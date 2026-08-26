import { InferenceGatewayError, type InferenceTelemetry } from '../inference-gateway'
import type {
  ExecutionEventStatus,
  ExecutionTraceEvent,
  FailureCategory,
  PriorityClass,
  ResearchPacketV1,
  ResearchWorkItem,
  RetrievedEvidence,
  Signal,
} from '../signal-platform/contracts'
import { EXECUTION_EVENT_SCHEMA_VERSION } from '../signal-platform/contracts'
import { stableContractId } from '../signal-platform/adapters/identity'
import type { ExecutionLedger } from '../signal-platform/execution-ledger'
import type { CanonicalPlatformStore } from '../signal-platform/platform-store'
import { adaptRetrievedEvidenceArtifact } from '../signal-platform/retrieved-evidence-adapter'
import {
  SharedResearchScheduler,
  type ClaimNextCommand,
  type GlobalSchedulerQuery,
} from '../signal-platform/shared-scheduler'
import type { SchedulerStage, WorkLease } from '../signal-platform/store-adapter'
import {
  DeterministicRetriever,
  RetrievalPlanError,
  type DeterministicRetrievalPlan,
  type RetrievalBatch,
  type RetrievalFailure,
  type RetrievedEvidenceArtifact,
} from './deterministic-retrieval'
import { StructuredResearchSynthesizer } from './structured-synthesizer'
import type { BoundedStandardSearch, StandardSearchPlan } from './search-connector'
import {
  WorkContractEvidenceReusePolicy,
  type EvidenceReusePolicyPort,
  withEvidenceReuseContext,
} from './evidence-reuse-policy'

export type SharedResearchWorkerMode = 'off' | 'shadow' | 'active'
export type SharedResearchWorkerOwnership = 'legacy' | 'shared'
export type ResearchWorkerStage = Extract<SchedulerStage, 'retrieval' | 'synthesis'>

export interface SharedResearchWorkPort extends CanonicalPlatformStore {
  /** Atomic CAS from research_ready to entity_pending. */
  promoteResearchReady(workId: string, now: string): boolean
}

export interface SharedResearchSchedulerPort {
  peekGlobal(query: GlobalSchedulerQuery): Promise<ResearchWorkItem[]>
  claimNext(command: ClaimNextCommand): Promise<WorkLease | null>
}

export interface StandardResearchSearchPort extends Pick<BoundedStandardSearch, 'discover'> {}

export interface ResearchExecutionLedgerPort extends Pick<ExecutionLedger, 'append'> {}

export interface DeepResearchPort {
  /** Must be idempotent by workItem.workId so a fenced handoff can be replayed. */
  enqueue(input: {
    workItem: ResearchWorkItem
    signal: Signal
    evidence: readonly RetrievedEvidence[]
  }): Promise<void>
}

export type StageReadinessDecision =
  | { ready: true }
  | { ready: false, category: 'circuit_open', detail: string, retryAfterMs?: number }

export interface StageReadinessPort {
  /** Optional workload-level gate evaluated before the scheduler can claim. */
  checkStage?(stage: ResearchWorkerStage): Promise<StageReadinessDecision>
  check(input: {
    stage: ResearchWorkerStage | 'deep_research'
    workItem: ResearchWorkItem
  }): Promise<StageReadinessDecision>
}

export interface SharedWorkerClock {
  now(): Date
  setInterval(callback: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
}

export interface SharedResearchWorkerOptions {
  workerId: string
  stores: SharedResearchWorkPort[]
  scheduler?: SharedResearchSchedulerPort
  retriever: DeterministicRetriever
  synthesizer: StructuredResearchSynthesizer
  /** Required for admitted standard work; absent configuration fails closed. */
  standardSearch?: StandardResearchSearchPort
  /** Best-effort immutable instrumentation. Queue correctness never depends on it. */
  executionLedger?: ResearchExecutionLedgerPort
  deepResearch?: DeepResearchPort
  readiness?: StageReadinessPort
  mode?: SharedResearchWorkerMode
  ownership?: SharedResearchWorkerOwnership
  legacyClaimersActive?: boolean
  stages?: ResearchWorkerStage[]
  /** Optional capacity partition for dedicated urgent/background worker pools. */
  priorityClasses?: PriorityClass[]
  leaseTtlMs?: number
  heartbeatIntervalMs?: number
  maxAttempts?: number
  maxBackoffMs?: number
  retrieval?: Partial<ResearchRetrievalLimits>
  evidenceReadLimit?: number
  evidenceReusePolicy?: EvidenceReusePolicyPort
  clock?: SharedWorkerClock
}

export interface ResearchRetrievalLimits {
  maxSources: number
  maxBytesPerSource: number
  maxTotalBytes: number
  maxTextCharsPerSource: number
  maxRedirects: number
  timeoutMs: number
}

export type SharedResearchRunOutcome =
  | { kind: 'disabled' }
  | { kind: 'idle' }
  | { kind: 'shadow', sampled: number, ready: number, issues: string[] }
  | { kind: 'succeeded', stage: ResearchWorkerStage, sourceType: ResearchWorkItem['sourceType'], workId: string }
  | { kind: 'deep_routed', sourceType: ResearchWorkItem['sourceType'], workId: string }
  | { kind: 'released', stage: ResearchWorkerStage, sourceType: ResearchWorkItem['sourceType'], workId: string, category: 'circuit_open' }
  | { kind: 'retry_wait' | 'dead_letter' | 'expired', stage: ResearchWorkerStage, sourceType: ResearchWorkItem['sourceType'], workId: string, category: FailureCategory }
  | { kind: 'lease_lost' | 'handoff_pending', stage: ResearchWorkerStage, sourceType: ResearchWorkItem['sourceType'], workId: string }

export class SharedResearchWorkerConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SharedResearchWorkerConfigurationError'
  }
}

