import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteClassificationControlPlane, SqliteClassificationShadowWriter } from './classification-store'
import type {
  ClassificationAttemptRecord,
  ClassificationCapacityPolicy,
  ClassificationShadowEnvelope,
} from './classification-types'

interface TestDatabase {
  exec(sql: string): void
  close(): void
}
const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new(path: string) => TestDatabase }

const POLICY: ClassificationCapacityPolicy = {
  liveConcurrency: 1, shadowConcurrency: 1, providerMaxCalls: 20, workloadMaxCalls: 10, windowMs: 60_000,
  circuitFailureThreshold: 2, circuitCooldownMs: 5_000, leaseMs: 10_000,
}
const TARGET = { provider: 'typesafe', model: 'jev-1.13.0' }

test('SQLite capacity is deployment-wide across process-local instances', () => {
  let now = 1_000
  const path = join(mkdtempSync(join(tmpdir(), 'classification-')), 'control.sqlite')
  const first = new SqliteClassificationControlPlane(path, { now: () => now })
  const second = new SqliteClassificationControlPlane(path, { now: () => now })
  try {
    const lease = first.acquire({ workload: 'research.novelty', target: TARGET, mode: 'live', policy: POLICY })
    assert.throws(() => second.acquire({ workload: 'entity.catalog_identity', target: TARGET, mode: 'live', policy: POLICY }), /concurrency limit/)
    const reservedShadow = second.acquire({ workload: 'entity.catalog_identity', target: TARGET, mode: 'shadow', policy: POLICY })
    reservedShadow.release({ success: true, retryableFailure: false })
    lease.release({ success: true, retryableFailure: false })
    const next = second.acquire({ workload: 'research.novelty', target: TARGET, mode: 'live', policy: POLICY })
    next.release({ success: true, retryableFailure: false })
    now += 1
  } finally { first.close(); second.close() }
})

test('SQLite circuit permits exactly one half-open probe', () => {
  let now = 10_000
  const path = join(mkdtempSync(join(tmpdir(), 'classification-')), 'control.sqlite')
  const store = new SqliteClassificationControlPlane(path, { now: () => now })
  try {
    for (let index = 0; index < 2; index += 1) {
      const lease = store.acquire({ workload: 'research.novelty', target: TARGET, mode: 'live', policy: POLICY })
      lease.release({ success: false, retryableFailure: true })
    }
    assert.throws(() => store.acquire({ workload: 'research.novelty', target: TARGET, mode: 'live', policy: POLICY }), /circuit is open/)
    now += POLICY.circuitCooldownMs
    const probe = store.acquire({ workload: 'research.novelty', target: TARGET, mode: 'live', policy: POLICY })
    assert.throws(() => store.acquire({ workload: 'research.novelty', target: TARGET, mode: 'live', policy: POLICY }), /circuit is open/)
    probe.release({ success: true, retryableFailure: false })
  } finally { store.close() }
})

test('an expired crashed half-open probe is reclaimed instead of wedging the circuit', () => {
  let now = 30_000
  const path = join(mkdtempSync(join(tmpdir(), 'classification-')), 'control.sqlite')
  const store = new SqliteClassificationControlPlane(path, { now: () => now })
  try {
    for (let index = 0; index < 2; index += 1) {
      const lease = store.acquire({ workload: 'research.novelty', target: TARGET, mode: 'live', policy: POLICY })
      lease.release({ success: false, retryableFailure: true })
    }
    now += POLICY.circuitCooldownMs
    store.acquire({ workload: 'research.novelty', target: TARGET, mode: 'live', policy: POLICY })
    now += POLICY.leaseMs + 1
    const recoveredProbe = store.acquire({ workload: 'research.novelty', target: TARGET, mode: 'live', policy: POLICY })
    recoveredProbe.release({ success: true, retryableFailure: false })
  } finally { store.close() }
})

