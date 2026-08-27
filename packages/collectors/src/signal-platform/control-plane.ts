import type {
  ExecutionEventStatus,
  ExecutionStage,
  FailureCategory,
  PriorityClass,
  ResearchDepth,
  Signal,
  TriageOutcome,
  WorkStatus,
} from './contracts'
import type {
  ExecutionAggregateRow,
  ExecutionAggregateStatus,
  ExecutionLedger,
  ExecutionProviderPerformance,
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
    | 'EXECUTION_READER_PARTIAL'
    | 'EXECUTION_READER_NOT_CONFIGURED'
  component: string
  message: string
}

export interface WorkFailureAggregate {
  category: FailureCategory
  count: number
  lastOccurredAt: string | null
}

export interface WorkQueueAgeAggregate {
  priorityClass: PriorityClass
  researchDepth: ResearchDepth
  status: WorkStatus
  count: number
  oldestQueuedAt: string
  oldestAgeMs: number
  p50AgeMs: number
  p95AgeMs: number
}

export interface LatencyPercentiles {
  sampleCount: number
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
}

export interface SqliteSizeAggregate {
  mainBytes: number
  walBytes: number
  shmBytes: number
  totalBytes: number
}

export interface DeadLetterAggregate {
  total: number
  oldestAt: string | null
  oldestAgeMs: number | null
  byFailureCategory: WorkFailureAggregate[]
}

/** Optional richer read port. It deliberately exposes no mutation methods. */
export interface WorkObservabilityReadPort {
  readonly sourceType: Signal['sourceType']
  readWorkObservability(input: {
    now: string
    recentFailureSince: string
    /** Independent rolling window for arrival/admission/completion comparison. */
    activitySince?: string
    failureLimit: number
  }): Promise<{
    signalCount: number
    observationCount?: number
    deduplicatedObservationCount?: number
    triageDecisionCount: number
    triageOutcomes?: Partial<Record<TriageOutcome, number>>
    researchPacketCount?: number
    entityMemoryHandoffCount?: number
    endToEndLatency?: LatencyPercentiles
    sqliteSize?: SqliteSizeAggregate
    sqliteStoreId?: string
    sqliteWriteErrors?: MetricCoverage<number>
    totalAttempts: number
    attemptedItems: number
    maxAttemptCount: number
    recentFailures: WorkFailureAggregate[]
    arrivalsInWindow?: number
    admissionsInWindow?: number
    completionsInWindow?: number
    queueAge?: Array<Omit<WorkQueueAgeAggregate, 'oldestAgeMs'>>
    deadLetters?: Omit<DeadLetterAggregate, 'oldestAgeMs'>
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
    observations: number | null
    deduplicatedObservations: number | null
    deduplicationRate: number | null
    triageDecisions: number | null
    admittedWorkItems: number | null
    triageOutcomes: Partial<Record<TriageOutcome, number>>
  }
  attempts: {
    availability: ControlPlaneAvailability
    totalAttempts: number | null
    attemptedItems: number | null
    maxAttemptCount: number | null
  }
  recentFailures: WorkFailureAggregate[]
  activity: {
    windowStart: string
    arrivals: number | null
    admissions: number | null
    completions: number | null
  }
  queueAge: WorkQueueAgeAggregate[]
  deadLetters: DeadLetterAggregate
  artifacts: {
    researchPackets: number | null
    entityMemoryHandoffs: number | null
  }
  endToEndLatency: LatencyPercentiles | null
  sqliteSize: SqliteSizeAggregate | null
  sqliteStoreId: string | null
  sqliteWriteErrors: MetricCoverage<number>
}

export interface MetricCoverage<T> {
  availability: 'available' | 'partial' | 'unavailable'
  value: T | null
  measuredCount: number
  reason: string | null
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
  providerPerformance: ExecutionProviderPerformance[]
  perCompletedPacket: {
    executionTelemetryPackets: number
    canonicalPackets: number | null
    telemetryCoverageRate: number | null
    inputTokens: number | null
    outputTokens: number | null
    costUsdMicros: MetricCoverage<number>
  }
}

