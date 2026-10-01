import { stableContractId } from './adapters/identity'
import { canonicalJson } from './canonical-json'
import type {
  FailureCategory,
  ResearchCompletion,
  ResearchPacketV1,
  ResearchWorkItem,
  RetrievedEvidence,
  Signal,
  WorkStatus,
} from './contracts'
import { ContractValidationError, validateResearchPacket, validateResearchWorkItem } from './validation'
import { isRetryableFailure } from './failures'

export const RESEARCH_READINESS_SCHEMA_VERSION = 'myboon.research_readiness.v1' as const
export const RESEARCH_READINESS_POLICY_VERSION = 'myboon.research_readiness_policy.v1' as const
export const RESEARCH_READINESS_ASSESSOR_ID = 'myboon.research_readiness.assessor.v1' as const

/**
 * Research-owned sufficiency decision for one immutable packet.
 *
 * The completion label is recorded provenance, never the decision: `partial`
 * output may be ready and `complete` output may not be. Nothing outside this
 * module infers sufficiency from a packet's existence or its completion label.
 */
export type ResearchReadinessOutcome =
  | 'ready_for_entity'
  | 'resolved_without_new_item'
  | 'blocked'
  | 'failed'
  | 'readiness_unknown'

/** What kind of write Entity Manager is being asked to make, if any. */
export type ResearchEntityActionKind = 'none' | 'entity_item' | 'evidence_attachment'

/**
 * The action this decision owes Entity Manager.
 *
 * `resolved_without_new_item` means no *new note*, not "nothing happens". The
 * PRD is explicit that a required source/evidence attachment or reuse action
 * must still be preserved and reach the validated Entity writer. So the owed
 * action is modelled explicitly: either `none` for a deliberate no-action
 * result, or a required action carrying its target and a stable idempotency
 * identity. A no-new-item result with a required action stays claimable.
 */
export type ResearchEntityAction =
  | { kind: 'none' }
  | {
    kind: ResearchEntityActionKind
    /**
     * Stable identity for this required action, so re-entry and replay address
     * the same owed write rather than creating a second one.
     */
    actionId: string
    /**
     * What the action attaches to. Required for an `evidence_attachment`;
     * null for a self-contained `entity_item` with no prior target.
     */
    targetId: string | null
  }

export type ResearchAttributionCoverage =
  | 'none'
  | 'unattributed'
  | 'partially_attributed'
  | 'attributed'

/**
 * Measured coverage of the handoff candidate. It exists so a later reader can
 * tell a useful attributed contribution from an empty or unsupported packet
 * without re-reading the packet body.
 */
export interface ResearchContributionCoverage extends Record<string, unknown> {
  claimCount: number
  attributedClaimCount: number
  evidenceLinkedClaimCount: number
  verifiedFactCount: number
  unresolvedClaimCount: number
  referencedEvidenceIds: string[]
  limitationsCount: number
  openQuestionsCount: number
  attribution: ResearchAttributionCoverage
  /** True when at least one attributable, evidence-resolving claim or fact exists. */
  useful: boolean
}

export interface ResearchReadinessV1 extends Record<string, unknown> {
  schemaVersion: typeof RESEARCH_READINESS_SCHEMA_VERSION
  readinessId: string
  workId: string
  signalId: string
  sourceType: Signal['sourceType']
  packetId: string
  researchContractVersion: ResearchWorkItem['researchContractVersion']
  readinessPolicyVersion: string
  outcome: ResearchReadinessOutcome
  entityAction: ResearchEntityAction
  /** Recorded completion provenance. Never read as the sufficiency decision. */
  packetCompletion: ResearchCompletion
  coverage: ResearchContributionCoverage
  /** Exact persisted evidence identities backing the assessed contribution. */
  evidenceIds: string[]
  /** Retained verbatim from the packet so limitations survive the handoff. */
  limitations: string[]
  openQuestions: string[]
  reason: string
  /** Required for a non-claimable outcome; null for a ready or no-item result. */
  failureCategory: FailureCategory | null
  assessedBy: string
  assessedAt: string
  createdAt: string
}

const OUTCOMES: readonly ResearchReadinessOutcome[] = [
  'ready_for_entity', 'resolved_without_new_item', 'blocked', 'failed', 'readiness_unknown',
]

