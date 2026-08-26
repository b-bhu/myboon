import { createHash } from 'node:crypto'
import type { NewsSignal, ResearchWorkItem, WorkStatus } from './contracts'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
} from './contracts'
import { ImmutableRecordConflictError } from './platform-store'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'

export const LOAD_SOAK_ARTIFACT_VERSION = 'myboon.feed_v3_load_soak_harness.v1' as const

export interface LoadSoakHarnessConfig {
  fixtureDatabasePath: string
  durationSeconds: number
  tickSeconds: number
  baselineAdmittedArrivalsPerSecond: number
  admittedArrivalMultiplier: number
  completionCapacityPerSecond: number
  duplicateEvery: number
  collisionEvery: number
  failureEvery: number
  logicalStart: string
  thresholds: {
    maxQueueDepth: number
    minCompletionRatio: number
    maxSqliteErrors: number
    maxTransitionFailures: number
  }
}

export interface LoadSoakHarnessRuntime {
  monotonicNow?: () => number
  pace?: (milliseconds: number) => Promise<void>
}

export interface LoadSoakHarnessArtifact {
  schemaVersion: typeof LOAD_SOAK_ARTIFACT_VERSION
  mode: 'dry_run' | 'executed'
  evidenceClass: 'non_production_sqlite_queue_harness'
  runId: string
  generatedAt: string
  simulation: {
    logicalStart: string
    durationSeconds: number
    tickSeconds: number
    baselineAdmittedArrivalsPerSecond: number
    admittedArrivalMultiplier: number
    completionCapacityPerSecond: number
    wallTimeMs: number
  }
  counts: {
    offered: number
    admitted: number
    completed: number
    duplicateAppends: number
    collisions: number
    injectedFailures: number
    transitionFailures: number
    sqliteErrors: number
    unexpectedErrors: number
  }
  ratesPerSecond: {
    offered: number
    admitted: number
    completed: number
  }
  queueDepth: {
    samples: number
    p95: number
    max: number
    final: number
  }
  thresholds: LoadSoakHarnessConfig['thresholds']
  passed: boolean
  failureReasons: string[]
  limitations: readonly [
    'does_not_satisfy_ac22_wall_clock_throughput',
    'does_not_satisfy_ac23_live_soak',
    'does_not_prove_production_soak',
    'does_not_exercise_providers_or_models',
    'does_not_exercise_supabase_or_entity_memory',
    'does_not_prove_deep_research_containment',
  ]
}

interface MutableMetrics {
  offered: number
  admitted: number
  completed: number
  duplicateAppends: number
  collisions: number
  injectedFailures: number
  transitionFailures: number
  sqliteErrors: number
  unexpectedErrors: number
  queueDepths: number[]
}

const LIMITATIONS = [
  'does_not_satisfy_ac22_wall_clock_throughput',
  'does_not_satisfy_ac23_live_soak',
  'does_not_prove_production_soak',
  'does_not_exercise_providers_or_models',
  'does_not_exercise_supabase_or_entity_memory',
  'does_not_prove_deep_research_containment',
] as const

/** Builds a non-evidence plan without opening or creating the fixture database. */
export function planLoadSoakHarness(
  config: LoadSoakHarnessConfig,
  generatedAt = new Date().toISOString(),
): LoadSoakHarnessArtifact {
  validateConfig(config)
  return artifact(config, emptyMetrics(), 'dry_run', generatedAt, 0, ['HARNESS_NOT_EXECUTED'])
}

/**
 * Runs only against a caller-validated fixture path. Logical time and IDs are
 * code-owned so identical clean fixtures exercise the same queue schedule.
 */
