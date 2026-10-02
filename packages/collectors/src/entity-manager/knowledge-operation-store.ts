import { createHash } from 'node:crypto'
import { canonicalJson } from '../signal-platform/canonical-json'
import { progressionPlanDigest, type ProgressionPlanV1 } from './progression-plan'

/**
 * Stage 4 slice 1 (PRD §5.4): operation receipts and writer fencing.
 *
 * This file holds the contract types, the port interface the progression
 * processor depends on, and the in-memory reference implementation used by
 * tests. The production private-writer client (Supabase/SQL) is a later
 * slice; it must implement the same port with the same fencing semantics:
 *
 * - one fencing lease per logical operation: `owner` + monotonically
 *   increasing `epoch`,
 * - every conditional update rejects a stale owner/epoch,
 * - effects plus the receipt commit in one all-or-nothing operation,
 * - replays never duplicate accepted contributions.
 */

export const KNOWLEDGE_OPERATION_RECEIPT_SCHEMA_VERSION = 'myboon.knowledge_operation_receipt.v2' as const

/** `accepted` is terminal; `held` is an append-only attempt record with zero commits. */
export type KnowledgeOperationStatus = 'accepted' | 'held'

export interface KnowledgeOperationReceipt {
  schemaVersion: typeof KNOWLEDGE_OPERATION_RECEIPT_SCHEMA_VERSION
  /** Code-assigned stable identity of the logical operation. */
  operationId: string
  workId: string
  /** Digest of the immutable input/plan attempt, including prompt provenance. */
  attemptDigest: string
  /** Immutable saved-plan revision used by this result; null for pre-plan holds. */
  planRevision: number | null
  /** SHA-256 (64 lowercase hex) of the immutable validated plan. */
  planDigest: string
  status: KnowledgeOperationStatus
  reason: string | null
  missingDependency: string | null
  /** Number of item groups preserved under a durable hold. Zero when accepted. */
  retainedGroups: number
  /** Full rejected/unprocessed proposal payload, retained without applying effects. */
  retainedPayload: unknown | null
  /** Fencing lease that committed this receipt (epoch of the winning writer). */
  owner: string
  ownerEpoch: number
  /** SHA-256 (64 lowercase hex) over the applied effects, for conflict rejection. */
  contentDigest: string
  committedAt: string
}

export interface KnowledgeOperationLease {
  operationId: string
  owner: string
  epoch: number
  expiresAt: string
}

/** One planned write effect. The private-writer client (later slice) maps this to real rows. */
export interface KnowledgeOperationEffect {
  /** Code-assigned persisted identity; the model never supplies this. */
  itemId: string
  kind: 'managed_item' | 'existing_item_operation'
  /** Immutable canonical payload for the private managed tables. */
  payload: Record<string, unknown>
}

export interface KnowledgeOperationCommitInput {
  operationId: string
  workId: string
  owner: string
  epoch: number
  attemptDigest: string
  planRevision: number
  planDigest: string
  contentDigest: string
  /** Expected revision of every managed target changed by these effects. */
  targetRevisions: Record<string, string>
  /** Code-derived managed item IDs that must still be absent at commit. */
  expectedAbsentItemIds: string[]
  effects: KnowledgeOperationEffect[]
}

export interface KnowledgeOperationCommitResult {
  receipt: KnowledgeOperationReceipt
  alreadyAccepted: boolean
}

export interface KnowledgeOperationHoldInput {
  operationId: string
  workId: string
  owner: string
  epoch: number
  attemptDigest: string
  /** Null when the hold happened before a validated plan was checkpointed. */
  planRevision: number | null
  planDigest: string
  contentDigest: string
  reason: string
  /** Required PRD field for holds; empty string is not a dependency name. */
  missingDependency: string
  retainedGroups: number
  /** Full unprocessed proposal groups. Required when retainedGroups is non-zero. */
  retainedPayload: unknown | null
}

export interface SavedProgressionPlan {
  revision: number
  attemptDigest: string
  plan: ProgressionPlanV1
  planDigest: string
  savedAt: string
  owner: string
  ownerEpoch: number
}

export interface SaveProgressionPlanInput {
  operationId: string
  workId: string
  owner: string
  epoch: number
  attemptDigest: string
  plan: ProgressionPlanV1
  planDigest: string
}

