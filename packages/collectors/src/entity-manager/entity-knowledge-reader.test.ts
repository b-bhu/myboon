import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ENTITY_KNOWLEDGE_MAX_PAGE_SIZE,
  ENTITY_MEMORY_CHANGES_START_CURSOR,
  InvalidEntityKnowledgeCursorError,
  PortBackedEntityKnowledgeReader,
} from './entity-knowledge-reader'
import type { EntityKnowledgeQuery, EntityKnowledgeQueryPort, EntityKnowledgeRow } from './entity-knowledge-query'

const T1 = '2026-08-26T10:00:00.000Z'
const T2 = '2026-08-26T11:00:00.000Z'
const T3 = '2026-08-26T12:00:00.000Z'

function row(overrides: Partial<EntityKnowledgeRow> = {}): EntityKnowledgeRow {
  return {
    id: 'memory-a',
    entity_id: 'entity-1',
    source: 'news',
    source_area: 'feed',
    source_type: 'article',
    source_ref_id: 'article-1',
    source_research_id: 'packet-1',
    memory_type: 'news_event',
    title: 'A material event',
    summary: 'The source reported a material event.',
    body: 'Context for the event.',
    event_at: T1,
    observed_at: T1,
    confidence: 0.8,
    evidence: [{ url: 'https://example.com/evidence' }],
    mentions: ['Bitcoin'],
    metrics: { move: 5 },
    context: {
      priority_class: 'P1',
      image_url: 'https://example.com/image.jpg',
      image_kind: 'content',
      image_attribution: 'Example',
    },
    created_at: T1,
    updated_at: T1,
    ...overrides,
  }
}

class InMemoryQueryPort implements EntityKnowledgeQueryPort {
  readonly limits: number[] = []

  constructor(private readonly rows: EntityKnowledgeRow[]) {}

  async queryMemories(query: EntityKnowledgeQuery): Promise<EntityKnowledgeRow[]> {
    this.limits.push(query.limit)
    if (query.order === 'id-asc') {
      const memoryIds = new Set(query.memoryIds ?? [])
      return this.rows
        .filter((candidate) => memoryIds.has(String(candidate.id)))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
        .slice(0, query.limit)
    }
    const timeField = query.order === 'observed-desc' ? 'observed_at' : 'updated_at'
    const direction = query.order === 'observed-desc' ? -1 : 1
    const filtered = this.rows.filter((candidate) => {
      if (query.entityId && candidate.entity_id !== query.entityId) return false
      if (query.since && String(candidate.observed_at) < query.since) return false
      if (query.memoryTypes && !query.memoryTypes.includes(candidate.memory_type as never)) return false
      const context = candidate.context as Record<string, unknown>
      if (query.priorityClasses && !query.priorityClasses.includes(context.priority_class as never)) return false
      if (query.after) {
        const at = String(candidate[timeField])
        const id = String(candidate.id)
        if (direction < 0 && !(at < query.after.at || (at === query.after.at && id < query.after.id))) return false
        if (direction > 0 && !(at > query.after.at || (at === query.after.at && id > query.after.id))) return false
      }
      return true
    })
    filtered.sort((left, right) => {
      const leftTime = String(left[timeField])
      const rightTime = String(right[timeField])
      const byTime = leftTime < rightTime ? -1 : leftTime > rightTime ? 1 : 0
      const leftId = String(left.id)
      const rightId = String(right.id)
      return byTime !== 0
        ? byTime * direction
        : (leftId < rightId ? -1 : leftId > rightId ? 1 : 0) * direction
    })
    return filtered.slice(0, query.limit)
  }

  async queryMemoryEvents(query: import('./entity-knowledge-query').EntityKnowledgeEventQuery) {
    const rows = this.rows.filter((candidate) => (
      candidate.entity_id === query.entityId && typeof candidate.event_at === 'string'
    ))
    const filtered = rows.filter((candidate) => !query.after || (
      String(candidate.event_at) < query.after.at
      || (String(candidate.event_at) === query.after.at && String(candidate.id) < query.after.id)
    ))
    filtered.sort((left, right) => (
      String(right.event_at).localeCompare(String(left.event_at))
      || String(right.id).localeCompare(String(left.id))
    ))
    this.limits.push(query.limit)
    return { rows: filtered.slice(0, query.limit), totalCount: rows.length }
  }
}

