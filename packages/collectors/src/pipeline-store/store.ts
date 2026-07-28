/**
 * Shared pipeline store contract.
 *
 * `PipelineStore` is the single interface that both a SQLite implementation
 * (running locally on the VPS) and a Supabase implementation must satisfy.
 * It covers the full collector -> researcher -> editor -> draft -> publish
 * pipeline: watchlist snapshots, candidates, research, editor decisions,
 * editor drafts, pipeline run receipts, and the lease/recovery primitives
 * used to safely claim and requeue work across worker restarts.
 *
 * Intermediate pipeline state lives here. This is transient, high-churn,
 * operational data - the kind of thing a worker reads and writes many times
 * on its way to a finished artifact. In production that state lives in a
 * local SQLite database on the VPS; a Supabase-backed implementation exists
 * for environments where a shared/durable store is preferred (e.g. local
 * dev, tests, or a future hosted worker).
 *
 * `entities`, `entity_memories`, `published_narratives`, and
 * `entity_published_history` deliberately do NOT belong here. Those tables
 * hold durable product data - the entity graph and the finished, customer-
 * facing output of the pipeline - and they stay in Supabase regardless of
 * where intermediate pipeline state lives. Nothing in this interface reads
 * or writes them.
 *
 * This file is types and an interface only. No implementation.
 */

// ---------------------------------------------------------------------------
// Status unions
// ---------------------------------------------------------------------------

/** Matches polymarket_market_watchlist.status CHECK constraint. */
export type PipelineWatchlistStatus = 'active' | 'inactive'

/**
 * Matches polymarket_market_candidates.status CHECK constraint, plus
 * 'stale_expired' - a new terminal status (not yet in the DB constraint)
 * used by expireAgedWork (L5) to give aged-out work an explicit terminal
 * state instead of silently filtering it out of every query.
 */
export type PipelineStoreCandidateStatus =
  | 'pending_research'
  | 'researching'
  | 'researched'
  | 'skipped_recently_researched'
  | 'research_failed'
  | 'rejected'
  | 'published'
  | 'stale_expired'

/** Matches polymarket_market_candidates.research_depth / candidate_research.research_depth CHECK constraint. */
export type PipelineResearchDepth = 'market_structure_only' | 'reuse_prior' | 'deep_web'

/** Matches polymarket_market_candidate_research.evidence_quality CHECK constraint. */
export type PipelineEvidenceQuality = 'strong' | 'medium' | 'weak'

/** Matches polymarket_market_candidate_research.recommended_editor_action CHECK constraint. */
export type PipelineRecommendedEditorAction = 'publish_candidate' | 'reject_thin' | 'needs_more_research'

/** Matches polymarket_market_candidate_research.status CHECK constraint. */
export type PipelineResearchStatus =
  | 'pending_editor'
  | 'editing'
  | 'edited'
  | 'rejected'
  | 'needs_more_research'
  | 'published'

/** Matches polymarket_market_editor_decisions.decision CHECK constraint. */
export type PipelineEditorDecision = 'publish' | 'reject' | 'needs_more_research'

/** Matches polymarket_market_editor_decisions.status CHECK constraint. */
export type PipelineEditorDecisionStatus = 'pending_publisher' | 'rejected' | 'needs_more_research' | 'published'

/** Matches polymarket_market_editor_decisions.topic_confidence CHECK constraint. */
export type PipelineTopicConfidence = 'high' | 'medium' | 'low'

/** Matches editor_drafts.action CHECK constraint. */
export type PipelineDraftAction =
  | 'draft_post'
  | 'watch'
  | 'skip_repetitive'
  | 'needs_more_research'
  | 'merge_with_existing_draft'

/** Matches editor_drafts.status CHECK constraint. */
export type PipelineDraftStatus = 'drafted' | 'watching' | 'skipped' | 'needs_more_research' | 'merged' | 'published'

