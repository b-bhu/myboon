import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PlatformFailure } from '../signal-platform/failures'
import type {
  EntityInput,
  EntityIdentityLookupInput,
  EntityIdentityLookupResult,
  EntityMemoryConsolidationPatch,
  EntityMemoryInput,
  EntityMemoryRecord,
  EntityMemoryStore,
  EntityMemoryType,
  EntityRecord,
  ManualCommandLogInput,
  ManualCommandLogRecord,
  MemoryLookupKey,
} from './types'

const ENTITY_SELECT = 'id, slug, name, type, aliases, summary, status, show_in_carousel, metadata, created_at, updated_at'
const LEGACY_ENTITY_SELECT = 'id, slug, name, type, aliases, summary, status, metadata, created_at, updated_at'
const MEMORY_SELECT = 'id, memory_identity_key, entity_id, source, source_area, source_type, source_ref_id, source_research_id, memory_type, title, summary, body, event_at, observed_at, confidence, evidence, mentions, metrics, context, created_at, updated_at'
const MANUAL_COMMAND_LOG_SELECT = 'request_id, command_hash, actor, entity_id, applied_at'

interface EntityRowsResult {
  data: unknown[] | null
  error: { message: string; code?: string } | null
}

interface EntityRowResult {
  data: unknown
  error: { message: string; code?: string } | null
}

interface EntityIdentityRow extends Record<string, unknown> {
  total_count?: unknown
}

const CANONICAL_IDENTITY_LOOKUP_LIMIT = 100

function normalizeEntity(row: unknown): EntityRecord {
  const record = row as Record<string, unknown>
  return {
    id: String(record.id),
    slug: String(record.slug),
    name: String(record.name),
    type: String(record.type),
    aliases: Array.isArray(record.aliases) ? record.aliases.filter((item): item is string => typeof item === 'string') : [],
    summary: typeof record.summary === 'string' ? record.summary : null,
    status: typeof record.status === 'string' ? record.status : 'active',
    show_in_carousel: typeof record.show_in_carousel === 'boolean' ? record.show_in_carousel : false,
    metadata: record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : {},
    created_at: typeof record.created_at === 'string' ? record.created_at : undefined,
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : undefined,
  }
}

function normalizeMemory(row: unknown): EntityMemoryRecord {
  const record = row as Record<string, unknown>
  return {
    id: String(record.id),
    memory_identity_key: typeof record.memory_identity_key === 'string' ? record.memory_identity_key : undefined,
    entity_id: typeof record.entity_id === 'string' ? record.entity_id : null,
    source: String(record.source),
    source_area: String(record.source_area),
    source_type: String(record.source_type),
    source_ref_id: String(record.source_ref_id),
    source_research_id: String(record.source_research_id),
    memory_type: record.memory_type as EntityMemoryRecord['memory_type'],
    title: String(record.title),
    summary: String(record.summary),
    body: typeof record.body === 'string' ? record.body : null,
    event_at: typeof record.event_at === 'string' ? record.event_at : null,
    observed_at: String(record.observed_at),
    confidence: typeof record.confidence === 'number' ? record.confidence : null,
    evidence: Array.isArray(record.evidence) ? record.evidence : [],
    mentions: Array.isArray(record.mentions)
      ? record.mentions.filter((item): item is string => typeof item === 'string')
      : [],
    metrics: record.metrics && typeof record.metrics === 'object' && !Array.isArray(record.metrics)
      ? record.metrics as Record<string, unknown>
      : {},
    context: record.context && typeof record.context === 'object' && !Array.isArray(record.context)
      ? record.context as Record<string, unknown>
      : {},
    created_at: typeof record.created_at === 'string' ? record.created_at : undefined,
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : undefined,
  }
}