export class SharedResearchWorker {
  private readonly workerId: string
  private readonly stores: ReadonlyMap<ResearchWorkItem['sourceType'], SharedResearchWorkPort>
  private readonly scheduler: SharedResearchSchedulerPort
  private readonly retriever: DeterministicRetriever
  private readonly synthesizer: StructuredResearchSynthesizer
  private readonly standardSearch?: StandardResearchSearchPort
  private readonly executionLedger?: ResearchExecutionLedgerPort
  private readonly deepResearch?: DeepResearchPort
  private readonly readiness?: StageReadinessPort
  private readonly mode: SharedResearchWorkerMode
  private readonly ownership: SharedResearchWorkerOwnership
  private readonly stages: ResearchWorkerStage[]
  private readonly priorityClasses?: PriorityClass[]
  private readonly leaseTtlMs: number
  private readonly heartbeatIntervalMs: number
  private readonly maxAttempts: number
  private readonly maxBackoffMs: number
  private readonly retrievalLimits: ResearchRetrievalLimits
  private readonly evidenceReadLimit: number
  private readonly evidenceReusePolicy: EvidenceReusePolicyPort
  private readonly clock: SharedWorkerClock
  private stopping = false
  private readonly active = new Set<Promise<SharedResearchRunOutcome>>()

  constructor(options: SharedResearchWorkerOptions) {
    if (!options.workerId.trim()) throw new SharedResearchWorkerConfigurationError('workerId is required')
    if (options.stores.length === 0) throw new SharedResearchWorkerConfigurationError('At least one source store is required')
    this.workerId = options.workerId
    this.mode = options.mode ?? 'off'
    this.ownership = options.ownership ?? 'legacy'
    if (this.mode === 'active' && this.ownership !== 'shared') {
      throw new SharedResearchWorkerConfigurationError('Active shared worker requires shared ownership')
    }
    if (this.mode === 'active' && options.legacyClaimersActive !== false) {
      throw new SharedResearchWorkerConfigurationError('Active shared worker requires an explicit legacyClaimersActive=false topology guard')
    }

    const stores = new Map<ResearchWorkItem['sourceType'], SharedResearchWorkPort>()
    for (const store of options.stores) {
      if (stores.has(store.sourceType)) throw new SharedResearchWorkerConfigurationError(`Duplicate store for ${store.sourceType}`)
      stores.set(store.sourceType, store)
    }
    this.stores = stores
    this.scheduler = options.scheduler ?? new SharedResearchScheduler(options.stores)
    this.retriever = options.retriever
    this.synthesizer = options.synthesizer
    this.standardSearch = options.standardSearch
    this.executionLedger = options.executionLedger
    this.deepResearch = options.deepResearch
    this.readiness = options.readiness
    this.stages = uniqueStages(options.stages ?? ['retrieval', 'synthesis'])
    this.priorityClasses = optionalPriorityClasses(options.priorityClasses)
    this.leaseTtlMs = boundedInteger(options.leaseTtlMs ?? 60_000, 'leaseTtlMs', 1_000, 60 * 60_000)
    this.heartbeatIntervalMs = boundedInteger(
      options.heartbeatIntervalMs ?? Math.max(500, Math.floor(this.leaseTtlMs / 3)),
      'heartbeatIntervalMs',
      100,
      this.leaseTtlMs,
    )
    this.maxAttempts = boundedInteger(options.maxAttempts ?? 3, 'maxAttempts', 1, 20)
    this.maxBackoffMs = boundedInteger(options.maxBackoffMs ?? 15 * 60_000, 'maxBackoffMs', 1_000, 24 * 60 * 60_000)
    this.evidenceReadLimit = boundedInteger(options.evidenceReadLimit ?? 100, 'evidenceReadLimit', 1, 1_000)
    this.retrievalLimits = validateRetrievalLimits({
      maxSources: 5,
      maxBytesPerSource: 1_000_000,
      maxTotalBytes: 3_000_000,
      maxTextCharsPerSource: 100_000,
      maxRedirects: 3,
      timeoutMs: 30_000,
      ...options.retrieval,
    })
    this.evidenceReusePolicy = options.evidenceReusePolicy ?? new WorkContractEvidenceReusePolicy({
      maxArtifactBytes: this.retrievalLimits.maxBytesPerSource,
    })
    this.clock = options.clock ?? SYSTEM_CLOCK
  }

  runOnce(): Promise<SharedResearchRunOutcome> {
    if (this.mode === 'off') return Promise.resolve({ kind: 'disabled' })
    if (this.stopping) return Promise.resolve({ kind: 'idle' })
    if (this.mode === 'shadow') return this.sampleReadiness()

    const task = this.claimAndProcess()
    this.active.add(task)
    void task.then(
      () => this.active.delete(task),
      () => this.active.delete(task),
    )
    return task
  }

  async runBatch(limit: number): Promise<SharedResearchRunOutcome[]> {
    boundedInteger(limit, 'limit', 1, 250)
    const outcomes: SharedResearchRunOutcome[] = []
    for (let index = 0; index < limit && !this.stopping; index += 1) {
      const outcome = await this.runOnce()
      outcomes.push(outcome)
      if (outcome.kind === 'idle' || outcome.kind === 'disabled' || outcome.kind === 'shadow') break
    }
    return outcomes
  }

