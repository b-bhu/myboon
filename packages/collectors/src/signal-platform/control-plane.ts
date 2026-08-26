import type {
  ExecutionEventStatus,
  ExecutionStage,
  FailureCategory,
  Signal,
  WorkStatus,
} from './contracts'
import type {
  ExecutionAggregateRow,
  ExecutionAggregateStatus,
  ExecutionLedger,
} from './execution-ledger'
import type { ResearchWorkStoreAdapter, SchedulerAggregateStatus } from './store-adapter'

export const CONTROL_PLANE_STATUS_SCHEMA_VERSION = 'myboon.control_plane_status.v1' as const

export type ControlPlaneAvailability = 'available' | 'partial' | 'unavailable'
export type WorkControlPlaneStage = 'triage' | 'retrieval' | 'deep' | 'synthesis' | 'entity' | 'unassigned'

export interface ControlPlaneComponentError {
  code:
    | 'STORE_STATUS_UNAVAILABLE'
    | 'WORK_DETAIL_UNAVAILABLE'
    | 'EXECUTION_READER_UNAVAILABLE'
    | 'EXECUTION_READER_NOT_CONFIGURED'
  component: string
  message: string
}

export interface WorkFailureAggregate {
  category: FailureCategory
  count: number
  lastOccurredAt: string | null
}

/** Optional richer read port. It deliberately exposes no mutation methods. */
export interface WorkObservabilityReadPort {
  readonly sourceType: Signal['sourceType']
  readWorkObservability(input: {
    now: string
    recentFailureSince: string
    failureLimit: number
  }): Promise<{
    signalCount: number
    triageDecisionCount: number
    totalAttempts: number
    attemptedItems: number
    maxAttemptCount: number
    recentFailures: WorkFailureAggregate[]
  }>
}

export type ExecutionObservabilityReadPort = Pick<ExecutionLedger, 'readAggregateStatus'>

export interface StageWorkStatus {
  total: number
  byStatus: Partial<Record<WorkStatus, number>>
}

export interface SourceControlPlaneStatus {
  sourceType: Signal['sourceType']
  availability: ControlPlaneAvailability
  error: ControlPlaneComponentError | null
  total: number | null
  byStatus: Partial<Record<WorkStatus, number>>
  byStage: Record<WorkControlPlaneStage, StageWorkStatus>
  counts: {
    ready: number
    retry: number
    deadLetter: number
    expired: number
    leased: number
    unfinished: number
  }
  oldestReadyAt: string | null
  oldestReadyAgeMs: number | null
  oldestLeaseExpiresAt: string | null
  oldestLeaseExpiresInMs: number | null
  intake: {
    availability: ControlPlaneAvailability
    signals: number | null
    triageDecisions: number | null
    admittedWorkItems: number | null
  }
  attempts: {
    availability: ControlPlaneAvailability
    totalAttempts: number | null
    attemptedItems: number | null
    maxAttemptCount: number | null
  }
  recentFailures: WorkFailureAggregate[]
}

export interface ExecutionStageStatus {
  total: number
  byStatus: Partial<Record<ExecutionEventStatus, number>>
}

export interface ProviderUsageAggregate {
  sourceType: Signal['sourceType']
  provider: string | null
  model: string | null
  fallbackProvider: string | null
  fallbackModel: string | null
  fallbackUsed: boolean
  eventCount: number
  providerCalls: number
  repairCalls: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  budgetExceededCount: number
  totalWallTimeMs: number
}

export interface ExecutionControlPlaneStatus {
  availability: ControlPlaneAvailability
  error: ControlPlaneComponentError | null
  totalEvents: number | null
  activeEvents: number | null
  bySource: Partial<Record<Signal['sourceType'], {
    total: number
    byStage: Partial<Record<ExecutionStage, ExecutionStageStatus>>
  }>>
  recentFailures: WorkFailureAggregate[]
  providerUsage: ProviderUsageAggregate[]
}

