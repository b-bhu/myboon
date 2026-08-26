import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  type DeepEscalationReason,
  type DeepEscalationAdmission,
  type PriorityClass,
  type ResearchBudget,
  type ResearchDepth,
  type ResearchWorkItem,
  type Signal,
  type TriageOutcome,
} from './contracts'
import { stableContractId } from './adapters/identity'
import { canonicalJson } from './canonical-json'
import {
  COMMON_PRIORITY_SEMANTICS,
  PRIORITY_POLICY_SCHEMA_VERSION,
  TRIAGE_CLASSIFIER_RESULT_SCHEMA_VERSION,
  TRIAGE_DECISION_SCHEMA_VERSION,
  type BoundedTriageClassifierInput,
  type CheapToollessTriageClassifier,
  type MaterialityTag,
  type PriorityPolicyV1,
  type RulesFirstTriageInput,
  type TriageDecisionReason,
  type TriageDecisionV1,
} from './triage-contracts'
import {
  validateBoundedClassifierResult,
  validatePriorityPolicy,
  validateTriageDecision,
} from './triage-validation'
import { validateResearchWorkItem, validateSignal } from './validation'

const MATERIAL_TAGS = new Set<MaterialityTag>([
  'security_incident', 'market_halt', 'immediate_regulatory_action',
  'official_release', 'security', 'regulatory', 'market_material', 'macro',
  'earnings', 'calendar',
])
const IMMEDIATE_TAGS = new Set<MaterialityTag>([
  'security_incident', 'market_halt', 'immediate_regulatory_action',
])

export interface ResearchWorkCreationPolicy {
  policyVersion: string
  allowedDomains: string[]
  maxExternalSourcesByDepth: Record<ResearchDepth, number>
}

export class RulesFirstTriageEngine {
  private readonly policy: PriorityPolicyV1
  private readonly classifier: CheapToollessTriageClassifier | null

  constructor(input: {
    policy: PriorityPolicyV1
    classifier?: CheapToollessTriageClassifier | null
  }) {
    this.policy = validatePriorityPolicy(input.policy)
    this.classifier = input.classifier ?? null
  }

