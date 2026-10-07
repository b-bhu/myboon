import { createHash } from 'node:crypto'
import { canonicalJson } from '../signal-platform/canonical-json'
import {
  ProgressionPlanValidationError,
  progressionPlanDigest,
  validateProgressionPlan,
  type ExistingItemOperation,
  type ItemDraft,
  type ItemEvidenceRef,
  type ProgressionPlanV1,
} from './progression-plan'
import {
  knowledgeOperationHoldContentDigest,
  knowledgeOperationSemanticDigest,
  KnowledgeOperationConflictError,
  KnowledgeOperationFencingError,
  KnowledgeOperationStaleTargetError,
  PROVISIONAL_MAX_HOLD_RECORD_BYTES,
  type KnowledgeOperationLease,
  type KnowledgeOperationEffect,
  type KnowledgeOperationReceipt,
  type KnowledgeOperationWriterPort,
} from './knowledge-operation-store'
import { ProgressionSourcePacketEvidenceReader } from './progression-source-packet-reader'

export type ProgressionPlanMetadata = Omit<
  ProgressionPlanV1,
  'contractVersion' | 'operationId' | 'workId' | 'outcome'
>

export interface ProgressionPlanFreshness {
  current: boolean
  reason: string
  missingDependency: string
}

export interface SavedProgressionSourcePacket {
  workId: string
  packetDigest: string
  evidenceRefs: readonly ItemEvidenceRef[]
}

/** Raw saved-packet access only; the processor constructs its own verifier. */
export interface ProgressionSourcePacketReadPort {
  readResearchPacket(workId: string): Promise<unknown | null>
}

export interface ProgressionProcessInput {
  /** Stable logical operation identity assigned by code from workId alone. */
  operationId: string
  workId: string
  owner: string
  metadata: ProgressionPlanMetadata
  /** Runs only for a new operation after the receipt lookup. */
  assertPlanningAvailable: () => Promise<void>
  /** Model/code proposes only the outcome; all identity/version metadata is code-owned. */
  proposeOutcome: () => Promise<unknown>
  resolveEntityIdentity: (candidateEntityRef: string | null, draft: ItemDraft) => string | null
  resolveExistingItemIdentity: (
    candidateItemRef: string | null,
    kind: ExistingItemOperation['kind'],
  ) => string | null
  /** Re-check saved packet/context/policy/decision/target versions before any write. */
  checkPlanFreshness: (plan: ProgressionPlanV1) => Promise<ProgressionPlanFreshness>
}

export type ProgressionProcessResult =
  | { kind: 'replayed'; receipt: KnowledgeOperationReceipt }
  | { kind: 'accepted'; receipt: KnowledgeOperationReceipt; alreadyAccepted: boolean }
  | { kind: 'held'; receipt: KnowledgeOperationReceipt; alreadyAccepted: boolean }
  | { kind: 'busy' }
  | { kind: 'fenced' }

