import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createFileCutoverReadinessLoader,
  PHASE_1_READINESS_PAIRS,
  reportCutoverReadiness,
} from './cutover-readiness'
import type { CutoverReadinessLoader, CutoverReadinessPair } from './cutover-readiness'

const DIGEST = 'a'.repeat(64)

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'myboon.feed_v3_cutover_receipt.v1',
    receiptId: 'receipt-1', sourceType: 'news', stage: 'research',
    approvedAt: '2026-08-26T10:00:00.000Z', approvedBy: 'release-owner',
    attestationMode: 'manual_review',
    expiresAt: '2026-08-28T10:00:00.000Z',
    shadowEvaluation: { sampleSize: 1_000, passed: true, artifactSha256: DIGEST },
    rollbackRehearsal: { rehearsedAt: '2026-08-26T09:00:00.000Z', passed: true, artifactSha256: DIGEST },
    ...overrides,
  }
}

/** Write a valid manifest with bound artifacts; returns the manifest path. */
function writeManifest(receipts: Array<Record<string, unknown>>): string {
  const directory = mkdtempSync(join(tmpdir(), 'cutover-readiness-'))
  const bound = structuredClone(receipts) as Array<Record<string, unknown>>
  for (const [index, entry] of bound.entries()) {
    const shadow = entry.shadowEvaluation as Record<string, unknown>
    const shadowArtifact = JSON.stringify({
      schemaVersion: 'myboon.feed_v3_shadow_evaluation.v1', sourceType: entry.sourceType,
      stage: entry.stage, passed: true, sampleSize: shadow.sampleSize,
    })
    const shadowName = `shadow-${index}.json`
    writeFileSync(join(directory, shadowName), shadowArtifact)
    shadow.artifactPath = shadowName
    shadow.artifactSchemaVersion = 'myboon.feed_v3_shadow_evaluation.v1'
    shadow.artifactSha256 = createHash('sha256').update(shadowArtifact).digest('hex')
    const rollback = entry.rollbackRehearsal as Record<string, unknown>
    const rollbackArtifact = JSON.stringify({
      schemaVersion: 'myboon.feed_v3_rollback_rehearsal.v1', sourceType: entry.sourceType,
      stage: entry.stage, passed: true, rehearsedAt: rollback.rehearsedAt,
    })
    const rollbackName = `rollback-${index}.json`
    writeFileSync(join(directory, rollbackName), rollbackArtifact)
    rollback.artifactPath = rollbackName
    rollback.artifactSchemaVersion = 'myboon.feed_v3_rollback_rehearsal.v1'
    rollback.artifactSha256 = createHash('sha256').update(rollbackArtifact).digest('hex')
  }
  const path = join(directory, 'manifest.json')
  writeFileSync(path, JSON.stringify({ schemaVersion: 'myboon.feed_v3_cutover_manifest.v1', receipts: bound }), { mode: 0o600 })
  return path
}

function makeLoader(path: string): CutoverReadinessLoader {
  return { manifestPath: path, readReceipts: createFileCutoverReadinessLoader(path).readReceipts }
}

function countingLoader(path: string): { loader: CutoverReadinessLoader, calls: () => number } {
  let count = 0
  const base = createFileCutoverReadinessLoader(path)
  return {
    loader: {
      manifestPath: path,
      readReceipts() { count += 1; return base.readReceipts() },
    },
    calls: () => count,
  }
}

function phase1Receipts(): Array<Record<string, unknown>> {
  return PHASE_1_READINESS_PAIRS.map((pair) => receipt({
    sourceType: pair.source, stage: pair.stage, receiptId: `r-${pair.source}-${pair.stage}`,
  }))
}

const NOW = new Date('2026-08-27T00:00:00.000Z')

test('reports all four valid Phase 1 pairs as ready', () => {
  const path = writeManifest(phase1Receipts())
  const loader = makeLoader(path)
  const report = reportCutoverReadiness({ pairs: PHASE_1_READINESS_PAIRS, loader, now: NOW })
  assert.equal(report.ready, true)
  assert.equal(report.pairs.length, 4)
  assert.ok(report.pairs.every((p) => p.outcome === 'ready' && p.ready))
})