const NON_CLAIMABLE: readonly ResearchReadinessOutcome[] = ['blocked', 'failed', 'readiness_unknown']

const FAILURE_CATEGORIES = new Set([
  'provider_unavailable', 'provider_rate_limited', 'provider_timeout', 'provider_authentication',
  'circuit_open', 'retrieval_timeout', 'retrieval_blocked', 'retrieval_unsafe_url',
  'budget_exceeded', 'invalid_structured_output', 'schema_version_mismatch',
  'permanent_source_error', 'entity_resolution_failed', 'storage_transient', 'storage_permanent',
])

export function researchReadinessId(
  workId: string,
  packetId: string,
  readinessPolicyVersion: string,
): string {
  return stableContractId('research_readiness', workId, packetId, readinessPolicyVersion)
}

/**
 * Stable idempotency identity for one owed Entity action.
 *
 * The identity covers the work, packet, policy version, and the action's kind
 * and target, so a replay addresses the same owed write and a genuinely
 * different action can never collide with it.
 */
export function researchEntityActionId(input: {
  workId: string
  packetId: string
  readinessPolicyVersion: string
  kind: Exclude<ResearchEntityActionKind, 'none'>
  targetId: string | null
}): string {
  return stableContractId(
    'research_entity_action',
    input.workId,
    input.packetId,
    input.readinessPolicyVersion,
    input.kind,
    input.targetId ?? 'self',
  )
}

/** The deliberate no-action result: no Entity write is owed. */
export const NO_RESEARCH_ENTITY_ACTION: ResearchEntityAction = { kind: 'none' }

/**
 * Whether this decision owes Entity Manager a write that must reach the
 * validated Entity writer.
 *
 * `ready_for_entity` always owes its normal Entity action. A
 * `resolved_without_new_item` result owes one only when it carries a required
 * attachment or reuse action; otherwise it is a true deliberate no-action.
 */
export function owesResearchEntityAction(action: ResearchEntityAction): boolean {
  return action.kind !== 'none'
}

export function isNonClaimableReadiness(outcome: ResearchReadinessOutcome): boolean {
  return NON_CLAIMABLE.includes(outcome)
}

export interface ResearchReadinessAssessmentInput {
  work: ResearchWorkItem
  signal: Signal
  packet: ResearchPacketV1
  /** Evidence already persisted for this work item. */
  persistedEvidence: readonly RetrievedEvidence[]
  assessedAt: string
  assessedBy?: string
  readinessPolicyVersion?: string
}

/**
 * Deterministic Research-side sufficiency decision.
 *
 * This is a structural and attribution judgement over the immutable packet and
 * its persisted evidence. It is deliberately not a second research judgement by
 * Entity Manager, and it is deliberately not the Jev follow-up decision, which
 * stays a separate later slice.
 */