  async stop(options: { drain?: boolean } = {}): Promise<void> {
    this.stopping = true
    if (options.drain !== false) await Promise.allSettled([...this.active])
  }

  private async sampleReadiness(): Promise<SharedResearchRunOutcome> {
    const items = await this.scheduler.peekGlobal({
      now: this.nowIso(),
      limit: 25,
      stages: this.stages,
      priorityClasses: this.priorityClasses,
    })
    const issues: string[] = []
    let ready = 0
    for (const work of items) {
      const store = this.stores.get(work.sourceType)
      const signal = store?.getSignal(work.signalId) ?? null
      const issue = validateLinkage(work, signal, store)
      if (issue === null) ready += 1
      else issues.push(`${work.sourceType}:${work.workId}:${issue}`)
    }
    return { kind: 'shadow', sampled: items.length, ready, issues }
  }

  private async claimAndProcess(): Promise<SharedResearchRunOutcome> {
    const now = this.nowIso()
    let claimableStages = this.stages
    if (this.readiness?.checkStage !== undefined) {
      const decisions = await Promise.all(this.stages.map(async (stage) => ({
        stage,
        readiness: await this.readiness!.checkStage!(stage),
      })))
      claimableStages = decisions.filter((item) => item.readiness.ready).map((item) => item.stage)
      if (claimableStages.length === 0) return { kind: 'idle' }
    }
    const lease = await this.scheduler.claimNext({
      now,
      leaseOwner: this.workerId,
      leaseTtlMs: this.leaseTtlMs,
      stages: claimableStages,
      priorityClasses: this.priorityClasses,
    })
    if (lease === null) return { kind: 'idle' }
    const store = this.stores.get(lease.work.sourceType)
    if (store === undefined) {
      throw new SharedResearchWorkerConfigurationError(`Scheduler returned unregistered source ${lease.work.sourceType}`)
    }
    return lease.work.status === 'retrieval_leased'
      ? this.processRetrieval(store, lease)
      : this.processSynthesis(store, lease)
  }

  private async processRetrieval(store: SharedResearchWorkPort, lease: WorkLease): Promise<SharedResearchRunOutcome> {
    const stage = 'retrieval' as const
    const timing = stageTiming(lease, this.nowIso())
    const preflight = await this.preflight(stage, store, lease, timing)
    if (preflight !== null) return preflight
    const signal = store.getSignal(lease.work.signalId)
    const linkageIssue = validateLinkage(lease.work, signal, store)
    if (linkageIssue !== null) {
      return this.failWithoutExecution(store, lease, stage, 'permanent_source_error', linkageIssue, timing)
    }

    const existingEvidence = store.listEvidenceByWork(lease.work.workId, this.evidenceReadLimit)
    const reusableEvidence = existingEvidence.filter((artifact) => this.evidenceReusePolicy.evaluate({
      artifact, workItem: lease.work, signal: signal!, now: this.nowIso(),
    }).reusable)
    if (reusableEvidence.length > 0) {
      try {
        const outcome = await this.advanceRetrievedWork(store, lease, signal!, reusableEvidence)
        this.recordArtifactReplay(lease, stage, reusableEvidence[0]!.retrievedAt, reusableEvidence.map((item) => item.evidenceId))
        return outcome
      } catch (error) {
        return this.failWithoutExecution(
          store, lease, stage, failureCategory(error, stage), errorMessage(error), timing,
        )
      }
    }

    let plan: DeterministicRetrievalPlan
    try {
      plan = buildRetrievalPlan(lease.work, this.retrievalLimits)
    } catch (error) {
      return this.failWithoutExecution(store, lease, stage, 'permanent_source_error', errorMessage(error), timing)
    }
    if (lease.work.researchDepth === 'standard' && !this.standardSearch) {
      return this.failWithoutExecution(
        store, lease, stage, 'retrieval_blocked',
        'Standard research requires a registered bounded search connector', timing,
      )
    }
    if (!await this.beginAttempt(store, lease, 'retrieval_leased')) return leaseLost(stage, lease.work)

    const heartbeat = this.startHeartbeat(store, lease)
    try {
      if (!await heartbeat.check()) return leaseLost(stage, lease.work)
      if (lease.work.researchDepth === 'standard') {
        const discovery = await this.standardSearch!.discover({
          signal: signal!, work: lease.work, queries: buildStandardSearchQueries(signal!),
        })
        plan = mergeStandardSearchPlan(plan, discovery)
      }
      const batch = await this.retriever.retrieve(plan)
      if (!await heartbeat.check()) return leaseLost(stage, lease.work)
      if (batch.artifacts.length === 0) {
        const failure = selectRetrievalFailure(batch)
        return await this.failAfterExecution(store, lease, stage, failure.category, failure.message, failure.retryable, timing)
      }
      const evidence = batch.artifacts.map((artifact) => withEvidenceReuseContext(
        adaptRetrievedEvidenceArtifact(artifact), { signal: signal!, workItem: lease.work },
      ))
      for (const artifact of evidence) store.appendEvidence(artifact)
      this.recordExecution(lease, stage, timing, {
        status: 'succeeded', attempt: lease.work.attemptCount + 1,
      })
      return await this.advanceRetrievedWork(store, lease, signal!, evidence)
    } catch (error) {
      return this.failAfterExecution(
        store, lease, stage, failureCategory(error, stage), errorMessage(error), retryable(error), timing,
      )
    } finally {
      heartbeat.stop()
    }
  }

