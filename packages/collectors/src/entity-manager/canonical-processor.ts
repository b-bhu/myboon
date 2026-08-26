import type { ResearchPacketV1, ResearchWorkItem } from '../signal-platform/contracts'
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
import { shortlistForPacket, toCanonEntity, normalizeEntityType } from './canon'
import { adaptCanonicalResearchPacket } from './canonical-packet-adapter'
import { EntityService } from './entity-service'
import { deriveMemoryIdentityKey } from './memory-identity'
import { normalizeSlug } from './normalization'
import type { CanonicalPacketProcessor, CanonicalPacketProcessorInput } from './shared-worker'
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

export const CANONICAL_ENTITY_PLAN_SCHEMA_VERSION = 'myboon.canonical_entity_plan.v1' as const
export const CANONICAL_ENTITY_SHORTLIST_POLICY_VERSION = 'myboon.entity_shortlist.v1' as const

const MAX_PLAN_MEMORIES = 10
const MAX_CANON_LOOKUP_SLUGS = 100
const MAX_CANON_LOOKUP_NAMES = 20
const MAX_CANON_LOOKUP_ALIASES = 100
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

export interface CanonicalEntityPlan {
  schemaVersion: typeof CANONICAL_ENTITY_PLAN_SCHEMA_VERSION
  decision: EntityAdmissionDecision
  memories: CanonicalEntityMemoryDraft[]
}

export interface CanonicalEntityPlanningInput {
  admission: EntityAdmissionInput
  packet: ResearchPacket
  work: ResearchWorkItem
  signal: AbortSignal
}

export interface CanonicalEntityPlanningPort {
  /** Availability/circuit check only; it must not perform a durable write. */
  preflight?(input: Pick<CanonicalEntityPlanningInput, 'work' | 'signal'> & { packet: ResearchPacketV1 }): Promise<void>
  plan(input: CanonicalEntityPlanningInput): Promise<CanonicalEntityPlan | unknown>
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
  shortlistPolicyVersion?: string
}

export class CanonicalEntityProcessorValidationError extends PlatformFailure {
  constructor(message: string) {
    super({ category: 'invalid_structured_output', message, retryable: false })
    this.name = 'CanonicalEntityProcessorValidationError'
  }
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