/** Matches pipeline_runs.status CHECK constraint. */
export type PipelineRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'partial'

// ---------------------------------------------------------------------------
// Watchlist (W1-W3)
// ---------------------------------------------------------------------------

export interface PipelineWatchlistUpsertInput {
  source: string
  area: string
  tagSlug: string
  tagLabel: string | null
  marketId: string
  slug: string
  title: string
  eventSlug: string | null
  eventTitle: string | null
  endDate: string | null
  isManualPin: boolean
  rankInArea: number | null
  watchScore: number
  scoreBreakdown: unknown
  selectionReason: string
  latestObservedAt: string | null
  latestYesPrice: number | null
  latestVolume: number | null
  latestVolume24h: number | null
  latestLiquidity: number | null
  status?: PipelineWatchlistStatus
}

export interface PipelineWatchlistSnapshotRow {
  slug: string
  latestObservedAt: string | null
  latestYesPrice: number | null
  latestVolume: number | null
  latestVolume24h: number | null
}

// ---------------------------------------------------------------------------
// Candidates (C1-C9, L1-L5)
// ---------------------------------------------------------------------------

export interface PipelineCandidateRow {
  id: string
  source: string
  area: string
  candidateType: string
  marketId: string
  slug: string
  title: string
  tagSlug: string
  tagLabel: string | null
  observedAt: string
  whatChanged: string
  whyFlagged: string
  score: number
  scoreBreakdown: unknown
  metrics: unknown
  evidenceRefs: unknown
  status: PipelineStoreCandidateStatus
  dedupeKey: string
  researchError: string | null
  researchAttemptedAt: string | null
  researchRetryCount: number
  researchNextRetryAt: string | null
  researchLastErrorKind: string | null
  researchFamilyKey: string | null
  researchClusterKey: string | null
  researchDepth: PipelineResearchDepth | null
  leaseOwner: string | null
  leaseExpiresAt: string | null
  attemptCount: number
  createdAt: string
  updatedAt: string
}

export interface PipelineCandidateInsertInput {
  source: string
  area: string
  candidateType: string
  marketId: string
  slug: string
  title: string
  tagSlug: string
  tagLabel: string | null
  observedAt: string
  whatChanged: string
  whyFlagged: string
  score: number
  scoreBreakdown: unknown
  metrics: unknown
  evidenceRefs: unknown
  dedupeKey: string
  status?: PipelineStoreCandidateStatus
}

export interface PipelineCandidateThreadUpdate {
  id: string
  payload: Partial<
    Pick<
      PipelineCandidateRow,
      | 'status'
      | 'observedAt'
      | 'whatChanged'
      | 'whyFlagged'
      | 'score'
      | 'scoreBreakdown'
      | 'metrics'
      | 'evidenceRefs'
      | 'researchFamilyKey'
      | 'researchClusterKey'
      | 'researchDepth'
    >
  >
}

export interface PipelineFetchPendingCandidatesInput {
  source: string
  area: string
  limit: number
  observedAfter?: string | null
}

export interface PipelineFindCandidatesForBacklogInput {
  source: string
  area: string
  statuses: PipelineStoreCandidateStatus[]
  slugs?: string[]
  limit: number
}

export interface PipelineSetCandidateStatusInput {
  ids: string[]
  status: PipelineStoreCandidateStatus
  observedAt: string
  researchError?: string | null
  extra?: Partial<
    Pick<
      PipelineCandidateRow,
      'researchRetryCount' | 'researchNextRetryAt' | 'researchLastErrorKind' | 'researchAttemptedAt'
    >
  >
}

// ---------------------------------------------------------------------------
// Research (R1-R6)
// ---------------------------------------------------------------------------

