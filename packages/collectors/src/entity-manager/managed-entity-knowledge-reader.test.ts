import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  EntityKnowledgeEventQueryResult,
  EntityKnowledgeQueryPort,
  EntityKnowledgeRow,
} from './entity-knowledge-query'
import { ENTITY_KNOWLEDGE_SCHEMA_VERSION } from './entity-knowledge-reader'
import {
  DualEntityKnowledgeQueryPort,
  SupabaseManagedEntityKnowledgeQueryPort,
  SupabaseManagedEntityKnowledgeReader,
} from './managed-entity-knowledge-reader'

interface RpcCall {
  name: string
  args: Record<string, unknown>
}

const CANONICAL_ENTITY_ID = '20000000-0000-4000-8000-000000000002'
const RAW_ENTITY_ID = '20000000-0000-4000-8000-0000000000aa'
const MEMORY_ID_A = '10000000-0000-4000-8000-000000000001'
const MEMORY_ID_B = '10000000-0000-4000-8000-000000000002'
const MEMORY_ID_C = '10000000-0000-4000-8000-000000000003'

function fakeRow(overrides: Partial<EntityKnowledgeRow> = {}): EntityKnowledgeRow {
  return {
    id: MEMORY_ID_A,
    entity_id: CANONICAL_ENTITY_ID,
    source: 'news',
    source_area: 'feed',
    source_type: 'article',
    source_ref_id: 'article-1',
    source_research_id: 'packet-1',
    memory_type: 'news_event',
    title: 'Policy shift reprices odds',
    summary: 'Traders moved within minutes of the report.',
    body: null,
    event_at: '2026-10-15T10:00:00+00:00',
    observed_at: '2026-10-15T10:00:05+00:00',
    confidence: null,
    evidence: [],
    mentions: [],
    metrics: {},
    context: {},
    created_at: '2026-10-15T10:00:06+00:00',
    updated_at: '2026-10-15T10:00:06+00:00',
    ...overrides,
  }
}

class StubPort implements EntityKnowledgeQueryPort {
  constructor(
    private readonly memories: EntityKnowledgeRow[] | Error,
    private readonly events: EntityKnowledgeEventQueryResult | Error,
  ) {}

  async queryMemories(): Promise<EntityKnowledgeRow[]> {
    if (this.memories instanceof Error) throw this.memories
    return this.memories
  }

  async queryMemoryEvents(): Promise<EntityKnowledgeEventQueryResult> {
    if (this.events instanceof Error) throw this.events
    return this.events
  }
}

test('managed query port redirects the Entity and maps every RPC argument', async () => {
  const calls: RpcCall[] = []
  const row = fakeRow()
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args })
      if (name === 'resolve_entity_redirect_v1') return { data: CANONICAL_ENTITY_ID, error: null }
      assert.equal(calls.length, 2)
      return { data: { rows: [row], totalCount: null }, error: null }
    },
  } as unknown as SupabaseClient

  const port = new SupabaseManagedEntityKnowledgeQueryPort(db)
  const rows = await port.queryMemories({
    order: 'observed-desc',
    entityId: RAW_ENTITY_ID,
    since: '2026-10-01T00:00:00.000Z',
    memoryTypes: ['news_event'],
    priorityClasses: ['P0', 'P1'],
    after: { at: '2026-10-15T10:00:00+00:00', id: MEMORY_ID_B },
    limit: 11,
  })

  assert.deepEqual(rows, [row])
  assert.deepEqual(calls, [
    { name: 'resolve_entity_redirect_v1', args: { p_entity_id: RAW_ENTITY_ID } },
    {
      name: 'read_managed_entity_knowledge_v1',
      args: {
        p_order: 'observed-desc',
        p_entity_id: CANONICAL_ENTITY_ID,
        p_memory_ids: null,
        p_since: '2026-10-01T00:00:00.000Z',
        p_memory_types: ['news_event'],
        p_priority_classes: ['P0', 'P1'],
        p_after_at: '2026-10-15T10:00:00+00:00',
        p_after_id: MEMORY_ID_B,
        p_limit: 11,
      },
    },
  ])
})