  async process(input: CanonicalPacketProcessorInput): Promise<void> {
    const canonicalPacket = validateProcessorInput(input)
    ensureNotAborted(input.signal)
    const adaptedPacket = adaptCanonicalResearchPacket(canonicalPacket)
    const packet: ResearchPacket = {
      ...adaptedPacket,
      context: { ...adaptedPacket.context, ...sourceMediaContext(canonicalPacket) },
    }

    const packetLookup = await canonLookupCall(this.canonLookup, packetHintQuery(canonicalPacket), 'packet entity shortlist')
    const catalog = uniqueEntities(packetLookup.entities.filter((entity) => entity.status === 'active'))
    const shortlist = targetedShortlist(catalog, packet).map((entity, rank): CanonicalEntityRef => ({
      entityId: entity.id,
      slug: entity.slug,
      name: entity.name,
      type: entity.type,
      aliases: [...entity.aliases],
      summary: entity.summary,
      rank,
    }))
    const canonAvailability: CanonAvailability = packetLookup.complete
      ? { state: 'loaded', complete: true }
      : { state: 'loaded', complete: false, detail: 'Packet identity lookup was incomplete.' }
    const admission = buildEntityAdmissionInput({
      packet: canonicalPacket,
      canonicalEntityShortlist: shortlist,
      evidenceSpans: evidenceSpans(canonicalPacket),
      shortlistPolicyVersion: this.options.shortlistPolicyVersion ?? CANONICAL_ENTITY_SHORTLIST_POLICY_VERSION,
      canonAvailability,
    })

    const rawPlan = await providerCall('Entity planning', () => this.options.planner.plan({
      admission,
      packet,
      work: input.work,
      signal: input.signal,
    }))
    ensureNotAborted(input.signal)
    const plan = normalizePlan(rawPlan, canonicalPacket)
    const resolved = await resolveAdmissionDecision(admission, plan.decision, this.canonLookup)
    const processingCatalog = uniqueEntities([...catalog, ...resolved.collisionEntities])
    const extraction = extractionFor(resolved.decision, plan.memories, canonicalPacket, input.work, processingCatalog)

    // The scoped adapter serves the exact canon used for admission and injects
    // stable identities at the final store boundary. EntityService therefore
    // retains its resolver behavior without title-based replay identity.
    const scopedStore = new CanonicalIdentityStore(
      this.options.store,
      processingCatalog,
      canonicalPacket,
      plan.memories,
      resolved.decision.action === 'select_existing' ? resolved.decision.entityId : null,
    )
    const service = new EntityService(scopedStore)
    try {
      await service.writeExtraction(packet, { async extract() { return extraction } })
    } catch (error) {
      if (error instanceof PlatformFailure) throw error
      throw new CanonicalEntityProcessorValidationError(
        error instanceof Error ? error.message : 'Canonical EntityService processing failed.',
      )
    }
  }
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

function normalizePlan(value: unknown, packet: ResearchPacketV1): {
  decision: EntityAdmissionDecision
  memories: NormalizedMemoryDraft[]
} {
  if (!isRecord(value) || value.schemaVersion !== CANONICAL_ENTITY_PLAN_SCHEMA_VERSION) {
    throw new CanonicalEntityProcessorValidationError(
      `Entity plan schemaVersion must be ${CANONICAL_ENTITY_PLAN_SCHEMA_VERSION}.`,
    )
  }
  if (!isRecord(value.decision)) {
    throw new CanonicalEntityProcessorValidationError('Entity plan decision is required.')
  }
  if (!Array.isArray(value.memories) || value.memories.length < 1 || value.memories.length > MAX_PLAN_MEMORIES) {
    throw new CanonicalEntityProcessorValidationError(`Entity plan must contain 1-${MAX_PLAN_MEMORIES} memories.`)
  }
  const claimIds = new Set(packet.claims.map((claim) => claim.claimId))
  const evidenceIds = new Set(packet.evidence.map((evidence) => evidence.evidenceId))
  const correspondenceKeys = new Set<string>()
  const identityShapes = new Set<string>()
  const memories = value.memories.map((item, index): NormalizedMemoryDraft => {
    if (!isRecord(item)) throw new CanonicalEntityProcessorValidationError(`memories[${index}] must be an object.`)
    const memoryType = memoryTypeValue(item.memoryType, index)
    const memoryRole = stableRole(item.memoryRole, index)
    const representedClaimIds = references(item.representedClaimIds, claimIds, `memories[${index}].representedClaimIds`)
    const explicitEvidenceIds = references(
      item.representedEvidenceIds,
      evidenceIds,
      `memories[${index}].representedEvidenceIds`,
    )
    const representedClaimSet = new Set(representedClaimIds)
    const representedEvidenceIds = [...new Set([
      ...explicitEvidenceIds,
      ...packet.claims
        .filter((claim) => representedClaimSet.has(claim.claimId))
        .flatMap((claim) => claim.evidenceRefs),
    ])].sort(compareStrings)
    if (representedClaimIds.length === 0 && representedEvidenceIds.length === 0) {
      throw new CanonicalEntityProcessorValidationError(`memories[${index}] must represent a packet claim or evidence item.`)
    }
    const title = boundedText(item.title, `memories[${index}].title`, 240)
    const summary = boundedText(item.summary, `memories[${index}].summary`, 2_000)
    const correspondenceKey = `${memoryType}\u001f${title}`
    if (correspondenceKeys.has(correspondenceKey)) {
      throw new CanonicalEntityProcessorValidationError('Memory type/title pairs must be unique within an Entity plan.')
    }
    correspondenceKeys.add(correspondenceKey)
    const identityShape = JSON.stringify([memoryType, memoryRole, representedClaimIds, representedEvidenceIds])
    if (identityShapes.has(identityShape)) {
      throw new CanonicalEntityProcessorValidationError('Entity plan contains duplicate stable memory identity material.')
    }
    identityShapes.add(identityShape)
    return {
      memoryType,
      memoryRole,
      representedClaimIds,
      representedEvidenceIds,
      title,
      summary,
      body: nullableText(item.body, `memories[${index}].body`, 20_000),
      eventAt: nullableTimestamp(item.eventAt, `memories[${index}].eventAt`),
      observedAt: optionalTimestamp(item.observedAt, `memories[${index}].observedAt`),
      confidence: confidenceValue(item.confidence, index),
      mentions: stringArray(item.mentions ?? [], `memories[${index}].mentions`),
      metrics: plainRecord(item.metrics, `memories[${index}].metrics`),
      context: plainRecord(item.context, `memories[${index}].context`),
    }
  })
  return { decision: value.decision as unknown as EntityAdmissionDecision, memories }
}

async function resolveAdmissionDecision(
  admission: EntityAdmissionInput,
  decision: EntityAdmissionDecision,
  canonLookup: EntityCanonLookup,
): Promise<{ decision: ValidatedEntityAdmissionDecision; collisionEntities: EntityRecord[] }> {
  if (decision.action !== 'create_new') {
    return { decision: validateEntityAdmissionDecision(admission, decision), collisionEntities: [] }
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
    }
  }
  if (entities.length > 0) {
    throw new PlatformFailure({
      category: 'entity_resolution_failed',
      message: 'New Entity proposal collides with an existing canonical name or alias.',
      retryable: false,
    })
  }
  return { decision: normalized, collisionEntities: [] }
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

function packetHintQuery(packet: ResearchPacketV1): EntityCanonLookupQuery {
  const labels = packet.entityHints.flatMap((hint) => [hint.name, ...hint.aliases])
  return {
    slugs: labels.map((label) => normalizeSlug(undefined, label)),
    names: packet.entityHints.map((hint) => hint.name),
    aliases: packet.entityHints.flatMap((hint) => hint.aliases),
  }
}

function targetedShortlist(catalog: readonly EntityRecord[], packet: ResearchPacket): EntityRecord[] {
  const canon = catalog.map(toCanonEntity)
  const ranked = shortlistForPacket(canon, packet)
  const rankedIds = new Set(ranked.map((entity) => entity.id))
  const remainder = canon.filter((entity) => !rankedIds.has(entity.id))
  return [...ranked, ...remainder]
    .slice(0, 20)
    .map((entity) => catalog.find((record) => record.id === entity.id)!)
}

function uniqueEntities(entities: readonly EntityRecord[]): EntityRecord[] {
  return [...new Map(
    [...entities]
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((entity) => [entity.id, entity]),
  ).values()]
}

function extractionFor(
  decision: ValidatedEntityAdmissionDecision,
  memories: NormalizedMemoryDraft[],
  packet: ResearchPacketV1,
  work: ResearchWorkItem,
  catalog: readonly EntityRecord[],
): EntityMemoryExtraction {
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
        metadata: traceContext(packet, work, decision.supportingClaimIds, decision.supportingEvidenceIds),
      }],
    memories: memories.map((memory): EntityMemoryCandidate => ({
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
        ...traceContext(packet, work, memory.representedClaimIds, representedEvidenceIds(packet, memory)),
        canonical_memory_role: memory.memoryRole,
      },
    })),
  }
}