export function assessResearchReadiness(
  input: ResearchReadinessAssessmentInput,
): ResearchReadinessV1 {
  const work = validateResearchWorkItem(input.work)
  const packet = validateResearchPacket(input.packet)
  const assessedAt = input.assessedAt
  if (!Number.isFinite(Date.parse(assessedAt))) {
    throw new ContractValidationError('researchReadiness.assessedAt', 'must be a timestamp')
  }
  const readinessPolicyVersion = input.readinessPolicyVersion ?? RESEARCH_READINESS_POLICY_VERSION
  const assessedBy = input.assessedBy ?? RESEARCH_READINESS_ASSESSOR_ID

  const linkage = linkageIssue(work, input.signal, packet)
  const coverage = measureCoverage(packet, input.persistedEvidence)
  const base = {
    schemaVersion: RESEARCH_READINESS_SCHEMA_VERSION,
    readinessId: researchReadinessId(work.workId, packet.packetId, readinessPolicyVersion),
    workId: work.workId,
    signalId: work.signalId,
    sourceType: work.sourceType,
    packetId: packet.packetId,
    researchContractVersion: work.researchContractVersion,
    readinessPolicyVersion,
    packetCompletion: packet.completion,
    coverage,
    evidenceIds: coverage.referencedEvidenceIds,
    limitations: [...packet.limitations],
    openQuestions: [...packet.openQuestions],
    assessedBy,
    assessedAt,
    createdAt: assessedAt,
  } as const

  if (linkage !== null) {
    return validateResearchReadiness({
      ...base,
      outcome: 'failed',
      entityAction: NO_RESEARCH_ENTITY_ACTION,
      reason: linkage,
      failureCategory: 'schema_version_mismatch',
    })
  }
  // Measured against the packet's own references, not the coverage set: a
  // reference that never resolved must surface as a persistence fault rather
  // than being silently reported as an empty contribution.
  const referencedIds = new Set<string>()
  for (const refs of [
    ...packet.claims.map((claim) => claim.evidenceRefs),
    ...packet.verifiedFacts.map((fact) => fact.evidenceRefs),
    ...packet.unresolvedClaims.map((claim) => claim.evidenceRefs),
  ]) {
    for (const evidenceId of refs) referencedIds.add(evidenceId)
  }
  const unpersisted = [...referencedIds]
    .filter((evidenceId) => !input.persistedEvidence.some((artifact) => artifact.evidenceId === evidenceId))
    .sort()
  if (unpersisted.length > 0) {
    return validateResearchReadiness({
      ...base,
      outcome: 'failed',
      entityAction: NO_RESEARCH_ENTITY_ACTION,
      reason: `packet references evidence that is not persisted for this work item: ${unpersisted.join(',')}`,
      failureCategory: 'storage_permanent',
    })
  }
  if (packet.completion === 'failed') {
    return validateResearchReadiness({
      ...base,
      outcome: 'failed',
      entityAction: NO_RESEARCH_ENTITY_ACTION,
      reason: 'Research recorded a failed packet; no handoff is attempted.',
      failureCategory: 'invalid_structured_output',
    })
  }
  if (!coverage.useful) {
    return validateResearchReadiness({
      ...base,
      outcome: 'failed',
      entityAction: NO_RESEARCH_ENTITY_ACTION,
      reason: 'packet has no attributable contribution supported by persisted evidence references',
      failureCategory: 'invalid_structured_output',
    })
  }
  // Both a partial and a complete packet qualify here. What qualifies is the
  // attributable, evidence-resolving contribution, not the label.
  return validateResearchReadiness({
    ...base,
    outcome: 'ready_for_entity',
    // A ready result always owes its normal Entity item action.
    entityAction: {
      kind: 'entity_item',
      actionId: researchEntityActionId({
        workId: work.workId, packetId: packet.packetId, readinessPolicyVersion,
        kind: 'entity_item', targetId: null,
      }),
      targetId: null,
    },
    reason: packet.completion === 'partial'
      ? 'partial research retains an attributable, evidence-linked contribution with its limitations'
      : 'complete research retains an attributable, evidence-linked contribution',
    failureCategory: null,
  })
}

/**
 * An explicit blocked result: a required dependency, usable source, or valid
 * output is missing.
 *
 * This is not successful completion and never claims an Entity action. The
 * recorded category drives the existing bounded retry/dead-letter policy; the
 * stored artifacts are retained so an operator can inspect the cause.
 */
export function createBlockedReadiness(input: ResearchReadinessAssessmentInput & {
  reason: string
  failureCategory: FailureCategory
  /** Named dependency that is missing, retained for operator triage. */
  blockedDependency?: string | null
}): ResearchReadinessV1 {
  const work = validateResearchWorkItem(input.work)
  const packet = validateResearchPacket(input.packet)
  if (!input.reason.trim()) {
    throw new ContractValidationError('researchReadiness.reason', 'must explain the blocked decision')
  }
  const linkage = linkageIssue(work, input.signal, packet)
  if (linkage !== null) {
    throw new ContractValidationError('researchReadiness', linkage)
  }
  const dependency = input.blockedDependency?.trim() ?? ''
  return validateResearchReadiness({
    schemaVersion: RESEARCH_READINESS_SCHEMA_VERSION,
    readinessId: researchReadinessId(
      work.workId,
      packet.packetId,
      input.readinessPolicyVersion ?? RESEARCH_READINESS_POLICY_VERSION,
    ),
    workId: work.workId,
    signalId: work.signalId,
    sourceType: work.sourceType,
    packetId: packet.packetId,
    researchContractVersion: work.researchContractVersion,
    readinessPolicyVersion: input.readinessPolicyVersion ?? RESEARCH_READINESS_POLICY_VERSION,
    outcome: 'blocked',
    // A blocked result owes no Entity action: the missing dependency is
    // Research's to resolve, not Entity Manager's to guess at.
    entityAction: NO_RESEARCH_ENTITY_ACTION,
    packetCompletion: packet.completion,
    coverage: measureCoverage(packet, input.persistedEvidence),
    evidenceIds: [],
    limitations: [...packet.limitations],
    openQuestions: [...packet.openQuestions],
    reason: dependency ? `${input.reason} (blocked on: ${dependency})` : input.reason,
    failureCategory: input.failureCategory,
    assessedBy: input.assessedBy ?? RESEARCH_READINESS_ASSESSOR_ID,
    assessedAt: input.assessedAt,
    createdAt: input.assessedAt,
  })
}

