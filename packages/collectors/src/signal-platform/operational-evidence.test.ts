import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertActiveCutoverReceipts } from './cutover-receipt'
import {
  formatOperationalEvidenceJson,
  validateLiveLoadEvidence,
  validateLiveSoakEvidence,
  validateProviderOutageRehearsalEvidence,
  validateRollbackRehearsalEvidence,
} from './operational-evidence'
import { readOperationalEvidence, readOperationalEvidenceBundle } from './operational-evidence-bundle'
import { validateOperationalEvidencePolicy } from './operational-evidence-policy'

const DAY = 24 * 60 * 60_000
const HASH_A = 'a'.repeat(64)

function policy(kind: 'rollback' | 'live-load' | 'live-soak' | 'provider-outage') {
  const perKind = {
    rollback: { maximumRollbackMs: 60_000 },
    'live-load': {
      minimumDurationMs: 300_000, minimumArrivalMultiplier: 2, minimumCompletionRatio: 0.99,
      maximumQueueP95Ms: 1_000, maximumQueueDepth: 25, maximumTerminalFailures: 0,
      maximumDuplicateArtifacts: 0, maximumSqliteWriteErrors: 0,
    },
    'live-soak': {
      minimumDurationMs: DAY, maximumSampleGapMs: 60_000, minimumStatusSamples: 1_441,
      minimumQueueSamplesPerLane: 100, maximumRestartDelta: 0, maximumQueueP95Ms: 1_000,
      minimumProviderSuccessRate: 0.95, maximumProviderP95LatencyMs: 1_000,
      maximumSqliteGrowthBytes: 1_000, minimumMemoryHandoffRate: 0.95,
      maximumDeadLetterRate: 0.01, maximumBoundedStateGrowth: 0,
    },
    'provider-outage': {
      minimumCooldownMs: 600_000, maximumCooldownMs: 900_000, minimumCohortSize: 10,
      maximumRecoveryMs: 60_000,
    },
  }
  return validateOperationalEvidencePolicy({
    schemaVersion: 'myboon.feed_v3_operational_evidence_policy.v1', policyId: `${kind}.policy.v1`,
    evidenceKind: kind, attestationMode: 'manual_review', reviewedAt: '2026-08-24T00:00:00.000Z', reviewedBySha256: HASH_A,
    expiresAt: '2026-09-30T00:00:00.000Z', thresholds: perKind[kind],
  })
}

function reference(path = '/private/raw.json', sha = HASH_A) {
  return { artifactPath: path, artifactSha256: sha }
}

function binding(kind: 'rollback' | 'live-load' | 'live-soak' | 'provider-outage', policySha256 = HASH_A) {
  return { policyId: `${kind}.policy.v1`, policySha256 }
}

function rollbackEvidence(policySha256 = HASH_A) {
  return {
    schemaVersion: 'myboon.feed_v3_rollback_rehearsal.v1', artifactId: 'rollback-1', ...binding('rollback', policySha256),
    rehearsedAt: '2026-08-26T00:00:00.000Z', sourceType: 'news', stage: 'research',
    rawArtifacts: { inputSnapshot: reference('/private/input.json'), outputSnapshot: reference('/private/output.json') },
    elapsedMs: 10_000,
    before: { canonicalOwnerActive: true, legacyOwnerActive: false, queueRows: 10, leasedRows: 0 },
    after: { canonicalOwnerActive: false, legacyOwnerActive: true, queueRows: 10, leasedRows: 0 },
    queueIntegrityVerified: true, manualSqlRepairs: 0, passed: true, failures: [],
  }
}

function soakEvidence() {
  const size = (database: 'news' | 'pipeline') => ({ database, mainBytesStart: 1000, mainBytesEnd: 1100,
    walBytesStart: 0, walBytesEnd: 10, shmBytesStart: 0, shmBytesEnd: 0, writeErrorsDelta: 0 })
  return {
    schemaVersion: 'myboon.feed_v3_live_soak_evidence.v1', artifactId: 'soak-1', ...binding('live-soak'),
    startedAt: '2026-08-25T00:00:00.000Z', finishedAt: '2026-08-26T00:00:00.000Z', durationMs: DAY,
    sourceTypes: ['news'], rawArtifacts: {
      inputSnapshot: reference('/private/input.json'), statusSamples: reference('/private/status.json'),
      pm2Snapshot: reference('/private/pm2.json'), orphanAudit: reference('/private/orphan.json'),
    },
    sampling: { statusSampleCount: 1_441, firstSampleAt: '2026-08-25T00:00:00.000Z',
      lastSampleAt: '2026-08-26T00:00:00.000Z', maximumGapMs: 60_000 },
    processes: [{ processNameSha256: HASH_A, restartDelta: 0, uptimeMs: DAY, onlineAtEnd: true, expectedOnline: true }],
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
    orphanAudit: { passed: true, suspectedOrphans: 0, unregisteredArtifacts: 0, incomplete: false },
    handoffs: { admitted: 100, researchPackets: 99, entityWorkCompletions: 99, entityMemoryRows: 150,
      deadLetters: 0, latencySampleCount: 99, p50Ms: 100, p95Ms: 200, p99Ms: 300 },
    manualSqlRepairs: 0,
    boundedState: { hermesSessionsStart: 0, hermesSessionsEnd: 0, temporaryArtifactsStart: 0, temporaryArtifactsEnd: 0 },
    passed: true, failures: [],
  }
}

