import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteClassificationControlPlane } from './classification-store'
import type {
  ClassificationAttemptRecord,
  ClassificationCapacityPolicy,
} from './classification-types'

interface TestDatabase {
  exec(sql: string): void
  close(): void
}
const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new(path: string) => TestDatabase }

const POLICY: ClassificationCapacityPolicy = {
  liveConcurrency: 1, providerMaxCalls: 20, workloadMaxCalls: 10, windowMs: 60_000,
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
    assert.throws(() => second.acquire({ workload: 'research.followup_value', target: TARGET, mode: 'live', policy: POLICY }), /concurrency limit/)
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
    store.acquire({ workload: 'research.followup_value', target: TARGET, mode: 'live', policy })
      .release({ success: true, retryableFailure: false })
    assert.throws(
      () => store.acquire({ workload: 'research.followup_value', target: TARGET, mode: 'live', policy }),
      /provider-global rate limit/,
    )
  } finally { store.close() }
})

test('historical shadow attempts remain readable under the versioned audit key', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'classification-')), 'control.sqlite')
  const store = new SqliteClassificationControlPlane(path)
  const attempt = (attemptNumber: number): ClassificationAttemptRecord => ({
    schemaVersion: 'myboon.classification_attempt.v2',
    decisionId: 'decision-retry', executionMode: 'shadow', attemptNumber,
    workload: 'research.followup_value', decisionVersion: 'v1', stateDigest: 'digest',
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