  async decide(input: RulesFirstTriageInput): Promise<TriageDecisionV1> {
    const signal = validateSignal(input.signal)
    validateInput(input)
    const nowMs = Date.parse(input.now)
    const deadlineMs = input.eventDeadline ? Date.parse(input.eventDeadline) : null
    const lowValue = hasAny(input.materialityTags, ['low_value', 'unrelated', 'background'])
    const materiallyNovel = input.novelty === 'material' || input.novelty === 'novel_entity'
    const stale = deadlineMs !== null && deadlineMs <= nowMs
    const reasons: TriageDecisionReason[] = []

    const priorityClass = selectPriority(input, this.policy, nowMs, deadlineMs)
    let priorityScore = selectPriorityScore(input, priorityClass)
    const freshnessDeadline = selectFreshnessDeadline(input.now, input.eventDeadline, this.policy, priorityClass)

    if (input.dedupeOutcome === 'exact_duplicate') {
      return decision(signal, input, this.policy, {
        outcome: 'archive', priorityClass, priorityScore,
        freshnessDeadline, classifierUsed: false, deepReason: null,
        reasons: [{ code: 'exact_duplicate', detail: 'The source observation is an exact duplicate of retained canonical content.' }],
      })
    }
    if (stale && lowValue && !input.officialSource && !materiallyNovel
      && input.dedupeOutcome !== 'material_change') {
      return decision(signal, input, this.policy, {
        outcome: 'archive', priorityClass, priorityScore,
        freshnessDeadline, classifierUsed: false, deepReason: null,
        reasons: [{ code: 'stale_low_value', detail: 'The event deadline elapsed and independent low-value facts support archival.' }],
      })
    }

    if (input.dedupeOutcome === 'material_change') {
      reasons.push({ code: 'material_change', detail: 'A material source change requires a fresh admission decision.' })
    }
    if (!input.entityCanonOverlap && input.novelty === 'novel_entity') {
      reasons.push({ code: 'novel_entity_preserved', detail: 'A materially novel entity absent from canon retains a research path.' })
    }
    if (priorityClass === 'P0') {
      reasons.push({
        code: input.officialSource ? 'official_urgent_reserved_path' : 'priority_semantics',
        detail: 'The signal satisfies the common P0 semantics and uses reserved admission capacity.',
      })
    } else {
      reasons.push({ code: 'priority_semantics', detail: `The signal satisfies common ${priorityClass} semantics.` })
    }

    let outcome: TriageOutcome = selectRulesDepth(input, priorityClass)
    let classifierUsed = false
    if (input.ambiguity.isAmbiguous && this.classifier) {
      const classifierInput = boundedClassifierInput(input)
      const result = validateBoundedClassifierResult(await this.classifier.classify(classifierInput))
      outcome = result.suggestedOutcome
      priorityScore = clamp(priorityScore + result.scoreAdjustment)
      classifierUsed = true
      reasons.push({
        code: 'ambiguous_classifier',
        detail: `${result.reason}: ${result.explanation}`,
      })
    }

    let deepReason = input.deepEscalation?.reason ?? null
    if (deepReason) {
      const policyEligible = priorityClass !== 'P3'
        && this.policy.allowedDeepReasons.includes(deepReason)
        && input.providerHealth !== 'unavailable'
        && input.providerHealth !== 'circuit_open'
      const deepCapacityAvailable = input.capacity.byDepth.deep.available > 0
        && input.capacity.byDepth.deep.utilization < this.policy.deepAdmissionMaxUtilization
      if (policyEligible && deepCapacityAvailable) {
        outcome = 'deep'
        reasons.push({ code: 'typed_deep_escalation', detail: `${deepReason}: ${input.deepEscalation!.policyRule}` })
      } else if (policyEligible && !deepCapacityAvailable) {
        outcome = outcome === 'defer' ? 'defer' : 'standard'
        deepReason = null
        reasons.push({ code: 'deep_capacity_tightened', detail: 'Deep admission tightened before light/standard capacity.' })
      } else {
        outcome = outcome === 'defer' ? 'defer' : outcome === 'light' ? 'light' : 'standard'
        deepReason = null
        reasons.push({ code: 'deep_ineligible', detail: 'Typed escalation was declined by deterministic deep-admission policy.' })
      }
    }

    if (outcome === 'deep' && (
      input.capacity.byDepth.deep.available <= 0
      || input.capacity.byDepth.deep.utilization >= this.policy.deepAdmissionMaxUtilization
    )) {
      outcome = 'standard'
      deepReason = null
      reasons.push({ code: 'deep_capacity_tightened', detail: 'Deep admission tightened before light/standard capacity.' })
    }

    if (priorityClass !== 'P0'
      && (input.providerHealth === 'unavailable' || input.providerHealth === 'circuit_open')) {
      outcome = 'defer'
      deepReason = null
      reasons.push({ code: 'provider_pressure_defer', detail: `Provider workload is ${input.providerHealth}; lower-priority work remains observable and deferred.` })
    } else if (priorityClass !== 'P0' && (
      input.capacity.byPriority[priorityClass].available <= 0
      || input.capacity.byPriority[priorityClass].utilization >= this.policy.lowerPriorityDeferUtilization
      || (isResearchOutcome(outcome) && input.capacity.byDepth[outcome].available <= 0)
    )) {
      outcome = 'defer'
      deepReason = null
      reasons.push({ code: 'capacity_pressure_defer', detail: 'Current class/depth capacity defers lower-priority admission.' })
    }

    if (reasons.length === 1 && reasons[0]?.code === 'priority_semantics') {
      reasons.push({ code: 'rules_default', detail: `Rules selected ${outcome} research.` })
    }
    return decision(signal, input, this.policy, {
      outcome, priorityClass, priorityScore, freshnessDeadline,
      classifierUsed, deepReason, reasons,
    })
  }
}

