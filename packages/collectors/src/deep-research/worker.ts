import { createHash } from 'node:crypto'
import type {
  ExecutionEventStatus,
  ExecutionTraceEvent,
  FailureCategory,
  ResearchPacketV1,
  ResearchWorkItem,
  RetrievedEvidence,
  Signal,
} from '../signal-platform/contracts'
import { EXECUTION_EVENT_SCHEMA_VERSION } from '../signal-platform/contracts'
import type { ExecutionLedger } from '../signal-platform/execution-ledger'
import type { CanonicalPlatformStore } from '../signal-platform/platform-store'
import {
  SharedResearchScheduler,
  type ClaimNextCommand,
  type GlobalSchedulerQuery,
} from '../signal-platform/shared-scheduler'
import type { WorkLease } from '../signal-platform/store-adapter'
import { validateExecutionTraceEvent } from '../signal-platform/validation'
import { DeepResearchError } from './errors'
import { validateDeepResearchJob } from './executor'
import {
  assembleDeepResearchPacket,
  deterministicDeepPacketId,
  parseDeepResearchOutput,
  type DeepResearchPacketPolicyMetadata,
} from './packet-output'
import {
  DEEP_RESEARCH_JOB_SCHEMA_VERSION,
  type DeepResearchBudget,
  type DeepResearchCapability,
  type DeepResearchErrorCategory,
  type DeepResearchJob,
  type DeepResearchResult,
} from './types'

export interface DeepResearchWorkStore extends CanonicalPlatformStore {}

export interface DeepResearchSchedulerPort {
  peekGlobal(query: GlobalSchedulerQuery): Promise<ResearchWorkItem[]>
  claimNext(command: ClaimNextCommand): Promise<WorkLease | null>
}

/** Calling execute is the contained process-start boundary for attempt accounting. */
export interface ContainedDeepResearchExecutionPort {
  execute(job: DeepResearchJob, options?: { signal?: AbortSignal }): Promise<DeepResearchResult>
}

export type DeepResearchPreflightReason =
  | 'circuit_open'
  | 'containment_disabled'
  | 'unsupported_platform'
  | 'systemd_unavailable'

export interface DeepResearchPreflightPort {
  /** Process-wide containment/configuration gate. Runs before any deep lease is acquired. */
  checkStage?(): Promise<
    | { ready: true }
    | { ready: false, reason: DeepResearchPreflightReason, detail: string }
  >
  check(job: DeepResearchJob): Promise<
    | { ready: true }
    | { ready: false, reason: DeepResearchPreflightReason, detail: string }
  >
}

export interface DeepResearchJobPolicy {
  promptVersion: string
  provider: string
  model: string
  capabilities: readonly DeepResearchCapability[]
  maxBrowserNavigations: number
  maxSearchQueries: number
  maxHttpFetches: number
  maxOutputBytes: number
  cpuQuotaPercent: number
  memoryMaxBytes: number
  tasksMax: number
  unresolvedQuestion(input: {
    workItem: ResearchWorkItem
    signal: Signal
    evidence: readonly RetrievedEvidence[]
  }): string
}

export interface DeepResearchWorkerClock {
  now(): Date
  setInterval(callback: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
}

export interface DeepResearchSideQueueWorkerOptions {
  workerId: string
  stores: DeepResearchWorkStore[]
  executor: ContainedDeepResearchExecutionPort
  policy: DeepResearchJobPolicy
  scheduler?: DeepResearchSchedulerPort
  preflight?: DeepResearchPreflightPort
  leaseTtlMs?: number
  heartbeatIntervalMs?: number
  evidenceReadLimit?: number
  maxAttempts?: number
  maxBackoffMs?: number
  clock?: DeepResearchWorkerClock
  /** Optional immutable observer. Its failures never alter queue outcomes. */
  executionLedger?: Pick<ExecutionLedger, 'append'>
}

export type DeepResearchWorkerOutcome =
  | { kind: 'idle' }
  | { kind: 'succeeded', workId: string, sourceType: ResearchWorkItem['sourceType'] }
  | { kind: 'handoff_pending', workId: string, sourceType: ResearchWorkItem['sourceType'] }
  | { kind: 'released', workId: string, sourceType: ResearchWorkItem['sourceType'], reason: DeepResearchPreflightReason }
  | { kind: 'retry_wait' | 'dead_letter' | 'expired', workId: string, sourceType: ResearchWorkItem['sourceType'], category: FailureCategory }
  | { kind: 'lease_lost', workId: string, sourceType: ResearchWorkItem['sourceType'] }

export class DeepResearchWorkerConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeepResearchWorkerConfigurationError'
  }
}