  private async advanceRetrievedWork(
    store: SharedResearchWorkPort,
    lease: WorkLease,
    signal: Signal,
    evidence: readonly RetrievedEvidence[],
  ): Promise<SharedResearchRunOutcome> {
    if (lease.work.researchDepth === 'deep') {
      if (this.deepResearch === undefined) {
        throw new ResearchStageFailure('provider_unavailable', true, 'Deep research side-queue port is not configured')
      }
      await this.deepResearch.enqueue({ workItem: lease.work, signal, evidence })
    }
    const transitioned = await store.transitionLeased({
      ...leaseFence(lease), expectedStatus: 'retrieval_leased',
      nextStatus: lease.work.researchDepth === 'deep' ? 'deep_pending' : 'synthesis_pending',
      now: this.nowIso(), attemptDelta: 0, failureCategory: null, failureDetail: null, nextAttemptAt: null,
    })
    if (!transitioned) return leaseLost('retrieval', lease.work)
    return lease.work.researchDepth === 'deep'
      ? { kind: 'deep_routed', sourceType: lease.work.sourceType, workId: lease.work.workId }
      : success('retrieval', lease.work)
  }

  private async processSynthesis(store: SharedResearchWorkPort, lease: WorkLease): Promise<SharedResearchRunOutcome> {
    const stage = 'synthesis' as const
    const timing = stageTiming(lease, this.nowIso())
    if (lease.work.researchDepth === 'deep') {
      return this.failWithoutExecution(
        store, lease, stage, 'schema_version_mismatch',
        'Deep work cannot enter the shared structured-synthesis stage', timing,
      )
    }
    const signal = store.getSignal(lease.work.signalId)
    const linkageIssue = validateLinkage(lease.work, signal, store)
    if (linkageIssue !== null || signal === null) {
      return this.failWithoutExecution(store, lease, stage, 'permanent_source_error', linkageIssue ?? 'signal missing', timing)
    }
    const existingPackets = store.listResearchPacketsByWork(lease.work.workId, 2)
    if (existingPackets.length > 1) {
      return this.failWithoutExecution(
        store, lease, stage, 'storage_permanent', 'More than one canonical packet exists for one work contract', timing,
      )
    }
    if (existingPackets.length === 1) {
      const existing = existingPackets[0]
      if (existing.workId !== lease.work.workId || existing.signalId !== lease.work.signalId
        || existing.sourceType !== lease.work.sourceType
        || existing.researchContractVersion !== lease.work.researchContractVersion) {
        return this.failWithoutExecution(
          store, lease, stage, 'schema_version_mismatch', 'Existing Research Packet linkage is invalid', timing,
        )
      }
      const outcome = await this.completeSynthesisHandoff(store, lease)
      this.recordPacketReplay(lease, existing)
      return outcome
    }
    const evidence = store.listEvidenceByWork(lease.work.workId, this.evidenceReadLimit).filter((artifact) =>
      this.evidenceReusePolicy.evaluate({
        artifact, workItem: lease.work, signal, now: this.nowIso(),
      }).reusable)
    if (evidence.length === 0) {
      return this.failWithoutExecution(
        store, lease, stage, 'permanent_source_error',
        'Synthesis requires at least one freshness-approved immutable evidence artifact', timing,
      )
    }
    const preflight = await this.preflight(stage, store, lease, timing)
    if (preflight !== null) return preflight
    if (!await this.beginAttempt(store, lease, 'synthesis_leased')) return leaseLost(stage, lease.work)

    const heartbeat = this.startHeartbeat(store, lease)
    try {
      if (!await heartbeat.check()) return leaseLost(stage, lease.work)
      const packet = await this.synthesizer.synthesize({
        signal,
        workItem: lease.work,
        evidence: evidence.map(toDeterministicEvidence),
      })
      if (!await heartbeat.check()) return leaseLost(stage, lease.work)
      store.appendResearchPacket(packet)
      this.recordSynthesisSuccess(lease, packet, timing)
      return this.completeSynthesisHandoff(store, lease)
    } catch (error) {
      return this.failAfterExecution(
        store, lease, stage, failureCategory(error, stage), errorMessage(error), retryable(error), timing,
        error instanceof InferenceGatewayError && error.telemetry
          ? telemetryExecutionProvenance(error.telemetry)
          : undefined,
      )
    } finally {
      heartbeat.stop()
    }
  }

  private async completeSynthesisHandoff(
    store: SharedResearchWorkPort,
    lease: WorkLease,
  ): Promise<SharedResearchRunOutcome> {
    const transitioned = await store.transitionLeased({
      ...leaseFence(lease), expectedStatus: 'synthesis_leased', nextStatus: 'research_ready',
      now: this.nowIso(), attemptDelta: 0, failureCategory: null, failureDetail: null, nextAttemptAt: null,
    })
    if (!transitioned) return leaseLost('synthesis', lease.work)
    try {
      const promoted = await store.promoteResearchReady(lease.work.workId, this.nowIso())
      return promoted ? success('synthesis', lease.work) : handoffPending('synthesis', lease.work)
    } catch {
      // The fenced synthesis completion is already durable. A dispatcher may
      // safely replay only this CAS handoff; it must not rerun inference.
      return handoffPending('synthesis', lease.work)
    }
  }

  private async preflight(
    stage: ResearchWorkerStage | 'deep_research',
    store: SharedResearchWorkPort,
    lease: WorkLease,
    timing: StageTiming,
  ): Promise<SharedResearchRunOutcome | null> {
    if (Date.parse(lease.work.freshnessDeadline) <= this.clock.now().getTime()) {
      const workerStage = stage === 'deep_research' ? 'synthesis' : stage
      const transitioned = await store.transitionLeased({
        ...leaseFence(lease), expectedStatus: leasedStatus(workerStage), nextStatus: 'expired',
        now: this.nowIso(), attemptDelta: 0, failureCategory: 'budget_exceeded', failureDetail: 'Freshness deadline elapsed',
      })
      if (!transitioned) return leaseLost(workerStage, lease.work)
      this.recordExecution(lease, workerStage, timing, {
        status: 'expired', failureCategory: 'budget_exceeded', attempt: lease.work.attemptCount,
      })
      return terminal('expired', workerStage, lease.work, 'budget_exceeded')
    }
    if (this.readiness === undefined) return null
    const readiness = await this.readiness.check({ stage, workItem: lease.work })
    if (readiness.ready) return null
    const workerStage = stage === 'deep_research' ? 'synthesis' : stage
    const released = await store.releaseLease({
      ...leaseFence(lease), expectedStatus: leasedStatus(workerStage), targetStatus: pendingStatus(workerStage), now: this.nowIso(),
    })
    if (!released) return leaseLost(workerStage, lease.work)
    this.recordExecution(lease, workerStage, timing, {
      status: 'skipped', failureCategory: 'circuit_open', attempt: lease.work.attemptCount,
      discriminator: `preflight:${lease.leaseId}`,
    })
    return { kind: 'released', stage: workerStage, sourceType: lease.work.sourceType, workId: lease.work.workId, category: 'circuit_open' }
  }

  private async beginAttempt(
    store: SharedResearchWorkPort,
    lease: WorkLease,
    expectedStatus: 'retrieval_leased' | 'synthesis_leased',
  ): Promise<boolean> {
    return store.beginAttempt({ ...leaseFence(lease), expectedStatus, now: this.nowIso() })
  }

  private startHeartbeat(store: SharedResearchWorkPort, lease: WorkLease): { check(): Promise<boolean>, stop(): void } {
    let stopped = false
    let lost = false
    let inFlight: Promise<boolean> | null = null
    const beat = async (): Promise<boolean> => {
      if (stopped || lost) return !lost
      if (inFlight !== null) return inFlight
      inFlight = store.heartbeatLease({
        ...leaseFence(lease), now: this.nowIso(),
        leaseExpiresAt: new Date(this.clock.now().getTime() + this.leaseTtlMs).toISOString(),
      }).then((held) => {
        if (!held) lost = true
        return held
      }).finally(() => { inFlight = null })
      return inFlight
    }
    const handle = this.clock.setInterval(() => { void beat() }, this.heartbeatIntervalMs)
    return {
      check: beat,
      stop: () => {
        stopped = true
        this.clock.clearInterval(handle)
      },
    }
  }

  private async failWithoutExecution(
    store: SharedResearchWorkPort,
    lease: WorkLease,
    stage: ResearchWorkerStage,
    category: FailureCategory,
    detail: string,
    timing: StageTiming,
  ): Promise<SharedResearchRunOutcome> {
    return this.transitionFailure(store, lease, stage, category, detail, false, false, timing)
  }

  private async failAfterExecution(
    store: SharedResearchWorkPort,
    lease: WorkLease,
    stage: ResearchWorkerStage,
    category: FailureCategory,
    detail: string,
    mayRetry: boolean,
    timing: StageTiming,
    provenance?: ExecutionProvenance,
  ): Promise<SharedResearchRunOutcome> {
    return this.transitionFailure(store, lease, stage, category, detail, mayRetry, true, timing, provenance)
  }

  private async transitionFailure(
    store: SharedResearchWorkPort,
    lease: WorkLease,
    stage: ResearchWorkerStage,
    category: FailureCategory,
    detail: string,
    mayRetry: boolean,
    attemptBegan: boolean,
    timing: StageTiming,
    provenance?: ExecutionProvenance,
  ): Promise<SharedResearchRunOutcome> {
    const now = this.clock.now()
    const attempts = lease.work.attemptCount + (attemptBegan ? 1 : 0)
    const expired = Date.parse(lease.work.freshnessDeadline) <= now.getTime()
    const kind = expired ? 'expired' : mayRetry && attempts < this.maxAttempts ? 'retry_wait' : 'dead_letter'
    const nextAttemptAt = kind === 'retry_wait'
      ? new Date(now.getTime() + this.backoffMs(Math.max(1, attempts))).toISOString()
      : null
    const transitioned = await store.transitionLeased({
      ...leaseFence(lease), expectedStatus: leasedStatus(stage), nextStatus: kind,
      now: now.toISOString(), attemptDelta: 0, failureCategory: category,
      failureDetail: truncate(detail, 1_000), nextAttemptAt,
    })
    if (!transitioned) return leaseLost(stage, lease.work)
    this.recordExecution(lease, stage, timing, {
      status: kind, failureCategory: category,
      attempt: lease.work.attemptCount + (attemptBegan ? 1 : 0),
      provenance,
    })
    return terminal(kind, stage, lease.work, category)
  }

  private recordExecution(
    lease: WorkLease,
    stage: ResearchWorkerStage,
    timing: StageTiming,
    input: {
      status: ExecutionEventStatus
      attempt: number
      failureCategory?: FailureCategory | null
      discriminator?: string
      provenance?: ExecutionProvenance
    },
  ): void {
    const finishedAt = this.nowIso()
    this.appendExecutionEvent({
      ...baseExecutionEvent({
        lease, stage, timing, finishedAt,
        status: input.status, attempt: input.attempt,
        failureCategory: input.failureCategory ?? null,
        discriminator: input.discriminator ?? `attempt:${input.attempt}`,
      }),
      ...input.provenance,
    })
  }

