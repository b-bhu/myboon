export const SIGNAL_SCHEMA_VERSION = 'myboon.signal.v1' as const
export const RESEARCH_WORK_SCHEMA_VERSION = 'myboon.research_work.v1' as const
export const RETRIEVED_EVIDENCE_SCHEMA_VERSION = 'myboon.evidence.v1' as const
export const RESEARCH_PACKET_SCHEMA_VERSION = 'myboon.research_packet.v1' as const
export const EXECUTION_EVENT_SCHEMA_VERSION = 'myboon.execution_event.v1' as const

export type SignalSchemaVersion = typeof SIGNAL_SCHEMA_VERSION
export type ResearchWorkSchemaVersion = typeof RESEARCH_WORK_SCHEMA_VERSION
export type RetrievedEvidenceSchemaVersion = typeof RETRIEVED_EVIDENCE_SCHEMA_VERSION
export type ResearchPacketSchemaVersion = typeof RESEARCH_PACKET_SCHEMA_VERSION
export type ExecutionEventSchemaVersion = typeof EXECUTION_EVENT_SCHEMA_VERSION

export type PriorityClass = 'P0' | 'P1' | 'P2' | 'P3'
export type ResearchDepth = 'light' | 'standard' | 'deep'
export type TriageOutcome = 'archive' | 'defer' | ResearchDepth

export type DeepEscalationReason =
  | 'conflicting_primary_sources'
  | 'insufficient_primary_evidence'
  | 'rendering_required_for_material_fact'
  | 'entity_identity_ambiguous'
  | 'regulatory_interpretation_required'
  | 'manual_analyst_request'

export type WorkStatus =
  | 'signal_observed'
  | 'triage_pending'
  | 'archived'
  | 'deferred'
  | 'research_pending'
  | 'retrieval_leased'
  | 'deep_pending'
  | 'deep_leased'
  | 'synthesis_pending'
  | 'synthesis_leased'
  | 'research_ready'
  | 'entity_pending'
  | 'entity_leased'
  | 'complete'
  | 'retry_wait'
  | 'expired'
  | 'dead_letter'

export type FailureCategory =
  | 'provider_unavailable'
  | 'provider_rate_limited'
  | 'provider_timeout'
  | 'provider_authentication'
  | 'circuit_open'
  | 'retrieval_timeout'
  | 'retrieval_blocked'
  | 'retrieval_unsafe_url'
  | 'budget_exceeded'
  | 'invalid_structured_output'
  | 'schema_version_mismatch'
  | 'permanent_source_error'
  | 'entity_resolution_failed'
  | 'storage_transient'
  | 'storage_permanent'

export interface ExtensibleContract {
  [key: string]: unknown
}

export interface SignalMedia extends ExtensibleContract {
  imageUrl: string | null
  attribution: string | null
}

export interface SignalSourceHints extends ExtensibleContract {
  entities: string[]
  assets: string[]
  eventId: string | null
  deadline: string | null
}

export interface SignalProvenance extends ExtensibleContract {
  provider: string
  upstreamSource: string | null
  rawPayloadRef: string
}

export interface SignalBase extends ExtensibleContract {
  schemaVersion: SignalSchemaVersion
  signalId: string
  sourceId: string
  observedAt: string
  publishedAt: string | null
  canonicalUrl: string | null
  title: string
  visibleSummary: string | null
  media: SignalMedia
  sourceHints: SignalSourceHints
  provenance: SignalProvenance
  idempotencyKey: string
}

export interface ArticleContent extends ExtensibleContract {
  schemaVersion: 'myboon.signal_content.article.v1'
}

export interface MarketEventContent extends ExtensibleContract {
  schemaVersion: 'myboon.signal_content.market_event.v1'
}

export interface CalendarEventContent extends ExtensibleContract {
  schemaVersion: 'myboon.signal_content.calendar_event.v1'
}

export interface SocialThreadContent extends ExtensibleContract {
  schemaVersion: 'myboon.signal_content.social_thread.v1'
}

export interface NewsSignal extends SignalBase {
  sourceType: 'news'
  contentKind: 'article'
  content: ArticleContent
}

export interface PolymarketSignal extends SignalBase {
  sourceType: 'polymarket'
  contentKind: 'market_event'
  content: MarketEventContent
}

export interface MarketCalendarSignal extends SignalBase {
  sourceType: 'market_calendar'
  contentKind: 'calendar_event'
  content: CalendarEventContent
}

export interface XSignal extends SignalBase {
  sourceType: 'x'
  contentKind: 'social_thread'
  content: SocialThreadContent
}

/**
 * Versioned source-discriminated Signal v1. Adding a source means adding one
 * union member and one adapter; downstream stages continue switching on the
 * stable `sourceType` discriminator.
 */
export type Signal = NewsSignal | PolymarketSignal | MarketCalendarSignal | XSignal

export interface RetrievalPlan extends ExtensibleContract {
  sourceUrl: string | null
  allowedDomains: string[]
  maxExternalSources: number
}

export interface ResearchBudget extends ExtensibleContract {
  maxProviderCalls: number
  maxRepairCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  maxToolCalls: number
  maxWallTimeMs: number
}

/**
 * Immutable support recorded at the moment deep research is admitted.  The
 * optional field on ResearchWorkItem is an additive v1 compatibility seam for
 * legacy migrated work; every new triage-backed deep admission must carry it.
 */
export interface DeepEscalationAdmission extends ExtensibleContract {
  reason: DeepEscalationReason
  supportingEvidenceRefs: string[]
  unresolvedQuestion: string
  policyVersion: string
  policyRule: string
}

