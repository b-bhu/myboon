export const V4_EVALUATION_SCHEMA_VERSION = 'myboon.entity_manager_v4_evaluation.v1' as const

export type V4OutcomeStatus = 'completed' | 'failed' | 'incomplete'
export type V4ExecutionLane = 'production' | 'shadow'

/** Immutable measurements supplied by an offline evaluator; no payload fields are accepted. */
export interface V4EvaluationCaseV1 {
  readonly caseId: string
  readonly lane: V4ExecutionLane
  readonly outcome: V4OutcomeStatus
  readonly inputCorrect: boolean
  readonly usefulAcceptedItems: number
  readonly falseDiscard: boolean
  readonly providerCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly fallbackCalls: number
  readonly repairs: number
  readonly repeatedInferenceOnRetry: number
  readonly durationMs: number
  /** Integer USD micros; null means unavailable, not zero. */
  readonly costUsdMicros: number | null
}

export interface V4LaneMetricsV1 {
  readonly caseCount: number
  readonly completedCount: number
  readonly failedCount: number
  readonly incompleteCount: number
  readonly inputCorrectCount: number
  readonly falseDiscardCount: number
  readonly usefulAcceptedItems: number
  readonly providerCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly fallbackCalls: number
  readonly repairs: number
  readonly repeatedInferenceOnRetry: number
  readonly medianDurationMs: number | null
  readonly tailDurationMs: number | null
  readonly observedCostUsdMicros: number | null
  readonly costPerCorrectInputUsdMicros: number | null
  readonly costPerUsefulAcceptedItemUsdMicros: number | null
  readonly costCoverageCaseCount: number
  /** Observed cost for covered cases only; null when no case has cost coverage. */
  readonly coveredCostUsdMicros: number | null
}

export interface V4PairedBaselineCoverageV1 {
  readonly pairedCaseCount: number
  readonly productionOnlyCaseCount: number
  readonly shadowOnlyCaseCount: number
}


export interface V4EvaluationReportV1 {
  readonly schemaVersion: typeof V4_EVALUATION_SCHEMA_VERSION
  readonly totalCases: number
  readonly production: V4LaneMetricsV1
  readonly shadow: V4LaneMetricsV1
  readonly pairedBaselineCoverage: V4PairedBaselineCoverageV1
}

export class V4EvaluationInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'V4EvaluationInputError'
  }
}

/** Build a deterministic, payload-free report from frozen direct/shadow outcomes. */
export function buildV4EvaluationReport(cases: readonly V4EvaluationCaseV1[]): V4EvaluationReportV1 {
  if (!Array.isArray(cases)) throw new V4EvaluationInputError('cases must be an array')
  const ids = new Set<string>()
  const caseLanes = new Map<string, Set<V4ExecutionLane>>()
  for (const [index, candidate] of cases.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new V4EvaluationInputError(`cases[${index}] must be an object`)
    }
    const row = candidate as V4EvaluationCaseV1
    const keys = ['caseId', 'lane', 'outcome', 'inputCorrect', 'usefulAcceptedItems', 'falseDiscard', 'providerCalls',
      'inputTokens', 'outputTokens', 'fallbackCalls', 'repairs', 'repeatedInferenceOnRetry', 'durationMs', 'costUsdMicros']
    const actual = Object.keys(row).sort()
    if (actual.length !== keys.length || actual.some((key, i) => key !== [...keys].sort()[i])) {
      throw new V4EvaluationInputError(`cases[${index}] must contain only the documented metric fields`)
    }
    if (typeof row.caseId !== 'string' || row.caseId.trim() === '') throw new V4EvaluationInputError(`cases[${index}].caseId must be non-empty`)
    const identity = `${row.lane}:${row.caseId}`
    if (ids.has(identity)) throw new V4EvaluationInputError(`duplicate caseId in lane: ${row.caseId}`)
    ids.add(identity)
    const lanes = caseLanes.get(row.caseId) ?? new Set<V4ExecutionLane>()
    lanes.add(row.lane)
    caseLanes.set(row.caseId, lanes)
    if (row.lane !== 'production' && row.lane !== 'shadow') throw new V4EvaluationInputError(`cases[${index}].lane is invalid`)
    if (!['completed', 'failed', 'incomplete'].includes(row.outcome)) throw new V4EvaluationInputError(`cases[${index}].outcome is invalid`)
    for (const key of ['inputCorrect', 'falseDiscard'] as const) {
      if (typeof row[key] !== 'boolean') throw new V4EvaluationInputError(`cases[${index}].${key} must be boolean`)
    }
    for (const key of ['usefulAcceptedItems', 'providerCalls', 'inputTokens', 'outputTokens', 'fallbackCalls', 'repairs', 'repeatedInferenceOnRetry', 'durationMs'] as const) {
      if (!Number.isSafeInteger(row[key]) || row[key] < 0) throw new V4EvaluationInputError(`cases[${index}].${key} must be a non-negative safe integer`)
    }
    if (row.costUsdMicros !== null && (!Number.isSafeInteger(row.costUsdMicros) || row.costUsdMicros < 0)) {
      throw new V4EvaluationInputError(`cases[${index}].costUsdMicros must be null or a non-negative safe integer`)
    }
    if (row.outcome !== 'completed' && (row.inputCorrect || row.usefulAcceptedItems > 0)) {
      throw new V4EvaluationInputError(`cases[${index}] failed or incomplete outcome cannot claim correct or useful accepted items`)
    }
    if (row.falseDiscard && (row.inputCorrect || row.usefulAcceptedItems > 0)) {
      throw new V4EvaluationInputError(`cases[${index}] false discard cannot be correct or useful`)
    }
  }
  return {
    schemaVersion: V4_EVALUATION_SCHEMA_VERSION,
    totalCases: cases.length,
    production: metrics(cases.filter(row => row.lane === 'production')),
    shadow: metrics(cases.filter(row => row.lane === 'shadow')),
    pairedBaselineCoverage: {
      pairedCaseCount: [...caseLanes.values()].filter(lanes => lanes.has('production') && lanes.has('shadow')).length,
      productionOnlyCaseCount: [...caseLanes.values()].filter(lanes => lanes.has('production') && !lanes.has('shadow')).length,
      shadowOnlyCaseCount: [...caseLanes.values()].filter(lanes => lanes.has('shadow') && !lanes.has('production')).length,
    },
  }
}

