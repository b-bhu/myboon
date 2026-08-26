import type { DeepEscalationReason, PriorityClass, ResearchBudget, ResearchDepth } from './contracts'
import {
  COMMON_PRIORITY_SEMANTICS,
  PRIORITY_POLICY_SCHEMA_VERSION,
  TRIAGE_CLASSIFIER_RESULT_SCHEMA_VERSION,
  TRIAGE_DECISION_SCHEMA_VERSION,
  type BoundedTriageClassifierResult,
  type PriorityPolicyV1,
  type TriageDecisionV1,
} from './triage-contracts'
import { ContractValidationError } from './validation'

const PRIORITIES: PriorityClass[] = ['P0', 'P1', 'P2', 'P3']
const DEPTHS: ResearchDepth[] = ['light', 'standard', 'deep']
const DEEP_REASONS: DeepEscalationReason[] = [
  'conflicting_primary_sources', 'insufficient_primary_evidence',
  'rendering_required_for_material_fact', 'entity_identity_ambiguous',
  'regulatory_interpretation_required', 'manual_analyst_request',
]
const DECISION_REASON_CODES = [
  'exact_duplicate', 'stale_low_value', 'material_change', 'novel_entity_preserved',
  'official_urgent_reserved_path', 'priority_semantics', 'provider_pressure_defer',
  'capacity_pressure_defer', 'deep_capacity_tightened', 'deep_ineligible',
  'typed_deep_escalation', 'ambiguous_classifier', 'rules_default',
] as const

export function validatePriorityPolicy(value: unknown): PriorityPolicyV1 {
  const policy = record(value, 'priorityPolicy')
  exact(policy.schemaVersion, PRIORITY_POLICY_SCHEMA_VERSION, 'priorityPolicy.schemaVersion')
  nonEmpty(policy.policyVersion, 'priorityPolicy.policyVersion')
  nonEmpty(policy.budgetPolicyVersion, 'priorityPolicy.budgetPolicyVersion')
  const classes = record(policy.classes, 'priorityPolicy.classes')
  for (const priority of PRIORITIES) {
    const item = record(classes[priority], `priorityPolicy.classes.${priority}`)
    exact(item.meaning, COMMON_PRIORITY_SEMANTICS[priority], `priorityPolicy.classes.${priority}.meaning`)
    positiveInteger(item.freshnessMs, `priorityPolicy.classes.${priority}.freshnessMs`)
  }
  const budgets = record(policy.budgets, 'priorityPolicy.budgets')
  for (const depth of DEPTHS) validateBudget(budgets[depth], `priorityPolicy.budgets.${depth}`)
  positiveInteger(policy.p0DeadlineWindowMs, 'priorityPolicy.p0DeadlineWindowMs')
  positiveInteger(policy.p1DeadlineWindowMs, 'priorityPolicy.p1DeadlineWindowMs')
  unitNumber(policy.authoritativeScoreThreshold, 'priorityPolicy.authoritativeScoreThreshold')
  unitNumber(policy.deepAdmissionMaxUtilization, 'priorityPolicy.deepAdmissionMaxUtilization')
  unitNumber(policy.lowerPriorityDeferUtilization, 'priorityPolicy.lowerPriorityDeferUtilization')
  if (!Array.isArray(policy.allowedDeepReasons)
    || !policy.allowedDeepReasons.every((reason) => DEEP_REASONS.includes(reason as DeepEscalationReason))) {
    throw new ContractValidationError('priorityPolicy.allowedDeepReasons', 'must contain only typed deep reasons')
  }
  return value as PriorityPolicyV1
}

