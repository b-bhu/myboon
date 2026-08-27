import { createHash } from 'node:crypto'
import type { Signal } from './contracts'
import type { TriageEvaluationRecord, TriageEvaluationReport } from './triage-evaluator'
import { evaluateTriageRecords } from './triage-evaluator'

export const TRIAGE_EVALUATION_ARTIFACT_VERSION = 'myboon.feed_v3_triage_evaluation.v1' as const

export interface TriageEvaluationThresholds {
  minimumRecords: number
  minimumObservedCompletionRate: number
  maxFalseNegativeRate: number
  maxProviderCallsPerObservedCompletion: number
  maxInputTokensPerObservedCompletion: number
  maxOutputTokensPerObservedCompletion: number
  maxP95LatencyMs: number
  minimumBlindReviewRate: number
  minimumBlindAcceptanceRate: number
  minimumBlindProductQualityScore: number
  minimumBlindEvidenceQualityScore: number
  minimumBlindAttributionQualityScore: number
}

export interface TriageEvaluationArtifact {
  schemaVersion: typeof TRIAGE_EVALUATION_ARTIFACT_VERSION
  sourceType: Signal['sourceType'] | 'mixed'
  stage: 'research'
  sampleSize: number
  inputSha256: string
  evaluatedAt: string
  thresholds: TriageEvaluationThresholds
  passed: boolean
  failures: string[]
  report: TriageEvaluationReport
}

export interface TriageEvaluationCommand {
  inputPath: string
  thresholds: TriageEvaluationThresholds
}

export function parseTriageEvaluationArgs(argv: string[]): TriageEvaluationCommand {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Expected --flag value near ${flag ?? '<end>'}`)
    }
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`)
    values.set(flag, value)
  }
  const allowed = new Set([
    '--input', '--minimum-records', '--max-false-negative-rate',
    '--min-metered-completion-rate',
    '--max-provider-calls-per-completion', '--max-input-tokens-per-completion',
    '--max-output-tokens-per-completion', '--max-p95-latency-ms',
    '--min-blind-review-rate', '--min-blind-acceptance-rate',
    '--min-blind-product-quality', '--min-blind-evidence-quality', '--min-blind-attribution-quality',
  ])
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`Unknown argument: ${flag}`)
  const inputPath = required(values, '--input')
  return {
    inputPath,
    thresholds: {
      minimumRecords: positiveInteger(values.get('--minimum-records') ?? '1000', '--minimum-records'),
      minimumObservedCompletionRate: unitNumber(
        required(values, '--min-metered-completion-rate'), '--min-metered-completion-rate',
      ),
      maxFalseNegativeRate: unitNumber(required(values, '--max-false-negative-rate'), '--max-false-negative-rate'),
      maxProviderCallsPerObservedCompletion: nonNegativeNumber(
        required(values, '--max-provider-calls-per-completion'), '--max-provider-calls-per-completion',
      ),
      maxInputTokensPerObservedCompletion: nonNegativeNumber(
        required(values, '--max-input-tokens-per-completion'), '--max-input-tokens-per-completion',
      ),
      maxOutputTokensPerObservedCompletion: nonNegativeNumber(
        required(values, '--max-output-tokens-per-completion'), '--max-output-tokens-per-completion',
      ),
      maxP95LatencyMs: positiveInteger(required(values, '--max-p95-latency-ms'), '--max-p95-latency-ms'),
      minimumBlindReviewRate: unitNumber(required(values, '--min-blind-review-rate'), '--min-blind-review-rate'),
      minimumBlindAcceptanceRate: unitNumber(
        required(values, '--min-blind-acceptance-rate'), '--min-blind-acceptance-rate',
      ),
      minimumBlindProductQualityScore: qualityScore(
        required(values, '--min-blind-product-quality'), '--min-blind-product-quality',
      ),
      minimumBlindEvidenceQualityScore: qualityScore(
        required(values, '--min-blind-evidence-quality'), '--min-blind-evidence-quality',
      ),
      minimumBlindAttributionQualityScore: qualityScore(
        required(values, '--min-blind-attribution-quality'), '--min-blind-attribution-quality',
      ),
    },
  }
}