/**
 * Explicit deliberate no-item outcome. Only an explicit Research decision may
 * record this; it is never inferred from packet shape.
 *
 * "No new item" is not the same as "no action". Pass `owedAttachment` when a
 * required source/evidence attachment or reuse action must still be preserved
 * and reach the validated Entity writer; the result then stays claimable. Omit
 * it for a true deliberate no-action result, which completes locally.
 */
export function createResolvedWithoutNewItemReadiness(input: ResearchReadinessAssessmentInput & {
  reason: string
  /**
   * A required attachment or reuse action that must still reach the validated
   * Entity writer even though no new note is created.
   */
  owedAttachment?: { targetId: string } | null
}): ResearchReadinessV1 {
  const work = validateResearchWorkItem(input.work)
  const packet = validateResearchPacket(input.packet)
  if (!input.reason.trim()) {
    throw new ContractValidationError('researchReadiness.reason', 'must explain the no-item decision')
  }
  const linkage = linkageIssue(work, input.signal, packet)
  if (linkage !== null) {
    throw new ContractValidationError('researchReadiness', linkage)
  }
  const readinessPolicyVersion = input.readinessPolicyVersion ?? RESEARCH_READINESS_POLICY_VERSION
  const coverage = measureCoverage(packet, input.persistedEvidence)
  const assessedAt = input.assessedAt
  // A required attachment is preserved as an explicit owed action rather than
  // being collapsed into the no-action result or silently discarded.
  const targetId = input.owedAttachment?.targetId.trim() ?? ''
  const entityAction: ResearchEntityAction = targetId
    ? {
      kind: 'evidence_attachment',
      actionId: researchEntityActionId({
        workId: work.workId, packetId: packet.packetId, readinessPolicyVersion,
        kind: 'evidence_attachment', targetId,
      }),
      targetId,
    }
    : NO_RESEARCH_ENTITY_ACTION
  if (input.owedAttachment && !targetId) {
    throw new ContractValidationError(
      'researchReadiness.owedAttachment.targetId',
      'must name the target an owed attachment applies to',
    )
  }
  return validateResearchReadiness({
    schemaVersion: RESEARCH_READINESS_SCHEMA_VERSION,
    readinessId: researchReadinessId(
      work.workId,
      packet.packetId,
      readinessPolicyVersion,
    ),
    workId: work.workId,
    signalId: work.signalId,
    sourceType: work.sourceType,
    packetId: packet.packetId,
    researchContractVersion: work.researchContractVersion,
    readinessPolicyVersion,
    outcome: 'resolved_without_new_item',
    entityAction,
    packetCompletion: packet.completion,
    coverage,
    evidenceIds: coverage.referencedEvidenceIds,
    limitations: [...packet.limitations],
    openQuestions: [...packet.openQuestions],
    reason: input.reason,
    failureCategory: null,
    assessedBy: input.assessedBy ?? RESEARCH_READINESS_ASSESSOR_ID,
    assessedAt,
    createdAt: assessedAt,
  })
}

/**
 * An explicit held result for a saved packet that no assessor has judged.
 *
 * Old incomplete packets without a new assessment stay `readiness_unknown`; they
 * are never auto-admitted and their artifacts are never rewritten.
 */
