import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import type { FeedV3Source, FeedV3RuntimeStage } from './runtime-config'

export const CUTOVER_RECEIPT_SCHEMA_VERSION = 'myboon.feed_v3_cutover_receipt.v1' as const
export const CUTOVER_MINIMUM_SHADOW_SAMPLE_SIZE = 1_000 as const

export type CutoverStage = Exclude<FeedV3RuntimeStage, 'intake'>

export interface FeedV3CutoverReceipt {
  schemaVersion: typeof CUTOVER_RECEIPT_SCHEMA_VERSION
  receiptId: string
  sourceType: FeedV3Source
  stage: CutoverStage
  approvedAt: string
  approvedBy: string
  attestationMode: 'manual_review'
  expiresAt: string
  shadowEvaluation: {
    sampleSize: number
    passed: true
    artifactPath: string
    artifactSchemaVersion: string
    artifactSha256: string
  }
  rollbackRehearsal: {
    rehearsedAt: string
    passed: true
    artifactPath: string
    artifactSchemaVersion: string
    artifactSha256: string
  }
}

export interface FeedV3CutoverManifest {
  schemaVersion: 'myboon.feed_v3_cutover_manifest.v1'
  receipts: FeedV3CutoverReceipt[]
}

export class FeedV3CutoverReceiptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedV3CutoverReceiptError'
  }
}

/**
 * Load and validate the operator-reviewed evidence required before shared
 * workers may take active ownership. This is deliberately read-only and must
 * run before opening a queue or provider session.
 */
export function assertActiveCutoverReceipts(input: {
  path: string
  required: ReadonlyArray<{ sourceType: FeedV3Source, stage: CutoverStage }>
  now?: Date
}): FeedV3CutoverManifest {
  if (!input.path.trim()) throw new FeedV3CutoverReceiptError('Cutover receipt path is required')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(input.path, 'utf8'))
  } catch {
    throw new FeedV3CutoverReceiptError('Cutover receipt manifest could not be read or parsed')
  }
  const manifest = validateManifest(parsed)
  const manifestDirectory = dirname(resolve(input.path))
  const now = input.now ?? new Date()
  for (const requirement of input.required) {
    const receipt = manifest.receipts.find((candidate) => (
      candidate.sourceType === requirement.sourceType && candidate.stage === requirement.stage
    ))
    if (!receipt) {
      throw new FeedV3CutoverReceiptError(
        `Cutover receipt missing for ${requirement.stage}:${requirement.sourceType}`,
      )
    }
    verifyBoundArtifact(receipt, 'shadow', manifestDirectory)
    verifyBoundArtifact(receipt, 'rollback', manifestDirectory)
    if (Date.parse(receipt.approvedAt) > now.getTime()) {
      throw new FeedV3CutoverReceiptError(
        `Cutover receipt approval is in the future for ${requirement.stage}:${requirement.sourceType}`,
      )
    }
    if (Date.parse(receipt.expiresAt) <= now.getTime()) {
      throw new FeedV3CutoverReceiptError(
        `Cutover receipt expired for ${requirement.stage}:${requirement.sourceType}`,
      )
    }
  }
  return manifest
}

function validateManifest(value: unknown): FeedV3CutoverManifest {
  const record = object(value, 'manifest')
  if (record.schemaVersion !== 'myboon.feed_v3_cutover_manifest.v1') {
    throw new FeedV3CutoverReceiptError('Unsupported cutover manifest schema version')
  }
  if (!Array.isArray(record.receipts)) throw new FeedV3CutoverReceiptError('Cutover manifest receipts must be an array')
  const receipts = record.receipts.map(validateReceipt)
  const identities = new Set<string>()
  for (const receipt of receipts) {
    const identity = `${receipt.stage}:${receipt.sourceType}`
    if (identities.has(identity)) throw new FeedV3CutoverReceiptError(`Duplicate cutover receipt for ${identity}`)
    identities.add(identity)
  }
  return { schemaVersion: 'myboon.feed_v3_cutover_manifest.v1', receipts }
}