/**
 * The managed-writer port consumed by the progression processor. Every
 * method is conditional: stale owners/epochs are rejected, and replays of an
 * already-accepted operation return the existing receipt unchanged.
 */
export interface KnowledgeOperationWriterPort {
  /**
   * Resolve an accepted terminal receipt for the logical operation. Ordering rule 3
   * (PRD §5.4): this runs before any model/configuration-version check so a
   * changed provider or prompt can never write accepted knowledge again.
   */
  findReceipt(operationId: string): Promise<KnowledgeOperationReceipt | null>
  /** Resume an unheld immutable plan for this exact input/prompt attempt. */
  findSavedPlan(operationId: string, attemptDigest: string): Promise<SavedProgressionPlan | null>
  /** All saved revisions remain available for audit and held-plan references. */
  findSavedPlanHistory(operationId: string): Promise<readonly SavedProgressionPlan[]>
  /** Holds are retryable attempt history, not terminal operation receipts. */
  findHoldHistory(operationId: string): Promise<readonly KnowledgeOperationReceipt[]>
  saveValidatedPlan(input: SaveProgressionPlanInput): Promise<SavedProgressionPlan>
  /** Acquire only when unclaimed/expired; every live lease is exclusive, even for the same owner. */
  acquireLease(operationId: string, owner: string): Promise<KnowledgeOperationLease | null>
  /** Extend the current lease only while the same owner/epoch remains live. */
  renewLease(operationId: string, owner: string, epoch: number): Promise<KnowledgeOperationLease | null>
  /** Expire only the exact owner/epoch lease; stale release attempts cannot clear a newer fence. */
  releaseLease(operationId: string, owner: string, epoch: number): Promise<boolean>
  currentLease(operationId: string, owner: string): Promise<KnowledgeOperationLease | null>
  /**
   * All-or-nothing commit of effects plus receipt. Zero partial commits by
   * contract: either every effect plus the receipt is durable, or nothing
   * changed. An identical accepted replay returns the original receipt with
   * `alreadyAccepted` so callers can acknowledge without re-writing.
   */
  commitOperations(
    input: KnowledgeOperationCommitInput,
  ): Promise<KnowledgeOperationCommitResult>
  /** Append hold attempt history with no effects; a later attempt may still succeed. */
  commitHold(input: KnowledgeOperationHoldInput): Promise<KnowledgeOperationCommitResult>
}

export class KnowledgeOperationConflictError extends Error {
  constructor(readonly operationId: string, detail: string) {
    super(`Knowledge operation ${operationId} conflict: ${detail}`)
    this.name = 'KnowledgeOperationConflictError'
  }
}

export class KnowledgeOperationFencingError extends Error {
  constructor(readonly operationId: string, detail: string) {
    super(`Knowledge operation ${operationId} fencing rejection: ${detail}`)
    this.name = 'KnowledgeOperationFencingError'
  }
}

export class KnowledgeOperationStaleTargetError extends Error {
  constructor(readonly operationId: string, readonly targetId: string) {
    super(`Knowledge operation ${operationId} target revision changed: ${targetId}`)
    this.name = 'KnowledgeOperationStaleTargetError'
  }
}

const BOUNDED_TEXT_MAX = 1_000
const PROVISIONAL_MAX_EFFECTS = 8
const PROVISIONAL_MAX_JSON_BYTES = 1_048_576
export const PROVISIONAL_MAX_HOLD_PAYLOAD_BYTES = 7 * 1_048_576
export const PROVISIONAL_MAX_HOLD_RECORD_BYTES = 8 * 1_048_576

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`knowledge operation ${field} must be a non-empty string`)
  }
  if (value.trim().length > BOUNDED_TEXT_MAX) {
    throw new RangeError(`knowledge operation ${field} exceeds the bounded length`)
  }
  return value.trim()
}

function sha256Hex62(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`knowledge operation ${field} must be a lowercase SHA-256 hex digest`)
  }
  return value
}

/**
 * Normalized, immutable commit record. Kept in the file used by both the
 * in-memory reference implementation below and the future private-writer
 * client so both sides share one construction path.
 */
export interface NormalizedKnowledgeOperationCommit {
  readonly operationId: string
  readonly attemptDigest: string
  readonly planRevision: number
  readonly planDigest: string
  readonly contentDigest: string
  readonly targetRevisions: Readonly<Record<string, string>>
  readonly expectedAbsentItemIds: readonly string[]
  readonly effects: readonly KnowledgeOperationEffect[]
}