test('entity memory cursor pagination has no gaps or duplicates and is deterministic on tied timestamps', async () => {
  const port = new InMemoryQueryPort([
    row({ id: 'memory-a', observed_at: T1 }),
    row({ id: 'memory-b', observed_at: T2 }),
    row({ id: 'memory-c', observed_at: T2 }),
    row({ id: 'memory-d', observed_at: T3 }),
    row({ id: 'memory-e', observed_at: T3 }),
    row({ id: 'other-entity', entity_id: 'entity-2', observed_at: T3 }),
  ])
  const reader = new PortBackedEntityKnowledgeReader(port)
  const ids: string[] = []
  let cursor: string | undefined

  do {
    const page = await reader.getEntityMemories({ entityId: 'entity-1', limit: 2, cursor })
    ids.push(...page.items.map((item) => item.id))
    cursor = page.nextCursor ?? undefined
    if (!page.hasMore) break
  } while (cursor)

  assert.deepEqual(ids, ['memory-e', 'memory-d', 'memory-c', 'memory-b', 'memory-a'])
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(port.limits, [3, 3, 3])
})

test('entity memories apply inclusive since and memory type filters', async () => {
  const reader = new PortBackedEntityKnowledgeReader(new InMemoryQueryPort([
    row({ id: 'before', observed_at: T1, memory_type: 'market_signal' }),
    row({ id: 'included', observed_at: T2, memory_type: 'market_signal' }),
    row({ id: 'wrong-type', observed_at: T3, memory_type: 'news_event' }),
  ]))

  const page = await reader.getEntityMemories({
    entityId: 'entity-1',
    since: T2,
    memoryTypes: ['market_signal'],
    limit: 10,
  })

  assert.deepEqual(page.items.map((item) => item.id), ['included'])
})

test('event-time pages are stable on ties and carry the exact Entity event count', async () => {
  const reader = new PortBackedEntityKnowledgeReader(new InMemoryQueryPort([
    row({ id: 'memory-a', event_at: T1 }),
    row({ id: 'memory-b', event_at: T2 }),
    row({ id: 'memory-c', event_at: T2 }),
    row({ id: 'memory-without-event', event_at: null }),
    row({ id: 'other-entity', entity_id: 'entity-2', event_at: T3 }),
  ]))

  const first = await reader.getEntityMemoryEvents({ entityId: 'entity-1', limit: 2 })
  assert.deepEqual(first.items.map((item) => item.id), ['memory-c', 'memory-b'])
  assert.equal(first.totalCount, 3)
  assert.equal(first.hasMore, true)
  assert.ok(first.nextCursor)
  const second = await reader.getEntityMemoryEvents({
    entityId: 'entity-1', limit: 2, cursor: first.nextCursor ?? undefined,
  })
  assert.deepEqual(second.items.map((item) => item.id), ['memory-a'])
  assert.equal(second.totalCount, 3)
  assert.equal(second.hasMore, false)
})

test('exact memory hydration is bounded, deduplicated, and follows first-requested ID order', async () => {
  const port = new InMemoryQueryPort([
    row({ id: 'memory-a' }),
    row({ id: 'memory-b' }),
    row({ id: 'memory-c' }),
  ])
  const reader = new PortBackedEntityKnowledgeReader(port)

  const memories = await reader.getEntityMemoriesByIds({
    memoryIds: ['memory-c', 'memory-missing', 'memory-a', 'memory-c'],
    limit: 3,
  })

  assert.deepEqual(memories.map((memory) => memory.id), ['memory-c', 'memory-a'])
  assert.deepEqual(port.limits, [3])
})

test('exact memory hydration rejects invalid IDs and silent limit truncation', async () => {
  const reader = new PortBackedEntityKnowledgeReader(new InMemoryQueryPort([]))

  await assert.rejects(
    reader.getEntityMemoriesByIds({ memoryIds: ['memory-a', 'memory-b'], limit: 1 }),
    /more unique IDs than limit/,
  )
  await assert.rejects(
    reader.getEntityMemoriesByIds({ memoryIds: ['not valid'], limit: 1 }),
    /Invalid entity memory ID/,
  )
  await assert.rejects(
    reader.getEntityMemoriesByIds({ memoryIds: ['memory-a'], limit: ENTITY_KNOWLEDGE_MAX_PAGE_SIZE + 1 }),
    /between 1 and 100/,
  )
})

