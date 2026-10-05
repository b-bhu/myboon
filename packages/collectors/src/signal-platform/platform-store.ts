import type {
  ResearchPacket,
  ResearchWorkItem,
  RetrievedEvidence,
  Signal,
} from './contracts'
import type { TriageDecisionV1 } from './triage-contracts'
import type { ResearchWorkStoreAdapter } from './store-adapter'
import type { AdmissionDispositionV1 } from './intake-admission'
import type { RetrievalManifestV1 } from './retrieval-manifest'
import type { ResearchReadiness, ResearchHandoffRetryPolicy } from './research-readiness'

export interface ImmutableAppendResult<T> {
  inserted: boolean
  value: T
}

export interface SignalObservationRecord {
  observationId: string
  signalId: string
  sourceType: Signal['sourceType']
  observedAt: string
  deduplicated: boolean
}

export interface SignalObservationAppendResult {
  signal: ImmutableAppendResult<Signal>
  observation: ImmutableAppendResult<SignalObservationRecord>
}

export class ImmutableRecordConflictError extends Error {
  readonly code = 'IMMUTABLE_RECORD_CONFLICT'

  constructor(
    readonly recordType: 'signal' | 'triage' | 'work' | 'evidence' | 'packet' | 'admission' | 'readiness' | 'delivery' | 'manifest' | 'research_v4_record',
    readonly identity: string,
  ) {
    super(`${recordType} ${identity} already exists with a different canonical payload`)
    this.name = 'ImmutableRecordConflictError'
  }
}

/** One durable intake unit: decision, admission disposition, and frozen work. */
export interface IntakeUnit {
  decision: TriageDecisionV1
  disposition: AdmissionDispositionV1
  work: ResearchWorkItem | null
}

export interface IntakeUnitAppendResult {
  decision: ImmutableAppendResult<TriageDecisionV1>
  disposition: ImmutableAppendResult<AdmissionDispositionV1>
  work: ImmutableAppendResult<ResearchWorkItem> | null
}

export interface CanonicalPlatformStore extends ResearchWorkStoreAdapter {
  appendSignal(signal: Signal): ImmutableAppendResult<Signal>
  appendSignalObservation?(
    signal: Signal,
    observation: SignalObservationRecord,
  ): SignalObservationAppendResult
  /**
   * Durable source-delivery accounting. The identity must be stable for an
   * exact replay of the same source observation, while a later poll may use a
   * new identity even when it deduplicates to an existing canonical Signal.
   */
  recordSignalObservation?(observation: SignalObservationRecord): ImmutableAppendResult<SignalObservationRecord>
  getSignal(signalId: string): Signal | null
  findSignalByIdempotencyKey(idempotencyKey: string): Signal | null
  /** Bounded retry source for Signals retained before a failed triage step. */
  listSignalsMissingDecision(input: {
    priorityPolicyVersion?: string
    budgetPolicyVersion?: string
    limit: number
  }): Signal[]

  appendTriageDecision(decision: TriageDecisionV1): ImmutableAppendResult<TriageDecisionV1>
  getTriageDecision(decisionId: string): TriageDecisionV1 | null
  listTriageDecisionsBySignal(signalId: string, limit: number): TriageDecisionV1[]

  /**
   * Atomic, single-transaction intake unit. The accepted decision, the explicit
   * admission disposition with its provenance, and any required frozen work row
   * are persisted together or not at all.
   */
  appendIntakeUnit(unit: IntakeUnit): IntakeUnitAppendResult
  /**
   * Re-entry lookup keyed by the decision's uniqueness tuple. Returns the saved
   * decision plus its disposition and work without recomputing either; a missing
   * disposition or work is reported as `null` so legacy rows are never inferred.
   */
  findIntakeUnit(input: {
    signalId: string
    priorityPolicyVersion?: string
    budgetPolicyVersion?: string
  }): { decision: TriageDecisionV1; disposition: AdmissionDispositionV1 | null; work: ResearchWorkItem | null } | null
  /** Saved decision plus disposition for every active admission still owed work. */
  listOwedActiveAdmissions(input: { limit: number }): Array<{
    decision: TriageDecisionV1
    disposition: AdmissionDispositionV1
  }>
  /** Research-shaped decisions with no admission disposition and no work. */
  listAmbiguousAdmissionCandidates(input: { limit: number }): TriageDecisionV1[]

  admitResearchWork(work: ResearchWorkItem): ImmutableAppendResult<ResearchWorkItem>
  getResearchWork(workId: string): ResearchWorkItem | null
  listResearchWorkBySignal(signalId: string, limit: number): ResearchWorkItem[]

