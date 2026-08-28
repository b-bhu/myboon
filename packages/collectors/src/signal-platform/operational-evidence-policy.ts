export const OPERATIONAL_EVIDENCE_POLICY_SCHEMA_VERSION =
  'myboon.feed_v3_operational_evidence_policy.v1' as const

export type OperationalEvidenceKind = 'rollback' | 'live-load' | 'live-soak' | 'provider-outage'

export interface RollbackEvidenceThresholdsV1 {
  maximumRollbackMs: number
}

export interface LiveLoadEvidenceThresholdsV1 {
  minimumDurationMs: number
  minimumArrivalMultiplier: number
  minimumCompletionRatio: number
  maximumQueueP95Ms: number
  maximumQueueDepth: number
  maximumTerminalFailures: number
  maximumDuplicateArtifacts: number
  maximumSqliteWriteErrors: number
}

export interface LiveSoakEvidenceThresholdsV1 {
  minimumDurationMs: number
  maximumSampleGapMs: number
  minimumStatusSamples: number
  minimumQueueSamplesPerLane: number
  maximumRestartDelta: number
  maximumQueueP95Ms: number
  minimumProviderSuccessRate: number
  maximumProviderP95LatencyMs: number
  maximumSqliteGrowthBytes: number
  minimumMemoryHandoffRate: number
  maximumDeadLetterRate: number
  maximumBoundedStateGrowth: number
}

export interface ProviderOutageEvidenceThresholdsV1 {
  minimumCooldownMs: number
  maximumCooldownMs: number
  minimumCohortSize: number
  maximumRecoveryMs: number
}

export type OperationalEvidenceThresholdsV1 =
  | RollbackEvidenceThresholdsV1
  | LiveLoadEvidenceThresholdsV1
  | LiveSoakEvidenceThresholdsV1
  | ProviderOutageEvidenceThresholdsV1

export interface OperationalEvidencePolicyV1 {
  schemaVersion: typeof OPERATIONAL_EVIDENCE_POLICY_SCHEMA_VERSION
  policyId: string
  evidenceKind: OperationalEvidenceKind
  attestationMode: 'manual_review'
  reviewedAt: string
  reviewedBySha256: string
  expiresAt: string
  thresholds: OperationalEvidenceThresholdsV1
}

export function validateOperationalEvidencePolicy(value: unknown): OperationalEvidencePolicyV1 {
  const record = exactObject(value, [
    'schemaVersion', 'policyId', 'evidenceKind', 'attestationMode', 'reviewedAt', 'reviewedBySha256', 'expiresAt', 'thresholds',
  ], 'policy')
  literal(record.schemaVersion, OPERATIONAL_EVIDENCE_POLICY_SCHEMA_VERSION, 'policy.schemaVersion')
  const evidenceKind = kind(record.evidenceKind)
  const reviewedAt = timestamp(record.reviewedAt, 'policy.reviewedAt')
  const expiresAt = timestamp(record.expiresAt, 'policy.expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(reviewedAt)) {
    throw new Error('policy.expiresAt must be after policy.reviewedAt')
  }
  return {
    schemaVersion: OPERATIONAL_EVIDENCE_POLICY_SCHEMA_VERSION,
    policyId: text(record.policyId, 'policy.policyId'),
    evidenceKind,
    attestationMode: manualReview(record.attestationMode),
    reviewedAt,
    reviewedBySha256: digest(record.reviewedBySha256, 'policy.reviewedBySha256'),
    expiresAt,
    thresholds: thresholds(record.thresholds, evidenceKind),
  }
}

export function assertPolicyUsable(input: {
  policy: OperationalEvidencePolicyV1
  kind: OperationalEvidenceKind
  observedAt: string
}): void {
  if (input.policy.evidenceKind !== input.kind) {
    throw new Error(`policy.evidenceKind must be ${input.kind}`)
  }
  const observedAt = Date.parse(input.observedAt)
  if (Date.parse(input.policy.reviewedAt) > observedAt) {
    throw new Error('evidence predates independent policy review')
  }
  if (Date.parse(input.policy.expiresAt) <= observedAt) {
    throw new Error('independently reviewed evidence policy is expired')
  }
}

export function assertOperationalEvidencePolicyCurrent(
  policy: OperationalEvidencePolicyV1,
  now: Date = new Date(),
): void {
  if (!Number.isFinite(now.getTime())) throw new Error('policy validation time must be valid')
  if (Date.parse(policy.reviewedAt) > now.getTime()) throw new Error('independent policy review is in the future')
  if (Date.parse(policy.expiresAt) <= now.getTime()) throw new Error('independently reviewed evidence policy is expired')
}