export function createPriorityPolicyV1(input: {
  policyVersion: string
  budgetPolicyVersion: string
}): PriorityPolicyV1 {
  const budget = (overrides: Partial<ResearchBudget>): ResearchBudget => ({
    maxProviderCalls: 1,
    maxRepairCalls: 1,
    maxInputTokens: 15_000,
    maxOutputTokens: 3_000,
    maxToolCalls: 0,
    maxWallTimeMs: 90_000,
    ...overrides,
  })
  return validatePriorityPolicy({
    schemaVersion: PRIORITY_POLICY_SCHEMA_VERSION,
    policyVersion: input.policyVersion,
    budgetPolicyVersion: input.budgetPolicyVersion,
    classes: {
      P0: { meaning: COMMON_PRIORITY_SEMANTICS.P0, freshnessMs: 15 * 60_000 },
      P1: { meaning: COMMON_PRIORITY_SEMANTICS.P1, freshnessMs: 2 * 60 * 60_000 },
      P2: { meaning: COMMON_PRIORITY_SEMANTICS.P2, freshnessMs: 12 * 60 * 60_000 },
      P3: { meaning: COMMON_PRIORITY_SEMANTICS.P3, freshnessMs: 24 * 60 * 60_000 },
    },
    budgets: {
      light: budget({ maxInputTokens: 8_000, maxOutputTokens: 1_500, maxWallTimeMs: 90_000 }),
      standard: budget({ maxWallTimeMs: 120_000 }),
      deep: budget({ maxProviderCalls: 2, maxInputTokens: 30_000, maxOutputTokens: 5_000, maxToolCalls: 8, maxWallTimeMs: 10 * 60_000 }),
    },
    p0DeadlineWindowMs: 30 * 60_000,
    p1DeadlineWindowMs: 24 * 60 * 60_000,
    authoritativeScoreThreshold: 0.8,
    deepAdmissionMaxUtilization: 0.7,
    lowerPriorityDeferUtilization: 0.9,
    allowedDeepReasons: [
      'conflicting_primary_sources', 'insufficient_primary_evidence',
      'rendering_required_for_material_fact', 'entity_identity_ambiguous',
      'regulatory_interpretation_required', 'manual_analyst_request',
    ],
  })
}

export function createResearchWorkItemFromDecision(input: {
  signal: Signal
  decision: TriageDecisionV1
  retrievalPolicy: ResearchWorkCreationPolicy
}): ResearchWorkItem {
  const signal = validateSignal(input.signal)
  const triage = validateTriageDecision(input.decision)
  if (triage.signalId !== signal.signalId || triage.sourceType !== signal.sourceType) {
    throw new Error('Triage decision does not belong to the supplied signal')
  }
  if (!isResearchOutcome(triage.outcome) || !triage.budget) {
    throw new Error(`Triage outcome ${triage.outcome} does not admit research work`)
  }
  const workId = stableContractId(
    'work', signal.signalId, triage.priorityPolicyVersion,
    triage.budgetPolicyVersion, triage.outcome,
    triage.deepEscalation ? canonicalJson(triage.deepEscalation) : '',
  )
  const traceId = stableContractId('trace', workId, triage.decisionId)
  return validateResearchWorkItem({
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION,
    workId,
    signalId: signal.signalId,
    sourceType: signal.sourceType,
    researchDepth: triage.outcome,
    deepReason: triage.deepEscalationReason,
    deepEscalation: triage.deepEscalation ? structuredClone(triage.deepEscalation) : null,
    priorityClass: triage.priorityClass,
    priorityScore: triage.priorityScore,
    freshnessDeadline: triage.freshnessDeadline,
    policyVersion: triage.priorityPolicyVersion,
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: {
      sourceUrl: signal.canonicalUrl,
      allowedDomains: [...input.retrievalPolicy.allowedDomains],
      maxExternalSources: input.retrievalPolicy.maxExternalSourcesByDepth[triage.outcome],
      policyVersion: input.retrievalPolicy.policyVersion,
    },
    budget: { ...triage.budget },
    status: 'research_pending',
    attemptCount: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseId: null,
    leaseExpiresAt: null,
    failureCategory: null,
    failureDetail: null,
    traceId,
    createdAt: triage.decidedAt,
    updatedAt: triage.decidedAt,
    triageDecisionId: triage.decisionId,
    budgetPolicyVersion: triage.budgetPolicyVersion,
  })
}

