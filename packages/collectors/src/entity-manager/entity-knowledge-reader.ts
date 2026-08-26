import type { EntityKnowledgeQuery, EntityKnowledgeQueryPort, EntityKnowledgeRow } from './entity-knowledge-query'

export const ENTITY_KNOWLEDGE_SCHEMA_VERSION = 'myboon.entity_knowledge.v1' as const
export const ENTITY_KNOWLEDGE_MAX_PAGE_SIZE = 100

export type PriorityClass = 'P0' | 'P1' | 'P2' | 'P3'

export type EntityKnowledgeMemoryType =
  | 'research_note'
  | 'market_signal'
  | 'news_event'
  | 'social_signal'
  | 'timeline_event'
  | 'metric_change'

export interface EntityKnowledgeMediaV1 {
  imageUrl: string | null
  imageKind: string | null
  attribution: string | null
}

export interface EntityKnowledgeProvenanceV1 {
  provider: string
  sourceArea: string
  sourceType: string
  sourceRefId: string
  researchPacketId: string
}

/**
 * Source-neutral product representation of an entity memory. Supabase column
 * names and source-local research row shapes deliberately stop at the reader.
 */
export interface EntityKnowledgeMemoryV1 {
  schemaVersion: typeof ENTITY_KNOWLEDGE_SCHEMA_VERSION
  id: string
  entityId: string
  memoryType: EntityKnowledgeMemoryType
  title: string
  summary: string
  body: string | null
  eventAt: string | null
  observedAt: string
  confidence: number | null
  evidence: unknown[]
  mentions: string[]
  metrics: Record<string, unknown>
  context: Record<string, unknown>
  media: EntityKnowledgeMediaV1
  provenance: EntityKnowledgeProvenanceV1
  priorityClass: PriorityClass | null
  createdAt: string | null
  updatedAt: string
}

export interface EntityMemoryPage {
  schemaVersion: typeof ENTITY_KNOWLEDGE_SCHEMA_VERSION
  items: EntityKnowledgeMemoryV1[]
  nextCursor: string | null
  hasMore: boolean
}

export interface EntityMemoryChangeV1 {
  changeType: 'upsert'
  changedAt: string
  cursor: string
  memory: EntityKnowledgeMemoryV1
}

export interface EntityMemoryChangePage {
  schemaVersion: typeof ENTITY_KNOWLEDGE_SCHEMA_VERSION
  changes: EntityMemoryChangeV1[]
  /** Advances to the final returned change, or remains unchanged when empty. */
  nextCursor: string
  hasMore: boolean
}

export interface GetEntityMemoriesInput {
  entityId: string
  since?: string
  limit: number
  memoryTypes?: EntityKnowledgeMemoryType[]
  cursor?: string
}

export interface GetRecentEntityMemoriesInput {
  priorityClasses?: PriorityClass[]
  since?: string
  limit: number
  cursor?: string
}

export interface GetEntityMemoryChangesInput {
  afterCursor: string
  limit: number
}

export interface EntityKnowledgeReader {
  getEntityMemories(input: GetEntityMemoriesInput): Promise<EntityMemoryPage>
  getRecentEntityMemories(input: GetRecentEntityMemoriesInput): Promise<EntityMemoryPage>
  getEntityMemoryChanges(input: GetEntityMemoryChangesInput): Promise<EntityMemoryChangePage>
}

export class InvalidEntityKnowledgeCursorError extends Error {
  constructor(message = 'Invalid entity knowledge cursor.') {
    super(message)
    this.name = 'InvalidEntityKnowledgeCursorError'
  }
}

type CursorKind = 'entity-memories' | 'recent-memories' | 'memory-changes'

interface CursorPayloadV1 {
  v: 1
  kind: CursorKind
  query: string
  at: string
  id: string
}

const MEMORY_TYPES = new Set<EntityKnowledgeMemoryType>([
  'research_note',
  'market_signal',
  'news_event',
  'social_signal',
  'timeline_event',
  'metric_change',
])
const PRIORITY_CLASSES = new Set<PriorityClass>(['P0', 'P1', 'P2', 'P3'])
const CURSOR_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/
const CHANGE_QUERY_KEY = 'memory-changes:v1'
const INITIAL_CHANGE_TIME = '1970-01-01T00:00:00.000Z'
const INITIAL_CHANGE_ID = '00000000-0000-0000-0000-000000000000'

