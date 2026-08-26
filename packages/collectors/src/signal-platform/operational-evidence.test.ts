import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertActiveCutoverReceipts } from './cutover-receipt'
import {
  formatOperationalEvidenceJson,
  readOperationalEvidence,
  validateLiveSoakEvidence,
  validateRollbackRehearsalEvidence,
} from './operational-evidence'

const DAY = 24 * 60 * 60_000
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function rollbackEvidence() {
  return {
    schemaVersion: 'myboon.feed_v3_rollback_rehearsal.v1', artifactId: 'rollback-1',
    rehearsedAt: '2026-08-26T00:00:00.000Z', sourceType: 'news', stage: 'research',
    inputSnapshotSha256: HASH_A, outputSnapshotSha256: HASH_B,
    elapsedMs: 10_000, maximumRollbackMs: 60_000,
    before: { canonicalOwnerActive: true, legacyOwnerActive: false, queueRows: 10, leasedRows: 0 },
    after: { canonicalOwnerActive: false, legacyOwnerActive: true, queueRows: 10, leasedRows: 0 },
    queueIntegrityVerified: true, manualSqlRepairs: 0, passed: true, failures: [],
  } as const
}

function soakEvidence() {
  const size = (database: 'news' | 'pipeline') => ({
    database, mainBytesStart: 1000, mainBytesEnd: 1100, walBytesStart: 0, walBytesEnd: 10,
    shmBytesStart: 0, shmBytesEnd: 0, writeErrorsDelta: 0,
  })
  return {
    schemaVersion: 'myboon.feed_v3_live_soak_evidence.v1', artifactId: 'soak-1',
    startedAt: '2026-08-25T00:00:00.000Z', finishedAt: '2026-08-26T00:00:00.000Z',
    durationMs: DAY, sourceTypes: ['news'], inputSnapshotSha256: HASH_A, statusSamplesSha256: HASH_B,
    pm2SnapshotSha256: HASH_A,
    processes: [
      { processNameSha256: HASH_A, restartDelta: 0, uptimeMs: DAY, onlineAtEnd: true, expectedOnline: true },
      { processNameSha256: HASH_B, restartDelta: 0, uptimeMs: DAY, onlineAtEnd: true, expectedOnline: true },
    ],
    queueFreshness: [{ sourceType: 'news', priorityClass: 'P1', researchDepth: 'light',
      sampleCount: 100, p50Ms: 100, p95Ms: 200, p99Ms: 300, oldestMs: 400 }],
    typedFailures: [{ category: 'provider_timeout', count: 1 }],
    providers: [
      { sourceType: 'news', stage: 'research', provider: 'fixture', terminalCalls: 100, succeededCalls: 99, p95LatencyMs: 200 },
      { sourceType: 'news', stage: 'entity', provider: 'fixture', terminalCalls: 99, succeededCalls: 99, p95LatencyMs: 200 },
    ],
    circuits: [
      { sourceType: 'news', stage: 'research', provider: 'fixture', state: 'closed', nextProbeAt: null },
      { sourceType: 'news', stage: 'entity', provider: 'fixture', state: 'closed', nextProbeAt: null },
    ],
    sqlite: [size('news'), size('pipeline')],
    orphanAudit: { artifactSha256: HASH_A, passed: true, suspectedOrphans: 0, unregisteredArtifacts: 0, incomplete: false },
    handoffs: { admitted: 100, researchPackets: 99, entityWorkCompletions: 99, entityMemoryRows: 150, deadLetters: 0,
      latencySampleCount: 99, p50Ms: 100, p95Ms: 200, p99Ms: 300 },
    manualSqlRepairs: 0,
    boundedState: { hermesSessionsStart: 0, hermesSessionsEnd: 0, temporaryArtifactsStart: 0, temporaryArtifactsEnd: 0 },
    thresholds: { maximumRestartDelta: 0, maximumQueueP95Ms: 1000, minimumProviderSuccessRate: 0.95,
      maximumProviderP95LatencyMs: 1000, maximumSqliteGrowthBytes: 1000,
      minimumMemoryHandoffRate: 0.95, maximumDeadLetterRate: 0.01, maximumBoundedStateGrowth: 0 },
    passed: true, failures: [],
  } as const
}