function outageEvidence() {
  return {
    schemaVersion: 'myboon.feed_v3_provider_outage_rehearsal.v1', artifactId: 'outage-1', ...binding('provider-outage'),
    sourceType: 'news', stage: 'research', failureCategory: 'provider_timeout',
    startedAt: '2026-08-26T00:00:00.000Z', circuitOpenedAt: '2026-08-26T00:01:00.000Z',
    probeAllowedAt: '2026-08-26T00:11:00.000Z', recoveredAt: '2026-08-26T00:11:10.000Z',
    finishedAt: '2026-08-26T00:20:00.000Z', configuredCooldownMs: 600_000,
    rawArtifacts: { cohort: reference('/private/cohort.json'), statusSamples: reference('/private/status.json'),
      traceSamples: reference('/private/trace.json') }, cohortSize: 10,
    outageInjection: { attemptedItems: 1, retryableFailures: 1, providerCalls: 1 },
    duringOpen: { observationCount: 2, observationDurationMs: 600_000, pendingItems: 10,
      claimedItems: 0, terminalFailures: 0, attemptDelta: 0, providerCalls: 0 },
    probe: { calls: 1, succeeded: true },
    afterRecovery: { pendingItems: 0, retryingItems: 0, completedItems: 10, deadLetterItems: 0,
      duplicateArtifacts: 0, terminalOutageFailures: 0 },
    manualSqlRepairs: 0, passed: true, failures: [],
  }
}

test('validators reject unknown keys at every contract boundary', () => {
  assert.throws(() => validateRollbackRehearsalEvidence({ ...rollbackEvidence(), surprise: true }, policy('rollback')), /exactly/)
  assert.throws(() => validateRollbackRehearsalEvidence({
    ...rollbackEvidence(), before: { ...rollbackEvidence().before, surprise: true },
  }, policy('rollback')), /exactly/)
  assert.throws(() => validateOperationalEvidencePolicy({
    ...policy('rollback'), thresholds: { maximumRollbackMs: 10, unreviewedOverride: true },
  }), /exactly/)
})