const FAIL_CLOSED_PREFLIGHT: DeepResearchPreflightPort = {
  check: async () => ({
    ready: false,
    reason: 'containment_disabled',
    detail: 'Deep containment readiness was not explicitly configured',
  }),
}

export class DeepResearchSideQueueWorker {
  private readonly workerId: string
  private readonly stores: ReadonlyMap<ResearchWorkItem['sourceType'], DeepResearchWorkStore>
  private readonly scheduler: DeepResearchSchedulerPort
  private readonly executor: ContainedDeepResearchExecutionPort
  private readonly preflight: DeepResearchPreflightPort
  private readonly policy: DeepResearchJobPolicy
  private readonly leaseTtlMs: number
  private readonly heartbeatIntervalMs: number
  private readonly evidenceReadLimit: number
  private readonly maxAttempts: number
  private readonly maxBackoffMs: number
  private readonly clock: DeepResearchWorkerClock
  private readonly executionLedger?: Pick<ExecutionLedger, 'append'>
  private stopping = false
  private readonly active = new Set<Promise<DeepResearchWorkerOutcome>>()

  constructor(options: DeepResearchSideQueueWorkerOptions) {
    if (!options.workerId.trim()) throw new DeepResearchWorkerConfigurationError('workerId is required')
    if (options.stores.length === 0) throw new DeepResearchWorkerConfigurationError('At least one source store is required')
    this.workerId = options.workerId
    const stores = new Map<ResearchWorkItem['sourceType'], DeepResearchWorkStore>()
    for (const store of options.stores) {
      if (stores.has(store.sourceType)) throw new DeepResearchWorkerConfigurationError(`Duplicate store for ${store.sourceType}`)
      stores.set(store.sourceType, store)
    }
    this.stores = stores
    this.scheduler = options.scheduler ?? new SharedResearchScheduler(options.stores)
    this.executor = options.executor
    this.preflight = options.preflight ?? FAIL_CLOSED_PREFLIGHT
    this.policy = validatePolicy(options.policy)
    this.leaseTtlMs = boundedInteger(options.leaseTtlMs ?? 60_000, 'leaseTtlMs', 1_000, 60 * 60_000)
    this.heartbeatIntervalMs = boundedInteger(
      options.heartbeatIntervalMs ?? Math.max(500, Math.floor(this.leaseTtlMs / 3)),
      'heartbeatIntervalMs', 100, this.leaseTtlMs,
    )
    this.evidenceReadLimit = boundedInteger(options.evidenceReadLimit ?? 250, 'evidenceReadLimit', 1, 1_000)
    this.maxAttempts = boundedInteger(options.maxAttempts ?? 3, 'maxAttempts', 1, 20)
    this.maxBackoffMs = boundedInteger(options.maxBackoffMs ?? 15 * 60_000, 'maxBackoffMs', 1_000, 24 * 60 * 60_000)
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.executionLedger = options.executionLedger
  }

  runOnce(): Promise<DeepResearchWorkerOutcome> {
    if (this.stopping) return Promise.resolve({ kind: 'idle' })
    const task = this.claimAndProcess()
    this.active.add(task)
    void task.then(() => this.active.delete(task), () => this.active.delete(task))
    return task
  }

  async stop(options: { drain?: boolean } = {}): Promise<void> {
    this.stopping = true
    if (options.drain !== false) await Promise.allSettled([...this.active])
  }