export function createReadinessUnknownReadiness(input: ResearchReadinessAssessmentInput & {
  reason: string
}): ResearchReadinessV1 {
  const work = validateResearchWorkItem(input.work)
  const packet = validateResearchPacket(input.packet)
  const assessedAt = input.assessedAt
  const readinessPolicyVersion = input.readinessPolicyVersion ?? RESEARCH_READINESS_POLICY_VERSION
  return validateResearchReadiness({
    schemaVersion: RESEARCH_READINESS_SCHEMA_VERSION,
    readinessId: researchReadinessId(work.workId, packet.packetId, readinessPolicyVersion),
    workId: work.workId,
    signalId: work.signalId,
    sourceType: work.sourceType,
    packetId: packet.packetId,
    researchContractVersion: work.researchContractVersion,
    readinessPolicyVersion,
    outcome: 'readiness_unknown',
    entityAction: NO_RESEARCH_ENTITY_ACTION,
    packetCompletion: packet.completion,
    coverage: measureCoverage(packet, input.persistedEvidence),
    evidenceIds: [],
    limitations: [...packet.limitations],
    openQuestions: [...packet.openQuestions],
    reason: input.reason,
    failureCategory: 'schema_version_mismatch',
    assessedBy: input.assessedBy ?? RESEARCH_READINESS_ASSESSOR_ID,
    assessedAt,
    createdAt: assessedAt,
  })
}

/**
 * How a recorded outcome terminates the Research stage.
 *
 * A ready result, and a no-item result that still owes an attachment or reuse
 * action, leave exactly one claimable Entity action. A true deliberate no-action
 * result is successful processing with no Entity mutation.
 *
 * A `blocked` or `failed` result is not successful completion: it routes through
 * the existing bounded retry/dead-letter policy and keeps its recorded category.
 * `readiness_unknown` is always held, never retried and never automatically
 * re-assessed, because an absent capture cannot justify re-deciding old material.
 */
export function researchHandoffWorkStatus(readiness: ResearchReadinessV1): WorkStatus {
  if (researchHandoffEntityClaim(readiness)) return 'entity_pending'
  if (readiness.outcome === 'resolved_without_new_item') return 'complete'
  return 'dead_letter'
}

/**
 * The Entity action a decision makes claimable, or null when it owes none.
 *
 * This is what keeps the two `resolved_without_new_item` variants distinct: a
 * no-new-item result with an owed action stays claimable and reaches the Entity
 * processor, while a deliberate no-action result does not.
 */
export function researchHandoffEntityClaim(
  readiness: ResearchReadinessV1,
): Exclude<ResearchEntityAction, { kind: 'none' }> | null {
  if (isNonClaimableReadiness(readiness.outcome)) return null
  const action = readiness.entityAction
  return action.kind === 'none' ? null : action
}

export interface ResearchHandoffRetryPolicy {
  /** Attempts already spent on this work item. */
  attemptCount: number
  /** Existing bounded attempt ceiling; retries cannot reset it. */
  maxAttempts: number
  /** Whether the freshness deadline has already elapsed. */
  expired: boolean
  /** Deadline for the next bounded retry, when the policy allows one. */
  nextAttemptAt: string | null
}

/**
 * Resolve the work status for a non-claimable outcome under the existing
 * bounded retry policy.
 *
 * `blocked` and `failed` are handled as failures, not completions: a
 * retryable category waits until a bounded retry deadline, and once no bounded
 * retry remains the result is an explicit non-claimable held/dead-letter row.
 * `readiness_unknown` never retries and is never re-assessed automatically.
 */
export function researchHandoffTerminalStatus(
  readiness: ResearchReadinessV1,
  policy: ResearchHandoffRetryPolicy,
): Extract<WorkStatus, 'retry_wait' | 'dead_letter'> {
  const category = readiness.failureCategory
  if (category === null) {
    throw new ContractValidationError(
      'researchReadiness.failureCategory',
      `is required to route a ${readiness.outcome} outcome through retry handling`,
    )
  }
  if (readiness.outcome === 'readiness_unknown') return 'dead_letter'
  if (policy.expired || !isRetryableFailure(category)) return 'dead_letter'
  if (policy.attemptCount >= policy.maxAttempts || policy.nextAttemptAt === null) return 'dead_letter'
  return 'retry_wait'
}

