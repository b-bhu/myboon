import type { ResearchPacketV1, ResearchWorkItem } from '../signal-platform/contracts'
import {
  claimRefsForIdentityLabels,
  deriveEntityHintClaimRefs,
} from '../signal-platform/entity-hint-claims'
import type { InferenceTelemetry } from '../inference-gateway/types'
import { PlatformFailure } from '../signal-platform/failures'
import {
  buildEntityAdmissionInput,
  EntityCanonUnavailableError,
  validateEntityAdmissionDecision,
  type CanonAvailability,
  type CanonicalEntityRef,
  type EntityAdmissionDecision,
  type EntityAdmissionInput,
  type EvidenceSpan,
  type ValidatedEntityAdmissionDecision,
} from './admission'
import { isBannedEntitySlug, shortlistForPacket, toCanonEntity, normalizeEntityType } from './canon'
import { adaptCanonicalResearchPacket } from './canonical-packet-adapter'
import {
  EntityAdmissionKnowledgeValidationError,
  validateEntityAdmissionKnowledge,
  type EntityAdmissionKnowledgeContextV1,
  type EntityAdmissionKnowledgePort,
} from './entity-knowledge-context'
import {
  entityAliasIsStructurallyRelated,
  entityHintAuthorizesPrimarySelection,
  entityHintCanonicalLabels,
  entityHintIdentityLabels,
  groundEntityCandidates,
  type EntityGroundingSupport,
} from './entity-grounding'
import { EntityService } from './entity-service'
import { deriveMemoryIdentityKey } from './memory-identity'
import { normalizeSlug } from './normalization'
import type {
  CanonicalPacketProcessor,
  CanonicalPacketProcessorInput,
  CanonicalPacketProcessorResult,
} from './shared-worker'
import type {
  EntityInput,
  EntityIdentityLookupInput,
  EntityMemoryCandidate,
  EntityMemoryConsolidationPatch,
  EntityMemoryInput,
  EntityMemoryRecord,
  EntityMemoryStore,
  EntityMemoryType,
  EntityRecord,
  EntityMemoryExtraction,
  ManualCommandLogInput,
  ManualCommandLogRecord,
  MemoryLookupKey,
  ResearchPacket,
} from './types'

export const CANONICAL_ENTITY_PLAN_SCHEMA_VERSION = 'myboon.canonical_entity_plan.v2' as const
export const CANONICAL_ENTITY_SHORTLIST_POLICY_VERSION = 'myboon.entity_shortlist.v3' as const

const MAX_CANON_LOOKUP_SLUGS = 100
const MAX_CANON_LOOKUP_NAMES = 20
const MAX_CANON_LOOKUP_ALIASES = 100
const CANONICAL_NEWS_LOOKBACK_HOURS = 48
const CANONICAL_NEWS_LOOKBACK_LIMIT = 30
const CANONICAL_NEWS_UPDATE_MIN_CONFIDENCE = 0.8
const MEMORY_TYPES = new Set<EntityMemoryType>([
  'research_note',
  'market_signal',
  'news_event',
  'social_signal',
  'timeline_event',
  'metric_change',
])

export interface CanonicalEntityMemoryDraft {
  memoryType: Exclude<EntityMemoryType, 'source_marker'>
  /** Code/model contract role used in stable identity; never presentation wording. */
  memoryRole: string
  representedClaimIds: string[]
  representedEvidenceIds: string[]
  title: string
  summary: string
  body?: string | null
  eventAt?: string | null
  observedAt?: string
  confidence?: number | null
  mentions?: string[]
  metrics?: Record<string, unknown>
  context?: Record<string, unknown>
}

export interface CanonicalRecentMemoryContext {
  id: string
  entityId: string
  entitySlug: string
  entityName: string
  memoryType: EntityMemoryType
  title: string
  summary: string
  eventAt: string | null
  observedAt: string
  sourceResearchId: string
  sourceItemId: string | null
  sourceUrl: string | null
  sourceContentHash: string | null
}

export type CanonicalNoRelevantSubjectDecision = {
  action: 'no_relevant_subject'
  reasonCode: 'no_evidence_backed_subject' | 'ambiguous_identity' | 'source_only_subject' | 'no_durable_subject'
  reason: string
}

export type CanonicalMemoryDecision =
  | { action: 'keep'; memory: CanonicalEntityMemoryDraft }
  | {
    action: 'update'
    subtype: 'material_update' | 'duplicate_source'
    existingMemoryId: string
    confidence: number
    reason: string
    memory: CanonicalEntityMemoryDraft
  }
  | {
    action: 'drop'
    reasonCode: 'no_relevant_subject' | 'no_material_change' | 'duplicate_without_new_evidence' | 'low_durable_value'
    reason: string
  }

export interface CanonicalEntityPlan {
  schemaVersion: typeof CANONICAL_ENTITY_PLAN_SCHEMA_VERSION
  decision: EntityAdmissionDecision | CanonicalNoRelevantSubjectDecision
  memory: CanonicalMemoryDecision
}

export interface CanonicalEntityPlanningInput {
  admission: EntityAdmissionInput
  packet: ResearchPacket
  recentMemories: CanonicalRecentMemoryContext[]
  work: ResearchWorkItem
  signal: AbortSignal
}

export interface CanonicalEntityPlanningPort {
  /** Availability/circuit check only; it must not perform a durable write. */
  preflight?(input: Pick<CanonicalEntityPlanningInput, 'work' | 'signal'> & { packet: ResearchPacketV1 }): Promise<void>
  plan(input: CanonicalEntityPlanningInput): Promise<CanonicalEntityPlan | CanonicalEntityPlanningResult | unknown>
}

export interface CanonicalEntityPlanningResult {
  plan: CanonicalEntityPlan | unknown
  telemetry: InferenceTelemetry | null
}

export interface EntityCanonLookupQuery {
  slugs: string[]
  names: string[]
  aliases: string[]
}

export interface EntityCanonLookupResult {
  entities: EntityRecord[]
  /** True only when the lookup covered every supplied exact identity label. */
  complete: boolean
}

export interface EntityCanonLookup {
  lookup(query: EntityCanonLookupQuery): Promise<EntityCanonLookupResult>
}

/** Exact slug/alias lookup over the same store used by EntityService. */
export class EntityMemoryStoreCanonLookup implements EntityCanonLookup {
  constructor(private readonly store: EntityMemoryStore) {}

  async lookup(query: EntityCanonLookupQuery): Promise<EntityCanonLookupResult> {
    if (!this.store.findEntitiesByIdentity) {
      return { entities: [], complete: false }
    }
    return this.store.findEntitiesByIdentity(query)
  }
}

export interface EntityServiceCanonicalPacketProcessorOptions {
  store: EntityMemoryStore
  planner: CanonicalEntityPlanningPort
  canonLookup?: EntityCanonLookup
  /**
   * Optional reviewed knowledge projection for the real admission path. When
   * absent, the processor remains catalog-only. Configured lookup failures
   * fail closed before planner invocation or durable writes.
   */
  admissionKnowledge?: EntityAdmissionKnowledgePort
  shortlistPolicyVersion?: string
}

export class CanonicalEntityProcessorValidationError extends PlatformFailure {
  constructor(message: string) {
    super({ category: 'invalid_structured_output', message, retryable: false })
    this.name = 'CanonicalEntityProcessorValidationError'
  }
}

export class CanonicalEntityTelemetryFailure extends PlatformFailure {
  readonly entityTelemetry: InferenceTelemetry

  constructor(failure: PlatformFailure, telemetry: InferenceTelemetry) {
    super({
      category: failure.category,
      message: failure.message,
      retryable: failure.retryable,
      retryAfterMs: failure.retryAfterMs,
      incrementsAttempt: failure.incrementsAttempt,
    })
    this.name = 'CanonicalEntityTelemetryFailure'
    this.entityTelemetry = telemetry
  }
}