/** A deterministic name-based UUID (RFC 4122 v5) for a persisted managed item. */
export function deriveManagedItemId(operationId: string, localKey: string): string {
  const namespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')
  const name = Buffer.from(`${operationId}\u0000${localKey}`, 'utf8')
  const bytes = createHash('sha1').update(namespace).update(name).digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Derives stable logical identity from the code-owned work ID only. */
export function deriveProgressionOperationId(workId: string): string {
  const normalizedWorkId = normalizeMetadataString(workId, 'workId')
  const digest = createHash('sha256').update(canonicalJson({
    schemaVersion: 'myboon.progression_operation_key.v2',
    workId: normalizedWorkId,
  })).digest('hex')
  return `progression-v2:${digest}`
}

export function deriveProgressionAttemptDigest(operationId: string, metadata: ProgressionPlanMetadata): string {
  return createHash('sha256').update(canonicalJson({
    schemaVersion: 'myboon.progression_plan_attempt.v1',
    operationId,
    ...normalizeProgressionPlanMetadata(metadata),
  })).digest('hex')
}

/**
 * Idempotent orchestration slice for Stage 4. The receipt lookup is always the
 * first external read. Plan attempts are checkpointed before writes; holds
 * retain their full payload, commit no effects, and do not block retry.
 */
export class ProgressionProcessor {
  private readonly sourcePackets: ProgressionSourcePacketEvidenceReader

  constructor(
    private readonly writer: KnowledgeOperationWriterPort,
    sourcePackets: ProgressionSourcePacketReadPort,
  ) {
    this.sourcePackets = new ProgressionSourcePacketEvidenceReader(sourcePackets)
  }

  async process(input: ProgressionProcessInput): Promise<ProgressionProcessResult> {
    const operationId = nonEmptyString(input.operationId, 'operationId')
    const workId = nonEmptyString(input.workId, 'workId')
    const owner = nonEmptyString(input.owner, 'owner')
    const expectedOperationId = deriveProgressionOperationId(workId)
    if (operationId !== expectedOperationId) {
      throw new KnowledgeOperationConflictError(
        operationId,
        'operationId does not match the code-owned logical work ID',
      )
    }
    // PRD ordering invariant: accepted receipts bypass all model/configuration-version work.
    const priorReceipt = await this.writer.findReceipt(operationId)
    if (priorReceipt) {
      assertReceiptIdentity(priorReceipt, operationId, workId)
      return { kind: 'replayed', receipt: priorReceipt }
    }

    const lease = await this.writer.acquireLease(operationId, owner)
    if (!lease) {
      const receipt = await this.writer.findReceipt(operationId)
      if (receipt) assertReceiptIdentity(receipt, operationId, workId)
      return receipt ? { kind: 'replayed', receipt } : { kind: 'busy' }
    }
    try {
      return await this.withLeaseHeartbeat(lease, async (assertLease) => {
    const racedReceipt = await this.writer.findReceipt(operationId)
    assertLease()
    if (racedReceipt) {
      assertReceiptIdentity(racedReceipt, operationId, workId)
      return { kind: 'replayed', receipt: racedReceipt }
    }

    const metadata = immutableCanonicalSnapshot(normalizeProgressionPlanMetadata(input.metadata))
    const attemptDigest = deriveProgressionAttemptDigest(operationId, metadata)

    let saved = await this.writer.findSavedPlan(operationId, attemptDigest)
    assertLease()
    if (saved) assertSavedPlanMatchesRequest(saved, operationId, workId, metadata, attemptDigest)

    if (!saved) {
      let sourcePacket: SavedProgressionSourcePacket
      try {
        const loaded = await this.sourcePackets.loadSavedPacket({
          workId,
          packetDigest: metadata.packetDigest,
        })
        assertLease()
        if (!loaded) throw new Error('saved source packet was not found')
        sourcePacket = normalizeSavedSourcePacket(loaded, workId, metadata.packetDigest)
      } catch (error) {
        if (error instanceof KnowledgeOperationFencingError) throw error
        assertLease()
        const reason = `saved source packet unavailable: ${safeError(error)}`
        const held = await this.commitHold({
          operationId,
          workId,
          owner: lease.owner,
          epoch: lease.epoch,
          attemptDigest,
          planRevision: null,
          planDigest: knowledgeOperationSemanticDigest({ operationId, workId, metadata, reason }, PROVISIONAL_MAX_HOLD_RECORD_BYTES),
          reason,
          missingDependency: 'source_packet',
          retainedGroups: 0,
          retainedPayload: { metadata },
        })
        return resultForReceipt(held.receipt, held.alreadyAccepted)
      }

      try {
        await input.assertPlanningAvailable()
        assertLease()
      } catch (error) {
        if (error instanceof KnowledgeOperationFencingError) throw error
        assertLease()
        const reason = `planning unavailable: ${safeError(error)}`
        const held = await this.commitHold({
          operationId,
          workId,
          owner: lease.owner,
          epoch: lease.epoch,
          attemptDigest,
          planRevision: null,
          planDigest: knowledgeOperationSemanticDigest({ operationId, workId, metadata, reason }),
          reason,
          missingDependency: 'planning_configuration',
          retainedGroups: 0,
          retainedPayload: { metadata },
        })
        return resultForReceipt(held.receipt, held.alreadyAccepted)
      }

      const proposedOutcome = await input.proposeOutcome()
      assertLease()
      try {
        const plan = validateProgressionPlan({
          contractVersion: 1,
          operationId,
          workId,
          ...metadata,
          outcome: proposedOutcome,
        }, input.resolveEntityIdentity, input.resolveExistingItemIdentity, (candidate) => {
          const candidateKey = canonicalJson(candidate)
          return sourcePacket.evidenceRefs.some((reference) => canonicalJson(reference) === candidateKey)
            ? candidate
            : null
        })
        const planDigest = progressionPlanDigest(plan)
        saved = await this.writer.saveValidatedPlan({
          operationId,
          workId,
          owner: lease.owner,
          epoch: lease.epoch,
          attemptDigest,
          plan,
          planDigest,
        })
        assertLease()
      } catch (error) {
        if (error instanceof KnowledgeOperationFencingError) throw error
        if (!(error instanceof ProgressionPlanValidationError)) throw error
        assertLease()
        const retainedPayload = { outcome: proposedOutcome, metadata }
        const retainedGroups = countGroups(proposedOutcome)
        const reason = safeError(error)
        const held = await this.commitHold({
          operationId,
          workId,
          owner: lease.owner,
          epoch: lease.epoch,
          attemptDigest,
          planRevision: null,
          planDigest: knowledgeOperationSemanticDigest({
            schemaVersion: 'myboon.rejected_progression_proposal.v1',
            operationId,
            workId,
            retainedPayload,
          }, PROVISIONAL_MAX_HOLD_RECORD_BYTES),
          reason,
          missingDependency: 'plan_validation',
          retainedGroups,
          retainedPayload,
        })
        return resultForReceipt(held.receipt, held.alreadyAccepted)
      }
    }

    if (!saved) throw new Error(`validated progression plan was not saved for ${operationId}`)
    assertSavedPlanMatchesRequest(saved, operationId, workId, metadata, attemptDigest)
    const immutablePlan = freezePlanSnapshot(saved.plan)
    if (
      immutablePlan.operationId !== operationId || immutablePlan.workId !== workId ||
      progressionPlanDigest(immutablePlan) !== saved.planDigest ||
      canonicalJson(progressionPlanMetadata(immutablePlan)) !== canonicalJson(metadata)
    ) {
      throw new KnowledgeOperationConflictError(operationId, 'saved progression plan failed immutable snapshot verification')
    }
    saved = { ...saved, plan: immutablePlan }
    assertLease()
    const freshness = await input.checkPlanFreshness(saved.plan)
    assertLease()
    if (progressionPlanDigest(saved.plan) !== saved.planDigest) {
      throw new KnowledgeOperationConflictError(operationId, 'saved progression plan changed during freshness check')
    }
    if (!freshness.current) {
      const retainedPayload = saved.plan
      const held = await this.commitHold({
        operationId,
        workId,
        owner: lease.owner,
        epoch: lease.epoch,
        attemptDigest,
        planRevision: saved.revision,
        planDigest: saved.planDigest,
        reason: nonEmptyString(freshness.reason, 'stale plan reason'),
        missingDependency: nonEmptyString(freshness.missingDependency, 'stale plan missingDependency'),
        retainedGroups: countGroups(saved.plan.outcome),
        retainedPayload,
      })
      return resultForReceipt(held.receipt, held.alreadyAccepted)
    }

    if (saved.plan.outcome.kind === 'hold') {
      const retainedPayload = saved.plan
      const held = await this.commitHold({
        operationId,
        workId,
        owner: lease.owner,
        epoch: lease.epoch,
        attemptDigest,
        planRevision: saved.revision,
        planDigest: saved.planDigest,
        reason: saved.plan.outcome.reason,
        missingDependency: saved.plan.outcome.missingDependency,
        retainedGroups: 0,
        retainedPayload,
      })
      return resultForReceipt(held.receipt, held.alreadyAccepted)
    }

    const effects = saved.plan.outcome.kind === 'apply'
      ? buildProgressionEffects(operationId, saved.plan.outcome.drafts, saved.plan.outcome.operations)
      : []
    const expectedAbsentItemIds = effects
      .filter((effect) => effect.kind === 'managed_item')
      .map((effect) => effect.itemId)
    const contentDigest = knowledgeOperationSemanticDigest(effects)
    assertLease()
    try {
      const committed = await this.writer.commitOperations({
        operationId,
        workId,
        owner: lease.owner,
        epoch: lease.epoch,
        attemptDigest,
        planRevision: saved.revision,
        planDigest: saved.planDigest,
        contentDigest,
        targetRevisions: saved.plan.targetRevisions,
        expectedAbsentItemIds,
        effects,
      })
      assertReceiptIdentity(committed.receipt, operationId, workId)
      if (committed.receipt.status !== 'accepted') {
        throw new KnowledgeOperationConflictError(operationId, 'writer returned a non-accepted receipt for committed effects')
      }
      return {
        kind: 'accepted',
        receipt: committed.receipt,
        alreadyAccepted: committed.alreadyAccepted,
      }
    } catch (error) {
      if (error instanceof KnowledgeOperationFencingError) return { kind: 'fenced' }
      if (error instanceof KnowledgeOperationStaleTargetError) {
        const held = await this.commitHold({
          operationId,
          workId,
          owner: lease.owner,
          epoch: lease.epoch,
          attemptDigest,
          planRevision: saved.revision,
          planDigest: saved.planDigest,
          reason: `target revision changed before commit: ${error.targetId}`,
          missingDependency: 'target_revalidation',
          retainedGroups: countGroups(saved.plan.outcome),
          retainedPayload: saved.plan,
        })
        return resultForReceipt(held.receipt, held.alreadyAccepted)
      }
      throw error
    }
      })
    } catch (error) {
      if (error instanceof KnowledgeOperationFencingError) return { kind: 'fenced' }
      throw error
    } finally {
      try {
        await this.writer.releaseLease(operationId, lease.owner, lease.epoch)
      } catch {
        // Expiry is the recovery path; cleanup must not mask a durable result or original error.
      }
    }
  }

  private async withLeaseHeartbeat<T>(
    lease: KnowledgeOperationLease,
    work: (assertLease: () => void) => Promise<T>,
  ): Promise<T> {
    let expiresAt = Date.parse(lease.expiresAt)
    if (!Number.isFinite(expiresAt)) throw new TypeError('lease expiresAt is invalid')
    let stopped = false
    let failure: Error | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const wakeState: { resolve?: () => void } = {}

    const heartbeatTask = (async () => {
      while (!stopped && !failure) {
        const delayMs = Math.max(1, Math.floor((expiresAt - Date.now()) / 2))
        await new Promise<void>((resolve) => {
          wakeState.resolve = resolve
          timer = setTimeout(() => {
            timer = undefined
            wakeState.resolve = undefined
            resolve()
          }, delayMs)
        })
        if (stopped) break
        try {
          const renewed = await this.writer.renewLease(lease.operationId, lease.owner, lease.epoch)
          if (!renewed) {
            failure = new KnowledgeOperationFencingError(lease.operationId, 'lease heartbeat lost ownership')
            break
          }
          expiresAt = Date.parse(renewed.expiresAt)
          if (!Number.isFinite(expiresAt)) throw new TypeError('renewed lease expiresAt is invalid')
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error))
        }
      }
    })()

    const assertLease = (): void => {
      if (failure) throw failure
      if (Date.now() >= expiresAt) {
        throw new KnowledgeOperationFencingError(lease.operationId, 'lease expired while operation was in progress')
      }
    }

    try {
      return await work(assertLease)
    } finally {
      stopped = true
      if (timer) clearTimeout(timer)
      const wakeHeartbeat = wakeState.resolve
      wakeState.resolve = undefined
      wakeHeartbeat?.()
      await heartbeatTask
    }
  }

  private async commitHold(input: {
    operationId: string
    workId: string
    owner: string
    epoch: number
    attemptDigest: string
    planRevision: number | null
    planDigest: string
    reason: string
    missingDependency: string
    retainedGroups: number
    retainedPayload: unknown | null
  }): Promise<{ receipt: KnowledgeOperationReceipt; alreadyAccepted: boolean }> {
    const hold = {
      reason: input.reason,
      missingDependency: input.missingDependency,
      retainedGroups: input.retainedGroups,
      retainedPayload: input.retainedPayload,
    }
    const result = await this.writer.commitHold({
      ...input,
      contentDigest: knowledgeOperationHoldContentDigest(hold),
    })
    if (!result.receipt) throw new Error(`writer returned no receipt for held operation ${input.operationId}`)
    assertReceiptIdentity(result.receipt, input.operationId, input.workId)
    if (result.receipt.status !== 'held') {
      throw new KnowledgeOperationConflictError(input.operationId, 'writer returned a non-held receipt for a hold request')
    }
    return { receipt: result.receipt, alreadyAccepted: result.alreadyAccepted }
  }
}