function metrics(rows: readonly V4EvaluationCaseV1[]): V4LaneMetricsV1 {
  const durations = rows.map(row => row.durationMs).sort((a, b) => a - b)
  const costs = rows.filter((row): row is V4EvaluationCaseV1 & { costUsdMicros: number } => row.costUsdMicros !== null)
  const cost = costs.reduce((sum, row) => sum + row.costUsdMicros, 0)
  if (!Number.isSafeInteger(cost)) throw new V4EvaluationInputError('aggregate costUsdMicros exceeds safe integer range')
  const correct = rows.filter(row => row.inputCorrect).length
  const useful = rows.reduce((sum, row) => sum + row.usefulAcceptedItems, 0)
  const costAvailable = costs.length === rows.length
  return {
    caseCount: rows.length,
    completedCount: rows.filter(row => row.outcome === 'completed').length,
    failedCount: rows.filter(row => row.outcome === 'failed').length,
    incompleteCount: rows.filter(row => row.outcome === 'incomplete').length,
    inputCorrectCount: correct,
    falseDiscardCount: rows.filter(row => row.falseDiscard).length,
    usefulAcceptedItems: useful,
    providerCalls: sum(rows, 'providerCalls'), inputTokens: sum(rows, 'inputTokens'), outputTokens: sum(rows, 'outputTokens'),
    fallbackCalls: sum(rows, 'fallbackCalls'), repairs: sum(rows, 'repairs'),
    repeatedInferenceOnRetry: sum(rows, 'repeatedInferenceOnRetry'),
    medianDurationMs: median(durations), tailDurationMs: percentileNearestRank(durations, 0.95),
    observedCostUsdMicros: rows.length > 0 && costAvailable ? cost : null,
    coveredCostUsdMicros: costs.length ? cost : null,
    costPerCorrectInputUsdMicros: costAvailable && correct > 0 ? cost / correct : null,
    costPerUsefulAcceptedItemUsdMicros: costAvailable && useful > 0 ? cost / useful : null,
    costCoverageCaseCount: costs.length,
  }
}

function sum(rows: readonly V4EvaluationCaseV1[], key: 'providerCalls' | 'inputTokens' | 'outputTokens' | 'fallbackCalls' | 'repairs' | 'repeatedInferenceOnRetry'): number {
  const total = rows.reduce((n, row) => n + row[key], 0)
  if (!Number.isSafeInteger(total)) throw new V4EvaluationInputError(`aggregate ${key} exceeds safe integer range`)
  return total
}

function percentileNearestRank(sorted: readonly number[], percentile: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.ceil(percentile * sorted.length) - 1]
}

function median(sorted: readonly number[]): number | null {
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
