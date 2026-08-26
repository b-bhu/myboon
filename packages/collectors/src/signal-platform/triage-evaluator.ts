import type { PriorityClass, ResearchDepth, Signal, TriageOutcome } from './contracts'
import type {
  RulesFirstTriageInput,
  TriageDecisionV1,
} from './triage-contracts'
import type { RulesFirstTriageEngine } from './triage-engine'
import { validateTriageDecision } from './triage-validation'
import { validateSignal } from './validation'

export interface TriageEvaluationLabel {
  productRelevant: boolean
  usefulEntityMemory: boolean
}

export interface TriageEvaluationCostObservation {
  latencyMs: number
  providerCalls: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
}

export interface TriageEvaluationRecord {
  recordId: string
  signal: Signal
  decision: TriageDecisionV1
  label: TriageEvaluationLabel
  observedCost?: TriageEvaluationCostObservation | null
  arrivalWeight?: number
}

export interface TriageShadowCase {
  recordId: string
  input: RulesFirstTriageInput
  label: TriageEvaluationLabel
  observedCost?: TriageEvaluationCostObservation | null
  arrivalWeight?: number
}

export interface OutcomeMetrics {
  count: number
  weightedCount: number
  rate: number
}

export interface OutcomeBreakdown {
  total: number
  admitted: number
  admissionRate: number
  outcomes: Record<TriageOutcome, OutcomeMetrics>
}

export interface TriageFalseNegative {
  recordId: string
  signalId: string
  sourceType: Signal['sourceType']
  outcome: Extract<TriageOutcome, 'archive' | 'defer'>
  usefulEntityMemory: boolean
}

export interface TriageEvaluationReport {
  totalRecords: number
  totalWeightedArrivals: number
  distribution: OutcomeBreakdown
  falseNegatives: TriageFalseNegative[]
  falseNegativeCount: number
  falseNegativeRate: number
  capacityProjection: {
    weightedAdmissionRate: number
    weightedAdmissions: number
    byDepth: Record<ResearchDepth, number>
    byPriority: Record<PriorityClass, number>
  }
  budgetProjection: {
    maxProviderCalls: number
    maxInputTokens: number
    maxOutputTokens: number
    maxToolCalls: number
    maxWallTimeMs: number
    averageMaxWallTimeMsPerAdmission: number
  }
  observedProjection: {
    sampleCount: number
    averageLatencyMs: number | null
    p50LatencyMs: number | null
    p95LatencyMs: number | null
    providerCalls: number
    inputTokens: number
    outputTokens: number
    toolCalls: number
  }
  perSource: Partial<Record<Signal['sourceType'], OutcomeBreakdown>>
  perPriority: Record<PriorityClass, OutcomeBreakdown>
}

export async function runTriageShadowEvaluation(
  engine: RulesFirstTriageEngine,
  cases: TriageShadowCase[],
): Promise<TriageEvaluationReport> {
  const records: TriageEvaluationRecord[] = []
  for (const item of cases) {
    records.push({
      recordId: item.recordId,
      signal: item.input.signal,
      decision: await engine.decide(item.input),
      label: item.label,
      observedCost: item.observedCost,
      arrivalWeight: item.arrivalWeight,
    })
  }
  return evaluateTriageRecords(records)
}

/** Reports replay/shadow measurements; it intentionally declares no target mix or pass threshold. */
export function evaluateTriageRecords(records: TriageEvaluationRecord[]): TriageEvaluationReport {
  const recordIds = new Set<string>()
  const normalized = records.map((record) => ({
    ...record,
    recordId: validateRecordId(record.recordId, recordIds),
    signal: validateSignal(record.signal),
    decision: validateTriageDecision(record.decision),
    label: validateLabel(record.label),
    observedCost: validateObservedCost(record.observedCost),
    weight: validateWeight(record.arrivalWeight),
  }))
  for (const record of normalized) {
    if (record.signal.signalId !== record.decision.signalId
      || record.signal.sourceType !== record.decision.sourceType) {
      throw new Error(`Evaluation record ${record.recordId} has mismatched signal and decision identity`)
    }
    if (record.observedCost && !isDepth(record.decision.outcome)) {
      throw new Error(`Evaluation record ${record.recordId} meters a non-admitted decision`)
    }
  }
  const totalWeight = sum(normalized.map((record) => record.weight))
  const distribution = breakdown(normalized)
  const falseNegatives = normalized.flatMap((record): TriageFalseNegative[] => {
    if (!record.label.productRelevant
      || (record.decision.outcome !== 'archive' && record.decision.outcome !== 'defer')) return []
    return [{
      recordId: record.recordId,
      signalId: record.signal.signalId,
      sourceType: record.signal.sourceType,
      outcome: record.decision.outcome,
      usefulEntityMemory: record.label.usefulEntityMemory,
    }]
  })
  const relevantCount = normalized.filter((record) => record.label.productRelevant).length
  const admitted = normalized.filter((record) => isDepth(record.decision.outcome))
  const observed = normalized.flatMap((record) => record.observedCost ? [record.observedCost] : [])
  const latencies = observed.map((item) => item.latencyMs).sort((a, b) => a - b)
  const sources = new Set(normalized.map((record) => record.signal.sourceType))
  const perSource: TriageEvaluationReport['perSource'] = {}
  for (const source of sources) perSource[source] = breakdown(normalized.filter((record) => record.signal.sourceType === source))
  const perPriority = Object.fromEntries(
    (['P0', 'P1', 'P2', 'P3'] as PriorityClass[]).map((priority) => [
      priority,
      breakdown(normalized.filter((record) => record.decision.priorityClass === priority)),
    ]),
  ) as Record<PriorityClass, OutcomeBreakdown>
  const weightedAdmissions = sum(admitted.map((record) => record.weight))
  return {
    totalRecords: normalized.length,
    totalWeightedArrivals: totalWeight,
    distribution,
    falseNegatives,
    falseNegativeCount: falseNegatives.length,
    falseNegativeRate: relevantCount === 0 ? 0 : falseNegatives.length / relevantCount,
    capacityProjection: {
      weightedAdmissionRate: totalWeight === 0 ? 0 : weightedAdmissions / totalWeight,
      weightedAdmissions,
      byDepth: countWeightedDepth(admitted),
      byPriority: countWeightedPriority(admitted),
    },
    budgetProjection: {
      maxProviderCalls: sum(admitted.map((record) => (record.decision.budget?.maxProviderCalls ?? 0) * record.weight)),
      maxInputTokens: sum(admitted.map((record) => (record.decision.budget?.maxInputTokens ?? 0) * record.weight)),
      maxOutputTokens: sum(admitted.map((record) => (record.decision.budget?.maxOutputTokens ?? 0) * record.weight)),
      maxToolCalls: sum(admitted.map((record) => (record.decision.budget?.maxToolCalls ?? 0) * record.weight)),
      maxWallTimeMs: sum(admitted.map((record) => (record.decision.budget?.maxWallTimeMs ?? 0) * record.weight)),
      averageMaxWallTimeMsPerAdmission: weightedAdmissions === 0 ? 0
        : sum(admitted.map((record) => (record.decision.budget?.maxWallTimeMs ?? 0) * record.weight)) / weightedAdmissions,
    },
    observedProjection: {
      sampleCount: observed.length,
      averageLatencyMs: observed.length === 0 ? null : sum(latencies) / observed.length,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      providerCalls: sum(observed.map((item) => item.providerCalls)),
      inputTokens: sum(observed.map((item) => item.inputTokens)),
      outputTokens: sum(observed.map((item) => item.outputTokens)),
      toolCalls: sum(observed.map((item) => item.toolCalls)),
    },
    perSource,
    perPriority,
  }
}