export function buildProgressionEffects(
  operationId: string,
  drafts: ItemDraft[],
  operations: ExistingItemOperation[],
): KnowledgeOperationEffect[] {
  const itemIds = new Map(drafts.map((draft) => [draft.localKey, deriveManagedItemId(operationId, draft.localKey)]))
  const draftEffects: KnowledgeOperationEffect[] = drafts.map((draft) => ({
    itemId: itemIds.get(draft.localKey)!,
    kind: 'managed_item',
    payload: {
      localKey: draft.localKey,
      candidateId: draft.candidateId,
      note: draft.note,
      entityLinks: draft.entityLinks.map((link) => ({
        entityId: link.resolvedEntityRef,
        candidateEntityRef: link.candidateEntityRef,
        role: link.role,
      })),
      continuityLinks: draft.continuityLinks.map((link) => ({
        itemId: itemIds.get(link.toLocalKey)!,
        kind: link.kind,
      })),
      evidenceRefs: draft.evidenceRefs,
    },
  }))
  const existingItemEffects: KnowledgeOperationEffect[] = operations.map((operation) => ({
    itemId: operation.itemId,
    kind: 'existing_item_operation',
    payload: {
      ...operation.payload,
      // Operation identity/kind and successor IDs remain code-owned even if
      // a proposal embeds identically named fields in its payload.
      candidateItemRef: operation.candidateItemRef,
      kind: operation.kind,
      ...(typeof operation.payload.successorLocalKey === 'string'
        ? { successorItemId: itemIds.get(operation.payload.successorLocalKey)! }
        : {}),
    },
  }))
  return [...draftEffects, ...existingItemEffects]
}