  private recordSynthesisSuccess(lease: WorkLease, packet: ResearchPacketV1, timing: StageTiming): void {
    const finishedAt = packet.createdAt
    const startedAt = subtractMs(finishedAt, packet.budgetUsed.wallTimeMs)
    this.appendExecutionEvent({
      ...baseExecutionEvent({
        lease, stage: 'synthesis', timing: { ...timing, startedAt }, finishedAt,
        status: 'succeeded', attempt: packet.execution.attempt,
        failureCategory: null, discriminator: `packet:${packet.packetId}`,
      }),
      packetId: packet.packetId,
      wallTimeMs: packet.budgetUsed.wallTimeMs,
      provider: packet.execution.provider,
      model: packet.execution.model,
      fallbackProvider: packet.execution.fallbackProvider,
      fallbackModel: packet.execution.fallbackModel,
      fallbackUsed: packet.execution.fallbackUsed,
      configuredPrimaryProvider: packet.execution.configuredPrimaryProvider ?? null,
      configuredPrimaryModel: packet.execution.configuredPrimaryModel ?? null,
      fallbackReason: packet.execution.fallbackReason ?? null,
      outputSchemaValid: packet.execution.outputSchemaValid ?? null,
      promptVersion: packet.execution.promptVersion,
      policyVersion: packet.execution.policyVersion,
      researchContractVersion: packet.researchContractVersion,
      providerCalls: packet.budgetUsed.providerCalls,
      repairCalls: packet.budgetUsed.repairCalls,
      inputTokens: packet.budgetUsed.inputTokens,
      outputTokens: packet.budgetUsed.outputTokens,
      toolCalls: packet.budgetUsed.toolCalls,
      budgetExceeded: packet.budgetUsed.budgetExceeded,
    })
  }

  private recordPacketReplay(lease: WorkLease, packet: ResearchPacketV1): void {
    const timing = { startedAt: packet.createdAt, queueWaitMs: 0 }
    this.appendExecutionEvent({
      ...baseExecutionEvent({
        lease, stage: 'synthesis', timing, finishedAt: packet.createdAt,
        status: 'skipped', attempt: packet.execution.attempt, failureCategory: null,
        discriminator: `packet_replay:${packet.packetId}`, packetId: packet.packetId,
      }),
      configuredPrimaryProvider: packet.execution.configuredPrimaryProvider ?? null,
      configuredPrimaryModel: packet.execution.configuredPrimaryModel ?? null,
      fallbackReason: packet.execution.fallbackReason ?? null,
      outputSchemaValid: packet.execution.outputSchemaValid ?? null,
      promptVersion: packet.execution.promptVersion,
      policyVersion: packet.execution.policyVersion,
    })
  }

  private recordArtifactReplay(
    lease: WorkLease,
    stage: 'retrieval',
    anchor: string,
    evidenceIds: string[],
  ): void {
    this.appendExecutionEvent(baseExecutionEvent({
      lease, stage, timing: { startedAt: anchor, queueWaitMs: 0 }, finishedAt: anchor,
      status: 'skipped', attempt: lease.work.attemptCount, failureCategory: null,
      discriminator: `evidence_replay:${stableContractId('evidence_set', ...[...evidenceIds].sort())}`,
    }))
  }

  private appendExecutionEvent(event: ExecutionTraceEvent): void {
    if (!this.executionLedger) return
    try {
      this.executionLedger.append(event)
    } catch {
      // Observability is deliberately best-effort. Queue state and immutable
      // artifacts remain authoritative when the ledger is unavailable.
    }
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.maxBackoffMs, 1_000 * (2 ** Math.min(20, attempt - 1)))
  }

  private nowIso(): string {
    return this.clock.now().toISOString()
  }
}

export function buildRetrievalPlan(
  work: ResearchWorkItem,
  limits: ResearchRetrievalLimits,
): DeterministicRetrievalPlan {
  const sourceUrl = work.retrievalPlan.sourceUrl
  if (sourceUrl === null) throw new RetrievalPlanError('Work item has no approved sourceUrl')
  if (work.retrievalPlan.allowedDomains.length === 0) throw new RetrievalPlanError('Work item has no approved domains')
  return {
    workId: work.workId,
    urls: [{ url: sourceUrl, authority: 'source_url', authorityId: work.signalId }],
    allowedDomains: [...work.retrievalPlan.allowedDomains],
    maxSources: Math.min(limits.maxSources, 1 + work.retrievalPlan.maxExternalSources),
    maxBytesPerSource: limits.maxBytesPerSource,
    maxTotalBytes: limits.maxTotalBytes,
    maxTextCharsPerSource: limits.maxTextCharsPerSource,
    maxRedirects: limits.maxRedirects,
    timeoutMs: Math.min(limits.timeoutMs, work.budget.maxWallTimeMs),
    freshnessDeadline: work.freshnessDeadline,
  }
}

/** Code-owned and deterministic; providers cannot author search queries. */
export function buildStandardSearchQueries(signal: Signal): string[] {
  const identity = [signal.title, ...signal.sourceHints.entities, ...signal.sourceHints.assets]
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 120)
  const summary = signal.visibleSummary?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? ''
  return [...new Set([identity, summary].filter(Boolean))]
}