export interface PipelineResearchRow {
  id: string
  candidateId: string
  source: string
  area: string
  slug: string
  title: string
  candidateType: string
  researchMode: string
  summary: string
  notes: string
  keyFindings: unknown
  evidenceLinks: unknown
  relatedContext: unknown
  uncertainty: string
  editorNotes: string
  status: PipelineResearchStatus
  researchedAt: string
  researchFamilyKey: string
  researchClusterKey: string
  researchDepth: PipelineResearchDepth
  evidenceQuality: PipelineEvidenceQuality
  catalystFound: boolean
  recommendedEditorAction: PipelineRecommendedEditorAction
  duplicateOfResearchId: string | null
  researchBackend: string
  researchModel: string | null
  createdAt: string
  updatedAt: string
}

export interface PipelineResearchUpsertInput {
  candidateId: string
  source: string
  area: string
  slug: string
  title: string
  candidateType: string
  researchMode: string
  summary: string
  notes: string
  keyFindings: unknown
  evidenceLinks: unknown
  relatedContext: unknown
  uncertainty: string
  editorNotes: string
  status?: PipelineResearchStatus
  researchedAt: string
  researchFamilyKey: string
  researchClusterKey: string
  researchDepth: PipelineResearchDepth
  evidenceQuality: PipelineEvidenceQuality
  catalystFound: boolean
  recommendedEditorAction: PipelineRecommendedEditorAction
  duplicateOfResearchId?: string | null
  researchBackend: string
  researchModel?: string | null
}

export interface PipelineFindResearchForBacklogInput {
  source: string
  area: string
  statuses: PipelineResearchStatus[]
  slugs?: string[]
  limit: number
}

export interface PipelineFindPriorResearchInput {
  keyType: 'slug' | 'family'
  keys: string[]
  limit: number
}