export async function runLoadSoakHarness(
  config: LoadSoakHarnessConfig,
  generatedAt = new Date().toISOString(),
  runtime: LoadSoakHarnessRuntime = {},
): Promise<LoadSoakHarnessArtifact> {
  validateConfig(config)
  const metrics = emptyMetrics()
  const monotonicNow = runtime.monotonicNow ?? (() => performance.now())
  const pace = runtime.pace ?? wait
  const wallStartedAt = monotonicNow()
  const store = new SqliteSignalPlatformStore(config.fixtureDatabasePath, 'news')
  const failedOnce = new Set<string>()
  try {
    const startMs = Date.parse(config.logicalStart)
    const ticks = Math.ceil(config.durationSeconds / config.tickSeconds)
    for (let tick = 1; tick <= ticks; tick += 1) {
      const elapsedSeconds = Math.min(tick * config.tickSeconds, config.durationSeconds)
      const now = new Date(startMs + elapsedSeconds * 1_000).toISOString()
      await guarded(metrics, async () => {
        await store.recoverExpiredLeases({ now, limit: 500 })
      })

      const targetOffered = Math.floor(
        config.baselineAdmittedArrivalsPerSecond
          * config.admittedArrivalMultiplier
          * elapsedSeconds,
      )
      while (metrics.offered < targetOffered) {
        const ordinal = metrics.offered + 1
        metrics.offered += 1
        await guarded(metrics, () => offer(store, config, metrics, ordinal, now))
      }

      const targetCapacity = Math.floor(config.completionCapacityPerSecond * elapsedSeconds)
      const availableSlots = Math.max(0, targetCapacity - metrics.completed - metrics.injectedFailures)
      for (let slot = 0; slot < availableSlots; slot += 1) {
        const result = await guarded(metrics, () => processOne(store, config, metrics, failedOnce, now))
        if (result === null || result === 'empty') break
        if (result === 'completed') metrics.completed += 1
      }
      const status = await guarded(metrics, () => store.getSchedulerStatus({ now }))
      metrics.queueDepths.push(status === null ? 0 : unfinishedCount(status.byStatus))
      const targetElapsedMs = elapsedSeconds * 1_000
      const remainingMs = targetElapsedMs - (monotonicNow() - wallStartedAt)
      if (remainingMs > 0) await pace(remainingMs)
    }
  } finally {
    store.close()
  }
  const wallTimeMs = Math.max(1, monotonicNow() - wallStartedAt)
  return artifact(config, metrics, 'executed', generatedAt, wallTimeMs)
}

function offer(
  store: SqliteSignalPlatformStore,
  config: LoadSoakHarnessConfig,
  metrics: MutableMetrics,
  ordinal: number,
  now: string,
): void {
  const signal = fixtureSignal(ordinal, now)
  const inserted = store.appendSignal(signal)
  const work = fixtureWork(ordinal, now, config.logicalStart)
  const admitted = store.admitResearchWork(work)
  if (inserted.inserted && admitted.inserted) metrics.admitted += 1

  if (config.duplicateEvery > 0 && ordinal % config.duplicateEvery === 0) {
    if (!store.appendSignal(signal).inserted) metrics.duplicateAppends += 1
    if (!store.admitResearchWork(work).inserted) metrics.duplicateAppends += 1
  }
  if (config.collisionEvery > 0 && ordinal % config.collisionEvery === 0) {
    try {
      store.appendSignal({ ...signal, title: `${signal.title} conflicting` })
    } catch (error) {
      if (error instanceof ImmutableRecordConflictError) metrics.collisions += 1
      else throw error
    }
  }
}