export function normalizeCommitInput(input: KnowledgeOperationCommitInput): NormalizedKnowledgeOperationCommit {
  const operationId = nonEmptyString(input.operationId, 'operationId')
  nonEmptyString(input.owner, 'owner')
  if (!Number.isInteger(input.epoch) || input.epoch <= 0) {
    throw new RangeError('knowledge operation lease epoch must be a positive integer')
  }
  const attemptDigest = sha256Hex62(input.attemptDigest, 'attemptDigest')
  if (!Number.isSafeInteger(input.planRevision) || input.planRevision <= 0) {
    throw new RangeError('knowledge operation planRevision must be a positive safe integer')
  }
  const planDigest = sha256Hex62(input.planDigest, 'planDigest')
  const contentDigest = sha256Hex62(input.contentDigest, 'contentDigest')
  const targetRevisions = normalizeStringRecord(input.targetRevisions, 'targetRevisions')
  if (!Array.isArray(input.effects)) throw new TypeError('knowledge operation effects must be an array')
  if (input.effects.length > PROVISIONAL_MAX_EFFECTS) {
    throw new RangeError(`knowledge operation effects exceed the PROVISIONAL cap of ${PROVISIONAL_MAX_EFFECTS}`)
  }
  const effects: KnowledgeOperationEffect[] = input.effects.map((effect) => {
    if (!effect || typeof effect !== 'object') throw new TypeError('knowledge operation effect must be an object')
    const candidate = effect as Partial<KnowledgeOperationEffect>
    if (candidate.kind !== 'managed_item' && candidate.kind !== 'existing_item_operation') {
      throw new TypeError(`knowledge operation effect has unsupported kind: ${String(candidate.kind)}`)
    }
    if (!candidate.payload || typeof candidate.payload !== 'object' || Array.isArray(candidate.payload)) {
      throw new TypeError('knowledge operation effect payload must be a JSON object')
    }
    return {
      kind: candidate.kind,
      itemId: nonEmptyString(candidate.itemId, 'effect itemId'),
      payload: cloneCanonical(candidate.payload) as Record<string, unknown>,
    }
  })
  const expectedAbsentItemIds = normalizeUniqueStringList(input.expectedAbsentItemIds, 'expectedAbsentItemIds')
  const createdItemIds = effects.filter((effect) => effect.kind === 'managed_item').map((effect) => effect.itemId)
  if (!sameStringSet(expectedAbsentItemIds, createdItemIds)) {
    throw new TypeError('knowledge operation expectedAbsentItemIds must exactly match new managed item effects')
  }
  const normalized = {
    operationId,
    attemptDigest,
    planRevision: input.planRevision,
    planDigest,
    contentDigest,
    targetRevisions,
    expectedAbsentItemIds,
    effects,
  }
  if (Buffer.byteLength(canonicalJson(normalized), 'utf8') > PROVISIONAL_MAX_JSON_BYTES) {
    throw new RangeError(`knowledge operation commit exceeds the PROVISIONAL cap of ${PROVISIONAL_MAX_JSON_BYTES} bytes`)
  }
  return deepFreeze(normalized)
}