test('rate admission enforces provider-global and workload-specific windows independently', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'classification-')), 'control.sqlite')
  const store = new SqliteClassificationControlPlane(path)
  const policy = { ...POLICY, providerMaxCalls: 3, workloadMaxCalls: 2 }
  try {
    for (let index = 0; index < 2; index += 1) {
      store.acquire({ workload: 'research.novelty', target: TARGET, mode: 'live', policy })
        .release({ success: true, retryableFailure: false })
    }
    assert.throws(
      () => store.acquire({ workload: 'research.novelty', target: TARGET, mode: 'live', policy }),
      /workload rate limit/,
    )
    store.acquire({ workload: 'entity.catalog_identity', target: TARGET, mode: 'live', policy })
      .release({ success: true, retryableFailure: false })
    assert.throws(
      () => store.acquire({ workload: 'entity.catalog_identity', target: TARGET, mode: 'live', policy }),
      /provider-global rate limit/,
    )
  } finally { store.close() }
})

test('shadow outbox is immutable, leased, retryable, and crash-reclaimable', () => {
  let now = 20_000
  const path = join(mkdtempSync(join(tmpdir(), 'classification-')), 'control.sqlite')
  const store = new SqliteClassificationControlPlane(path, { now: () => now })
  const envelope: ClassificationShadowEnvelope = {
    decisionId: 'decision-1', workload: 'entity.catalog_identity', decisionVersion: 'v1',
    state: { pair: 'a:b' }, stateDigest: 'digest', stableDecisionKey: 'a:b',
    correlationIds: {}, deadlineMs: 1_000, createdAt: new Date(now).toISOString(),
  }
  try {
    store.enqueue(envelope)
    store.enqueue(envelope)
    assert.throws(() => store.enqueue({ ...envelope, state: { pair: 'changed' } }), /Conflicting/)
    const first = store.claimShadow(100)!
    assert.equal(first.envelope.decisionId, 'decision-1')
    assert.equal(store.claimShadow(100), null)
    now += 101
    const reclaimed = store.claimShadow(100)!
    assert.equal(reclaimed.attempt, 2)
    store.failShadow('decision-1', reclaimed.leaseToken, 'temporary', now + 50)
    assert.equal(store.claimShadow(100), null)
    now += 50
    const retry = store.claimShadow(100)!
    store.completeShadow('decision-1', retry.leaseToken)
    assert.equal(store.claimShadow(100), null)
  } finally { store.close() }
})

test('shadow retry attempts are independently auditable under one decision ID', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'classification-')), 'control.sqlite')
  const store = new SqliteClassificationControlPlane(path)
  const attempt = (attemptNumber: number): ClassificationAttemptRecord => ({
    schemaVersion: 'myboon.classification_attempt.v2',
    decisionId: 'decision-retry', executionMode: 'shadow', attemptNumber,
    workload: 'entity.catalog_identity', decisionVersion: 'v1', stateDigest: 'digest',
    stableDecisionKey: 'pair', configuredPrimary: TARGET, configuredFallback: null,
    actualProvider: 'typesafe', actualModel: 'jev-1.13.0', fallbackUsed: false,
    fallbackReason: null, status: 'failed', failureCategory: 'provider_timeout',
    decision: null, answers: null, calls: [], startedAt: `2026-09-23T00:00:0${attemptNumber}.000Z`,
    finishedAt: `2026-09-23T00:00:0${attemptNumber}.100Z`, durationMs: 100,
  })
  try {
    store.recordAttempt(attempt(1))
    store.recordAttempt(attempt(2))
    assert.equal(store.getAttempt('decision-retry', 'shadow', 1)?.attemptNumber, 1)
    assert.equal(store.getAttempt('decision-retry', 'shadow')?.attemptNumber, 2)
  } finally { store.close() }
})

