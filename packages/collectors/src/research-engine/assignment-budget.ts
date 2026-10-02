// D2 reservation ledger (V4 PRD §5.3 / owner decision §3.2): every follow-up
// dispatch holds a reservation whose outcome is never guessed. A timeout is not
// evidence that the provider did no work, so the module refuses to release or
// re-spend without a provider-supported finding. Pure logic only: persistence
// goes through BudgetStorePort (source-local SQLite wiring is a later slice).

export type D2ReservationState =
  | 'reserved_not_dispatched'
  | 'dispatch_intent'
  | 'execution_outcome_unknown'
  | 'settled'
  | 'released'

// Recorded proposals awaiting product approval (PRD §3.3 invents no numbers).
// PROVISIONAL gut-call values used only as a conservative default snapshot,
// not as calibrated limits or targets.
export const PROVISIONAL_FOLLOWUP_LIMITS = {
  maxProviderCalls: 1,
  maxInputTokens: 15_000,
  maxOutputTokens: 3_000,
  maxIncrementalCostUsdMicros: 100_000,
} as const

export interface D2FollowupLimitsSnapshot {
  readonly maxProviderCalls: number
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly maxIncrementalCostUsdMicros: number | null
}

export type D2ReservationStatus =
  | 'reserved_max_exposure'
  | 'settled_actual_or_unknown_usage'
  | 'released_no_charge'

export interface D2NoDispatchFact {
  readonly kind: 'no_dispatch'
  readonly evidence: string
}

export interface D2Settlement {
  readonly attemptId: string
  readonly requestDigest: string
  readonly providerResultDigest: string | null
  readonly savedResultRef: string | null
  readonly usage: D2Usage
  readonly settledByEpoch: number
  readonly settledAtMs: number
}

export type D2Usage =
  | { readonly status: 'measured', readonly costUsdMicros: number | null, readonly inputTokens: number | null, readonly outputTokens: number | null }
  | { readonly status: 'unknown', readonly costUsdMicros: null, readonly inputTokens: null, readonly outputTokens: null }

export interface D2ReservationKey {
  readonly rootAssignmentId: string
  readonly allowanceId: string
  readonly attemptId: string
}

export interface D2ReservationRecord {
  readonly rootAssignmentId: string
  readonly allowanceId: string
  readonly attemptId: string
  readonly state: D2ReservationState
  readonly requestDigest: string
  readonly providerRoute: string
  readonly approvedLimits: D2FollowupLimitsSnapshot
  readonly reservationStatus: D2ReservationStatus
  readonly ownershipEpoch: number
  readonly noDispatchFact: D2NoDispatchFact | null
  readonly settlement: D2Settlement | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

// Conditional persistence port. The module owns the state-machine policy; the
// port is a dumb compare-and-set store so the future SQLite wiring can be a
// plain table update guarded by expected state/epoch.
export interface BudgetConditionalExpectation {
  readonly states: readonly D2ReservationState[]
  readonly ownershipEpoch: number | null
}

export interface BudgetStatePatch {
  readonly state: D2ReservationState
  readonly ownershipEpoch: number
  readonly noDispatchFact?: D2NoDispatchFact | null
  readonly settlement?: D2Settlement | null
  readonly reservationStatus?: D2ReservationStatus
}

export interface BudgetStorePort {
  listByAllowance(
    key: { readonly rootAssignmentId: string, readonly allowanceId: string },
  ): Promise<readonly D2ReservationRecord[]>
  insert(record: D2ReservationRecord): Promise<'created' | 'conflict'>
  // Returns the updated row, or null when the condition misses (row absent,
  // state outside `states`, or epoch differs — `null` epoch asserts nothing).
  update(
    key: D2ReservationKey,
    expect: BudgetConditionalExpectation,
    next: BudgetStatePatch,
    nowMs: number,
  ): Promise<D2ReservationRecord | null>
  get(key: D2ReservationKey): Promise<D2ReservationRecord | null>
}

export type D2RefusalCode =
  | 'active_attempt_exists'
  | 'same_attempt_already_reserved'
  | 'store_insert_conflict'
  | 'unknown_reservation'
  | 'invalid_state_transition'
  | 'stale_owner_epoch'
  | 'requires_provider_supported_handle'
  | 'attempt_identity_mismatch'
  | 'settle_once_conflict'
  | 'invalid_d2_usage_report'
  | 'fence_epoch_not_higher'
  | 'terminal_reservation'
  | 'exclusivity_not_provable'

export type D2Outcome<RecordT> =
  | { readonly ok: true, readonly record: RecordT }
  | { readonly ok: false, readonly code: D2RefusalCode, readonly record: D2ReservationRecord | null }

const TERMINAL_STATES: readonly D2ReservationState[] = ['settled', 'released']

export function isTerminalD2State(state: D2ReservationState): boolean {
  return TERMINAL_STATES.includes(state)
}

// Hold for intervention: outcome unknown with no provider-supported channel.
// Holds indefinitely — lease expiry does not close it and D2 never re-spends.
export function isHoldForIntervention(record: D2ReservationRecord): boolean {
  return record.state === 'execution_outcome_unknown'
    && record.noDispatchFact === null
    && record.settlement === null
}

// One logical allowance, one reserved exposure, one row per attempt. The
// single conditional insert claims both; automatic retries must reuse this
// allowance and are refused until the open attempt reaches a terminal state.
export async function claimReservation(
  port: BudgetStorePort,
  input: {
    rootAssignmentId: string
    allowanceId: string
    attemptId: string
    requestDigest: string
    providerRoute: string
    approvedLimits?: D2FollowupLimitsSnapshot
    nowMs: number
  },
): Promise<D2Outcome<D2ReservationRecord>> {
  const key = {
    rootAssignmentId: input.rootAssignmentId,
    allowanceId: input.allowanceId,
    attemptId: input.attemptId,
  }
  const existing = await port.listByAllowance(key)
  for (const record of existing) {
    if (record.attemptId === input.attemptId) {
      return { ok: true, record }
    }
    if (!isTerminalD2State(record.state)) {
      return { ok: false, code: 'active_attempt_exists', record }
    }
  }
  const record: D2ReservationRecord = Object.freeze({
    rootAssignmentId: input.rootAssignmentId,
    allowanceId: input.allowanceId,
    attemptId: input.attemptId,
    state: 'reserved_not_dispatched' as const,
    requestDigest: input.requestDigest,
    providerRoute: input.providerRoute,
    approvedLimits: Object.freeze(
      input.approvedLimits
        ?? {
          maxProviderCalls: PROVISIONAL_FOLLOWUP_LIMITS.maxProviderCalls,
          maxInputTokens: PROVISIONAL_FOLLOWUP_LIMITS.maxInputTokens,
          maxOutputTokens: PROVISIONAL_FOLLOWUP_LIMITS.maxOutputTokens,
          maxIncrementalCostUsdMicros: PROVISIONAL_FOLLOWUP_LIMITS.maxIncrementalCostUsdMicros as number | null,
        }
    ),
    reservationStatus: 'reserved_max_exposure' as const,
    ownershipEpoch: 1,
    noDispatchFact: null,
    settlement: null,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
  })
  const inserted = await port.insert(record)
  if (inserted !== 'created') {
    return { ok: false, code: 'store_insert_conflict', record: null }
  }
  return { ok: true, record }
}

// Persisted before the request is handed to the transport.
export async function recordDispatchIntent(
  port: BudgetStorePort,
  key: D2ReservationKey,
  input: { ownedEpoch: number, nowMs: number },
): Promise<D2Outcome<D2ReservationRecord>> {
  return conditionalTransition(
    port,
    key,
    { states: ['reserved_not_dispatched'], ownershipEpoch: input.ownedEpoch },
    { state: 'dispatch_intent', ownershipEpoch: input.ownedEpoch },
    input.nowMs,
  )
}

// A timeout, crash, lost response, or lost exclusivity is conservative
// evidence only: outcome unknown, never non-execution.
export async function recordUnknownOutcome(
  port: BudgetStorePort,
  key: D2ReservationKey,
  input: { ownedEpoch: number, nowMs: number },
): Promise<D2Outcome<D2ReservationRecord>> {
  return conditionalTransition(
    port,
    key,
    {
      states: ['reserved_not_dispatched', 'dispatch_intent'],
      ownershipEpoch: input.ownedEpoch,
    },
    { state: 'execution_outcome_unknown', ownershipEpoch: input.ownedEpoch },
    input.nowMs,
  )
}

// Exclusive ownership proof = correct current epoch. Released only with a
// persisted no-dispatch fact, which is stored atomically with the release.
// With exclusivity lost and nothing provable, the conservative move is to
// record the unknown outcome and hold — never to release.
export async function releaseNoDispatch(
  port: BudgetStorePort,
  key: D2ReservationKey,
  input: { ownedEpoch: number, fact: D2NoDispatchFact, nowMs: number },
): Promise<D2Outcome<D2ReservationRecord>> {
  const record = await port.get(key)
  if (!record) return { ok: false, code: 'unknown_reservation', record: null }
  if (isTerminalD2State(record.state)) {
    return { ok: false, code: 'terminal_reservation', record }
  }
  if (record.state !== 'reserved_not_dispatched') {
    return { ok: false, code: 'invalid_state_transition', record }
  }
  if (record.ownershipEpoch !== input.ownedEpoch) {
    return { ok: false, code: 'stale_owner_epoch', record }
  }
  return conditionalTransition(
    port,
    key,
    { states: ['reserved_not_dispatched'], ownershipEpoch: input.ownedEpoch },
    {
      state: 'released',
      ownershipEpoch: input.ownedEpoch,
      noDispatchFact: input.fact,
      reservationStatus: 'released_no_charge',
    },
    input.nowMs,
  )
}

const NON_TERMINAL_STATES: readonly D2ReservationState[] = [
  'reserved_not_dispatched', 'dispatch_intent', 'execution_outcome_unknown',
]

// Lease expiry only lets a new reconciler acquire a higher fenced ownership
// epoch. The state never changes here — an in-flight call is never made to
// disappear by a fence.
export async function acquireLeaseFence(
  port: BudgetStorePort,
  key: D2ReservationKey,
  input: { newOwnershipEpoch: number, nowMs: number },
): Promise<D2Outcome<D2ReservationRecord>> {
  const record = await port.get(key)
  if (!record) return { ok: false, code: 'unknown_reservation', record: null }
  if (isTerminalD2State(record.state)) {
    return { ok: false, code: 'terminal_reservation', record }
  }
  const current = record.ownershipEpoch
  if (!Number.isInteger(input.newOwnershipEpoch) || input.newOwnershipEpoch <= current) {
    return { ok: false, code: 'fence_epoch_not_higher', record }
  }
  return conditionalTransition(
    port,
    key,
    { states: NON_TERMINAL_STATES, ownershipEpoch: current },
    { state: record.state, ownershipEpoch: input.newOwnershipEpoch },
    input.nowMs,
  )
}

// Settlement input must carry the exact attempt/request identity and digest.
// Cost reporting fails closed: cost must be a positive measured value or the
// usage must be declared unknown — never zero, never null cost labeled
// measured (both traced historical executions reported no usable cost).
const settleOutcomeShape = (
  usage: D2Usage,
): 'measured_requires_nonzero_cost' | 'unknown_only_when_cost_absent' | 'valid' => {
  if (usage.status === 'unknown') return 'valid'
  if (usage.costUsdMicros === null || usage.costUsdMicros <= 0) {
    return 'measured_requires_nonzero_cost'
  }
  return 'valid'
}

export type D2SettleVerification =
  | { readonly kind: 'transport_response_saved' }
  | { readonly kind: 'provider_supported', readonly sourceHandle: string }

// Saved result identity: settled exactly once against the same attempt,
// request digest, and provider result digest. Epoch-neutral late save is
// accepted ONLY when the attempt identity matches (PRD §5.3): the old owner
// may save the one true result; a different identity is rejected.
export async function settleReservation(
  port: BudgetStorePort,
  key: D2ReservationKey,
  input: {
    requestDigest: string
    providerResultDigest: string | null
    savedResultRef: string | null
    usage: D2Usage
    settlementEpoch?: number
    savedResultSavedAtMs: number
    verification: D2SettleVerification
  },
): Promise<D2Outcome<D2ReservationRecord>> {
  const record = await port.get(key)
  if (!record) return { ok: false, code: 'unknown_reservation', record: null }
  if (isTerminalD2State(record.state)) {
    if (record.state === 'settled') {
      const settlement = record.settlement!
      const sameAttemptResult = input.requestDigest === record.requestDigest
        && settlement.providerResultDigest === input.providerResultDigest
        && settlement.savedResultRef === input.savedResultRef
      if (sameAttemptResult) {
        return { ok: true, record }
      }
      return { ok: false, code: 'settle_once_conflict', record }
    }
    return { ok: false, code: 'terminal_reservation', record }
  }
  if (record.state === 'reserved_not_dispatched') {
    return { ok: false, code: 'invalid_state_transition', record }
  }
  if (key.attemptId !== record.attemptId) {
    return { ok: false, code: 'attempt_identity_mismatch', record }
  }
  if (input.requestDigest !== record.requestDigest) {
    return { ok: false, code: 'attempt_identity_mismatch', record }
  }
  const shape = settleOutcomeShape(input.usage)
  if (shape !== 'valid') {
    return { ok: false, code: 'invalid_d2_usage_report', record }
  }
  if (record.state === 'execution_outcome_unknown'
    && input.verification.kind !== 'provider_supported') {
    return { ok: false, code: 'requires_provider_supported_handle', record }
  }
  const settlement: D2Settlement = Object.freeze({
    attemptId: record.attemptId,
    requestDigest: input.requestDigest,
    providerResultDigest: input.providerResultDigest,
    savedResultRef: input.savedResultRef,
    usage: input.usage,
    settledByEpoch: input.settlementEpoch ?? record.ownershipEpoch,
    settledAtMs: input.savedResultSavedAtMs,
  })
  const reservationStatus: D2ReservationStatus = input.usage.status === 'unknown'
    ? 'settled_actual_or_unknown_usage'
    : 'settled_actual_or_unknown_usage'
  const updated = await port.update(
    key,
    {
      states: ['dispatch_intent', 'execution_outcome_unknown'],
      ownershipEpoch: null,
    },
    { state: 'settled', ownershipEpoch: record.ownershipEpoch, settlement, reservationStatus },
    input.savedResultSavedAtMs,
  )
  if (!updated) return { ok: false, code: 'invalid_state_transition', record }
  return { ok: true, record: updated }
}

// Release from execution_outcome_unknown needs an authoritative no-execution
// or no-charge finding the provider actually supports (durable result handle
// or verified provider record). Without one the reservation holds forever.
export async function releaseUnknownOutcome(
  port: BudgetStorePort,
  key: D2ReservationKey,
  input: {
    ownedEpoch: number
    finding: { readonly kind: 'provider_no_execution' | 'provider_no_charge', readonly sourceHandle: string }
    settlement?: D2Settlement
    nowMs: number
  },
): Promise<D2Outcome<D2ReservationRecord>> {
  const record = await port.get(key)
  if (!record) return { ok: false, code: 'unknown_reservation', record: null }
  if (isTerminalD2State(record.state)) {
    return { ok: false, code: 'terminal_reservation', record }
  }
  if (record.state !== 'execution_outcome_unknown') {
    return { ok: false, code: 'invalid_state_transition', record }
  }
  if (!input.finding.sourceHandle || input.finding.sourceHandle.trim() === '') {
    return { ok: false, code: 'requires_provider_supported_handle', record }
  }
  return conditionalTransition(
    port,
    key,
    { states: ['execution_outcome_unknown'], ownershipEpoch: input.ownedEpoch },
    { state: 'released', ownershipEpoch: input.ownedEpoch, reservationStatus: 'released_no_charge' },
    input.nowMs,
  )
}

async function conditionalTransition(
  port: BudgetStorePort,
  key: D2ReservationKey,
  expect: BudgetConditionalExpectation,
  next: BudgetStatePatch,
  nowMs: number,
): Promise<D2Outcome<D2ReservationRecord>> {
  const record = await port.get(key)
  if (!record) return { ok: false, code: 'unknown_reservation', record: null }
  if (isTerminalD2State(record.state)) {
    return { ok: false, code: 'terminal_reservation', record }
  }
  const updated = await port.update(key, expect, next, nowMs)
  if (!updated) {
    const stale = expect.ownershipEpoch !== null && record.ownershipEpoch !== expect.ownershipEpoch
    return {
      ok: false,
      code: stale ? 'stale_owner_epoch' : 'invalid_state_transition',
      record: await port.get(key),
    }
  }
  return { ok: true, record: updated }
}
