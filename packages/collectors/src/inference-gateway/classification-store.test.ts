import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteClassificationControlPlane } from './classification-store'
import type { ClassificationCapacityPolicy, ClassificationShadowEnvelope } from './classification-types'

const POLICY: ClassificationCapacityPolicy = {
  liveConcurrency: 1, shadowConcurrency: 1, maxCalls: 10, windowMs: 60_000,
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