export interface ControlPlaneAlert {
  code: 'QUEUE_AGE_SLO_EXCEEDED' | 'PROVIDER_ERROR_RATE' | 'DEAD_LETTER_THRESHOLD'
  sourceType: Signal['sourceType']
  stage: WorkControlPlaneStage | ExecutionStage
  provider: string | null
  queueAgeMs: number | null
  message: string
  suggestedCommand: string
}

export interface ControlPlaneAlertPolicy {
  queueAgeSloMs: Partial<Record<Signal['sourceType'], Partial<Record<'P0' | 'P1', number>>>>
  providerErrorRateThreshold: number
  deadLetterCountThreshold: number
}

export function parseControlPlaneAlertPolicy(value: unknown): ControlPlaneAlertPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('alert policy must be an object')
  const record = value as Record<string, unknown>
  const queueRaw = record.queueAgeSloMs
  if (!queueRaw || typeof queueRaw !== 'object' || Array.isArray(queueRaw)) {
    throw new Error('alert policy queueAgeSloMs must be an object')
  }
  const queueAgeSloMs: ControlPlaneAlertPolicy['queueAgeSloMs'] = {}
  const knownSources = new Set<Signal['sourceType']>(['news', 'polymarket', 'market_calendar', 'x'])
  for (const [sourceKey, thresholds] of Object.entries(queueRaw as Record<string, unknown>)) {
    if (!knownSources.has(sourceKey as Signal['sourceType']) || !thresholds
      || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
      throw new Error(`alert policy queue source ${sourceKey} is invalid`)
    }
    const row = thresholds as Record<string, unknown>
    for (const key of Object.keys(row)) if (key !== 'P0' && key !== 'P1') throw new Error(`alert policy priority ${key} is invalid`)
    queueAgeSloMs[sourceKey as Signal['sourceType']] = {
      ...(row.P0 === undefined ? {} : { P0: boundedInteger(Number(row.P0), `${sourceKey}.P0`, 1, 30 * 24 * 60 * 60_000) }),
      ...(row.P1 === undefined ? {} : { P1: boundedInteger(Number(row.P1), `${sourceKey}.P1`, 1, 30 * 24 * 60 * 60_000) }),
    }
  }
  const providerErrorRateThreshold = Number(record.providerErrorRateThreshold)
  if (!Number.isFinite(providerErrorRateThreshold) || providerErrorRateThreshold < 0 || providerErrorRateThreshold > 1) {
    throw new Error('alert policy providerErrorRateThreshold must be between 0 and 1')
  }
  return {
    queueAgeSloMs,
    providerErrorRateThreshold,
    deadLetterCountThreshold: boundedInteger(
      Number(record.deadLetterCountThreshold), 'deadLetterCountThreshold', 0, 1_000_000,
    ),
  }
}

export interface SignalPlatformControlPlaneStatus {
  schemaVersion: typeof CONTROL_PLANE_STATUS_SCHEMA_VERSION
  generatedAt: string
  availability: ControlPlaneAvailability
  errors: ControlPlaneComponentError[]
  totals: {
    signals: number | null
    observations: number | null
    deduplicatedObservations: number | null
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
    arrivalsInWindow: number | null
    admissionsInWindow: number | null
    completionsInWindow: number | null
    researchPackets: number | null
    entityMemoryHandoffs: number | null
    sqliteBytes: number | null
  }
  sources: Partial<Record<Signal['sourceType'], SourceControlPlaneStatus>>
  execution: ExecutionControlPlaneStatus
  sqliteWriteErrors: MetricCoverage<number>
  recentFailures: WorkFailureAggregate[]
  alerts: {
    availability: 'available' | 'unavailable'
    reason: string | null
    items: ControlPlaneAlert[]
  }
}

export interface SignalPlatformControlPlaneOptions {
  stores: ResearchWorkStoreAdapter[]
  workReaders?: WorkObservabilityReadPort[]
  executionReader?: ExecutionObservabilityReadPort | null
  recentFailureWindowMs?: number
  activityWindowMs?: number
  recentFailureLimit?: number
  alertPolicy?: ControlPlaneAlertPolicy | null
}

