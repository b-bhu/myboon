import type { SupabaseClient } from '@supabase/supabase-js'
import { PortBackedEntityKnowledgeReader } from './entity-knowledge-reader'
import type {
  EntityKnowledgeEventQuery,
  EntityKnowledgeEventQueryResult,
  EntityKnowledgeQuery,
  EntityKnowledgeQueryPort,
  EntityKnowledgeRow,
} from './entity-knowledge-query'

const ENTITY_KNOWLEDGE_SELECT = [
  'id',
  'entity_id',
  'source',
  'source_area',
  'source_type',
  'source_ref_id',
  'source_research_id',
  'memory_type',
  'title',
  'summary',
  'body',
  'event_at',
  'observed_at',
  'confidence',
  'evidence',
  'mentions',
  'metrics',
  'context',
  'created_at',
  'updated_at',
].join(', ')

interface RowsResult {
  data: unknown[] | null
  error: { message: string } | null
}

interface QueryBuilder extends PromiseLike<RowsResult> {
  eq(column: string, value: string): QueryBuilder
  neq(column: string, value: string): QueryBuilder
  in(column: string, values: readonly string[]): QueryBuilder
  gte(column: string, value: string): QueryBuilder
  or(filters: string): QueryBuilder
  order(column: string, options: { ascending: boolean }): QueryBuilder
  limit(limit: number): QueryBuilder
  not(column: string, operator: string, value: unknown): QueryBuilder
}

interface CountResult { count: number | null, error: { message: string } | null }

/** Supabase/PostgREST adapter for the source-neutral knowledge query port. */
export class SupabaseEntityKnowledgeQueryPort implements EntityKnowledgeQueryPort {
  constructor(private readonly db: SupabaseClient) {}

  async queryMemories(input: EntityKnowledgeQuery): Promise<EntityKnowledgeRow[]> {
    let query = this.db
      .from('entity_memories')
      .select(ENTITY_KNOWLEDGE_SELECT) as unknown as QueryBuilder

    if (input.entityId) query = query.eq('entity_id', input.entityId)
    if (input.memoryIds) query = query.in('id', input.memoryIds)
    if (input.since) query = query.gte('observed_at', input.since)
    if (input.memoryTypes) query = query.in('memory_type', input.memoryTypes)
    // PriorityClass is product policy, persisted in the neutral memory context
    // until the v1 write contract promotes it to a dedicated column.
    if (input.priorityClasses) query = query.in('context->>priority_class', input.priorityClasses)

    if (input.order === 'id-asc') {
      const { data, error } = await query
        .order('id', { ascending: true })
        .limit(input.limit)
      if (error) throw new Error(`entity knowledge query failed: ${error.message}`)
      return (data ?? []) as EntityKnowledgeRow[]
    }

    const timeColumn = input.order === 'observed-desc' ? 'observed_at' : 'updated_at'
    const ascending = input.order === 'updated-asc'
    if (input.after) {
      const comparison = ascending ? 'gt' : 'lt'
      query = query.or(
        `${timeColumn}.${comparison}.${input.after.at},and(${timeColumn}.eq.${input.after.at},id.${comparison}.${input.after.id})`,
      )
    }

    query = query
      .order(timeColumn, { ascending })
      .order('id', { ascending })
      .limit(input.limit)

    const { data, error } = await query
    if (error) throw new Error(`entity knowledge query failed: ${error.message}`)
    return (data ?? []) as EntityKnowledgeRow[]
  }

  async queryMemoryEvents(input: EntityKnowledgeEventQuery): Promise<EntityKnowledgeEventQueryResult> {
    let rowsQuery = this.db
      .from('entity_memories')
      .select(ENTITY_KNOWLEDGE_SELECT) as unknown as QueryBuilder
    rowsQuery = rowsQuery
      .eq('entity_id', input.entityId)
      .neq('memory_type', 'source_marker')
      .not('event_at', 'is', null)
    if (input.after) {
      rowsQuery = rowsQuery.or(
        `event_at.lt.${input.after.at},and(event_at.eq.${input.after.at},id.lt.${input.after.id})`,
      )
    }
    rowsQuery = rowsQuery
      .order('event_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(input.limit)

    const countQuery = this.db
      .from('entity_memories')
      .select('id', { count: 'exact', head: true })
      .eq('entity_id', input.entityId)
      .neq('memory_type', 'source_marker')
      .not('event_at', 'is', null) as unknown as PromiseLike<CountResult>
    const [{ data, error }, countResult] = await Promise.all([rowsQuery, countQuery])
    if (error) throw new Error(`entity knowledge event query failed: ${error.message}`)
    if (countResult.error) throw new Error(`entity knowledge event count failed: ${countResult.error.message}`)
    if (!Number.isSafeInteger(countResult.count) || (countResult.count ?? -1) < 0) {
      throw new Error('entity knowledge event count was unavailable')
    }
    return { rows: (data ?? []) as EntityKnowledgeRow[], totalCount: countResult.count! }
  }
}

/** Production EntityKnowledgeReader over the existing durable entity tables. */
export class SupabaseEntityKnowledgeReader extends PortBackedEntityKnowledgeReader {
  constructor(db: SupabaseClient) {
    super(new SupabaseEntityKnowledgeQueryPort(db))
  }
}

export const __supabaseEntityKnowledgeReaderTesting = {
  ENTITY_KNOWLEDGE_SELECT,
}
