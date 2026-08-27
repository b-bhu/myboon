import type { EntityKnowledgeMemoryType, PriorityClass } from './entity-knowledge-reader'

/** Internal storage row. This type is intentionally not re-exported publicly. */
export interface EntityKnowledgeRow {
  id: unknown
  entity_id: unknown
  source: unknown
  source_area: unknown
  source_type: unknown
  source_ref_id: unknown
  source_research_id: unknown
  memory_type: unknown
  title: unknown
  summary: unknown
  body: unknown
  event_at: unknown
  observed_at: unknown
  confidence: unknown
  evidence: unknown
  mentions: unknown
  metrics: unknown
  context: unknown
  created_at: unknown
  updated_at: unknown
}

export interface EntityKnowledgeQuery {
  order: 'observed-desc' | 'updated-asc' | 'id-asc'
  entityId?: string
  memoryIds?: string[]
  since?: string
  memoryTypes?: EntityKnowledgeMemoryType[]
  priorityClasses?: PriorityClass[]
  after?: { at: string, id: string }
  /** Includes the one-row lookahead used to calculate hasMore. */
  limit: number
}

export interface EntityKnowledgeQueryPort {
  queryMemories(query: EntityKnowledgeQuery): Promise<EntityKnowledgeRow[]>
  queryMemoryEvents(query: EntityKnowledgeEventQuery): Promise<EntityKnowledgeEventQueryResult>
}

export interface EntityKnowledgeEventQuery {
  entityId: string
  after?: { at: string, id: string }
  /** Includes the one-row lookahead used to calculate hasMore. */
  limit: number
}

export interface EntityKnowledgeEventQueryResult {
  rows: EntityKnowledgeRow[]
  /** Exact total before applying the keyset cursor. */
  totalCount: number
}
