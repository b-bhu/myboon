import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { evaluateV4SourceCutoverPreflight } from './v4-source-cutover-preflight'

const now = new Date('2026-01-01T00:00:00.000Z')
function fixture(expired = false, mismatch = false): { dir: string; manifest: string } {
  const dir = mkdtempSync(join(tmpdir(), 'v4-cutover-'))
  const receipts = (['research', 'entity'] as const).map((stage) => {
    const shadow = { schemaVersion: 'evaluation.v1', passed: true, sourceType: 'news', stage, sampleSize: 1000 }
    const rollback = { schemaVersion: 'rollback.v1', passed: true, sourceType: 'news', stage, rehearsedAt: '2025-12-01T00:00:00.000Z' }
    writeFileSync(join(dir, `${stage}-evaluation.json`), JSON.stringify(shadow))
    writeFileSync(join(dir, `${stage}-rollback.json`), JSON.stringify(rollback))
    return {
      schemaVersion: 'myboon.feed_v3_cutover_receipt.v1', receiptId: `${stage}-receipt`, sourceType: mismatch && stage === 'entity' ? 'polymarket' : 'news', stage,
      approvedAt: '2025-12-15T00:00:00.000Z', approvedBy: 'operator', attestationMode: 'manual_review',
      expiresAt: expired ? '2025-12-31T00:00:00.000Z' : '2027-01-01T00:00:00.000Z',
      shadowEvaluation: { sampleSize: 1000, passed: true, artifactPath: `${stage}-evaluation.json`, artifactSchemaVersion: 'evaluation.v1', artifactSha256: createHash('sha256').update(JSON.stringify(shadow)).digest('hex') },
      rollbackRehearsal: { rehearsedAt: rollback.rehearsedAt, passed: true, artifactPath: `${stage}-rollback.json`, artifactSchemaVersion: 'rollback.v1', artifactSha256: createHash('sha256').update(JSON.stringify(rollback)).digest('hex') },
    }
  })
  const manifest = join(dir, 'manifest.json')
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 'myboon.feed_v3_cutover_manifest.v1', receipts }))
  return { dir, manifest }
}
const baseline = { enabled: true, action: 'cutover' as const, source: 'news' as const, owners: { research: 'legacy' as const, entity: 'legacy' as const }, ownerApprovedEvaluation: true, backupRestoreVerified: true, outboxReconciled: true, cursorReconciled: true, inflightReconciled: true }