export class SupabaseEntityMemoryStore implements EntityMemoryStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listEntities(limit = 1000): Promise<EntityRecord[]> {
    let result = await this.db
      .from('entities')
      .select(ENTITY_SELECT)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(limit) as unknown as EntityRowsResult
    if (isMissingCarouselColumn(result.error)) {
      result = await this.db
        .from('entities')
        .select(LEGACY_ENTITY_SELECT)
        .eq('status', 'active')
        .order('created_at', { ascending: true })
        .limit(limit) as unknown as EntityRowsResult
    }
    const { data, error } = result
    if (error) throw new Error(`entity catalog list failed: ${error.message}`)
    return (data ?? []).map(normalizeEntity)
  }

  async findEntities(slugs: string[], aliases: string[]): Promise<EntityRecord[]> {
    const byId = new Map<string, EntityRecord>()
    const uniqueSlugs = [...new Set(slugs)]
    if (uniqueSlugs.length > 0) {
      let result = await this.db
        .from('entities')
        .select(ENTITY_SELECT)
        .in('slug', uniqueSlugs) as unknown as EntityRowsResult
      if (isMissingCarouselColumn(result.error)) {
        result = await this.db.from('entities').select(LEGACY_ENTITY_SELECT).in('slug', uniqueSlugs) as unknown as EntityRowsResult
      }
      const { data, error } = result
      if (error) throw new Error(`entity slug lookup failed: ${error.message}`)
      for (const row of data ?? []) {
        const entity = normalizeEntity(row)
        byId.set(entity.id, entity)
      }
    }

    for (const alias of [...new Set(aliases)]) {
      let result = await this.db
        .from('entities')
        .select(ENTITY_SELECT)
        .contains('aliases', JSON.stringify([alias]))
        .limit(20) as unknown as EntityRowsResult
      if (isMissingCarouselColumn(result.error)) {
        result = await this.db
          .from('entities')
          .select(LEGACY_ENTITY_SELECT)
          .contains('aliases', JSON.stringify([alias]))
          .limit(20) as unknown as EntityRowsResult
      }
      const { data, error } = result
      if (error) throw new Error(`entity alias lookup failed: ${error.message}`)
      for (const row of data ?? []) {
        const entity = normalizeEntity(row)
        byId.set(entity.id, entity)
      }
    }

    return [...byId.values()]
  }

  async findEntitiesByIdentity(input: EntityIdentityLookupInput): Promise<EntityIdentityLookupResult> {
    const identity = normalizedIdentityLookup(input)
    if (identity.slugs.length === 0 && identity.names.length === 0 && identity.aliases.length === 0) {
      return { entities: [], complete: true }
    }
    const { data, error } = await this.db.rpc('entity_manager_lookup_entities_v1', {
      p_slugs: identity.slugs,
      p_names: identity.names,
      p_aliases: identity.aliases,
      p_limit: CANONICAL_IDENTITY_LOOKUP_LIMIT,
    }) as unknown as EntityRowsResult
    if (error) throw new Error(`canonical entity identity lookup failed: ${error.message}`)
    const rows = (data ?? []) as EntityIdentityRow[]
    const total = rows.length === 0 ? 0 : Number(rows[0]?.total_count)
    const complete = Number.isSafeInteger(total) && total <= CANONICAL_IDENTITY_LOOKUP_LIMIT
    return {
      entities: rows.slice(0, CANONICAL_IDENTITY_LOOKUP_LIMIT).map(normalizeEntity),
      complete,
    }
  }

  async createCanonicalEntity(entity: EntityInput, input: EntityIdentityLookupInput): Promise<EntityRecord> {
    const identity = normalizedIdentityLookup(input)
    const { data, error } = await this.db.rpc('entity_manager_create_entity_v1', {
      p_slug: entity.slug,
      p_name: entity.name,
      p_type: entity.type,
      p_aliases: entity.aliases,
      p_summary: entity.summary,
      p_status: entity.status,
      p_show_in_carousel: entity.show_in_carousel ?? false,
      p_metadata: entity.metadata,
      p_identity_slugs: identity.slugs,
      p_identity_names: identity.names,
      p_identity_aliases: identity.aliases,
    }) as unknown as EntityRowsResult
    if (error) {
      if (error.code === '23505' && /canonical entity identity collision/i.test(error.message)) {
        throw new PlatformFailure({
          category: 'entity_resolution_failed',
          message: 'Canonical Entity creation collided with an existing name or alias.',
          retryable: false,
        })
      }
      throw new Error(`canonical entity creation failed: ${error.message}`)
    }
    if ((data ?? []).length !== 1) throw new Error('canonical entity creation returned an invalid row count')
    return normalizeEntity(data![0])
  }

  async createEntities(entities: EntityInput[]): Promise<EntityRecord[]> {
    if (entities.length === 0) return []
    let result = await this.db
      .from('entities')
      .upsert(entities, { onConflict: 'slug', defaultToNull: false })
      .select(ENTITY_SELECT) as unknown as EntityRowsResult
    if (isMissingCarouselColumn(result.error)) {
      if (entities.some((entity) => entity.show_in_carousel === true)) throw carouselMigrationError()
      const legacyEntities = entities.map(({ show_in_carousel: _flag, ...entity }) => entity)
      result = await this.db
        .from('entities')
        .upsert(legacyEntities, { onConflict: 'slug', defaultToNull: false })
        .select(LEGACY_ENTITY_SELECT) as unknown as EntityRowsResult
    }
    const { data, error } = result
    if (error) throw new Error(`entity upsert failed: ${error.message}`)
    return (data ?? []).map(normalizeEntity)
  }

  async updateEntity(entity: EntityRecord): Promise<EntityRecord> {
    const payload = {
      name: entity.name,
      type: entity.type,
      aliases: entity.aliases,
      summary: entity.summary,
      status: entity.status,
      show_in_carousel: entity.show_in_carousel,
      metadata: entity.metadata,
      updated_at: new Date().toISOString(),
    }
    let result = await this.db
      .from('entities')
      .update(payload)
      .eq('id', entity.id)
      .select(ENTITY_SELECT)
      .single() as unknown as EntityRowResult
    if (isMissingCarouselColumn(result.error)) {
      if (entity.show_in_carousel) throw carouselMigrationError()
      const { show_in_carousel: _flag, ...legacyPayload } = payload
      result = await this.db
        .from('entities')
        .update(legacyPayload)
        .eq('id', entity.id)
        .select(LEGACY_ENTITY_SELECT)
        .single() as unknown as EntityRowResult
    }
    const { data, error } = result
    if (error) throw new Error(`entity update failed: ${error.message}`)
    return normalizeEntity(data)
  }

  async findMemories(keys: MemoryLookupKey[]): Promise<EntityMemoryRecord[]> {
    const identities = [...new Set(keys.map((key) => key.memoryIdentityKey
      ? explicitMemoryIdentity(key.memoryIdentityKey)
      : legacyMemoryIdentity({
        source: key.source,
        source_area: key.sourceArea,
        source_research_id: key.sourceResearchId,
        entity_id: key.entityId,
        memory_type: key.memoryType,
        title: key.title,
      })))]
    if (identities.length === 0) return []
    const { data, error } = await this.db
      .from('entity_memories')
      .select(MEMORY_SELECT)
      .in('memory_identity_key', identities)
    if (error) throw new Error(`entity memory lookup failed: ${error.message}`)
    const wanted = new Set(identities)
    return (data ?? []).map(normalizeMemory).filter((memory) => (
      typeof memory.memory_identity_key === 'string' && wanted.has(memory.memory_identity_key)
    ))
  }

  async upsertMemories(memories: EntityMemoryInput[]): Promise<EntityMemoryRecord[]> {
    if (memories.length === 0) return []
    const updatedAt = this.now().toISOString()
    const identified = memories.map((memory) => ({
      ...memory,
      updated_at: updatedAt,
      memory_identity_key: memory.memory_identity_key
        ? explicitMemoryIdentity(memory.memory_identity_key)
        : legacyMemoryIdentity(memory),
    }))
    const { data, error } = await this.db
      .from('entity_memories')
      .upsert(identified, {
        onConflict: 'memory_identity_key',
      })
      .select(MEMORY_SELECT)
    if (error) throw new Error(`entity memory upsert failed: ${error.message}`)
    return (data ?? []).map(normalizeMemory)
  }

  async listRecentMemories(
    entityIds: string[],
    sinceIso: string,
    untilIso: string,
    limit: number,
    source: string,
  ): Promise<EntityMemoryRecord[]> {
    const uniqueEntityIds = [...new Set(entityIds)]
    if (uniqueEntityIds.length === 0 || limit <= 0) return []
    const { data, error } = await this.db
      .from('entity_memories')
      .select(MEMORY_SELECT)
      .in('entity_id', uniqueEntityIds)
      .eq('source', source)
      .gte('observed_at', sinceIso)
      .lte('observed_at', untilIso)
      .order('observed_at', { ascending: false })
      .limit(limit) as unknown as EntityRowsResult
    if (error) throw new Error(`recent entity memory list failed: ${error.message}`)
    return (data ?? []).map(normalizeMemory)
  }

  async findLatestMemorySince(
    entityId: string,
    memoryType: EntityMemoryType,
    sinceIso: string,
  ): Promise<EntityMemoryRecord | null> {
    const { data, error } = await this.db
      .from('entity_memories')
      .select(MEMORY_SELECT)
      .eq('entity_id', entityId)
      .eq('memory_type', memoryType)
      .gte('observed_at', sinceIso)
      .order('observed_at', { ascending: false })
      .limit(1)
      .maybeSingle() as unknown as EntityRowResult
    if (error) throw new Error(`latest entity memory lookup failed: ${error.message}`)
    return data ? normalizeMemory(data) : null
  }

  async updateMemory(id: string, patch: EntityMemoryConsolidationPatch): Promise<EntityMemoryRecord> {
    const { data, error } = await this.db
      .from('entity_memories')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(MEMORY_SELECT)
      .single() as unknown as EntityRowResult
    if (error) throw new Error(`entity memory update failed: ${error.message}`)
    return normalizeMemory(data)
  }

  async findManualCommand(requestId: string): Promise<ManualCommandLogRecord | null> {
    const { data, error } = await this.db
      .from('manual_command_log')
      .select(MANUAL_COMMAND_LOG_SELECT)
      .eq('request_id', requestId)
      .maybeSingle() as unknown as EntityRowResult
    if (error) throw new Error(`manual command log lookup failed: ${error.message}`)
    return data ? normalizeManualCommandLog(data) : null
  }

  async recordManualCommand(input: ManualCommandLogInput): Promise<ManualCommandLogRecord> {
    const { data, error } = await this.db
      .from('manual_command_log')
      .insert({
        request_id: input.requestId,
        command_hash: input.commandHash,
        actor: input.actor,
        entity_id: input.entityId,
      })
      .select(MANUAL_COMMAND_LOG_SELECT)
      .single() as unknown as EntityRowResult
    if (error) throw new Error(`manual command log insert failed: ${error.message}`)
    return normalizeManualCommandLog(data)
  }
}