async function processOne(
  store: SqliteSignalPlatformStore,
  config: LoadSoakHarnessConfig,
  metrics: MutableMetrics,
  failedOnce: Set<string>,
  now: string,
): Promise<'completed' | 'failed' | 'empty'> {
  const head = (await store.peekSchedulable({ now, limit: 1 }))[0]
  if (!head) return 'empty'
  let work = head
  for (let stage = 0; stage < 3; stage += 1) {
    if (work.status === 'research_ready') {
      if (!store.promoteResearchReady(work.workId, now)) {
        metrics.transitionFailures += 1
        return 'failed'
      }
      work = store.getResearchWork(work.workId)!
    }
    const pending = pendingStage(work.status)
    if (!pending) return work.status === 'complete' ? 'completed' : 'failed'
    const leaseId = `lease:${work.workId}:${work.status}:${work.attemptCount}`
    const lease = await store.claimWithLease({
      workId: work.workId,
      expectedStatus: pending.pending,
      leaseOwner: 'load-soak-harness',
      leaseId,
      leaseExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
      now,
    })
    if (!lease) {
      metrics.transitionFailures += 1
      return 'failed'
    }
    if (pending.pending === 'research_pending'
      && shouldInject(config.failureEvery, work.workId)
      && !failedOnce.has(work.workId)) {
      failedOnce.add(work.workId)
      metrics.injectedFailures += 1
      const transitioned = await store.transitionLeased({
        workId: work.workId,
        leaseOwner: lease.leaseOwner,
        leaseId: lease.leaseId,
        expectedStatus: pending.leased,
        nextStatus: 'retry_wait',
        attemptDelta: 1,
        nextAttemptAt: new Date(Date.parse(now) + 1).toISOString(),
        failureCategory: 'storage_transient',
        failureDetail: 'injected non-production harness failure',
        now,
      })
      if (!transitioned) metrics.transitionFailures += 1
      return 'failed'
    }
    if (!await store.beginAttempt({
      workId: work.workId,
      leaseOwner: lease.leaseOwner,
      leaseId: lease.leaseId,
      expectedStatus: pending.leased,
      now,
    })) {
      metrics.transitionFailures += 1
      return 'failed'
    }
    if (!await store.transitionLeased({
      workId: work.workId,
      leaseOwner: lease.leaseOwner,
      leaseId: lease.leaseId,
      expectedStatus: pending.leased,
      nextStatus: pending.next,
      now,
    })) {
      metrics.transitionFailures += 1
      return 'failed'
    }
    work = store.getResearchWork(work.workId)!
  }
  if (work.status === 'research_ready' && store.promoteResearchReady(work.workId, now)) {
    work = store.getResearchWork(work.workId)!
  }
  return work.status === 'complete' ? 'completed' : 'failed'
}

function pendingStage(status: WorkStatus): {
  pending: 'research_pending' | 'synthesis_pending' | 'entity_pending'
  leased: 'retrieval_leased' | 'synthesis_leased' | 'entity_leased'
  next: 'synthesis_pending' | 'research_ready' | 'complete'
} | null {
  if (status === 'research_pending') return {
    pending: 'research_pending', leased: 'retrieval_leased', next: 'synthesis_pending',
  }
  if (status === 'synthesis_pending') return {
    pending: 'synthesis_pending', leased: 'synthesis_leased', next: 'research_ready',
  }
  if (status === 'entity_pending') return {
    pending: 'entity_pending', leased: 'entity_leased', next: 'complete',
  }
  return null
}

function fixtureSignal(ordinal: number, now: string): NewsSignal {
  const id = sequenceId(ordinal)
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: `signal-load-${id}`,
    sourceType: 'news',
    sourceId: `load-fixture:${id}`,
    contentKind: 'article',
    content: { schemaVersion: 'myboon.signal_content.article.v1', fixtureOrdinal: ordinal },
    observedAt: now,
    publishedAt: now,
    canonicalUrl: `https://fixture.invalid/load/${id}`,
    title: `Non-production load fixture ${id}`,
    visibleSummary: null,
    media: { imageUrl: null, attribution: 'Feed V3 load harness' },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: {
      provider: 'non-production-fixture', upstreamSource: null, rawPayloadRef: `fixture:${id}`,
    },
    idempotencyKey: `load-fixture:${id}`,
  }
}

function fixtureWork(ordinal: number, now: string, logicalStart: string): ResearchWorkItem {
  const id = sequenceId(ordinal)
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION,
    workId: `work-load-${id}`,
    signalId: `signal-load-${id}`,
    sourceType: 'news',
    researchDepth: 'light',
    deepReason: null,
    deepEscalation: null,
    priorityClass: ordinal % 10 === 0 ? 'P1' : 'P2',
    priorityScore: ordinal % 10 === 0 ? 0.9 : 0.5,
    freshnessDeadline: new Date(Date.parse(logicalStart) + 7 * 86_400_000).toISOString(),
    policyVersion: 'load-harness.priority.v1',
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: {
      sourceUrl: `https://fixture.invalid/load/${id}`, allowedDomains: ['fixture.invalid'], maxExternalSources: 0,
    },
    budget: {
      maxProviderCalls: 0, maxRepairCalls: 0, maxInputTokens: 0,
      maxOutputTokens: 0, maxToolCalls: 0, maxWallTimeMs: 1_000,
    },
    status: 'research_pending',
    attemptCount: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseId: null,
    leaseExpiresAt: null,
    failureCategory: null,
    failureDetail: null,
    retryTargetStatus: null,
    traceId: `trace-load-${id}`,
    createdAt: now,
    updatedAt: now,
  }
}