export function validateResearchReadiness(value: unknown): ResearchReadinessV1 {
  const record = object(value, 'researchReadiness')
  literal(record.schemaVersion, RESEARCH_READINESS_SCHEMA_VERSION, 'researchReadiness.schemaVersion')
  for (const key of [
    'readinessId', 'workId', 'signalId', 'packetId', 'researchContractVersion',
    'readinessPolicyVersion', 'reason', 'assessedBy',
  ] as const) {
    nonEmpty(record[key], `researchReadiness.${key}`)
  }
  oneOf(record.sourceType, ['news', 'polymarket', 'market_calendar', 'x'], 'researchReadiness.sourceType')
  const outcome = oneOf(record.outcome, OUTCOMES, 'researchReadiness.outcome')
  const entityAction = validateEntityAction(record.entityAction)
  oneOf(record.packetCompletion, ['complete', 'partial', 'failed'], 'researchReadiness.packetCompletion')
  stringArray(record.limitations, 'researchReadiness.limitations')
  stringArray(record.openQuestions, 'researchReadiness.openQuestions')
  const evidenceIds = record.evidenceIds
  assertedStringArray(evidenceIds, 'researchReadiness.evidenceIds')
  timestamp(record.assessedAt, 'researchReadiness.assessedAt')
  timestamp(record.createdAt, 'researchReadiness.createdAt')
  if (record.readinessId !== researchReadinessId(
    record.workId as string, record.packetId as string, record.readinessPolicyVersion as string,
  )) {
    throw new ContractValidationError(
      'researchReadiness.readinessId',
      'must be stable for its work, packet, and readiness policy version',
    )
  }
  if (record.failureCategory !== null
    && (typeof record.failureCategory !== 'string' || !FAILURE_CATEGORIES.has(record.failureCategory))) {
    throw new ContractValidationError('researchReadiness.failureCategory', 'must be a known failure category or null')
  }
  if (isNonClaimableReadiness(outcome) && record.failureCategory === null) {
    throw new ContractValidationError(
      'researchReadiness.failureCategory',
      'is required for a blocked, failed, or readiness_unknown outcome',
    )
  }
  // A non-claimable outcome never owes an Entity write: the cause is Research's
  // to resolve, and Entity must not be handed a packet to fail on later.
  if (isNonClaimableReadiness(outcome) && entityAction.kind !== 'none') {
    throw new ContractValidationError(
      'researchReadiness.entityAction',
      `must be none for a ${outcome} outcome`,
    )
  }
  // A ready result always owes its normal Entity item action; a no-new-item
  // result may still owe a required attachment or reuse action, but never an
  // item action that would contradict "no new note".
  if (outcome === 'ready_for_entity' && entityAction.kind !== 'entity_item') {
    throw new ContractValidationError(
      'researchReadiness.entityAction',
      'must be an entity_item action for a ready_for_entity outcome',
    )
  }
  if (outcome === 'resolved_without_new_item' && entityAction.kind === 'entity_item') {
    throw new ContractValidationError(
      'researchReadiness.entityAction',
      'must not create an entity_item action for a resolved_without_new_item outcome',
    )
  }
  const coverage = validateCoverage(record.coverage)
  if ((record.outcome === 'ready_for_entity') && !coverage.useful) {
    throw new ContractValidationError(
      'researchReadiness.coverage',
      'must report a useful contribution for a ready_for_entity outcome',
    )
  }
  if (record.outcome === 'ready_for_entity' && evidenceIds.length === 0) {
    throw new ContractValidationError(
      'researchReadiness.evidenceIds',
      'must reference persisted evidence for a ready_for_entity outcome',
    )
  }
  for (const evidenceId of evidenceIds) {
    if (!coverage.referencedEvidenceIds.includes(evidenceId)) {
      throw new ContractValidationError(
        'researchReadiness.evidenceIds',
        `must be covered by coverage.referencedEvidenceIds: ${evidenceId}`,
      )
    }
  }
  return value as ResearchReadinessV1
}

/**
 * Validates a saved readiness record against the stored work, signal, packet,
 * and evidence it claims to describe. Entity Manager uses this to trust the
 * decision's linkage, never its sufficiency.
 */