export function withCanonicalEntityTelemetry(error: unknown, telemetry: InferenceTelemetry | null): unknown {
  if (!telemetry) return error
  if (error instanceof CanonicalEntityTelemetryFailure) return error
  if (error instanceof PlatformFailure) return new CanonicalEntityTelemetryFailure(error, telemetry)
  return new CanonicalEntityTelemetryFailure(new PlatformFailure({
    category: 'provider_unavailable',
    message: error instanceof Error ? error.message : 'Canonical Entity processing failed.',
    retryable: true,
  }), telemetry)
}

/**
 * Canonical Feed V3 composition over the same EntityMemoryStore boundary used
 * by EntityService and SupabaseEntityMemoryStore. It does no direct SQL,
 * network, environment, queue, or lease work.
 */
export class EntityServiceCanonicalPacketProcessor implements CanonicalPacketProcessor {
  private readonly canonLookup: EntityCanonLookup

  constructor(private readonly options: EntityServiceCanonicalPacketProcessorOptions) {
    this.canonLookup = options.canonLookup ?? new EntityMemoryStoreCanonLookup(options.store)
  }

  async preflight(input: CanonicalPacketProcessorInput): Promise<void> {
    const packet = validateProcessorInput(input)
    ensureNotAborted(input.signal)
    if (!this.options.planner.preflight) return
    await providerCall('Entity planning preflight', () => this.options.planner.preflight!({
      work: input.work,
      packet,
      signal: input.signal,
    }))
  }

  async process(input: CanonicalPacketProcessorInput): Promise<CanonicalPacketProcessorResult> {
    const canonicalPacket = validateProcessorInput(input)
    ensureNotAborted(input.signal)
    const groundedPacket: ResearchPacketV1 = {
      ...canonicalPacket,
      entityHints: deriveEntityHintClaimRefs(canonicalPacket.entityHints, canonicalPacket.claims),
    }
    const adaptedPacket = adaptCanonicalResearchPacket(groundedPacket)
    const packet: ResearchPacket = {
      ...adaptedPacket,
      context: { ...adaptedPacket.context, ...sourceMediaContext(groundedPacket) },
    }

    const packetQuery = packetHintQuery(groundedPacket)
    const packetLookup = await canonLookupCall(this.canonLookup, packetQuery.query, 'packet entity shortlist')
    const lookupCatalog = uniqueEntities(packetLookup.entities.filter((entity) => entity.status === 'active'))
    const packetLookupComplete = packetLookup.complete && !packetQuery.truncated
    const grounding = groundEntityCandidates(lookupCatalog, groundedPacket.entityHints)
    const claimGroundedEntityIds = new Set(grounding.support
      .filter((support) => support.primarySelectionAuthorized && support.supportingClaimIds.length > 0)
      .map((support) => support.entityId))
    // Alias uniqueness cannot be established from a partial canon page. An
    // exact proposal-specific lookup may still safely resolve or create later.
    const catalog = packetLookupComplete
      ? grounding.candidates.filter((entity) => claimGroundedEntityIds.has(entity.id))
      : []
    const subjectSourceEntitySlugs = explicitlySupportedSourceEntitySlugs(groundedPacket)
    const shortlistEntities = targetedShortlist(catalog, packet, subjectSourceEntitySlugs)
    const knowledgeByEntityId = await admissionKnowledgeByEntityId(
      this.options.admissionKnowledge,
      shortlistEntities,
      groundedPacket,
      input.signal,
    )
    ensureNotAborted(input.signal)
    const shortlist = shortlistEntities.map((entity, rank): CanonicalEntityRef => ({
      entityId: entity.id,
      slug: entity.slug,
      name: entity.name,
      type: entity.type,
      aliases: [...entity.aliases],
      summary: entity.summary,
      rank,
      ...(knowledgeByEntityId.has(entity.id) ? { knowledge: knowledgeByEntityId.get(entity.id)! } : {}),
    }))
    const canonAvailability: CanonAvailability = packetLookupComplete
      ? { state: 'loaded', complete: true }
      : {
        state: 'loaded',
        complete: false,
        detail: packetQuery.truncated
          ? 'Packet identity hints exceeded the bounded lookup window.'
          : 'Packet identity lookup was incomplete.',
      }
    const admission = buildEntityAdmissionInput({
      packet: groundedPacket,
      canonicalEntityShortlist: shortlist,
      evidenceSpans: evidenceSpans(groundedPacket),
      shortlistPolicyVersion: this.options.shortlistPolicyVersion ?? CANONICAL_ENTITY_SHORTLIST_POLICY_VERSION,
      canonAvailability,
    })
    const recentMemoryRows = await loadCanonicalRecentMemories(
      this.options.store,
      groundedPacket,
      shortlistEntities,
    )
    const recentMemories = recentMemoryContext(recentMemoryRows, shortlistEntities)

    const rawPlanningResult = await providerCall('Entity planning', () => this.options.planner.plan({
      admission,
      packet,
      recentMemories,
      work: input.work,
      signal: input.signal,
    }))
    const planningResult = planningResultFrom(rawPlanningResult)
    try {
      ensureNotAborted(input.signal)
      const plan = normalizePlan(planningResult.plan, groundedPacket, recentMemories)
      if (plan.decision.action === 'no_relevant_subject') {
        return { entityTelemetry: planningResult.telemetry, memoryOutcome: 'skipped' }
      }
      if (plan.memory.action === 'drop') {
        if (plan.decision.action === 'create_new') {
          throw new CanonicalEntityProcessorValidationError('A dropped memory cannot create a new canonical Entity.')
        }
        const validated = validateEntityAdmissionDecision(admission, plan.decision)
        validateGroundedDecisionSupport(validated, grounding.support)
        return { entityTelemetry: planningResult.telemetry, memoryOutcome: 'skipped' }
      }
      const resolved = await resolveAdmissionDecision(admission, plan.decision, this.canonLookup)
      const resolvedGrounding = resolved.collisionEntities.length > 0
        ? groundEntityCandidates(
          uniqueEntities([...lookupCatalog, ...resolved.collisionEntities]),
          groundedPacket.entityHints,
        )
        : grounding
      const primarySupport = resolved.decision.action === 'select_existing'
        ? validateGroundedDecisionSupport(resolved.decision, resolvedGrounding.support)
        : resolved.proposalSupport
      if (!primarySupport) {
        throw new CanonicalEntityProcessorValidationError('Resolved Entity is missing authoritative grounding support.')
      }
      validateResolvedMemoryDecision(plan.memory, resolved.decision, recentMemoryRows, groundedPacket)
      validateMemoryGroundingSupport(plan.memory.memory, primarySupport, groundedPacket)
      const processingCatalog = uniqueEntities([...catalog, ...resolved.collisionEntities])
      const extraction = extractionFor(
        resolved.decision,
        plan.memory,
        groundedPacket,
        input.work,
        processingCatalog,
        planningResult.telemetry,
      )

      // The scoped adapter serves the exact canon used for admission and injects
      // stable identities at the final store boundary. EntityService therefore
      // retains its resolver behavior without title-based replay identity.
      const scopedStore = new CanonicalIdentityStore(
        this.options.store,
        processingCatalog,
        groundedPacket,
        [plan.memory.memory],
        resolved.decision.action === 'select_existing' ? resolved.decision.entityId : null,
        recentMemoryRows,
      )
      const service = new EntityService(scopedStore)
      await service.writeExtraction(packet, { async extract() { return extraction } })
      return { entityTelemetry: planningResult.telemetry, memoryOutcome: 'written' }
    } catch (error) {
      const failure = error instanceof PlatformFailure ? error : new CanonicalEntityProcessorValidationError(
        error instanceof Error ? error.message : 'Canonical EntityService processing failed.',
      )
      throw withCanonicalEntityTelemetry(failure, planningResult.telemetry)
    }
  }
}

function planningResultFrom(value: unknown): CanonicalEntityPlanningResult {
  if (isRecord(value) && 'plan' in value && 'telemetry' in value) {
    return { plan: value.plan, telemetry: validatedEntityTelemetry(value.telemetry) }
  }
  return { plan: value, telemetry: null }
}