  private async claimAndProcess(): Promise<DeepResearchWorkerOutcome> {
    if (this.preflight.checkStage !== undefined && !await this.preclaimReady()) return { kind: 'idle' }
    const lease = await this.scheduler.claimNext({
      now: this.nowIso(), leaseOwner: this.workerId, leaseTtlMs: this.leaseTtlMs, stages: ['deep'],
    })
    if (lease === null) return { kind: 'idle' }
    const store = this.stores.get(lease.work.sourceType)
    if (store === undefined) throw new DeepResearchWorkerConfigurationError(`Unregistered source ${lease.work.sourceType}`)
    return this.process(store, lease)
  }

  /**
   * Production containment checks the exact queue head without mutating it.
   * Existing-packet handoff replay remains available during provider/systemd
   * outages because it does not start a contained unit.
   */
  private async preclaimReady(): Promise<boolean> {
    const now = this.nowIso()
    const [work] = await this.scheduler.peekGlobal({ now, limit: 1, stages: ['deep'] })
    if (!work) return false
    const store = this.stores.get(work.sourceType)
    if (!store) return false
    const packetId = deterministicDeepPacketId(work.workId, work.researchContractVersion)
    if (store.getResearchPacket(packetId) !== null) return true
    const signal = store.getSignal(work.signalId)
    const evidence = store.listEvidenceByWork(work.workId, this.evidenceReadLimit)
    if (signal === null || validateLinkage(store, work, signal, evidence) !== null) return false
    let job: DeepResearchJob
    try { job = buildDeepResearchJob({ workItem: work, signal, evidence, policy: this.policy }) } catch { return false }
    const stageReadiness = await this.preflight.checkStage!()
    if (!stageReadiness.ready) return false
    const jobReadiness = await this.preflight.check(job)
    return jobReadiness.ready
  }

