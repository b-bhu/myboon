import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseEntityKnowledgeReader } from '../entity-manager/supabase-entity-knowledge-reader'
import type { EntityMemoryChangePage } from '../entity-manager/entity-knowledge-reader'
import type { XDeskEntity, XDeskSource } from './types'

export class SupabaseXDeskSource implements XDeskSource {
  private readonly reader: SupabaseEntityKnowledgeReader

  constructor(private readonly db: SupabaseClient) {
    this.reader = new SupabaseEntityKnowledgeReader(db)
  }

  getChanges(afterCursor: string, limit: number): Promise<EntityMemoryChangePage> {
    return this.reader.getEntityMemoryChanges({ afterCursor, limit })
  }

  async getEntities(entityIds: string[]): Promise<Map<string, XDeskEntity>> {
    const ids = [...new Set(entityIds)]
    if (ids.length === 0) return new Map()
    const { data, error } = await this.db
      .from('entities')
      .select('id, slug, name, type, summary')
      .in('id', ids)
    if (error) throw new Error(`X desk entity fetch failed: ${error.message}`)
    const entities = (data ?? []).map((row) => ({
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      type: String(row.type),
      summary: typeof row.summary === 'string' ? row.summary : null,
    }))
    return new Map(entities.map((entity) => [entity.id, entity]))
  }
}