class CanonicalIdentityStore implements EntityMemoryStore {
  private readonly entities: EntityRecord[]

  constructor(
    private readonly delegate: EntityMemoryStore,
    catalog: readonly EntityRecord[],
    private readonly packet: ResearchPacketV1,
    private readonly drafts: readonly NormalizedMemoryDraft[],
    private readonly selectedExistingEntityId: string | null,
  ) {
    this.entities = [...catalog]
  }

  async listEntities(limit = 1_000): Promise<EntityRecord[]> {
    return this.entities.slice(0, limit)
  }

  async findEntities(slugs: string[], aliases: string[]): Promise<EntityRecord[]> {
    const wantedSlugs = new Set(slugs)
    const wantedAliases = new Set(aliases.map((alias) => alias.toLowerCase()))
    return this.entities.filter((entity) => (
      wantedSlugs.has(entity.slug)
      || entity.aliases.some((alias) => wantedAliases.has(alias.toLowerCase()))
    ))
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
    for (const entity of created) this.remember(entity)
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
    return storageCall('find canonical entity memories', () => this.delegate.findMemories(keys.map((key) => ({
      ...key,
      memoryIdentityKey: this.identityFor(key.entityId, key.memoryType, key.title),
    }))))
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
): Record<string, unknown> {
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
    canonical_source_media: isRecord(packet.sourceSignal.media) ? packet.sourceSignal.media : {},
    ...sourceMediaContext(packet),
    priority_class: work.priorityClass,
    research_depth: work.researchDepth,
    freshness_deadline: work.freshnessDeadline,
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

function confidenceValue(value: unknown, index: number): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new CanonicalEntityProcessorValidationError(`memories[${index}].confidence must be between 0 and 1.`)
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