test('one missing pair is reported missing and overall is not ready', () => {
  const receipts = PHASE_1_READINESS_PAIRS
    .filter((p) => !(p.source === 'polymarket' && p.stage === 'entity'))
    .map((pair) => receipt({ sourceType: pair.source, stage: pair.stage }))
  const path = writeManifest(receipts)
  const loader = makeLoader(path)
  const report = reportCutoverReadiness({ pairs: PHASE_1_READINESS_PAIRS, loader, now: NOW })
  assert.equal(report.ready, false)
  const missingReport = report.pairs.find((p) => p.outcome === 'missing')
  assert.ok(missingReport)
  assert.deepEqual(missingReport.pair, { source: 'polymarket', stage: 'entity' })
})

test('an expired receipt is reported as expired and not ready', () => {
  const receipts = PHASE_1_READINESS_PAIRS.map((pair) => receipt({
    sourceType: pair.source, stage: pair.stage,
    ...(pair.source === 'news' && pair.stage === 'research'
      ? { expiresAt: '2026-08-26T11:00:00.000Z' } : {}),
  }))
  const path = writeManifest(receipts)
  const loader = makeLoader(path)
  const report = reportCutoverReadiness({ pairs: PHASE_1_READINESS_PAIRS, loader, now: NOW })
  assert.equal(report.ready, false)
  const expired = report.pairs.find((p) => p.outcome === 'expired')
  assert.ok(expired)
  assert.deepEqual(expired.pair, { source: 'news', stage: 'research' })
})

test('a binding failure is reported as invalid without leaking error detail', () => {
  const path = writeManifest(phase1Receipts())
  // Tamper with the shadow artifact so the shared contract throws on digest mismatch.
  writeFileSync(join(path, '..', 'shadow-0.json'), '{"tampered":true}')
  const loader = makeLoader(path)
  const report = reportCutoverReadiness({ pairs: PHASE_1_READINESS_PAIRS, loader, now: NOW })
  assert.equal(report.ready, false)
  const invalid = report.pairs.find((p) => p.outcome === 'invalid')
  assert.ok(invalid)
  assert.ok(!invalid.note.toLowerCase().includes('digest'))
  assert.ok(!invalid.note.includes('tampered'))
})

test('duplicate requested pairs are deduplicated deterministically', () => {
  const path = writeManifest(phase1Receipts())
  const loader = makeLoader(path)
  const dupes = [...PHASE_1_READINESS_PAIRS, ...PHASE_1_READINESS_PAIRS]
  const report = reportCutoverReadiness({ pairs: dupes, loader, now: NOW })
  assert.equal(report.ready, true)
  assert.equal(report.pairs.length, 4)
})

test('unsupported source or stage pairs are rejected', () => {
  const path = writeManifest(phase1Receipts())
  const loader = makeLoader(path)
  assert.throws(
    () => reportCutoverReadiness({ pairs: [{ source: 'market_calendar', stage: 'research' }], loader, now: NOW }),
    /Unsupported cutover readiness pair/,
  )
  const unsupportedStage = { source: 'news', stage: 'intake' } as unknown as CutoverReadinessPair
  assert.throws(
    () => reportCutoverReadiness({ pairs: [unsupportedStage], loader, now: NOW }),
    /Unsupported cutover readiness pair/,
  )
})

test('evaluation is read-only and does not mutate the loader', () => {
  const path = writeManifest(phase1Receipts())
  const { loader, calls } = countingLoader(path)
  const before = JSON.stringify(loader.readReceipts())
  const report = reportCutoverReadiness({ pairs: PHASE_1_READINESS_PAIRS, loader, now: NOW })
  const after = JSON.stringify(loader.readReceipts())
  assert.equal(report.ready, true)
  // one pre-check read + one report-internal read + one post-check read
  assert.equal(calls(), 3)
  assert.equal(after, before)
})

test('a manifest that cannot be read yields an invalid outcome, not a crash', () => {
  const loader = makeLoader('/does/not/exist.json')
  const report = reportCutoverReadiness({ pairs: PHASE_1_READINESS_PAIRS, loader, now: NOW })
  assert.equal(report.ready, false)
  assert.ok(report.pairs.every((p) => p.outcome === 'invalid'))
})

test('a structurally invalid manifest is invalid rather than missing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cutover-readiness-invalid-'))
  const path = join(directory, 'manifest.json')
  writeFileSync(path, JSON.stringify({
    schemaVersion: 'myboon.feed_v3_cutover_manifest.v1',
    receipts: [{ sourceType: 'news', stage: 'research' }],
  }))
  const report = reportCutoverReadiness({
    pairs: PHASE_1_READINESS_PAIRS,
    loader: makeLoader(path),
    now: NOW,
  })
  assert.equal(report.ready, false)
  assert.ok(report.pairs.every((pair) => pair.outcome === 'invalid'))
})