function countGroups(value: unknown): number {
  if (value && typeof value === 'object') {
    const candidate = value as { drafts?: unknown; operations?: unknown; outcome?: unknown }
    if (candidate.outcome !== undefined) return countGroups(candidate.outcome)
    const drafts = Array.isArray(candidate.drafts) ? candidate.drafts.length : 0
    const operations = Array.isArray(candidate.operations) ? candidate.operations.length : 0
    return drafts + operations
  }
  return 0
}

function resultForReceipt(receipt: KnowledgeOperationReceipt, alreadyAccepted: boolean): ProgressionProcessResult {
  if (receipt.status === 'held') {
    return { kind: 'held', receipt, alreadyAccepted }
  }
  return { kind: 'accepted', receipt, alreadyAccepted }
}

function assertReceiptIdentity(
  receipt: KnowledgeOperationReceipt,
  operationId: string,
  workId: string,
): void {
  if (receipt.operationId !== operationId || receipt.workId !== workId) {
    throw new KnowledgeOperationConflictError(operationId, 'receipt operationId or workId does not match the requested operation')
  }
}

function assertSavedPlanMatchesRequest(
  saved: { attemptDigest: string; plan: ProgressionPlanV1; planDigest: string },
  operationId: string,
  workId: string,
  metadata: ProgressionPlanMetadata,
  attemptDigest: string,
): void {
  let matches = false
  try {
    matches = saved.attemptDigest === attemptDigest &&
      saved.plan.operationId === operationId && saved.plan.workId === workId &&
      saved.planDigest === progressionPlanDigest(saved.plan) &&
      canonicalJson(progressionPlanMetadata(saved.plan)) === canonicalJson(metadata)
  } catch {
    matches = false
  }
  if (!matches) {
    throw new KnowledgeOperationConflictError(operationId, 'saved progression plan does not match requested operation and material inputs')
  }
}

function progressionPlanMetadata(plan: ProgressionPlanV1): ProgressionPlanMetadata {
  return {
    packetDigest: plan.packetDigest,
    contextDigest: plan.contextDigest,
    contextWatermark: plan.contextWatermark,
    policyVersion: plan.policyVersion,
    promptVersion: plan.promptVersion,
    decisionVersions: plan.decisionVersions,
    targetRevisions: plan.targetRevisions,
  }
}

function normalizeProgressionPlanMetadata(metadata: ProgressionPlanMetadata): ProgressionPlanMetadata {
  return {
    packetDigest: metadata.packetDigest,
    contextDigest: metadata.contextDigest,
    contextWatermark: metadata.contextWatermark == null
      ? null
      : normalizeMetadataString(metadata.contextWatermark, 'contextWatermark'),
    policyVersion: normalizeMetadataString(metadata.policyVersion, 'policyVersion'),
    promptVersion: normalizeMetadataString(metadata.promptVersion, 'promptVersion'),
    decisionVersions: normalizeMetadataStringRecord(metadata.decisionVersions, 'decisionVersions'),
    targetRevisions: normalizeMetadataStringRecord(metadata.targetRevisions, 'targetRevisions'),
  }
}

function normalizeMetadataString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProgressionPlanValidationError(field, 'must be a non-empty string')
  }
  return value.trim()
}

function normalizeMetadataStringRecord(value: unknown, field: string): Record<string, string> {
  if (value === null || value === undefined) return Object.create(null) as Record<string, string>
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ProgressionPlanValidationError(field, 'must be an object of string values')
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => [normalizeMetadataString(key, `${field}.key`), normalizeMetadataString(entry, `${field}.${key}`)] as const)
    .sort(([left], [right]) => left.localeCompare(right))
  const normalized = Object.create(null) as Record<string, string>
  for (const [key, entry] of entries) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      throw new ProgressionPlanValidationError(field, `contains duplicate normalized key ${key}`)
    }
    normalized[key] = entry
  }
  return normalized
}

function normalizeSavedSourcePacket(
  value: SavedProgressionSourcePacket,
  expectedWorkId: string,
  expectedPacketDigest: string,
): SavedProgressionSourcePacket {
  if (!value || typeof value !== 'object' || value.workId !== expectedWorkId || value.packetDigest !== expectedPacketDigest) {
    throw new Error('saved source packet identity or digest does not match the requested work')
  }
  if (!Array.isArray(value.evidenceRefs)) throw new Error('saved source packet evidence references are invalid')
  const evidenceRefs = value.evidenceRefs.map((reference, index) => {
    if (!reference || typeof reference !== 'object') {
      throw new Error(`saved source packet evidence reference ${index} is invalid`)
    }
    return {
      claimId: nonEmptyString(reference.claimId, `source evidence ${index} claimId`),
      evidenceId: nonEmptyString(reference.evidenceId, `source evidence ${index} evidenceId`),
      sourceRef: nonEmptyString(reference.sourceRef, `source evidence ${index} sourceRef`),
    }
  })
  return deepFreeze({ workId: expectedWorkId, packetDigest: expectedPacketDigest, evidenceRefs })
}

function freezePlanSnapshot(plan: ProgressionPlanV1): ProgressionPlanV1 {
  return immutableCanonicalSnapshot(plan)
}

function immutableCanonicalSnapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim().slice(0, 900) || 'unspecified processing failure'
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value.trim()
}
