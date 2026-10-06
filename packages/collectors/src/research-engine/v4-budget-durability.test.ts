import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import {
  claimReservation, recordDispatchIntent, recordUnknownOutcome, settleReservation,
  type D2Usage, type D2AssignmentLimitsSnapshot, type BudgetStorePort,
} from './assignment-budget'
import { v4Database } from './v4-test-fixtures'

const STAGE = { maxProviderCalls: 2, maxInputTokens: 100, maxOutputTokens: 40, maxIncrementalCostUsdMicros: 20 as number | null }
const ROOT: D2AssignmentLimitsSnapshot = { ...STAGE, policyVersion: 'approved.test.v1', maxProviderCalls: 3,
  maxInputTokens: 150, maxOutputTokens: 60, maxIncrementalCostUsdMicros: 30 }
const claim = (port: BudgetStorePort, allowanceId: string, root = ROOT, stage = STAGE, attemptId = 'attempt-1') =>
  claimReservation(port, { rootAssignmentId: 'root-shared', allowanceId, attemptId, requestDigest: 'request-digest',
    providerRoute: 'mock-only', approvedLimits: stage, assignmentLimits: root, nowMs: 1 })

test('operational hold totals include a paid outcome beyond the first 1000 historical reservations', async () => {
  const fx = v4Database()
  try {
    const port = fx.store.researchBudgetStore()
    for (let index = 0; index < 1_001; index++) {
      assert.equal((await claimReservation(port, {
        rootAssignmentId: `root-${String(index).padStart(4, '0')}`, allowanceId: 'primary', attemptId: 'attempt',
        requestDigest: 'digest', providerRoute: 'offline', approvedLimits: STAGE, assignmentLimits: ROOT, nowMs: 1,
      })).ok, true)
    }
    const key = { rootAssignmentId: 'root-1000', allowanceId: 'primary', attemptId: 'attempt' }
    assert.equal((await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 2 })).ok, true)
    assert.equal((await recordUnknownOutcome(port, key, { ownedEpoch: 1, nowMs: 3 })).ok, true)
    assert.equal(fx.store.listResearchReservations(1_000).filter(row => row.state === 'execution_outcome_unknown').length, 0)
    assert.equal(fx.store.countUnresolvedResearchReservations(), 1)
  } finally { fx.close() }
})

async function settle(port: BudgetStorePort, allowanceId: string, usage: D2Usage) {
  const key = { rootAssignmentId: 'root-shared', allowanceId, attemptId: 'attempt-1' }
  assert.equal((await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 2 })).ok, true)
  return settleReservation(port, key, { requestDigest: 'request-digest', providerResultDigest: 'saved-digest',
    savedResultRef: 'saved-packet', usage, savedResultSavedAtMs: 3, verification: { kind: 'transport_response_saved' } })
}

test('SQLite competing connections reserve a shared root atomically including fallback exposure', async () => {
  const fx = v4Database()
  const other = new SqliteSignalPlatformStore(fx.path, 'news')
  try {
    const results = await Promise.all([claim(fx.store.researchBudgetStore(), 'novelty'), claim(other.researchBudgetStore(), 'synthesis')])
    assert.equal(results.filter((result) => result.ok).length, 1)
    assert.equal(fx.store.listResearchReservations(100).length, 1)
    // Each stage reserves its two-call ceiling. The root has three calls,
    // so fallback exposure cannot be hidden behind distinct stage keys.
    assert.equal(results.some((result) => !result.ok && result.code === 'store_insert_conflict'), true)
  } finally { other.close(); fx.close() }
})

test('SQLite enforces each aggregate token/cost ceiling independently', async () => {
  const fx = v4Database()
  try {
    for (const dimension of ['maxInputTokens', 'maxOutputTokens', 'maxIncrementalCostUsdMicros'] as const) {
      const root = { ...ROOT, maxProviderCalls: 10, maxInputTokens: 1_000, maxOutputTokens: 1_000,
        maxIncrementalCostUsdMicros: 1_000, [dimension]: STAGE[dimension] }
      const port = fx.store.researchBudgetStore()
      const rootId = `root-${dimension}`
      const reserve = (allowanceId: string) => claimReservation(port, { rootAssignmentId: rootId, allowanceId,
        attemptId: 'attempt', requestDigest: 'digest', providerRoute: 'offline', approvedLimits: STAGE,
        assignmentLimits: root, nowMs: 1 })
      assert.equal((await reserve('first')).ok, true)
      assert.equal((await reserve('second')).ok, false, dimension)
    }
  } finally { fx.close() }
})

test('same allowance cannot be concurrently minted by a second attempt or reused after settlement', async () => {
  const fx = v4Database()
  const other = new SqliteSignalPlatformStore(fx.path, 'news')
  try {
    const results = await Promise.all([claim(fx.store.researchBudgetStore(), 'followup'),
      claim(other.researchBudgetStore(), 'followup', ROOT, STAGE, 'attempt-2')])
    assert.equal(results.filter((result) => result.ok).length, 1)
    const row = fx.store.listResearchReservations(100)[0]
    const key = { rootAssignmentId: row.rootAssignmentId, allowanceId: row.allowanceId, attemptId: row.attemptId }
    const port = fx.store.researchBudgetStore()
    assert.equal((await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 2 })).ok, true)
    assert.equal((await settleReservation(port, key, { requestDigest: 'request-digest', providerResultDigest: 'response', savedResultRef: 'packet',
      usage: { status: 'unknown', costUsdMicros: null, providerCalls: 1, inputTokens: 10, outputTokens: 5 },
      savedResultSavedAtMs: 3, verification: { kind: 'transport_response_saved' } })).ok, true)
    const next = await claim(port, 'followup', ROOT, STAGE, 'new-continuation-attempt')
    assert.equal(next.ok, false)
    if (!next.ok) assert.equal(next.code, 'allowance_consumed')
  } finally { other.close(); fx.close() }
})