function validateReceipt(value: unknown): FeedV3CutoverReceipt {
  const record = object(value, 'receipt')
  if (record.schemaVersion !== CUTOVER_RECEIPT_SCHEMA_VERSION) {
    throw new FeedV3CutoverReceiptError('Unsupported cutover receipt schema version')
  }
  const sourceType = enumeration(record.sourceType, ['news', 'polymarket', 'market_calendar', 'x'], 'sourceType')
  const stage = enumeration(record.stage, ['research', 'entity'], 'stage')
  const shadow = object(record.shadowEvaluation, 'shadowEvaluation')
  const rollback = object(record.rollbackRehearsal, 'rollbackRehearsal')
  const sampleSize = integer(shadow.sampleSize, 'shadowEvaluation.sampleSize')
  if (sampleSize < CUTOVER_MINIMUM_SHADOW_SAMPLE_SIZE) {
    throw new FeedV3CutoverReceiptError(
      `shadowEvaluation.sampleSize must be at least ${CUTOVER_MINIMUM_SHADOW_SAMPLE_SIZE}`,
    )
  }
  if (shadow.passed !== true) throw new FeedV3CutoverReceiptError('Shadow evaluation must have passed')
  if (rollback.passed !== true) throw new FeedV3CutoverReceiptError('Rollback rehearsal must have passed')
  const approvedAt = timestamp(record.approvedAt, 'approvedAt')
  const expiresAt = timestamp(record.expiresAt, 'expiresAt')
  const rehearsedAt = timestamp(rollback.rehearsedAt, 'rollbackRehearsal.rehearsedAt')
  if (Date.parse(rehearsedAt) > Date.parse(approvedAt)) {
    throw new FeedV3CutoverReceiptError('Rollback rehearsal must precede approval')
  }
  if (Date.parse(expiresAt) <= Date.parse(approvedAt)) {
    throw new FeedV3CutoverReceiptError('Cutover receipt must expire after approval')
  }
  return {
    schemaVersion: CUTOVER_RECEIPT_SCHEMA_VERSION,
    receiptId: nonEmpty(record.receiptId, 'receiptId'),
    sourceType,
    stage,
    approvedAt,
    approvedBy: nonEmpty(record.approvedBy, 'approvedBy'),
    attestationMode: exact(record.attestationMode, 'manual_review', 'attestationMode'),
    expiresAt,
    shadowEvaluation: {
      sampleSize,
      passed: true,
      artifactPath: safeArtifactPath(shadow.artifactPath, 'shadowEvaluation.artifactPath'),
      artifactSchemaVersion: nonEmpty(shadow.artifactSchemaVersion, 'shadowEvaluation.artifactSchemaVersion'),
      artifactSha256: sha256(shadow.artifactSha256, 'shadowEvaluation.artifactSha256'),
    },
    rollbackRehearsal: {
      rehearsedAt,
      passed: true,
      artifactPath: safeArtifactPath(rollback.artifactPath, 'rollbackRehearsal.artifactPath'),
      artifactSchemaVersion: nonEmpty(rollback.artifactSchemaVersion, 'rollbackRehearsal.artifactSchemaVersion'),
      artifactSha256: sha256(rollback.artifactSha256, 'rollbackRehearsal.artifactSha256'),
    },
  }
}

function verifyBoundArtifact(
  receipt: FeedV3CutoverReceipt,
  kind: 'shadow' | 'rollback',
  manifestDirectory: string,
): void {
  const binding = kind === 'shadow' ? receipt.shadowEvaluation : receipt.rollbackRehearsal
  const path = resolve(manifestDirectory, binding.artifactPath)
  let bytes: string
  let artifact: Record<string, unknown>
  try {
    bytes = readFileSync(path, 'utf8')
    artifact = object(JSON.parse(bytes), `${kind} artifact`)
  } catch {
    throw new FeedV3CutoverReceiptError(`${kind} cutover artifact could not be read or parsed`)
  }
  const digest = createHash('sha256').update(bytes, 'utf8').digest('hex')
  if (digest !== binding.artifactSha256) {
    throw new FeedV3CutoverReceiptError(`${kind} cutover artifact digest does not match receipt`)
  }
  if (artifact.schemaVersion !== binding.artifactSchemaVersion) {
    throw new FeedV3CutoverReceiptError(`${kind} cutover artifact schema does not match receipt`)
  }
  if (artifact.passed !== true) throw new FeedV3CutoverReceiptError(`${kind} cutover artifact did not pass`)
  if (artifact.sourceType !== receipt.sourceType || artifact.stage !== receipt.stage) {
    throw new FeedV3CutoverReceiptError(`${kind} cutover artifact source/stage does not match receipt`)
  }
  if (kind === 'shadow') {
    const sampleSize = integer(artifact.sampleSize, 'shadow artifact sampleSize')
    if (sampleSize !== receipt.shadowEvaluation.sampleSize || sampleSize < CUTOVER_MINIMUM_SHADOW_SAMPLE_SIZE) {
      throw new FeedV3CutoverReceiptError('shadow cutover artifact sample size does not match receipt')
    }
  } else if (artifact.rehearsedAt !== receipt.rollbackRehearsal.rehearsedAt) {
    throw new FeedV3CutoverReceiptError('rollback cutover artifact rehearsal time does not match receipt')
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FeedV3CutoverReceiptError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new FeedV3CutoverReceiptError(`${field} must be non-empty`)
  return value.trim()
}

function exact<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new FeedV3CutoverReceiptError(`${field} must equal ${expected}`)
  return expected
}

function safeArtifactPath(value: unknown, field: string): string {
  const path = nonEmpty(value, field)
  if (path.includes('\0')) throw new FeedV3CutoverReceiptError(`${field} is invalid`)
  const normalized = normalize(path)
  if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new FeedV3CutoverReceiptError(`${field} must stay inside the manifest directory`)
  }
  return normalized
}

function timestamp(value: unknown, field: string): string {
  const result = nonEmpty(value, field)
  if (!Number.isFinite(Date.parse(result))) throw new FeedV3CutoverReceiptError(`${field} must be an ISO timestamp`)
  return result
}

function sha256(value: unknown, field: string): string {
  const result = nonEmpty(value, field)
  if (!/^[a-f0-9]{64}$/i.test(result)) throw new FeedV3CutoverReceiptError(`${field} must be a SHA-256 digest`)
  return result.toLowerCase()
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new FeedV3CutoverReceiptError(`${field} must be an integer`)
  return value as number
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new FeedV3CutoverReceiptError(`${field} is unsupported`)
  }
  return value as T
}
