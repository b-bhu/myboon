import type {
  DeepEscalationReason,
  PriorityClass,
  ResearchBudget,
  ResearchDepth,
  Signal,
  TriageOutcome,
} from './contracts'

export const PRIORITY_POLICY_SCHEMA_VERSION = 'myboon.priority_policy.v1' as const
export const TRIAGE_DECISION_SCHEMA_VERSION = 'myboon.triage_decision.v1' as const
export const TRIAGE_CLASSIFIER_RESULT_SCHEMA_VERSION = 'myboon.triage_classifier_result.v1' as const

export const COMMON_PRIORITY_SEMANTICS = {
  P0: 'an active security incident, market halt, official release/event at or near its effective deadline, or immediate regulatory action whose value materially decays within minutes',
  P1: 'authoritative, materially market-relevant information whose product value materially decays within the same day',
  P2: 'useful current context without an immediate deadline',
  P3: 'background, low-confidence, or deferrable context',
} as const satisfies Record<PriorityClass, string>

export interface PriorityClassPolicy {
  meaning: typeof COMMON_PRIORITY_SEMANTICS[PriorityClass]
  freshnessMs: number
}

export interface PriorityPolicyV1 {
  schemaVersion: typeof PRIORITY_POLICY_SCHEMA_VERSION
  policyVersion: string
  budgetPolicyVersion: string
  classes: Record<PriorityClass, PriorityClassPolicy>
  budgets: Record<ResearchDepth, ResearchBudget>
  p0DeadlineWindowMs: number
  p1DeadlineWindowMs: number
  authoritativeScoreThreshold: number
  deepAdmissionMaxUtilization: number
  lowerPriorityDeferUtilization: number
  allowedDeepReasons: DeepEscalationReason[]
}

export type DedupeMaterialChangeOutcome =
  | 'new'
  | 'new_observation'
  | 'exact_duplicate'
  | 'cosmetic_change'
  | 'material_change'

export type NoveltyLevel = 'none' | 'low' | 'material' | 'novel_entity'

export type MaterialityTag =
  | 'security_incident'
  | 'market_halt'
  | 'immediate_regulatory_action'
  | 'official_release'
  | 'security'
  | 'regulatory'
  | 'market_material'
  | 'macro'
  | 'earnings'
  | 'calendar'
  | 'social'
  | 'background'
  | 'low_value'
  | 'unrelated'

export interface DeepEscalationRequest {
  reason: DeepEscalationReason
  evidenceRefs: string[]
  unresolvedQuestion: string
  policyRule: string
}

export interface CapacityBucket {
  available: number
  reservedAvailable: number
  utilization: number
}

export interface TriageCapacitySnapshot {
  byPriority: Record<PriorityClass, CapacityBucket>
  byDepth: Record<ResearchDepth, CapacityBucket>
}

export type ProviderWorkloadHealth = 'healthy' | 'degraded' | 'unavailable' | 'circuit_open'

export interface RulesFirstTriageInput {
  signal: Signal
  /** Source-native facts translated to the shared registry; sources cannot submit a priority class. */
  dedupeOutcome: DedupeMaterialChangeOutcome
  sourceAuthorityScore: number
  officialSource: boolean
  entityCanonOverlap: boolean
  novelty: NoveltyLevel
  materialityTags: MaterialityTag[]
  eventDeadline: string | null
  capacity: TriageCapacitySnapshot
  providerHealth: ProviderWorkloadHealth
  ambiguity: {
    isAmbiguous: boolean
    reasons: string[]
  }
  deepEscalation: DeepEscalationRequest | null
  now: string
}

export type TriageDecisionReasonCode =
  | 'exact_duplicate'
  | 'stale_low_value'
  | 'material_change'
  | 'novel_entity_preserved'
  | 'official_urgent_reserved_path'
  | 'priority_semantics'
  | 'provider_pressure_defer'
  | 'capacity_pressure_defer'
  | 'deep_capacity_tightened'
  | 'deep_ineligible'
  | 'typed_deep_escalation'
  | 'ambiguous_classifier'
  | 'rules_default'

export interface TriageDecisionReason {
  code: TriageDecisionReasonCode
  detail: string
}

export interface TriageDecisionV1 {
  schemaVersion: typeof TRIAGE_DECISION_SCHEMA_VERSION
  decisionId: string
  signalId: string
  sourceType: Signal['sourceType']
  outcome: TriageOutcome
  priorityClass: PriorityClass
  priorityScore: number
  reasons: TriageDecisionReason[]
  freshnessDeadline: string
  budgetPolicyVersion: string
  budget: ResearchBudget | null
  deepEscalationReason: DeepEscalationReason | null
  priorityPolicyVersion: string
  classifierUsed: boolean
  decidedAt: string
}

export type TriageClassifierReason =
  | 'low_materiality'
  | 'useful_current_context'
  | 'material_relevance'
  | 'insufficient_rules'

export interface BoundedTriageClassifierInput {
  signalId: string
  sourceType: Signal['sourceType']
  contentKind: Signal['contentKind']
  title: string
  visibleSummary: string | null
  officialSource: boolean
  sourceAuthorityScore: number
  novelty: NoveltyLevel
  materialityTags: MaterialityTag[]
  ambiguityReasons: string[]
}

export interface BoundedTriageClassifierResult {
  schemaVersion: typeof TRIAGE_CLASSIFIER_RESULT_SCHEMA_VERSION
  suggestedOutcome: Extract<TriageOutcome, 'defer' | 'light' | 'standard'>
  scoreAdjustment: number
  reason: TriageClassifierReason
  explanation: string
}

export interface CheapToollessTriageClassifier {
  classify(input: Readonly<BoundedTriageClassifierInput>):
    BoundedTriageClassifierResult | Promise<BoundedTriageClassifierResult>
}