export function normalizeHoldInput(input: KnowledgeOperationHoldInput): NormalizedKnowledgeOperationHold {
  const operationId = nonEmptyString(input.operationId, 'operationId')
  nonEmptyString(input.owner, 'owner')
  if (!Number.isInteger(input.epoch) || input.epoch <= 0) {
    throw new RangeError('knowledge operation lease epoch must be a positive integer')
  }
  const attemptDigest = sha256Hex62(input.attemptDigest, 'attemptDigest')
  const planRevision = input.planRevision == null ? null : input.planRevision
  if (planRevision !== null && (!Number.isSafeInteger(planRevision) || planRevision <= 0)) {
    throw new RangeError('knowledge operation hold planRevision must be null or a positive safe integer')
  }
  sha256Hex62(input.planDigest, 'planDigest')
  sha256Hex62(input.contentDigest, 'contentDigest')
  const reason = nonEmptyString(input.reason, 'hold reason')
  const missingDependency = nonEmptyString(input.missingDependency, 'hold missingDependency')
  if (!Number.isInteger(input.retainedGroups) || input.retainedGroups < 0) {
    throw new RangeError('knowledge operation retainedGroups must be a non-negative integer')
  }
  const retainedPayload = input.retainedPayload == null
    ? null
    : cloneCanonical(input.retainedPayload, PROVISIONAL_MAX_HOLD_PAYLOAD_BYTES)
  if (input.retainedGroups > 0 && retainedPayload === null) {
    throw new TypeError('knowledge operation hold must preserve the unprocessed payload')
  }
  const expectedContentDigest = knowledgeOperationHoldContentDigest({
    reason,
    missingDependency,
    retainedGroups: input.retainedGroups,
    retainedPayload,
  })
  if (input.contentDigest !== expectedContentDigest) {
    throw new TypeError('knowledge operation hold content digest does not match retained payload and reason')
  }
  return Object.freeze({
    operationId,
    attemptDigest,
    planRevision,
    planDigest: sha256Hex62(input.planDigest, 'planDigest'),
    contentDigest: sha256Hex62(input.contentDigest, 'contentDigest'),
    reason,
    missingDependency,
    retainedGroups: input.retainedGroups,
    retainedPayload,
  })
}

export interface NormalizedKnowledgeOperationHold {
  readonly operationId: string
  readonly attemptDigest: string
  readonly planRevision: number | null
  readonly planDigest: string
  readonly contentDigest: string
  readonly reason: string
  readonly missingDependency: string
  readonly retainedGroups: number
  readonly retainedPayload: unknown | null
}

/**
 * In-memory reference implementation of the fencing contract. It encodes the
 * exact semantics a real private-writer client must reproduce:
 * atomic effect+receipt commit, monotonic lease epochs, and stale-writer
 * rejection at every conditional boundary. The processor's tests drive this
 * directly; a SQL implementation is a later slice.
 */
export interface InMemoryKnowledgeOperationStoreOptions {
  /** Explicit because production lease duration is a worker policy, not a store default. */
  leaseTtlMs: number
  now?: () => Date
}

export class InMemoryKnowledgeOperationStore implements KnowledgeOperationWriterPort {
  private readonly receipts = new Map<string, KnowledgeOperationReceipt>()
  private readonly holdAttempts = new Map<string, KnowledgeOperationReceipt[]>()
  private readonly leases = new Map<string, KnowledgeOperationLease>()
  private readonly savedPlans = new Map<string, SavedProgressionPlan[]>()
  private readonly heldPlanRevisions = new Set<string>()
  private readonly effectsByOperation = new Map<string, readonly KnowledgeOperationEffect[]>()
  private readonly targetRevisions = new Map<string, string>()
  private readonly managedItemIds = new Set<string>()
  private readonly now: () => Date
  /** Injectable failure for all-or-nothing tests; runs before any mutation. */
  private commitInterceptor: ((input: KnowledgeOperationCommitInput) => void) | null = null

  constructor(private readonly options: InMemoryKnowledgeOperationStoreOptions) {
    if (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
      throw new RangeError('knowledge operation leaseTtlMs must be a positive safe integer')
    }
    this.now = options.now ?? (() => new Date())
  }

  setTargetRevision(targetId: string, revision: string | null): void {
    const target = nonEmptyString(targetId, 'targetId')
    if (revision === null) this.targetRevisions.delete(target)
    else this.targetRevisions.set(target, nonEmptyString(revision, 'target revision'))
  }
  setCommitInterceptor(interceptor: (input: KnowledgeOperationCommitInput) => void): void {
    this.commitInterceptor = interceptor
  }

  async findReceipt(operationId: string): Promise<KnowledgeOperationReceipt | null> {
    const receipt = this.receipts.get(nonEmptyString(operationId, 'operationId'))
    return receipt ? cloneCanonical(receipt, PROVISIONAL_MAX_HOLD_RECORD_BYTES) : null
  }

  async findSavedPlan(operationId: string, attemptDigest: string): Promise<SavedProgressionPlan | null> {
    const key = nonEmptyString(operationId, 'operationId')
    const digest = sha256Hex62(attemptDigest, 'attemptDigest')
    const revisions = this.savedPlans.get(key) ?? []
    const savedPlan = [...revisions].reverse().find((candidate) =>
      candidate.attemptDigest === digest && !this.isPlanRevisionHeld(key, candidate.revision),
    )
    return savedPlan ? deepFreeze(cloneCanonical(savedPlan)) : null
  }