/** Initial polling position for consumers that do not yet have a durable cursor. */
export const ENTITY_MEMORY_CHANGES_START_CURSOR = encodeCursor({
  v: 1,
  kind: 'memory-changes',
  query: CHANGE_QUERY_KEY,
  at: INITIAL_CHANGE_TIME,
  id: INITIAL_CHANGE_ID,
})

/**
 * Port-backed implementation kept separate from Supabase so cursor/filter
 * semantics can be contract-tested without mocking the fluent client.
 */
export class PortBackedEntityKnowledgeReader implements EntityKnowledgeReader {
  constructor(private readonly port: EntityKnowledgeQueryPort) {}

  async getEntityMemories(input: GetEntityMemoriesInput): Promise<EntityMemoryPage> {
    const entityId = requiredString(input.entityId, 'entityId')
    const since = optionalTimestamp(input.since, 'since')
    const memoryTypes = normalizeMemoryTypes(input.memoryTypes)
    const limit = validLimit(input.limit)
    const queryKey = JSON.stringify({ entityId, since: since ?? null, memoryTypes: memoryTypes ?? null })
    const after = input.cursor
      ? cursorPosition(decodeCursor(input.cursor, 'entity-memories', queryKey))
      : undefined

    return this.memoryPage({
      order: 'observed-desc',
      entityId,
      since,
      memoryTypes,
      after,
      limit: limit + 1,
    }, limit, 'entity-memories', queryKey)
  }

  async getRecentEntityMemories(input: GetRecentEntityMemoriesInput): Promise<EntityMemoryPage> {
    const since = optionalTimestamp(input.since, 'since')
    const priorityClasses = normalizePriorityClasses(input.priorityClasses)
    const limit = validLimit(input.limit)
    const queryKey = JSON.stringify({ since: since ?? null, priorityClasses: priorityClasses ?? null })
    const after = input.cursor
      ? cursorPosition(decodeCursor(input.cursor, 'recent-memories', queryKey))
      : undefined

    return this.memoryPage({
      order: 'observed-desc',
      since,
      priorityClasses,
      after,
      limit: limit + 1,
    }, limit, 'recent-memories', queryKey)
  }

  async getEntityMemoryChanges(input: GetEntityMemoryChangesInput): Promise<EntityMemoryChangePage> {
    const limit = validLimit(input.limit)
    const decoded = decodeCursor(input.afterCursor, 'memory-changes', CHANGE_QUERY_KEY)
    const rows = sortRows(await this.port.queryMemories({
      order: 'updated-asc',
      after: cursorPosition(decoded),
      limit: limit + 1,
    }), 'updated-asc')
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    const changes = pageRows.map((row) => {
      const memory = normalizeRow(row)
      const cursor = encodeCursor({
        v: 1,
        kind: 'memory-changes',
        query: CHANGE_QUERY_KEY,
        at: memory.updatedAt,
        id: memory.id,
      })
      return { changeType: 'upsert' as const, changedAt: memory.updatedAt, cursor, memory }
    })

    return {
      schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
      changes,
      nextCursor: changes.at(-1)?.cursor ?? input.afterCursor,
      hasMore,
    }
  }

  private async memoryPage(
    query: EntityKnowledgeQuery,
    limit: number,
    kind: Exclude<CursorKind, 'memory-changes'>,
    queryKey: string,
  ): Promise<EntityMemoryPage> {
    const rows = sortRows(await this.port.queryMemories(query), 'observed-desc')
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(normalizeRow)
    const last = items.at(-1)
    return {
      schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
      items,
      nextCursor: hasMore && last
        ? encodeCursor({ v: 1, kind, query: queryKey, at: last.observedAt, id: last.id })
        : null,
      hasMore,
    }
  }
}

function validLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > ENTITY_KNOWLEDGE_MAX_PAGE_SIZE) {
    throw new RangeError(`limit must be an integer between 1 and ${ENTITY_KNOWLEDGE_MAX_PAGE_SIZE}`)
  }
  return limit
}

function requiredString(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`)
  return value.trim()
}

function optionalTimestamp(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  return timestamp(value, field)
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid timestamp`)
  }
  return new Date(value).toISOString()
}

function normalizeMemoryTypes(values: EntityKnowledgeMemoryType[] | undefined): EntityKnowledgeMemoryType[] | undefined {
  if (!values || values.length === 0) return undefined
  for (const value of values) {
    if (!MEMORY_TYPES.has(value)) throw new TypeError(`Unsupported entity memory type: ${String(value)}`)
  }
  return [...new Set(values)].sort()
}

