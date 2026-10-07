import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { claimReservation, recordDispatchIntent, recordUnknownOutcome, settleReservation } from '../research-engine/assignment-budget'
import { researchRootAssignmentId } from '../research-engine/bounded-followup'
import type { ResearchWorkItem, Signal } from './contracts'
import { DEFAULT_LOCAL_TRIAGE_CAPACITY, SqliteLocalCapacitySnapshot } from './local-capacity'
import { operatorSignal, operatorWork } from './operator-fixtures.test-support'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'

const NOW = '2026-10-03T15:00:00.000Z'
const EXPIRED = '2026-10-03T14:00:00.000Z'
const FUTURE = '2026-10-03T16:00:00.000Z'

function fixture(source: Signal['sourceType'] = 'polymarket') {
  const dir = mkdtempSync(join(tmpdir(), 'myboon-local-capacity-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'store.sqlite'), source)
  const capacity = new SqliteLocalCapacitySnapshot(store)
  const seed = (id: string, overrides: Partial<ResearchWorkItem> = {}) => {
    store.appendSignal(operatorSignal(source, id))
    const work = operatorWork(source, id, { priorityClass: 'P1', researchDepth: 'light',
      freshnessDeadline: FUTURE, createdAt: EXPIRED, updatedAt: EXPIRED, ...overrides })
    store.admitResearchWork(work)
    return work
  }
  return { store, capacity, seed, snapshot: () => capacity.snapshot({ sourceType: source, now: NOW }),
    dispose() { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

async function dispatched(fx: ReturnType<typeof fixture>, work: ResearchWorkItem, allowance: string, unknown = false) {
  const port = fx.store.researchBudgetStore()
  const key = { rootAssignmentId: researchRootAssignmentId(work), allowanceId: allowance, attemptId: `attempt-${allowance}` }
  const requestDigest = 'a'.repeat(64)
  assert.equal((await claimReservation(port, { ...key, requestDigest, providerRoute: 'fixture',
    approvedLimits: { maxProviderCalls: 1, maxInputTokens: 100, maxOutputTokens: 20, maxIncrementalCostUsdMicros: null },
    nowMs: Date.parse(EXPIRED) })).ok, true)
  assert.equal((await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: Date.parse(EXPIRED) })).ok, true)
  if (unknown) assert.equal((await recordUnknownOutcome(port, key, { ownedEpoch: 1, nowMs: Date.parse(NOW) })).ok, true)
  return { port, key, requestDigest }
}

test('retained expired pending/retry work stops consuming current capacity without changing any row', () => {
  const fx = fixture()
  try {
    const retained = ['research_pending', 'deep_pending', 'synthesis_pending', 'entity_pending', 'retry_wait'].map((status, i) => fx.seed(`expired-${i}`, {
      status: status as ResearchWorkItem['status'], freshnessDeadline: EXPIRED,
      ...(status === 'retry_wait' ? { nextAttemptAt: EXPIRED, retryTargetStatus: 'research_pending' as const } : {}),
    }))
    const before = retained.map(work => fx.store.getResearchWork(work.workId))
    assert.equal(fx.snapshot().byPriority.P1.available, DEFAULT_LOCAL_TRIAGE_CAPACITY.byPriority.P1)
    assert.equal(fx.snapshot().byDepth.light.utilization, 0)
    assert.deepEqual(retained.map(work => fx.store.getResearchWork(work.workId)), before)
  } finally { fx.dispose() }
})

test('the supplied observation clock, exact expiry boundary and fresh future retry govern capacity', () => {
  const fx = fixture()
  try {
    fx.seed('boundary', { freshnessDeadline: NOW })
    fx.seed('future-retry', { status: 'retry_wait', nextAttemptAt: '2026-10-03T15:30:00.000Z', retryTargetStatus: 'research_pending' })
    assert.equal(fx.snapshot().byDepth.light.available, 99)
    assert.equal(fx.capacity.snapshot({ sourceType: 'polymarket', now: EXPIRED }).byDepth.light.available, 98)
    assert.equal(fx.capacity.snapshot({ sourceType: 'polymarket', now: FUTURE }).byDepth.light.available, 100)
    assert.throws(() => fx.capacity.snapshot({ sourceType: 'polymarket', now: 'invalid' }), /timestamp/)
    assert.throws(() => fx.capacity.snapshot({ sourceType: 'news', now: NOW }), /cannot report/)
  } finally { fx.dispose() }
})

test('leased Research and Entity work remains capacity exposure after freshness and lease expiry', () => {
  const fx = fixture()
  try {
    for (const status of ['retrieval_leased', 'deep_leased', 'synthesis_leased', 'entity_leased'] as const) fx.seed(status, {
      status, freshnessDeadline: EXPIRED, leaseOwner: 'still-unreconciled-worker', leaseId: `lease-${status}`, leaseExpiresAt: EXPIRED,
    })
    assert.equal(fx.snapshot().byPriority.P1.available, 46)
    assert.equal(fx.snapshot().byDepth.light.available, 96)
  } finally { fx.dispose() }
})

test('unresolved paid exposure counts expired and terminal work once, then stops counting a durably settled result', async () => {
  const fx = fixture()
  try {
    const retry = fx.seed('unknown-retry', { status: 'retry_wait', freshnessDeadline: EXPIRED, nextAttemptAt: EXPIRED, retryTargetStatus: 'research_pending' })
    await dispatched(fx, retry, 'retry-primary', true)
    await dispatched(fx, retry, 'retry-classifier', true)
    const terminal = fx.seed('terminal-dispatch', { status: 'dead_letter', freshnessDeadline: EXPIRED })
    const active = await dispatched(fx, terminal, 'terminal-primary')
    assert.equal(fx.snapshot().byDepth.light.available, 98)
    const resultRef = 'baseline:terminal-dispatch:packet'
    assert.equal((await settleReservation(active.port, active.key, { requestDigest: active.requestDigest,
      providerResultDigest: 'b'.repeat(64), savedResultRef: resultRef,
      usage: { status: 'unknown', costUsdMicros: null, inputTokens: 10, outputTokens: 5, providerCalls: 1 },
      savedResultSavedAtMs: Date.parse(NOW), verification: { kind: 'durable_matching_response', savedResultRef: resultRef, providerResultDigest: 'b'.repeat(64) },
    })).ok, true)
    assert.equal(fx.snapshot().byDepth.light.available, 99)
    assert.equal(fx.store.getResearchWork(terminal.workId)?.status, 'dead_letter')
  } finally { fx.dispose() }
})

test('fresh leased work and its dispatch are counted once; inherited root IDs retain unresolved exposure', async () => {
  const fx = fixture()
  try {
    const leased = fx.seed('live', { status: 'synthesis_leased', leaseOwner: 'worker', leaseId: 'lease-live', leaseExpiresAt: FUTURE })
    await dispatched(fx, leased, 'live-primary')
    const continuation = fx.seed('continuation', { freshnessDeadline: EXPIRED,
      retrievalPlan: { ...operatorWork('polymarket', 'continuation').retrievalPlan, rootAssignmentId: 'explicit-root-continuation' } })
    await dispatched(fx, continuation, 'continuation-primary', true)
    assert.equal(fx.snapshot().byDepth.light.available, 98)
  } finally { fx.dispose() }
})

test('unbound paid exposure fails capacity closed rather than disappearing from admission', async () => {
  const fx = fixture()
  try {
    await dispatched(fx, operatorWork('polymarket', 'missing-work'), 'missing-primary', true)
    assert.throws(() => fx.snapshot(), /paid exposure has no canonical work binding/)
  } finally { fx.dispose() }
})
