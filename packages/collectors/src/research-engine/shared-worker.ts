import { InferenceGatewayError, type InferenceTelemetry } from '../inference-gateway'
import { latestArticleCapture } from './article-capture'
import type {
  ExecutionEventStatus,
  ExecutionTraceEvent,
  FailureCategory,
  PriorityClass,
  ResearchPacketV1,
  ResearchPacket,
  ResearchWorkItem,
  RetrievedEvidence,
  Signal,
} from '../signal-platform/contracts'
import { EXECUTION_EVENT_SCHEMA_VERSION, isArticleResearchPacket } from '../signal-platform/contracts'
import { stableContractId } from '../signal-platform/adapters/identity'
import type { ExecutionLedger } from '../signal-platform/execution-ledger'
import type { CanonicalPlatformStore } from '../signal-platform/platform-store'
import { adaptRetrievedEvidenceArtifact } from '../signal-platform/retrieved-evidence-adapter'
import {
  assessRetrievalManifest,
  retrievalManifestHoldFailure,
  retrievalManifestMayProceed,
  retrievalPlanDigest,
  retrievalPlanId,
  validateRetrievalManifestLinkage,
  type RetrievalCapture,
  type RetrievalManifestV1,
  type RetrievalPlannedSource,
  type RetrievalPlanIdentityInput,
  type RetrievalSkipReason,
  type RetrievalSourceFailure,
} from '../signal-platform/retrieval-manifest'
import {
  assessResearchReadiness,
  createResolvedWithoutNewItemReadiness,
  isNonClaimableReadiness,
  researchHandoffEntityClaim,
  researchHandoffTerminalStatus,
  type ResearchHandoffRetryPolicy,
  type ResearchReadinessOutcome,
  type ResearchReadiness,
} from '../signal-platform/research-readiness'
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
  type RetrievedEvidenceArtifact,
} from './deterministic-retrieval'
import { StructuredResearchSynthesizer } from './structured-synthesizer'
import { gateSignal, type ResearchGateOptions } from '../research-gate/gate'
import type { EntityMemoryReader, GateDecision, GateSignal } from '../research-gate/types'
import { canonicalJson } from '../signal-platform/canonical-json'
import { createHash } from 'node:crypto'
import { sourceMaterialHash } from './evidence-reuse-policy'
import { supportsResearchV4Store, type ResearchV4StorePort } from './v4-store'
import { reuseCompatibleResearchResult, structuredAssignmentReuseContract, type ResearchReusePolicy } from './research-result-reuse'
import { reusePlannedSourceEvidence } from './cross-source-evidence-reuse'
import { runBoundedFollowup, ResearchFollowupHold, type BoundedFollowupPolicy } from './bounded-followup'
import { durableResearchClassification } from './durable-classification'
import { durablePrimarySynthesis, type PrimarySynthesisPolicy } from './durable-synthesis'
import { durableArticleEntityProposal } from './durable-article-proposal'
import type { ClassificationGateway } from '../inference-gateway'
import { ArticleResearchHold, prepareArticlePlacement, articleLookupTerms } from './article-placement'
import { isTransientContextFailure, type ArticleResearchContext } from '../research-gate/managed-context-reader'
import type { D2AssignmentLimitsSnapshot } from './assignment-budget'
import { capturedObservationDigest, resolveKnownObservation, assertKnownObservationResolution } from './known-observation'
import type { BoundedStandardSearch, StandardSearchPlan } from './search-connector'
import {
  WorkContractEvidenceReusePolicy,
  type EvidenceReusePolicyPort,
  withEvidenceReuseContext,
} from './evidence-reuse-policy'
import {
  linkArtifact,
  resolveArtifactUsage,
  type ArtifactConsumerPort,
  type ArtifactOwnerPort,
  type ArtifactPin,
  type ArtifactRef,
  type ArtifactUsage,
} from './artifact-repository'

export type SharedResearchWorkerMode = 'off' | 'shadow' | 'active'
export type SharedResearchWorkerOwnership = 'legacy' | 'shared'
export type ResearchWorkerStage = Extract<SchedulerStage, 'retrieval' | 'synthesis'>

export interface SharedResearchWorkPort extends CanonicalPlatformStore {
  /** Atomic CAS from research_ready to entity_pending. */
  promoteResearchReady(workId: string, now: string): boolean
  /**
   * Cross-source artifact-reuse surface (PRD §5.2). SQLite-backed stores
   * implement it; test fakes and non-SQLite stores stay valid without it.
   * The worker guards every call behind supportsArtifactReuse().
   */
  listRecentEvidence?(limit: number): RetrievedEvidence[]
  artifactStoreId?(): string
  pinArtifact?(ref: ArtifactRef, consumerStoreId: string, consumerWorkId: string, now: string): ArtifactPin
  getArtifactPin?(pinId: string): ArtifactPin | null
  resolvePinnedArtifact?(pin: ArtifactPin): RetrievedEvidence | null
  recordArtifactUsage?(usage: ArtifactUsage, pin: ArtifactPin | null): ArtifactUsage
}

/** Upper bound on cross-work background artifacts attached to one synthesis. */
const BACKGROUND_CONTEXT_LIMIT = 20

/**
 * The artifact-reuse surface SQLite-backed stores implement: the shared work
 * port plus the required owner/consumer artifact operations. Re-declaring the
 * optional port members as required makes post-narrowing calls direct.
 */
export type ArtifactReuseStore = SharedResearchWorkPort
  & ArtifactOwnerPort
  & ArtifactConsumerPort
  & {
    listRecentEvidence(limit: number): RetrievedEvidence[]
    artifactStoreId(): string
    pinArtifact(ref: ArtifactRef, consumerStoreId: string, consumerWorkId: string, now: string): ArtifactPin
    getArtifactPin(pinId: string): ArtifactPin | null
    resolvePinnedArtifact(pin: ArtifactPin): RetrievedEvidence | null
    recordArtifactUsage(usage: ArtifactUsage, pin: ArtifactPin | null): ArtifactUsage
  }

function supportsArtifactReuse(store: SharedResearchWorkPort): store is ArtifactReuseStore {
  return typeof store.artifactStoreId === 'function'
    && typeof store.listRecentEvidence === 'function'
    && typeof store.pinArtifact === 'function'
    && typeof store.getArtifactPin === 'function'
    && typeof store.resolvePinnedArtifact === 'function'
    && typeof store.recordArtifactUsage === 'function'
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
  /** V4 capabilities are explicitly composed; absent means the existing path. */
  v4?: SharedResearchV4Options
  mayExecuteWork?: (work: ResearchWorkItem) => boolean
  clock?: SharedWorkerClock
}

export interface SharedResearchV4Options {
  policyVersion: string
  synthesisPolicy: PrimarySynthesisPolicy
  assignmentPolicy: D2AssignmentLimitsSnapshot
  sources?: ReadonlySet<Signal['sourceType']>
  contextReader?: (signal: Signal, work: ResearchWorkItem) => EntityMemoryReader
  novelty?: Omit<ResearchGateOptions, 'reader'> & {
    reader(signal: Signal, work: ResearchWorkItem): EntityMemoryReader
  }
  reusePolicy?: ResearchReusePolicy
  followup?: {
    classification: Pick<ClassificationGateway, 'classify' | 'recordPolicyOutcome'>
    policy: BoundedFollowupPolicy
  }
  article?: {
    classification: Pick<ClassificationGateway, 'classify' | 'recordPolicyOutcome'>
    contextReader(signal: Signal, work: ResearchWorkItem): EntityMemoryReader
  }
}

type ArticleContextReader = EntityMemoryReader & {
  articleContext?(input?: { sourceUrl: string | null, terms: readonly string[] }): Promise<ArticleResearchContext>
}