test('managed query port hydrates bounded memory IDs without a redirect lookup', async () => {
  const calls: RpcCall[] = []
  const row = fakeRow({ id: MEMORY_ID_A })
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args })
      assert.equal(name, 'read_managed_entity_knowledge_v1')
      return { data: { rows: [row], totalCount: null }, error: null }
    },
  } as unknown as SupabaseClient

  const port = new SupabaseManagedEntityKnowledgeQueryPort(db)
  const rows = await port.queryMemories({
    order: 'id-asc',
    memoryIds: [MEMORY_ID_A, MEMORY_ID_B],
    limit: 2,
  })

  assert.deepEqual(rows, [row])
  assert.deepEqual(calls, [{
    name: 'read_managed_entity_knowledge_v1',
    args: {
      p_order: 'id-asc',
      p_entity_id: null,
      p_memory_ids: [MEMORY_ID_A, MEMORY_ID_B],
      p_since: null,
      p_memory_types: null,
      p_priority_classes: null,
      p_after_at: null,
      p_after_id: null,
      p_limit: 2,
    },
  }])
})

test('managed query port passes the original ID through when public entities lack it', async () => {
  const calls: RpcCall[] = []
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args })
      if (name === 'resolve_entity_redirect_v1') return { data: null, error: null }
      return { data: { rows: [], totalCount: null }, error: null }
    },
  } as unknown as SupabaseClient

  await new SupabaseManagedEntityKnowledgeQueryPort(db).queryMemories({
    order: 'observed-desc',
    entityId: RAW_ENTITY_ID,
    limit: 1,
  })

  assert.deepEqual(calls, [
    { name: 'resolve_entity_redirect_v1', args: { p_entity_id: RAW_ENTITY_ID } },
    {
      name: 'read_managed_entity_knowledge_v1',
      args: {
        p_order: 'observed-desc',
        p_entity_id: RAW_ENTITY_ID,
        p_memory_ids: null,
        p_since: null,
        p_memory_types: null,
        p_priority_classes: null,
        p_after_at: null,
        p_after_id: null,
        p_limit: 1,
      },
    },
  ])
})

test('managed query port propagates rpc and redirect lookups as failures', async () => {
  const failingDb = {
    async rpc() {
      return { data: null, error: { message: 'relation is not accessible' } }
    },
  } as unknown as SupabaseClient
  await assert.rejects(
    new SupabaseManagedEntityKnowledgeQueryPort(failingDb).queryMemories({ order: 'observed-desc', limit: 5 }),
    /managed entity knowledge query failed: relation is not accessible/,
  )

  const failingRedirectDb = {
    async rpc(name: string) {
      if (name === 'resolve_entity_redirect_v1') return { data: null, error: { message: 'lookup exploded' } }
      throw new Error('managed knowledge must not be queried')
    },
  } as unknown as SupabaseClient
  await assert.rejects(
    new SupabaseManagedEntityKnowledgeQueryPort(failingRedirectDb)
      .queryMemories({ order: 'observed-desc', entityId: RAW_ENTITY_ID, limit: 5 }),
    /entity redirect lookup failed: lookup exploded/,
  )
})

test('managed query port rejects function results that are not a rows envelope', async () => {
  for (const data of [null, {}, { rows: 'three' }]) {
    const db = {
      async rpc(name: string) {
        if (name === 'resolve_entity_redirect_v1') return { data: CANONICAL_ENTITY_ID, error: null }
        return { data, error: null }
      },
    } as unknown as SupabaseClient
    await assert.rejects(
      new SupabaseManagedEntityKnowledgeQueryPort(db).queryMemories({ order: 'observed-desc', entityId: RAW_ENTITY_ID, limit: 1 }),
      /managed entity knowledge query returned an invalid result/,
    )
  }
})

test('managed query port returns event rows with the exact entity total', async () => {
  const row = fakeRow()
  const calls: RpcCall[] = []
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args })
      if (name === 'resolve_entity_redirect_v1') return { data: CANONICAL_ENTITY_ID, error: null }
      return { data: { rows: [row], totalCount: 7 }, error: null }
    },
  } as unknown as SupabaseClient

  const result = await new SupabaseManagedEntityKnowledgeQueryPort(db).queryMemoryEvents({
    entityId: RAW_ENTITY_ID,
    after: { at: '2026-10-14T00:00:00.000Z', id: MEMORY_ID_B },
    limit: 11,
  })

  assert.deepEqual(result.rows, [row])
  assert.equal(result.totalCount, 7)
  assert.deepEqual(calls, [
    { name: 'resolve_entity_redirect_v1', args: { p_entity_id: RAW_ENTITY_ID } },
    {
      name: 'read_managed_entity_knowledge_v1',
      args: {
        p_order: 'event-desc',
        p_entity_id: CANONICAL_ENTITY_ID,
        p_memory_ids: null,
        p_since: null,
        p_memory_types: null,
        p_priority_classes: null,
        p_after_at: '2026-10-14T00:00:00.000Z',
        p_after_id: MEMORY_ID_B,
        p_limit: 11,
      },
    },
  ])
})