function selectPriority(
  input: RulesFirstTriageInput,
  policy: PriorityPolicyV1,
  nowMs: number,
  deadlineMs: number | null,
): PriorityClass {
  const nearDeadline = deadlineMs !== null && deadlineMs >= nowMs
    && deadlineMs - nowMs <= policy.p0DeadlineWindowMs
  if (input.materialityTags.some((tag) => IMMEDIATE_TAGS.has(tag))
    || (input.officialSource && nearDeadline && input.materialityTags.includes('official_release'))) return 'P0'
  const authoritative = input.officialSource || input.sourceAuthorityScore >= policy.authoritativeScoreThreshold
  const sameDay = deadlineMs !== null && deadlineMs >= nowMs
    && deadlineMs - nowMs <= policy.p1DeadlineWindowMs
  if (authoritative && input.materialityTags.some((tag) => MATERIAL_TAGS.has(tag))
    && (sameDay || input.materialityTags.includes('market_material') || input.materialityTags.includes('regulatory'))) return 'P1'
  if (input.novelty !== 'none' || input.materialityTags.some((tag) => MATERIAL_TAGS.has(tag))) return 'P2'
  return 'P3'
}

function selectPriorityScore(input: RulesFirstTriageInput, priority: PriorityClass): number {
  const base = { P0: 0.94, P1: 0.76, P2: 0.5, P3: 0.2 }[priority]
  return clamp(base
    + input.sourceAuthorityScore * 0.04
    + (input.officialSource ? 0.02 : 0)
    + (input.novelty === 'novel_entity' ? 0.04 : input.novelty === 'material' ? 0.02 : 0)
    + (input.dedupeOutcome === 'material_change' ? 0.02 : 0))
}

function selectRulesDepth(input: RulesFirstTriageInput, priority: PriorityClass): TriageOutcome {
  if (priority === 'P0' || priority === 'P1'
    || input.materialityTags.some((tag) => MATERIAL_TAGS.has(tag))
    || input.dedupeOutcome === 'material_change') return 'standard'
  return 'light'
}

function selectFreshnessDeadline(
  now: string,
  eventDeadline: string | null,
  policy: PriorityPolicyV1,
  priority: PriorityClass,
): string {
  const policyDeadline = Date.parse(now) + policy.classes[priority].freshnessMs
  const eventMs = eventDeadline ? Date.parse(eventDeadline) : null
  return new Date(eventMs !== null && eventMs > Date.parse(now)
    ? Math.min(policyDeadline, eventMs) : policyDeadline).toISOString()
}