export interface SignalPlatformControlPlaneStatus {
  schemaVersion: typeof CONTROL_PLANE_STATUS_SCHEMA_VERSION
  generatedAt: string
  availability: ControlPlaneAvailability
  errors: ControlPlaneComponentError[]
  totals: {
    signals: number | null
    triageDecisions: number | null
    admittedWorkItems: number
    workItems: number
    ready: number
    retry: number
    deadLetter: number
    expired: number
    leased: number
    unfinished: number
    attempts: number | null
  }
  sources: Partial<Record<Signal['sourceType'], SourceControlPlaneStatus>>
  execution: ExecutionControlPlaneStatus
  recentFailures: WorkFailureAggregate[]
}

export interface SignalPlatformControlPlaneOptions {
  stores: ResearchWorkStoreAdapter[]
  workReaders?: WorkObservabilityReadPort[]
  executionReader?: ExecutionObservabilityReadPort | null
  recentFailureWindowMs?: number
  recentFailureLimit?: number
}

export class SignalPlatformControlPlane {
  private readonly stores: ResearchWorkStoreAdapter[]
  private readonly workReaders: ReadonlyMap<Signal['sourceType'], WorkObservabilityReadPort>
  private readonly executionReader: ExecutionObservabilityReadPort | null
  private readonly recentFailureWindowMs: number
  private readonly recentFailureLimit: number

  constructor(options: SignalPlatformControlPlaneOptions) {
    assertUniqueSources(options.stores, 'store')
    assertUniqueSources(options.workReaders ?? [], 'work reader')
    this.stores = [...options.stores]
    this.workReaders = new Map((options.workReaders ?? []).map((reader) => [reader.sourceType, reader]))
    this.executionReader = options.executionReader ?? null
    this.recentFailureWindowMs = boundedInteger(
      options.recentFailureWindowMs ?? 60 * 60_000,
      'recentFailureWindowMs', 1, 30 * 24 * 60 * 60_000,
    )
    this.recentFailureLimit = boundedInteger(options.recentFailureLimit ?? 25, 'recentFailureLimit', 1, 250)
  }

  async readStatus(input: { now: string }): Promise<SignalPlatformControlPlaneStatus> {
    const nowMs = Date.parse(input.now)
    if (!Number.isFinite(nowMs)) throw new Error('now must be a valid timestamp')
    const failureSince = new Date(nowMs - this.recentFailureWindowMs).toISOString()

    const sourceEntries = await Promise.all(this.stores.map(async (store) => {
      const [statusResult, detailResult] = await Promise.allSettled([
        store.getSchedulerStatus({ now: input.now }),
        this.readWorkDetail(store.sourceType, input.now, failureSince),
      ])
      return [store.sourceType, sourceStatus(
        store.sourceType, statusResult, detailResult, nowMs,
      )] as const
    }))
    const sources = Object.fromEntries(sourceEntries) as SignalPlatformControlPlaneStatus['sources']
    const execution = await this.readExecution(input.now, failureSince)
    const errors = [
      ...sourceEntries.flatMap(([, source]) => source.error ? [source.error] : []),
      ...(execution.error ? [execution.error] : []),
    ]
    const availableSources = sourceEntries.map(([, source]) => source).filter((source) => source.total !== null)
    const allFailures = mergeFailures([
      ...availableSources.flatMap((source) => source.recentFailures),
      ...execution.recentFailures,
    ], this.recentFailureLimit)
    const attempts = availableSources.every((source) => source.attempts.totalAttempts !== null)
      ? sum(availableSources.map((source) => source.attempts.totalAttempts ?? 0))
      : null
    const signals = availableSources.every((source) => source.intake.signals !== null)
      ? sum(availableSources.map((source) => source.intake.signals ?? 0))
      : null
    const triageDecisions = availableSources.every((source) => source.intake.triageDecisions !== null)
      ? sum(availableSources.map((source) => source.intake.triageDecisions ?? 0))
      : null
    const availability = overallAvailability(
      availableSources.length,
      this.stores.length,
      execution.availability,
      errors.length,
    )
    return {
      schemaVersion: CONTROL_PLANE_STATUS_SCHEMA_VERSION,
      generatedAt: input.now,
      availability,
      errors,
      totals: {
        signals,
        triageDecisions,
        admittedWorkItems: sum(availableSources.map((source) => source.total ?? 0)),
        workItems: sum(availableSources.map((source) => source.total ?? 0)),
        ready: sum(availableSources.map((source) => source.counts.ready)),
        retry: sum(availableSources.map((source) => source.counts.retry)),
        deadLetter: sum(availableSources.map((source) => source.counts.deadLetter)),
        expired: sum(availableSources.map((source) => source.counts.expired)),
        leased: sum(availableSources.map((source) => source.counts.leased)),
        unfinished: sum(availableSources.map((source) => source.counts.unfinished)),
        attempts,
      },
      sources,
      execution,
      recentFailures: allFailures,
    }
  }

  private async readWorkDetail(
    sourceType: Signal['sourceType'],
    now: string,
    recentFailureSince: string,
  ): Promise<Awaited<ReturnType<WorkObservabilityReadPort['readWorkObservability']>> | null> {
    const reader = this.workReaders.get(sourceType)
    if (!reader) return null
    return reader.readWorkObservability({
      now,
      recentFailureSince,
      failureLimit: this.recentFailureLimit,
    })
  }

  private async readExecution(now: string, since: string): Promise<ExecutionControlPlaneStatus> {
    if (!this.executionReader) return emptyExecution(
      componentError('EXECUTION_READER_NOT_CONFIGURED', 'execution', 'execution reader is not configured'),
    )
    try {
      const aggregate = await Promise.resolve(this.executionReader.readAggregateStatus({ since, until: now }))
      return executionStatus(aggregate, this.recentFailureLimit)
    } catch {
      return emptyExecution(
        componentError('EXECUTION_READER_UNAVAILABLE', 'execution', 'execution aggregate unavailable'),
      )
    }
  }
}

function sourceStatus(
  sourceType: Signal['sourceType'],
  statusResult: PromiseSettledResult<SchedulerAggregateStatus>,
  detailResult: PromiseSettledResult<Awaited<ReturnType<WorkObservabilityReadPort['readWorkObservability']>> | null>,
  nowMs: number,
): SourceControlPlaneStatus {
  if (statusResult.status === 'rejected') return unavailableSource(sourceType)
  const status = statusResult.value
  const byStatus = { ...status.byStatus }
  const counts = countWork(byStatus)
  const detail = detailResult.status === 'fulfilled' ? detailResult.value : null
  const hasConfiguredDetail = detailResult.status === 'rejected' || detail !== null
  const availability: ControlPlaneAvailability = detailResult.status === 'rejected' ? 'partial' : 'available'
  return {
    sourceType,
    availability,
    error: detailResult.status === 'rejected'
      ? componentError('WORK_DETAIL_UNAVAILABLE', sourceType, `${sourceType} work detail unavailable`)
      : null,
    total: status.total,
    byStatus,
    byStage: stageWorkCounts(byStatus),
    counts,
    oldestReadyAt: status.oldestReadyAt,
    oldestReadyAgeMs: ageMs(status.oldestReadyAt, nowMs),
    oldestLeaseExpiresAt: status.oldestLeaseExpiresAt,
    oldestLeaseExpiresInMs: status.oldestLeaseExpiresAt === null
      ? null : Date.parse(status.oldestLeaseExpiresAt) - nowMs,
    intake: {
      availability: hasConfiguredDetail ? availability : 'unavailable',
      signals: detail?.signalCount ?? null,
      triageDecisions: detail?.triageDecisionCount ?? null,
      admittedWorkItems: status.total,
    },
    attempts: {
      availability: hasConfiguredDetail ? availability : 'unavailable',
      totalAttempts: detail?.totalAttempts ?? null,
      attemptedItems: detail?.attemptedItems ?? null,
      maxAttemptCount: detail?.maxAttemptCount ?? null,
    },
    recentFailures: detail?.recentFailures.slice(0, 250) ?? [],
  }
}

function unavailableSource(sourceType: Signal['sourceType']): SourceControlPlaneStatus {
  return {
    sourceType,
    availability: 'unavailable',
    error: componentError('STORE_STATUS_UNAVAILABLE', sourceType, `${sourceType} store status unavailable`),
    total: null,
    byStatus: {},
    byStage: emptyStageWorkCounts(),
    counts: { ready: 0, retry: 0, deadLetter: 0, expired: 0, leased: 0, unfinished: 0 },
    oldestReadyAt: null,
    oldestReadyAgeMs: null,
    oldestLeaseExpiresAt: null,
    oldestLeaseExpiresInMs: null,
    intake: {
      availability: 'unavailable', signals: null, triageDecisions: null, admittedWorkItems: null,
    },
    attempts: {
      availability: 'unavailable', totalAttempts: null, attemptedItems: null, maxAttemptCount: null,
    },
    recentFailures: [],
  }
}

function executionStatus(aggregate: ExecutionAggregateStatus, limit: number): ExecutionControlPlaneStatus {
  const bySource: ExecutionControlPlaneStatus['bySource'] = {}
  for (const row of aggregate.rows) {
    const source = bySource[row.sourceType] ?? { total: 0, byStage: {} }
    const stage = source.byStage[row.stage] ?? { total: 0, byStatus: {} }
    stage.total += row.eventCount
    stage.byStatus[row.status] = (stage.byStatus[row.status] ?? 0) + row.eventCount
    source.total += row.eventCount
    source.byStage[row.stage] = stage
    bySource[row.sourceType] = source
  }
  return {
    availability: 'available',
    error: null,
    totalEvents: aggregate.totalEvents,
    activeEvents: aggregate.activeEvents,
    bySource,
    recentFailures: mergeFailures(aggregate.rows.flatMap((row) => row.failureCategory
      ? [{ category: row.failureCategory, count: row.eventCount, lastOccurredAt: null }]
      : []), limit),
    providerUsage: mergeProviderUsage(aggregate.rows),
  }
}

function emptyExecution(error: ControlPlaneComponentError): ExecutionControlPlaneStatus {
  return {
    availability: 'unavailable', error, totalEvents: null, activeEvents: null,
    bySource: {}, recentFailures: [], providerUsage: [],
  }
}

function mergeProviderUsage(rows: ExecutionAggregateRow[]): ProviderUsageAggregate[] {
  const grouped = new Map<string, ProviderUsageAggregate>()
  for (const row of rows) {
    if (!row.provider && !row.model && !row.fallbackUsed && row.providerCalls === 0) continue
    const key = JSON.stringify([
      row.sourceType, row.provider, row.model, row.fallbackProvider, row.fallbackModel, row.fallbackUsed,
    ])
    const current = grouped.get(key) ?? {
      sourceType: row.sourceType,
      provider: row.provider,
      model: row.model,
      fallbackProvider: row.fallbackProvider,
      fallbackModel: row.fallbackModel,
      fallbackUsed: row.fallbackUsed,
      eventCount: 0,
      providerCalls: 0,
      repairCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      budgetExceededCount: 0,
      totalWallTimeMs: 0,
    }
    current.eventCount += row.eventCount
    current.providerCalls += row.providerCalls
    current.repairCalls += row.repairCalls
    current.inputTokens += row.inputTokens
    current.outputTokens += row.outputTokens
    current.toolCalls += row.toolCalls
    current.budgetExceededCount += row.budgetExceededCount
    current.totalWallTimeMs += row.totalWallTimeMs
    grouped.set(key, current)
  }
  return [...grouped.values()].sort((a, b) => a.sourceType.localeCompare(b.sourceType)
    || (a.provider ?? '').localeCompare(b.provider ?? ''))
}