export function validateResearchReadinessLinkage(input: {
  readiness: ResearchReadinessV1
  work: ResearchWorkItem
  signal: Signal
  packet: ResearchPacketV1
  persistedEvidence: readonly RetrievedEvidence[]
}): string | null {
  const readiness = validateResearchReadiness(input.readiness)
  const work = validateResearchWorkItem(input.work)
  const packet = validateResearchPacket(input.packet)
  if (readiness.workId !== work.workId || readiness.signalId !== work.signalId
    || readiness.sourceType !== work.sourceType) {
    return 'readiness linkage does not match its work item'
  }
  if (readiness.packetId !== packet.packetId || packet.workId !== work.workId
    || packet.signalId !== work.signalId || packet.sourceType !== work.sourceType) {
    return 'readiness linkage does not match its packet'
  }
  if (readiness.researchContractVersion !== packet.researchContractVersion
    || readiness.researchContractVersion !== work.researchContractVersion) {
    return 'readiness research contract version does not match its packet and work'
  }
  if (input.signal.signalId !== readiness.signalId || input.signal.sourceType !== readiness.sourceType) {
    return 'readiness linkage does not match its signal'
  }
  if (readiness.packetCompletion !== packet.completion) {
    return 'readiness completion provenance does not match its packet'
  }
  if (canonicalJson(readiness.limitations) !== canonicalJson(packet.limitations)
    || canonicalJson(readiness.openQuestions) !== canonicalJson(packet.openQuestions)) {
    return 'readiness does not retain the packet limitations and open questions'
  }
  const storedEvidence = new Set(input.persistedEvidence.map((artifact) => artifact.evidenceId))
  for (const evidenceId of readiness.evidenceIds) {
    if (!storedEvidence.has(evidenceId)) {
      return `readiness references evidence that is not persisted for this work item: ${evidenceId}`
    }
  }
  const packetEvidence = new Set(packet.evidence.map((reference) => reference.evidenceId))
  for (const evidenceId of readiness.evidenceIds) {
    if (!packetEvidence.has(evidenceId)) {
      return `readiness references evidence absent from its packet: ${evidenceId}`
    }
  }
  return null
}

function linkageIssue(
  work: ResearchWorkItem,
  signal: Signal,
  packet: ResearchPacketV1,
): string | null {
  if (packet.workId !== work.workId || packet.signalId !== work.signalId
    || packet.sourceType !== work.sourceType) {
    return 'packet linkage does not match its work item'
  }
  if (packet.researchContractVersion !== work.researchContractVersion) {
    return 'packet research contract version does not match its work item'
  }
  if (signal.signalId !== work.signalId || signal.sourceType !== work.sourceType) {
    return 'signal linkage does not match its work item'
  }
  return null
}

function measureCoverage(
  packet: ResearchPacketV1,
  persistedEvidence: readonly RetrievedEvidence[],
): ResearchContributionCoverage {
  const stored = new Set(persistedEvidence.map((artifact) => artifact.evidenceId))
  const packetEvidence = new Set(packet.evidence.map((reference) => reference.evidenceId))
  const referenced = new Set<string>()
  const resolvable = (refs: readonly string[]): string[] => {
    const resolved = refs.filter((evidenceId) => packetEvidence.has(evidenceId) && stored.has(evidenceId))
    for (const evidenceId of resolved) referenced.add(evidenceId)
    return resolved
  }
  const claimEvidence = packet.claims.map((claim) => resolvable(claim.evidenceRefs))
  const factEvidence = packet.verifiedFacts.map((fact) => resolvable(fact.evidenceRefs))
  const unresolvedEvidence = packet.unresolvedClaims.map((claim) => resolvable(claim.evidenceRefs))
  const attributedClaimCount = packet.claims.filter(
    (claim) => typeof claim.attributedTo === 'string' && claim.attributedTo.trim() !== '',
  ).length
  const evidenceLinkedClaimCount = claimEvidence.filter((refs) => refs.length > 0).length
  const evidenceLinkedFactCount = factEvidence.filter((refs) => refs.length > 0).length
  const evidenceLinkedUnresolvedCount = unresolvedEvidence.filter((refs) => refs.length > 0).length
  // A contribution is useful when it says something material and is grounded in
  // evidence that is actually persisted for this work item. Attribution is
  // measured and reported rather than demanded per claim: an evidence
  // reference names the source, which is the attribution Entity preserves. The
  // Ethena case qualifies here with zero verified facts because its attributed
  // claims are evidence-linked.
  const useful = packet.claims.some((claim, index) =>
    claim.claim.trim() !== '' && claimEvidence[index]!.length > 0)
    || evidenceLinkedFactCount > 0
    || evidenceLinkedUnresolvedCount > 0
  return {
    claimCount: packet.claims.length,
    attributedClaimCount,
    evidenceLinkedClaimCount,
    verifiedFactCount: packet.verifiedFacts.length,
    unresolvedClaimCount: packet.unresolvedClaims.length,
    referencedEvidenceIds: [...referenced].sort(),
    limitationsCount: packet.limitations.length,
    openQuestionsCount: packet.openQuestions.length,
    attribution: attributionCoverage(packet.claims.length, attributedClaimCount),
    useful,
  }
}