function artifact(
  config: LoadSoakHarnessConfig,
  metrics: MutableMetrics,
  mode: LoadSoakHarnessArtifact['mode'],
  generatedAt: string,
  wallTimeMs: number,
  initialReasons: string[] = [],
): LoadSoakHarnessArtifact {
  const completionRatio = metrics.admitted === 0 ? 0 : metrics.completed / metrics.admitted
  const p95 = percentile(metrics.queueDepths, 0.95)
  const max = metrics.queueDepths.length === 0 ? 0 : Math.max(...metrics.queueDepths)
  const reasons = [...initialReasons]
  if (mode === 'executed' && completionRatio < config.thresholds.minCompletionRatio) {
    reasons.push(`completion_ratio ${round(completionRatio)} < ${config.thresholds.minCompletionRatio}`)
  }
  if (mode === 'executed' && max > config.thresholds.maxQueueDepth) {
    reasons.push(`max_queue_depth ${max} > ${config.thresholds.maxQueueDepth}`)
  }
  if (mode === 'executed' && metrics.sqliteErrors > config.thresholds.maxSqliteErrors) {
    reasons.push(`sqlite_errors ${metrics.sqliteErrors} > ${config.thresholds.maxSqliteErrors}`)
  }
  if (mode === 'executed' && metrics.transitionFailures > config.thresholds.maxTransitionFailures) {
    reasons.push(
      `transition_failures ${metrics.transitionFailures} > ${config.thresholds.maxTransitionFailures}`,
    )
  }
  if (mode === 'executed' && metrics.unexpectedErrors > 0) {
    reasons.push(`unexpected_errors ${metrics.unexpectedErrors} > 0`)
  }
  return {
    schemaVersion: LOAD_SOAK_ARTIFACT_VERSION,
    mode,
    evidenceClass: 'non_production_sqlite_queue_harness',
    runId: runId(config),
    generatedAt,
    simulation: {
      logicalStart: config.logicalStart,
      durationSeconds: config.durationSeconds,
      tickSeconds: config.tickSeconds,
      baselineAdmittedArrivalsPerSecond: config.baselineAdmittedArrivalsPerSecond,
      admittedArrivalMultiplier: config.admittedArrivalMultiplier,
      completionCapacityPerSecond: config.completionCapacityPerSecond,
      wallTimeMs: round(wallTimeMs),
    },
    counts: {
      offered: metrics.offered,
      admitted: metrics.admitted,
      completed: metrics.completed,
      duplicateAppends: metrics.duplicateAppends,
      collisions: metrics.collisions,
      injectedFailures: metrics.injectedFailures,
      transitionFailures: metrics.transitionFailures,
      sqliteErrors: metrics.sqliteErrors,
      unexpectedErrors: metrics.unexpectedErrors,
    },
    ratesPerSecond: {
      offered: rate(metrics.offered, wallTimeMs / 1_000),
      admitted: rate(metrics.admitted, wallTimeMs / 1_000),
      completed: rate(metrics.completed, wallTimeMs / 1_000),
    },
    queueDepth: {
      samples: metrics.queueDepths.length,
      p95,
      max,
      final: metrics.queueDepths.at(-1) ?? 0,
    },
    thresholds: { ...config.thresholds },
    passed: mode === 'executed' && reasons.length === 0,
    failureReasons: reasons,
    limitations: LIMITATIONS,
  }
}

async function guarded<T>(metrics: MutableMetrics, operation: () => T | Promise<T>): Promise<T | null> {
  try {
    return await operation()
  } catch (error) {
    if (isSqliteError(error)) metrics.sqliteErrors += 1
    else metrics.unexpectedErrors += 1
    return null
  }
}

