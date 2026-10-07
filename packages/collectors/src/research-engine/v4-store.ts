import type { ResearchPacket } from '../signal-platform/contracts'
import type { BudgetStorePort, D2ReservationRecord } from './assignment-budget'

export type ResearchV4RecordKind =
  | 'novelty' | 'baseline' | 'followup_decision' | 'followup_evidence'
  | 'followup_result' | 'followup_resolution' | 'research_reuse' | 'evidence_reuse'
  | 'retained_partial_assessment'
  | 'classification_result'
  | 'rejected_response'
  | 'article_entity_proposal'
  | 'reservation_reconciliation'

/** Immutable, source-local checkpoints. They never make a job claimable. */
export interface ResearchV4StorePort {
  putResearchV4Record<T>(kind: ResearchV4RecordKind, workId: string, recordId: string, value: T): T
  getResearchV4Record<T>(kind: ResearchV4RecordKind, workId: string, recordId: string): T | null
  listResearchV4Records<T>(kind: ResearchV4RecordKind, workId: string, limit: number): T[]
  researchBudgetStore(): BudgetStorePort
  listResearchReservations(limit: number): D2ReservationRecord[]
  listRecentResearchPackets(limit: number): ResearchPacket[]
}

export function supportsResearchV4Store(store: object): store is ResearchV4StorePort {
  const candidate = store as Partial<ResearchV4StorePort>
  return typeof candidate.putResearchV4Record === 'function'
    && typeof candidate.getResearchV4Record === 'function'
    && typeof candidate.listResearchV4Records === 'function'
    && typeof candidate.researchBudgetStore === 'function'
    && typeof candidate.listRecentResearchPackets === 'function'
}