  async findSavedPlanHistory(operationId: string): Promise<readonly SavedProgressionPlan[]> {
    const revisions = this.savedPlans.get(nonEmptyString(operationId, 'operationId')) ?? []
    return deepFreeze(revisions.map((revision) => cloneCanonical(revision)))
  }

  async findHoldHistory(operationId: string): Promise<readonly KnowledgeOperationReceipt[]> {
    const attempts = this.holdAttempts.get(nonEmptyString(operationId, 'operationId')) ?? []
    return deepFreeze(attempts.map((attempt) => cloneCanonical(attempt, PROVISIONAL_MAX_HOLD_RECORD_BYTES)))
  }

  async saveValidatedPlan(input: SaveProgressionPlanInput): Promise<SavedProgressionPlan> {
    const operationId = nonEmptyString(input.operationId, 'operationId')
    const workId = nonEmptyString(input.workId, 'workId')
    const attemptDigest = sha256Hex62(input.attemptDigest, 'attemptDigest')
    this.assertLease(operationId, input.owner, input.epoch)
    if (this.receipts.has(operationId)) {
      throw new KnowledgeOperationConflictError(operationId, 'an accepted receipt already exists for this operation')
    }
    if (input.plan.operationId !== operationId || input.plan.workId !== workId) {
      throw new KnowledgeOperationConflictError(operationId, 'saved plan identity does not match code-owned operation/work')
    }
    const planDigest = sha256Hex62(input.planDigest, 'planDigest')
    if (progressionPlanDigest(input.plan) !== planDigest) {
      throw new KnowledgeOperationConflictError(operationId, 'saved plan digest does not match normalized plan')
    }
    const revisions = this.savedPlans.get(operationId) ?? []
    const existing = [...revisions].reverse().find((candidate) =>
      candidate.attemptDigest === attemptDigest && !this.isPlanRevisionHeld(operationId, candidate.revision),
    )
    if (existing) {
      if (existing.planDigest !== planDigest) {
        throw new KnowledgeOperationConflictError(operationId, 'a saved plan is immutable for this input attempt')
      }
      return deepFreeze(cloneCanonical(existing))
    }
    const savedPlan: SavedProgressionPlan = deepFreeze({
      revision: revisions.length + 1,
      attemptDigest,
      plan: cloneCanonical(input.plan),
      planDigest,
      savedAt: this.readNow().toISOString(),
      owner: nonEmptyString(input.owner, 'owner'),
      ownerEpoch: input.epoch,
    })
    this.savedPlans.set(operationId, [...revisions, savedPlan])
    return deepFreeze(cloneCanonical(savedPlan))
  }

  committedEffects(operationId: string): readonly KnowledgeOperationEffect[] {
    const effects = this.effectsByOperation.get(nonEmptyString(operationId, 'operationId')) ?? []
    return JSON.parse(canonicalJson(effects)) as KnowledgeOperationEffect[]
  }

  async acquireLease(operationId: string, owner: string): Promise<KnowledgeOperationLease | null> {
    const key = nonEmptyString(operationId, 'operationId')
    const nextOwner = nonEmptyString(owner, 'owner')
    const now = this.readNow()
    const existing = this.leases.get(key)
    if (existing && Date.parse(existing.expiresAt) > now.getTime()) return null
    const epoch = existing ? existing.epoch + 1 : 1
    const lease: KnowledgeOperationLease = {
      operationId: key,
      owner: nextOwner,
      epoch,
      expiresAt: new Date(now.getTime() + this.options.leaseTtlMs).toISOString(),
    }
    this.leases.set(key, lease)
    return { ...lease }
  }

  async releaseLease(operationId: string, owner: string, epoch: number): Promise<boolean> {
    const key = nonEmptyString(operationId, 'operationId')
    const requested = nonEmptyString(owner, 'owner')
    const lease = this.leases.get(key)
    if (!lease || lease.owner !== requested || lease.epoch !== epoch) return false
    this.leases.set(key, {
      ...lease,
      expiresAt: this.readNow().toISOString(),
    })
    return true
  }