function validatedEntityTelemetry(value: unknown): InferenceTelemetry | null {
  if (value === null) return null
  if (!isRecord(value)) throw new CanonicalEntityProcessorValidationError('Entity planner telemetry must be an object or null.')
  const strings = ['workload', 'purpose', 'mode', 'promptVersion', 'policyVersion', 'configuredPrimaryProvider', 'configuredPrimaryModel']
  if (strings.some((key) => typeof value[key] !== 'string' || (value[key] as string).length === 0)) {
    throw new CanonicalEntityProcessorValidationError('Entity planner telemetry is missing required route provenance.')
  }
  if (value.workload !== 'entity.extract' || value.mode !== 'generateStructured') {
    throw new CanonicalEntityProcessorValidationError('Entity planner telemetry must describe entity.extract structured inference.')
  }
  for (const key of ['actualProvider', 'actualModel', 'fallbackReason', 'failureCategory']) {
    if (value[key] !== null && typeof value[key] !== 'string') {
      throw new CanonicalEntityProcessorValidationError(`Entity planner telemetry ${key} must be a string or null.`)
    }
  }
  for (const key of ['configuredReasoningEffort', 'actualReasoningEffort']) {
    if (value[key] !== undefined && value[key] !== null && !['low', 'medium', 'high'].includes(value[key] as string)) {
      throw new CanonicalEntityProcessorValidationError(`Entity planner telemetry ${key} has an invalid value.`)
    }
  }
  if ((value.actualProvider === null) !== (value.actualModel === null)) {
    throw new CanonicalEntityProcessorValidationError('Entity planner actual provider and model coverage must match.')
  }
  for (const key of ['fallbackInvoked', 'budgetExceeded']) {
    if (typeof value[key] !== 'boolean') {
      throw new CanonicalEntityProcessorValidationError(`Entity planner telemetry ${key} must be boolean.`)
    }
  }
  if (value.schemaValid !== null && typeof value.schemaValid !== 'boolean') {
    throw new CanonicalEntityProcessorValidationError('Entity planner telemetry schemaValid must be boolean or null.')
  }
  for (const key of ['providerCalls', 'repairCalls', 'inputTokens', 'outputTokens', 'toolCalls', 'durationMs']) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
      throw new CanonicalEntityProcessorValidationError(`Entity planner telemetry ${key} must be a non-negative integer.`)
    }
  }
  if (value.costUsdMicros !== undefined && value.costUsdMicros !== null
    && (!Number.isSafeInteger(value.costUsdMicros) || (value.costUsdMicros as number) < 0)) {
    throw new CanonicalEntityProcessorValidationError('Entity planner telemetry cost must be measured non-negative micros or null.')
  }
  if (!Array.isArray(value.calls)) throw new CanonicalEntityProcessorValidationError('Entity planner telemetry calls must be an array.')
  return value as unknown as InferenceTelemetry
}

interface NormalizedMemoryDraft extends CanonicalEntityMemoryDraft {
  body: string | null
  eventAt: string | null
  observedAt: string | undefined
  confidence: number | null
  mentions: string[]
  metrics: Record<string, unknown>
  context: Record<string, unknown>
}

type NormalizedCanonicalMemoryDecision =
  | { action: 'keep'; memory: NormalizedMemoryDraft }
  | {
    action: 'update'
    subtype: 'material_update' | 'duplicate_source'
    existingMemoryId: string
    confidence: number
    reason: string
    memory: NormalizedMemoryDraft
  }
  | Extract<CanonicalMemoryDecision, { action: 'drop' }>

function normalizePlan(
  value: unknown,
  packet: ResearchPacketV1,
  recentMemories: readonly CanonicalRecentMemoryContext[],
): {
  decision: EntityAdmissionDecision | CanonicalNoRelevantSubjectDecision
  memory: NormalizedCanonicalMemoryDecision
} {
  if (!isRecord(value) || value.schemaVersion !== CANONICAL_ENTITY_PLAN_SCHEMA_VERSION) {
    throw new CanonicalEntityProcessorValidationError(
      `Entity plan schemaVersion must be ${CANONICAL_ENTITY_PLAN_SCHEMA_VERSION}.`,
    )
  }
  if (!isRecord(value.decision)) {
    throw new CanonicalEntityProcessorValidationError('Entity plan decision is required.')
  }
  if (!isRecord(value.memory)) {
    throw new CanonicalEntityProcessorValidationError('Entity plan memory decision is required.')
  }
  const decision = normalizePlanDecision(value.decision)
  const memory = normalizeMemoryDecision(value.memory, packet, recentMemories)
  if (decision.action === 'no_relevant_subject') {
    if (memory.action !== 'drop' || memory.reasonCode !== 'no_relevant_subject') {
      throw new CanonicalEntityProcessorValidationError(
        'no_relevant_subject must pair with a no_relevant_subject drop decision.',
      )
    }
  } else if (memory.action === 'drop' && memory.reasonCode === 'no_relevant_subject') {
    throw new CanonicalEntityProcessorValidationError(
      'A relevant Entity admission decision cannot use the no_relevant_subject drop reason.',
    )
  }
  return { decision, memory }
}

function normalizePlanDecision(value: Record<string, unknown>): EntityAdmissionDecision | CanonicalNoRelevantSubjectDecision {
  if (value.action !== 'no_relevant_subject') return value as unknown as EntityAdmissionDecision
  const reasonCodes = new Set<CanonicalNoRelevantSubjectDecision['reasonCode']>([
    'no_evidence_backed_subject',
    'ambiguous_identity',
    'source_only_subject',
    'no_durable_subject',
  ])
  if (typeof value.reasonCode !== 'string' || !reasonCodes.has(value.reasonCode as CanonicalNoRelevantSubjectDecision['reasonCode'])) {
    throw new CanonicalEntityProcessorValidationError('no_relevant_subject reasonCode is unsupported.')
  }
  return {
    action: 'no_relevant_subject',
    reasonCode: value.reasonCode as CanonicalNoRelevantSubjectDecision['reasonCode'],
    reason: boundedText(value.reason, 'decision.reason', 1_000),
  }
}

function normalizeMemoryDecision(
  value: Record<string, unknown>,
  packet: ResearchPacketV1,
  recentMemories: readonly CanonicalRecentMemoryContext[],
): NormalizedCanonicalMemoryDecision {
  if (value.action === 'drop') {
    const reasonCodes = new Set<Extract<CanonicalMemoryDecision, { action: 'drop' }>['reasonCode']>([
      'no_relevant_subject',
      'no_material_change',
      'duplicate_without_new_evidence',
      'low_durable_value',
    ])
    if (typeof value.reasonCode !== 'string' || !reasonCodes.has(value.reasonCode as never)) {
      throw new CanonicalEntityProcessorValidationError('Memory drop reasonCode is unsupported.')
    }
    return {
      action: 'drop',
      reasonCode: value.reasonCode as Extract<CanonicalMemoryDecision, { action: 'drop' }>['reasonCode'],
      reason: boundedText(value.reason, 'memory.reason', 1_000),
    }
  }
  if (value.action !== 'keep' && value.action !== 'update') {
    throw new CanonicalEntityProcessorValidationError('Memory action must be keep, update, or drop.')
  }
  if (!isRecord(value.memory)) {
    throw new CanonicalEntityProcessorValidationError(`Memory ${value.action} requires one memory object.`)
  }
  const memory = normalizeMemoryDraft(value.memory, packet)
  if (packet.sourceType === 'news' && memory.memoryType !== 'news_event') {
    throw new CanonicalEntityProcessorValidationError('Canonical news packets may retain only one news_event memory.')
  }
  if (value.action === 'keep') return { action: 'keep', memory }

  const existingMemoryId = boundedText(value.existingMemoryId, 'memory.existingMemoryId', 500)
  const target = recentMemories.find((item) => item.id === existingMemoryId)
  if (!target) {
    throw new CanonicalEntityProcessorValidationError('Memory update target must be present in the supplied recent-memory context.')
  }
  const confidence = confidenceValue(value.confidence, 'memory.confidence')
  if (confidence === null || confidence < CANONICAL_NEWS_UPDATE_MIN_CONFIDENCE) {
    throw new CanonicalEntityProcessorValidationError(
      `Memory update confidence must be at least ${CANONICAL_NEWS_UPDATE_MIN_CONFIDENCE}.`,
    )
  }
  if (value.subtype !== 'material_update' && value.subtype !== 'duplicate_source') {
    throw new CanonicalEntityProcessorValidationError('Memory update subtype must be material_update or duplicate_source.')
  }
  return {
    action: 'update',
    subtype: value.subtype,
    existingMemoryId,
    confidence,
    reason: boundedText(value.reason, 'memory.reason', 1_000),
    memory,
  }
}