export interface PipelineFetchResearchByStatusInput {
  source: string
  area: string
  status: PipelineResearchStatus
  limit: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Editor decisions (E1-E3)
// ---------------------------------------------------------------------------

export interface PipelineEditorDecisionRow {
  id: string
  source: string
  area: string
  researchIds: string[]
  decision: PipelineEditorDecision
  status: PipelineEditorDecisionStatus
  angle: string | null
  whyThisMatters: string | null
  reasoning: string
  reasonCodes: unknown
  evidenceQuality: PipelineEvidenceQuality
  primaryTopic: string | null
  relatedTopics: unknown
  topicConfidence: PipelineTopicConfidence | null
  publisherNotes: string | null
  followUpQuestions: unknown
  researchInstructions: string | null
  createdAt: string
  updatedAt: string
}

export interface PipelineEditorDecisionInsertInput {
  source: string
  area: string
  researchIds: string[]
  decision: PipelineEditorDecision
  status: PipelineEditorDecisionStatus
  angle?: string | null
  whyThisMatters?: string | null
  reasoning: string
  reasonCodes?: unknown
  evidenceQuality: PipelineEvidenceQuality
  primaryTopic?: string | null
  relatedTopics?: unknown
  topicConfidence?: PipelineTopicConfidence | null
  publisherNotes?: string | null
  followUpQuestions?: unknown
  researchInstructions?: string | null
}

export interface PipelineFindEditorDecisionsInput {
  source: string
  area: string
  status?: PipelineEditorDecisionStatus
  decision?: PipelineEditorDecision
  orderBy: 'asc' | 'desc'
  limit: number
}

export interface PipelineEditorDecisionInsertResult {
  id: string
  researchIds: string[]
  decision: PipelineEditorDecision
  status: PipelineEditorDecisionStatus
  angle: string | null
}

// ---------------------------------------------------------------------------
// Editor drafts (D1-D5)
// ---------------------------------------------------------------------------

export interface PipelineDraftRow {
  id: string
  entityId: string
  entitySlug: string
  entityName: string
  entityType: string
  bundleKey: string
  sourceMemoryIds: string[]
  sourceMemoryHash: string
  source: string | null
  sourceArea: string | null
  action: PipelineDraftAction
  status: PipelineDraftStatus
  title: string | null
  angle: string | null
  summary: string | null
  body: string | null
  reasoning: string
  reasonCodes: unknown
  evidenceQuality: PipelineEvidenceQuality | null
  priority: number | null
  confidence: number | null
  mergeTargetDraftId: string | null
  relatedDraftIds: unknown
  followUpQuestions: unknown
  researchInstructions: string | null
  backend: string
  model: string | null
  createdAt: string
  updatedAt: string
}

export interface PipelineDraftUpsertInput {
  entityId: string
  entitySlug: string
  entityName: string
  entityType: string
  bundleKey: string
  sourceMemoryIds: string[]
  sourceMemoryHash: string
  source?: string | null
  sourceArea?: string | null
  action: PipelineDraftAction
  status: PipelineDraftStatus
  title?: string | null
  angle?: string | null
  summary?: string | null
  body?: string | null
  reasoning: string
  reasonCodes?: unknown
  evidenceQuality?: PipelineEvidenceQuality | null
  priority?: number | null
  confidence?: number | null
  mergeTargetDraftId?: string | null
  relatedDraftIds?: unknown
  followUpQuestions?: unknown
  researchInstructions?: string | null
  backend: string
  model?: string | null
}

export interface PipelineFetchEligibleDraftsInput {
  action: PipelineDraftAction
  status: PipelineDraftStatus
  limit: number
}

// ---------------------------------------------------------------------------
// Pipeline runs (P1-P2)
// ---------------------------------------------------------------------------

export interface PipelineRunStartInput {
  source: string
  sourceArea?: string | null
  stage: string
  inputRef?: string | null
  startedAt: string
  metadata?: unknown
}

export interface PipelineRunStartResult {
  id: string
}

export interface PipelineRunFinishInput {
  status: Exclude<PipelineRunStatus, 'running'>
  outputRef?: string | null
  finishedAt: string
  counts?: unknown
  error?: string | null
  metadata?: unknown
}

// ---------------------------------------------------------------------------
// Lease / recovery (L1-L5) - reserved for issue #257, defined now so that
// work does not have to change this interface.
// ---------------------------------------------------------------------------

export interface PipelineClaimWithLeaseInput {
  source: string
  area: string
  stage: string
  limit: number
  leaseOwner: string
  leaseSeconds: number
  now: string
}

export interface PipelineClaimRetryableWithLeaseInput {
  source: string
  area: string
  stage: string
  limit: number
  leaseOwner: string
  leaseSeconds: number
  now: string
  /** Only claim 'research_failed' rows whose attempt_count is strictly less than this. */
  maxRetryCount: number
}

export interface PipelineRecoverExpiredLeasesInput {
  stage: string
  now: string
}

export interface PipelineRecoverExpiredLeasesResult {
  recovered: number
  ids: string[]
}

export interface PipelineExpireAgedWorkInput {
  stage: string
  olderThan: string
  now: string
}

export interface PipelineExpireAgedWorkResult {
  expired: number
}

// ---------------------------------------------------------------------------
// Backlog depth
// ---------------------------------------------------------------------------

export interface PipelineBacklogDepthInput {
  source: string
  area: string
  /** Reference instant used to decide whether an in-flight lease is still live. Defaults to "now" in the caller if omitted. */
  now?: string
}

/**
 * Cheap, COUNT-only view of how much work is sitting at each stage of the
 * collector -> researcher -> editor -> draft -> publish pipeline, for a given
 * (source, area).
 *
 * This exists so supply (the collector inserting candidates) can see drain
 * (the researcher's throughput) before creating more work, and so a status
 * surface can report backlog without ever fetching full rows. Every field
 * must be answerable with `COUNT(*) ... WHERE`, never a row scan.
 */
export interface PipelineBacklogDepth {
  source: string
  area: string
  /** pipeline_candidates rows with status = 'pending_research'. */
  candidatesPending: number
  /**
   * pipeline_candidates rows with status = 'researching' AND an unexpired
   * lease (lease_expires_at > now). Distinct from candidatesLeaseExpired -
   * see that field's doc.
   */
  candidatesInFlight: number
  /** pipeline_candidates rows with status = 'research_failed'. */
  candidatesFailed: number
  /** pipeline_candidates rows with status = 'stale_expired' (see expireAgedWork). */
  candidatesStaleExpired: number
  /**
   * pipeline_candidates rows with status = 'researching' whose lease has
   * expired (lease_expires_at <= now) but have not yet been recovered by
   * recoverExpiredLeases. This is work that LOOKS in-flight but is actually
   * stuck - the leaks this whole effort exists to keep visible.
   */
  candidatesLeaseExpired: number
  /** pipeline_research rows with status = 'pending_editor'. */
  researchPendingEditor: number
  /** pipeline_editor_decisions rows with status = 'pending_publisher'. */
  decisionsPendingPublisher: number
  /** pipeline_editor_drafts rows with status = 'drafted'. */
  draftsDrafted: number
}

// ---------------------------------------------------------------------------
// PipelineStore
// ---------------------------------------------------------------------------

export interface PipelineStore {
  // Watchlist
  getWatchlistSnapshots(area: string, slugs: string[]): Promise<PipelineWatchlistSnapshotRow[]>
  upsertWatchlist(rows: PipelineWatchlistUpsertInput[]): Promise<void>
  /**
   * Marks watchlist rows inactive when they were not seen in the run at
   * `observedAt`. This is a status write ONLY: deactivated rows must remain
   * visible to `getWatchlistSnapshots`, which reads prior values to compute
   * deltas and would produce wrong deltas if they disappeared. An
   * implementation must NOT filter on status in `getWatchlistSnapshots`.
   */
  deactivateStaleWatchlist(area: string, observedAt: string): Promise<void>