function attributionCoverage(
  claimCount: number,
  attributedClaimCount: number,
): ResearchAttributionCoverage {
  if (claimCount === 0) return 'none'
  if (attributedClaimCount === 0) return 'unattributed'
  return attributedClaimCount === claimCount ? 'attributed' : 'partially_attributed'
}

/**
 * Validate the explicit owed Entity action.
 *
 * `none` is the deliberate no-action result and carries no identity. A required
 * action must name its kind and a stable action identity, and an attachment or
 * reuse action must name the target it applies to — an owed action with no
 * target cannot be addressed by the Entity writer.
 */
function validateEntityAction(value: unknown): ResearchEntityAction {
  const record = object(value, 'researchReadiness.entityAction')
  const kind = oneOf(record.kind, ['none', 'entity_item', 'evidence_attachment'], 'researchReadiness.entityAction.kind')
  if (kind === 'none') {
    if (record.actionId !== undefined || record.targetId !== undefined) {
      throw new ContractValidationError(
        'researchReadiness.entityAction',
        'a none action must not carry an actionId or targetId',
      )
    }
    return value as ResearchEntityAction
  }
  nonEmpty(record.actionId, 'researchReadiness.entityAction.actionId')
  if (record.targetId !== null) nonEmpty(record.targetId, 'researchReadiness.entityAction.targetId')
  if (kind === 'evidence_attachment' && record.targetId === null) {
    throw new ContractValidationError(
      'researchReadiness.entityAction.targetId',
      'is required for an evidence_attachment action',
    )
  }
  return value as ResearchEntityAction
}

function validateCoverage(value: unknown): ResearchContributionCoverage {
  const record = object(value, 'researchReadiness.coverage')
  for (const key of [
    'claimCount', 'attributedClaimCount', 'evidenceLinkedClaimCount', 'verifiedFactCount',
    'unresolvedClaimCount', 'limitationsCount', 'openQuestionsCount',
  ] as const) {
    nonNegativeInteger(record[key], `researchReadiness.coverage.${key}`)
  }
  uniqueStringArray(record.referencedEvidenceIds, 'researchReadiness.coverage.referencedEvidenceIds')
  oneOf(
    record.attribution,
    ['none', 'unattributed', 'partially_attributed', 'attributed'],
    'researchReadiness.coverage.attribution',
  )
  if (typeof record.useful !== 'boolean') {
    throw new ContractValidationError('researchReadiness.coverage.useful', 'must be boolean')
  }
  return value as ResearchContributionCoverage
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractValidationError(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

function literal(value: unknown, expected: string, path: string): void {
  if (value !== expected) throw new ContractValidationError(path, `must equal ${expected}`)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ContractValidationError(path, `must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContractValidationError(path, 'must be a non-empty string')
  }
}

function stringArray(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ContractValidationError(path, 'must be a string array')
  }
}

function assertedStringArray(value: unknown, path: string): asserts value is string[] {
  uniqueStringArray(value, path)
}

function uniqueStringArray(value: unknown, path: string): void {
  stringArray(value, path)
  const items = value as string[]
  if (new Set(items).size !== items.length) {
    throw new ContractValidationError(path, 'must not contain duplicates')
  }
  if (items.some((item) => item.trim() === '')) {
    throw new ContractValidationError(path, 'must not contain empty entries')
  }
}

function nonNegativeInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ContractValidationError(path, 'must be a non-negative integer')
  }
}

function timestamp(value: unknown, path: string): void {
  nonEmpty(value, path)
  if (!Number.isFinite(Date.parse(value))) throw new ContractValidationError(path, 'must be a timestamp')
}
