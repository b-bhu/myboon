import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  acquireLeaseFence,
  claimReservation,
  isHoldForIntervention,
  PROVISIONAL_FOLLOWUP_LIMITS,
  recordDispatchIntent,
  recordUnknownOutcome,
  releaseNoDispatch,
  releaseUnknownOutcome,
  settleReservation,
  type BudgetStatePatch,
  type BudgetStorePort,
  type BudgetConditionalExpectation,
  type D2ReservationRecord,
  type D2ReservationState,
} from './assignment-budget'

// In-memory compare-and-set fake of the future source-local SQLite wiring.
// Conditional update double-checks its expectation exactly like a guarded
// UPDATE ... WHERE state = ... AND ownership_epoch = ... would.
function createInMemoryBudgetStore(): BudgetStorePort {
  const rows = new Map<string, D2ReservationRecord>()
  const keyOf = (key: { rootAssignmentId: string, allowanceId: string, attemptId: string }) =>
    `${key.rootAssignmentId}|${key.allowanceId}|${key.attemptId}`

  return {
    async listByAllowance(key) {
      return [...rows.values()].filter((row) =>
        row.rootAssignmentId === key.rootAssignmentId && row.allowanceId === key.allowanceId
      )
    },
    async insert(record) {
      const keyText = keyOf(record)
      if (rows.has(keyText)) return 'conflict'
      rows.set(keyText, record)
      return 'created'
    },
    async get(key) {
      return rows.get(keyOf(key)) ?? null
    },
    async update(key, expect, patch, nowMs) {
      const current = rows.get(keyOf(key))
      if (!current) return null
      const stateMismatch = !expect.states.includes(current.state)
      const epochMismatch = expect.ownershipEpoch !== null
        && current.ownershipEpoch !== expect.ownershipEpoch
      if (stateMismatch || epochMismatch) return null
      const next: D2ReservationRecord = {
        ...current,
        ...patch,
      }
      rows.set(keyOf(current), next)
      return next
    },
  }
}

function settleKey(): {
  rootAssignmentId: string
  allowanceId: string
  attemptId: string
} {
  return { rootAssignmentId: 'root-1', allowanceId: 'fu-1', attemptId: 'a-1' }
}

test('claimReservation reserves max exposure once and replays the same attempt idempotently', async () => {
  const port = createInMemoryBudgetStore()
  const claimed = await claimReservation(port, {
    rootAssignmentId: 'root-1',
    allowanceId: 'fu-1',
    attemptId: 'a-1',
    requestDigest: 'digest-1',
    providerRoute: 'jev/systemone@1',
    nowMs: 1_000,
  })
  assert.equal(claimed.ok, true)
  assert.ok(claimed.ok && claimed.record.state === 'reserved_not_dispatched')
  assert.equal(claimed.ok && claimed.record.reservationStatus, 'reserved_max_exposure')
  assert.equal(claimed.ok && claimed.record.ownershipEpoch, 1)
  assert.deepEqual(claimed.ok && claimed.record.approvedLimits, {
    maxProviderCalls: PROVISIONAL_FOLLOWUP_LIMITS.maxProviderCalls,
    maxInputTokens: PROVISIONAL_FOLLOWUP_LIMITS.maxInputTokens,
    maxOutputTokens: PROVISIONAL_FOLLOWUP_LIMITS.maxOutputTokens,
    maxIncrementalCostUsdMicros: PROVISIONAL_FOLLOWUP_LIMITS.maxIncrementalCostUsdMicros,
  })

  const replay = await claimReservation(port, {
    rootAssignmentId: 'root-1',
    allowanceId: 'fu-1',
    attemptId: 'a-1',
    requestDigest: 'digest-1',
    providerRoute: 'jev/systemone@1',
    nowMs: 2_000,
  })
  assert.equal(replay.ok, true)
  assert.ok(replay.ok && replay.record.createdAtMs === 1_000, 'same attempt must not double-reserve')
})

test('open attempt blocks a fresh attempt under the same logical allowance', async () => {
  const port = createInMemoryBudgetStore()
  await claimReservation(port, {
    rootAssignmentId: 'root-1',
    allowanceId: 'fu-1',
    attemptId: 'a-1',
    requestDigest: 'digest-1',
    providerRoute: 'jev/systemone@1',
    nowMs: 1_000,
  })
  const blocked = await claimReservation(port, {
    rootAssignmentId: 'root-1',
    allowanceId: 'fu-1',
    attemptId: 'a-2',
    requestDigest: 'digest-2',
    providerRoute: 'jev/systemone@1',
    nowMs: 2_000,
  })
  assert.equal(blocked.ok, false)
  assert.ok(!blocked.ok && blocked.code === 'active_attempt_exists')
})

test('new attempt only after the prior attempt reaches a terminal state', async () => {
  const port = createInMemoryBudgetStore()
  await claimReservation(port, { rootAssignmentId: 'r', allowanceId: 'fu', attemptId: 'a-1', requestDigest: 'd-1', providerRoute: 'jev/systemone@1', nowMs: 1_000 })
  const released = await releaseNoDispatch(port, { rootAssignmentId: 'r', allowanceId: 'fu', attemptId: 'a-1' }, {
    ownedEpoch: 1,
    fact: { kind: 'no_dispatch', evidence: 'crash persisted before transport handoff' },
    nowMs: 2_000,
  })
  assert.equal(released.ok, true)
  const allowed = await claimReservation(port, { rootAssignmentId: 'r', allowanceId: 'fu', attemptId: 'a-2', requestDigest: 'd-2', providerRoute: 'jev/systemone@1', nowMs: 3_000 })
  assert.equal(allowed.ok, true)
})

test('dispatch intent is persisted before handoff and unknown outcome is conservative evidence', async () => {
  const port = createInMemoryBudgetStore()
  const key = settleKey()
  await claimReservation(port, { ...key, requestDigest: 'digest-1', providerRoute: 'jev/systemone@1', nowMs: 1_000 })
  const intent = await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 2_000 })
  assert.ok(intent.ok && intent.record.state === 'dispatch_intent')

  // Timeout during in-flight call: never non-execution evidence.
  const unknown = await recordUnknownOutcome(port, key, { ownedEpoch: 1, nowMs: 3_000 })
  assert.ok(unknown.ok && unknown.record.state === 'execution_outcome_unknown')
  assert.ok(unknown.ok && isHoldForIntervention(unknown.record))
})

test('stale owner epoch is refused on dispatch intent', async () => {
  const port = createInMemoryBudgetStore()
  const key = settleKey()
  await claimReservation(port, { ...key, requestDigest: 'digest-1', providerRoute: 'jev/systemone@1', nowMs: 1_000 })
  const bumped = await acquireLeaseFence(port, key, { newOwnershipEpoch: 2, nowMs: 1_500 })
  assert.ok(bumped.ok && bumped.record.ownershipEpoch === 2)
  const refused = await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 2_000 })
  assert.equal(refused.ok, false)
  assert.ok(!refused.ok && refused.code === 'stale_owner_epoch')
})

test('settle saves against exact attempt/request identity+digest and settles once', async () => {
  const port = createInMemoryBudgetStore()
  const key = settleKey()
  await claimReservation(port, { ...key, requestDigest: 'digest-1', providerRoute: 'jev/systemone@1', nowMs: 1_000 })
  await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 2_000 })
  const settled = await settleReservation(port, key, {
    requestDigest: 'digest-1',
    providerResultDigest: 'result-digest-1',
    savedResultRef: 'sqlite-collectors:artifact-7',
    usage: { status: 'measured', costUsdMicros: 120, inputTokens: 4_000, outputTokens: 400 },
    savedResultSavedAtMs: 4_000,
    verification: { kind: 'provider_supported', sourceHandle: 'provider-handle-1' },
  })
  assert.ok(settled.ok && settled.record.state === 'settled')
  assert.ok(settled.ok && settled.record.reservationStatus === 'settled_actual_or_unknown_usage')
  assert.ok(settled.ok && settled.record.settlement!.settledByEpoch === 1)

  const replaySame = await settleReservation(port, key, {
    requestDigest: 'digest-1',
    providerResultDigest: 'result-digest-1',
    savedResultRef: 'sqlite-collectors:artifact-7',
    usage: { status: 'measured', costUsdMicros: 120, inputTokens: 4_000, outputTokens: 400 },
    savedResultSavedAtMs: 5_000,
    verification: { kind: 'provider_supported', sourceHandle: 'provider-handle-2' },
  })
  assert.ok(replaySame.ok && replaySame.record.settlement!.settledAtMs === 4_000,
    'same verified attempt settles once, idempotent')

  const conflicting = await settleReservation(port, key, {
    requestDigest: 'digest-1',
    providerResultDigest: 'other-result-digest',
    savedResultRef: null,
    usage: { status: 'unknown', costUsdMicros: null, inputTokens: null, outputTokens: null },
    savedResultSavedAtMs: 6_000,
    verification: { kind: 'transport_response_saved' },
  })
  assert.ok(!conflicting.ok && conflicting.code === 'settle_once_conflict')
})

test('wrong attempt/request identity never settles', async () => {
  const port = createInMemoryBudgetStore()
  const key = settleKey()
  await claimReservation(port, { ...key, requestDigest: 'digest-1', providerRoute: 'jev/systemone@1', nowMs: 1_000 })
  await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 2_000 })
  const mismatched = await settleReservation(port, key, {
    requestDigest: 'different-digest',
    providerResultDigest: null,
    savedResultRef: null,
    usage: { status: 'unknown', costUsdMicros: null, inputTokens: null, outputTokens: null },
    savedResultSavedAtMs: 3_000,
    verification: { kind: 'transport_response_saved' },
  })
  assert.ok(!mismatched.ok && mismatched.code === 'attempt_identity_mismatch')
})

test('cost reporting fails closed: null measured cost or zero cost rejected, unknown declared usage accepted', async () => {
  const port = createInMemoryBudgetStore()
  const key = settleKey()
  await claimReservation(port, { ...key, requestDigest: 'digest-1', providerRoute: 'jev/systemone@1', nowMs: 1_000 })
  await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 2_000 })

  const nullCost = await settleReservation(port, key, {
    requestDigest: 'digest-1',
    providerResultDigest: 'rd-1',
    savedResultRef: null,
    usage: { status: 'measured', costUsdMicros: null, inputTokens: 4_000, outputTokens: 400 },
    savedResultSavedAtMs: 3_000,
    verification: { kind: 'transport_response_saved' },
  })
  assert.ok(!nullCost.ok && nullCost.code === 'invalid_d2_usage_report')

  const zeroCost = await settleReservation(port, key, {
    requestDigest: 'digest-1',
    providerResultDigest: 'rd-1',
    savedResultRef: null,
    usage: { status: 'measured', costUsdMicros: 0, inputTokens: 4_000, outputTokens: 400 },
    savedResultSavedAtMs: 3_100,
    verification: { kind: 'transport_response_saved' },
  })
  assert.ok(!zeroCost.ok && zeroCost.code === 'invalid_d2_usage_report')

  const unknown = await settleReservation(port, key, {
    requestDigest: 'digest-1',
    providerResultDigest: 'rd-1',
    savedResultRef: null,
    usage: { status: 'unknown', costUsdMicros: null, inputTokens: null, outputTokens: null },
    savedResultSavedAtMs: 3_200,
    verification: { kind: 'transport_response_saved' },
  })
  assert.ok(unknown.ok && unknown.record.state === 'settled')
})

test('hold-forever: unknown outcome keeps holding without a provider-supported handle, even after lease expiry', async () => {
  const port = createInMemoryBudgetStore()
  const key = settleKey()
  await claimReservation(port, { ...key, requestDigest: 'digest-1', providerRoute: 'jev/systemone@1', nowMs: 1_000 })
  await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 2_000 })
  const unknown = await recordUnknownOutcome(port, key, { ownedEpoch: 1, nowMs: 3_000 })
  assert.ok(unknown.ok && unknown.record.state === 'execution_outcome_unknown')

  const releaseWithoutHandle = await releaseUnknownOutcome(port, key, {
    ownedEpoch: 1,
    finding: { kind: 'provider_no_charge', sourceHandle: '   ' },
    nowMs: 4_000,
  })
  assert.ok(!releaseWithoutHandle.ok && releaseWithoutHandle.code === 'requires_provider_supported_handle')
  const stillHolding = await port.get(key)
  assert.ok(stillHolding !== null && stillHolding.state === 'execution_outcome_unknown')

  // Lease expiry moves the fence but never releases the hold.
  const fenced = await acquireLeaseFence(port, key, { newOwnershipEpoch: 9, nowMs: 5_000 })
  assert.ok(fenced.ok && fenced.record.ownershipEpoch === 9 && fenced.record.state === 'execution_outcome_unknown')
  const laterRelease = await releaseUnknownOutcome(port, key, {
    ownedEpoch: 9,
    finding: { kind: 'provider_no_charge', sourceHandle: '' },
    nowMs: 6_000,
  })
  assert.ok(!laterRelease.ok && laterRelease.code === 'requires_provider_supported_handle')
})

test('release from reserved_not_dispatched requires ownership + persisted no-dispatch fact', async () => {
  const port = createInMemoryBudgetStore()
  const key = settleKey()
  await claimReservation(port, { ...key, requestDigest: 'digest-1', providerRoute: 'jev/systemone@1', nowMs: 1_000 })

  const wrongEpoch = await releaseNoDispatch(port, key, {
    ownedEpoch: 4,
    fact: { kind: 'no_dispatch', evidence: 'process never reached transport' },
    nowMs: 2_000,
  })
  assert.ok(!wrongEpoch.ok && wrongEpoch.code === 'stale_owner_epoch')

  const released = await releaseNoDispatch(port, key, {
    ownedEpoch: 1,
    fact: { kind: 'no_dispatch', evidence: 'process never reached transport' },
    nowMs: 2_000,
  })
  assert.ok(released.ok && released.record.state === 'released')
  assert.ok(released.ok && released.record.noDispatchFact !== null && released.record.noDispatchFact.evidence !== '')

  const terminalAgain = await releaseNoDispatch(port, key, {
    ownedEpoch: 1,
    fact: { kind: 'no_dispatch', evidence: 'anything' },
    nowMs: 3_000,
  })
  assert.ok(!terminalAgain.ok && terminalAgain.code === 'terminal_reservation')
})

test('release path from dispatch_intent must go through execution_outcome_unknown first', async () => {
  const port = createInMemoryBudgetStore()
  const key = settleKey()
  await claimReservation(port, { ...key, requestDigest: 'digest-1', providerRoute: 'jev/systemone@1', nowMs: 1_000 })
  await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 2_000 })

  const direct = await releaseUnknownOutcome(port, key, {
    ownedEpoch: 1,
    finding: { kind: 'provider_no_charge', sourceHandle: 'some-handle' },
    nowMs: 2_500,
  })
  assert.ok(!direct.ok && direct.code === 'invalid_state_transition')

  await recordUnknownOutcome(port, key, { ownedEpoch: 1, nowMs: 3_000 })
  const released = await releaseUnknownOutcome(port, key, {
    ownedEpoch: 1,
    finding: { kind: 'provider_no_execution', sourceHandle: 'provider-durable-handle-1' },
    nowMs: 4_000,
  })
  assert.ok(released.ok && released.record.state === 'released')
  assert.ok(released.ok && released.record.reservationStatus === 'released_no_charge')
})

test('fence must strictly increase and never hides the in-flight call', async () => {
  const port = createInMemoryBudgetStore()
  const key = settleKey()
  await claimReservation(port, { ...key, requestDigest: 'digest-1', providerRoute: 'jev/systemone@1', nowMs: 1_000 })
  await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 2_000 })

  const equal = await acquireLeaseFence(port, key, { newOwnershipEpoch: 1, nowMs: 2_100 })
  assert.ok(!equal.ok && equal.code === 'fence_epoch_not_higher')

  const lower = await acquireLeaseFence(port, key, { newOwnershipEpoch: 0, nowMs: 2_200 })
  assert.ok(!lower.ok && lower.code === 'fence_epoch_not_higher')

  const bumped = await acquireLeaseFence(port, key, { newOwnershipEpoch: 2, nowMs: 2_300 })
  assert.ok(bumped.ok && bumped.record.state === 'dispatch_intent', 'fence never changes the state')

  // Old owner cannot settle at its stale epoch with a DIFFERENT result
  // identity. The same verified attempt result is still accepted late.
  const lateDifferent = await settleReservation(port, key, {
    requestDigest: 'other-digest',
    providerResultDigest: null,
    savedResultRef: null,
    usage: { status: 'unknown', costUsdMicros: null, inputTokens: null, outputTokens: null },
    settlementEpoch: 1,
    savedResultSavedAtMs: 3_000,
    verification: { kind: 'transport_response_saved' },
  })
  assert.ok(!lateDifferent.ok && lateDifferent.code === 'attempt_identity_mismatch')

  const lateSameAttempt = await settleReservation(port, key, {
    requestDigest: 'digest-1',
    providerResultDigest: 'result-digest-1',
    savedResultRef: 'sqlite-collectors:artifact-42',
    usage: { status: 'measured', costUsdMicros: 90, inputTokens: 3_000, outputTokens: 300 },
    settlementEpoch: 1,
    savedResultSavedAtMs: 3_100,
    verification: { kind: 'provider_supported', sourceHandle: 'provider-handle-9' },
  })
  assert.ok(lateSameAttempt.ok && lateSameAttempt.record.state === 'settled')
  assert.ok(lateSameAttempt.ok && lateSameAttempt.record.settlement!.settledByEpoch === 1)
})

test('terminal reservations refuse every further transition', async () => {
  const port = createInMemoryBudgetStore()
  const key = settleKey()
  await claimReservation(port, { ...key, requestDigest: 'digest-1', providerRoute: 'jev/systemone@1', nowMs: 1_000 })
  await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 2_000 })
  const settled = await settleReservation(port, key, {
    requestDigest: 'digest-1',
    providerResultDigest: 'result-digest-1',
    savedResultRef: null,
    usage: { status: 'unknown', costUsdMicros: null, inputTokens: null, outputTokens: null },
    savedResultSavedAtMs: 3_000,
    verification: { kind: 'transport_response_saved' },
  })
  assert.ok(settled.ok)

  const fence = await acquireLeaseFence(port, key, { newOwnershipEpoch: 5, nowMs: 3_100 })
  assert.ok(!fence.ok && fence.code === 'terminal_reservation')

  const intent = await recordDispatchIntent(port, key, { ownedEpoch: 1, nowMs: 3_200 })
  assert.ok(!intent.ok && intent.code === 'terminal_reservation')

  const unknown = await recordUnknownOutcome(port, key, { ownedEpoch: 1, nowMs: 3_300 })
  assert.ok(!unknown.ok && unknown.code === 'terminal_reservation')
})

