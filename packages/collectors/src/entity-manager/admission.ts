import type { EntityHint, ResearchPacketV1 } from '../signal-platform/contracts'
import { PlatformFailure } from '../signal-platform/failures'
import { validateResearchPacket } from '../signal-platform/validation'

export const ENTITY_ADMISSION_SCHEMA_VERSION = 'myboon.entity_admission.v1' as const
export const ENTITY_ADMISSION_MAX_SHORTLIST_SIZE = 20

export interface CanonicalEntityRef {
  entityId: string
  slug: string
  name: string
  type: string
  aliases: string[]
  summary: string | null
  /** Deterministic code-owned rank; lower ranks are preferred. */
  rank: number
}

/** A bounded excerpt linked to canonical packet evidence and, optionally, claims. */
export interface EvidenceSpan {
  spanId: string
  evidenceId: string
  claimRefs: string[]
  text: string
}

export type CanonAvailability =
  | { state: 'loaded', complete: true }
  | { state: 'loaded', complete: false, detail?: string }
  | { state: 'unavailable', complete: false, detail?: string }

export interface EntityAdmissionInput {
  schemaVersion: typeof ENTITY_ADMISSION_SCHEMA_VERSION
  packet: ResearchPacketV1
  canonicalEntityShortlist: CanonicalEntityRef[]
  entityHints: EntityHint[]
  evidenceSpans: EvidenceSpan[]
  shortlistPolicyVersion: string
  canonAvailability: CanonAvailability
}

export interface BuildEntityAdmissionInput {
  packet: ResearchPacketV1
  canonicalEntityShortlist: readonly CanonicalEntityRef[]
  evidenceSpans: readonly EvidenceSpan[]
  shortlistPolicyVersion: string
  canonAvailability: CanonAvailability
}

export interface NewEntityProposal {
  slug: string
  name: string
  type: string
  aliases?: string[]
  summary?: string | null
}

interface DecisionSupport {
  supportingClaimIds?: string[]
  supportingEvidenceIds?: string[]
}

export type EntityAdmissionDecision =
  | ({ action: 'select_existing', entityId: string } & DecisionSupport)
  | ({ action: 'create_new', proposal: NewEntityProposal } & DecisionSupport)

export type ValidatedEntityAdmissionDecision =
  | {
    action: 'select_existing'
    entityId: string
    supportingClaimIds: string[]
    supportingEvidenceIds: string[]
  }
  | {
    action: 'create_new'
    proposal: Required<Omit<NewEntityProposal, 'summary'>> & { summary: string | null }
    supportingClaimIds: string[]
    supportingEvidenceIds: string[]
  }

export class EntityAdmissionValidationError extends PlatformFailure {
  constructor(message: string) {
    super({ category: 'entity_resolution_failed', message, retryable: false })
    this.name = 'EntityAdmissionValidationError'
  }
}

/** Fail-closed retryable error used when duplicate-safe creation cannot run. */
export class EntityCanonUnavailableError extends PlatformFailure {
  constructor(message = 'Authoritative entity canon is unavailable or incomplete.') {
    super({ category: 'storage_transient', message, retryable: true })
    this.name = 'EntityCanonUnavailableError'
  }
}

/**
 * Builds the normalized admission envelope after validating packet-local
 * references. No model, database, or network work occurs here.
 */
export function buildEntityAdmissionInput(input: BuildEntityAdmissionInput): EntityAdmissionInput {
  let packet: ResearchPacketV1
  try {
    packet = validateResearchPacket(input.packet)
  } catch (error) {
    throw new EntityAdmissionValidationError(error instanceof Error ? error.message : 'Invalid Research Packet.')
  }
  const shortlistPolicyVersion = policyVersion(input.shortlistPolicyVersion)
  const refs = packetReferences(packet)
  validatePacketReferences(packet, refs)
  const entityHints = packet.entityHints.map((hint, index) => normalizeHint(hint, index, refs))
  const evidenceSpans = normalizeEvidenceSpans(input.evidenceSpans, refs)
  const canonicalEntityShortlist = normalizeShortlist(input.canonicalEntityShortlist)

  return {
    schemaVersion: ENTITY_ADMISSION_SCHEMA_VERSION,
    packet,
    canonicalEntityShortlist,
    entityHints,
    evidenceSpans,
    shortlistPolicyVersion,
    canonAvailability: normalizeCanonAvailability(input.canonAvailability),
  }
}

/**
 * Enforces the only two legal model outcomes. Existing selections are limited
 * to the supplied menu; creation additionally requires evidence and a complete
 * authoritative canon so duplicate checks cannot be skipped under failure.
 */
export function validateEntityAdmissionDecision(
  input: EntityAdmissionInput,
  decision: EntityAdmissionDecision,
): ValidatedEntityAdmissionDecision {
  const refs = packetReferences(input.packet)
  const supportingClaimIds = uniqueReferences(decision.supportingClaimIds ?? [], 'supportingClaimIds', refs.claimIds)
  const supportingEvidenceIds = uniqueReferences(
    decision.supportingEvidenceIds ?? [],
    'supportingEvidenceIds',
    refs.evidenceIds,
  )

  if (decision.action === 'select_existing') {
    const entityId = nonEmpty(decision.entityId, 'decision.entityId')
    if (!input.canonicalEntityShortlist.some((entity) => entity.entityId === entityId)) {
      throw new EntityAdmissionValidationError(`Unknown canonical entity ID: ${entityId}`)
    }
    return { action: 'select_existing', entityId, supportingClaimIds, supportingEvidenceIds }
  }

  if (decision.action !== 'create_new') {
    throw new EntityAdmissionValidationError('Decision action must be select_existing or create_new.')
  }
  if (input.canonAvailability.state !== 'loaded' || !input.canonAvailability.complete) {
    throw new EntityCanonUnavailableError()
  }

  const evidenceBackedClaims = supportingClaimIds.flatMap((claimId) => refs.claimEvidence.get(claimId) ?? [])
  if (supportingEvidenceIds.length === 0 && evidenceBackedClaims.length === 0) {
    throw new EntityAdmissionValidationError('create_new requires supporting packet evidence.')
  }

  const proposal = decision.proposal
  if (!proposal || typeof proposal !== 'object') {
    throw new EntityAdmissionValidationError('create_new requires an entity proposal.')
  }
  const slug = nonEmpty(proposal.slug, 'decision.proposal.slug')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new EntityAdmissionValidationError('decision.proposal.slug must be a canonical lowercase slug.')
  }

  return {
    action: 'create_new',
    proposal: {
      slug,
      name: nonEmpty(proposal.name, 'decision.proposal.name'),
      type: nonEmpty(proposal.type, 'decision.proposal.type'),
      aliases: sortedUniqueStrings(proposal.aliases ?? [], 'decision.proposal.aliases'),
      summary: proposal.summary === undefined || proposal.summary === null
        ? null
        : nonEmpty(proposal.summary, 'decision.proposal.summary'),
    },
    supportingClaimIds,
    supportingEvidenceIds,
  }
}

interface PacketReferences {
  claimIds: Set<string>
  evidenceIds: Set<string>
  claimEvidence: Map<string, string[]>
}

function packetReferences(packet: ResearchPacketV1): PacketReferences {
  const claimIds = new Set<string>()
  const evidenceIds = new Set<string>()
  const claimEvidence = new Map<string, string[]>()
  for (const claim of packet.claims) {
    if (claimIds.has(claim.claimId)) throw new EntityAdmissionValidationError(`Duplicate packet claim ID: ${claim.claimId}`)
    claimIds.add(claim.claimId)
    claimEvidence.set(claim.claimId, [...claim.evidenceRefs])
  }
  for (const evidence of packet.evidence) {
    if (evidenceIds.has(evidence.evidenceId)) {
      throw new EntityAdmissionValidationError(`Duplicate packet evidence ID: ${evidence.evidenceId}`)
    }
    evidenceIds.add(evidence.evidenceId)
  }
  return { claimIds, evidenceIds, claimEvidence }
}

function validatePacketReferences(packet: ResearchPacketV1, refs: PacketReferences): void {
  for (const [index, claim] of packet.claims.entries()) {
    uniqueReferences(claim.evidenceRefs, `packet.claims[${index}].evidenceRefs`, refs.evidenceIds)
  }
  for (const [index, fact] of packet.verifiedFacts.entries()) {
    uniqueReferences(fact.evidenceRefs, `packet.verifiedFacts[${index}].evidenceRefs`, refs.evidenceIds)
  }
  for (const [index, claim] of packet.unresolvedClaims.entries()) {
    uniqueReferences(claim.evidenceRefs, `packet.unresolvedClaims[${index}].evidenceRefs`, refs.evidenceIds)
  }
}

function normalizeHint(hint: EntityHint, index: number, refs: PacketReferences): EntityHint {
  const claimRefs = hint.claimRefs
  const evidenceRefs = hint.evidenceRefs
  if (claimRefs.length === 0 && evidenceRefs.length === 0) {
    throw new EntityAdmissionValidationError(`packet.entityHints[${index}] must reference a packet claim or evidence item.`)
  }
  return {
    ...hint,
    claimRefs: uniqueReferences(claimRefs, `packet.entityHints[${index}].claimRefs`, refs.claimIds),
    evidenceRefs: uniqueReferences(evidenceRefs, `packet.entityHints[${index}].evidenceRefs`, refs.evidenceIds),
    aliases: sortedUniqueStrings(hint.aliases, `packet.entityHints[${index}].aliases`),
  }
}