function normalizePriorityClasses(values: PriorityClass[] | undefined): PriorityClass[] | undefined {
  if (!values || values.length === 0) return undefined
  for (const value of values) {
    if (!PRIORITY_CLASSES.has(value)) throw new TypeError(`Unsupported priority class: ${String(value)}`)
  }
  return [...new Set(values)].sort()
}

function cursorPosition(cursor: CursorPayloadV1): NonNullable<EntityKnowledgeQuery['after']> {
  return { at: cursor.at, id: cursor.id }
}

function encodeCursor(payload: CursorPayloadV1): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string, kind: CursorKind, query: string): CursorPayloadV1 {
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('encoding')
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) throw new Error('encoding')
    const value = JSON.parse(bytes.toString('utf8')) as Partial<CursorPayloadV1>
    if (value.v !== 1 || value.kind !== kind || value.query !== query) throw new Error('scope')
    if (typeof value.id !== 'string' || !CURSOR_ID_PATTERN.test(value.id)) throw new Error('id')
    const at = timestamp(value.at, 'cursor timestamp')
    return { v: 1, kind, query, at, id: value.id }
  } catch (error) {
    if (error instanceof InvalidEntityKnowledgeCursorError) throw error
    throw new InvalidEntityKnowledgeCursorError()
  }
}

function sortRows(rows: EntityKnowledgeRow[], order: EntityKnowledgeQuery['order']): EntityKnowledgeRow[] {
  const timeField = order === 'observed-desc' ? 'observed_at' : 'updated_at'
  const direction = order === 'observed-desc' ? -1 : 1
  return [...rows].sort((left, right) => {
    const timeComparison = compareStrings(String(left[timeField]), String(right[timeField]))
    if (timeComparison !== 0) return timeComparison * direction
    return compareStrings(String(left.id), String(right.id)) * direction
  })
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeRow(row: EntityKnowledgeRow): EntityKnowledgeMemoryV1 {
  const context = objectValue(row.context)
  const priorityClass = priorityValue(context.priority_class ?? context.priorityClass)
  return {
    schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
    id: requiredRowString(row.id, 'id'),
    entityId: requiredRowString(row.entity_id, 'entity_id'),
    memoryType: memoryTypeValue(row.memory_type),
    title: requiredRowString(row.title, 'title'),
    summary: requiredRowString(row.summary, 'summary'),
    body: nullableString(row.body),
    eventAt: nullableTimestamp(row.event_at, 'event_at'),
    observedAt: timestamp(row.observed_at, 'observed_at'),
    confidence: typeof row.confidence === 'number' && Number.isFinite(row.confidence) ? row.confidence : null,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    mentions: Array.isArray(row.mentions) ? row.mentions.filter((value): value is string => typeof value === 'string') : [],
    metrics: objectValue(row.metrics),
    context,
    media: {
      imageUrl: nullableString(context.image_url ?? context.imageUrl),
      imageKind: nullableString(context.image_kind ?? context.imageKind),
      attribution: nullableString(context.image_attribution ?? context.imageAttribution),
    },
    provenance: {
      provider: requiredRowString(row.source, 'source'),
      sourceArea: requiredRowString(row.source_area, 'source_area'),
      sourceType: requiredRowString(row.source_type, 'source_type'),
      sourceRefId: requiredRowString(row.source_ref_id, 'source_ref_id'),
      researchPacketId: requiredRowString(row.source_research_id, 'source_research_id'),
    },
    priorityClass,
    createdAt: nullableTimestamp(row.created_at, 'created_at'),
    updatedAt: timestamp(row.updated_at, 'updated_at'),
  }
}

function requiredRowString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`Invalid entity memory ${field}`)
  return value
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : timestamp(value, field)
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function priorityValue(value: unknown): PriorityClass | null {
  return typeof value === 'string' && PRIORITY_CLASSES.has(value as PriorityClass) ? value as PriorityClass : null
}

function memoryTypeValue(value: unknown): EntityKnowledgeMemoryType {
  if (typeof value !== 'string' || !MEMORY_TYPES.has(value as EntityKnowledgeMemoryType)) {
    throw new TypeError(`Unsupported stored entity memory type: ${String(value)}`)
  }
  return value as EntityKnowledgeMemoryType
}

export const __entityKnowledgeReaderTesting = {
  decodeCursor,
  normalizeRow,
}