export function validateTriageDecision(value: unknown): TriageDecisionV1 {
  const decision = record(value, 'triageDecision')
  exact(decision.schemaVersion, TRIAGE_DECISION_SCHEMA_VERSION, 'triageDecision.schemaVersion')
  for (const field of ['decisionId', 'signalId', 'priorityPolicyVersion', 'budgetPolicyVersion'] as const) {
    nonEmpty(decision[field], `triageDecision.${field}`)
  }
  oneOf(decision.sourceType, ['news', 'polymarket', 'market_calendar', 'x'], 'triageDecision.sourceType')
  const outcome = oneOf(decision.outcome, ['archive', 'defer', 'light', 'standard', 'deep'], 'triageDecision.outcome')
  oneOf(decision.priorityClass, PRIORITIES, 'triageDecision.priorityClass')
  unitNumber(decision.priorityScore, 'triageDecision.priorityScore')
  timestamp(decision.freshnessDeadline, 'triageDecision.freshnessDeadline')
  timestamp(decision.decidedAt, 'triageDecision.decidedAt')
  if (!Array.isArray(decision.reasons) || decision.reasons.length === 0) {
    throw new ContractValidationError('triageDecision.reasons', 'must contain at least one decision reason')
  }
  for (const [index, item] of decision.reasons.entries()) {
    const reason = record(item, `triageDecision.reasons[${index}]`)
    oneOf(reason.code, DECISION_REASON_CODES, `triageDecision.reasons[${index}].code`)
    nonEmpty(reason.detail, `triageDecision.reasons[${index}].detail`)
  }
  if (decision.deepEscalationReason !== null
    && !DEEP_REASONS.includes(decision.deepEscalationReason as DeepEscalationReason)) {
    throw new ContractValidationError('triageDecision.deepEscalationReason', 'must be a typed deep reason or null')
  }
  if (outcome === 'deep' && decision.deepEscalationReason === null) {
    throw new ContractValidationError('triageDecision.deepEscalationReason', 'is required for deep')
  }
  if (outcome !== 'deep' && decision.deepEscalationReason !== null) {
    throw new ContractValidationError('triageDecision.deepEscalationReason', 'must be null unless outcome is deep')
  }
  if ((outcome === 'archive' || outcome === 'defer') && decision.budget !== null) {
    throw new ContractValidationError('triageDecision.budget', 'must be null without admission')
  }
  if (outcome !== 'archive' && outcome !== 'defer') validateBudget(decision.budget, 'triageDecision.budget')
  if (typeof decision.classifierUsed !== 'boolean') {
    throw new ContractValidationError('triageDecision.classifierUsed', 'must be boolean')
  }
  return value as TriageDecisionV1
}

export function validateBoundedClassifierResult(value: unknown): BoundedTriageClassifierResult {
  const result = record(value, 'classifierResult')
  const allowedKeys = new Set(['schemaVersion', 'suggestedOutcome', 'scoreAdjustment', 'reason', 'explanation'])
  if (Object.keys(result).some((key) => !allowedKeys.has(key))) {
    throw new ContractValidationError('classifierResult', 'contains unsupported fields')
  }
  exact(result.schemaVersion, TRIAGE_CLASSIFIER_RESULT_SCHEMA_VERSION, 'classifierResult.schemaVersion')
  oneOf(result.suggestedOutcome, ['defer', 'light', 'standard'], 'classifierResult.suggestedOutcome')
  if (typeof result.scoreAdjustment !== 'number' || !Number.isFinite(result.scoreAdjustment)
    || result.scoreAdjustment < -0.1 || result.scoreAdjustment > 0.1) {
    throw new ContractValidationError('classifierResult.scoreAdjustment', 'must be between -0.1 and 0.1')
  }
  oneOf(result.reason, ['low_materiality', 'useful_current_context', 'material_relevance', 'insufficient_rules'], 'classifierResult.reason')
  nonEmpty(result.explanation, 'classifierResult.explanation')
  if ((result.explanation as string).length > 240) {
    throw new ContractValidationError('classifierResult.explanation', 'must be at most 240 characters')
  }
  return value as BoundedTriageClassifierResult
}

function validateBudget(value: unknown, path: string): asserts value is ResearchBudget {
  const budget = record(value, path)
  for (const key of ['maxProviderCalls', 'maxRepairCalls', 'maxInputTokens', 'maxOutputTokens', 'maxToolCalls', 'maxWallTimeMs'] as const) {
    if (!Number.isInteger(budget[key]) || Number(budget[key]) < 0) {
      throw new ContractValidationError(`${path}.${key}`, 'must be a non-negative integer')
    }
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractValidationError(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

function exact(value: unknown, expected: string, path: string): void {
  if (value !== expected) throw new ContractValidationError(path, `must equal ${expected}`)
}

function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new ContractValidationError(path, 'must be non-empty')
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ContractValidationError(path, `must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function positiveInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new ContractValidationError(path, 'must be a positive integer')
}

function unitNumber(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ContractValidationError(path, 'must be between 0 and 1')
  }
}

function timestamp(value: unknown, path: string): void {
  nonEmpty(value, path)
  if (!Number.isFinite(Date.parse(value))) throw new ContractValidationError(path, 'must be a timestamp')
}