function mergeStandardSearchPlan(
  retrieval: DeterministicRetrievalPlan,
  discovery: StandardSearchPlan,
): DeterministicRetrievalPlan {
  const seen = new Set<string>()
  const urls = [...retrieval.urls, ...discovery.urls].filter((item) => {
    const normalized = new URL(item.url).toString()
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  }).slice(0, retrieval.maxSources)
  return { ...retrieval, urls }
}

type ExecutionProvenance = Pick<ExecutionTraceEvent,
  | 'provider'
  | 'model'
  | 'fallbackProvider'
  | 'fallbackModel'
  | 'fallbackUsed'
  | 'configuredPrimaryProvider'
  | 'configuredPrimaryModel'
  | 'fallbackReason'
  | 'outputSchemaValid'
  | 'promptVersion'
  | 'policyVersion'
  | 'providerCalls'
  | 'repairCalls'
  | 'inputTokens'
  | 'outputTokens'
  | 'toolCalls'
  | 'wallTimeMs'
  | 'budgetExceeded'
>

function telemetryExecutionProvenance(telemetry: InferenceTelemetry): ExecutionProvenance {
  return {
    provider: telemetry.actualProvider,
    model: telemetry.actualModel,
    fallbackProvider: telemetry.fallbackInvoked ? telemetry.actualProvider : null,
    fallbackModel: telemetry.fallbackInvoked ? telemetry.actualModel : null,
    fallbackUsed: telemetry.fallbackInvoked,
    configuredPrimaryProvider: telemetry.configuredPrimaryProvider,
    configuredPrimaryModel: telemetry.configuredPrimaryModel,
    fallbackReason: telemetry.fallbackReason,
    outputSchemaValid: telemetry.schemaValid,
    promptVersion: telemetry.promptVersion,
    policyVersion: telemetry.policyVersion,
    providerCalls: telemetry.providerCalls,
    repairCalls: telemetry.repairCalls,
    inputTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    toolCalls: telemetry.toolCalls,
    wallTimeMs: telemetry.durationMs,
    budgetExceeded: telemetry.budgetExceeded,
  }
}

interface StageTiming {
  startedAt: string
  queueWaitMs: number
}

function stageTiming(lease: WorkLease, startedAt: string): StageTiming {
  return {
    startedAt,
    queueWaitMs: elapsedMs(lease.queuedAt, startedAt),
  }
}

function baseExecutionEvent(input: {
  lease: WorkLease
  stage: ResearchWorkerStage
  timing: StageTiming
  finishedAt: string
  status: ExecutionEventStatus
  attempt: number
  failureCategory: FailureCategory | null
  discriminator: string
  packetId?: string | null
}): ExecutionTraceEvent {
  const work = input.lease.work
  return {
    schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
    eventId: stableContractId('execution_event', work.traceId, input.stage, input.discriminator),
    traceId: work.traceId,
    signalId: work.signalId,
    workId: work.workId,
    packetId: input.packetId ?? null,
    sourceType: work.sourceType,
    stage: input.stage,
    attempt: input.attempt,
    startedAt: input.timing.startedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    failureCategory: input.failureCategory,
    // Persist only the typed category. Provider messages can contain prompts,
    // evidence, credentials, or other prose and never belong in this ledger.
    failureDetail: input.failureCategory ? `failure:${input.failureCategory}` : null,
    queueWaitMs: input.timing.queueWaitMs,
    wallTimeMs: elapsedMs(input.timing.startedAt, input.finishedAt),
    provider: null,
    model: null,
    fallbackProvider: null,
    fallbackModel: null,
    fallbackUsed: false,
    configuredPrimaryProvider: null,
    configuredPrimaryModel: null,
    fallbackReason: null,
    outputSchemaValid: null,
    promptVersion: null,
    policyVersion: work.policyVersion,
    researchContractVersion: work.researchContractVersion,
    providerCalls: 0,
    repairCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    budgetExceeded: input.failureCategory === 'budget_exceeded',
    createdAt: input.finishedAt,
  }
}