function normalizeMemoryDraft(item: Record<string, unknown>, packet: ResearchPacketV1): NormalizedMemoryDraft {
  const claimIds = new Set(packet.claims.map((claim) => claim.claimId))
  const evidenceIds = new Set(packet.evidence.map((evidence) => evidence.evidenceId))
  const memoryType = memoryTypeValue(item.memoryType, 0)
  const memoryRole = stableRole(item.memoryRole, 0)
  const representedClaimIds = references(item.representedClaimIds, claimIds, 'memory.memory.representedClaimIds')
  const explicitEvidenceIds = references(
    item.representedEvidenceIds,
    evidenceIds,
    'memory.memory.representedEvidenceIds',
  )
  const representedClaimSet = new Set(representedClaimIds)
  const representedEvidenceIds = [...new Set([
    ...explicitEvidenceIds,
    ...packet.claims
      .filter((claim) => representedClaimSet.has(claim.claimId))
      .flatMap((claim) => claim.evidenceRefs),
  ])].sort(compareStrings)
  if (representedClaimIds.length === 0 && representedEvidenceIds.length === 0) {
    throw new CanonicalEntityProcessorValidationError('Retained memory must represent a packet claim or evidence item.')
  }
  return {
    memoryType,
    memoryRole,
    representedClaimIds,
    representedEvidenceIds,
    title: boundedText(item.title, 'memory.memory.title', 240),
    summary: boundedText(item.summary, 'memory.memory.summary', 2_000),
    body: nullableText(item.body, 'memory.memory.body', 20_000),
    eventAt: nullableTimestamp(item.eventAt, 'memory.memory.eventAt'),
    observedAt: optionalTimestamp(item.observedAt, 'memory.memory.observedAt'),
    confidence: confidenceValue(item.confidence, 'memory.memory.confidence'),
    mentions: stringArray(item.mentions ?? [], 'memory.memory.mentions'),
    metrics: plainRecord(item.metrics, 'memory.memory.metrics'),
    context: plainRecord(item.context, 'memory.memory.context'),
  }
}

async function resolveAdmissionDecision(
  admission: EntityAdmissionInput,
  decision: EntityAdmissionDecision,
  canonLookup: EntityCanonLookup,
): Promise<{
  decision: ValidatedEntityAdmissionDecision
  collisionEntities: EntityRecord[]
  proposalSupport: EntityGroundingSupport | null
}> {
  if (decision.action !== 'create_new') {
    return {
      decision: validateEntityAdmissionDecision(admission, decision),
      collisionEntities: [],
      proposalSupport: null,
    }
  }

  // Validate the proposal shape and packet evidence first. Completeness is
  // established by the proposal-specific lookup immediately below, rather
  // than by the unrelated size of the global catalog.
  const normalized = validateEntityAdmissionDecision({
    ...admission,
    canonAvailability: { state: 'loaded', complete: true },
  }, decision)
  if (normalized.action !== 'create_new') {
    throw new CanonicalEntityProcessorValidationError('Expected a normalized create_new decision.')
  }
  const proposalSupport = validateNewEntityProposalGrounding(normalized, admission.packet)
  const collisions = await canonLookupCall(canonLookup, {
    slugs: [
      normalized.proposal.slug,
      ...[normalized.proposal.name, ...normalized.proposal.aliases]
        .map((label) => normalizeSlug(undefined, label)),
    ],
    names: [normalized.proposal.name],
    aliases: normalized.proposal.aliases,
  }, 'new Entity collision lookup')
  if (!collisions.complete) {
    throw new EntityCanonUnavailableError('Authoritative new Entity collision lookup was incomplete.')
  }
  const entities = uniqueEntities(collisions.entities)
  const exactSlug = entities.find((entity) => (
    entity.slug === normalized.proposal.slug && entity.status === 'active'
  ))
  if (exactSlug) {
    return {
      decision: {
        action: 'select_existing',
        entityId: exactSlug.id,
        supportingClaimIds: normalized.supportingClaimIds,
        supportingEvidenceIds: normalized.supportingEvidenceIds,
      },
      collisionEntities: entities,
      proposalSupport: null,
    }
  }
  if (entities.length > 0) {
    throw new PlatformFailure({
      category: 'entity_resolution_failed',
      message: 'New Entity proposal collides with an existing canonical name or alias.',
      retryable: false,
    })
  }
  return { decision: normalized, collisionEntities: [], proposalSupport }
}

function validateNewEntityProposalGrounding(
  decision: Extract<ValidatedEntityAdmissionDecision, { action: 'create_new' }>,
  packet: ResearchPacketV1,
): EntityGroundingSupport {
  const proposal = decision.proposal
  const candidate: EntityRecord = {
    id: 'proposed-canonical-entity',
    slug: proposal.slug,
    name: proposal.name,
    type: normalizeEntityType(proposal.type),
    aliases: proposal.aliases,
    summary: proposal.summary,
    status: 'active',
    show_in_carousel: false,
    metadata: {},
  }
  const grounding = groundEntityCandidates([candidate], packet.entityHints)
  const support = grounding.support.find((item) => (
    item.entityId === candidate.id && item.primarySelectionAuthorized
  ))
  if (grounding.candidates.length !== 1 || !support) {
    throw new CanonicalEntityProcessorValidationError(
      'New Entity proposal must match an evidence-linked primary-subject hint.',
    )
  }
  if (support.supportingClaimIds.length === 0) {
    throw new CanonicalEntityProcessorValidationError(
      'New Entity canonical name must be linked to a packet claim.',
    )
  }
  if (!support.matches.some((match) => (
    match.primarySelectionAuthorized && match.matchKind === 'canonical_name'
  ))) {
    throw new CanonicalEntityProcessorValidationError(
      'New Entity canonical name must match an evidence-linked primary-subject hint.',
    )
  }
  const supportedClaims = new Set(support.supportingClaimIds)
  const supportedEvidence = new Set(support.supportingEvidenceIds)
  if (
    !decision.supportingClaimIds.some((id) => supportedClaims.has(id))
    && !decision.supportingEvidenceIds.some((id) => supportedEvidence.has(id))
  ) {
    throw new CanonicalEntityProcessorValidationError(
      'New Entity support does not overlap its authoritative packet hint.',
    )
  }
  for (const alias of proposal.aliases) {
    const groundedAlias = support.matches.some((match) => (
      match.primarySelectionAuthorized
      && match.matchKind === 'alias'
      && groundingLabelKey(match.label) === groundingLabelKey(alias)
    ))
    const relatedToCanonicalName = entityAliasIsStructurallyRelated(alias, proposal.name)
      || packet.entityHints.some((hint) => parentheticalAliasSupportsProposal(hint, proposal.name, alias))
    if (
      !groundedAlias
      || !relatedToCanonicalName
      || claimRefsForIdentityLabels([alias], packet.claims).length === 0
    ) {
      throw new CanonicalEntityProcessorValidationError(
        `New Entity alias is not grounded by a subject-linked packet claim: ${alias}`,
      )
    }
  }
  return support
}

