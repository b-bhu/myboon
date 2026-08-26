import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertActiveCutoverReceipts, FeedV3CutoverReceiptError } from './cutover-receipt'

const DIGEST = 'a'.repeat(64)

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'myboon.feed_v3_cutover_manifest.v1',
    receipts: [{
      schemaVersion: 'myboon.feed_v3_cutover_receipt.v1',
      receiptId: 'receipt-news-research-1', sourceType: 'news', stage: 'research',
      approvedAt: '2026-08-26T10:00:00.000Z', approvedBy: 'release-owner',
      attestationMode: 'manual_review',
      expiresAt: '2026-08-28T10:00:00.000Z',
      shadowEvaluation: { sampleSize: 1_000, passed: true, artifactSha256: DIGEST },
      rollbackRehearsal: {
        rehearsedAt: '2026-08-26T09:00:00.000Z', passed: true, artifactSha256: DIGEST,
      },
      ...overrides,
    }],
  }
}

function file(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'feed-v3-cutover-'))
  const bound = structuredClone(value) as { receipts?: Array<Record<string, unknown>> }
  for (const [index, receipt] of (bound.receipts ?? []).entries()) {
    const shadow = receipt.shadowEvaluation as Record<string, unknown>
    const shadowArtifact = JSON.stringify({
      schemaVersion: 'myboon.feed_v3_shadow_evaluation.v1', sourceType: receipt.sourceType,
      stage: receipt.stage, passed: shadow.passed, sampleSize: shadow.sampleSize,
    })
    const shadowName = `shadow-${index}.json`
    writeFileSync(join(directory, shadowName), shadowArtifact)
    shadow.artifactPath = shadowName
    shadow.artifactSchemaVersion = 'myboon.feed_v3_shadow_evaluation.v1'
    shadow.artifactSha256 = createHash('sha256').update(shadowArtifact).digest('hex')
    const rollback = receipt.rollbackRehearsal as Record<string, unknown>
    const rollbackArtifact = JSON.stringify({
      schemaVersion: 'myboon.feed_v3_rollback_rehearsal.v1', sourceType: receipt.sourceType,
      stage: receipt.stage, passed: rollback.passed, rehearsedAt: rollback.rehearsedAt,
    })
    const rollbackName = `rollback-${index}.json`
    writeFileSync(join(directory, rollbackName), rollbackArtifact)
    rollback.artifactPath = rollbackName
    rollback.artifactSchemaVersion = 'myboon.feed_v3_rollback_rehearsal.v1'
    rollback.artifactSha256 = createHash('sha256').update(rollbackArtifact).digest('hex')
  }
  const path = join(directory, 'manifest.json')
  writeFileSync(path, JSON.stringify(bound), { mode: 0o600 })
  return path
}

test('accepts a current reviewed receipt for the exact active source and stage', () => {
  const result = assertActiveCutoverReceipts({
    path: file(manifest()),
    required: [{ sourceType: 'news', stage: 'research' }],
    now: new Date('2026-08-27T00:00:00.000Z'),
  })
  assert.equal(result.receipts[0]?.shadowEvaluation.sampleSize, 1_000)
})

test('fails closed for missing, expired, failed, malformed, or duplicate evidence', () => {
  const required = [{ sourceType: 'news' as const, stage: 'research' as const }]
  assert.throws(() => assertActiveCutoverReceipts({
    path: file(manifest()), required: [{ sourceType: 'polymarket', stage: 'research' }],
  }), /missing for research:polymarket/)
  assert.throws(() => assertActiveCutoverReceipts({
    path: file(manifest({ expiresAt: '2026-08-26T11:00:00.000Z' })), required,
    now: new Date('2026-08-26T12:00:00.000Z'),
  }), /expired/)
  assert.throws(() => assertActiveCutoverReceipts({
    path: file(manifest({ shadowEvaluation: { sampleSize: 10, passed: false, artifactSha256: DIGEST } })), required,
  }), /at least 1000/)
  assert.throws(() => assertActiveCutoverReceipts({
    path: file(manifest({ rollbackRehearsal: { rehearsedAt: 'bad', passed: true, artifactSha256: DIGEST } })), required,
  }), /ISO timestamp/)
  assert.throws(() => assertActiveCutoverReceipts({
    path: file(manifest({
      rollbackRehearsal: { rehearsedAt: '2026-08-26T11:00:00.000Z', passed: true, artifactSha256: DIGEST },
    })), required,
  }), /precede approval/)
  const duplicate = manifest() as { receipts: unknown[] }
  duplicate.receipts.push(duplicate.receipts[0])
  assert.throws(() => assertActiveCutoverReceipts({ path: file(duplicate), required }), /Duplicate/)
  assert.throws(() => assertActiveCutoverReceipts({ path: '/does/not/exist', required }), FeedV3CutoverReceiptError)
})

test('receipt binds manual attestation to exact artifact bytes, schema, scope, and sample size', () => {
  const path = file(manifest())
  const directory = join(path, '..')
  writeFileSync(join(directory, 'shadow-0.json'), JSON.stringify({
    schemaVersion: 'myboon.feed_v3_shadow_evaluation.v1', sourceType: 'news', stage: 'research',
    passed: true, sampleSize: 1_000, changedAfterApproval: true,
  }))
  assert.throws(() => assertActiveCutoverReceipts({
    path, required: [{ sourceType: 'news', stage: 'research' }],
  }), /digest does not match/)
})

test('receipt artifacts cannot escape the manifest directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'feed-v3-cutover-escape-'))
  const value = manifest() as { receipts: Array<Record<string, unknown>> }
  value.receipts[0]!.shadowEvaluation = {
    sampleSize: 1_000, passed: true, artifactPath: '../shadow.json',
    artifactSchemaVersion: 'myboon.feed_v3_shadow_evaluation.v1', artifactSha256: DIGEST,
  }
  const path = join(directory, 'manifest.json')
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  assert.throws(() => assertActiveCutoverReceipts({
    path,
    required: [{ sourceType: 'news', stage: 'research' }],
  }), /must stay inside the manifest directory/)
})