test('validates a digest-bound rollback rehearsal and binds to a cutover receipt end to end', () => {
  const evidence = validateRollbackRehearsalEvidence(rollbackEvidence())
  assert.equal(evidence.passed, true)
  assert.throws(() => validateRollbackRehearsalEvidence({
    ...evidence, after: { ...evidence.after, canonicalOwnerActive: true },
  }), /cannot pass/)

  const dir = mkdtempSync(join(tmpdir(), 'feed-v3-receipt-binding-'))
  try {
    const rollbackBytes = JSON.stringify(evidence)
    const shadowBytes = JSON.stringify({
      schemaVersion: 'myboon.feed_v3_shadow_evaluation.v1', sourceType: 'news', stage: 'research',
      sampleSize: 1000, passed: true,
    })
    writeFileSync(join(dir, 'rollback.json'), rollbackBytes)
    writeFileSync(join(dir, 'shadow.json'), shadowBytes)
    const manifest = {
      schemaVersion: 'myboon.feed_v3_cutover_manifest.v1', receipts: [{
        schemaVersion: 'myboon.feed_v3_cutover_receipt.v1', receiptId: 'receipt-1', sourceType: 'news',
        stage: 'research', approvedAt: '2026-08-26T01:00:00.000Z', approvedBy: 'reviewer',
        attestationMode: 'manual_review', expiresAt: '2026-08-28T00:00:00.000Z',
        shadowEvaluation: { sampleSize: 1000, passed: true, artifactPath: 'shadow.json',
          artifactSchemaVersion: 'myboon.feed_v3_shadow_evaluation.v1',
          artifactSha256: createHash('sha256').update(shadowBytes).digest('hex') },
        rollbackRehearsal: { rehearsedAt: evidence.rehearsedAt, passed: true, artifactPath: 'rollback.json',
          artifactSchemaVersion: evidence.schemaVersion,
          artifactSha256: createHash('sha256').update(rollbackBytes).digest('hex') },
      }],
    }
    const manifestPath = join(dir, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    assert.doesNotThrow(() => assertActiveCutoverReceipts({
      path: manifestPath, required: [{ sourceType: 'news', stage: 'research' }],
      now: new Date('2026-08-27T00:00:00.000Z'),
    }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('live soak evidence requires all PRD measurements and derives pass from them', () => {
  const evidence = validateLiveSoakEvidence(soakEvidence())
  assert.equal(evidence.durationMs, DAY)
  assert.throws(() => validateLiveSoakEvidence({ ...evidence, durationMs: DAY - 1 }), /exactly match/)
  assert.throws(() => validateLiveSoakEvidence({
    ...evidence, sqlite: evidence.sqlite.map((row, index) => index === 0 ? { ...row, writeErrorsDelta: 1 } : row),
  }), /cannot pass/)
  assert.equal(evidence.handoffs.entityMemoryRows, 150, 'one packet/work completion may write multiple memories')
  assert.throws(() => validateLiveSoakEvidence({
    ...evidence,
    boundedState: {
      hermesSessionsStart: 10, hermesSessionsEnd: 0,
      temporaryArtifactsStart: 0, temporaryArtifactsEnd: 5,
    },
  }), /cannot pass/, 'a decrease in one bounded state must not mask growth in another')
  const { orphanAudit: _missing, ...superficial } = evidence
  assert.throws(() => validateLiveSoakEvidence(superficial), /object/)
})

test('file reader requires an explicit absolute artifact and formatter redacts credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-v3-evidence-'))
  try {
    const path = join(dir, 'rollback.json')
    writeFileSync(path, JSON.stringify(rollbackEvidence()))
    const evidence = readOperationalEvidence({ kind: 'rollback', inputPath: path })
    assert.equal(evidence.artifactId, 'rollback-1')
    assert.throws(() => readOperationalEvidence({ kind: 'rollback', inputPath: 'relative.json' }), /absolute/)
    const json = formatOperationalEvidenceJson(
      { ...evidence, secret: 'sk-this-must-not-leak' } as unknown as typeof evidence,
    )
    assert.equal(json.includes('sk-this-must-not-leak'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
