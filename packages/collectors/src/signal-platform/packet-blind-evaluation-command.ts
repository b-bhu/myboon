import type { Signal } from './contracts'
import {
  evaluateBlindPacketComparison,
  type BlindPacketManifestV1,
  type BlindPacketScoreV1,
  type PacketComparisonReportV1,
} from './packet-blind-evaluator'

export const PACKET_COMPARISON_EVIDENCE_SCHEMA_VERSION = 'myboon.packet_comparison_evidence.v1' as const

export interface PacketComparisonThresholdsV1 {
  requiredSourceTypes: Signal['sourceType'][]
  minimumPairsPerSource: number
  minimumReviewCoverageRate: number
  minimumProposedAcceptableRate: number
  minimumProposedProductQualityScore: number
  minimumProposedEvidenceQualityScore: number
  minimumProposedAttributionQualityScore: number
  maximumProductQualityRegression: number
  maximumEvidenceQualityRegression: number
  maximumAttributionQualityRegression: number
  maximumProposedProviderCalls: number
  maximumProposedInputTokens: number
  maximumProposedOutputTokens: number
  maximumProposedP95WallTimeMs: number
}

export interface PacketComparisonEvidenceV1 {
  schemaVersion: typeof PACKET_COMPARISON_EVIDENCE_SCHEMA_VERSION
  evaluatedAt: string
  sourceTypes: Signal['sourceType'][]
  thresholds: PacketComparisonThresholdsV1
  passed: boolean
  failures: string[]
  report: PacketComparisonReportV1
}

export function evaluatePacketComparisonEvidence(input: {
  manifest: BlindPacketManifestV1
  reviews: BlindPacketScoreV1[]
  thresholds: PacketComparisonThresholdsV1
  now?: Date
}): PacketComparisonEvidenceV1 {
  const thresholds = validateThresholds(input.thresholds)
  const report = evaluateBlindPacketComparison(input)
  const sourceTypes = Object.keys(report.perSource).sort() as Signal['sourceType'][]
  const failures: string[] = []
  for (const sourceType of thresholds.requiredSourceTypes) {
    const row = report.perSource[sourceType]
    const count = row?.totalPairs ?? 0
    if (count < thresholds.minimumPairsPerSource) {
      failures.push(`${sourceType}.pairs ${count} < ${thresholds.minimumPairsPerSource}`)
    }
  }
  if (report.reviewCoverageRate < thresholds.minimumReviewCoverageRate) {
    failures.push(`review_coverage ${report.reviewCoverageRate} < ${thresholds.minimumReviewCoverageRate}`)
  }
  const proposed = report.proposed
  const current = report.current
  compareMinimum(failures, 'proposed_acceptable_rate', proposed.acceptableRate, thresholds.minimumProposedAcceptableRate)
  compareMinimum(
    failures, 'proposed_product_quality', proposed.averageProductQualityScore,
    thresholds.minimumProposedProductQualityScore,
  )
  compareMinimum(
    failures, 'proposed_evidence_quality', proposed.averageEvidenceQualityScore,
    thresholds.minimumProposedEvidenceQualityScore,
  )
  compareMinimum(
    failures, 'proposed_attribution_quality', proposed.averageAttributionQualityScore,
    thresholds.minimumProposedAttributionQualityScore,
  )
  compareRegression(
    failures, 'product_quality', current.averageProductQualityScore,
    proposed.averageProductQualityScore, thresholds.maximumProductQualityRegression,
  )
  compareRegression(
    failures, 'evidence_quality', current.averageEvidenceQualityScore,
    proposed.averageEvidenceQualityScore, thresholds.maximumEvidenceQualityRegression,
  )
  compareRegression(
    failures, 'attribution_quality', current.averageAttributionQualityScore,
    proposed.averageAttributionQualityScore, thresholds.maximumAttributionQualityRegression,
  )
  compareMaximum(
    failures, 'proposed_provider_calls', proposed.averageProviderCalls,
    thresholds.maximumProposedProviderCalls,
  )
  compareMaximum(
    failures, 'proposed_input_tokens', proposed.averageInputTokens,
    thresholds.maximumProposedInputTokens,
  )
  compareMaximum(
    failures, 'proposed_output_tokens', proposed.averageOutputTokens,
    thresholds.maximumProposedOutputTokens,
  )
  compareMaximum(
    failures, 'proposed_p95_wall_time_ms', proposed.p95WallTimeMs,
    thresholds.maximumProposedP95WallTimeMs,
  )
  if (proposed.averageToolCalls === null || proposed.averageToolCalls !== 0) {
    failures.push(`proposed_interactive_tool_calls ${proposed.averageToolCalls ?? 'unavailable'} != 0`)
  }
  return {
    schemaVersion: PACKET_COMPARISON_EVIDENCE_SCHEMA_VERSION,
    evaluatedAt: (input.now ?? new Date()).toISOString(),
    sourceTypes,
    thresholds,
    passed: failures.length === 0,
    failures,
    report,
  }
}