function thresholds(value: unknown, evidenceKind: OperationalEvidenceKind): OperationalEvidenceThresholdsV1 {
  if (evidenceKind === 'rollback') {
    const row = exactObject(value, ['maximumRollbackMs'], 'policy.thresholds')
    return { maximumRollbackMs: positiveInteger(row.maximumRollbackMs, 'policy.thresholds.maximumRollbackMs') }
  }
  if (evidenceKind === 'live-load') {
    const row = exactObject(value, [
      'minimumDurationMs', 'minimumArrivalMultiplier', 'minimumCompletionRatio', 'maximumQueueP95Ms',
      'maximumQueueDepth', 'maximumTerminalFailures', 'maximumDuplicateArtifacts', 'maximumSqliteWriteErrors',
    ], 'policy.thresholds')
    return {
      minimumDurationMs: positiveInteger(row.minimumDurationMs, 'policy.thresholds.minimumDurationMs'),
      minimumArrivalMultiplier: positiveNumber(row.minimumArrivalMultiplier, 'policy.thresholds.minimumArrivalMultiplier'),
      minimumCompletionRatio: unit(row.minimumCompletionRatio, 'policy.thresholds.minimumCompletionRatio'),
      maximumQueueP95Ms: positiveInteger(row.maximumQueueP95Ms, 'policy.thresholds.maximumQueueP95Ms'),
      maximumQueueDepth: integer(row.maximumQueueDepth, 'policy.thresholds.maximumQueueDepth'),
      maximumTerminalFailures: integer(row.maximumTerminalFailures, 'policy.thresholds.maximumTerminalFailures'),
      maximumDuplicateArtifacts: integer(row.maximumDuplicateArtifacts, 'policy.thresholds.maximumDuplicateArtifacts'),
      maximumSqliteWriteErrors: integer(row.maximumSqliteWriteErrors, 'policy.thresholds.maximumSqliteWriteErrors'),
    }
  }
  if (evidenceKind === 'live-soak') {
    const row = exactObject(value, [
      'minimumDurationMs', 'maximumSampleGapMs', 'minimumStatusSamples', 'minimumQueueSamplesPerLane',
      'maximumRestartDelta', 'maximumQueueP95Ms', 'minimumProviderSuccessRate',
      'maximumProviderP95LatencyMs', 'maximumSqliteGrowthBytes', 'minimumMemoryHandoffRate',
      'maximumDeadLetterRate', 'maximumBoundedStateGrowth',
    ], 'policy.thresholds')
    return {
      minimumDurationMs: positiveInteger(row.minimumDurationMs, 'policy.thresholds.minimumDurationMs'),
      maximumSampleGapMs: positiveInteger(row.maximumSampleGapMs, 'policy.thresholds.maximumSampleGapMs'),
      minimumStatusSamples: positiveInteger(row.minimumStatusSamples, 'policy.thresholds.minimumStatusSamples'),
      minimumQueueSamplesPerLane: positiveInteger(row.minimumQueueSamplesPerLane, 'policy.thresholds.minimumQueueSamplesPerLane'),
      maximumRestartDelta: integer(row.maximumRestartDelta, 'policy.thresholds.maximumRestartDelta'),
      maximumQueueP95Ms: positiveInteger(row.maximumQueueP95Ms, 'policy.thresholds.maximumQueueP95Ms'),
      minimumProviderSuccessRate: unit(row.minimumProviderSuccessRate, 'policy.thresholds.minimumProviderSuccessRate'),
      maximumProviderP95LatencyMs: positiveInteger(row.maximumProviderP95LatencyMs, 'policy.thresholds.maximumProviderP95LatencyMs'),
      maximumSqliteGrowthBytes: integer(row.maximumSqliteGrowthBytes, 'policy.thresholds.maximumSqliteGrowthBytes'),
      minimumMemoryHandoffRate: unit(row.minimumMemoryHandoffRate, 'policy.thresholds.minimumMemoryHandoffRate'),
      maximumDeadLetterRate: unit(row.maximumDeadLetterRate, 'policy.thresholds.maximumDeadLetterRate'),
      maximumBoundedStateGrowth: integer(row.maximumBoundedStateGrowth, 'policy.thresholds.maximumBoundedStateGrowth'),
    }
  }
  const row = exactObject(value, [
    'minimumCooldownMs', 'maximumCooldownMs', 'minimumCohortSize', 'maximumRecoveryMs',
  ], 'policy.thresholds')
  const minimumCooldownMs = positiveInteger(row.minimumCooldownMs, 'policy.thresholds.minimumCooldownMs')
  const maximumCooldownMs = positiveInteger(row.maximumCooldownMs, 'policy.thresholds.maximumCooldownMs')
  if (maximumCooldownMs < minimumCooldownMs) {
    throw new Error('policy.thresholds.maximumCooldownMs must not be below minimumCooldownMs')
  }
  if (minimumCooldownMs < 10 * 60_000 || maximumCooldownMs > 15 * 60_000) {
    throw new Error('policy cooldown range must stay within the reviewed 10-15 minute safety envelope')
  }
  return {
    minimumCooldownMs,
    maximumCooldownMs,
    minimumCohortSize: positiveInteger(row.minimumCohortSize, 'policy.thresholds.minimumCohortSize'),
    maximumRecoveryMs: positiveInteger(row.maximumRecoveryMs, 'policy.thresholds.maximumRecoveryMs'),
  }
}

function exactObject(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`)
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${path} must contain exactly: ${keys.join(', ')}`)
  }
  return record
}

function kind(value: unknown): OperationalEvidenceKind {
  if (value !== 'rollback' && value !== 'live-load' && value !== 'live-soak' && value !== 'provider-outage') {
    throw new Error('policy.evidenceKind is unsupported')
  }
  return value
}

function manualReview(value: unknown): 'manual_review' {
  if (value !== 'manual_review') throw new Error('policy.attestationMode must be manual_review')
  return value
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be non-empty`)
  return value.trim()
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(Date.parse(result)).toISOString() !== result) {
    throw new Error(`${field} must be a canonical UTC timestamp`)
  }
  return result
}

function digest(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${field} must be lowercase SHA-256`)
  return result
}

function literal(value: unknown, expected: string, field: string): void {
  if (value !== expected) throw new Error(`${field} must be ${expected}`)
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} must be a non-negative safe integer`)
  return Number(value)
}

function positiveInteger(value: unknown, field: string): number {
  const result = integer(value, field)
  if (result === 0) throw new Error(`${field} must be positive`)
  return result
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`)
  return value
}

function unit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`)
  }
  return value
}