  private async process(store: DeepResearchWorkStore, lease: WorkLease): Promise<DeepResearchWorkerOutcome> {
    if (lease.work.status !== 'deep_leased') return leaseLost(lease.work)
    if (Date.parse(lease.work.freshnessDeadline) <= this.clock.now().getTime()) {
      return this.transitionFailure(store, lease, 'budget_exceeded', 'Freshness deadline elapsed', false, false)
    }
    const signal = store.getSignal(lease.work.signalId)
    const evidence = store.listEvidenceByWork(lease.work.workId, this.evidenceReadLimit)
    const linkage = validateLinkage(store, lease.work, signal, evidence)
    if (linkage !== null || signal === null) {
      return this.transitionFailure(store, lease, 'permanent_source_error', linkage ?? 'Signal missing', false, false)
    }

    const packetId = deterministicDeepPacketId(lease.work.workId, lease.work.researchContractVersion)
    const existing = store.getResearchPacket(packetId)
    if (existing !== null) {
      if (existing.workId !== lease.work.workId || existing.signalId !== signal.signalId) {
        return this.transitionFailure(store, lease, 'storage_permanent', 'Existing packet linkage conflict', false, false)
      }
      const outcome = await this.completeHandoff(store, lease)
      this.recordPacketEvent(lease.work, existing)
      return outcome
    }

    let job: DeepResearchJob
    try {
      job = buildDeepResearchJob({ workItem: lease.work, signal, evidence, policy: this.policy })
    } catch (error) {
      return this.transitionFailure(store, lease, 'schema_version_mismatch', message(error), false, false)
    }
    const readiness = await this.preflight.check(job)
    if (!readiness.ready) {
      const released = await store.releaseLease({
        ...fence(lease), expectedStatus: 'deep_leased', targetStatus: 'deep_pending', now: this.nowIso(),
      })
      const outcome: DeepResearchWorkerOutcome = released
        ? { kind: 'released', workId: lease.work.workId, sourceType: lease.work.sourceType, reason: readiness.reason }
        : leaseLost(lease.work)
      this.recordEvent({
        work: lease.work,
        status: released ? 'skipped' : 'failed',
        attempt: lease.work.attemptCount,
        failureCategory: released ? preflightFailure(readiness.reason) : 'storage_transient',
        startedAt: lease.work.updatedAt,
        finishedAt: lease.work.updatedAt,
        queueWaitMs: elapsedMs(lease.queuedAt, lease.work.updatedAt),
        providerInvoked: false,
      })
      return outcome
    }

    const began = await store.beginAttempt({
      ...fence(lease), expectedStatus: 'deep_leased', now: this.nowIso(),
    })
    if (!began) {
      this.recordLeaseLostEvent(lease, false)
      return leaseLost(lease.work)
    }
    const logicalStartedAt = this.nowIso()
    const heartbeat = this.startHeartbeat(store, lease)
    let containedResult: DeepResearchResult | null = null
    try {
      if (!await heartbeat.check()) {
        this.recordLeaseLostEvent(lease, true, logicalStartedAt)
        return leaseLost(lease.work)
      }
      const result = await this.executor.execute(job)
      containedResult = result
      if (!await heartbeat.check()) {
        this.recordLeaseLostEvent(lease, true, logicalStartedAt, result)
        return leaseLost(lease.work)
      }
      if (result.status !== 'succeeded' || result.exitCode !== 0) {
        throw new DeepResearchError('Contained worker exited without a successful result', {
          category: 'execution_failed', retryable: true,
        })
      }
      const body = parseDeepResearchOutput(result.stdout, job, result.fetchedEvidence)
      const packet = assembleDeepResearchPacket({
        job,
        result,
        body,
        policy: packetPolicy(this.policy),
        attempt: lease.work.attemptCount + 1,
        createdAt: this.nowIso(),
        queuedAt: lease.queuedAt,
      })
      store.appendResearchPacket(packet)
      const outcome = await this.completeHandoff(store, lease)
      this.recordPacketEvent(lease.work, packet)
      return outcome
    } catch (error) {
      const mapped = mapExecutionFailure(error)
      return this.transitionFailure(
        store, lease, mapped.category, message(error), mapped.retryable, true,
        { startedAt: logicalStartedAt, result: containedResult, providerInvoked: true },
      )
    } finally {
      heartbeat.stop()
    }
  }

  private async completeHandoff(store: DeepResearchWorkStore, lease: WorkLease): Promise<DeepResearchWorkerOutcome> {
    const transitioned = await store.transitionLeased({
      ...fence(lease), expectedStatus: 'deep_leased', nextStatus: 'research_ready', now: this.nowIso(),
      attemptDelta: 0, failureCategory: null, failureDetail: null, nextAttemptAt: null,
    })
    if (!transitioned) return leaseLost(lease.work)
    try {
      return store.promoteResearchReady(lease.work.workId, this.nowIso())
        ? success(lease.work)
        : handoffPending(lease.work)
    } catch {
      return handoffPending(lease.work)
    }
  }