export class SignalPlatformControlPlane {
  private readonly stores: ResearchWorkStoreAdapter[]
  private readonly workReaders: ReadonlyMap<Signal['sourceType'], WorkObservabilityReadPort>
  private readonly executionReader: ExecutionObservabilityReadPort | null
  private readonly recentFailureWindowMs: number
  private readonly recentFailureLimit: number
  private readonly activityWindowMs: number
  private readonly alertPolicy: ControlPlaneAlertPolicy | null

  constructor(options: SignalPlatformControlPlaneOptions) {
    assertUniqueSources(options.stores, 'store')
    assertUniqueSources(options.workReaders ?? [], 'work reader')
    this.stores = [...options.stores]
    this.workReaders = new Map((options.workReaders ?? []).map((reader) => [reader.sourceType, reader]))
    this.executionReader = options.executionReader ?? null
    this.recentFailureWindowMs = boundedInteger(
      options.recentFailureWindowMs ?? 5 * 60_000,
      'recentFailureWindowMs', 1, 30 * 24 * 60 * 60_000,
    )
    this.recentFailureLimit = boundedInteger(options.recentFailureLimit ?? 25, 'recentFailureLimit', 1, 250)
    this.activityWindowMs = boundedInteger(
      options.activityWindowMs ?? 30 * 60_000,
      'activityWindowMs', 60_000, 30 * 24 * 60 * 60_000,
    )
    this.alertPolicy = options.alertPolicy ?? null
  }

  async readStatus(input: { now: string }): Promise<SignalPlatformControlPlaneStatus> {
    const nowMs = Date.parse(input.now)
    if (!Number.isFinite(nowMs)) throw new Error('now must be a valid timestamp')
    const failureSince = new Date(nowMs - this.recentFailureWindowMs).toISOString()
    const activitySince = new Date(nowMs - this.activityWindowMs).toISOString()

    const sourceEntries = await Promise.all(this.stores.map(async (store) => {
      const [statusResult, detailResult] = await Promise.allSettled([
        store.getSchedulerStatus({ now: input.now }),
        this.readWorkDetail(store.sourceType, input.now, failureSince, activitySince),
      ])
      return [store.sourceType, sourceStatus(
        store.sourceType, statusResult, detailResult, nowMs, activitySince,
      )] as const
    }))
    let sources = Object.fromEntries(sourceEntries) as SignalPlatformControlPlaneStatus['sources']
    const execution = await this.readExecution(input.now, failureSince)
    sources = applyMemoryWriteCoverage(sources, execution)
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
    const observationTotal = (field: 'observations' | 'deduplicatedObservations'): number | null =>
      availableSources.every((source) => source.intake[field] !== null)
        ? sum(availableSources.map((source) => source.intake[field] ?? 0))
        : null
    const activityTotal = (field: 'arrivals' | 'admissions' | 'completions'): number | null =>
      availableSources.every((source) => source.activity[field] !== null)
        ? sum(availableSources.map((source) => source.activity[field] ?? 0))
        : null
    const detailTotal = (read: (source: SourceControlPlaneStatus) => number | null): number | null =>
      availableSources.every((source) => read(source) !== null)
        ? sum(availableSources.map((source) => read(source) ?? 0))
        : null
    const availability = overallAvailability(
      availableSources.length,
      this.stores.length,
      execution.availability,
      errors.length,
    )
    const sqliteWriteErrors = aggregateCoverage(
      availableSources.map((source) => source.sqliteWriteErrors),
      'no source has a durable SQLite write-error collector',
    )
    const sqliteBytes = aggregatePhysicalStoreBytes(availableSources)
    const researchPackets = detailTotal((source) => source.artifacts.researchPackets)
    const executionWithPacketCoverage = applyCanonicalPacketCoverage(execution, researchPackets)
    const alerts = this.alertPolicy
      ? { availability: 'available' as const, reason: null, items: evaluateAlerts(sources, execution, this.alertPolicy) }
      : {
          availability: 'unavailable' as const,
          reason: 'reviewed alert thresholds are not configured',
          items: [],
        }
    return {
      schemaVersion: CONTROL_PLANE_STATUS_SCHEMA_VERSION,
      generatedAt: input.now,
      availability,
      errors,
      totals: {
        signals,
        observations: observationTotal('observations'),
        deduplicatedObservations: observationTotal('deduplicatedObservations'),
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
        arrivalsInWindow: activityTotal('arrivals'),
        admissionsInWindow: activityTotal('admissions'),
        completionsInWindow: activityTotal('completions'),
        researchPackets,
        entityMemoryHandoffs: detailTotal((source) => source.artifacts.entityMemoryHandoffs),
        sqliteBytes,
      },
      sources,
      execution: executionWithPacketCoverage,
      sqliteWriteErrors,
      recentFailures: allFailures,
      alerts,
    }
  }