function validateConfig(config: LoadSoakHarnessConfig): void {
  positiveInteger(config.durationSeconds, 'durationSeconds', 86_400)
  positiveInteger(config.tickSeconds, 'tickSeconds', 60)
  if (config.tickSeconds > config.durationSeconds) throw new Error('tickSeconds cannot exceed durationSeconds')
  positiveNumber(config.baselineAdmittedArrivalsPerSecond, 'baselineAdmittedArrivalsPerSecond', 10_000)
  positiveNumber(config.admittedArrivalMultiplier, 'admittedArrivalMultiplier', 100)
  positiveNumber(config.completionCapacityPerSecond, 'completionCapacityPerSecond', 10_000)
  nonNegativeInteger(config.duplicateEvery, 'duplicateEvery', 100_000)
  nonNegativeInteger(config.collisionEvery, 'collisionEvery', 100_000)
  nonNegativeInteger(config.failureEvery, 'failureEvery', 100_000)
  nonNegativeInteger(config.thresholds.maxQueueDepth, 'thresholds.maxQueueDepth', 1_000_000)
  unitNumber(config.thresholds.minCompletionRatio, 'thresholds.minCompletionRatio')
  nonNegativeInteger(config.thresholds.maxSqliteErrors, 'thresholds.maxSqliteErrors', 1_000_000)
  nonNegativeInteger(config.thresholds.maxTransitionFailures, 'thresholds.maxTransitionFailures', 1_000_000)
  if (!Number.isFinite(Date.parse(config.logicalStart))) throw new Error('logicalStart must be a timestamp')
  const offered = config.durationSeconds
    * config.baselineAdmittedArrivalsPerSecond
    * config.admittedArrivalMultiplier
  if (offered > 100_000) throw new Error('Harness is bounded to at most 100000 offered items')
}

function emptyMetrics(): MutableMetrics {
  return {
    offered: 0, admitted: 0, completed: 0, duplicateAppends: 0, collisions: 0,
    injectedFailures: 0, transitionFailures: 0, sqliteErrors: 0,
    unexpectedErrors: 0, queueDepths: [],
  }
}

function unfinishedCount(byStatus: Partial<Record<WorkStatus, number>>): number {
  const terminal = new Set<WorkStatus>(['archived', 'complete', 'expired', 'dead_letter'])
  return Object.entries(byStatus).reduce(
    (sum, [status, count]) => sum + (terminal.has(status as WorkStatus) ? 0 : count ?? 0),
    0,
  )
}

function shouldInject(every: number, workId: string): boolean {
  if (every === 0) return false
  const ordinal = Number(workId.slice(-6))
  return Number.isSafeInteger(ordinal) && ordinal % every === 0
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!
}

function runId(config: LoadSoakHarnessConfig): string {
  const stable = JSON.stringify({
    durationSeconds: config.durationSeconds,
    tickSeconds: config.tickSeconds,
    baselineAdmittedArrivalsPerSecond: config.baselineAdmittedArrivalsPerSecond,
    admittedArrivalMultiplier: config.admittedArrivalMultiplier,
    completionCapacityPerSecond: config.completionCapacityPerSecond,
    duplicateEvery: config.duplicateEvery,
    collisionEvery: config.collisionEvery,
    failureEvery: config.failureEvery,
    logicalStart: config.logicalStart,
    thresholds: config.thresholds,
  })
  return `load-soak-${createHash('sha256').update(stable).digest('hex').slice(0, 24)}`
}

function isSqliteError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && typeof (error as { code?: unknown }).code === 'string'
    && (error as { code: string }).code.startsWith('SQLITE_')
}

function rate(count: number, seconds: number): number { return seconds <= 0 ? 0 : round(count / seconds) }
function round(value: number): number { return Number(value.toFixed(6)) }
function sequenceId(value: number): string { return String(value).padStart(6, '0') }

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
}

function positiveInteger(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`)
  }
}

function nonNegativeInteger(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`)
  }
}

function positiveNumber(value: number, name: string, max: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be greater than 0 and at most ${max}`)
  }
}

function unitNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`)
  }
}