  private async transitionFailure(
    store: DeepResearchWorkStore,
    lease: WorkLease,
    category: FailureCategory,
    detail: string,
    retryable: boolean,
    attemptBegan: boolean,
    usage: { startedAt?: string, result?: DeepResearchResult | null, providerInvoked?: boolean } = {},
  ): Promise<DeepResearchWorkerOutcome> {
    const now = this.clock.now()
    const attempts = lease.work.attemptCount + (attemptBegan ? 1 : 0)
    const expired = Date.parse(lease.work.freshnessDeadline) <= now.getTime()
    const kind = expired ? 'expired' : retryable && attempts < this.maxAttempts ? 'retry_wait' : 'dead_letter'
    const transitioned = await store.transitionLeased({
      ...fence(lease), expectedStatus: 'deep_leased', nextStatus: kind, now: now.toISOString(),
      attemptDelta: 0, failureCategory: category, failureDetail: detail.slice(0, 1_000),
      nextAttemptAt: kind === 'retry_wait'
        ? new Date(now.getTime() + Math.min(this.maxBackoffMs, 1_000 * 2 ** Math.max(0, attempts - 1))).toISOString()
        : null,
    })
    const outcome: DeepResearchWorkerOutcome = transitioned
      ? { kind, workId: lease.work.workId, sourceType: lease.work.sourceType, category }
      : leaseLost(lease.work)
    const result = usage.result ?? null
    this.recordEvent({
      work: lease.work,
      status: transitioned ? kind : 'failed',
      attempt: attempts,
      failureCategory: transitioned ? category : 'storage_transient',
      startedAt: result?.startedAt ?? usage.startedAt ?? lease.work.updatedAt,
      finishedAt: result?.finishedAt ?? (attemptBegan ? now.toISOString() : lease.work.updatedAt),
      wallTimeMs: result?.durationMs,
      queueWaitMs: elapsedMs(lease.queuedAt, result?.startedAt ?? usage.startedAt ?? lease.work.updatedAt),
      measuredUsage: measuredUsage(result),
      providerInvoked: usage.providerInvoked ?? attemptBegan,
      budgetExceeded: category === 'budget_exceeded',
    })
    return outcome
  }

  private recordPacketEvent(work: ResearchWorkItem, packet: ResearchPacketV1): void {
    const execution = packet.execution
    const containedStartedAt = typeof execution.containedStartedAt === 'string'
      ? execution.containedStartedAt
      : new Date(Date.parse(packet.createdAt) - packet.budgetUsed.wallTimeMs).toISOString()
    const containedFinishedAt = typeof execution.containedFinishedAt === 'string'
      ? execution.containedFinishedAt
      : packet.createdAt
    this.recordEvent({
      work,
      packet,
      status: 'succeeded',
      attempt: execution.attempt,
      failureCategory: null,
      startedAt: containedStartedAt,
      finishedAt: containedFinishedAt,
      wallTimeMs: packet.budgetUsed.wallTimeMs,
      queueWaitMs: typeof execution.queueWaitMs === 'number' ? execution.queueWaitMs : 0,
      providerInvoked: packet.budgetUsed.providerCalls > 0,
      budgetExceeded: packet.budgetUsed.budgetExceeded,
    })
  }

  private recordLeaseLostEvent(
    lease: WorkLease,
    attemptBegan: boolean,
    startedAt?: string,
    result: DeepResearchResult | null = null,
  ): void {
    const work = lease.work
    const effectiveStartedAt = startedAt ?? work.updatedAt
    this.recordEvent({
      work,
      status: 'failed',
      attempt: work.attemptCount + (attemptBegan ? 1 : 0),
      failureCategory: 'storage_transient',
      startedAt: result?.startedAt ?? effectiveStartedAt,
      finishedAt: result?.finishedAt ?? this.nowIso(),
      wallTimeMs: result?.durationMs,
      queueWaitMs: elapsedMs(lease.queuedAt, result?.startedAt ?? effectiveStartedAt),
      measuredUsage: measuredUsage(result),
      providerInvoked: result !== null,
    })
  }

  private recordEvent(input: DeepExecutionEventInput): void {
    if (this.executionLedger === undefined) return
    try {
      this.executionLedger.append(deepExecutionEvent(input, this.policy))
    } catch {
      // Observability is deliberately best-effort. It cannot undo a contained
      // execution, immutable packet append, or fenced queue transition.
    }
  }

  private startHeartbeat(store: DeepResearchWorkStore, lease: WorkLease): { check(): Promise<boolean>, stop(): void } {
    let stopped = false
    let lost = false
    let active: Promise<boolean> | null = null
    const beat = async (): Promise<boolean> => {
      if (stopped || lost) return !lost
      if (active !== null) return active
      active = store.heartbeatLease({
        ...fence(lease), now: this.nowIso(),
        leaseExpiresAt: new Date(this.clock.now().getTime() + this.leaseTtlMs).toISOString(),
      }).then((held) => {
        if (!held) lost = true
        return held
      }).finally(() => { active = null })
      return active
    }
    const handle = this.clock.setInterval(() => { void beat() }, this.heartbeatIntervalMs)
    return { check: beat, stop: () => { stopped = true; this.clock.clearInterval(handle) } }
  }