  async renewLease(operationId: string, owner: string, epoch: number): Promise<KnowledgeOperationLease | null> {
    const key = nonEmptyString(operationId, 'operationId')
    const requested = nonEmptyString(owner, 'owner')
    const lease = this.leases.get(key)
    const now = this.readNow()
    if (
      !lease || lease.owner !== requested || lease.epoch !== epoch ||
      Date.parse(lease.expiresAt) <= now.getTime()
    ) return null
    const renewed = {
      ...lease,
      expiresAt: new Date(now.getTime() + this.options.leaseTtlMs).toISOString(),
    }
    this.leases.set(key, renewed)
    return { ...renewed }
  }

  async currentLease(operationId: string, owner: string): Promise<KnowledgeOperationLease | null> {
    const key = nonEmptyString(operationId, 'operationId')
    const requested = nonEmptyString(owner, 'owner')
    const lease = this.leases.get(key)
    if (!lease || lease.owner !== requested || Date.parse(lease.expiresAt) <= this.readNow().getTime()) return null
    return { ...lease }
  }

  async commitOperations(
    input: KnowledgeOperationCommitInput,
  ): Promise<KnowledgeOperationCommitResult> {
    const commit = normalizeCommitInput(input)
    const workId = nonEmptyString(input.workId, 'workId')
    if (knowledgeOperationSemanticDigest(commit.effects) !== commit.contentDigest) {
      throw new KnowledgeOperationConflictError(commit.operationId, 'content digest does not match normalized effects')
    }
    const existing = this.receipts.get(commit.operationId)
    if (existing) {
      if (
        existing.planDigest !== commit.planDigest ||
        existing.contentDigest !== commit.contentDigest ||
        existing.workId !== workId
      ) {
        throw new KnowledgeOperationConflictError(
          commit.operationId,
          'an already-committed operation cannot be re-written with a different plan digest',
        )
      }
      return { receipt: cloneCanonical(existing), alreadyAccepted: true }
    }
    for (const targetId of collectRequiredRevisionTargetIds(commit.effects)) {
      if (!Object.prototype.hasOwnProperty.call(commit.targetRevisions, targetId)) {
        throw new TypeError(`knowledge operation targetRevisions must include the expected revision for managed target ${targetId}`)
      }
    }
    this.assertLease(commit.operationId, input.owner, input.epoch)
    this.assertTargetRevisions(commit.operationId, commit.targetRevisions)
    this.assertExpectedAbsentItemIds(commit.operationId, commit.expectedAbsentItemIds)
    this.commitInterceptor?.(input)
    // Reference "transaction": receipt is only visible after effects. Nothing
    // here writes before the interceptor returns; an interceptor throw leaves
    // zero mutations (all-or-nothing).
    const receipt: KnowledgeOperationReceipt = {
      schemaVersion: KNOWLEDGE_OPERATION_RECEIPT_SCHEMA_VERSION,
      operationId: commit.operationId,
      workId,
      attemptDigest: commit.attemptDigest,
      planRevision: commit.planRevision,
      planDigest: commit.planDigest,
      status: 'accepted',
      reason: null,
      missingDependency: null,
      retainedGroups: 0,
      retainedPayload: null,
      owner: nonEmptyString(input.owner, 'owner'),
      ownerEpoch: input.epoch,
      contentDigest: commit.contentDigest,
      committedAt: this.readNow().toISOString(),
    }
    const effectSnapshot = cloneCanonical(commit.effects) as KnowledgeOperationEffect[]
    this.effectsByOperation.set(commit.operationId, effectSnapshot)
    for (const itemId of commit.expectedAbsentItemIds) this.managedItemIds.add(itemId)
    this.receipts.set(commit.operationId, receipt)
    return { receipt: cloneCanonical(receipt), alreadyAccepted: false }
  }

