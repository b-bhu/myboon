import type {
  NewsCandidateFingerprint,
  NewsDedupeOutcome,
  NewsResearchResponse,
  NewsCandidate,
  NewsSourceDescriptor,
  NewsSourceEndpoint,
  PriorNewsObservation,
} from './types'

export type NewsCandidateObservationStatus =
  | 'pending_research'
  | 'research_queued'
  | 'researching'
  | 'researched'
  | 'handed_to_entity_memory'
  | 'rejected'
  | 'failed_research'

export type PersistedNewsDedupeOutcome = 'new_candidate' | 'known_materially_changed'
export type NewsResearchResultStatus =
  | 'pending_entity_memory'
  | 'not_ready_for_entity_memory'
  | 'handed_to_entity_memory'
  | 'failed_entity_memory'

export function initialNewsResearchResultStatus(
  responseStatus: NewsResearchResponse['status']
): NewsResearchResultStatus {
  return responseStatus === 'ready_for_entity_memory'
    ? 'pending_entity_memory'
    : 'not_ready_for_entity_memory'
}

export interface NewsCandidateObservationInput {
  source: NewsSourceDescriptor
  sourceUrl: NewsSourceEndpoint
  candidate: NewsCandidate
  fingerprint: NewsCandidateFingerprint
  dedupeOutcome: NewsDedupeOutcome
  observedAt: string
  status?: NewsCandidateObservationStatus
}

export interface NewsCandidateObservationRow {
  id: string
  sourceRunId: string | null
  sourceId: string
  sourceName: string
  urlId: string
  urlLabel: string
  sourceUrl: string
  canonicalArticleUrl: string
  headline: string
  visibleSummary: string | null
  publishedAt: string | null
  observedAt: string
  headlineHash: string
  summaryHash: string | null
  contentHash: string
  articleIdentityKey: string
  observationDedupeKey: string
  dedupeOutcome: PersistedNewsDedupeOutcome
  status: NewsCandidateObservationStatus
  lastResearchJobId: string | null
  researchWorkerStatus: string | null
  researchError: string | null
  researchRawResponse: string | null
  researchStderr: string | null
  rawCandidate: NewsCandidate
  createdAt: string
  updatedAt: string
}

export interface RecordNewsResearchFailureInput {
  id: string
  jobId: string
  workerStatus?: string | null
  error: string
  rawResponse?: string | null
  stderr?: string | null
}

export interface RecoverStaleNewsWorkInput {
  candidateCutoffIso: string
}

export interface RecoverStaleNewsWorkResult {
  candidatesRecovered: number
}

export interface NewsResearchBacklog {
  pendingCandidates: number
  oldestPendingObservedAt: string | null
}

export interface NewsResearchResultInput {
  candidate: NewsCandidateObservationRow
  response: NewsResearchResponse
  researchedAt: string
  status?: NewsResearchResultStatus
}

export interface NewsResearchResultRow {
  id: string
  candidateObservationId: string
  sourceId: string
  sourceName: string
  urlId: string
  urlLabel: string
  sourceUrl: string
  canonicalArticleUrl: string
  articleIdentityKey: string
  observationDedupeKey: string
  researchJobId: string
  status: NewsResearchResultStatus
  responseStatus: NewsResearchResponse['status']
  sourceSignal: NewsResearchResponse['source_signal']
  researchSummary: NewsResearchResponse['research_summary']
  articleClaims: NewsResearchResponse['article_claims']
  verifiedFacts: NewsResearchResponse['verified_facts']
  unresolvedClaims: NewsResearchResponse['unresolved_claims']
  entityHints: NewsResearchResponse['entity_hints']
  evidence: NewsResearchResponse['evidence']
  openQuestions: NewsResearchResponse['open_questions']
  limitations: NewsResearchResponse['limitations']
  errors: NewsResearchResponse['errors']
  rawResponse: NewsResearchResponse
  researchedAt: string
  createdAt: string
  updatedAt: string
}

export interface PendingNewsResearchResult {
  result: NewsResearchResultRow
  candidate: NewsCandidateObservationRow
}

export interface NewsStore {
  fetchPriorObservations(
    sourceId: string,
    canonicalArticleUrls: string[]
  ): Promise<PriorNewsObservation[]>
  insertCandidateObservations(
    inputs: NewsCandidateObservationInput[]
  ): Promise<NewsCandidateObservationRow[]>
  fetchCandidateObservation(id: string): Promise<NewsCandidateObservationRow | null>
  fetchPendingCandidateObservations(limit: number): Promise<NewsCandidateObservationRow[]>
  /**
   * Claims distinct oldest-first candidates before any Hermes work begins.
   * Implementations must transition only rows that are still pending so
   * multiple workers cannot research the same observation.
   */
  claimPendingCandidateObservations(limit: number): Promise<NewsCandidateObservationRow[]>
  readResearchBacklog(): Promise<NewsResearchBacklog>
  markCandidateObservationStatus(id: string, status: NewsCandidateObservationStatus): Promise<void>
  markCandidateResearchStarted(id: string, jobId: string): Promise<void>
  recordCandidateResearchFailure(input: RecordNewsResearchFailureInput): Promise<void>
  recoverStaleWork(input: RecoverStaleNewsWorkInput): Promise<RecoverStaleNewsWorkResult>
  insertResearchResult(input: NewsResearchResultInput): Promise<NewsResearchResultRow>
  fetchResearchResult(id: string): Promise<NewsResearchResultRow | null>
  fetchPendingResearchResults(limit: number): Promise<PendingNewsResearchResult[]>
  markResearchResultStatus(
    id: string,
    status: NewsResearchResultStatus,
    failure?: { error: string; category?: string | null }
  ): Promise<void>
}