  // Candidates
  findExistingDedupeKeys(dedupeKeys: string[]): Promise<Set<string>>
  findCandidateThreadsByFamilyKey(
    source: string,
    area: string,
    familyKeys: string[],
    fallbackScanLimit?: number
  ): Promise<PipelineCandidateRow[]>
  findCandidatesForBacklog(input: PipelineFindCandidatesForBacklogInput): Promise<PipelineCandidateRow[]>
  insertCandidates(rows: PipelineCandidateInsertInput[]): Promise<PipelineCandidateRow[]>
  updateCandidateThreads(updates: PipelineCandidateThreadUpdate[]): Promise<void>
  fetchPendingCandidates(input: PipelineFetchPendingCandidatesInput): Promise<PipelineCandidateRow[]>
  setCandidateStatus(input: PipelineSetCandidateStatusInput): Promise<void>
  getCandidatesByIds(ids: string[]): Promise<PipelineCandidateRow[]>

  // Research
  getResearchByIds(ids: string[]): Promise<PipelineResearchRow[]>
  findResearchForBacklog(input: PipelineFindResearchForBacklogInput): Promise<PipelineResearchRow[]>
  findPriorResearch(input: PipelineFindPriorResearchInput): Promise<PipelineResearchRow[]>
  /**
   * Upserts research rows, keyed on `candidateId`.
   *
   * Returns the persisted research row ids (NOT the candidate ids the caller
   * already holds), in the same order as `rows`. The ids must be read back
   * from what was actually written -- an implementation must not echo its
   * input and infer success, because a caller that trusts an echo cannot tell
   * a silently dropped row from a persisted one.
   */
  upsertResearchRows(rows: PipelineResearchUpsertInput[]): Promise<string[]>
  fetchResearchByStatus(input: PipelineFetchResearchByStatusInput): Promise<PipelineResearchRow[]>
  setResearchStatus(ids: string[], status: PipelineResearchStatus, observedAt: string): Promise<void>

