import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityMemoryReader, GateEntity, GateMemory } from './types'
import { rankEntityCandidates } from './entity-candidates'

const ENTITY_PROFILE_SELECT = 'id, slug, name, type, aliases, summary, metadata'
const MEMORY_SELECT = 'id, entity_id, memory_type, title, summary, event_at, observed_at, context'

interface SupabaseQueryError {
  message: string
  code?: string
  status?: number
  details?: string
  hint?: string
}

/**
 * Production EntityMemoryReader over the Supabase entity tables.
 *
 * All three lookups are small, indexed reads. This is the payoff of #256
 * moving pipeline state local: consulting entity memory before research is
 * the ONLY remote read in the research path, and it replaces (when the
 * verdict is already_known) an entire hermes+retrieval research pass.
 *
 * Row bounds: entityIdsForSourceRef caps at 200 memory rows (a subject that
 * filed under more than a handful of entities is already pathological - see
 * the resolver-fragmentation notes in the entity-manager module); the
 * distinct set is built client-side.
 */
export class SupabaseEntityMemoryReader implements EntityMemoryReader {
  constructor(private readonly db: SupabaseClient) {}

  async entityIdsForSourceRef(source: string, sourceRefId: string): Promise<string[]> {
    const { data, error } = await this.db
      .from('entity_memories')
      .select('entity_id')
      .eq('source', source)
      .eq('source_ref_id', sourceRefId)
      .limit(200)
    if (error) throw supabaseQueryError('entity_memories lookup failed', error)
    const ids = (data ?? [])
      .map((row) => (row as { entity_id: string | null }).entity_id)
      .filter((id): id is string => Boolean(id))
    return [...new Set(ids)]
  }

  async entitiesByIds(ids: string[]): Promise<GateEntity[]> {
    if (ids.length === 0) return []
    const { data, error } = await this.db
      .from('entities')
      .select(ENTITY_PROFILE_SELECT)
      .in('id', ids)
    if (error) throw supabaseQueryError('entities lookup failed', error)
    return (data ?? []).map(entityProfile)
  }

  async searchEntities(labels: string[], limit: number, options: { exactOnly?: boolean } = {}): Promise<GateEntity[]> {
    const terms = searchTerms(labels)
    if (terms.length === 0) return []
    const exact = terms.flatMap(term => [`name.ilike.${filterValue(term)}`, `slug.ilike.${filterValue(term)}`,
      `aliases.cs.${filterValue(JSON.stringify([term]))}`])
    const names = terms.flatMap(term => [`name.ilike.${filterValue(`%${term}%`)}`])
    const filters = terms.flatMap((term) => {
      const pattern = filterValue(`%${term}%`)
      return [`name.ilike.${pattern}`, `summary.ilike.${pattern}`,
        `metadata->>routing_rule.ilike.${pattern}`, `metadata->>category.ilike.${pattern}`,
        `aliases.cs.${filterValue(JSON.stringify([term]))}`]
    })
    const read = async (conditions: string[]) => {
      const { data, error } = await this.db.from('entities').select(ENTITY_PROFILE_SELECT)
        .eq('status', 'active').or(conditions.join(',')).order('id', { ascending: true }).limit(200)
      if (error) throw supabaseQueryError('article entity lookup failed', error)
      return (data ?? []).map(entityProfile)
    }
    const batches = await Promise.all((options.exactOnly ? [exact] : [exact, names, filters]).map(read))
    return rankEntityCandidates(batches.flat(), terms, queryLimit(limit))
  }

  async recentMemories(entityIds: string[], limit: number): Promise<GateMemory[]> {
    if (entityIds.length === 0) return []
    const { data, error } = await this.db
      .from('entity_memories')
      .select(MEMORY_SELECT)
      .in('entity_id', entityIds)
      .order('event_at', { ascending: false, nullsFirst: false })
      .order('observed_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .limit(queryLimit(limit))
    if (error) throw supabaseQueryError('entity_memories timeline lookup failed', error)
    return (data ?? []).map(memoryProfile)
  }

  async findMemoriesForArticle(input: {
    entityIds: string[], terms: string[], sourceUrl: string | null, limit: number,
  }): Promise<GateMemory[]> {
    if (input.entityIds.length === 0) return []
    const filters = searchTerms(input.terms).flatMap((term) => {
      const pattern = filterValue(`%${term}%`)
      return [`title.ilike.${pattern}`, `summary.ilike.${pattern}`]
    })
    if (input.sourceUrl) {
      const url = filterValue(input.sourceUrl)
      filters.push(`context->>url.eq.${url}`, `context->>source_url.eq.${url}`,
        `context->source_signal->>canonicalUrl.eq.${url}`,
        `context->canonical_packet->sourceSignal->>canonicalUrl.eq.${url}`)
    }
    if (filters.length === 0) return []
    const { data, error } = await this.db.from('entity_memories')
      .select(MEMORY_SELECT)
      .in('entity_id', [...new Set(input.entityIds)].slice(0, 32))
      .or(filters.join(','))
      .order('observed_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .limit(queryLimit(input.limit))
    if (error) throw supabaseQueryError('article historical lookup failed', error)
    return (data ?? []).map(memoryProfile)
  }
}

/** Preserve Supabase's machine-readable failure fields for outage recovery. */
function supabaseQueryError(prefix: string, error: SupabaseQueryError): Error {
  const wrapped = new Error(`${prefix}: ${error.message}`)
  Object.assign(wrapped, {
    code: error.code,
    status: error.status,
    details: error.details,
    hint: error.hint,
    cause: error,
  })
  return wrapped
}

function entityProfile(value: unknown): GateEntity {
  const row = value as { id: string, slug: string, name: string, type?: string,
    summary: string | null, aliases?: unknown, metadata?: unknown }
  return { id: row.id, slug: row.slug, name: row.name, type: row.type,
    summary: row.summary ?? null,
    aliases: Array.isArray(row.aliases) ? row.aliases.filter((alias): alias is string => typeof alias === 'string') : [],
    metadata: object(row.metadata) }
}

function memoryProfile(value: unknown): GateMemory {
  const row = value as { id: string, entity_id: string, memory_type: string, title: string,
    summary: string, event_at: string | null, observed_at: string | null, context?: unknown }
  const context = object(row.context)
  const signal = object(context.source_signal)
  const packetSignal = object(object(context.canonical_packet).sourceSignal)
  const url = [context.url, context.source_url, signal.canonicalUrl, packetSignal.canonicalUrl]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
  return { id: row.id, entityId: row.entity_id, memoryType: row.memory_type,
    title: row.title, summary: row.summary, eventAt: row.event_at ?? row.observed_at ?? '', sourceUrl: url ?? null }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function searchTerms(values: string[]): string[] {
  return [...new Set(values.map((value) => value.replace(/[%_*\\]/g, '').trim())
    .filter((value) => value.length >= 2 && value.length <= 100))].slice(0, 16)
}

function filterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function queryLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('article lookup limit must be a positive integer')
  return Math.min(value, 200)
}