test('managed query port fails when the event total is unusable', async () => {
  for (const totalCount of [null, undefined, -1, '7']) {
    const db = {
      async rpc(name: string) {
        if (name === 'resolve_entity_redirect_v1') return { data: CANONICAL_ENTITY_ID, error: null }
        return { data: { rows: [], totalCount }, error: null }
      },
    } as unknown as SupabaseClient
    await assert.rejects(
      new SupabaseManagedEntityKnowledgeQueryPort(db).queryMemoryEvents({ entityId: RAW_ENTITY_ID, limit: 5 }),
      /managed entity knowledge event count was unavailable/,
    )
  }
})

test('managed reader normalizes event pages end to end', async () => {
  const row = fakeRow()
  const db = {
    async rpc(name: string) {
      if (name === 'resolve_entity_redirect_v1') return { data: CANONICAL_ENTITY_ID, error: null }
      assert.equal(name, 'read_managed_entity_knowledge_v1')
      return { data: { rows: [row], totalCount: 1 }, error: null }
    },
  } as unknown as SupabaseClient

  const page = await new SupabaseManagedEntityKnowledgeReader(db).getEntityMemoryEvents({
    entityId: CANONICAL_ENTITY_ID,
    limit: 10,
  })

  assert.equal(page.schemaVersion, ENTITY_KNOWLEDGE_SCHEMA_VERSION)
  assert.equal(page.totalCount, 1)
  assert.equal(page.hasMore, false)
  assert.equal(page.nextCursor, null)
  assert.deepEqual(page.items, [{
    schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
    id: MEMORY_ID_A,
    entityId: CANONICAL_ENTITY_ID,
    memoryType: 'news_event',
    title: 'Policy shift reprices odds',
    summary: 'Traders moved within minutes of the report.',
    body: null,
    eventAt: '2026-10-15T10:00:00.000Z',
    observedAt: '2026-10-15T10:00:05.000Z',
    confidence: null,
    evidence: [],
    mentions: [],
    metrics: {},
    context: {},
    media: { imageUrl: null, imageKind: null, attribution: null },
    provenance: {
      provider: 'news',
      sourceArea: 'feed',
      sourceType: 'article',
      sourceRefId: 'article-1',
      researchPacketId: 'packet-1',
    },
    priorityClass: null,
    createdAt: '2026-10-15T10:00:06.000Z',
    updatedAt: '2026-10-15T10:00:06.000Z',
  }])
})

test('dual port merges V4-first, drops legacy duplicates, and honours the limit', async () => {
  const older = fakeRow({ id: MEMORY_ID_A, observed_at: '2026-10-15T10:00:00+00:00' })
  const managedNew = fakeRow({ id: MEMORY_ID_B, observed_at: '2026-10-16T10:00:00+00:00' })
  const legacyDuplicate = fakeRow({ id: MEMORY_ID_B, observed_at: '2026-10-17T10:00:00+00:00' })
  const legacyOnly = fakeRow({ id: MEMORY_ID_C, entity_id: RAW_ENTITY_ID, observed_at: '2026-10-14T10:00:00+00:00' })
  const port = new DualEntityKnowledgeQueryPort(
    new StubPort([older, managedNew], { rows: [], totalCount: 0 }),
    new StubPort([legacyDuplicate, legacyOnly], { rows: [], totalCount: 0 }),
  )

  assert.deepEqual(
    await port.queryMemories({ order: 'observed-desc', limit: 3 }),
    [managedNew, older, legacyOnly],
  )
  assert.deepEqual(
    await port.queryMemories({ order: 'observed-desc', limit: 2 }),
    [managedNew, older],
  )
})