  private async readWorkDetail(
    sourceType: Signal['sourceType'],
    now: string,
    recentFailureSince: string,
    activitySince: string,
  ): Promise<Awaited<ReturnType<WorkObservabilityReadPort['readWorkObservability']>> | null> {
    const reader = this.workReaders.get(sourceType)
    if (!reader) return null
    return reader.readWorkObservability({
      now,
      recentFailureSince,
      activitySince,
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
  windowStart: string,
): SourceControlPlaneStatus {
  if (statusResult.status === 'rejected') return unavailableSource(sourceType, windowStart)
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
      observations: detail?.observationCount ?? null,
      deduplicatedObservations: detail?.deduplicatedObservationCount ?? null,
      deduplicationRate: detail?.observationCount
        ? (detail.deduplicatedObservationCount ?? 0) / detail.observationCount
        : detail?.observationCount === 0 ? 0 : null,
      triageDecisions: detail?.triageDecisionCount ?? null,
      admittedWorkItems: status.total,
      triageOutcomes: { ...(detail?.triageOutcomes ?? {}) },
    },
    attempts: {
      availability: hasConfiguredDetail ? availability : 'unavailable',
      totalAttempts: detail?.totalAttempts ?? null,
      attemptedItems: detail?.attemptedItems ?? null,
      maxAttemptCount: detail?.maxAttemptCount ?? null,
    },
    recentFailures: detail?.recentFailures.slice(0, 250) ?? [],
    activity: {
      windowStart,
      arrivals: detail?.arrivalsInWindow ?? null,
      admissions: detail?.admissionsInWindow ?? null,
      completions: detail?.completionsInWindow ?? null,
    },
    queueAge: (detail?.queueAge ?? []).map((row) => ({
      ...row,
      oldestAgeMs: Math.max(0, nowMs - Date.parse(row.oldestQueuedAt)),
    })),
    deadLetters: {
      total: detail?.deadLetters?.total ?? counts.deadLetter,
      oldestAt: detail?.deadLetters?.oldestAt ?? null,
      oldestAgeMs: ageMs(detail?.deadLetters?.oldestAt ?? null, nowMs),
      byFailureCategory: detail?.deadLetters?.byFailureCategory ?? [],
    },
    artifacts: {
      researchPackets: detail?.researchPacketCount ?? null,
      entityMemoryHandoffs: detail?.entityMemoryHandoffCount ?? null,
    },
    endToEndLatency: detail?.endToEndLatency ?? null,
    sqliteSize: detail?.sqliteSize ?? null,
    sqliteStoreId: detail?.sqliteStoreId ?? null,
    sqliteWriteErrors: detail?.sqliteWriteErrors ?? {
      availability: 'unavailable', value: null, measuredCount: 0,
      reason: 'SQLite does not expose historical write-error counts; no durable external write-error collector is configured',
    },
  }
}

function unavailableSource(sourceType: Signal['sourceType'], windowStart: string): SourceControlPlaneStatus {
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
      availability: 'unavailable', signals: null, observations: null, deduplicatedObservations: null,
      deduplicationRate: null, triageDecisions: null, admittedWorkItems: null,
      triageOutcomes: {},
    },
    attempts: {
      availability: 'unavailable', totalAttempts: null, attemptedItems: null, maxAttemptCount: null,
    },
    recentFailures: [],
    activity: { windowStart, arrivals: null, admissions: null, completions: null },
    queueAge: [],
    deadLetters: { total: 0, oldestAt: null, oldestAgeMs: null, byFailureCategory: [] },
    artifacts: { researchPackets: null, entityMemoryHandoffs: null },
    endToEndLatency: null,
    sqliteSize: null,
    sqliteStoreId: null,
    sqliteWriteErrors: {
      availability: 'unavailable', value: null, measuredCount: 0,
      reason: 'source store is unavailable',
    },
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
    availability: aggregate.unavailableSources?.length ? 'partial' : 'available',
    error: aggregate.unavailableSources?.length
      ? componentError(
          'EXECUTION_READER_PARTIAL',
          'execution',
          `execution aggregates unavailable for: ${aggregate.unavailableSources.join(', ')}`,
        )
      : null,
    totalEvents: aggregate.totalEvents,
    activeEvents: aggregate.activeEvents,
    bySource,
    recentFailures: mergeFailures(aggregate.rows.flatMap((row) => row.failureCategory
      ? [{ category: row.failureCategory, count: row.eventCount, lastOccurredAt: null }]
      : []), limit),
    providerUsage: mergeProviderUsage(aggregate.rows),
    providerPerformance: aggregate.providerPerformance,
    perCompletedPacket: completionUsage(aggregate),
  }
}