function stageWorkCounts(byStatus: Partial<Record<WorkStatus, number>>): Record<WorkControlPlaneStage, StageWorkStatus> {
  const result = emptyStageWorkCounts()
  for (const [status, rawCount] of Object.entries(byStatus) as Array<[WorkStatus, number | undefined]>) {
    const count = rawCount ?? 0
    const stage = stageForWorkStatus(status)
    result[stage].total += count
    result[stage].byStatus[status] = count
  }
  return result
}

function emptyStageWorkCounts(): Record<WorkControlPlaneStage, StageWorkStatus> {
  return {
    triage: { total: 0, byStatus: {} },
    retrieval: { total: 0, byStatus: {} },
    deep: { total: 0, byStatus: {} },
    synthesis: { total: 0, byStatus: {} },
    entity: { total: 0, byStatus: {} },
    unassigned: { total: 0, byStatus: {} },
  }
}

function stageForWorkStatus(status: WorkStatus): WorkControlPlaneStage {
  if (status === 'signal_observed' || status === 'triage_pending' || status === 'archived' || status === 'deferred') return 'triage'
  if (status === 'research_pending' || status === 'retrieval_leased') return 'retrieval'
  if (status === 'deep_pending' || status === 'deep_leased') return 'deep'
  if (status === 'synthesis_pending' || status === 'synthesis_leased' || status === 'research_ready') return 'synthesis'
  if (status === 'entity_pending' || status === 'entity_leased' || status === 'complete') return 'entity'
  return 'unassigned'
}

function countWork(byStatus: Partial<Record<WorkStatus, number>>): SourceControlPlaneStatus['counts'] {
  const get = (...statuses: WorkStatus[]) => sum(statuses.map((status) => byStatus[status] ?? 0))
  const ready = get('research_pending', 'deep_pending', 'synthesis_pending', 'research_ready', 'entity_pending')
  const retry = get('retry_wait')
  const deadLetter = get('dead_letter')
  const expired = get('expired')
  const leased = get('retrieval_leased', 'deep_leased', 'synthesis_leased', 'entity_leased')
  return { ready, retry, deadLetter, expired, leased, unfinished: ready + retry + leased }
}

function mergeFailures(failures: WorkFailureAggregate[], limit: number): WorkFailureAggregate[] {
  const grouped = new Map<FailureCategory, WorkFailureAggregate>()
  for (const failure of failures) {
    const current = grouped.get(failure.category) ?? {
      category: failure.category, count: 0, lastOccurredAt: null,
    }
    current.count += failure.count
    if (failure.lastOccurredAt && (!current.lastOccurredAt
      || Date.parse(failure.lastOccurredAt) > Date.parse(current.lastOccurredAt))) {
      current.lastOccurredAt = failure.lastOccurredAt
    }
    grouped.set(failure.category, current)
  }
  return [...grouped.values()]
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
    .slice(0, limit)
}

function componentError(
  code: ControlPlaneComponentError['code'],
  component: string,
  message: string,
): ControlPlaneComponentError {
  return { code, component, message }
}

function overallAvailability(
  availableStores: number,
  totalStores: number,
  execution: ControlPlaneAvailability,
  errorCount: number,
): ControlPlaneAvailability {
  if (availableStores === 0 && execution === 'unavailable') return 'unavailable'
  if (availableStores < totalStores || execution !== 'available' || errorCount > 0) return 'partial'
  return 'available'
}

function ageMs(timestamp: string | null, nowMs: number): number | null {
  if (!timestamp) return null
  return Math.max(0, nowMs - Date.parse(timestamp))
}

function assertUniqueSources(
  values: Array<{ sourceType: Signal['sourceType'] }>,
  label: string,
): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value.sourceType)) throw new Error(`Duplicate ${label} for source ${value.sourceType}`)
    seen.add(value.sourceType)
  }
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