function normalizeEvidenceSpans(spans: readonly EvidenceSpan[], refs: PacketReferences): EvidenceSpan[] {
  const spanIds = new Set<string>()
  return spans.map((span, index) => {
    const spanId = nonEmpty(span.spanId, `evidenceSpans[${index}].spanId`)
    if (spanIds.has(spanId)) throw new EntityAdmissionValidationError(`Duplicate evidence span ID: ${spanId}`)
    spanIds.add(spanId)
    const evidenceId = reference(span.evidenceId, `evidenceSpans[${index}].evidenceId`, refs.evidenceIds)
    const claimRefs = uniqueReferences(span.claimRefs, `evidenceSpans[${index}].claimRefs`, refs.claimIds)
    return { spanId, evidenceId, claimRefs, text: nonEmpty(span.text, `evidenceSpans[${index}].text`) }
  }).sort((left, right) => compareStrings(left.spanId, right.spanId))
}

function normalizeShortlist(shortlist: readonly CanonicalEntityRef[]): CanonicalEntityRef[] {
  if (shortlist.length > ENTITY_ADMISSION_MAX_SHORTLIST_SIZE) {
    throw new EntityAdmissionValidationError(
      `canonicalEntityShortlist exceeds the ${ENTITY_ADMISSION_MAX_SHORTLIST_SIZE}-entity limit.`,
    )
  }
  const ids = new Set<string>()
  return shortlist.map((entity, index) => {
    const entityId = nonEmpty(entity.entityId, `canonicalEntityShortlist[${index}].entityId`)
    if (ids.has(entityId)) throw new EntityAdmissionValidationError(`Duplicate canonical entity ID: ${entityId}`)
    ids.add(entityId)
    if (!Number.isInteger(entity.rank) || entity.rank < 0) {
      throw new EntityAdmissionValidationError(`canonicalEntityShortlist[${index}].rank must be a non-negative integer.`)
    }
    return {
      entityId,
      slug: nonEmpty(entity.slug, `canonicalEntityShortlist[${index}].slug`),
      name: nonEmpty(entity.name, `canonicalEntityShortlist[${index}].name`),
      type: nonEmpty(entity.type, `canonicalEntityShortlist[${index}].type`),
      aliases: sortedUniqueStrings(entity.aliases, `canonicalEntityShortlist[${index}].aliases`),
      summary: entity.summary === null ? null : nonEmpty(entity.summary, `canonicalEntityShortlist[${index}].summary`),
      rank: entity.rank,
    }
  }).sort((left, right) => left.rank - right.rank || compareStrings(left.entityId, right.entityId))
}

function normalizeCanonAvailability(value: CanonAvailability): CanonAvailability {
  if (value.state === 'loaded' && value.complete === true) return { state: 'loaded', complete: true }
  if (value.state === 'loaded' && value.complete === false) {
    return { state: 'loaded', complete: false, ...(value.detail ? { detail: value.detail } : {}) }
  }
  if (value.state === 'unavailable' && value.complete === false) {
    return { state: 'unavailable', complete: false, ...(value.detail ? { detail: value.detail } : {}) }
  }
  throw new EntityAdmissionValidationError('Invalid canon availability state.')
}

function policyVersion(value: string): string {
  const normalized = nonEmpty(value, 'shortlistPolicyVersion')
  if (normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalized) || !/\d/.test(normalized)) {
    throw new EntityAdmissionValidationError('shortlistPolicyVersion must be a bounded versioned identifier.')
  }
  return normalized
}

function uniqueReferences(values: readonly string[], field: string, known: Set<string>): string[] {
  return sortedUniqueStrings(values, field).map((value) => reference(value, field, known))
}

function reference(value: string, field: string, known: Set<string>): string {
  const normalized = nonEmpty(value, field)
  if (!known.has(normalized)) throw new EntityAdmissionValidationError(`${field} references unknown ID: ${normalized}`)
  return normalized
}

function sortedUniqueStrings(values: readonly string[], field: string): string[] {
  if (!Array.isArray(values)) throw new EntityAdmissionValidationError(`${field} must be an array.`)
  return [...new Set(values.map((value) => nonEmpty(value, field)))].sort(compareStrings)
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EntityAdmissionValidationError(`${field} must be a non-empty string.`)
  }
  return value.trim()
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