  private nowIso(): string { return this.clock.now().toISOString() }
}

export function buildDeepResearchJob(input: {
  workItem: ResearchWorkItem
  signal: Signal
  evidence: readonly RetrievedEvidence[]
  policy: DeepResearchJobPolicy
}): DeepResearchJob {
  const { workItem, signal, evidence, policy } = input
  if (workItem.researchDepth !== 'deep' || workItem.deepReason === null) {
    throw new DeepResearchError('Only canonical deep work may enter the deep side queue', {
      category: 'invalid_job', retryable: false,
    })
  }
  const maxToolCalls = workItem.budget.maxToolCalls
  const budget: DeepResearchBudget = {
    maxProviderCalls: workItem.budget.maxProviderCalls,
    maxInputTokens: workItem.budget.maxInputTokens,
    maxOutputTokens: workItem.budget.maxOutputTokens,
    maxToolCalls,
    maxBrowserNavigations: policy.capabilities.includes('browser_navigation') ? Math.min(policy.maxBrowserNavigations, maxToolCalls) : 0,
    maxSearchQueries: policy.capabilities.includes('registered_search') ? Math.min(policy.maxSearchQueries, maxToolCalls) : 0,
    maxHttpFetches: policy.capabilities.includes('http_fetch') ? Math.min(policy.maxHttpFetches, maxToolCalls) : 0,
    maxWallTimeMs: workItem.budget.maxWallTimeMs,
    maxOutputBytes: policy.maxOutputBytes,
    cpuQuotaPercent: policy.cpuQuotaPercent,
    memoryMaxBytes: policy.memoryMaxBytes,
    tasksMax: policy.tasksMax,
  }
  const possibleCalls = budget.maxBrowserNavigations + budget.maxSearchQueries + budget.maxHttpFetches
  if (budget.maxToolCalls > possibleCalls) {
    throw new DeepResearchError('Policy capability limits do not cover the canonical tool-call budget', {
      category: 'invalid_job', retryable: false,
    })
  }
  const unresolvedQuestion = policy.unresolvedQuestion({ workItem, signal, evidence })
  const job: DeepResearchJob = {
    schemaVersion: DEEP_RESEARCH_JOB_SCHEMA_VERSION,
    jobId: deterministicDeepJobId(workItem.workId, workItem.researchContractVersion, policy.promptVersion),
    signal,
    workItem,
    evidence: evidence.map((item) => ({ ...item })),
    escalation: {
      reason: workItem.deepReason,
      unresolvedQuestion,
      supportingEvidenceRefs: evidence.map((item) => item.evidenceId),
    },
    approvedDomains: [...workItem.retrievalPlan.allowedDomains],
    capabilities: [...policy.capabilities],
    budget,
  }
  validateDeepResearchJob(job)
  return job
}

export function deterministicDeepJobId(workId: string, contractVersion: string, promptVersion: string): string {
  return `deep_job_${createHash('sha256').update(`${workId}\0${contractVersion}\0${promptVersion}`).digest('hex').slice(0, 32)}`
}

function validatePolicy(policy: DeepResearchJobPolicy): DeepResearchJobPolicy {
  for (const [name, value] of [
    ['promptVersion', policy.promptVersion], ['provider', policy.provider], ['model', policy.model],
  ] as const) {
    if (!value.trim() || value.length > 500) throw new DeepResearchWorkerConfigurationError(`${name} is required and bounded`)
  }
  const capabilities = [...new Set(policy.capabilities)]
  if (capabilities.length === 0 || capabilities.length !== policy.capabilities.length
    || capabilities.some((item) => !CAPABILITIES.has(item))) {
    throw new DeepResearchWorkerConfigurationError('capabilities must be a unique non-empty allowlisted set')
  }
  for (const field of ['maxBrowserNavigations', 'maxSearchQueries', 'maxHttpFetches', 'maxOutputBytes', 'memoryMaxBytes', 'tasksMax'] as const) {
    boundedInteger(policy[field], field, 0, Number.MAX_SAFE_INTEGER)
  }
  boundedInteger(policy.cpuQuotaPercent, 'cpuQuotaPercent', 1, 100)
  return { ...policy, capabilities }
}