function emptyExecution(error: ControlPlaneComponentError): ExecutionControlPlaneStatus {
  return {
    availability: 'unavailable', error, totalEvents: null, activeEvents: null,
    bySource: {}, recentFailures: [], providerUsage: [], providerPerformance: [],
    perCompletedPacket: {
      executionTelemetryPackets: 0, canonicalPackets: null, telemetryCoverageRate: null,
      inputTokens: null, outputTokens: null,
      costUsdMicros: { availability: 'unavailable', value: null, measuredCount: 0, reason: error.message },
    },
  }
}

function completionUsage(aggregate: ExecutionAggregateStatus): ExecutionControlPlaneStatus['perCompletedPacket'] {
  const usage = aggregate.completionUsage
  if (usage.completedPackets === 0) return {
    executionTelemetryPackets: 0, canonicalPackets: null, telemetryCoverageRate: null,
    inputTokens: null,
    outputTokens: null,
    costUsdMicros: { availability: 'unavailable', value: null, measuredCount: 0, reason: 'no completed packet events' },
  }
  const costAvailability = usage.measuredCostPackets === 0 ? 'unavailable'
    : usage.measuredCostPackets === usage.completedPackets ? 'available' : 'partial'
  return {
    executionTelemetryPackets: usage.completedPackets,
    canonicalPackets: null,
    telemetryCoverageRate: null,
    inputTokens: usage.inputTokens / usage.completedPackets,
    outputTokens: usage.outputTokens / usage.completedPackets,
    costUsdMicros: {
      availability: costAvailability,
      value: usage.measuredCostPackets === 0 ? null : usage.totalCostUsdMicros / usage.measuredCostPackets,
      measuredCount: usage.measuredCostPackets,
      reason: usage.measuredCostPackets === usage.completedPackets
        ? null : 'costUsdMicros is reported only for explicitly metered completed packet events; missing cost is not inferred',
    },
  }
}

function applyCanonicalPacketCoverage(
  execution: ExecutionControlPlaneStatus,
  canonicalPackets: number | null,
): ExecutionControlPlaneStatus {
  const measured = execution.perCompletedPacket.executionTelemetryPackets
  const telemetryCoverageRate = canonicalPackets === null ? null
    : canonicalPackets === 0 ? (measured === 0 ? 1 : null) : Math.min(1, measured / canonicalPackets)
  const cost = execution.perCompletedPacket.costUsdMicros
  const incompleteTelemetry = canonicalPackets !== null && measured < canonicalPackets
  return {
    ...execution,
    perCompletedPacket: {
      ...execution.perCompletedPacket,
      canonicalPackets,
      telemetryCoverageRate,
      costUsdMicros: incompleteTelemetry && cost.availability === 'available'
        ? {
            ...cost, availability: 'partial',
            reason: 'some canonical packets have no completed synthesis execution telemetry',
          }
        : cost,
    },
  }
}