export interface ResearchWorkItem extends ExtensibleContract {
  schemaVersion: ResearchWorkSchemaVersion
  workId: string
  signalId: string
  sourceType: Signal['sourceType']
  researchDepth: ResearchDepth
  deepReason: DeepEscalationReason | null
  deepEscalation?: DeepEscalationAdmission | null
  priorityClass: PriorityClass
  priorityScore: number
  freshnessDeadline: string
  policyVersion: string
  researchContractVersion: ResearchPacketSchemaVersion
  retrievalPlan: RetrievalPlan
  budget: ResearchBudget
  status: WorkStatus
  attemptCount: number
  nextAttemptAt: string | null
  /** Code-owned resume target while status is retry_wait. */
  retryTargetStatus?: Extract<WorkStatus, 'research_pending' | 'deep_pending' | 'synthesis_pending' | 'entity_pending'> | null
  leaseOwner: string | null
  leaseId: string | null
  leaseExpiresAt: string | null
  failureCategory: FailureCategory | null
  failureDetail: string | null
  traceId: string
  createdAt: string
  updatedAt: string
}

export type RetrievalUrlAuthority = 'source_url' | 'source_hint' | 'search_connector'
export type RetrievalMethod = 'safe_http' | 'browser'

export interface RetrievedEvidence extends ExtensibleContract {
  schemaVersion: RetrievedEvidenceSchemaVersion
  evidenceId: string
  workId: string
  requestedUrl: string
  finalUrl: string
  authority: RetrievalUrlAuthority
  authorityId: string
  contentHash: string
  contentType: string | null
  httpStatus: number
  retrievalMethod: RetrievalMethod
  retrievedAt: string
  text: string
  truncated: boolean
  byteLength: number
}

export interface ResearchClaim extends ExtensibleContract {
  claimId: string
  claim: string
  attributedTo: string | null
  evidenceRefs: string[]
}

export interface VerifiedFact extends ExtensibleContract {
  fact: string
  evidenceRefs: string[]
}

export interface UnresolvedClaim extends ExtensibleContract {
  claim: string
  reason: string
  evidenceRefs: string[]
}

export interface ResearchEvidenceReference extends ExtensibleContract {
  evidenceId: string
  title: string
  url: string
  sourceType: string | null
  observedAt: string | null
  note: string | null
}

export interface EntityHint extends ExtensibleContract {
  name: string
  type: string | null
  role: string | null
  aliases: string[]
  source: string | null
  claimRefs: string[]
  evidenceRefs: string[]
}

export type ResearchCompletion = 'complete' | 'partial' | 'failed'

export interface BudgetUsage extends ExtensibleContract {
  providerCalls: number
  repairCalls: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  wallTimeMs: number
  budgetExceeded: boolean
}

export interface ResearchExecution extends ExtensibleContract {
  provider: string
  model: string
  fallbackProvider: string | null
  fallbackModel: string | null
  fallbackUsed: boolean
  promptVersion: string
  policyVersion: string
  traceId: string
  attempt: number
  /** Additive gateway provenance. Absent on packets written before AC20. */
  configuredPrimaryProvider?: string
  configuredPrimaryModel?: string
  fallbackReason?: FailureCategory | null
  outputSchemaValid?: boolean | null
}

export interface ResearchPacketV1 extends ExtensibleContract {
  schemaVersion: ResearchPacketSchemaVersion
  packetId: string
  workId: string
  signalId: string
  sourceType: Signal['sourceType']
  observedAt: string
  sourceSignal: {
    title: string
    canonicalUrl: string | null
    publishedAt: string | null
    provenance: SignalProvenance
    [key: string]: unknown
  }
  claims: ResearchClaim[]
  verifiedFacts: VerifiedFact[]
  unresolvedClaims: UnresolvedClaim[]
  evidence: ResearchEvidenceReference[]
  entityHints: EntityHint[]
  limitations: string[]
  openQuestions: string[]
  completion: ResearchCompletion
  budgetUsed: BudgetUsage
  execution: ResearchExecution
  researchContractVersion: ResearchPacketSchemaVersion
  createdAt: string
}

export type ExecutionStage =
  | 'collection'
  | 'normalization'
  | 'triage'
  | 'queue'
  | 'retrieval'
  | 'synthesis'
  | 'deep_research'
  | 'entity_manager'
  | 'memory_write'

export type ExecutionEventStatus =
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'retry_wait'
  | 'skipped'
  | 'expired'
  | 'dead_letter'

export interface ExecutionTraceEvent extends ExtensibleContract {
  schemaVersion: ExecutionEventSchemaVersion
  eventId: string
  traceId: string
  signalId: string | null
  workId: string | null
  packetId: string | null
  sourceType: Signal['sourceType']
  stage: ExecutionStage
  attempt: number
  startedAt: string
  finishedAt: string | null
  status: ExecutionEventStatus
  failureCategory: FailureCategory | null
  failureDetail: string | null
  queueWaitMs: number
  wallTimeMs: number
  provider: string | null
  model: string | null
  fallbackProvider: string | null
  fallbackModel: string | null
  fallbackUsed: boolean
  /** Additive route/schema provenance; legacy v1 events may omit these keys. */
  configuredPrimaryProvider?: string | null
  configuredPrimaryModel?: string | null
  fallbackReason?: FailureCategory | null
  outputSchemaValid?: boolean | null
  promptVersion: string | null
  policyVersion: string | null
  researchContractVersion: string | null
  providerCalls: number
  repairCalls: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  budgetExceeded: boolean
  /** Monetary cost reported by the provider/gateway. Null means unmeasured; never inferred from tokens. */
  costUsdMicros?: number | null
  createdAt: string
}