function parentheticalAliasSupportsProposal(
  hint: ResearchPacketV1['entityHints'][number],
  proposalName: string,
  alias: string,
): boolean {
  const match = hint.name.normalize('NFKC').replace(/\s+/g, ' ').trim().match(/^(.+?)\s*\(([^()]+)\)$/)
  if (!match) return false
  return groundingLabelKey(match[1]) === groundingLabelKey(proposalName)
    && groundingLabelKey(match[2]) === groundingLabelKey(alias)
    && hint.aliases.some((candidate) => groundingLabelKey(candidate) === groundingLabelKey(alias))
}

function groundingLabelKey(value: string): string {
  const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  return /^\$?[A-Z][A-Z0-9.-]{1,9}$/.test(normalized)
    ? normalized
    : normalized.toLocaleLowerCase('en-US')
}

async function canonLookupCall(
  lookup: EntityCanonLookup,
  query: EntityCanonLookupQuery,
  operation: string,
): Promise<EntityCanonLookupResult> {
  const slugs = [...new Set(query.slugs)].sort(compareStrings)
  const names = [...new Set(query.names)].sort(compareStrings)
  const aliases = [...new Set(query.aliases)].sort(compareStrings)
  if (
    slugs.length > MAX_CANON_LOOKUP_SLUGS
    || names.length > MAX_CANON_LOOKUP_NAMES
    || aliases.length > MAX_CANON_LOOKUP_ALIASES
  ) {
    throw new CanonicalEntityProcessorValidationError(
      `${operation} exceeds the bounded identity-label lookup contract.`,
    )
  }
  const result = await storageCall(operation, () => lookup.lookup({ slugs, names, aliases }))
  if (!isRecord(result) || !Array.isArray(result.entities) || typeof result.complete !== 'boolean') {
    throw new PlatformFailure({
      category: 'storage_permanent',
      message: `${operation} returned an invalid result.`,
      retryable: false,
    })
  }
  return result
}