test('measured usage releases only unused root capacity while unknown usage retains exposure across reopen', async () => {
  const fx = v4Database()
  let reopened: SqliteSignalPlatformStore | undefined
  try {
    const port = fx.store.researchBudgetStore()
    assert.equal((await claim(port, 'primary')).ok, true)
    assert.equal((await claimReservation(port, { rootAssignmentId: 'root-shared', allowanceId: 'policy-omitted', attemptId: 'attempt',
      requestDigest: 'digest', providerRoute: 'offline', approvedLimits: STAGE, nowMs: 1 })).ok, false)
    assert.equal((await settle(port, 'primary', { status: 'measured', costUsdMicros: 5,
      providerCalls: 1, inputTokens: 20, outputTokens: 5 })).ok, true)
    assert.equal((await claim(port, 'followup')).ok, true)
    const key = { rootAssignmentId: 'root-shared', allowanceId: 'followup', attemptId: 'attempt-1' }
    assert.equal((await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 4 })).ok, true)
    assert.equal((await recordUnknownOutcome(port, key, { ownedEpoch: 1, nowMs: 5 })).ok, true)
    fx.store.close()
    reopened = new SqliteSignalPlatformStore(fx.path, 'news')
    const denied = await claim(reopened.researchBudgetStore(), 'replacement', ROOT,
      { maxProviderCalls: 1, maxInputTokens: 1, maxOutputTokens: 1, maxIncrementalCostUsdMicros: 1 })
    assert.equal(denied.ok, false)
    assert.equal(reopened.listResearchReservations(100).find((row) => row.allowanceId === 'followup')?.state, 'execution_outcome_unknown')
    assert.equal((await claim(reopened.researchBudgetStore(), 'new-policy', { ...ROOT, maxProviderCalls: 99 })).ok, false)
  } finally { reopened?.close(); fx.close() }
})

test('unknown cost cannot be represented as free spending under a finite cost cap', async () => {
  const fx = v4Database()
  try {
    assert.equal((await claim(fx.store.researchBudgetStore(), 'unknown-cost', ROOT,
      { ...STAGE, maxIncrementalCostUsdMicros: null } as typeof STAGE)).ok, false)
    const port = fx.store.researchBudgetStore()
    assert.equal((await claim(port, 'actual-cost-unknown')).ok, true)
    assert.equal((await settle(port, 'actual-cost-unknown', { status: 'unknown', costUsdMicros: null,
      providerCalls: 1, inputTokens: 1, outputTokens: 1 })).ok, true)
    assert.equal((await claim(port, 'next', { ...ROOT, maxProviderCalls: 3 },
      { ...STAGE, maxProviderCalls: 1, maxInputTokens: 1, maxOutputTokens: 1, maxIncrementalCostUsdMicros: 11 })).ok, false)
  } finally { fx.close() }
})

test('missing approved limits fails safely; invalid usage cannot lower aggregate exposure', async () => {
  const fx = v4Database()
  try {
    const port = fx.store.researchBudgetStore()
    const missing = await claimReservation(port, { rootAssignmentId: 'root', allowanceId: 'missing', attemptId: 'attempt',
      requestDigest: 'digest', providerRoute: 'mock', nowMs: 1 })
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.code, 'limits_not_configured')
    assert.equal((await claim(port, 'invalid-usage')).ok, true)
    const key = { rootAssignmentId: 'root-shared', allowanceId: 'invalid-usage', attemptId: 'attempt-1' }
    await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 2 })
    for (const usage of [
      { status: 'unknown', costUsdMicros: null, providerCalls: -1, inputTokens: 1, outputTokens: 1 },
      { status: 'unknown', costUsdMicros: null, providerCalls: 1, inputTokens: -10, outputTokens: 1 },
      { status: 'unknown', costUsdMicros: null, providerCalls: 1, inputTokens: 1, outputTokens: 0.5 },
      { status: 'unknown', costUsdMicros: null, providerCalls: Number.NaN, inputTokens: 1, outputTokens: 1 },
      { status: 'unknown', costUsdMicros: null, providerCalls: 1, inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 1 },
      { status: 'measured', costUsdMicros: Number.POSITIVE_INFINITY, providerCalls: 1, inputTokens: 1, outputTokens: 1 },
      { status: 'unknown', costUsdMicros: 0, providerCalls: 1, inputTokens: 1, outputTokens: 1 },
    ] as D2Usage[]) {
      const result = await settleReservation(port, key, { requestDigest: 'request-digest', providerResultDigest: 'response', savedResultRef: 'packet', usage,
        savedResultSavedAtMs: 3, verification: { kind: 'transport_response_saved' } })
      assert.equal(result.ok, false, JSON.stringify(usage))
      if (!result.ok) assert.equal(result.code, 'invalid_d2_usage_report')
    }
    assert.equal((await port.get(key))?.state, 'dispatch_intent')
  } finally { fx.close() }
})