test('defaults off and validates both receipts without authorizing a cutover', () => {
  const f = fixture()
  try {
    assert.equal(evaluateV4SourceCutoverPreflight({ ...baseline, enabled: undefined, receiptManifestPath: f.manifest, now }).advisoryChecksPassed, false)
    const ready = evaluateV4SourceCutoverPreflight({ ...baseline, receiptManifestPath: f.manifest, now })
    assert.deepEqual(ready.reasons, [])
    assert.equal(ready.advisoryChecksPassed, true)
    assert.equal(ready.authorizesOwnershipChange, false)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('fails closed on absent, expired, or mismatched receipts', () => {
  for (const [f, shouldAllow] of [[fixture(), true], [fixture(true), false], [fixture(false, true), false]] as const) {
    try {
      assert.equal(evaluateV4SourceCutoverPreflight({ ...baseline, receiptManifestPath: f.manifest, now }).advisoryChecksPassed, shouldAllow)
    } finally { rmSync(f.dir, { recursive: true, force: true }) }
  }
  assert.equal(evaluateV4SourceCutoverPreflight({ ...baseline, receiptManifestPath: '/missing/manifest.json', now }).advisoryChecksPassed, false)
})

test('an earlier advisory result cannot authorize action after evidence changes', () => {
  const f = fixture()
  try {
    const first = evaluateV4SourceCutoverPreflight({ ...baseline, receiptManifestPath: f.manifest, now })
    assert.equal(first.advisoryChecksPassed, true)
    assert.equal(first.authorizesOwnershipChange, false)
    writeFileSync(f.manifest, '{}')
    const next = evaluateV4SourceCutoverPreflight({ ...baseline, receiptManifestPath: f.manifest, now })
    assert.equal(next.advisoryChecksPassed, false)
    assert.equal(next.authorizesOwnershipChange, false)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('refuses dual ownership, unacknowledged obligations, and unsafe retirement', () => {
  const f = fixture()
  try {
    assert.equal(evaluateV4SourceCutoverPreflight({ ...baseline, owners: { research: 'shared', entity: 'shared' }, receiptManifestPath: f.manifest, now }).advisoryChecksPassed, false)
    assert.equal(evaluateV4SourceCutoverPreflight({ ...baseline, outboxReconciled: false, receiptManifestPath: f.manifest, now }).advisoryChecksPassed, false)
    const retire = evaluateV4SourceCutoverPreflight({ ...baseline, action: 'retire_legacy', canonicalPathHealthy: true, residualReferencesAccounted: true, receiptManifestPath: f.manifest, now })
    assert.equal(retire.advisoryChecksPassed, false)
    assert.match(retire.reasons.join(' '), /source-level ownership receipt verifier is not supplied/)
    const verifiedRetire = evaluateV4SourceCutoverPreflight({ ...baseline, action: 'retire_legacy', canonicalPathHealthy: true, residualReferencesAccounted: true, obsoleteQueueWritesStopped: true, owners: { research: 'shared', entity: 'shared' }, verifySourceOwnershipEvidence: (source) => source === 'news', receiptManifestPath: f.manifest, now })
    assert.equal(verifiedRetire.advisoryChecksPassed, true)
    assert.equal(verifiedRetire.authorizesOwnershipChange, false)
    const legacyLegacy = evaluateV4SourceCutoverPreflight({ ...baseline, action: 'retire_legacy', canonicalPathHealthy: true, residualReferencesAccounted: true, owners: { research: 'legacy', entity: 'legacy' }, obsoleteQueueWritesStopped: true, verifySourceOwnershipEvidence: () => true, receiptManifestPath: f.manifest, now })
    assert.equal(legacyLegacy.advisoryChecksPassed, false)
    const noWriterFence = evaluateV4SourceCutoverPreflight({ ...baseline, action: 'retire_legacy', canonicalPathHealthy: true, residualReferencesAccounted: true, verifySourceOwnershipEvidence: () => true, owners: { research: 'shared', entity: 'shared' }, receiptManifestPath: f.manifest, now })
    assert.match(noWriterFence.reasons.join(' '), /obsolete collector queue writes/)
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('requires news-first and enforces rollback ordering', () => {
  const poly = evaluateV4SourceCutoverPreflight({ ...baseline, source: 'polymarket', newsCutoverComplete: false })
  assert.equal(poly.advisoryChecksPassed, false)
  assert.match(poly.reasons.join(' '), /news cutover must complete/)
  const mismatchedSourceEvidence = evaluateV4SourceCutoverPreflight({ ...baseline, source: 'polymarket', action: 'retire_legacy', newsCutoverComplete: true, owners: { research: 'shared', entity: 'shared' }, canonicalPathHealthy: true, residualReferencesAccounted: true, obsoleteQueueWritesStopped: true, verifySourceOwnershipEvidence: (source) => source === 'news' })
  assert.equal(mismatchedSourceEvidence.advisoryChecksPassed, false)
  assert.match(mismatchedSourceEvidence.reasons.join(' '), /evidence is missing or invalid/)
  const rollback = evaluateV4SourceCutoverPreflight({ ...baseline, action: 'rollback', newClaimsStopped: true, priorOwnerReopened: true, exclusiveOwnershipEstablished: false })
  assert.equal(rollback.advisoryChecksPassed, false)
  assert.match(rollback.reasons.join(' '), /exclusive ownership/)
})