function packetHintQuery(packet: ResearchPacketV1): { query: EntityCanonLookupQuery; truncated: boolean } {
  const prioritized = packet.entityHints
    .map((hint, index) => ({ hint, index }))
    .sort((left, right) => (
      Number(entityHintAuthorizesPrimarySelection(right.hint.role))
      - Number(entityHintAuthorizesPrimarySelection(left.hint.role))
      || left.index - right.index
    ))
  const allLabels = uniqueStrings(prioritized.flatMap(({ hint }) => entityHintIdentityLabels(hint)))
  const allNames = uniqueStrings(prioritized.flatMap(({ hint }) => entityHintCanonicalLabels(hint)))
  const allAliases = uniqueStrings(prioritized.flatMap(({ hint }) => hint.aliases))
  return {
    query: {
      slugs: allLabels.slice(0, MAX_CANON_LOOKUP_SLUGS).map((label) => normalizeSlug(undefined, label)),
      names: allNames.slice(0, MAX_CANON_LOOKUP_NAMES),
      aliases: allAliases.slice(0, MAX_CANON_LOOKUP_ALIASES),
    },
    truncated: allLabels.length > MAX_CANON_LOOKUP_SLUGS
      || allNames.length > MAX_CANON_LOOKUP_NAMES
      || allAliases.length > MAX_CANON_LOOKUP_ALIASES,
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function targetedShortlist(
  catalog: readonly EntityRecord[],
  packet: ResearchPacket,
  allowedSourceEntitySlugs: ReadonlySet<string>,
): EntityRecord[] {
  const canon = catalog
    .map(toCanonEntity)
    .filter((entity) => !isBannedEntitySlug(entity.slug) || allowedSourceEntitySlugs.has(entity.slug))
  const ranked = shortlistForPacket(canon, packet, 20, {
    allowSourceEntitySlugs: [...allowedSourceEntitySlugs],
  })
  const rankedIds = new Set(ranked.map((entity) => entity.id))
  const remainder = canon.filter((entity) => !rankedIds.has(entity.id))
  return [...ranked, ...remainder]
    .slice(0, 20)
    .map((entity) => catalog.find((record) => record.id === entity.id)!)
}

function explicitlySupportedSourceEntitySlugs(packet: ResearchPacketV1): Set<string> {
  const output = new Set<string>()
  for (const hint of packet.entityHints) {
    const role = hint.role?.trim().toLowerCase().replace(/[\s-]+/g, '_') ?? ''
    if (role !== 'subject' && role !== 'primary_subject' && role !== 'primary') continue
    if (hint.claimRefs.length === 0 && hint.evidenceRefs.length === 0) continue
    for (const label of [hint.name, ...hint.aliases]) {
      const slug = normalizeSlug(undefined, label)
      if (isBannedEntitySlug(slug)) output.add(slug)
    }
  }
  return output
}

async function admissionKnowledgeByEntityId(
  port: EntityAdmissionKnowledgePort | undefined,
  entities: readonly EntityRecord[],
  packet: ResearchPacketV1,
  signal: AbortSignal,
): Promise<Map<string, EntityAdmissionKnowledgeContextV1>> {
  if (!port || entities.length === 0) return new Map()
  ensureNotAborted(signal)
  const raw = await storageCall('Entity admission knowledge lookup', () => (
    port.getEntityAdmissionKnowledge({ entities, packet, signal })
  ))
  try {
    const contexts = validateEntityAdmissionKnowledge(raw, new Set(entities.map((entity) => entity.id)))
    return new Map(contexts.map((context) => [context.entityId, context]))
  } catch (error) {
    if (!(error instanceof EntityAdmissionKnowledgeValidationError)) throw error
    throw new PlatformFailure({
      category: 'storage_permanent',
      message: `Entity admission knowledge is invalid: ${error.message}`,
      retryable: false,
    })
  }
}

function uniqueEntities(entities: readonly EntityRecord[]): EntityRecord[] {
  return [...new Map(
    [...entities]
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((entity) => [entity.id, entity]),
  ).values()]
}

async function loadCanonicalRecentMemories(
  store: EntityMemoryStore,
  packet: ResearchPacketV1,
  entities: readonly EntityRecord[],
): Promise<EntityMemoryRecord[]> {
  if (packet.sourceType !== 'news' || entities.length === 0) return []
  const until = Date.parse(packet.observedAt)
  if (!Number.isFinite(until)) {
    throw new CanonicalEntityProcessorValidationError('Research Packet observedAt is invalid for memory lookback.')
  }
  const sinceIso = new Date(until - CANONICAL_NEWS_LOOKBACK_HOURS * 3_600_000).toISOString()
  return storageCall('canonical Entity recent-memory lookback', () => store.listRecentMemories(
    entities.map((entity) => entity.id),
    sinceIso,
    new Date(until).toISOString(),
    CANONICAL_NEWS_LOOKBACK_LIMIT,
    'news',
  ))
}

function recentMemoryContext(
  memories: readonly EntityMemoryRecord[],
  entities: readonly EntityRecord[],
): CanonicalRecentMemoryContext[] {
  const byId = new Map(entities.map((entity) => [entity.id, entity]))
  return memories.flatMap((memory) => {
    const entity = memory.entity_id ? byId.get(memory.entity_id) : undefined
    if (!entity) return []
    return [{
      id: memory.id,
      entityId: entity.id,
      entitySlug: entity.slug,
      entityName: entity.name,
      memoryType: memory.memory_type,
      title: memory.title.slice(0, 240),
      summary: memory.summary.slice(0, 700),
      eventAt: memory.event_at,
      observedAt: memory.observed_at,
      sourceResearchId: memory.source_research_id,
      sourceItemId: typeof memory.context.canonical_source_item_id === 'string'
        ? memory.context.canonical_source_item_id.slice(0, 500)
        : null,
      sourceUrl: typeof memory.context.canonical_source_url === 'string'
        ? memory.context.canonical_source_url.slice(0, 1_000)
        : typeof memory.context.source_url === 'string'
          ? memory.context.source_url.slice(0, 1_000)
          : null,
      sourceContentHash: typeof memory.context.canonical_source_content_hash === 'string'
        ? memory.context.canonical_source_content_hash.slice(0, 500)
        : null,
    }]
  })
}

function validateResolvedMemoryDecision(
  memory: Exclude<NormalizedCanonicalMemoryDecision, { action: 'drop' }>,
  decision: ValidatedEntityAdmissionDecision,
  recentMemories: readonly EntityMemoryRecord[],
  packet: ResearchPacketV1,
): void {
  if (memory.action !== 'update') return
  if (decision.action !== 'select_existing') {
    throw new CanonicalEntityProcessorValidationError('A memory update cannot create a new canonical Entity.')
  }
  const target = recentMemories.find((item) => item.id === memory.existingMemoryId)
  if (!target || target.entity_id !== decision.entityId) {
    throw new CanonicalEntityProcessorValidationError('Memory update target must belong to the selected canonical Entity.')
  }
  if (target.source_research_id === packet.packetId) {
    throw new CanonicalEntityProcessorValidationError('Memory update target cannot come from the same Research Packet.')
  }
}

function validateGroundedDecisionSupport(
  decision: ValidatedEntityAdmissionDecision,
  grounding: readonly EntityGroundingSupport[],
): EntityGroundingSupport {
  if (decision.action !== 'select_existing') {
    throw new CanonicalEntityProcessorValidationError('Grounded support validation requires an existing Entity decision.')
  }
  const support = grounding.find((item) => (
    item.entityId === decision.entityId && item.primarySelectionAuthorized
  ))
  if (!support) {
    throw new CanonicalEntityProcessorValidationError(
      'Selected Entity is not grounded by an evidence-linked primary-subject hint.',
    )
  }
  const supportedClaims = new Set(support.supportingClaimIds)
  const supportedEvidence = new Set(support.supportingEvidenceIds)
  const overlaps = decision.supportingClaimIds.some((id) => supportedClaims.has(id))
    || decision.supportingEvidenceIds.some((id) => supportedEvidence.has(id))
  if (!overlaps) {
    throw new CanonicalEntityProcessorValidationError(
      'Selected Entity support does not overlap its authoritative packet hint.',
    )
  }
  return support
}

function validateMemoryGroundingSupport(
  memory: NormalizedMemoryDraft,
  support: EntityGroundingSupport,
  packet: ResearchPacketV1,
): void {
  const authoritative = support.matches.filter((match) => match.primarySelectionAuthorized)
  const bestKind = authoritative.some((match) => match.matchKind === 'canonical_name')
    ? 'canonical_name'
    : authoritative.some((match) => match.matchKind === 'canonical_slug')
      ? 'canonical_slug'
      : 'alias'
  const labels = authoritative
    .filter((match) => match.matchKind === bestKind)
    .map((match) => match.label)
  const supportedClaims = new Set(claimRefsForIdentityLabels(labels, packet.claims))
  const overlaps = memory.representedClaimIds.some((id) => supportedClaims.has(id))
  if (!overlaps) {
    throw new CanonicalEntityProcessorValidationError(
      'Retained memory claims must overlap the selected Entity primary-subject hint.',
    )
  }
}

function extractionFor(
  decision: ValidatedEntityAdmissionDecision,
  memoryDecision: Exclude<NormalizedCanonicalMemoryDecision, { action: 'drop' }>,
  packet: ResearchPacketV1,
  work: ResearchWorkItem,
  catalog: readonly EntityRecord[],
  telemetry: InferenceTelemetry | null,
): EntityMemoryExtraction {
  const memory = memoryDecision.memory
  const existing = decision.action === 'select_existing'
    ? catalog.find((entity) => entity.id === decision.entityId)
    : undefined
  if (decision.action === 'select_existing' && !existing) {
    throw new CanonicalEntityProcessorValidationError(`Selected Entity is absent from the loaded canon: ${decision.entityId}`)
  }
  const entity = decision.action === 'create_new' ? decision.proposal : null
  const entitySlug = decision.action === 'select_existing'
    ? existing!.slug
    : decision.proposal.slug
  return {
    primaryEntities: decision.action === 'select_existing'
      ? [{
        name: existing!.name,
        slug: existing!.slug,
        type: existing!.type,
        aliases: existing!.aliases,
        summary: existing!.summary ?? undefined,
        createIfMissing: false,
      }]
      : [{
        name: entity!.name,
        slug: entity!.slug,
        type: normalizeEntityType(entity!.type),
        aliases: entity!.aliases,
        summary: entity!.summary ?? undefined,
        createIfMissing: true,
        createReason: 'canonical_entity_admission',
        metadata: traceContext(packet, work, decision.supportingClaimIds, decision.supportingEvidenceIds, telemetry),
      }],
    memories: [{
      entitySlug,
      memoryType: memory.memoryType,
      title: memory.title,
      summary: memory.summary,
      body: memory.body ?? undefined,
      eventAt: memory.eventAt,
      observedAt: memory.observedAt,
      confidence: memory.confidence ?? undefined,
      evidence: representedEvidence(packet, memory),
      mentions: memory.mentions,
      metrics: {
        ...memory.metrics,
        canonical_packet_id: packet.packetId,
        canonical_claim_count: memory.representedClaimIds.length,
        canonical_evidence_count: representedEvidenceIds(packet, memory).length,
      },
      context: {
        ...memory.context,
        ...traceContext(packet, work, memory.representedClaimIds, representedEvidenceIds(packet, memory), telemetry),
        canonical_memory_role: memory.memoryRole,
      },
      ...(memoryDecision.action === 'update' ? {
        reconciliation: {
          action: memoryDecision.subtype === 'duplicate_source' ? 'duplicate_source' as const : 'update_existing_story' as const,
          existingMemoryId: memoryDecision.existingMemoryId,
          confidence: memoryDecision.confidence,
          reason: memoryDecision.reason,
        },
      } : {
        reconciliation: { action: 'new_story' as const },
      }),
    }],
  }
}

function validateAtomicCreateResult(
  created: EntityRecord,
  requested: EntityInput,
  packet: ResearchPacketV1,
): void {
  const requestedAliases = new Set(requested.aliases.map(groundingLabelKey))
  const createdAliases = new Set(created.aliases.map(groundingLabelKey))
  const identityMatches = created.slug === requested.slug
    && groundingLabelKey(created.name) === groundingLabelKey(requested.name)
    && normalizeEntityType(created.type) === normalizeEntityType(requested.type)
    && createdAliases.size === requestedAliases.size
    && [...requestedAliases].every((alias) => createdAliases.has(alias))
    && created.status === 'active'
  if (!identityMatches) {
    throw new PlatformFailure({
      category: 'storage_transient',
      message: 'Atomic canonical Entity creation returned an identity-mismatched row; retry resolution.',
      retryable: true,
    })
  }

  const grounding = groundEntityCandidates([created], packet.entityHints)
  const support = grounding.support.find((item) => (
    item.entityId === created.id
    && item.primarySelectionAuthorized
    && item.supportingClaimIds.length > 0
    && item.matches.some((match) => (
      match.primarySelectionAuthorized && match.matchKind === 'canonical_name'
    ))
  ))
  if (!support || grounding.candidates.length !== 1) {
    throw new CanonicalEntityProcessorValidationError(
      'Atomic canonical Entity creation result is not grounded by the packet subject.',
    )
  }
}

function uniqueMemoriesById(memories: readonly EntityMemoryRecord[]): EntityMemoryRecord[] {
  return [...new Map(memories.map((memory) => [memory.id, memory])).values()]
}

class CanonicalIdentityStore implements EntityMemoryStore {
  private readonly entities: EntityRecord[]
  private readonly compatibleIdentityByEntityId = new Map<string, string>()

  constructor(
    private readonly delegate: EntityMemoryStore,
    catalog: readonly EntityRecord[],
    private readonly packet: ResearchPacketV1,
    private readonly drafts: readonly NormalizedMemoryDraft[],
    private readonly selectedExistingEntityId: string | null,
    private readonly recentMemoryRows: readonly EntityMemoryRecord[] = [],
  ) {
    this.entities = [...catalog]
  }

  async listEntities(limit = 1_000): Promise<EntityRecord[]> {
    // The canonical planner has already made and validated the ownership
    // decision. Do not let the legacy resolver's catalogue/near-duplicate
    // heuristics override it after validation.
    if (!this.selectedExistingEntityId) return []
    return this.entities
      .filter((entity) => entity.id === this.selectedExistingEntityId)
      .slice(0, limit)
  }

  async findEntities(slugs: string[], aliases: string[]): Promise<EntityRecord[]> {
    const wantedSlugs = new Set(slugs)
    if (this.selectedExistingEntityId) {
      const selected = this.entities.find((entity) => entity.id === this.selectedExistingEntityId)
      if (!selected) {
        throw new CanonicalEntityProcessorValidationError(
          `Selected Entity disappeared: ${this.selectedExistingEntityId}`,
        )
      }
      return wantedSlugs.has(selected.slug) ? [selected] : []
    }

    // A create_new plan has already passed a complete, proposal-specific
    // identity collision lookup. Alias matching here would let the legacy
    // resolver remap that validated decision, so only exact slugs participate.
    void aliases
    return this.entities.filter((entity) => wantedSlugs.has(entity.slug))
  }

  async createEntities(entities: EntityInput[]): Promise<EntityRecord[]> {
    if (entities.length > 1) {
      throw new CanonicalEntityProcessorValidationError('Canonical processing may create only one primary Entity.')
    }
    const created = await storageCall('create canonical entity', async () => {
      if (!this.delegate.createCanonicalEntity) return this.delegate.createEntities(entities)
      const entity = entities[0]
      if (!entity) return []
      return [await this.delegate.createCanonicalEntity(entity, identityQueryForEntity(entity))]
    })
    for (const [index, entity] of created.entries()) {
      const requested = entities[index]
      if (!requested) {
        throw new CanonicalEntityProcessorValidationError('Canonical Entity creation returned an unexpected row.')
      }
      validateAtomicCreateResult(entity, requested, this.packet)
      this.remember(entity)
    }
    return created
  }

  async updateEntity(entity: EntityRecord): Promise<EntityRecord> {
    if (entity.id === this.selectedExistingEntityId) {
      const canonical = this.entities.find((candidate) => candidate.id === entity.id)
      if (!canonical) throw new CanonicalEntityProcessorValidationError(`Selected Entity disappeared: ${entity.id}`)
      return canonical
    }
    const updated = await storageCall('update canonical entity', () => this.delegate.updateEntity(entity))
    this.remember(updated)
    return updated
  }

  async findMemories(keys: MemoryLookupKey[]): Promise<EntityMemoryRecord[]> {
    const compatibilityRows = this.delegate.findCanonicalPacketMemory
      ? await storageCall('find canonical packet memory compatibility row', async () => {
        const rows: EntityMemoryRecord[] = []
        const seen = new Set<string>()
        for (const key of keys) {
          const entityId = key.entityId
          if (!entityId) {
            throw new CanonicalEntityProcessorValidationError('Canonical memory lookup requires an Entity ID.')
          }
          if (seen.has(entityId)) continue
          seen.add(entityId)
          const row = await this.delegate.findCanonicalPacketMemory!(
            key.source,
            key.sourceArea,
            key.sourceResearchId,
            entityId,
            canonicalSourceItemIdentity(this.packet),
          )
          if (!row) continue
          if (typeof row.memory_identity_key === 'string') {
            this.compatibleIdentityByEntityId.set(entityId, row.memory_identity_key)
          }
          rows.push(row)
        }
        return rows
      })
      : []
    const exactRows = await storageCall('find canonical entity memories', () => this.delegate.findMemories(keys.map((key) => ({
      ...key,
      memoryIdentityKey: this.identityFor(key.entityId, key.memoryType, key.title),
    }))))
    return uniqueMemoriesById([...compatibilityRows, ...exactRows])
  }

  async upsertMemories(memories: EntityMemoryInput[]): Promise<EntityMemoryRecord[]> {
    const identified = memories.map((memory) => {
      const identity = this.identityFor(memory.entity_id, memory.memory_type, memory.title)
      return {
        ...memory,
        memory_identity_key: identity,
        context: { ...memory.context, canonical_memory_identity_key: identity },
      }
    })
    return storageCall('upsert canonical entity memories', () => this.delegate.upsertMemories(identified))
  }

  async listRecentMemories(
    entityIds: string[], sinceIso: string, untilIso: string, limit: number, source: string,
  ): Promise<EntityMemoryRecord[]> {
    if (this.packet.sourceType === 'news' && source === 'news') {
      const wanted = new Set(entityIds)
      const since = Date.parse(sinceIso)
      const until = Date.parse(untilIso)
      return this.recentMemoryRows.filter((memory) => (
        memory.entity_id !== null
        && wanted.has(memory.entity_id)
        && memory.source === source
        && Date.parse(memory.observed_at) >= since
        && Date.parse(memory.observed_at) <= until
      )).slice(0, Math.max(0, limit))
    }
    return storageCall('list recent canonical entity memories', () => (
      this.delegate.listRecentMemories(entityIds, sinceIso, untilIso, limit, source)
    ))
  }

  async findLatestMemorySince(
    entityId: string, memoryType: EntityMemoryType, sinceIso: string,
  ): Promise<EntityMemoryRecord | null> {
    return storageCall('find latest canonical entity memory', () => (
      this.delegate.findLatestMemorySince(entityId, memoryType, sinceIso)
    ))
  }

  async updateMemory(id: string, patch: EntityMemoryConsolidationPatch): Promise<EntityMemoryRecord> {
    return storageCall('update canonical entity memory', () => this.delegate.updateMemory(id, patch))
  }

  async findManualCommand(requestId: string): Promise<ManualCommandLogRecord | null> {
    return storageCall('find manual command', () => this.delegate.findManualCommand(requestId))
  }

  async recordManualCommand(input: ManualCommandLogInput): Promise<ManualCommandLogRecord> {
    return storageCall('record manual command', () => this.delegate.recordManualCommand(input))
  }

  private identityFor(entityId: string | null, memoryType: EntityMemoryType, title: string): string {
    if (!entityId) throw new CanonicalEntityProcessorValidationError('Canonical memory must resolve to an Entity ID.')
    const compatibleIdentity = this.compatibleIdentityByEntityId.get(entityId)
    if (compatibleIdentity) return compatibleIdentity
    const draft = this.drafts.find((item) => item.memoryType === memoryType && item.title === title)
    if (!draft) throw new CanonicalEntityProcessorValidationError('Canonical memory does not match a validated plan item.')
    return deriveMemoryIdentityKey({
      packet: this.packet,
      canonicalEntityId: entityId,
      memoryType: draft.memoryType,
      memoryRole: draft.memoryRole,
      representedClaimIds: draft.representedClaimIds,
      representedEvidenceIds: draft.representedEvidenceIds,
    })
  }

  private remember(entity: EntityRecord): void {
    const index = this.entities.findIndex((candidate) => candidate.id === entity.id)
    if (index === -1) this.entities.push(entity)
    else this.entities[index] = entity
  }
}

function canonicalSourceItemIdentity(packet: ResearchPacketV1): string {
  const sourceId = packet.sourceSignal.sourceId
  return typeof sourceId === 'string' && sourceId.trim() !== ''
    ? sourceId.trim()
    : packet.signalId
}

function validateProcessorInput(input: CanonicalPacketProcessorInput): ResearchPacketV1 {
  const packet = input.canonicalPacket
  // The adapter performs schema, completion policy, linkage, and all canonical
  // evidence-reference validation before any catalog or write operation.
  const adapted = adaptCanonicalResearchPacket(packet)
  if (packet.completion !== 'complete') {
    throw new CanonicalEntityProcessorValidationError('Canonical Entity processing requires a complete Research Packet.')
  }
  if (packet.evidence.length === 0) {
    throw new CanonicalEntityProcessorValidationError('Canonical Entity processing requires packet evidence.')
  }
  if (
    packet.workId !== input.work.workId
    || packet.signalId !== input.work.signalId
    || packet.sourceType !== input.work.sourceType
    || packet.researchContractVersion !== input.work.researchContractVersion
    || packet.execution.traceId !== input.work.traceId
    || packet.execution.policyVersion !== input.work.policyVersion
  ) {
    throw new CanonicalEntityProcessorValidationError('Research Packet linkage does not match its work item.')
  }
  if (
    input.packet.sourceResearchId !== adapted.sourceResearchId
    || input.packet.sourceRefId !== adapted.sourceRefId
    || input.packet.source !== adapted.source
  ) {
    throw new CanonicalEntityProcessorValidationError('Adapted Research Packet linkage does not match canonical input.')
  }
  return packet
}

function evidenceSpans(packet: ResearchPacketV1): EvidenceSpan[] {
  return packet.evidence.map((evidence) => ({
    spanId: `${evidence.evidenceId}:reference`,
    evidenceId: evidence.evidenceId,
    claimRefs: packet.claims
      .filter((claim) => claim.evidenceRefs.includes(evidence.evidenceId))
      .map((claim) => claim.claimId),
    text: evidence.note?.trim() || evidence.title.trim(),
  }))
}

function representedEvidenceIds(packet: ResearchPacketV1, memory: NormalizedMemoryDraft): string[] {
  const claimIds = new Set(memory.representedClaimIds)
  return [...new Set([
    ...memory.representedEvidenceIds,
    ...packet.claims.filter((claim) => claimIds.has(claim.claimId)).flatMap((claim) => claim.evidenceRefs),
  ])].sort(compareStrings)
}

function representedEvidence(packet: ResearchPacketV1, memory: NormalizedMemoryDraft): unknown[] {
  const ids = new Set(representedEvidenceIds(packet, memory))
  return packet.evidence.filter((evidence) => ids.has(evidence.evidenceId))
}

function traceContext(
  packet: ResearchPacketV1,
  work: ResearchWorkItem,
  claimIds: readonly string[],
  evidenceIds: readonly string[],
  telemetry: InferenceTelemetry | null,
): Record<string, unknown> {
  const sourceContent = isRecord(packet.sourceSignal.content) ? packet.sourceSignal.content : {}
  return {
    canonical_packet_id: packet.packetId,
    canonical_work_id: packet.workId,
    canonical_signal_id: packet.signalId,
    canonical_trace_id: packet.execution.traceId,
    canonical_policy_version: packet.execution.policyVersion,
    canonical_prompt_version: packet.execution.promptVersion,
    canonical_research_contract_version: packet.researchContractVersion,
    canonical_claim_ids: [...claimIds],
    canonical_evidence_ids: [...evidenceIds],
    canonical_source_provenance: packet.sourceSignal.provenance,
    canonical_source_item_id: packet.sourceSignal.sourceId,
    canonical_source_url: packet.sourceSignal.canonicalUrl,
    canonical_source_content_hash: typeof sourceContent.contentHash === 'string'
      ? sourceContent.contentHash
      : null,
    canonical_source_media: isRecord(packet.sourceSignal.media) ? packet.sourceSignal.media : {},
    ...sourceMediaContext(packet),
    priority_class: work.priorityClass,
    research_depth: work.researchDepth,
    freshness_deadline: work.freshnessDeadline,
    entity_execution_attempt: work.attemptCount + 1,
    entity_prompt_version: telemetry?.promptVersion ?? null,
    entity_policy_version: telemetry?.policyVersion ?? null,
    entity_provider: telemetry?.actualProvider ?? null,
    entity_model: telemetry?.actualModel ?? null,
    entity_fallback_used: telemetry?.fallbackInvoked ?? false,
    entity_fallback_reason: telemetry?.fallbackReason ?? null,
    entity_output_schema_valid: telemetry?.schemaValid ?? null,
    entity_cost_usd_micros: telemetry?.costUsdMicros ?? null,
    entity_configured_reasoning_effort: telemetry?.configuredReasoningEffort ?? null,
    entity_actual_reasoning_effort: telemetry?.actualReasoningEffort ?? null,
  }
}

function identityQueryForEntity(entity: EntityInput): EntityIdentityLookupInput {
  const labels = [entity.name, ...entity.aliases]
  return {
    slugs: [...new Set([entity.slug, ...labels.map((label) => normalizeSlug(undefined, label))])],
    names: [entity.name],
    aliases: [...entity.aliases],
  }
}

function sourceMediaContext(packet: ResearchPacketV1): Record<string, unknown> {
  const media = isRecord(packet.sourceSignal.media) ? packet.sourceSignal.media : {}
  const imageUrl = typeof media.imageUrl === 'string' && /^https?:\/\//i.test(media.imageUrl)
    ? media.imageUrl
    : null
  return {
    image_url: imageUrl,
    image_kind: imageUrl ? 'content' : null,
    image_origin: packet.sourceSignal.provenance.provider,
    image_attribution: typeof media.attribution === 'string' ? media.attribution : null,
    // The existing resolver deliberately derives image provenance from these
    // legacy context keys. Supplying them here keeps the canonical packet's
    // richer provenance intact when it crosses that compatibility boundary.
    provider_id: packet.sourceSignal.provenance.provider,
    upstream_source_name: packet.sourceSignal.provenance.upstreamSource
      ?? (typeof media.attribution === 'string' ? media.attribution : null),
  }
}

function memoryTypeValue(value: unknown, index: number): Exclude<EntityMemoryType, 'source_marker'> {
  if (typeof value !== 'string' || !MEMORY_TYPES.has(value as EntityMemoryType)) {
    throw new CanonicalEntityProcessorValidationError(`memories[${index}].memoryType is unsupported.`)
  }
  return value as Exclude<EntityMemoryType, 'source_marker'>
}

function stableRole(value: unknown, index: number): string {
  const role = boundedText(value, `memories[${index}].memoryRole`, 128)
  if (!/^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/.test(role)) {
    throw new CanonicalEntityProcessorValidationError(`memories[${index}].memoryRole must be a stable identifier.`)
  }
  return role
}

function references(value: unknown, known: ReadonlySet<string>, field: string): string[] {
  const values = stringArray(value, field)
  for (const reference of values) {
    if (!known.has(reference)) throw new CanonicalEntityProcessorValidationError(`${field} references unknown ID: ${reference}`)
  }
  return values.sort(compareStrings)
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new CanonicalEntityProcessorValidationError(`${field} must be an array.`)
  return [...new Set(value.map((item) => boundedText(item, field, 500)))]
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > maximum) {
    throw new CanonicalEntityProcessorValidationError(`${field} must be a non-empty string up to ${maximum} characters.`)
  }
  return value.trim()
}

function nullableText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return boundedText(value, field, maximum)
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return timestamp(value, field)
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return timestamp(value, field)
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new CanonicalEntityProcessorValidationError(`${field} must be an ISO timestamp.`)
  }
  return new Date(value).toISOString()
}

function confidenceValue(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new CanonicalEntityProcessorValidationError(`${field} must be between 0 and 1.`)
  }
  return value
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new CanonicalEntityProcessorValidationError(`${field} must be an object.`)
  return { ...value }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new PlatformFailure({
      category: 'provider_unavailable',
      message: 'Canonical Entity processing was aborted.',
      retryable: true,
      incrementsAttempt: false,
    })
  }
}

async function providerCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof PlatformFailure) throw error
    throw new PlatformFailure({
      category: 'provider_unavailable',
      message: `${operation} failed: ${error instanceof Error ? error.message : 'unknown provider failure'}`,
      retryable: true,
    })
  }
}

async function storageCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof PlatformFailure) throw error
    throw new PlatformFailure({
      category: 'storage_transient',
      message: `${operation} failed: ${error instanceof Error ? error.message : 'unknown storage failure'}`,
      retryable: true,
    })
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