function validateLinkage(
  store: DeepResearchWorkStore,
  work: ResearchWorkItem,
  signal: Signal | null,
  evidence: readonly RetrievedEvidence[],
): string | null {
  if (work.researchDepth !== 'deep' || work.deepReason === null) return 'Non-deep work entered the deep queue'
  if (signal === null) return 'Canonical signal is missing'
  if (work.sourceType !== store.sourceType || signal.sourceType !== work.sourceType) return 'Source isolation mismatch'
  if (signal.signalId !== work.signalId) return 'Signal linkage mismatch'
  if (evidence.length === 0) return 'Deep research requires canonical supporting evidence'
  if (evidence.some((item) => item.workId !== work.workId)) return 'Evidence linkage mismatch'
  return null
}

function mapExecutionFailure(error: unknown): { category: FailureCategory, retryable: boolean } {
  if (!(error instanceof DeepResearchError)) return { category: 'provider_unavailable', retryable: false }
  const mapping: Record<DeepResearchErrorCategory, FailureCategory> = {
    containment_disabled: 'provider_unavailable',
    unsupported_platform: 'provider_unavailable',
    systemd_unavailable: 'provider_unavailable',
    invalid_job: 'invalid_structured_output',
    budget_exceeded: 'budget_exceeded',
    timed_out: 'provider_timeout',
    cancelled: 'provider_timeout',
    execution_failed: 'provider_unavailable',
    containment_cleanup_failed: 'storage_permanent',
  }
  return { category: mapping[error.category], retryable: error.retryable }
}

function packetPolicy(policy: DeepResearchJobPolicy): DeepResearchPacketPolicyMetadata {
  return { provider: policy.provider, model: policy.model, promptVersion: policy.promptVersion }
}

function fence(lease: WorkLease): { workId: string, leaseOwner: string, leaseId: string } {
  return { workId: lease.work.workId, leaseOwner: lease.leaseOwner, leaseId: lease.leaseId }
}

function success(work: ResearchWorkItem): DeepResearchWorkerOutcome {
  return { kind: 'succeeded', workId: work.workId, sourceType: work.sourceType }
}

function handoffPending(work: ResearchWorkItem): DeepResearchWorkerOutcome {
  return { kind: 'handoff_pending', workId: work.workId, sourceType: work.sourceType }
}

