export type NewsSourceType = 'curated_news'

export interface NewsSourceEndpoint {
  urlId: string
  label: string
  url: string
}

export interface NewsSourceDescriptor {
  sourceId: string
  sourceName: string
  sourceType: NewsSourceType
}

export type HermesWorkerTaskType = 'source_aware_research'
export type HermesWorkerStatus = 'succeeded' | 'failed' | 'timed_out'

export interface HermesWorkerRequest {
  jobId: string
  taskType: HermesWorkerTaskType
  prompt: string
  timeoutMs: number
  /** Known article URL used by the HTTP-only agent-browser read fast path. */
  sourceUrl?: string
}

export type NewsResearchExecutionMode = 'agent_browser_read' | 'hermes_browser_fallback'
export type NewsSourceReadStatus = 'succeeded' | 'failed' | 'timed_out' | 'skipped'

export interface HermesWorkerResult {
  jobId: string
  taskType: HermesWorkerTaskType
  status: HermesWorkerStatus
  stdout: string
  stderr: string
  exitCode: number | null
  startedAt: string
  finishedAt: string
  durationMs: number
  executionMode?: NewsResearchExecutionMode
  sourceReadStatus?: NewsSourceReadStatus
  sourceReadDurationMs?: number
  sourceReadError?: string | null
}

export interface HermesWorkerClientOptions {
  command: string
  profile?: string
  toolsets: string[]
}

export interface NewsCandidate {
  headline: string
  article_url: string
  summary?: string
  published_at?: string
  observed_at?: string
  author?: string
  section?: string
  evidence?: string[]
  /** Logical source kind retained inside the existing raw_candidate JSON. */
  content_kind?: 'article' | 'social_post'
  /** Technical provenance for auditing; never used as the pipeline identity. */
  provider_id?: string
  /** Actual outlet or handle supplied by an aggregator. */
  upstream_source_name?: string
  image_url?: string
  /** Untrusted upstream hints; research may inspect them but cannot assign entities from them. */
  related_coin_ids?: string[]
}

export interface NewsCandidateFingerprint {
  sourceId: string
  urlId: string
  canonicalArticleUrl: string
  headlineHash: string
  summaryHash: string | null
  contentHash: string
  articleIdentityKey: string
  observationDedupeKey: string
}

export type NewsDedupeOutcome =
  | 'new_candidate'
  | 'known_unchanged'
  | 'known_materially_changed'
  | 'ignored_invalid_candidate'

export interface PriorNewsObservation {
  sourceId: string
  urlId: string
  canonicalArticleUrl: string
  headlineHash: string
  summaryHash: string | null
  articleIdentityKey: string
  observationDedupeKey: string
  observedAt: string
}

export interface NewsCandidateDedupeDecision {
  outcome: NewsDedupeOutcome
  candidate: NewsCandidate
  fingerprint: NewsCandidateFingerprint | null
  reason: string
}

export interface NewsResearchRequest {
  schema_version: 'myboon.hermes.research_request.v1'
  job_id: string
  candidate_id: string
  task: {
    type: 'source_aware_research'
    objective: string
  }
  source: {
    source_id: string
    name: string
    source_type: 'curated_news'
  }
  source_url: {
    url_id: string
    label: string
    url: string
  }
  article: {
    content_kind: 'article' | 'social_post'
    provider_id?: string
    canonical_article_url: string
    article_url: string
    headline: string
    visible_summary: string | null
    published_at: string | null
    observed_at: string
    author?: string
    section?: string
    upstream_source_name?: string
    image_url?: string
    untrusted_related_coin_ids?: string[]
  }
  prior_observation: {
    dedupe_outcome: 'new_candidate' | 'known_materially_changed'
    article_identity_key: string
    observation_dedupe_key: string
    headline_hash: string
    summary_hash: string | null
    content_hash: string
  }
  research_requirements: {
    inspect_article: true
    extract_article_claims: true
    verify_with_external_evidence: true
    collect_evidence_links: true
    return_entity_hints: true
    note_uncertainty: true
  }
  response_rules: {
    return_json_only: true
    do_not_publish: true
    do_not_make_trade_recommendations: true
    do_not_score_rank_or_filter: true
    do_not_make_editorial_decisions: true
  }
  requested_at: string
}

export interface NewsResearchResponse {
  schema_version: 'myboon.hermes.research_response.v1'
  job_id: string
  candidate_id: string
  source_id: string
  url_id: string
  status: 'ready_for_entity_memory' | 'needs_followup' | 'failed'
  source_signal: {
    source_name: string
    source_url: string
    article_url: string
    canonical_article_url: string
    headline: string
    visible_summary: string | null
    published_at: string | null
    observed_at: string
  }
  research_summary: {
    one_liner: string
    what_was_checked: string[]
    requires_followup: boolean
    followup_reason?: string
  }
  article_claims: Array<{
    claim_id: string
    claim: string
    attributed_to?: string
    evidence_refs?: string[]
  }>
  verified_facts: Array<{
    fact: string
    evidence_refs: string[]
  }>
  unresolved_claims: Array<{
    claim: string
    reason: string
    evidence_refs?: string[]
  }>
  entity_hints: Array<{
    name: string
    type?: string
    role?: string
    aliases?: string[]
    source?: 'article' | 'evidence' | 'researcher_hint'
  }>
  evidence: Array<{
    evidence_id: string
    title: string
    url: string
    source_type?: string
    observed_at?: string
    note?: string
  }>
  open_questions: string[]
  limitations: string[]
  errors: string[]
}