function normalizedIdentityLookup(input: EntityIdentityLookupInput): EntityIdentityLookupInput {
  return {
    slugs: boundedIdentityLabels(input.slugs, 'slugs'),
    names: boundedIdentityLabels(input.names, 'names'),
    aliases: boundedIdentityLabels(input.aliases, 'aliases'),
  }
}

function boundedIdentityLabels(values: readonly string[], field: string): string[] {
  if (!Array.isArray(values)) throw new TypeError(`canonical entity ${field} must be an array`)
  const normalized = [...new Set(values.map((value) => {
    if (typeof value !== 'string' || value.trim() === '' || value.trim().length > 500) {
      throw new TypeError(`canonical entity ${field} contains an invalid label`)
    }
    return value.trim()
  }))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  if (normalized.length > CANONICAL_IDENTITY_LOOKUP_LIMIT) {
    throw new RangeError(`canonical entity ${field} exceeds ${CANONICAL_IDENTITY_LOOKUP_LIMIT} labels`)
  }
  return normalized
}

function normalizeManualCommandLog(row: unknown): ManualCommandLogRecord {
  const record = row as Record<string, unknown>
  const actor = record.actor && typeof record.actor === 'object' && !Array.isArray(record.actor)
    ? record.actor as Record<string, unknown>
    : {}
  return {
    requestId: String(record.request_id),
    commandHash: String(record.command_hash),
    actor: {
      kind: (actor.kind as ManualCommandLogRecord['actor']['kind']) ?? 'agent',
      name: typeof actor.name === 'string' ? actor.name : '',
    },
    entityId: typeof record.entity_id === 'string' ? record.entity_id : null,
    appliedAt: String(record.applied_at),
  }
}

function isMissingCarouselColumn(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false
  return /show_in_carousel/i.test(error.message ?? '')
    && (error.code === 'PGRST204' || /column|schema cache|does not exist/i.test(error.message ?? ''))
}

function carouselMigrationError(): Error {
  return new Error('Entity carousel selection requires the pending entity_carousel_flag migration.')
}

const EXPLICIT_MEMORY_IDENTITY_PATTERN = /^myboon\.memory_identity\.v1:[0-9a-f]{64}$/
const LEGACY_MEMORY_IDENTITY_SEPARATOR = '\u001f'

function explicitMemoryIdentity(value: string): string {
  if (!EXPLICIT_MEMORY_IDENTITY_PATTERN.test(value)) {
    throw new TypeError('memory_identity_key must be a myboon.memory_identity.v1 SHA-256 key')
  }
  return value
}

function legacyMemoryIdentity(memory: Pick<
  EntityMemoryInput,
  'source' | 'source_area' | 'source_research_id' | 'entity_id' | 'memory_type' | 'title'
>): string {
  const canonical = [
    memory.source,
    memory.source_area,
    memory.source_research_id,
    memory.entity_id ?? '',
    memory.memory_type,
    memory.title,
  ].join(LEGACY_MEMORY_IDENTITY_SEPARATOR)
  return `myboon.memory_identity.v1:legacy:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

export const __testing = {
  ENTITY_SELECT,
  LEGACY_ENTITY_SELECT,
  MEMORY_SELECT,
  normalizeEntity,
  normalizeMemory,
  explicitMemoryIdentity,
  legacyMemoryIdentity,
  normalizedIdentityLookup,
  isMissingCarouselColumn,
}