  async commitHold(input: KnowledgeOperationHoldInput): Promise<KnowledgeOperationCommitResult> {
    const hold = normalizeHoldInput(input)
    const workId = nonEmptyString(input.workId, 'workId')
    const existing = this.receipts.get(hold.operationId)
    if (existing) {
      throw new KnowledgeOperationConflictError(hold.operationId, 'an accepted receipt cannot be replaced by a hold')
    }
    this.assertLease(hold.operationId, input.owner, input.epoch)
    const history = this.holdAttempts.get(hold.operationId) ?? []
    const duplicate = history.find((record) =>
      record.ownerEpoch === input.epoch &&
      record.attemptDigest === hold.attemptDigest &&
      record.planRevision === hold.planRevision &&
      record.planDigest === hold.planDigest &&
      record.contentDigest === hold.contentDigest,
    )
    if (duplicate) {
      return { receipt: cloneCanonical(duplicate, PROVISIONAL_MAX_HOLD_RECORD_BYTES), alreadyAccepted: false }
    }
    if (hold.planRevision !== null) {
      const saved = (this.savedPlans.get(hold.operationId) ?? []).find((candidate) =>
        candidate.revision === hold.planRevision,
      )
      if (!saved || saved.attemptDigest !== hold.attemptDigest || saved.planDigest !== hold.planDigest) {
        throw new KnowledgeOperationConflictError(hold.operationId, 'held plan revision does not match its saved attempt')
      }
    }
    const receipt: KnowledgeOperationReceipt = {
      schemaVersion: KNOWLEDGE_OPERATION_RECEIPT_SCHEMA_VERSION,
      operationId: hold.operationId,
      workId,
      attemptDigest: hold.attemptDigest,
      planRevision: hold.planRevision,
      planDigest: hold.planDigest,
      status: 'held',
      reason: hold.reason,
      missingDependency: hold.missingDependency,
      retainedGroups: hold.retainedGroups,
      retainedPayload: cloneCanonical(hold.retainedPayload, PROVISIONAL_MAX_HOLD_PAYLOAD_BYTES),
      owner: nonEmptyString(input.owner, 'owner'),
      ownerEpoch: input.epoch,
      contentDigest: hold.contentDigest,
      committedAt: this.readNow().toISOString(),
    }
    if (hold.planRevision !== null) this.markPlanRevisionHeld(hold.operationId, hold.planRevision)
    this.holdAttempts.set(hold.operationId, [...history, receipt])
    return { receipt: cloneCanonical(receipt, PROVISIONAL_MAX_HOLD_RECORD_BYTES), alreadyAccepted: false }
  }

  private assertTargetRevisions(operationId: string, revisions: Readonly<Record<string, string>>): void {
    for (const [targetId, expectedRevision] of Object.entries(revisions)) {
      if (this.targetRevisions.get(targetId) !== expectedRevision) {
        throw new KnowledgeOperationStaleTargetError(operationId, targetId)
      }
    }
  }

  private assertExpectedAbsentItemIds(operationId: string, itemIds: readonly string[]): void {
    for (const itemId of itemIds) {
      if (this.targetRevisions.has(itemId) || this.managedItemIds.has(itemId)) {
        throw new KnowledgeOperationStaleTargetError(operationId, itemId)
      }
    }
  }

  private planRevisionKey(operationId: string, revision: number): string {
    return `${operationId}\u0000${revision}`
  }

  private isPlanRevisionHeld(operationId: string, revision: number): boolean {
    return this.heldPlanRevisions.has(this.planRevisionKey(operationId, revision))
  }

  private markPlanRevisionHeld(operationId: string, revision: number): void {
    this.heldPlanRevisions.add(this.planRevisionKey(operationId, revision))
  }

  private readNow(): Date {
    const value = this.now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new RangeError('knowledge operation clock returned an invalid date')
    }
    return new Date(value.getTime())
  }

  private assertLease(operationId: string, owner: unknown, epoch: number): void {
    nonEmptyString(operationId, 'operationId')
    nonEmptyString(owner as string, 'owner')
    if (!Number.isInteger(epoch) || epoch <= 0) {
      throw new RangeError('knowledge operation lease epoch must be a positive integer')
    }
    const lease = this.leases.get(operationId)
    if (!lease) {
      throw new KnowledgeOperationFencingError(operationId, 'no lease is held for this operation')
    }
    if (lease.owner !== (owner as string).trim()) {
      throw new KnowledgeOperationFencingError(operationId, 'lease is held by another owner')
    }
    if (lease.epoch !== epoch) {
      throw new KnowledgeOperationFencingError(
        operationId,
        `lease epoch is stale (held ${lease.epoch}, committed ${epoch})`,
      )
    }
    if (Date.parse(lease.expiresAt) <= this.readNow().getTime()) {
      throw new KnowledgeOperationFencingError(operationId, 'lease has expired')
    }
  }
}