function decision(
  signal: Signal,
  input: RulesFirstTriageInput,
  policy: PriorityPolicyV1,
  values: {
    outcome: TriageOutcome
    priorityClass: PriorityClass
    priorityScore: number
    freshnessDeadline: string
    classifierUsed: boolean
    deepReason: DeepEscalationReason | null
    reasons: TriageDecisionReason[]
  },
): TriageDecisionV1 {
  const decisionId = stableContractId(
    'triage', signal.signalId, policy.policyVersion, policy.budgetPolicyVersion,
    input.now, input.dedupeOutcome, values.outcome, values.priorityClass,
    values.outcome === 'deep' && input.deepEscalation
      ? JSON.stringify({
        reason: input.deepEscalation.reason,
        evidenceRefs: [...input.deepEscalation.evidenceRefs].sort(),
        unresolvedQuestion: input.deepEscalation.unresolvedQuestion,
        policyRule: input.deepEscalation.policyRule,
      }) : '',
  )
  const deepEscalation: DeepEscalationAdmission | null = values.outcome === 'deep'
    && values.deepReason !== null && input.deepEscalation !== null
    ? {
      reason: values.deepReason,
      supportingEvidenceRefs: [...new Set(input.deepEscalation.evidenceRefs)].sort(),
      unresolvedQuestion: input.deepEscalation.unresolvedQuestion,
      policyVersion: policy.policyVersion,
      policyRule: input.deepEscalation.policyRule,
    }
    : null
  return validateTriageDecision({
    schemaVersion: TRIAGE_DECISION_SCHEMA_VERSION,
    decisionId,
    signalId: signal.signalId,
    sourceType: signal.sourceType,
    outcome: values.outcome,
    priorityClass: values.priorityClass,
    priorityScore: values.priorityScore,
    reasons: values.reasons,
    freshnessDeadline: values.freshnessDeadline,
    budgetPolicyVersion: policy.budgetPolicyVersion,
    budget: isResearchOutcome(values.outcome) ? { ...policy.budgets[values.outcome] } : null,
    deepEscalationReason: values.outcome === 'deep' ? values.deepReason : null,
    deepEscalation,
    priorityPolicyVersion: policy.policyVersion,
    classifierUsed: values.classifierUsed,
    decidedAt: input.now,
  })
}

function boundedClassifierInput(input: RulesFirstTriageInput): Readonly<BoundedTriageClassifierInput> {
  return Object.freeze({
    signalId: input.signal.signalId,
    sourceType: input.signal.sourceType,
    contentKind: input.signal.contentKind,
    title: input.signal.title.slice(0, 512),
    visibleSummary: input.signal.visibleSummary?.slice(0, 1000) ?? null,
    officialSource: input.officialSource,
    sourceAuthorityScore: input.sourceAuthorityScore,
    novelty: input.novelty,
    materialityTags: Object.freeze([...input.materialityTags]) as unknown as MaterialityTag[],
    ambiguityReasons: Object.freeze(input.ambiguity.reasons.map((reason) => reason.slice(0, 200))) as unknown as string[],
  })
}

function validateInput(input: RulesFirstTriageInput): void {
  if (!Number.isFinite(Date.parse(input.now))) throw new Error('now must be a timestamp')
  if (input.eventDeadline && !Number.isFinite(Date.parse(input.eventDeadline))) throw new Error('eventDeadline must be a timestamp')
  if (!Number.isFinite(input.sourceAuthorityScore) || input.sourceAuthorityScore < 0 || input.sourceAuthorityScore > 1) {
    throw new Error('sourceAuthorityScore must be between 0 and 1')
  }
  for (const bucket of [
    ...Object.values(input.capacity.byPriority),
    ...Object.values(input.capacity.byDepth),
  ]) {
    if (!Number.isInteger(bucket.available) || bucket.available < 0
      || !Number.isInteger(bucket.reservedAvailable) || bucket.reservedAvailable < 0
      || !Number.isFinite(bucket.utilization) || bucket.utilization < 0 || bucket.utilization > 1) {
      throw new Error('capacity buckets must be bounded non-negative values')
    }
  }
  if (input.deepEscalation && (
    !input.deepEscalation.unresolvedQuestion.trim()
    || !input.deepEscalation.policyRule.trim()
    || input.deepEscalation.evidenceRefs.length === 0
    || input.deepEscalation.evidenceRefs.some((ref) => !ref.trim())
  )) throw new Error('deep escalation requires supporting evidence, a question, and a policy rule')
}

function isResearchOutcome(outcome: TriageOutcome): outcome is ResearchDepth {
  return outcome === 'light' || outcome === 'standard' || outcome === 'deep'
}

function hasAny(tags: MaterialityTag[], wanted: MaterialityTag[]): boolean {
  return tags.some((tag) => wanted.includes(tag))
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))))
}

export const __triageTesting = {
  TRIAGE_CLASSIFIER_RESULT_SCHEMA_VERSION,
  selectFreshnessDeadline,
}
