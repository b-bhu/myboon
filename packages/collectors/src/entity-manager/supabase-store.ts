import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  EntityInput,
  EntityMemoryConsolidationPatch,
  EntityMemoryInput,
  EntityMemoryRecord,
  EntityMemoryStore,
  EntityMemoryType,
  EntityRecord,
  MemoryLookupKey,
} from './types'

const ENTITY_SELECT = 'id, slug, name, type, aliases, summary, status, show_in_carousel, metadata, created_at, updated_at'
const LEGACY_ENTITY_SELECT = 'id, slug, name, type, aliases, summary, status, metadata, created_at, updated_at'
const MEMORY_SELECT = 'id, entity_id, source, source_area, source_type, source_ref_id, source_research_id, memory_type, title, summary, body, event_at, observed_at, confidence, evidence, mentions, metrics, context, created_at, updated_at'

interface EntityRowsResult {
  data: unknown[] | null
  error: { message: string; code?: string } | null
}

interface EntityRowResult {
  data: unknown
  error: { message: string; code?: string } | null
}

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
  constructor(private readonly db: SupabaseClient) {}

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
    const byKey = new Map<string, MemoryLookupKey>()
    for (const key of keys) {
      byKey.set([
        key.source,
        key.sourceArea,
        key.sourceResearchId,
        key.entityId ?? '',
        key.memoryType,
        key.title,
      ].join('|'), key)
    }
    const sourceResearchIds = [...new Set([...byKey.values()].map((key) => key.sourceResearchId))]
    if (sourceResearchIds.length === 0) return []
    const { data, error } = await this.db
      .from('entity_memories')
      .select(MEMORY_SELECT)
      .in('source_research_id', sourceResearchIds)
    if (error) throw new Error(`entity memory lookup failed: ${error.message}`)
    const wanted = new Set(byKey.keys())
    return (data ?? [])
      .map(normalizeMemory)
      .filter((memory) => wanted.has([
        memory.source,
        memory.source_area,
        memory.source_research_id,
        memory.entity_id ?? '',
        memory.memory_type,
        memory.title,
      ].join('|')))
  }

  async upsertMemories(memories: EntityMemoryInput[]): Promise<EntityMemoryRecord[]> {
    if (memories.length === 0) return []
    const { data, error } = await this.db
      .from('entity_memories')
      .upsert(memories, {
        onConflict: 'source,source_area,source_research_id,entity_id,memory_type,title',
      })
      .select(MEMORY_SELECT)
    if (error) throw new Error(`entity memory upsert failed: ${error.message}`)
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
}

function isMissingCarouselColumn(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false
  return /show_in_carousel/i.test(error.message ?? '')
    && (error.code === 'PGRST204' || /column|schema cache|does not exist/i.test(error.message ?? ''))
}

function carouselMigrationError(): Error {
  return new Error('Entity carousel selection requires the pending entity_carousel_flag migration.')
}

export const __testing = {
  ENTITY_SELECT,
  LEGACY_ENTITY_SELECT,
  MEMORY_SELECT,
  normalizeEntity,
  isMissingCarouselColumn,
}