/** Convenience helper for tests and future clients. */
export function knowledgeOperationSemanticDigest(
  value: unknown,
  maxBytes: number = PROVISIONAL_MAX_JSON_BYTES,
): string {
  return createHash('sha256').update(canonicalJson(cloneCanonical(value, maxBytes))).digest('hex')
}

export function knowledgeOperationHoldContentDigest(input: {
  reason: string
  missingDependency: string
  retainedGroups: number
  retainedPayload: unknown | null
}): string {
  return knowledgeOperationSemanticDigest({
    schemaVersion: 'myboon.knowledge_operation_hold.v1',
    reason: input.reason,
    missingDependency: input.missingDependency,
    retainedGroups: input.retainedGroups,
    retainedPayload: input.retainedPayload,
  }, PROVISIONAL_MAX_HOLD_RECORD_BYTES)
}

function normalizeUniqueStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`knowledge operation ${field} must be an array`)
  if (value.length > PROVISIONAL_MAX_EFFECTS) {
    throw new RangeError(`knowledge operation ${field} exceeds the PROVISIONAL cap of ${PROVISIONAL_MAX_EFFECTS}`)
  }
  const result = value.map((entry) => nonEmptyString(entry, `${field} entry`)).sort()
  if (new Set(result).size !== result.length) {
    throw new TypeError(`knowledge operation ${field} must not contain duplicate entries`)
  }
  return result
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const normalizedLeft = [...left].sort()
  const normalizedRight = [...right].sort()
  return normalizedLeft.every((value, index) => value === normalizedRight[index])
}

function collectRequiredRevisionTargetIds(effects: readonly KnowledgeOperationEffect[]): string[] {
  const targetIds = new Set<string>()
  for (const effect of effects) {
    if (effect.kind === 'existing_item_operation') {
      targetIds.add(effect.itemId)
      continue
    }

    if (!Object.prototype.hasOwnProperty.call(effect.payload, 'entityLinks')) continue
    const entityLinks = effect.payload.entityLinks
    if (!Array.isArray(entityLinks)) {
      throw new TypeError(`knowledge operation managed item ${effect.itemId} entityLinks must be an array`)
    }
    entityLinks.forEach((link, index) => {
      if (!link || typeof link !== 'object' || Array.isArray(link)) {
        throw new TypeError(`knowledge operation managed item ${effect.itemId} entityLinks[${index}] must be an object`)
      }
      const entityId = nonEmptyString((link as Record<string, unknown>).entityId, `managed item ${effect.itemId} entityLinks[${index}].entityId`)
      targetIds.add(entityId)
    })
  }
  return [...targetIds].sort()
}

function normalizeStringRecord(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`knowledge operation ${field} must be a string record`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
  if (entries.length > 32) throw new RangeError(`knowledge operation ${field} exceeds the PROVISIONAL 32-entry cap`)
  const result = Object.create(null) as Record<string, string>
  for (const [rawKey, rawValue] of entries) {
    const key = nonEmptyString(rawKey, `${field} key`)
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new TypeError(`knowledge operation ${field} contains duplicate normalized key ${key}`)
    }
    result[key] = nonEmptyString(rawValue, `${field}.${key}`)
  }
  return result
}

function cloneCanonical<T>(value: T, maxBytes: number = PROVISIONAL_MAX_JSON_BYTES): T {
  assertJsonValue(value, 'value', new Set<object>(), 0)
  const serialized = canonicalJson(value)
  if (typeof serialized !== 'string') throw new TypeError('knowledge operation value is not JSON serializable')
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new RangeError(`knowledge operation value exceeds the PROVISIONAL cap of ${maxBytes} bytes`)
  }
  return JSON.parse(serialized) as T
}

function assertJsonValue(value: unknown, path: string, ancestors: Set<object>, depth: number): void {
  if (depth > 32) throw new RangeError(`knowledge operation ${path} exceeds the JSON depth cap`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object') throw new TypeError(`knowledge operation ${path} contains a non-JSON value`)
  if (ancestors.has(value)) throw new TypeError(`knowledge operation ${path} contains a cycle`)
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertJsonValue(item, `${path}[${index}]`, ancestors, depth + 1)
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`knowledge operation ${path} must contain only plain objects`)
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`knowledge operation ${path} contains symbol keys`)
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertJsonValue(item, `${path}.${key}`, ancestors, depth + 1)
    }
  }
  ancestors.delete(value)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}