/** Accepts JSON array or JSONL, then emits only aggregate/redacted evidence. */
export function evaluateTriageDataset(input: {
  bytes: string
  thresholds: TriageEvaluationThresholds
  now?: Date
}): TriageEvaluationArtifact {
  const records = parseDataset(input.bytes)
  const report = evaluateTriageRecords(records)
  const sourceTypes = [...new Set(records.map((record) => record.signal.sourceType))]
  const observed = report.observedProjection
  const divisor = observed.sampleCount
  const admitted = report.distribution.admitted
  const observedCompletionRate = admitted === 0 ? 0 : divisor / admitted
  const providerCalls = divisor === 0 ? null : observed.providerCalls / divisor
  const inputTokens = divisor === 0 ? null : observed.inputTokens / divisor
  const outputTokens = divisor === 0 ? null : observed.outputTokens / divisor
  const failures: string[] = []
  if (report.totalRecords < input.thresholds.minimumRecords) {
    failures.push(`records ${report.totalRecords} < ${input.thresholds.minimumRecords}`)
  }
  for (const [source, breakdown] of Object.entries(report.perSource)) {
    if (breakdown && breakdown.total < input.thresholds.minimumRecords) {
      failures.push(`${source}_records ${breakdown.total} < ${input.thresholds.minimumRecords}`)
    }
  }
  if (report.falseNegativeRate > input.thresholds.maxFalseNegativeRate) {
    failures.push(`false_negative_rate ${report.falseNegativeRate} > ${input.thresholds.maxFalseNegativeRate}`)
  }
  if (observedCompletionRate < input.thresholds.minimumObservedCompletionRate) {
    failures.push(
      `metered_completion_rate ${observedCompletionRate} < ${input.thresholds.minimumObservedCompletionRate}`,
    )
  }
  if (divisor === 0) failures.push('no observed completions with measured usage')
  if (observed.toolCalls !== 0) failures.push(`interactive_tool_calls ${observed.toolCalls} != 0`)
  if (providerCalls !== null && providerCalls > input.thresholds.maxProviderCallsPerObservedCompletion) {
    failures.push(`provider_calls_per_completion ${providerCalls} > ${input.thresholds.maxProviderCallsPerObservedCompletion}`)
  }
  if (inputTokens !== null && inputTokens > input.thresholds.maxInputTokensPerObservedCompletion) {
    failures.push(`input_tokens_per_completion ${inputTokens} > ${input.thresholds.maxInputTokensPerObservedCompletion}`)
  }
  if (outputTokens !== null && outputTokens > input.thresholds.maxOutputTokensPerObservedCompletion) {
    failures.push(`output_tokens_per_completion ${outputTokens} > ${input.thresholds.maxOutputTokensPerObservedCompletion}`)
  }
  if (observed.p95LatencyMs !== null && observed.p95LatencyMs > input.thresholds.maxP95LatencyMs) {
    failures.push(`p95_latency_ms ${observed.p95LatencyMs} > ${input.thresholds.maxP95LatencyMs}`)
  }
  const blind = report.blindReview
  if (blind.coverageRate < input.thresholds.minimumBlindReviewRate) {
    failures.push(`blind_review_rate ${blind.coverageRate} < ${input.thresholds.minimumBlindReviewRate}`)
  }
  if ((blind.acceptableRate ?? 0) < input.thresholds.minimumBlindAcceptanceRate) {
    failures.push(`blind_acceptance_rate ${blind.acceptableRate ?? 0} < ${input.thresholds.minimumBlindAcceptanceRate}`)
  }
  const blindScores = [
    ['product', blind.averageProductQualityScore, input.thresholds.minimumBlindProductQualityScore],
    ['evidence', blind.averageEvidenceQualityScore, input.thresholds.minimumBlindEvidenceQualityScore],
    ['attribution', blind.averageAttributionQualityScore, input.thresholds.minimumBlindAttributionQualityScore],
  ] as const
  for (const [name, measured, minimum] of blindScores) {
    if ((measured ?? 0) < minimum) failures.push(`blind_${name}_quality ${measured ?? 0} < ${minimum}`)
  }
  return {
    schemaVersion: TRIAGE_EVALUATION_ARTIFACT_VERSION,
    sourceType: sourceTypes.length === 1 ? sourceTypes[0]! : 'mixed',
    stage: 'research',
    sampleSize: report.totalRecords,
    inputSha256: createHash('sha256').update(input.bytes, 'utf8').digest('hex'),
    evaluatedAt: (input.now ?? new Date()).toISOString(),
    thresholds: input.thresholds,
    passed: failures.length === 0,
    failures,
    report: redactEvaluationReport(report),
  }
}

function redactEvaluationReport(report: TriageEvaluationReport): TriageEvaluationReport {
  return {
    ...report,
    falseNegatives: report.falseNegatives.map((item) => ({
      ...item,
      recordId: createHash('sha256').update(item.recordId, 'utf8').digest('hex'),
      signalId: createHash('sha256').update(item.signalId, 'utf8').digest('hex'),
    })),
  }
}

function parseDataset(bytes: string): TriageEvaluationRecord[] {
  if (!bytes.trim()) throw new Error('Evaluation dataset is empty')
  const value = bytes.trimStart().startsWith('[')
    ? JSON.parse(bytes) as unknown
    : bytes.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line) as unknown } catch { throw new Error(`Invalid JSON on line ${index + 1}`) }
    })
  if (!Array.isArray(value)) throw new Error('Evaluation dataset must be a JSON array or JSONL records')
  return value as TriageEvaluationRecord[]
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag)?.trim()
  if (!value) throw new Error(`${flag} is required`)
  return value
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`)
  return value
}

function unitNumber(raw: string, flag: string): number {
  const value = nonNegativeNumber(raw, flag)
  if (value > 1) throw new Error(`${flag} must be between 0 and 1`)
  return value
}

function nonNegativeNumber(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a non-negative number`)
  return value
}

function qualityScore(raw: string, flag: string): number {
  const value = nonNegativeNumber(raw, flag)
  if (value > 4) throw new Error(`${flag} must be between 0 and 4`)
  return value
}