export function parsePacketComparisonThresholds(values: Readonly<Record<string, string | undefined>>): PacketComparisonThresholdsV1 {
  return validateThresholds({
    requiredSourceTypes: sourceList(values.requiredSourceTypes ?? 'news,polymarket'),
    minimumPairsPerSource: integer(values.minimumPairsPerSource ?? '1000', 'minimumPairsPerSource'),
    minimumReviewCoverageRate: unit(values.minimumReviewCoverageRate, 'minimumReviewCoverageRate'),
    minimumProposedAcceptableRate: unit(values.minimumProposedAcceptableRate, 'minimumProposedAcceptableRate'),
    minimumProposedProductQualityScore: score(values.minimumProposedProductQualityScore, 'minimumProposedProductQualityScore'),
    minimumProposedEvidenceQualityScore: score(values.minimumProposedEvidenceQualityScore, 'minimumProposedEvidenceQualityScore'),
    minimumProposedAttributionQualityScore: score(values.minimumProposedAttributionQualityScore, 'minimumProposedAttributionQualityScore'),
    maximumProductQualityRegression: score(values.maximumProductQualityRegression, 'maximumProductQualityRegression'),
    maximumEvidenceQualityRegression: score(values.maximumEvidenceQualityRegression, 'maximumEvidenceQualityRegression'),
    maximumAttributionQualityRegression: score(values.maximumAttributionQualityRegression, 'maximumAttributionQualityRegression'),
    maximumProposedProviderCalls: nonNegative(values.maximumProposedProviderCalls, 'maximumProposedProviderCalls'),
    maximumProposedInputTokens: nonNegative(values.maximumProposedInputTokens, 'maximumProposedInputTokens'),
    maximumProposedOutputTokens: nonNegative(values.maximumProposedOutputTokens, 'maximumProposedOutputTokens'),
    maximumProposedP95WallTimeMs: nonNegative(values.maximumProposedP95WallTimeMs, 'maximumProposedP95WallTimeMs'),
  })
}

function validateThresholds(value: PacketComparisonThresholdsV1): PacketComparisonThresholdsV1 {
  sourceList(value.requiredSourceTypes.join(','))
  integer(String(value.minimumPairsPerSource), 'minimumPairsPerSource')
  unit(String(value.minimumReviewCoverageRate), 'minimumReviewCoverageRate')
  unit(String(value.minimumProposedAcceptableRate), 'minimumProposedAcceptableRate')
  for (const field of [
    'minimumProposedProductQualityScore', 'minimumProposedEvidenceQualityScore',
    'minimumProposedAttributionQualityScore', 'maximumProductQualityRegression',
    'maximumEvidenceQualityRegression', 'maximumAttributionQualityRegression',
  ] as const) score(String(value[field]), field)
  for (const field of [
    'maximumProposedProviderCalls', 'maximumProposedInputTokens', 'maximumProposedOutputTokens',
    'maximumProposedP95WallTimeMs',
  ] as const) nonNegative(String(value[field]), field)
  return { ...value }
}

function compareMinimum(failures: string[], label: string, measured: number | null, minimum: number): void {
  if (measured === null || measured < minimum) failures.push(`${label} ${measured ?? 'unavailable'} < ${minimum}`)
}
function compareMaximum(failures: string[], label: string, measured: number | null, maximum: number): void {
  if (measured === null || measured > maximum) failures.push(`${label} ${measured ?? 'unavailable'} > ${maximum}`)
}
function compareRegression(
  failures: string[], label: string, current: number | null, proposed: number | null, maximum: number,
): void {
  if (current === null || proposed === null) failures.push(`${label}_regression unavailable`)
  else if (current - proposed > maximum) failures.push(`${label}_regression ${current - proposed} > ${maximum}`)
}
function integer(raw: string | undefined, name: string): number {
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a positive integer`)
  return Number(raw)
}
function unit(raw: string | undefined, name: string): number {
  const value = Number(raw)
  if (raw === undefined || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`)
  return value
}
function score(raw: string | undefined, name: string): number {
  const value = Number(raw)
  if (raw === undefined || !Number.isFinite(value) || value < 0 || value > 4) throw new Error(`${name} must be between 0 and 4`)
  return value
}
function nonNegative(raw: string | undefined, name: string): number {
  const value = Number(raw)
  if (raw === undefined || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`)
  return value
}
function sourceList(raw: string): Signal['sourceType'][] {
  const valid = new Set<Signal['sourceType']>(['news', 'polymarket', 'market_calendar', 'x'])
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean)
  if (values.length === 0 || new Set(values).size !== values.length
    || values.some((value) => !valid.has(value as Signal['sourceType']))) {
    throw new Error('requiredSourceTypes must contain unique registered sources')
  }
  return values as Signal['sourceType'][]
}