function aggregateCoverage(
  metrics: MetricCoverage<number>[],
  unavailableReason: string,
): MetricCoverage<number> {
  const measured = metrics.filter((metric) => metric.value !== null)
  if (measured.length === 0) return {
    availability: 'unavailable', value: null, measuredCount: 0, reason: unavailableReason,
  }
  return {
    availability: measured.length === metrics.length
      && measured.every((metric) => metric.availability === 'available') ? 'available' : 'partial',
    value: sum(measured.map((metric) => metric.value ?? 0)),
    measuredCount: sum(measured.map((metric) => metric.measuredCount)),
    reason: measured.length === metrics.length ? null : 'some source write-error measurements are unavailable',
  }
}

function aggregatePhysicalStoreBytes(sources: SourceControlPlaneStatus[]): number | null {
  if (sources.some((source) => source.sqliteSize === null)) return null
  const stores = new Map<string, number>()
  for (const source of sources) {
    const identity = source.sqliteStoreId ?? `source:${source.sourceType}`
    const bytes = source.sqliteSize?.totalBytes ?? 0
    const prior = stores.get(identity)
    if (prior !== undefined && prior !== bytes) return null
    stores.set(identity, bytes)
  }
  return sum([...stores.values()])
}

function evaluateAlerts(
  sources: SignalPlatformControlPlaneStatus['sources'],
  execution: ExecutionControlPlaneStatus,
  policy: ControlPlaneAlertPolicy,
): ControlPlaneAlert[] {
  const alerts: ControlPlaneAlert[] = []
  for (const source of Object.values(sources)) {
    if (!source) continue
    for (const row of source.queueAge) {
      if (row.priorityClass !== 'P0' && row.priorityClass !== 'P1') continue
      const slo = policy.queueAgeSloMs[source.sourceType]?.[row.priorityClass]
      if (slo !== undefined && row.oldestAgeMs > slo) alerts.push({
        code: 'QUEUE_AGE_SLO_EXCEEDED', sourceType: source.sourceType,
        stage: stageForWorkStatus(row.status), provider: null, queueAgeMs: row.oldestAgeMs,
        message: `${row.priorityClass} queue age exceeds configured SLO`,
        suggestedCommand: `pnpm feed-v3:trace -- --work-id <work-id>`,
      })
    }
    if (source.deadLetters.total > policy.deadLetterCountThreshold) alerts.push({
      code: 'DEAD_LETTER_THRESHOLD', sourceType: source.sourceType, stage: 'unassigned',
      provider: null, queueAgeMs: source.deadLetters.oldestAgeMs,
      message: 'Dead-letter count exceeds configured threshold',
      suggestedCommand: `pnpm feed-v3:recover -- --source ${source.sourceType}`,
    })
  }
  for (const row of execution.providerPerformance) {
    if (row.terminalEventCount > 0 && 1 - row.successRate > policy.providerErrorRateThreshold) alerts.push({
      code: 'PROVIDER_ERROR_RATE', sourceType: row.sourceType, stage: row.stage,
      provider: row.provider, queueAgeMs: null,
      message: 'Provider terminal error rate exceeds configured threshold',
      suggestedCommand: `pnpm feed-v3:status`,
    })
  }
  return alerts.sort((a, b) => a.sourceType.localeCompare(b.sourceType)
    || a.code.localeCompare(b.code) || (a.provider ?? '').localeCompare(b.provider ?? ''))
}

/** A completed queue item is not proof that a durable memory was written. */
function applyMemoryWriteCoverage(
  sources: SignalPlatformControlPlaneStatus['sources'],
  execution: ExecutionControlPlaneStatus,
): SignalPlatformControlPlaneStatus['sources'] {
  return Object.fromEntries(Object.entries(sources).map(([sourceType, source]) => {
    if (!source) return [sourceType, source]
    const succeeded = execution.availability === 'available'
      ? execution.bySource[source.sourceType]?.byStage.memory_write?.byStatus.succeeded ?? 0
      : null
    return [sourceType, {
      ...source,
      artifacts: { ...source.artifacts, entityMemoryHandoffs: succeeded },
    }]
  })) as SignalPlatformControlPlaneStatus['sources']
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