interface PreparedArticleContext {
  source: RetrievedEvidence
  reader: ArticleContextReader
  context: ArticleResearchContext
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
  | { kind: 'readiness_held', sourceType: ResearchWorkItem['sourceType'], workId: string, outcome: ResearchReadinessOutcome, category: FailureCategory }
  | { kind: 'ownership_held', stage: ResearchWorkerStage, sourceType: ResearchWorkItem['sourceType'], workId: string }

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
  private readonly v4?: SharedResearchV4Options
  private readonly mayExecuteWork: (work: ResearchWorkItem) => boolean
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
      maxBytesPerSource: 3_000_000,
      maxTotalBytes: 9_000_000,
      maxTextCharsPerSource: 100_000,
      maxRedirects: 3,
      timeoutMs: 30_000,
      ...options.retrieval,
    })
    this.evidenceReusePolicy = options.evidenceReusePolicy ?? new WorkContractEvidenceReusePolicy({
      maxArtifactBytes: this.retrievalLimits.maxBytesPerSource,
    })
    this.clock = options.clock ?? SYSTEM_CLOCK
    this.v4 = options.v4
    this.mayExecuteWork = options.mayExecuteWork ?? (() => true)
    if (this.v4 && (!this.v4.policyVersion.trim()
      || options.stores.some((store) => !supportsResearchV4Store(store)))) {
      throw new SharedResearchWorkerConfigurationError('V4 Research requires a versioned policy and durable checkpoints/reservations on every source store')
    }
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

  /**
   * Retrieval is checkpointed, not inferred.
   *
   * A saved evidence cache is never on its own a completion marker: evidence can
   * exist for sources that were never checked, for a plan cut short, or for
   * content that came back truncated. Only a saved retrieval manifest states
   * what was and was not evaluated, so re-entry reuses a checkpoint and nothing
   * else. When there is no usable checkpoint the plan runs again and a new
   * manifest is committed with its evidence batch in one transaction.
   */
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

    let plan: DeterministicRetrievalPlan
    try {
      plan = buildRetrievalPlan(lease.work, this.retrievalLimits)
    } catch (error) {
      return this.failWithoutExecution(store, lease, stage, 'permanent_source_error', errorMessage(error), timing)
    }
    const capturedSourceWorkflow = this.usesCapturedSourceWorkflow(lease.work)
    if (capturedSourceWorkflow) {
      const sourceUrls = plan.urls.filter((item) => item.authority === 'source_url').slice(0, 1)
      if (sourceUrls.length !== 1) {
        return this.failWithoutExecution(store, lease, stage, 'permanent_source_error',
          'Captured-source Research requires one immutable source URL; web search and unsupported source inputs are held.', timing)
      }
      plan = { ...plan, urls: sourceUrls, maxSources: 1 }
    }
    if (lease.work.researchDepth === 'standard' && !capturedSourceWorkflow && !this.standardSearch) {
      return this.failWithoutExecution(
        store, lease, stage, 'retrieval_blocked',
        'Standard research requires a registered bounded search connector', timing,
      )
    }

    const identity = retrievalPlanIdentity(lease.work, plan)
    const savedCheckpoint = store.getLatestRetrievalManifest(lease.work.workId, identity.retrievalPlanId)
    const replayed = await this.reuseSavedCheckpoint(store, lease, signal!, savedCheckpoint, timing)
    if (replayed !== null) return replayed

    const heldResume = savedCheckpoint?.decision === 'hold_and_retry'
      ? this.prepareHeldCheckpointRetry(store, lease, signal!, plan, savedCheckpoint)
      : null
    if (heldResume !== null) plan = heldResume.plan

    if (!await this.beginAttempt(store, lease, 'retrieval_leased')) return leaseLost(stage, lease.work)

    const heartbeat = this.startHeartbeat(store, lease)
    try {
      if (!await heartbeat.check()) return leaseLost(stage, lease.work)
      this.recordExecutionStarted(lease, stage, timing, lease.work.attemptCount + 1)
      if (heldResume === null && lease.work.researchDepth === 'standard' && !capturedSourceWorkflow) {
        const discovery = await this.standardSearch!.discover({
          signal: signal!, work: lease.work, queries: buildStandardSearchQueries(signal!),
        })
        plan = mergeStandardSearchPlan(plan, discovery)
      }
      const reusable = this.v4?.reusePolicy && (!this.v4.sources || this.v4.sources.has(lease.work.sourceType))
        && supportsResearchV4Store(store) && supportsArtifactReuse(store)
        ? reusePlannedSourceEvidence({
          owners: [...this.stores.values()].filter(supportsArtifactReuse), consumer: store,
          signal: signal!, work: lease.work, urls: plan.urls.slice(0, plan.maxSources).map((item) => item.url),
          policy: this.v4.reusePolicy, now: this.nowIso(),
          maxBytesPerSource: plan.maxBytesPerSource, maxTotalBytes: plan.maxTotalBytes,
        }) : []
      const reusableUrls = new Set(reusable.map((artifact) => artifact.requestedUrl))
      const reusedBytes = reusable.reduce((sum, artifact) => sum + artifact.byteLength, 0)
      const remainingPlan = { ...plan, urls: plan.urls.filter((item) => !reusableUrls.has(item.url)),
        maxSources: plan.maxSources - reusable.length, maxTotalBytes: plan.maxTotalBytes - reusedBytes }
      const freshBatch = remainingPlan.urls.length > 0 && remainingPlan.maxSources > 0 && remainingPlan.maxTotalBytes > 0
        ? await this.retriever.retrieve(remainingPlan)
        : { workId: plan.workId, artifacts: [], failures: [], skippedUrlCount: 0, totalBytes: 0 }
      const batch: RetrievalBatch = {
        ...freshBatch, artifacts: [...freshBatch.artifacts, ...reusable.map(toDeterministicEvidence)],
        totalBytes: freshBatch.totalBytes + reusedBytes,
      }
      if (!await heartbeat.check()) return leaseLost(stage, lease.work)
      const evidence = batch.artifacts.map((artifact) => withEvidenceReuseContext(
        reusable.find((candidate) => candidate.evidenceId === artifact.evidenceId)
          ?? adaptRetrievedEvidenceArtifact(artifact), { signal: signal!, workItem: lease.work },
      ))
      const reusedEvidence = heldResume?.reusedEvidence ?? []
      const manifest = buildRetrievalManifest({
        work: lease.work,
        plan,
        batch,
        attempt: lease.work.attemptCount + 1,
        recordedAt: this.nowIso(),
        ...(heldResume === null ? {} : {
          previous: {
            manifest: heldResume.manifest,
            reusedEvidence,
            preservedSkippedSources: heldResume.preservedSkippedSources,
          },
        }),
      })
      let checkpoint
      try {
        checkpoint = store.commitRetrievalCheckpoint({
          manifest, evidence, fence: leaseFence(lease), now: this.nowIso(),
        })
      } catch (error) {
        // Nothing was written, so the evidence batch is still absent and the
        // work row is still recoverable. A later attempt retries the retrieval
        // rather than resuming from a half-written checkpoint.
        return this.failAfterExecution(
          store, lease, stage, failureCategory(error, stage), errorMessage(error), false, timing,
        )
      }
      if (!checkpoint.committed) return leaseLost(stage, lease.work)
      // A held checkpoint is not a retrieval failure to be papered over: the
      // required source is missing, so the existing bounded retry policy routes
      // it and the recorded limitations stay with the work item.
      const hold = retrievalManifestHoldFailure(manifest)
      if (hold !== null) {
        return await this.failAfterExecution(store, lease, stage, hold.category, manifest.reason, hold.retryable, timing)
      }
      this.recordExecution(lease, stage, timing, {
        status: 'succeeded', attempt: lease.work.attemptCount + 1,
      })
      return await this.advanceRetrievedWork(store, lease, signal!, [...reusedEvidence, ...evidence])
    } catch (error) {
      return this.failAfterExecution(
        store, lease, stage, failureCategory(error, stage), errorMessage(error), retryable(error), timing,
      )
    } finally {
      heartbeat.stop()
    }
  }

  /**
   * Re-entry against a saved checkpoint.
   *
   * The manifest is validated against the persisted evidence before it is
   * trusted, and the evidence it names must still pass the ordinary reuse
   * policy. A checkpoint that cannot be validated, or that holds, returns null
   * so the retrieval simply runs again under a new attempt; it is never
   * synthesized from whatever happens to be in the evidence cache.
   */
  private async reuseSavedCheckpoint(
    store: SharedResearchWorkPort,
    lease: WorkLease,
    signal: Signal,
    saved: RetrievalManifestV1 | null,
    timing: StageTiming,
  ): Promise<SharedResearchRunOutcome | null> {
    if (saved === null || !retrievalManifestMayProceed(saved)) return null
    const persisted = store.listEvidenceByWork(lease.work.workId, this.evidenceReadLimit)
    const issue = validateRetrievalManifestLinkage({ manifest: saved, work: lease.work, persistedEvidence: persisted })
    if (issue !== null) return null
    const byId = new Map(persisted.map((artifact) => [artifact.evidenceId, artifact]))
    const evidence: RetrievedEvidence[] = []
    for (const evidenceId of saved.evidenceIds) {
      const artifact = byId.get(evidenceId)
      if (!artifact) return null
      if (!this.evidenceReusePolicy.evaluate({
        artifact, workItem: lease.work, signal, now: this.nowIso(),
      }).reusable || !this.resolvesProducerCapture(artifact)) return null
      evidence.push(artifact)
    }
    if (evidence.length === 0) return null
    this.recordManifestReplay(lease, saved, evidence)
    try {
      return await this.advanceRetrievedWork(store, lease, signal, evidence)
    } catch (error) {
      return this.failWithoutExecution(
        store, lease, 'retrieval', failureCategory(error, 'retrieval'), errorMessage(error), timing,
      )
    }
  }

  /**
   * A held checkpoint may contain successful optional captures alongside the
   * required source that failed. On bounded retry, reuse eligible saved
   * captures and fetch only unresolved sources from that exact saved coverage;
   * do not repeat discovery or successful retrievals.
   */
  private prepareHeldCheckpointRetry(
    store: SharedResearchWorkPort,
    lease: WorkLease,
    signal: Signal,
    basePlan: DeterministicRetrievalPlan,
    manifest: RetrievalManifestV1,
  ): {
    plan: DeterministicRetrievalPlan
    manifest: RetrievalManifestV1
    reusedEvidence: RetrievedEvidence[]
    preservedSkippedSources: (RetrievalPlannedSource & { skipReason: RetrievalSkipReason })[]
  } | null {
    const persisted = store.listEvidenceByWork(lease.work.workId, this.evidenceReadLimit)
    if (validateRetrievalManifestLinkage({ manifest, work: lease.work, persistedEvidence: persisted }) !== null) {
      return null
    }
    const byId = new Map(persisted.map((artifact) => [artifact.evidenceId, artifact]))
    const reusedEvidence: RetrievedEvidence[] = []
    const retrySources: RetrievalPlannedSource[] = []
    const preservedSkippedSources: (RetrievalPlannedSource & { skipReason: RetrievalSkipReason })[] = []
    for (const source of manifest.sources) {
      if (source.outcome === 'succeeded') {
        const artifact = byId.get(source.evidenceId!)
        if (!artifact) return null
        if (this.evidenceReusePolicy.evaluate({
          artifact, workItem: lease.work, signal, now: this.nowIso(),
        }).reusable) {
          reusedEvidence.push(artifact)
        } else {
          retrySources.push({ url: source.url, authority: source.authority, authorityId: source.authorityId })
        }
      } else if (source.outcome === 'skipped' && source.skipReason === 'source_limit') {
        // A configured source cap is policy, not an interrupted fetch. Keep it
        // visible and do not bypass it during retry.
        preservedSkippedSources.push({
          url: source.url, authority: source.authority, authorityId: source.authorityId,
          skipReason: 'source_limit',
        })
      } else {
        retrySources.push({ url: source.url, authority: source.authority, authorityId: source.authorityId })
      }
    }
    if (retrySources.length === 0) return null
    return {
      plan: { ...basePlan, urls: retrySources },
      manifest,
      reusedEvidence,
      preservedSkippedSources,
    }
  }

  private async advanceRetrievedWork(
    store: SharedResearchWorkPort,
    lease: WorkLease,
    signal: Signal,
    evidence: readonly RetrievedEvidence[],
  ): Promise<SharedResearchRunOutcome> {
    const capturedSourceWorkflow = this.usesCapturedSourceWorkflow(lease.work)
    if (lease.work.researchDepth === 'deep' && !capturedSourceWorkflow) {
      if (this.deepResearch === undefined) {
        throw new ResearchStageFailure('provider_unavailable', true, 'Deep research side-queue port is not configured')
      }
      await this.deepResearch.enqueue({ workItem: lease.work, signal, evidence })
    }
    const transitioned = await store.transitionLeased({
      ...leaseFence(lease), expectedStatus: 'retrieval_leased',
      nextStatus: lease.work.researchDepth === 'deep' && !capturedSourceWorkflow ? 'deep_pending' : 'synthesis_pending',
      now: this.nowIso(), attemptDelta: 0, failureCategory: null, failureDetail: null, nextAttemptAt: null,
    })
    if (!transitioned) return leaseLost('retrieval', lease.work)
    return lease.work.researchDepth === 'deep' && !capturedSourceWorkflow
      ? { kind: 'deep_routed', sourceType: lease.work.sourceType, workId: lease.work.workId }
      : success('retrieval', lease.work)
  }

  private async processSynthesis(store: SharedResearchWorkPort, lease: WorkLease): Promise<SharedResearchRunOutcome> {
    const stage = 'synthesis' as const
    const timing = stageTiming(lease, this.nowIso())
    if (lease.work.researchDepth === 'deep' && !this.usesCapturedSourceWorkflow(lease.work)) {
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
      // A saved decision is authoritative and is reused as-is. Re-entry must not
      // repeat synthesis or re-judge sufficiency.
      const savedReadiness = store.getResearchReadinessByWork(lease.work.workId)
      if (savedReadiness !== null) {
        const replayed = await this.completeSavedHandoff(store, lease, savedReadiness)
        this.recordPacketReplay(lease, existing, savedReadiness)
        return replayed
      }
      try {
        const handoff = await this.commitResearchHandoff(store, lease, signal, existing)
        this.recordPacketReplay(lease, existing, handoff.readiness)
        return handoff.run
      } catch (error) {
        return this.failWithoutExecution(store, lease, stage,
          error instanceof ArticleResearchHold ? articleHoldFailureCategory(error) : error instanceof ResearchFollowupHold ? 'budget_exceeded' : failureCategory(error, stage), errorMessage(error), timing)
      }
    }
    const evidence = store.listEvidenceByWork(lease.work.workId, this.evidenceReadLimit).filter((artifact) =>
      this.evidenceReusePolicy.evaluate({
        artifact, workItem: lease.work, signal, now: this.nowIso(),
      }).reusable && this.resolvesProducerCapture(artifact))
    if (evidence.length === 0) {
      return this.failWithoutExecution(
        store, lease, stage, 'permanent_source_error',
        'Synthesis requires at least one freshness-approved immutable evidence artifact', timing,
      )
    }
    const preflight = await this.preflight(stage, store, lease, timing)
    if (preflight !== null) return preflight
    const heartbeat = this.startHeartbeat(store, lease)
    try {
      if (!await heartbeat.check()) return leaseLost(stage, lease.work)
      let articleContext: PreparedArticleContext | undefined
      if (this.usesCapturedSourceWorkflow(lease.work)) {
        try {
          articleContext = await this.prepareArticleContext(signal!, lease, evidence)
        } catch (error) {
          if (error instanceof ArticleResearchHold && error.code === 'context_coverage_transient') {
            return this.failWithoutExecution(store, lease, stage, articleHoldFailureCategory(error), errorMessage(error), timing, true)
          }
          // Permanent article holds retain the existing post-attempt behavior;
          // only a dependency outage is allowed to leave the attempt untouched.
        }
      }
      // The context read can outlive freshness, ownership, or the worker
      // itself. Re-fence all of those conditions immediately before spending
      // an attempt or creating any paid reservation.
      if (!await heartbeat.check()) return leaseLost(stage, lease.work)
      if (this.stopping) {
        const released = await store.releaseLease({
          ...leaseFence(lease), expectedStatus: 'synthesis_leased', targetStatus: 'synthesis_pending', now: this.nowIso(),
        })
        return released ? { kind: 'ownership_held', stage, sourceType: lease.work.sourceType, workId: lease.work.workId } : leaseLost(stage, lease.work)
      }
      const postContextPreflight = await this.preflight(stage, store, lease, timing)
      if (postContextPreflight !== null) return postContextPreflight
      if (this.stopping) {
        const released = await store.releaseLease({
          ...leaseFence(lease), expectedStatus: 'synthesis_leased', targetStatus: 'synthesis_pending', now: this.nowIso(),
        })
        return released ? { kind: 'ownership_held', stage, sourceType: lease.work.sourceType, workId: lease.work.workId } : leaseLost(stage, lease.work)
      }
      if (!await this.beginAttempt(store, lease, 'synthesis_leased')) return leaseLost(stage, lease.work)
      this.recordExecutionStarted(lease, stage, timing, lease.work.attemptCount + 1)
      const citableEvidenceIds = new Set(evidence.map((artifact) => artifact.evidenceId))
      const backgroundContext = this.discoverBackgroundContext(store, lease, citableEvidenceIds)
      this.recordBackgroundReuse(lease, backgroundContext)
      const packet = await this.synthesizeWithV4({ store, lease, signal, evidence, backgroundContext, articleContext,
        stillOwnsLease: async () => await heartbeat.check() && this.mayExecuteWork(lease.work) })
      if (!await heartbeat.check()) return leaseLost(stage, lease.work)
      this.recordSynthesisSuccess(lease, packet, timing)
      const handoff = await this.commitResearchHandoff(store, lease, signal, packet)
      return handoff.run
    } catch (error) {
      return this.failAfterExecution(
        store, lease, stage, error instanceof ArticleResearchHold ? articleHoldFailureCategory(error) : error instanceof ResearchFollowupHold ? 'budget_exceeded' : failureCategory(error, stage),
        errorMessage(error), error instanceof ArticleResearchHold ? articleHoldMayRetry(error) : error instanceof ResearchFollowupHold ? false : retryable(error), timing,
        error instanceof InferenceGatewayError && error.telemetry
          ? telemetryExecutionProvenance(error.telemetry)
          : undefined,
      )
    } finally {
      heartbeat.stop()
    }
  }

  private async synthesizeWithV4(input: {
    store: SharedResearchWorkPort, lease: WorkLease, signal: Signal,
    evidence: RetrievedEvidence[], backgroundContext: RetrievedEvidenceArtifact[],
    articleContext?: PreparedArticleContext,
    stillOwnsLease(): Promise<boolean>,
  }): Promise<ResearchPacket> {
    const { store, lease, signal, evidence } = input
    const ordinary = async () => {
      if (signal.contentKind === 'article' || this.v4?.article) {
        throw new ArticleResearchHold('required_jev_disabled', 'Article synthesis requires the active durable Jev article workflow.')
      }
      return this.synthesizer.synthesize({
        signal, workItem: lease.work, evidence: evidence.map(toDeterministicEvidence),
        ...(input.backgroundContext.length ? { backgroundContext: input.backgroundContext } : {}),
      })
    }
    const v4 = this.v4
    if (!v4 || (v4.sources && !v4.sources.has(lease.work.sourceType)) || !supportsResearchV4Store(store)) return ordinary()
    // Article packets have a different, Jev-prepared handoff contract. They
    // do not use generic legacy novelty/result reuse, while Hermes remains
    // protected by the same durable root-assignment reservation.
    if (v4.article) return this.synthesizeArticleWithV4(input, v4)
    const gateInput = researchGateSignal(signal, evidence)
    let novelty = store.getResearchV4Record<GateDecision>('novelty', lease.work.workId, 'decision')
    if (!novelty && !v4.novelty && v4.contextReader) {
      const reader = v4.contextReader(signal, lease.work)
      try {
        const entityIds = await reader.entityIdsForSourceRef(gateInput.source, gateInput.sourceRefId)
        const [entities, recentMemories, contextEvidence] = await Promise.all([
          reader.entitiesByIds(entityIds), reader.recentMemories(entityIds, 12),
          reader.noveltyEvidence?.(gateInput.source, gateInput.sourceRefId),
        ])
        const failures = contextEvidence?.failures ?? ['Reader did not supply evidence/coverage bookkeeping.']
        novelty = {
          verdict: failures.length ? 'gate_unavailable' : 'new_information', proceed: true,
          reason: 'Bounded relevant knowledge consulted without a paid novelty decision or automatic suppression.',
          entityIds, memoriesConsulted: recentMemories.length, entityContext: { entities, recentMemories },
          noveltyContext: { resolvedCandidateRefs: entityIds, itemRefs: contextEvidence?.itemRefs ?? [],
            timeCoverage: contextEvidence?.timeCoverage ?? { oldestEventAt: null, newestEventAt: null },
            truncated: contextEvidence?.truncated === true || recentMemories.length >= 12,
            unrelated: contextEvidence?.unrelated === true, evidenceRan: contextEvidence !== undefined,
            lookupFailures: failures, digest: contextEvidence?.digest ?? sourceMaterialHash(signal) },
        }
      } catch (error) {
        novelty = { verdict: 'gate_unavailable', proceed: true, reason: `Relevant knowledge unavailable: ${String(error).slice(0, 300)}`,
          entityIds: [], memoriesConsulted: 0, entityContext: null }
      }
      novelty = store.putResearchV4Record('novelty', lease.work.workId, 'decision', novelty)
    }
    if (!novelty && v4.novelty) {
      const classification = v4.novelty.classification
        ? durableResearchClassification({ gateway: v4.novelty.classification, store, work: lease.work,
          assignmentPolicy: v4.assignmentPolicy, stillOwnsLease: input.stillOwnsLease, now: () => this.nowIso() })
        : undefined
      novelty = await gateSignal(gateInput, {
        ...v4.novelty, reader: v4.novelty.reader(signal, lease.work), classification,
      })
      novelty = store.putResearchV4Record('novelty', lease.work.workId, 'decision', {
        ...novelty, sourceMaterialDigest: sourceMaterialHash(signal), policyVersion: v4.policyVersion,
        capturedEvidenceDigest: capturedObservationDigest(evidence),
      })
    }
    // Novelty or title similarity alone never suppresses unseen source material
    // or manufactures a no-item/attachment target. Exact compatible results can
    // avoid synthesis; otherwise preserve the source through ordinary Research.
    let packet = store.getResearchV4Record<ResearchPacket>('baseline', lease.work.workId, 'packet')
    if (packet?.knownObservationResolution) return packet
    if (!packet && novelty && v4.novelty) {
      packet = await resolveKnownObservation({ store, work: lease.work, signal, evidence, gateSignal: gateInput,
        decision: novelty, reader: v4.novelty.reader(signal, lease.work), policyVersion: v4.policyVersion,
        stillOwnsLease: input.stillOwnsLease, now: () => this.nowIso() })
      if (packet) return store.putResearchV4Record('baseline', lease.work.workId, 'packet', packet)
    }
    const knowledgeDigest = novelty && novelty.verdict !== 'gate_unavailable'
      && !novelty.noveltyContext?.truncated && !novelty.noveltyContext?.lookupFailures.length
      ? novelty.noveltyContext?.digest ?? createHash('sha256').update(canonicalJson({ verdict: novelty.verdict,
        entityIds: novelty.entityIds, context: novelty.entityContext })).digest('hex') : null
    const assignmentContract = structuredAssignmentReuseContract({ work: lease.work, signal, evidence,
      promptVersion: this.synthesizer.contractPromptVersion(), knowledgeDigest })
    if (!packet && v4.reusePolicy) {
      packet = reuseCompatibleResearchResult({
        owners: [...this.stores.values()].filter((owner): owner is ArtifactReuseStore & ResearchV4StorePort =>
          supportsResearchV4Store(owner) && supportsArtifactReuse(owner)),
        consumer: store, signal, work: lease.work, evidence,
        policy: v4.reusePolicy, now: this.nowIso(),
        currentKnowledgeDigest: knowledgeDigest,
        assignmentContract,
      })
    }
    if (!packet?.execution.reusedResult) {
      packet = await durablePrimarySynthesis({
        store, work: lease.work, policy: v4.synthesisPolicy, saved: packet,
        assignmentPolicy: v4.assignmentPolicy,
        requestMaterial: { signal, evidence, backgroundContext: input.backgroundContext },
        stillOwnsLease: input.stillOwnsLease, now: () => this.nowIso(),
        generate: (work) => this.synthesizer.synthesize({
          signal, workItem: work, evidence: evidence.map(toDeterministicEvidence), holdOnUnknownOutcome: true,
          ...(input.backgroundContext.length ? { backgroundContext: input.backgroundContext } : {}),
        }),
        transform: (generated) => {
        if (isArticleResearchPacket(generated)) throw new Error('Legacy synthesis cannot transform an article packet')
        return {
        ...generated, reuseSnapshot: {
          policyVersion: v4.reusePolicy?.policyVersion ?? null,
          knowledgeDigest,
          assignmentContract,
          limitations: novelty?.verdict === 'gate_unavailable' ? ['Relevant knowledge lookup was unavailable.'] : [],
        },
        novelty: novelty ?? null,
        }
        },
      })
    }
    const savedBaseline = store.getResearchV4Record<ResearchPacket>('baseline', lease.work.workId, 'packet')
    if (!savedBaseline && packet.execution.reusedResult && v4.contextReader) {
      const reused = packet.execution.reusedResult as { packetId?: string }
      const reader = v4.contextReader(signal, lease.work)
      const target = reused.packetId && await reader.attachmentTargetForPacket?.(reused.packetId)
      if (target) packet = { ...packet,
        requiredEntityAction: { kind: 'evidence_attachment', targetId: target.targetId,
          producerPacketId: target.producerPacketId, proofKind: 'managed_packet_ref_exact' },
        managedAttachmentTargetRevision: target.revision,
      }
    }
    packet = store.putResearchV4Record('baseline', lease.work.workId, 'packet', packet)
    if (!v4.followup || packet.execution.reusedResult) return packet
    if (isArticleResearchPacket(packet)) {
      throw new ArticleResearchHold('incompatible_article_checkpoint',
        'An article packet reached the legacy bounded-followup path; the checkpoint is held rather than reinterpreted as claim/evidence research.')
    }
    return runBoundedFollowup({
      store, signal, work: lease.work, baseline: packet, gateSignal: gateInput,
      entityContext: novelty?.entityContext ?? null,
      classification: durableResearchClassification({ gateway: v4.followup.classification, store,
        work: lease.work, assignmentPolicy: v4.assignmentPolicy, stillOwnsLease: input.stillOwnsLease, now: () => this.nowIso() }),
      policy: v4.followup.policy, retriever: this.retriever, synthesizer: this.synthesizer,
      assignmentPolicy: v4.assignmentPolicy,
      stillOwnsLease: input.stillOwnsLease, now: () => this.nowIso(),
    })
  }

  private usesCapturedSourceWorkflow(work: ResearchWorkItem): boolean {
    return this.v4?.article !== undefined
      && (!this.v4.sources || this.v4.sources.has(work.sourceType))
  }

  /**
   * Article catalogue reads are dependency checks, not paid synthesis work.
   * Resolve them before beginAttempt so a managed/legacy outage can wait
   * without consuming the bounded execution-attempt budget.
   */
  private async prepareArticleContext(
    signal: Signal,
    lease: WorkLease,
    evidence: readonly RetrievedEvidence[],
  ): Promise<PreparedArticleContext | undefined> {
    const source = latestArticleCapture(evidence)
    if (!source) return undefined
    const reader = this.v4?.article?.contextReader(signal, lease.work) as ArticleContextReader | undefined
    if (!reader?.articleContext) return undefined
    try {
      const context = await reader.articleContext({ sourceUrl: source.finalUrl, terms: articleLookupTerms(signal) })
      if (context.coverageFailures.length > 0 && context.coverageFailureKind === 'transient') {
        throw new ArticleResearchHold(
          'context_coverage_transient',
          `Article placement is held while catalogue/history storage recovers: ${context.coverageFailures.join('; ')}`,
        )
      }
      return { source, reader, context }
    } catch (error) {
      if (error instanceof ArticleResearchHold) throw error
      if (isTransientContextFailure(error)) {
        throw new ArticleResearchHold('context_coverage_transient', 'Article placement is held while catalogue/history storage recovers.')
      }
      // Keep a permanent reader failure as a held context so the synthesis
      // path does not repeat the same unavailable lookup after beginAttempt.
      return {
        source,
        reader,
        context: {
          candidates: [], historyByEntity: new Map(),
          coverageFailures: [`Article context lookup failed: ${errorMessage(error)}`],
          coverageFailureKind: 'permanent',
        },
      }
    }
  }

  /**
   * Article prose uses the ordinary primary-synthesis reservation and result
   * reconciliation, but its request is prepared by Jev first. This prevents a
   * legacy novelty/reuse path from replacing placement or story decisions.
   */
  private async synthesizeArticleWithV4(input: {
    store: SharedResearchWorkPort, lease: WorkLease, signal: Signal,
    evidence: RetrievedEvidence[], backgroundContext: RetrievedEvidenceArtifact[],
    articleContext?: PreparedArticleContext,
    stillOwnsLease(): Promise<boolean>,
  }, v4: SharedResearchV4Options): Promise<ResearchPacket> {
    if (!supportsResearchV4Store(input.store)) throw new Error('Article synthesis requires a durable V4 store')
    const articleStore = input.store
    if (!v4.article) throw new ArticleResearchHold('required_jev_disabled', 'Article synthesis is held because the required Jev article workflow is not configured.')
    const source = input.articleContext?.source ?? latestArticleCapture(input.evidence)
    const reader = input.articleContext?.reader
      ?? v4.article.contextReader(input.signal, input.lease.work) as ArticleContextReader
    if (!source || !reader.articleContext) throw new ArticleResearchHold('source_capture_missing', 'Article workflow requires immutable source capture and managed catalogue context.')
    const durableClassification = durableResearchClassification({
      gateway: v4.article.classification, store: articleStore,
      work: input.lease.work, assignmentPolicy: v4.assignmentPolicy,
      stillOwnsLease: input.stillOwnsLease, now: () => this.nowIso(),
    })
    let preparation: { memberships: import('../signal-platform/contracts').ArticleEntityProposal[], novelty: import('../signal-platform/contracts').ArticleChoiceDecision, contextualHistory: string }
    try {
      preparation = await prepareArticlePlacement({
        gateway: durableClassification, stableDecisionKey: input.lease.work.workId,
        signal: input.signal, sourceText: source.text,
        context: input.articleContext?.context
          ?? await reader.articleContext({ sourceUrl: source.finalUrl, terms: articleLookupTerms(input.signal) }),
        proposeCreation: async () => (await durableArticleEntityProposal({
          store: articleStore, work: input.lease.work,
          assignmentPolicy: v4.assignmentPolicy,
          requestMaterial: { sourceUrl: source.finalUrl, contentHash: source.contentHash, signal: input.signal },
          stillOwnsLease: input.stillOwnsLease, now: () => this.nowIso(),
          generate: (budget) => this.synthesizer.proposeArticleEntity({
            signal: input.signal,
            workItem: { ...input.lease.work, budget: { ...input.lease.work.budget,
              maxInputTokens: budget.maxInputTokens, maxOutputTokens: budget.maxOutputTokens } },
            sourceText: source.text, sourceUrl: source.finalUrl,
          }),
        })).proposal,
      })
    } catch (error) {
      if (error instanceof InferenceGatewayError && /requires an explicitly active Jev lifecycle/.test(error.message)) {
        throw new ArticleResearchHold('required_jev_disabled', 'Article placement is held because its required Jev lifecycle is disabled.')
      }
      throw error
    }
    const saved = (articleStore).getResearchV4Record<ResearchPacket>('baseline', input.lease.work.workId, 'packet')
    if (saved && !isArticleResearchPacket(saved)) throw new Error('Article work has an incompatible legacy synthesis checkpoint')
    return durablePrimarySynthesis({
      store: articleStore, work: input.lease.work, policy: v4.synthesisPolicy,
      assignmentPolicy: v4.assignmentPolicy,
      requestMaterial: { article: { signal: input.signal, source: { finalUrl: source.finalUrl, contentHash: source.contentHash } }, preparation, backgroundContext: input.backgroundContext },
      saved, stillOwnsLease: input.stillOwnsLease, now: () => this.nowIso(),
      generate: async (work) => {
        const generated = await this.synthesizer.synthesize({
          signal: input.signal, workItem: work, evidence: input.evidence.map(toDeterministicEvidence),
          articlePreparation: preparation, holdOnUnknownOutcome: true,
          ...(input.backgroundContext.length ? { backgroundContext: input.backgroundContext } : {}),
        })
        if (!isArticleResearchPacket(generated)) throw new Error('Article synthesis returned a legacy claim/evidence packet')
        return generated
      },
      transform: (packet) => packet,
    })
  }

  /**
   * Cross-work background context (PRD §5.2): newest evidence from OTHER
   * sources' stores, each recorded through one idempotent artifact link, kept
   * only when eligibility says background_only and the owner still resolves the
   * pinned bytes. This is orientation context, never citable evidence, and
   * every candidate failure is absorbed so reuse can never block synthesis.
   */
  private discoverBackgroundContext(
    consumer: SharedResearchWorkPort,
    lease: WorkLease,
    citableEvidenceIds: ReadonlySet<string>,
  ): RetrievedEvidenceArtifact[] {
    const background: RetrievedEvidenceArtifact[] = []
    if (!supportsArtifactReuse(consumer)) return background
    const now = this.nowIso()
    for (const [sourceType, owner] of this.stores) {
      if (background.length >= BACKGROUND_CONTEXT_LIMIT) break
      if (sourceType === lease.work.sourceType) continue
      if (!supportsArtifactReuse(owner)) continue
      if (owner.artifactStoreId() === consumer.artifactStoreId()) continue
      for (const candidate of owner.listRecentEvidence(BACKGROUND_CONTEXT_LIMIT)) {
        if (background.length >= BACKGROUND_CONTEXT_LIMIT) break
        if (citableEvidenceIds.has(candidate.evidenceId)) continue
        try {
          const usage = linkArtifact({
            owner,
            consumer,
            artifactId: candidate.evidenceId,
            consumerWorkId: lease.work.workId,
            now,
          })
          if (usage.decision !== 'background_only') continue
          const resolved = resolveArtifactUsage(owner, usage)
          if (!resolved || citableEvidenceIds.has(resolved.evidenceId)) continue
          if (background.some((artifact) => artifact.evidenceId === resolved.evidenceId)) continue
          background.push(toDeterministicEvidence(resolved))
        } catch {
          // Rejected or conflicting candidates are absorbed: background reuse
          // is best-effort orientation context, never a gate on synthesis.
        }
      }
    }
    return background
  }

  private resolvesProducerCapture(evidence: RetrievedEvidence): boolean {
    const approval = evidence.reuseApproval as { ref?: ArtifactRef, pinId?: string } | undefined
    if (!approval) return true
    if (!approval.ref || !approval.pinId) return false
    for (const owner of this.stores.values()) {
      if (!supportsArtifactReuse(owner) || owner.sourceType !== approval.ref.ownerSourceType
        || owner.artifactStoreId() !== approval.ref.ownerStoreId) continue
      const pin = owner.getArtifactPin(approval.pinId)
      const capture = pin && owner.resolvePinnedArtifact(pin)
      return capture !== null && capture !== undefined && capture.contentHash === evidence.contentHash
        && capture.requestedUrl === evidence.requestedUrl && capture.finalUrl === evidence.finalUrl
        && capture.text === evidence.text
    }
    return false
  }

  /**
   * Research owns the sufficiency decision. The packet, that decision, and the
   * work status it requires are committed in one store transaction, so a saved
   * decision can never exist without the work state that admits it and a
   * synthesis result can never be promoted without a decision.
   *
   * A `blocked` or `failed` decision is not successful completion: it carries
   * the existing bounded retry policy into the same transaction, so the retry
   * deadline is persisted together with the decision rather than being left
   * disconnected from it.
   */
  private async commitResearchHandoff(
    store: SharedResearchWorkPort,
    lease: WorkLease,
    signal: Signal,
    packet: ResearchPacket,
  ): Promise<{ readiness: ResearchReadiness, run: SharedResearchRunOutcome }> {
    const assessment = {
      work: lease.work,
      signal,
      packet,
      persistedEvidence: store.listEvidenceByWork(lease.work.workId, this.evidenceReadLimit),
      assessedAt: this.nowIso(),
    }
    const required = packet.requiredEntityAction as { kind?: string, targetId?: string, proofKind?: string } | undefined
    const knownObservation = !isArticleResearchPacket(packet) && supportsResearchV4Store(store) && assertKnownObservationResolution({
      store, work: lease.work, packet, signal, evidence: assessment.persistedEvidence,
    })
    if (knownObservation) {
      const novelty = supportsResearchV4Store(store) && store.getResearchV4Record<GateDecision>('novelty', lease.work.workId, 'decision')
      const readerFactory = this.v4?.novelty?.reader
      if (!supportsResearchV4Store(store) || !novelty || !readerFactory || !await resolveKnownObservation({
        store, work: lease.work, signal, evidence: assessment.persistedEvidence,
        gateSignal: researchGateSignal(signal, assessment.persistedEvidence), decision: novelty,
        reader: readerFactory(signal, lease.work), policyVersion: this.v4!.policyVersion,
        stillOwnsLease: async () => {
          const current = store.getResearchWork(lease.work.workId)
          return current?.leaseId === lease.leaseId && current.leaseOwner === lease.leaseOwner
            && Date.parse(current.leaseExpiresAt ?? '') > this.clock.now().getTime() && this.mayExecuteWork(lease.work)
        }, now: () => this.nowIso(),
      })) throw new ResearchFollowupHold('Saved known observation comparison changed or became unavailable; retained observation requires review before no-item handoff.')
    }
    const readiness = knownObservation ? createResolvedWithoutNewItemReadiness({ ...assessment,
      reason: 'Complete captured observation is represented in bounded current knowledge; source evidence is retained and no new item action is owed.',
    }) : required?.kind === 'evidence_attachment' && required.proofKind === 'managed_packet_ref_exact'
      && required.targetId
      ? createResolvedWithoutNewItemReadiness({ ...assessment,
        owedAttachment: { targetId: required.targetId },
        reason: 'Compatible saved Research resolves this assignment without a new note; current source evidence is owed to the exact accepted producer-packet target.',
      }) : assessResearchReadiness(assessment)
    let committed
    try {
      committed = store.commitResearchHandoff({
        packet,
        readiness,
        fence: leaseFence(lease),
        now: this.nowIso(),
        retry: this.handoffRetryPolicy(lease),
      })
    } catch {
      // The decision is only durable together with the work status. A failure
      // here leaves the synthesis lease recoverable, so a later attempt reuses
      // the immutable packet instead of repeating synthesis.
      return { readiness, run: handoffPending('synthesis', lease.work) }
    }
    return {
      readiness,
      run: committed.committed
        ? handoffRun(lease.work, readiness, committed.workStatus)
        : handoffPending('synthesis', lease.work),
    }
  }

  /**
   * The existing bounded retry policy, offered to the atomic handoff so it can
   * persist the transition and its deadline in the same transaction. This adds
   * no automatic deferred wakeup: the deadline is the ordinary `retry_wait`
   * row the existing recovery sweep already advances.
   */
  private handoffRetryPolicy(lease: WorkLease): ResearchHandoffRetryPolicy {
    const now = this.clock.now()
    const attempts = lease.work.attemptCount
    const expired = Date.parse(lease.work.freshnessDeadline) <= now.getTime()
    const bounded = attempts < this.maxAttempts && !expired
    return {
      attemptCount: attempts,
      maxAttempts: this.maxAttempts,
      expired,
      nextAttemptAt: bounded
        ? new Date(now.getTime() + this.backoffMs(Math.max(1, attempts))).toISOString()
        : null,
    }
  }

  /**
   * Re-entry after a committed handoff. The saved decision is reused verbatim;
   * only the fenced work transition is replayed, never synthesis and never a
   * second sufficiency judgment.
   */
  private async completeSavedHandoff(
    store: SharedResearchWorkPort,
    lease: WorkLease,
    readiness: ResearchReadiness,
  ): Promise<SharedResearchRunOutcome> {
    const retry = this.handoffRetryPolicy(lease)
    const nextStatus = readinessHandoffStatus(readiness, lease.work, this.nowIso(), retry)
    const transitioned = await store.transitionLeased({
      ...leaseFence(lease), expectedStatus: 'synthesis_leased', nextStatus,
      now: this.nowIso(), attemptDelta: 0,
      failureCategory: readiness.failureCategory, failureDetail: readinessDetail(readiness),
      nextAttemptAt: nextStatus === 'retry_wait' ? retry.nextAttemptAt : null,
    })
    if (!transitioned) return leaseLost('synthesis', lease.work)
    return handoffRun(lease.work, readiness, nextStatus)
  }

  private async preflight(
    stage: ResearchWorkerStage | 'deep_research',
    store: SharedResearchWorkPort,
    lease: WorkLease,
    timing: StageTiming,
  ): Promise<SharedResearchRunOutcome | null> {
    if (!this.mayExecuteWork(lease.work)) {
      const workerStage = stage === 'deep_research' ? 'synthesis' : stage
      const released = await store.releaseLease({
        ...leaseFence(lease), expectedStatus: leasedStatus(workerStage), targetStatus: pendingStatus(workerStage), now: this.nowIso(),
      })
      return released ? { kind: 'ownership_held', stage: workerStage, sourceType: lease.work.sourceType, workId: lease.work.workId }
        : leaseLost(workerStage, lease.work)
    }
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
    mayRetry = false,
  ): Promise<SharedResearchRunOutcome> {
    return this.transitionFailure(store, lease, stage, category, detail, mayRetry, false, timing)
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
    // A storage outage is independent of the provider execution budget. Keep
    // the row retryable at the cap, while freshness still expires it normally.
    const kind = expired ? 'expired' : mayRetry && (category === 'storage_transient' || attempts < this.maxAttempts)
      ? 'retry_wait' : 'dead_letter'
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
        discriminator: input.discriminator ?? `attempt:${input.attempt}:terminal`,
      }),
      ...input.provenance,
    })
  }

  private recordExecutionStarted(lease: WorkLease, stage: ResearchWorkerStage, timing: StageTiming, attempt: number): void {
    this.appendExecutionEvent(baseExecutionEvent({
      lease, stage, timing, finishedAt: null, status: 'started', attempt,
      failureCategory: null, discriminator: `attempt:${attempt}:started`,
    }))
  }

  private recordSynthesisSuccess(lease: WorkLease, packet: ResearchPacket, timing: StageTiming): void {
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

  private recordPacketReplay(
    lease: WorkLease,
    packet: ResearchPacket,
    readiness: ResearchReadiness,
  ): void {
    const timing = { startedAt: packet.createdAt, queueWaitMs: 0 }
    this.appendExecutionEvent({
      ...baseExecutionEvent({
        lease, stage: 'synthesis', timing, finishedAt: packet.createdAt,
        status: 'skipped', attempt: packet.execution.attempt,
        failureCategory: readiness.failureCategory,
        discriminator: `packet_replay:${packet.packetId}`, packetId: packet.packetId,
      }),
      configuredPrimaryProvider: packet.execution.configuredPrimaryProvider ?? null,
      configuredPrimaryModel: packet.execution.configuredPrimaryModel ?? null,
      fallbackReason: packet.execution.fallbackReason ?? null,
      outputSchemaValid: packet.execution.outputSchemaValid ?? null,
      promptVersion: packet.execution.promptVersion,
      policyVersion: packet.execution.policyVersion,
      researchReadinessId: readiness.readinessId,
      researchReadinessOutcome: readiness.outcome,
      researchReadinessPolicyVersion: readiness.readinessPolicyVersion,
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

  private recordBackgroundReuse(lease: WorkLease, backgroundContext: readonly RetrievedEvidenceArtifact[]): void {
    if (backgroundContext.length === 0) return
    const anchor = this.nowIso()
    const evidenceIds = backgroundContext.map((artifact) => artifact.evidenceId)
    this.appendExecutionEvent(baseExecutionEvent({
      lease, stage: 'synthesis', timing: { startedAt: anchor, queueWaitMs: 0 }, finishedAt: anchor,
      status: 'skipped', attempt: lease.work.attemptCount, failureCategory: null,
      discriminator: `background_reuse:${stableContractId('background_set', ...[...evidenceIds].sort())}`,
    }))
  }

  /** Re-entry is reported against the checkpoint that was reused, not the cache. */
  private recordManifestReplay(
    lease: WorkLease,
    manifest: RetrievalManifestV1,
    evidence: readonly RetrievedEvidence[],
  ): void {
    const anchor = evidence[0]?.retrievedAt ?? manifest.recordedAt
    this.appendExecutionEvent(baseExecutionEvent({
      lease, stage: 'retrieval', timing: { startedAt: anchor, queueWaitMs: 0 }, finishedAt: anchor,
      status: 'skipped', attempt: lease.work.attemptCount, failureCategory: null,
      discriminator: `retrieval_manifest_replay:${manifest.manifestId}:${manifest.decision}`,
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

/**
 * Stable identity of the code-owned retrieval plan.
 *
 * The identity covers the work item's own plan, the effective limits, the
 * freshness deadline, and the contract/policy versions, so a changed plan is a
 * different checkpoint rather than a silently reused one. Search discovery is
 * deliberately excluded: discovered corroboration URLs belong to one execution
 * and are recorded inside the manifest as coverage.
 */
export function retrievalPlanIdentity(
  work: ResearchWorkItem,
  plan: DeterministicRetrievalPlan,
): { retrievalPlanId: string, retrievalPlanDigest: string } {
  const identity: RetrievalPlanIdentityInput = {
    workId: work.workId,
    researchContractVersion: work.researchContractVersion,
    policyVersion: work.policyVersion,
    sourceUrl: work.retrievalPlan.sourceUrl,
    allowedDomains: plan.allowedDomains,
    maxExternalSources: work.retrievalPlan.maxExternalSources,
    maxSources: plan.maxSources,
    maxBytesPerSource: plan.maxBytesPerSource,
    maxTotalBytes: plan.maxTotalBytes,
    maxTextCharsPerSource: plan.maxTextCharsPerSource,
    maxRedirects: plan.maxRedirects,
    timeoutMs: plan.timeoutMs,
    freshnessDeadline: plan.freshnessDeadline ?? work.freshnessDeadline,
  }
  return {
    retrievalPlanId: retrievalPlanId(identity),
    retrievalPlanDigest: retrievalPlanDigest(identity),
  }
}

/**
 * Builds the immutable checkpoint for one retrieval execution from the plan
 * that ran and the batch it produced.
 *
 * Every source the plan selected is accounted for: captured, failed, dropped by
 * the source cap, or left unevaluated when the executor stopped first. Only the
 * captures become evidence identities, and a source that was never evaluated is
 * never reported as checked.
 */
export function buildRetrievalManifest(input: {
  work: ResearchWorkItem
  plan: DeterministicRetrievalPlan
  batch: RetrievalBatch
  attempt: number
  recordedAt: string
  manifestPolicyVersion?: string
  previous?: {
    manifest: RetrievalManifestV1
    reusedEvidence: readonly RetrievedEvidence[]
    preservedSkippedSources: readonly (RetrievalPlannedSource & { skipReason: RetrievalSkipReason })[]
  }
}): RetrievalManifestV1 {
  const identity = retrievalPlanIdentity(input.work, input.plan)
  const coverage = describeRetrievalCoverage(input.plan, input.batch)
  if (input.previous !== undefined) {
    const reusedById = new Map(input.previous.reusedEvidence.map((artifact) => [artifact.evidenceId, artifact]))
    const reusedSources = input.previous.manifest.sources.filter(
      (source) => source.outcome === 'succeeded' && reusedById.has(source.evidenceId!),
    )
    coverage.plannedSources.unshift(...reusedSources.map(({ url, authority, authorityId }) => ({
      url, authority, authorityId,
    })))
    coverage.skippedSources.push(...input.previous.preservedSkippedSources)
    coverage.captures.unshift(...reusedSources.map((source) => {
      const artifact = reusedById.get(source.evidenceId!)!
      return {
        evidenceId: artifact.evidenceId,
        contentHash: artifact.contentHash,
        requestedUrl: artifact.requestedUrl,
        finalUrl: artifact.finalUrl,
        truncated: artifact.truncated,
        reused: true,
      }
    }))
  }
  return assessRetrievalManifest({
    work: input.work,
    planId: identity.retrievalPlanId,
    planDigest: identity.retrievalPlanDigest,
    planPolicyVersion: input.work.policyVersion,
    attempt: input.attempt,
    ...coverage,
    recordedAt: input.recordedAt,
    ...(input.manifestPolicyVersion === undefined
      ? {} : { manifestPolicyVersion: input.manifestPolicyVersion }),
  })
}

function describeRetrievalCoverage(
  plan: DeterministicRetrievalPlan,
  batch: RetrievalBatch,
): {
  plannedSources: RetrievalPlannedSource[]
  skippedSources: (RetrievalPlannedSource & { skipReason: RetrievalSkipReason })[]
  captures: RetrievalCapture[]
  failures: RetrievalSourceFailure[]
} {
  const selected = plan.urls.slice(0, plan.maxSources)
  const overLimit = plan.urls.slice(plan.maxSources)
  const evaluated = new Set([
    ...batch.artifacts.map((artifact) => normalizeUrl(artifact.requestedUrl)),
    ...batch.failures.map((failure) => normalizeUrl(failure.requestedUrl)),
  ])
  const plannedSources: RetrievalPlannedSource[] = []
  const stoppedEarly: (RetrievalPlannedSource & { skipReason: RetrievalSkipReason })[] = []
  for (const approved of selected) {
    const source: RetrievalPlannedSource = {
      url: normalizeUrl(approved.url), authority: approved.authority, authorityId: approved.authorityId,
    }
    // The executor breaks out on a byte budget, deadline, or earlier failure, so
    // a selected source can end up with neither a capture nor a failure. That is
    // explicitly unevaluated, not a silent omission.
    if (evaluated.has(source.url)) plannedSources.push(source)
    else stoppedEarly.push({ ...source, skipReason: 'execution_stopped' })
  }
  return {
    plannedSources,
    skippedSources: [
      ...overLimit.map((approved) => ({
        url: normalizeUrl(approved.url), authority: approved.authority, authorityId: approved.authorityId,
        skipReason: 'source_limit' as const,
      })),
      ...stoppedEarly,
    ],
    captures: batch.artifacts.map((artifact) => ({
      evidenceId: artifact.evidenceId,
      contentHash: artifact.contentHash,
      requestedUrl: normalizeUrl(artifact.requestedUrl),
      finalUrl: normalizeUrl(artifact.finalUrl),
      truncated: artifact.truncated,
    })),
    failures: batch.failures.map((failure) => ({
      requestedUrl: normalizeUrl(failure.requestedUrl),
      category: failure.category,
      retryable: failure.retryable,
    })),
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

export function researchGateSignal(signal: Signal, evidence: readonly RetrievedEvidence[]): GateSignal {
  const material = canonicalJson({ content: signal.content, evidence: evidence.map((artifact) => ({
    requestedUrl: artifact.requestedUrl, finalUrl: artifact.finalUrl, contentHash: artifact.contentHash,
    text: artifact.text, capturedAt: artifact.retrievedAt, truncated: artifact.truncated,
  })) })
  return {
    source: signal.sourceType, sourceRefId: signal.sourceId.slice(0, 300), title: signal.title.slice(0, 500),
    whatChanged: (signal.visibleSummary ?? signal.title).slice(0, 2_000), observedAt: signal.observedAt,
    sourceMaterial: material.slice(0, 12_000), sourceMaterialDigest: sourceMaterialHash(signal),
    sourceMaterialComplete: material.length <= 12_000 && evidence.length > 0 && evidence.every((artifact) => !artifact.truncated),
  }
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
  | 'costUsdMicros'
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
    costUsdMicros: telemetry.costUsdMicros,
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
  finishedAt: string | null
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
    wallTimeMs: input.finishedAt === null ? 0 : elapsedMs(input.timing.startedAt, input.finishedAt),
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
    costUsdMicros: null,
    createdAt: input.finishedAt ?? input.timing.startedAt,
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

function articleHoldFailureCategory(error: ArticleResearchHold): FailureCategory {
  if (error.code === 'source_capture_missing' || error.code === 'source_input_too_large') return 'permanent_source_error'
  if (error.code === 'context_coverage_transient') return 'storage_transient'
  if (error.code === 'required_jev_disabled') return 'provider_unavailable'
  return 'entity_resolution_failed'
}

function articleHoldMayRetry(error: ArticleResearchHold): boolean {
  return error.code === 'context_coverage_transient'
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

/**
 * The work status a saved decision owes, resolved with the same policy the
 * atomic handoff used. Replaying a saved decision must not invent a different
 * terminal status than the one originally committed.
 */
function readinessHandoffStatus(
  readiness: ResearchReadiness,
  work: ResearchWorkItem,
  now: string,
  retry: ResearchHandoffRetryPolicy,
): ResearchWorkItem['status'] {
  if (researchHandoffEntityClaim(readiness) !== null) return 'entity_pending'
  if (readiness.outcome === 'resolved_without_new_item') return 'complete'
  return researchHandoffTerminalStatus(readiness, {
    attemptCount: retry.attemptCount,
    maxAttempts: retry.maxAttempts,
    expired: Date.parse(work.freshnessDeadline) <= Date.parse(now),
    nextAttemptAt: retry.nextAttemptAt,
  })
}

/** Only the typed readiness outcome reaches the work row, never prose. */
function readinessDetail(readiness: ResearchReadiness): string | null {
  return isNonClaimableReadiness(readiness.outcome) ? `readiness:${readiness.outcome}` : null
}

/**
 * Report the outcome a committed handoff produced.
 *
 * A claimable decision is successful completion, including a no-new-item result
 * that still owes an Entity attachment or reuse action. A deliberate no-action
 * result completes without one. Everything else is routed to the existing
 * bounded retry/dead-letter reporting rather than being reported as success.
 */
function handoffRun(
  work: ResearchWorkItem,
  readiness: ResearchReadiness,
  workStatus: ResearchWorkItem['status'] | null,
): SharedResearchRunOutcome {
  // `entity_pending` covers a ready result and a no-new-item result that still
  // owes an Entity attachment; `complete` is a deliberate no-action result.
  // Both are successful completion of the Research stage.
  if (workStatus === 'entity_pending' || workStatus === 'complete') return success('synthesis', work)
  return {
    kind: 'readiness_held',
    sourceType: work.sourceType,
    workId: work.workId,
    outcome: readiness.outcome,
    // A validation-backed non-claimable outcome always carries a category; the
    // fallback only guards an externally constructed record.
    category: readiness.failureCategory ?? 'storage_permanent',
  }
}

function terminal(
  kind: 'retry_wait' | 'dead_letter' | 'expired',
  stage: ResearchWorkerStage,
  work: ResearchWorkItem,
  category: FailureCategory,
): SharedResearchRunOutcome {
  return { kind, stage, sourceType: work.sourceType, workId: work.workId, category }
}

function normalizeUrl(value: string): string {
  try { return new URL(value).toString() } catch { return value }
}

/** Bounded lexical hints complement named entities without becoming a broad search. */


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