test('existing v1 attempt rows migrate to the retry-aware v2 audit key', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'classification-')), 'control.sqlite')
  const legacy = new DatabaseSync(path)
  legacy.exec(`CREATE TABLE classification_attempts (
    decision_id TEXT NOT NULL,
    execution_mode TEXT NOT NULL,
    workload TEXT NOT NULL,
    decision_version TEXT NOT NULL,
    status TEXT NOT NULL,
    canonical_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(decision_id, execution_mode)
  );
  INSERT INTO classification_attempts VALUES (
    'legacy-decision', 'shadow', 'entity.catalog_identity', 'v1', 'failed',
    '{"schemaVersion":"myboon.classification_attempt.v1","decisionId":"legacy-decision","executionMode":"shadow"}',
    '2026-09-23T00:00:00.000Z'
  );`)
  legacy.close()
  const store = new SqliteClassificationControlPlane(path)
  try {
    const migrated = store.getAttempt('legacy-decision', 'shadow')
    assert.equal(migrated?.schemaVersion, 'myboon.classification_attempt.v2')
    assert.equal(migrated?.attemptNumber, 1)
  } finally { store.close() }
})

test('shadow outbox prunes terminal snapshots by row, byte, and age bounds', () => {
  let now = 20_000
  const path = join(mkdtempSync(join(tmpdir(), 'classification-')), 'control.sqlite')
  const store = new SqliteClassificationControlPlane(path, {
    now: () => now,
    shadowRetention: { maxRows: 2, maxBytes: 10_000, terminalRetentionMs: 100 },
  })
  const envelope = (decisionId: string): ClassificationShadowEnvelope => ({
    decisionId, workload: 'entity.catalog_identity', decisionVersion: 'v1',
    state: { pair: decisionId }, stateDigest: 'digest', stableDecisionKey: decisionId,
    correlationIds: {}, deadlineMs: 1_000, createdAt: new Date(now).toISOString(),
  })
  try {
    for (const id of ['decision-1', 'decision-2']) {
      store.enqueue(envelope(id))
      const claimed = store.claimShadow()!
      store.completeShadow(id, claimed.leaseToken)
    }
    store.enqueue(envelope('decision-3'))
    assert.deepEqual(store.shadowOutboxStats(), {
      rows: 2,
      bytes: store.shadowOutboxStats().bytes,
      pending: 1,
      leased: 0,
      terminal: 1,
    })
    const third = store.claimShadow()!
    store.completeShadow('decision-3', third.leaseToken)
    now += 101
    store.pruneShadowOutbox()
    assert.equal(store.shadowOutboxStats().rows, 0)
  } finally { store.close() }

  const bytePath = join(mkdtempSync(join(tmpdir(), 'classification-')), 'control.sqlite')
  const probe = envelope('byte-one')
  const approximateEnvelopeBytes = Buffer.byteLength(JSON.stringify(probe))
  const byteStore = new SqliteClassificationControlPlane(bytePath, {
    now: () => now,
    shadowRetention: { maxRows: 10, maxBytes: approximateEnvelopeBytes + 80, terminalRetentionMs: 10_000 },
  })
  try {
    byteStore.enqueue(probe)
    const claimed = byteStore.claimShadow()!
    byteStore.completeShadow(probe.decisionId, claimed.leaseToken)
    byteStore.enqueue(envelope('byte-two'))
    const stats = byteStore.shadowOutboxStats()
    assert.equal(stats.rows, 1)
    assert.equal(stats.pending, 1)
  } finally { byteStore.close() }
})

test('dedicated shadow writer fails immediately instead of waiting on the control-plane busy timeout', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'classification-')), 'control.sqlite')
  const store = new SqliteClassificationControlPlane(path)
  const writer = new SqliteClassificationShadowWriter(path)
  const locker = new DatabaseSync(path)
  try {
    locker.exec('BEGIN IMMEDIATE')
    const startedAt = Date.now()
    assert.throws(() => writer.enqueue({
      decisionId: 'locked', workload: 'entity.catalog_identity', decisionVersion: 'v1',
      state: {}, stateDigest: 'digest', stableDecisionKey: 'locked', correlationIds: {},
      deadlineMs: 1_000, createdAt: new Date().toISOString(),
    }), /locked/)
    assert.ok(Date.now() - startedAt < 250, 'zero-wait handoff must not inherit the 5-second busy timeout')
    locker.exec('ROLLBACK')
  } finally { locker.close(); writer.close(); store.close() }
})