function leaseLost(work: ResearchWorkItem): DeepResearchWorkerOutcome {
  return { kind: 'lease_lost', workId: work.workId, sourceType: work.sourceType }
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new DeepResearchWorkerConfigurationError(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

const CAPABILITIES = new Set<DeepResearchCapability>(['browser_navigation', 'registered_search', 'http_fetch'])

const SYSTEM_CLOCK: DeepResearchWorkerClock = {
  now: () => new Date(),
  setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
}

interface DeepExecutionEventInput {
  work: ResearchWorkItem
  packet?: ResearchPacketV1
  status: ExecutionEventStatus
  attempt: number
  failureCategory: FailureCategory | null
  startedAt: string
  finishedAt: string
  queueWaitMs?: number
  wallTimeMs?: number
  providerInvoked: boolean
  budgetExceeded?: boolean
  measuredUsage?: Pick<DeepResearchResult['budgetUsed'], 'providerCalls' | 'inputTokens' | 'outputTokens' | 'toolCalls'>
}

function deepExecutionEvent(input: DeepExecutionEventInput, policy: DeepResearchJobPolicy): ExecutionTraceEvent {
  const packet = input.packet
  const execution = packet?.execution
  const budget = packet?.budgetUsed
  const measuredUsage = budget ?? input.measuredUsage
  const event = validateExecutionTraceEvent({
    schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
    eventId: deepExecutionEventId(input),
    traceId: execution?.traceId ?? input.work.traceId,
    signalId: input.work.signalId,
    workId: input.work.workId,
    packetId: packet?.packetId ?? null,
    sourceType: input.work.sourceType,
    stage: 'deep_research',
    attempt: input.attempt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    failureCategory: input.failureCategory,
    failureDetail: redactedFailure(input.failureCategory),
    queueWaitMs: input.queueWaitMs ?? elapsedMs(input.work.updatedAt, input.startedAt),
    wallTimeMs: input.wallTimeMs ?? elapsedMs(input.startedAt, input.finishedAt),
    provider: input.providerInvoked ? execution?.provider ?? policy.provider : null,
    model: input.providerInvoked ? execution?.model ?? policy.model : null,
    fallbackProvider: null,
    fallbackModel: null,
    fallbackUsed: false,
    promptVersion: execution?.promptVersion ?? policy.promptVersion,
    policyVersion: execution?.policyVersion ?? input.work.policyVersion,
    researchContractVersion: packet?.researchContractVersion ?? input.work.researchContractVersion,
    providerCalls: measuredUsage?.providerCalls ?? 0,
    repairCalls: budget?.repairCalls ?? 0,
    inputTokens: measuredUsage?.inputTokens ?? 0,
    outputTokens: measuredUsage?.outputTokens ?? 0,
    toolCalls: measuredUsage?.toolCalls ?? 0,
    budgetExceeded: budget?.budgetExceeded ?? input.budgetExceeded ?? false,
    usageObserved: measuredUsage !== undefined,
    createdAt: input.finishedAt,
  })
  return Object.freeze(event)
}

function deepExecutionEventId(input: DeepExecutionEventInput): string {
  const canonical = [
    EXECUTION_EVENT_SCHEMA_VERSION,
    'deep_research_side_queue_worker',
    input.work.workId,
    input.packet?.packetId ?? '',
    String(input.attempt),
    input.status,
  ].join('\u001f')
  return `deep-execution:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

function preflightFailure(reason: DeepResearchPreflightReason): FailureCategory {
  return reason === 'circuit_open' ? 'circuit_open' : 'provider_unavailable'
}

function redactedFailure(category: FailureCategory | null): string | null {
  if (category === null) return null
  const labels: Record<FailureCategory, string> = {
    provider_unavailable: 'contained provider unavailable; details redacted',
    provider_rate_limited: 'contained provider rate limited; details redacted',
    provider_timeout: 'contained execution timed out; details redacted',
    provider_authentication: 'contained provider authentication failed; details redacted',
    circuit_open: 'contained execution circuit open; details redacted',
    retrieval_timeout: 'deep retrieval timed out; details redacted',
    retrieval_blocked: 'deep retrieval blocked; details redacted',
    retrieval_unsafe_url: 'deep retrieval URL rejected; details redacted',
    budget_exceeded: 'contained execution budget exceeded; details redacted',
    invalid_structured_output: 'contained structured output rejected; details redacted',
    schema_version_mismatch: 'deep schema version mismatch; details redacted',
    permanent_source_error: 'permanent source error; details redacted',
    entity_resolution_failed: 'entity resolution failed; details redacted',
    storage_transient: 'transient fencing or storage failure; details redacted',
    storage_permanent: 'permanent containment or storage failure; details redacted',
  }
  return labels[category]
}

function elapsedMs(start: string, finish: string): number {
  const value = Date.parse(finish) - Date.parse(start)
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function measuredUsage(
  result: DeepResearchResult | null,
): DeepExecutionEventInput['measuredUsage'] | undefined {
  if (result === null) return undefined
  const usage = result.budgetUsed
  return [usage.providerCalls, usage.inputTokens, usage.outputTokens, usage.toolCalls]
    .every((value) => Number.isInteger(value) && value >= 0)
    ? usage
    : undefined
}