test('recent memories apply common priority classes independently of source', async () => {
  const reader = new PortBackedEntityKnowledgeReader(new InMemoryQueryPort([
    row({ id: 'news-p0', source: 'news', context: { priority_class: 'P0' }, observed_at: T3 }),
    row({ id: 'market-p1', source: 'polymarket', context: { priority_class: 'P1' }, observed_at: T2 }),
    row({ id: 'social-p3', source: 'social', context: { priority_class: 'P3' }, observed_at: T1 }),
    row({ id: 'stale-p0', source: 'news', context: { priority_class: 'P0' }, observed_at: T1 }),
  ]))

  const page = await reader.getRecentEntityMemories({ priorityClasses: ['P0', 'P1'], since: T2, limit: 10 })

  assert.deepEqual(page.items.map((item) => item.id), ['news-p0', 'market-p1'])
  assert.deepEqual(page.items.map((item) => item.priorityClass), ['P0', 'P1'])
})

test('reader rejects malformed, wrong-scope, and filter-mismatched cursors', async () => {
  const reader = new PortBackedEntityKnowledgeReader(new InMemoryQueryPort([
    row({ id: 'memory-c', observed_at: T3 }),
    row({ id: 'memory-b', observed_at: T2 }),
  ]))

  await assert.rejects(
    reader.getEntityMemories({ entityId: 'entity-1', limit: 1, cursor: 'not-json' }),
    InvalidEntityKnowledgeCursorError,
  )

  const first = await reader.getEntityMemories({ entityId: 'entity-1', limit: 1 })
  assert.ok(first.nextCursor)
  await assert.rejects(
    reader.getEntityMemories({ entityId: 'entity-2', limit: 1, cursor: first.nextCursor ?? undefined }),
    InvalidEntityKnowledgeCursorError,
  )
  await assert.rejects(
    reader.getRecentEntityMemories({ limit: 1, cursor: first.nextCursor ?? undefined }),
    InvalidEntityKnowledgeCursorError,
  )
})

test('reader enforces the strict v1 maximum page size', async () => {
  const port = new InMemoryQueryPort([])
  const reader = new PortBackedEntityKnowledgeReader(port)

  await assert.rejects(
    reader.getRecentEntityMemories({ limit: ENTITY_KNOWLEDGE_MAX_PAGE_SIZE + 1 }),
    RangeError,
  )
  assert.deepEqual(port.limits, [])
})

test('change polling is stable, forward-only, and keeps the input cursor when empty', async () => {
  const reader = new PortBackedEntityKnowledgeReader(new InMemoryQueryPort([
    row({ id: 'memory-c', updated_at: T2 }),
    row({ id: 'memory-a', updated_at: T1 }),
    row({ id: 'memory-b', updated_at: T1 }),
  ]))

  const first = await reader.getEntityMemoryChanges({ afterCursor: ENTITY_MEMORY_CHANGES_START_CURSOR, limit: 2 })
  assert.deepEqual(first.changes.map((change) => change.memory.id), ['memory-a', 'memory-b'])
  assert.equal(first.hasMore, true)

  const second = await reader.getEntityMemoryChanges({ afterCursor: first.nextCursor, limit: 2 })
  assert.deepEqual(second.changes.map((change) => change.memory.id), ['memory-c'])
  assert.equal(second.hasMore, false)

  const empty = await reader.getEntityMemoryChanges({ afterCursor: second.nextCursor, limit: 2 })
  assert.deepEqual(empty.changes, [])
  assert.equal(empty.nextCursor, second.nextCursor)
})

test('v1 output preserves media, context, and provenance without leaking Supabase row keys', async () => {
  const reader = new PortBackedEntityKnowledgeReader(new InMemoryQueryPort([row()]))
  const page = await reader.getRecentEntityMemories({ limit: 1 })
  const memory = page.items[0]

  assert.deepEqual(memory.media, {
    imageUrl: 'https://example.com/image.jpg',
    imageKind: 'content',
    attribution: 'Example',
  })
  assert.deepEqual(memory.provenance, {
    provider: 'news',
    sourceArea: 'feed',
    sourceType: 'article',
    sourceRefId: 'article-1',
    researchPacketId: 'packet-1',
  })
  assert.equal(memory.context.image_url, 'https://example.com/image.jpg')
  assert.equal(Object.hasOwn(memory, 'source_research_id'), false)
  assert.equal(Object.hasOwn(memory, 'observed_at'), false)
})