  // Editor decisions
  findEditorDecisions(input: PipelineFindEditorDecisionsInput): Promise<PipelineEditorDecisionRow[]>
  insertEditorDecisions(
    rows: PipelineEditorDecisionInsertInput[]
  ): Promise<PipelineEditorDecisionInsertResult[]>
  setEditorDecisionStatus(ids: string[], status: PipelineEditorDecisionStatus, observedAt: string): Promise<void>

  // Editor drafts
  fetchPriorDraftsByEntity(entityIds: string[], limitPerEntity: number): Promise<Map<string, PipelineDraftRow[]>>
  findReviewedMemoryIds(memoryIds: string[]): Promise<Set<string>>
  upsertDraftsByBundleKey(drafts: PipelineDraftUpsertInput[]): Promise<PipelineDraftRow[]>
  fetchEligibleDrafts(input: PipelineFetchEligibleDraftsInput): Promise<PipelineDraftRow[]>
  setDraftPublished(draftId: string, observedAt: string): Promise<void>

  // Pipeline runs
  startRun(input: PipelineRunStartInput): Promise<PipelineRunStartResult>
  finishRun(id: string, input: PipelineRunFinishInput): Promise<void>

  // Lease / recovery (reserved for issue #257)
  /**
   * Atomically claims up to `limit` work items and marks them leased.
   *
   * THE CLAIMABLE SET is the union of:
   *   1. pending work that is not currently leased, and
   *   2. in-flight work whose lease has expired (`leaseExpiresAt <= now`).
   *
   * Clause 2 is not optional. Claiming flips status to in-flight, so an
   * implementation that only considers pending work can never reclaim an
   * expired lease -- the item becomes permanently unclaimable and the work is
   * silently lost. That is the exact failure this store exists to prevent.
   *
   * Must be atomic: two concurrent callers must never receive the same item.
   * `attemptCount` must be incremented in the database, never read-modify-write.
   */
  claimWithLease(input: PipelineClaimWithLeaseInput): Promise<PipelineCandidateRow[]>
  /**
   * Atomically claims up to `limit` retry-eligible 'research_failed' rows and
   * marks them leased, in the SAME sense as `claimWithLease` but for the
   * retry lane instead of the pending lane.
   *
   * THE CLAIMABLE SET is 'research_failed' rows where:
   *   - attempt_count < maxRetryCount, AND
   *   - research_next_retry_at IS NULL OR research_next_retry_at <= now
   *
   * This exists so promoting a retry-eligible row to leased-and-in-flight is
   * ONE atomic step instead of two (setCandidateStatus to 'pending_research'
   * followed by a separate claimWithLease call). The two-step version leaves
   * a window, if the caller crashes between the steps, where a row is
   * promoted but not yet leased - recoverable (the row is still claimable),
   * but still a status that misrepresents reality, which is exactly what the
   * lease model exists to avoid.
   *
   * Must be atomic: two concurrent callers must never receive the same row.
   * `attemptCount` must be incremented in the database, never read-modify-write.
   * Rows in any other status (including unexpired 'researching' leases) must
   * be left untouched.
   */
  claimRetryableWithLease(input: PipelineClaimRetryableWithLeaseInput): Promise<PipelineCandidateRow[]>
  renewLease(ids: string[], leaseOwner: string, leaseSeconds: number, now: string): Promise<void>
  releaseLease(ids: string[], leaseOwner: string): Promise<void>
  recoverExpiredLeases(input: PipelineRecoverExpiredLeasesInput): Promise<PipelineRecoverExpiredLeasesResult>
  expireAgedWork(input: PipelineExpireAgedWorkInput): Promise<PipelineExpireAgedWorkResult>

  // Backlog depth
  /**
   * Cheap per-stage backlog counts for (source, area). Must be implemented as
   * COUNT queries only - no row fetching - so it is safe to call before every
   * candidate-creation run and from a status CLI/endpoint on demand.
   */
  getBacklogDepth(input: PipelineBacklogDepthInput): Promise<PipelineBacklogDepth>

  // Lifecycle
  close(): void
}
