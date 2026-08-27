import type {
  ResearchPacketV1,
  ResearchWorkItem,
  RetrievedEvidence,
  Signal,
} from './contracts'
import type { TriageDecisionV1 } from './triage-contracts'
import type { ResearchWorkStoreAdapter } from './store-adapter'

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

  constructor(readonly recordType: 'signal' | 'triage' | 'work' | 'evidence' | 'packet', readonly identity: string) {
    super(`${recordType} ${identity} already exists with a different canonical payload`)
    this.name = 'ImmutableRecordConflictError'
  }
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

  admitResearchWork(work: ResearchWorkItem): ImmutableAppendResult<ResearchWorkItem>
  getResearchWork(workId: string): ResearchWorkItem | null
  listResearchWorkBySignal(signalId: string, limit: number): ResearchWorkItem[]

  appendEvidence(evidence: RetrievedEvidence): ImmutableAppendResult<RetrievedEvidence>
  getEvidence(evidenceId: string): RetrievedEvidence | null
  listEvidenceByWork(workId: string, limit: number): RetrievedEvidence[]

  appendResearchPacket(packet: ResearchPacketV1): ImmutableAppendResult<ResearchPacketV1>
  getResearchPacket(packetId: string): ResearchPacketV1 | null
  listResearchPacketsByWork(workId: string, limit: number): ResearchPacketV1[]
  listResearchPacketsBySignal(signalId: string, limit: number): ResearchPacketV1[]
  listResearchPacketsByTrace(traceId: string, limit: number): ResearchPacketV1[]

  /** Atomic, idempotent packet handoff; false means another worker won or the work is not ready. */
  promoteResearchReady(workId: string, now: string): boolean
}