type Normalized = TriageEvaluationRecord & { decision: TriageDecisionV1; weight: number }

function breakdown(records: Normalized[]): OutcomeBreakdown {
  const weightedTotal = sum(records.map((record) => record.weight))
  const outcomes = Object.fromEntries(
    (['archive', 'defer', 'light', 'standard', 'deep'] as TriageOutcome[]).map((outcome) => {
      const matching = records.filter((record) => record.decision.outcome === outcome)
      const weightedCount = sum(matching.map((record) => record.weight))
      return [outcome, {
        count: matching.length,
        weightedCount,
        rate: weightedTotal === 0 ? 0 : weightedCount / weightedTotal,
      }]
    }),
  ) as Record<TriageOutcome, OutcomeMetrics>
  const admitted = records.filter((record) => isDepth(record.decision.outcome)).length
  return {
    total: records.length,
    admitted,
    admissionRate: records.length === 0 ? 0 : admitted / records.length,
    outcomes,
  }
}

function countWeightedDepth(records: Normalized[]): Record<ResearchDepth, number> {
  return Object.fromEntries((['light', 'standard', 'deep'] as ResearchDepth[]).map((depth) => [
    depth, sum(records.filter((record) => record.decision.outcome === depth).map((record) => record.weight)),
  ])) as Record<ResearchDepth, number>
}

function countWeightedPriority(records: Normalized[]): Record<PriorityClass, number> {
  return Object.fromEntries((['P0', 'P1', 'P2', 'P3'] as PriorityClass[]).map((priority) => [
    priority, sum(records.filter((record) => record.decision.priorityClass === priority).map((record) => record.weight)),
  ])) as Record<PriorityClass, number>
}

function isDepth(outcome: TriageOutcome): outcome is ResearchDepth {
  return outcome === 'light' || outcome === 'standard' || outcome === 'deep'
}

function validateWeight(value: number | undefined): number {
  const weight = value ?? 1
  if (!Number.isFinite(weight) || weight <= 0) throw new Error('arrivalWeight must be positive')
  return weight
}

function validateRecordId(value: string, seen: Set<string>): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('recordId must be non-empty')
  const result = value.trim()
  if (seen.has(result)) throw new Error(`Duplicate evaluation recordId: ${result}`)
  seen.add(result)
  return result
}

function validateLabel(value: TriageEvaluationLabel): TriageEvaluationLabel {
  if (value === null || typeof value !== 'object'
    || typeof value.productRelevant !== 'boolean' || typeof value.usefulEntityMemory !== 'boolean') {
    throw new Error('Evaluation label must contain boolean productRelevant and usefulEntityMemory')
  }
  return { productRelevant: value.productRelevant, usefulEntityMemory: value.usefulEntityMemory }
}

function validateObservedCost(
  value: TriageEvaluationCostObservation | null | undefined,
): TriageEvaluationCostObservation | null | undefined {
  if (value === null || value === undefined) return value
  const fields = ['latencyMs', 'providerCalls', 'inputTokens', 'outputTokens', 'toolCalls'] as const
  for (const field of fields) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new Error(`observedCost.${field} must be a non-negative integer`)
    }
  }
  return { ...value }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function percentile(sorted: number[], value: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.ceil(sorted.length * value) - 1] ?? null
}