function elapsedMs(start: string, finish: string): number {
  const value = Date.parse(finish) - Date.parse(start)
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function subtractMs(timestamp: string, durationMs: number): string {
  const finish = Date.parse(timestamp)
  return new Date(finish - Math.max(0, durationMs)).toISOString()
}

class ResearchStageFailure extends Error {
  constructor(readonly category: FailureCategory, readonly retryable: boolean, message: string) {
    super(message)
    this.name = 'ResearchStageFailure'
  }
}

function validateLinkage(
  work: ResearchWorkItem,
  signal: Signal | null,
  store: SharedResearchWorkPort | undefined,
): string | null {
  if (store === undefined) return 'source store is not registered'
  if (signal === null) return 'canonical signal is missing'
  if (work.sourceType !== store.sourceType || signal.sourceType !== work.sourceType) return 'source isolation mismatch'
  if (signal.signalId !== work.signalId) return 'signal linkage mismatch'
  return null
}

function selectRetrievalFailure(batch: RetrievalBatch): RetrievalFailure {
  return batch.failures[0] ?? {
    requestedUrl: '', category: 'permanent_source_error', retryable: false,
    message: 'Deterministic retrieval returned no evidence',
  }
}

function toDeterministicEvidence(evidence: RetrievedEvidence): RetrievedEvidenceArtifact {
  if (evidence.retrievalMethod !== 'safe_http') {
    throw new RetrievalPlanError('Structured synthesis accepts only deterministic safe_http evidence')
  }
  return {
    schemaVersion: evidence.schemaVersion,
    evidenceId: evidence.evidenceId,
    workId: evidence.workId,
    requestedUrl: evidence.requestedUrl,
    finalUrl: evidence.finalUrl,
    authority: evidence.authority,
    authorityId: evidence.authorityId,
    contentHash: evidence.contentHash,
    contentType: evidence.contentType,
    httpStatus: evidence.httpStatus,
    retrievalMethod: 'safe_http',
    retrievedAt: evidence.retrievedAt,
    text: evidence.text,
    byteLength: evidence.byteLength,
    truncated: evidence.truncated,
  }
}

function failureCategory(error: unknown, stage: ResearchWorkerStage): FailureCategory {
  if (error instanceof InferenceGatewayError && isFailureCategory(error.category)) return error.category
  if (error instanceof RetrievalPlanError) return 'permanent_source_error'
  if (isTypedFailure(error) && isFailureCategory(error.category)) return error.category
  return stage === 'retrieval' ? 'permanent_source_error' : 'provider_unavailable'
}

function retryable(error: unknown): boolean {
  return isTypedFailure(error) ? error.retryable : false
}

function isTypedFailure(error: unknown): error is { category: string, retryable: boolean } {
  return typeof error === 'object' && error !== null
    && typeof (error as { category?: unknown }).category === 'string'
    && typeof (error as { retryable?: unknown }).retryable === 'boolean'
}

function isFailureCategory(value: string): value is FailureCategory {
  return FAILURE_CATEGORIES.has(value as FailureCategory)
}

function leaseFence(lease: WorkLease): Pick<WorkLease, 'leaseOwner' | 'leaseId'> & { workId: string } {
  return { workId: lease.work.workId, leaseOwner: lease.leaseOwner, leaseId: lease.leaseId }
}

function leasedStatus(stage: ResearchWorkerStage): 'retrieval_leased' | 'synthesis_leased' {
  return stage === 'retrieval' ? 'retrieval_leased' : 'synthesis_leased'
}

function pendingStatus(stage: ResearchWorkerStage): 'research_pending' | 'synthesis_pending' {
  return stage === 'retrieval' ? 'research_pending' : 'synthesis_pending'
}

function success(stage: ResearchWorkerStage, work: ResearchWorkItem): SharedResearchRunOutcome {
  return { kind: 'succeeded', stage, sourceType: work.sourceType, workId: work.workId }
}

function leaseLost(stage: ResearchWorkerStage, work: ResearchWorkItem): SharedResearchRunOutcome {
  return { kind: 'lease_lost', stage, sourceType: work.sourceType, workId: work.workId }
}

function handoffPending(stage: ResearchWorkerStage, work: ResearchWorkItem): SharedResearchRunOutcome {
  return { kind: 'handoff_pending', stage, sourceType: work.sourceType, workId: work.workId }
}

function terminal(
  kind: 'retry_wait' | 'dead_letter' | 'expired',
  stage: ResearchWorkerStage,
  work: ResearchWorkItem,
  category: FailureCategory,
): SharedResearchRunOutcome {
  return { kind, stage, sourceType: work.sourceType, workId: work.workId, category }
}

function uniqueStages(stages: ResearchWorkerStage[]): ResearchWorkerStage[] {
  const result = [...new Set(stages)]
  if (result.length === 0 || result.some((stage) => stage !== 'retrieval' && stage !== 'synthesis')) {
    throw new SharedResearchWorkerConfigurationError('stages must include retrieval and/or synthesis')
  }
  return result
}

function optionalPriorityClasses(values: PriorityClass[] | undefined): PriorityClass[] | undefined {
  if (values === undefined) return undefined
  const result = [...new Set(values)]
  const allowed = new Set<PriorityClass>(['P0', 'P1', 'P2', 'P3'])
  if (result.length === 0 || result.some((value) => !allowed.has(value))) {
    throw new SharedResearchWorkerConfigurationError('priorityClasses must contain one or more valid priority classes')
  }
  return result
}

function validateRetrievalLimits(limits: ResearchRetrievalLimits): ResearchRetrievalLimits {
  boundedInteger(limits.maxSources, 'retrieval.maxSources', 1, 100)
  boundedInteger(limits.maxBytesPerSource, 'retrieval.maxBytesPerSource', 1, 100_000_000)
  boundedInteger(limits.maxTotalBytes, 'retrieval.maxTotalBytes', 1, 500_000_000)
  boundedInteger(limits.maxTextCharsPerSource, 'retrieval.maxTextCharsPerSource', 1, 10_000_000)
  boundedInteger(limits.maxRedirects, 'retrieval.maxRedirects', 0, 20)
  boundedInteger(limits.timeoutMs, 'retrieval.timeoutMs', 1, 60 * 60_000)
  if (limits.maxTotalBytes < limits.maxBytesPerSource) {
    throw new SharedResearchWorkerConfigurationError('retrieval.maxTotalBytes must cover maxBytesPerSource')
  }
  return limits
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SharedResearchWorkerConfigurationError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

const FAILURE_CATEGORIES = new Set<FailureCategory>([
  'provider_unavailable', 'provider_rate_limited', 'provider_timeout', 'provider_authentication',
  'circuit_open', 'retrieval_timeout', 'retrieval_blocked', 'retrieval_unsafe_url',
  'budget_exceeded', 'invalid_structured_output', 'schema_version_mismatch',
  'permanent_source_error', 'entity_resolution_failed', 'storage_transient', 'storage_permanent',
])

const SYSTEM_CLOCK: SharedWorkerClock = {
  now: () => new Date(),
  setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
}