  appendEvidence(evidence: RetrievedEvidence): ImmutableAppendResult<RetrievedEvidence>
  getEvidence(evidenceId: string): RetrievedEvidence | null
  listEvidenceByWork(workId: string, limit: number): RetrievedEvidence[]

  /**
   * Single-transaction retrieval checkpoint: the immutable manifest and the
   * evidence batch it describes are committed together or not at all.
   *
   * A non-empty evidence cache is never a completion marker on its own. The
   * manifest is the record of what was and was not checked, so the two must not
   * be able to exist apart. Losing the lease fence writes nothing at all.
   */
  commitRetrievalCheckpoint(unit: RetrievalCheckpointUnit): RetrievalCheckpointCommitResult
  /** Newest checkpoint saved for this work under one exact plan identity. */
  getLatestRetrievalManifest(workId: string, retrievalPlanId: string): RetrievalManifestV1 | null
  /** Every checkpoint for a work item, oldest first. Never synthesised. */
  listRetrievalManifestsByWork(workId: string, limit: number): RetrievalManifestV1[]

  appendResearchPacket(packet: ResearchPacket): ImmutableAppendResult<ResearchPacket>
  getResearchPacket(packetId: string): ResearchPacket | null
  listResearchPacketsByWork(workId: string, limit: number): ResearchPacket[]
  listResearchPacketsBySignal(signalId: string, limit: number): ResearchPacket[]
  listResearchPacketsByTrace(traceId: string, limit: number): ResearchPacket[]

  /** Atomic, idempotent packet handoff; false means another worker won or the work is not ready. */
  promoteResearchReady(workId: string, now: string): boolean

  /**
   * Versioned Research-owned readiness decision, stored separately from the
   * immutable packet so a saved packet is never rewritten to change its verdict.
   *
   * Readiness has no standalone write: only the atomic handoff methods below may
   * persist one, so a decision can never exist without the work status that
   * admits it.
   */
  getResearchReadinessByWork(workId: string): ResearchReadiness | null
  getResearchReadinessByPacket(packetId: string): ResearchReadiness | null

  /**
   * Single-transaction Research handoff: the packet, the readiness decision,
   * and the work status each outcome requires are committed together or not at
   * all. A ready result, and a no-item result that still owes an Entity action,
   * leave exactly one claimable Entity action; a deliberate no-action result
   * performs no Entity mutation; a non-claimable result uses the existing
   * bounded retry/dead-letter handling rather than a hidden retry loop.
   */
  commitResearchHandoff(unit: ResearchHandoffUnit): ResearchHandoffCommitResult

  /**
   * Bounded bridge for packets saved before the readiness transition. It only
   * replays the fenced promotion for an already-saved `research_ready` result;
   * it never assesses, replays, or wakes the historical backlog.
   */
  promoteResearchReadyWithReadiness(input: {
    workId: string
    readiness: ResearchReadiness
    now: string
  }): ResearchHandoffCommitResult | null
}

/** Everything one Research handoff must persist together. */
export interface ResearchHandoffUnit {
  packet: ResearchPacket
  readiness: ResearchReadiness
  /** Fenced owner/lease of the synthesis stage committing the handoff. */
  fence: { workId: string, leaseOwner: string, leaseId: string }
  now: string
  /**
   * Existing bounded retry policy applied to a non-claimable outcome. The
   * deadline it produces is persisted in this same transaction, so a readiness
   * is never saved while the work status stays disconnected from it. Omit it and
   * a non-claimable result terminates as a held, non-claimable row.
   */
  retry?: ResearchHandoffRetryPolicy
}

export interface ResearchHandoffCommitResult {
  packet: ImmutableAppendResult<ResearchPacket>
  readiness: ImmutableAppendResult<ResearchReadiness>
  workStatus: ResearchWorkItem['status'] | null
  /** False when the fence lost; nothing was written in that case. */
  committed: boolean
  /** True when the saved decision was reused rather than newly assessed. */
  replayed: boolean
}

/** Everything one retrieval checkpoint must persist together. */
export interface RetrievalCheckpointUnit {
  manifest: RetrievalManifestV1
  /**
   * The exact evidence batch the manifest describes. Each artifact keeps its
   * originating `workId`; a consumer work identity is never written onto a
   * producer's artifact.
   */
  evidence: RetrievedEvidence[]
  /** Fenced owner/lease of the retrieval stage committing the checkpoint. */
  fence: { workId: string, leaseOwner: string, leaseId: string }
  now: string
}

export interface RetrievalCheckpointCommitResult {
  manifest: ImmutableAppendResult<RetrievalManifestV1>
  evidence: ImmutableAppendResult<RetrievedEvidence>[]
  workStatus: ResearchWorkItem['status'] | null
  /** False when the fence lost; nothing was written in that case. */
  committed: boolean
}
