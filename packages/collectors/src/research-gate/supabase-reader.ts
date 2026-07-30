import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityMemoryReader, GateEntity, GateMemory } from './types'

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
    if (error) throw new Error(`entity_memories lookup failed: ${error.message}`)
    const ids = (data ?? [])
      .map((row) => (row as { entity_id: string | null }).entity_id)
      .filter((id): id is string => Boolean(id))
    return [...new Set(ids)]
  }

  async entitiesByIds(ids: string[]): Promise<GateEntity[]> {
    if (ids.length === 0) return []
    const { data, error } = await this.db
      .from('entities')
      .select('id, slug, name, summary')
      .in('id', ids)
    if (error) throw new Error(`entities lookup failed: ${error.message}`)
    return (data ?? []).map((row) => {
      const record = row as { id: string, slug: string, name: string, summary: string | null }
      return { id: record.id, slug: record.slug, name: record.name, summary: record.summary ?? null }
    })
  }

  async recentMemories(entityIds: string[], limit: number): Promise<GateMemory[]> {
    if (entityIds.length === 0) return []
    const { data, error } = await this.db
      .from('entity_memories')
      .select('entity_id, memory_type, title, summary, event_at, observed_at')
      .in('entity_id', entityIds)
      .order('event_at', { ascending: false })
      .limit(limit)
    if (error) throw new Error(`entity_memories timeline lookup failed: ${error.message}`)
    return (data ?? []).map((row) => {
      const record = row as {
        entity_id: string
        memory_type: string
        title: string
        summary: string
        event_at: string | null
        observed_at: string | null
      }
      return {
        entityId: record.entity_id,
        memoryType: record.memory_type,
        title: record.title,
        summary: record.summary,
        eventAt: record.event_at ?? record.observed_at ?? '',
      }
    })
  }
}