test('rollback uses the independently reviewed maximum and remains cutover-bindable', () => {
  const evidence = validateRollbackRehearsalEvidence(rollbackEvidence(), policy('rollback'))
  assert.equal(evidence.passed, true)
  assert.throws(() => validateRollbackRehearsalEvidence({ ...evidence, elapsedMs: 60_001 }, policy('rollback')), /cannot pass/)

  const dir = mkdtempSync(join(tmpdir(), 'feed-v3-receipt-binding-'))
  try {
    const rollbackBytes = JSON.stringify(evidence)
    const shadowBytes = JSON.stringify({ schemaVersion: 'myboon.feed_v3_shadow_evaluation.v1', sourceType: 'news',
      stage: 'research', sampleSize: 1000, passed: true })
    writeFileSync(join(dir, 'rollback.json'), rollbackBytes); writeFileSync(join(dir, 'shadow.json'), shadowBytes)
    const manifest = { schemaVersion: 'myboon.feed_v3_cutover_manifest.v1', receipts: [{
      schemaVersion: 'myboon.feed_v3_cutover_receipt.v1', receiptId: 'receipt-1', sourceType: 'news',
      stage: 'research', approvedAt: '2026-08-26T01:00:00.000Z', approvedBy: 'reviewer',
      attestationMode: 'manual_review', expiresAt: '2026-08-28T00:00:00.000Z',
      shadowEvaluation: { sampleSize: 1000, passed: true, artifactPath: 'shadow.json',
        artifactSchemaVersion: 'myboon.feed_v3_shadow_evaluation.v1', artifactSha256: sha(shadowBytes) },
      rollbackRehearsal: { rehearsedAt: evidence.rehearsedAt, passed: true, artifactPath: 'rollback.json',
        artifactSchemaVersion: evidence.schemaVersion, artifactSha256: sha(rollbackBytes) },
    }] }
    const manifestPath = join(dir, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest))
    assert.doesNotThrow(() => assertActiveCutoverReceipts({ path: manifestPath,
      required: [{ sourceType: 'news', stage: 'research' }], now: new Date('2026-08-27T00:00:00.000Z') }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('24-hour soak requires continuous samples, uptime, lane coverage, and exact handoff sampling', () => {
  const evidence = validateLiveSoakEvidence(soakEvidence(), policy('live-soak'))
  assert.equal(evidence.durationMs, DAY)
  assert.throws(() => validateLiveSoakEvidence({ ...evidence,
    sampling: { ...evidence.sampling, firstSampleAt: '2026-08-25T00:01:00.000Z' } }, policy('live-soak')), /cannot pass/)
  assert.throws(() => validateLiveSoakEvidence({ ...evidence,
    processes: evidence.processes.map((row) => ({ ...row, uptimeMs: DAY - 1 })) }, policy('live-soak')), /cannot pass/)
  assert.throws(() => validateLiveSoakEvidence({ ...evidence,
    handoffs: { ...evidence.handoffs, latencySampleCount: 98 } }, policy('live-soak')), /cover every/)
})

test('provider outage proves a real trigger, cooldown observation, and full cohort recovery', () => {
  const evidence = validateProviderOutageRehearsalEvidence(outageEvidence(), policy('provider-outage'))
  assert.equal(evidence.passed, true)
  assert.throws(() => validateProviderOutageRehearsalEvidence({ ...evidence,
    outageInjection: { ...evidence.outageInjection, retryableFailures: 0 } }, policy('provider-outage')), /positive/)
  assert.throws(() => validateProviderOutageRehearsalEvidence({ ...evidence,
    duringOpen: { ...evidence.duringOpen, observationDurationMs: 599_999 } }, policy('provider-outage')), /cannot pass/)
  assert.throws(() => validateProviderOutageRehearsalEvidence({ ...evidence,
    afterRecovery: { ...evidence.afterRecovery, pendingItems: 5, completedItems: 5 } }, policy('provider-outage')), /cannot pass/)
})

test('live-load evidence requires measured two-times baseline capacity', () => {
  const value = {
    schemaVersion: 'myboon.feed_v3_live_load_evidence.v1', artifactId: 'load-1', ...binding('live-load'),
    startedAt: '2026-08-26T00:00:00.000Z', finishedAt: '2026-08-26T00:05:00.000Z', durationMs: 300_000,
    sourceTypes: ['news'], rawArtifacts: { arrivalSamples: reference('/private/arrivals.json'),
      statusSamples: reference('/private/status.json'), traceSamples: reference('/private/traces.json') },
    baselineAdmittedArrivalsPerSecond: 2, measuredAdmittedArrivalsPerSecond: 4,
    offeredItems: 1200, admittedItems: 1200, completedItems: 1200, queueP95Ms: 200,
    maximumQueueDepth: 10, terminalFailures: 0, duplicateArtifacts: 0, sqliteWriteErrors: 0,
    passed: true, failures: [],
  }
  assert.equal(validateLiveLoadEvidence(value, policy('live-load')).passed, true)
  assert.throws(() => validateLiveLoadEvidence({ ...value, measuredAdmittedArrivalsPerSecond: 3.99,
    admittedItems: 1197, completedItems: 1197 }, policy('live-load')), /cannot pass/)
})

test('bundle recomputes policy and raw artifact SHA-256 values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-v3-evidence-bundle-'))
  try {
    const rawPaths = [join(dir, 'input.json'), join(dir, 'output.json')]
    for (const path of rawPaths) writeFileSync(path, `raw:${path}`)
    const reviewedPolicy = policy('rollback'); const policyBytes = JSON.stringify(reviewedPolicy)
    const policyPath = join(dir, 'policy.json'); writeFileSync(policyPath, policyBytes)
    const evidenceValue = { ...rollbackEvidence(sha(policyBytes)), rawArtifacts: {
      inputSnapshot: reference(rawPaths[0], sha(`raw:${rawPaths[0]}`)),
      outputSnapshot: reference(rawPaths[1], sha(`raw:${rawPaths[1]}`)),
    } }
    const evidencePath = join(dir, 'evidence.json'); writeFileSync(evidencePath, JSON.stringify(evidenceValue))
    const bundle = readOperationalEvidenceBundle({ kind: 'rollback', evidencePath, policyPath })
    assert.equal(bundle.verifiedRawArtifacts.length, 2)
    assert.equal(readOperationalEvidence({ kind: 'rollback', inputPath: evidencePath, policyPath }).artifactId, 'rollback-1')
    writeFileSync(rawPaths[0]!, 'tampered')
    assert.throws(() => readOperationalEvidenceBundle({ kind: 'rollback', evidencePath, policyPath }), /SHA-256 mismatch/)
    assert.throws(() => readOperationalEvidence({ kind: 'rollback', inputPath: 'relative.json', policyPath }), /absolute/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('formatter redacts credentials from validated output', () => {
  const evidence = validateRollbackRehearsalEvidence(rollbackEvidence(), policy('rollback'))
  const json = formatOperationalEvidenceJson({ ...evidence, secret: 'sk-this-must-not-leak' } as unknown as typeof evidence)
  assert.equal(json.includes('sk-this-must-not-leak'), false)
})

function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }
