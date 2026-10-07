import { createHash } from 'node:crypto'
import { canonicalJson } from '../signal-platform/canonical-json'

/**
 * Stage 4 slice 1 (PRD §5.4): the bounded ProgressionPlanV1 contract and its
 * validator. The model proposes candidate IDs / local keys; **code assigns
 * persisted identities** and stable operation identity. Unresolved identity
 * blocks apply; unresolved research details alone do not.
 *
 * Caps (PRD §5.4, PROVISIONAL evaluation inputs — NOT calibrated limits, NOT
 * targets to fill; must be versioned explicitly before rollout):
 * - 4 items per packet
 * - 8 entity links per item
 * - 4 outgoing continuity links per item
 * - 32 evidence references per item
 * - 6000 characters per note
 */

export const PROVISIONAL_MAX_ITEMS_PER_PACKET = 4 // PROVISIONAL — PRD §5.4 eval input, not calibrated
export const PROVISIONAL_MAX_ENTITY_LINKS_PER_ITEM = 8 // PROVISIONAL — PRD §5.4 eval input, not calibrated
export const PROVISIONAL_MAX_CONTINUITY_LINKS_PER_ITEM = 4 // PROVISIONAL — PRD §5.4 eval input, not calibrated
export const PROVISIONAL_MAX_EVIDENCE_REFS_PER_ITEM = 32 // PROVISIONAL — PRD §5.4 eval input, not calibrated
export const PROVISIONAL_MAX_NOTE_CHARS = 6_000 // PROVISIONAL — PRD §5.4 eval input, not calibrated
export const PROVISIONAL_MAX_EXISTING_ITEM_OPERATIONS_PER_PACKET = 4 // PROVISIONAL — bounded writer safeguard
export const PROVISIONAL_MAX_OPERATION_PAYLOAD_BYTES = 16_384 // PROVISIONAL — bounded writer safeguard
export const PROVISIONAL_MAX_VERSION_ENTRIES = 32 // PROVISIONAL — bounded writer safeguard
export const PROVISIONAL_MAX_PLAN_BYTES = 1_048_576 // PROVISIONAL — bounded writer safeguard

export const PROGRESSION_PLAN_SCHEMA_VERSION = 'myboon.progression_plan.v1' as const

export type ProgressionPlanOutcome =
  | { kind: 'apply'; drafts: ItemDraft[]; operations: ExistingItemOperation[] }
  | { kind: 'retain_observation'; reason: string }
  | { kind: 'hold'; reason: string; missingDependency: string }

export interface ItemDraft {
  /** Model-supplied local key; the store assigns the persisted item identity. */
  localKey: string
  /** Model-supplied candidate id (may be null); never used as a persisted identity. */
  candidateId: string | null
  note: string
  /** PROVISIONAL cap 8. */
  entityLinks: ItemEntityLink[]
  /** PROVISIONAL cap 4. */
  continuityLinks: ItemContinuityLink[]
  /** PROVISIONAL cap 32. */
  evidenceRefs: ItemEvidenceRef[]
}

export interface ItemEntityLink {
  /** Code-resolved entity reference; the model proposes `candidateEntityRef`. */
  resolvedEntityRef: string
  candidateEntityRef: string | null
  role: string
}

export interface ItemContinuityLink {
  /** Local key of another draft in this plan (must resolve within the plan). */
  toLocalKey: string
  kind: string
}

export interface ItemEvidenceRef {
  claimId: string
  evidenceId: string
  sourceRef: string
}

export interface ExistingItemOperation {
  /** Code-resolved candidate reference; the model never supplies a persisted item ID. */
  candidateItemRef: string | null
  itemId: string
  kind: 'annotate' | 'correct' | 'supersede' | 'retract' | 'attach_evidence' | 'remove_membership'
  payload: Record<string, unknown>
}

export interface ProgressionPlanV1 {
  contractVersion: 1
  /** Assigned by code for the logical operation; the model never picks this. */
  operationId: string
  workId: string
  packetDigest: string
  contextDigest: string
  contextWatermark: string | null
  policyVersion: string
  promptVersion: string
  decisionVersions: Record<string, string>
  targetRevisions: Record<string, string>
  outcome: ProgressionPlanOutcome
}

export class ProgressionPlanValidationError extends Error {
  constructor(readonly field: string, detail: string) {
    super(`Progression plan validation failed at ${field}: ${detail}`)
    this.name = 'ProgressionPlanValidationError'
  }
}

const BOUNDED_STRING_MAX = 1_000

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function boundedString(value: unknown, field: string, max: number = BOUNDED_STRING_MAX): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProgressionPlanValidationError(field, 'must be a non-empty string')
  }
  const trimmed = value.trim()
  if (trimmed.length > max) {
    throw new ProgressionPlanValidationError(field, `exceeds the bounded maximum of ${max} characters`)
  }
  return trimmed
}

function optionalBoundedString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  return boundedString(value, field)
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ProgressionPlanValidationError(field, 'must be an object of string values')
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
  if (entries.length > PROVISIONAL_MAX_VERSION_ENTRIES) {
    throw new ProgressionPlanValidationError(
      field,
      `exceeds the PROVISIONAL cap of ${PROVISIONAL_MAX_VERSION_ENTRIES} entries`,
    )
  }
  const result = Object.create(null) as Record<string, string>
  for (const [rawKey, entry] of entries) {
    const key = boundedString(rawKey, `${field}.key`)
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new ProgressionPlanValidationError(field, `contains duplicate normalized key ${key}`)
    }
    result[key] = boundedString(entry, `${field}.${key}`)
  }
  return result
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ProgressionPlanValidationError(field, 'must be an object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProgressionPlanValidationError(field, 'must be a plain object')
  }
  return value as Record<string, unknown>
}

function assertJsonData(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 32) throw new TypeError('payload exceeds the JSON depth cap')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object') throw new TypeError('payload contains a non-JSON value')
  if (ancestors.has(value)) throw new TypeError('payload contains a cycle')
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertJsonData(item, ancestors, depth + 1)
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('payload contains a non-plain object')
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('payload contains symbol keys')
    for (const item of Object.values(value as Record<string, unknown>)) assertJsonData(item, ancestors, depth + 1)
  }
  ancestors.delete(value)
}

function validateDraft(draft: unknown, index: number): ItemDraft {
  if (!draft || typeof draft !== 'object') {
    throw new ProgressionPlanValidationError(`outcome.drafts[${index}]`, 'must be an object')
  }
  const candidate = draft as Partial<ItemDraft>
  const base = `outcome.drafts[${index}]`
  const localKey = boundedString(candidate.localKey, `${base}.localKey`)
  if (typeof candidate.note !== 'string' || candidate.note.trim() === '') {
    throw new ProgressionPlanValidationError(`${base}.note`, 'must be a non-empty string')
  }
  const note = candidate.note.trim()
  if (note.length > PROVISIONAL_MAX_NOTE_CHARS) {
    throw new ProgressionPlanValidationError(
      `${base}.note`,
      `exceeds the PROVISIONAL cap of ${PROVISIONAL_MAX_NOTE_CHARS} characters`,
    )
  }
  if (!Array.isArray(candidate.entityLinks)) {
    throw new ProgressionPlanValidationError(`${base}.entityLinks`, 'must be an array')
  }
  if (candidate.entityLinks.length > PROVISIONAL_MAX_ENTITY_LINKS_PER_ITEM) {
    throw new ProgressionPlanValidationError(
      `${base}.entityLinks`,
      `exceeds the PROVISIONAL cap of ${PROVISIONAL_MAX_ENTITY_LINKS_PER_ITEM}`,
    )
  }
  if (!Array.isArray(candidate.continuityLinks)) {
    throw new ProgressionPlanValidationError(`${base}.continuityLinks`, 'must be an array')
  }
  if (candidate.continuityLinks.length > PROVISIONAL_MAX_CONTINUITY_LINKS_PER_ITEM) {
    throw new ProgressionPlanValidationError(
      `${base}.continuityLinks`,
      `exceeds the PROVISIONAL cap of ${PROVISIONAL_MAX_CONTINUITY_LINKS_PER_ITEM}`,
    )
  }
  if (!Array.isArray(candidate.evidenceRefs)) {
    throw new ProgressionPlanValidationError(`${base}.evidenceRefs`, 'must be an array')
  }
  if (candidate.evidenceRefs.length > PROVISIONAL_MAX_EVIDENCE_REFS_PER_ITEM) {
    throw new ProgressionPlanValidationError(
      `${base}.evidenceRefs`,
      `exceeds the PROVISIONAL cap of ${PROVISIONAL_MAX_EVIDENCE_REFS_PER_ITEM}`,
    )
  }
  const entityLinks = candidate.entityLinks.map((link, linkIndex) => {
    const linkBase = `${base}.entityLinks[${linkIndex}]`
    if (!link || typeof link !== 'object') {
      throw new ProgressionPlanValidationError(linkBase, 'must be an object')
    }
    const candidateLink = link as Partial<ItemEntityLink>
    return {
      // The model's `resolvedEntityRef` is intentionally ignored. Code resolves
      // the candidate below and fills this placeholder before the plan escapes.
      resolvedEntityRef: '',
      candidateEntityRef: optionalBoundedString(candidateLink.candidateEntityRef, `${linkBase}.candidateEntityRef`),
      role: boundedString(candidateLink.role, `${linkBase}.role`),
    }
  })
  const continuityLinks = candidate.continuityLinks.map((link, linkIndex) => {
    const linkBase = `${base}.continuityLinks[${linkIndex}]`
    if (!link || typeof link !== 'object') {
      throw new ProgressionPlanValidationError(linkBase, 'must be an object')
    }
    const candidateLink = link as Partial<ItemContinuityLink>
    return {
      toLocalKey: boundedString(candidateLink.toLocalKey, `${linkBase}.toLocalKey`),
      kind: boundedString(candidateLink.kind, `${linkBase}.kind`),
    }
  })
  const evidenceRefs = candidate.evidenceRefs.map((ref, refIndex) => {
    const refBase = `${base}.evidenceRefs[${refIndex}]`
    if (!ref || typeof ref !== 'object') {
      throw new ProgressionPlanValidationError(refBase, 'must be an object')
    }
    const candidateRef = ref as Partial<ItemEvidenceRef>
    return {
      claimId: boundedString(candidateRef.claimId, `${refBase}.claimId`),
      evidenceId: boundedString(candidateRef.evidenceId, `${refBase}.evidenceId`),
      sourceRef: boundedString(candidateRef.sourceRef, `${refBase}.sourceRef`),
    }
  })
  return {
    localKey,
    candidateId: optionalBoundedString(candidate.candidateId, `${base}.candidateId`),
    note,
    entityLinks,
    continuityLinks,
    evidenceRefs,
  }
}

function validateApplyOutcome(
  outcome: Partial<Extract<ProgressionPlanOutcome, { kind: 'apply' }>>,
  identityResolver?: (candidateEntityRef: string | null, draft: ItemDraft) => string | null,
  existingItemResolver?: (candidateItemRef: string | null, kind: ExistingItemOperation['kind']) => string | null,
  evidenceRefResolver?: (candidate: ItemEvidenceRef, draft: ItemDraft) => ItemEvidenceRef | null,
): Extract<ProgressionPlanOutcome, { kind: 'apply' }> {
  if (!Array.isArray(outcome.drafts)) {
    throw new ProgressionPlanValidationError('outcome.drafts', 'must be an array')
  }
  if (outcome.drafts.length > PROVISIONAL_MAX_ITEMS_PER_PACKET) {
    throw new ProgressionPlanValidationError(
      'outcome.drafts',
      `exceeds the PROVISIONAL cap of ${PROVISIONAL_MAX_ITEMS_PER_PACKET} items per packet`,
    )
  }
  if (!Array.isArray(outcome.operations)) {
    throw new ProgressionPlanValidationError('outcome.operations', 'must be an array')
  }
  if (outcome.operations.length > PROVISIONAL_MAX_EXISTING_ITEM_OPERATIONS_PER_PACKET) {
    throw new ProgressionPlanValidationError(
      'outcome.operations',
      `exceeds the PROVISIONAL cap of ${PROVISIONAL_MAX_EXISTING_ITEM_OPERATIONS_PER_PACKET}`,
    )
  }
  const drafts = outcome.drafts.map((draft, index) => validateDraft(draft, index))
  const localKeys = new Set<string>()
  for (const draft of drafts) {
    if (localKeys.has(draft.localKey)) {
      throw new ProgressionPlanValidationError('outcome.drafts', `duplicate localKey: ${draft.localKey}`)
    }
    localKeys.add(draft.localKey)
  }
  // Unresolved identity blocks apply. Model-provided resolvedEntityRef values
  // are ignored; every link is bound by the code-owned resolver before commit.
  if (drafts.length > 0 && !identityResolver) {
    throw new ProgressionPlanValidationError(
      'outcome.drafts',
      'apply requires a code-owned identity resolver for every draft',
    )
  }
  for (const draft of drafts) {
    if (draft.evidenceRefs.length === 0) {
      throw new ProgressionPlanValidationError(`outcome.drafts[localKey=${draft.localKey}].evidenceRefs`, 'an accepted managed note must cite at least one saved Research edge')
    }
    if (draft.entityLinks.length === 0) {
      throw new ProgressionPlanValidationError(
        `outcome.drafts[localKey=${draft.localKey}].entityLinks`,
        'an apply draft must have at least one resolved Entity identity',
      )
    }
    for (const link of draft.entityLinks) {
      let resolved: string | null
      try {
        resolved = identityResolver!(link.candidateEntityRef, draft)
      } catch {
        throw new ProgressionPlanValidationError(
          `outcome.drafts[localKey=${draft.localKey}]`,
          'code-owned Entity identity resolution failed',
        )
      }
      if (resolved === null) {
        throw new ProgressionPlanValidationError(
          `outcome.drafts[localKey=${draft.localKey}]`,
          'unresolved identity blocks apply — code must assign persisted identity before apply',
        )
      }
      link.resolvedEntityRef = boundedString(
        resolved,
        `outcome.drafts[localKey=${draft.localKey}].entityLinks.resolvedEntityRef`,
      )
    }
  }
  // Continuity links must resolve within the plan (same-packet drafts only).
  for (const draft of drafts) {
    for (const link of draft.continuityLinks) {
      if (!localKeys.has(link.toLocalKey)) {
        throw new ProgressionPlanValidationError(
          `outcome.drafts[localKey=${draft.localKey}].continuityLinks`,
          `unresolved local key ${link.toLocalKey} — continuity links must resolve within the plan`,
        )
      }
    }
  }
  // Evidence references must be present in the saved packet/research source;
  // a model-shaped ID alone is not proof that an item supports the claim.
  const hasEvidenceRefs = drafts.some((draft) => draft.evidenceRefs.length > 0)
  if (hasEvidenceRefs && !evidenceRefResolver) {
    throw new ProgressionPlanValidationError(
      'outcome.drafts.evidenceRefs',
      'apply requires a code-owned evidence-reference resolver',
    )
  }
  for (const draft of drafts) {
    draft.evidenceRefs = draft.evidenceRefs.map((candidate, refIndex) => {
      let resolved: ItemEvidenceRef | null
      try {
        resolved = evidenceRefResolver!(candidate, draft)
      } catch {
        throw new ProgressionPlanValidationError(
          `outcome.drafts[localKey=${draft.localKey}].evidenceRefs[${refIndex}]`,
          'code-owned evidence reference resolution failed',
        )
      }
      if (resolved === null) {
        throw new ProgressionPlanValidationError(
          `outcome.drafts[localKey=${draft.localKey}].evidenceRefs[${refIndex}]`,
          'evidence reference is not present in the saved source packet',
        )
      }
      return {
        claimId: boundedString(resolved.claimId, 'evidenceRef.claimId'),
        evidenceId: boundedString(resolved.evidenceId, 'evidenceRef.evidenceId'),
        sourceRef: boundedString(resolved.sourceRef, 'evidenceRef.sourceRef'),
      }
    })
  }
  // An apply with zero drafts and zero operations has nothing to commit —
  // hold or retain_observation is the correct outcome kind for that.
  if (drafts.length === 0 && outcome.operations.length === 0) {
    throw new ProgressionPlanValidationError(
      'outcome',
      'apply requires at least one draft or one existing-item operation',
    )
  }
  if (outcome.operations.length > 0 && !existingItemResolver) {
    throw new ProgressionPlanValidationError(
      'outcome.operations',
      'apply requires a code-owned resolver for every existing-item operation',
    )
  }
  const normalizedOperations = outcome.operations.map((operation, index) => {
    if (!operation || typeof operation !== 'object') {
      throw new ProgressionPlanValidationError(`outcome.operations[${index}]`, 'must be an object')
    }
    const candidateOperation = operation as Partial<ExistingItemOperation>
    if (
      candidateOperation.kind !== 'annotate' &&
      candidateOperation.kind !== 'correct' &&
      candidateOperation.kind !== 'supersede' &&
      candidateOperation.kind !== 'retract' &&
      candidateOperation.kind !== 'attach_evidence' &&
      candidateOperation.kind !== 'remove_membership'
    ) {
      throw new ProgressionPlanValidationError(
        `outcome.operations[${index}].kind`,
        `unsupported kind: ${String(candidateOperation.kind)}`,
      )
    }
    const candidateItemRef = optionalBoundedString(
      candidateOperation.candidateItemRef,
      `outcome.operations[${index}].candidateItemRef`,
    )
    let itemId: string | null
    try {
      itemId = existingItemResolver!(candidateItemRef, candidateOperation.kind)
    } catch {
      throw new ProgressionPlanValidationError(
        `outcome.operations[${index}]`,
        'code-owned existing-item resolution failed',
      )
    }
    if (itemId === null) {
      throw new ProgressionPlanValidationError(
        `outcome.operations[${index}]`,
        'unresolved existing-item identity blocks apply',
      )
    }
    let payload: Record<string, unknown>
    try {
      const candidatePayload = plainRecord(
        candidateOperation.payload,
        `outcome.operations[${index}].payload`,
      )
      assertJsonData(candidatePayload)
      payload = JSON.parse(canonicalJson(candidatePayload)) as Record<string, unknown>
    } catch {
      throw new ProgressionPlanValidationError(
        `outcome.operations[${index}].payload`,
        'must contain canonical JSON values only',
      )
    }
    if (Buffer.byteLength(canonicalJson(payload), 'utf8') > PROVISIONAL_MAX_OPERATION_PAYLOAD_BYTES) {
      throw new ProgressionPlanValidationError(
        `outcome.operations[${index}].payload`,
        `exceeds the PROVISIONAL cap of ${PROVISIONAL_MAX_OPERATION_PAYLOAD_BYTES} bytes`,
      )
    }
    // Existing-item attachments owe the same exact saved claim/evidence edge
    // proof as new drafts. Model-shaped citations cannot become provenance.
    if (payload.evidenceRefs !== undefined) {
      if (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.length > PROVISIONAL_MAX_EVIDENCE_REFS_PER_ITEM) {
        throw new ProgressionPlanValidationError(`outcome.operations[${index}].payload.evidenceRefs`, 'must be a bounded evidence array')
      }
      const resolverDraft: ItemDraft = { localKey: 'existing-operation', candidateId: null, note: 'Evidence attachment', entityLinks: [], continuityLinks: [], evidenceRefs: [] }
      payload.evidenceRefs = payload.evidenceRefs.map((reference, referenceIndex) => {
        const value = plainRecord(reference, 'operation evidence reference')
        const candidate: ItemEvidenceRef = {
          claimId: boundedString(value.claimId, 'operation evidence claimId'),
          evidenceId: boundedString(value.evidenceId, 'operation evidence evidenceId'),
          sourceRef: boundedString(value.sourceRef, 'operation evidence sourceRef'),
        }
        const resolved = evidenceRefResolver?.(candidate, resolverDraft)
        if (!resolved) throw new ProgressionPlanValidationError(`outcome.operations[${index}].payload.evidenceRefs[${referenceIndex}]`, 'evidence reference is not present in the saved source packet')
        return resolved
      })
    }
    if (candidateOperation.kind === 'attach_evidence' && (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.length === 0)) {
      throw new ProgressionPlanValidationError(`outcome.operations[${index}].payload.evidenceRefs`, 'an attachment must preserve at least one saved evidence edge')
    }
    if (candidateOperation.kind === 'correct' || candidateOperation.kind === 'supersede') {
      const localKey = boundedString(payload.successorLocalKey, `outcome.operations[${index}].payload.successorLocalKey`)
      if (!localKeys.has(localKey)) throw new ProgressionPlanValidationError(`outcome.operations[${index}].payload.successorLocalKey`, 'successor must be a new draft in this same plan')
      payload.successorLocalKey = localKey
    }
    if (candidateOperation.kind === 'retract' || candidateOperation.kind === 'remove_membership') {
      payload.reason = boundedString(payload.reason, `outcome.operations[${index}].payload.reason`)
    }
    if (candidateOperation.kind === 'remove_membership') {
      payload.entityId = boundedString(payload.entityId, `outcome.operations[${index}].payload.entityId`)
      if (!identityResolver?.(payload.entityId as string, { localKey: 'membership-removal', candidateId: null, note: String(payload.reason), entityLinks: [], continuityLinks: [], evidenceRefs: [] })) {
        throw new ProgressionPlanValidationError(`outcome.operations[${index}].payload.entityId`, 'membership identity is not in the grounded context')
      }
    }
    return {
      candidateItemRef,
      itemId: boundedString(itemId, `outcome.operations[${index}].itemId`),
      kind: candidateOperation.kind,
      payload,
    }
  })
  return { kind: 'apply', drafts, operations: normalizedOperations }
}

/**
 * Validate a model- or code-produced plan and return its immutable, bounded
 * shape. Throws ProgressionPlanValidationError on any cap breach, digest
 * error, duplicate local key, unresolved identity (apply), or unresolved
 * continuity link.
 *
 * `packetDigest` / `contextDigest` are supplied by code, and the validator
 * only checks their shape — the semantic digest is computed separately by
 * `progressionPlanDigest` over the frozen validated plan so that code, not
 * the model, is the source of truth for identity.
 *
 * `identityResolver` — required for each apply draft. It receives the model's candidate
 * reference and returns a code-verified persistent Entity ID, or null to fail closed.
 */
export function validateProgressionPlan(
  input: {
    contractVersion: number
    operationId: unknown
    workId: unknown
    packetDigest: unknown
    contextDigest: unknown
    contextWatermark: unknown
    policyVersion: unknown
    promptVersion: unknown
    decisionVersions: unknown
    targetRevisions: unknown
    outcome: unknown
  },
  identityResolver?: (candidateEntityRef: string | null, draft: ItemDraft) => string | null,
  existingItemResolver?: (candidateItemRef: string | null, kind: ExistingItemOperation['kind']) => string | null,
  evidenceRefResolver?: (candidate: ItemEvidenceRef, draft: ItemDraft) => ItemEvidenceRef | null,
): ProgressionPlanV1 {
  if (input.contractVersion !== 1) {
    throw new ProgressionPlanValidationError('contractVersion', 'must be 1')
  }
  const operationId = boundedString(input.operationId, 'operationId')
  const workId = boundedString(input.workId, 'workId')
  if (!isSha256(input.packetDigest)) {
    throw new ProgressionPlanValidationError('packetDigest', 'must be a lowercase SHA-256 hex digest')
  }
  if (!isSha256(input.contextDigest)) {
    throw new ProgressionPlanValidationError('contextDigest', 'must be a lowercase SHA-256 hex digest')
  }
  let contextWatermark: string | null = null
  if (input.contextWatermark !== null && input.contextWatermark !== undefined) {
    if (typeof input.contextWatermark !== 'string' || input.contextWatermark.trim() === '') {
      throw new ProgressionPlanValidationError('contextWatermark', 'must be null or a non-empty string')
    }
    contextWatermark = boundedString(input.contextWatermark, 'contextWatermark')
  }
  const policyVersion = boundedString(input.policyVersion, 'policyVersion')
  const promptVersion = boundedString(input.promptVersion, 'promptVersion')
  const decisionVersions = stringRecord(input.decisionVersions, 'decisionVersions')
  const targetRevisions = stringRecord(input.targetRevisions, 'targetRevisions')

  const outcome = input.outcome
  if (!outcome || typeof outcome !== 'object') {
    throw new ProgressionPlanValidationError('outcome', 'must be an object')
  }
  const outcomeCandidate = outcome as Partial<ProgressionPlanOutcome>
  if (
    outcomeCandidate.kind !== 'apply' &&
    outcomeCandidate.kind !== 'retain_observation' &&
    outcomeCandidate.kind !== 'hold'
  ) {
    throw new ProgressionPlanValidationError('outcome.kind', `unsupported kind: ${String(outcomeCandidate.kind)}`)
  }

  let normalizedOutcome: ProgressionPlanOutcome
  if (outcomeCandidate.kind === 'apply') {
    normalizedOutcome = validateApplyOutcome(
      outcomeCandidate as Partial<Extract<ProgressionPlanOutcome, { kind: 'apply' }>>,
      identityResolver,
      existingItemResolver,
      evidenceRefResolver,
    )
  } else if (outcomeCandidate.kind === 'retain_observation') {
    const retainOutcome = outcomeCandidate as Partial<Extract<ProgressionPlanOutcome, { kind: 'retain_observation' }>>
    normalizedOutcome = {
      kind: 'retain_observation',
      reason: boundedString(retainOutcome.reason, 'outcome.reason'),
    }
  } else {
    const holdOutcome = outcomeCandidate as Partial<Extract<ProgressionPlanOutcome, { kind: 'hold' }>>
    normalizedOutcome = {
      kind: 'hold',
      reason: boundedString(holdOutcome.reason, 'hold reason'),
      missingDependency: boundedString(holdOutcome.missingDependency, 'hold missingDependency'),
    }
  }

  const requiredTargetIds = normalizedOutcome.kind === 'apply'
    ? [
        ...normalizedOutcome.drafts.flatMap((draft) => draft.entityLinks.map((link) => link.resolvedEntityRef)),
        ...normalizedOutcome.operations.flatMap((operation) => operation.kind === 'remove_membership' ? [operation.itemId, String(operation.payload.entityId)] : [operation.itemId]),
      ]
    : []
  if (
    normalizedOutcome.kind === 'apply' &&
    normalizedOutcome.drafts.length + normalizedOutcome.operations.length > 0 &&
    Object.keys(targetRevisions).length === 0
  ) {
    throw new ProgressionPlanValidationError('targetRevisions', 'managed writes require code-owned target revision expectations')
  }
  for (const targetId of requiredTargetIds) {
    if (!Object.prototype.hasOwnProperty.call(targetRevisions, targetId)) {
      throw new ProgressionPlanValidationError('targetRevisions', `missing commit-time revision for target ${targetId}`)
    }
  }

  const plan: ProgressionPlanV1 = {
    contractVersion: 1,
    operationId,
    workId,
    packetDigest: input.packetDigest,
    contextDigest: input.contextDigest,
    contextWatermark,
    policyVersion,
    promptVersion,
    decisionVersions,
    targetRevisions,
    outcome: normalizedOutcome,
  }
  if (Buffer.byteLength(canonicalJson(plan), 'utf8') > PROVISIONAL_MAX_PLAN_BYTES) {
    throw new ProgressionPlanValidationError(
      'plan',
      `exceeds the PROVISIONAL cap of ${PROVISIONAL_MAX_PLAN_BYTES} bytes`,
    )
  }
  return deepFreeze(plan)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** Canonical plan digest over the frozen validated plan (code-owned). */
export function progressionPlanDigest(plan: ProgressionPlanV1): string {
  return sha256Hex(canonicalJson(plan))
}