test('dual port orders hydrated memory IDs ascending across both ports', async () => {
  const fromLegacy = fakeRow({ id: MEMORY_ID_A, entity_id: RAW_ENTITY_ID })
  const fromManaged = fakeRow({ id: MEMORY_ID_B })
  const port = new DualEntityKnowledgeQueryPort(
    new StubPort([fromManaged], { rows: [], totalCount: 0 }),
    new StubPort([fromLegacy], { rows: [], totalCount: 0 }),
  )

  assert.deepEqual(
    await port.queryMemories({ order: 'id-asc', limit: 2 }),
    [fromLegacy, fromManaged],
  )
})

test('dual port sums the event totals to the exact count', async () => {
  const newest = fakeRow({ id: MEMORY_ID_A, event_at: '2026-10-15T10:02:00+00:00' })
  const middle = fakeRow({ id: MEMORY_ID_B, event_at: '2026-10-15T10:01:00+00:00' })
  const older = fakeRow({ id: MEMORY_ID_C, entity_id: RAW_ENTITY_ID, event_at: '2026-10-15T10:00:00+00:00' })
  const port = new DualEntityKnowledgeQueryPort(
    new StubPort([], { rows: [newest, older], totalCount: 5 }),
    new StubPort([], { rows: [middle], totalCount: 2 }),
  )

  const result = await port.queryMemoryEvents({ entityId: RAW_ENTITY_ID, limit: 2 })
  assert.deepEqual(result.rows, [newest, middle])
  assert.equal(result.totalCount, 7)
})

test('dual port falls back to the managed port alone when the legacy port fails', async () => {
  const warnings: Record<string, unknown>[] = []
  const managedRows = [fakeRow()]
  const port = new DualEntityKnowledgeQueryPort(
    new StubPort(managedRows, { rows: [], totalCount: 4 }),
    new StubPort(new Error('legacy exploded'), { rows: [], totalCount: 4 }),
    (event) => warnings.push(event),
  )

  assert.deepEqual(await port.queryMemories({ order: 'observed-desc', limit: 5 }), managedRows)
  assert.deepEqual(warnings, [{
    event: 'entity_knowledge_dual_read_fallback',
    failed: 'legacy',
    operation: 'queryMemories',
    error: 'legacy exploded',
  }])
})

test('dual port falls back to the legacy port alone when the managed port fails', async () => {
  const warnings: Record<string, unknown>[] = []
  const legacyRows = [fakeRow({ id: MEMORY_ID_B, entity_id: RAW_ENTITY_ID })]
  const legacyEvents: EntityKnowledgeEventQueryResult = { rows: legacyRows, totalCount: 3 }
  const port = new DualEntityKnowledgeQueryPort(
    new StubPort(new Error('managed exploded'), new Error('managed event query failed')),
    new StubPort(legacyRows, legacyEvents),
    (event) => warnings.push(event),
  )

  assert.deepEqual(await port.queryMemories({ order: 'observed-desc', limit: 5 }), legacyRows)
  assert.deepEqual(warnings, [{
    event: 'entity_knowledge_dual_read_fallback',
    failed: 'managed',
    operation: 'queryMemories',
    error: 'managed exploded',
  }])

  warnings.length = 0
  const events = await port.queryMemoryEvents({ entityId: RAW_ENTITY_ID, limit: 5 })
  assert.deepEqual(events, legacyEvents)
  assert.deepEqual(warnings, [{
    event: 'entity_knowledge_dual_read_fallback',
    failed: 'managed',
    operation: 'queryMemoryEvents',
    error: 'managed event query failed',
  }])
})

test('dual port rethrows the legacy rejection when both ports fail', async () => {
  const warnings: Record<string, unknown>[] = []
  const port = new DualEntityKnowledgeQueryPort(
    new StubPort(new Error('managed exploded'), new Error('managed exploded')),
    new StubPort(new Error('legacy exploded'), new Error('legacy exploded')),
    (event) => warnings.push(event),
  )

  await assert.rejects(
    port.queryMemories({ order: 'observed-desc', limit: 5 }),
    /legacy exploded/,
  )
  await assert.rejects(
    port.queryMemoryEvents({ entityId: RAW_ENTITY_ID, limit: 5 }),
    /legacy exploded/,
  )
  assert.deepEqual(warnings, [])
})