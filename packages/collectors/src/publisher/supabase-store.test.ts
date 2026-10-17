import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PipelineStore } from '../pipeline-store/store'
import {
  ENTITY_KNOWLEDGE_SCHEMA_VERSION,
} from '../entity-manager/entity-knowledge-reader'
import type {
  EntityKnowledgeMemoryV1,
  GetEntityMemoriesByIdsInput,
} from '../entity-manager/entity-knowledge-reader'
import type { ManagedEntityRow } from '../entity-manager/managed-entity-catalog'
import { SupabasePublisherStore } from './supabase-store'
import type { PublishedNarrativeInput } from './types'

const NOW = '2026-08-26T12:00:00.000Z'

function memory(id: string): EntityKnowledgeMemoryV1 {
  return {
    schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
    id,
    entityId: '00000000-0000-4000-8000-000000000999',
    memoryType: 'news_event',
    title: `Title ${id}`,
    summary: `Summary ${id}`,
    body: null,
    eventAt: NOW,
    observedAt: NOW,
    confidence: 0.9,
    evidence: [{ evidenceId: `evidence-${id}` }],
    mentions: [],
    metrics: {},
    context: { image_url: `https://example.com/${id}.jpg` },
    media: { imageUrl: `https://example.com/${id}.jpg`, imageKind: 'content', attribution: 'Example' },
    provenance: {
      provider: 'research_gateway',
      sourceArea: 'articles',
      sourceType: 'news',
      sourceRefId: `signal-${id}`,
      researchPacketId: `packet-${id}`,
    },
    priorityClass: 'P1',
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function id(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

test('publisher hydrates normalized memories through bounded Entity Knowledge calls', async () => {
  const calls: GetEntityMemoriesByIdsInput[] = []
  const directTables: string[] = []
  const store = new SupabasePublisherStore(
    { from(table: string) { directTables.push(table); throw new Error('unexpected direct query') } } as unknown as SupabaseClient,
    {} as PipelineStore,
    {
      async getEntityMemoriesByIds(input) {
        calls.push(input)
        return [...input.memoryIds].reverse().map(memory)
      },
    },
  )
  const memoryIds = Array.from({ length: 101 }, (_, index) => id(index + 1))

  const result = await store.fetchMemories([...memoryIds, memoryIds[0]!])

  assert.equal(result.length, 101)
  assert.deepEqual(result.map((item) => item.id), memoryIds)
  assert.deepEqual(calls.map((call) => [call.memoryIds.length, call.limit]), [[100, 100], [1, 1]])
  assert.deepEqual(directTables, [])
  assert.deepEqual(result[0], {
    id: memoryIds[0],
    source: 'research_gateway',
    source_area: 'articles',
    source_type: 'news',
    source_ref_id: `signal-${memoryIds[0]}`,
    source_research_id: `packet-${memoryIds[0]}`,
    title: `Title ${memoryIds[0]}`,
    summary: `Summary ${memoryIds[0]}`,
    evidence: [{ evidenceId: `evidence-${memoryIds[0]}` }],
    context: { image_url: `https://example.com/${memoryIds[0]}.jpg` },
  })
})

test('publisher preserves its typed read failure boundary when knowledge hydration fails', async () => {
  const cause = new Error('temporary storage outage')
  const store = new SupabasePublisherStore(
    {} as SupabaseClient,
    {} as PipelineStore,
    { async getEntityMemoriesByIds() { throw cause } },
  )

  await assert.rejects(
    store.fetchMemories([id(1)]),
    (error: unknown) => error instanceof Error
      && error.message === 'publisher memory fetch failed: temporary storage outage'
      && error.cause === cause,
  )
})

test('publisher fails closed before an extreme aggregate knowledge hydration drain', async () => {
  let calls = 0
  const store = new SupabasePublisherStore(
    {} as SupabaseClient,
    {} as PipelineStore,
    { async getEntityMemoriesByIds() { calls += 1; return [] } },
  )
  const memoryIds = Array.from({ length: 1_001 }, (_, index) => id(index + 1))

  await assert.rejects(store.fetchMemories(memoryIds), /exceeds 10 bounded knowledge requests/)
  assert.equal(calls, 0)
})

test('publisher does not fall back to a stale Entity ID when canonical resolution fails', async () => {
  let directReads = 0
  const store = new SupabasePublisherStore(
    {
      async rpc() { return { data: [], error: null } },
      from() { directReads += 1; throw new Error('stale Entity must not be read') },
    } as unknown as SupabaseClient,
    {} as PipelineStore,
    { async getEntityMemoriesByIds() { return [] } },
  )

  assert.equal(await store.fetchEntity(id(999)), null)
  assert.equal(directReads, 0)
})

const MANAGED_ENTITY_ID = '00000000-0000-4000-8000-000000001234'

function managedEntityRow(status = 'active'): ManagedEntityRow {
  return {
    id: MANAGED_ENTITY_ID,
    slug: 'private-slug',
    name: 'Private Entity',
    type: 'asset',
    aliases: [],
    summary: 'Managed only',
    status,
    show_in_carousel: null,
    metadata: { source: 'managed_v4' },
    created_at: NOW,
    updated_at: NOW,
    catalog_entity_id: null,
  }
}

function publicationInput(entityId: string): PublishedNarrativeInput {
  return {
    editor_draft_id: 'draft-1',
    title: 'Title',
    content_small: 'small',
    content_full: 'full',
    priority: 10,
    actions: [],
    tags: [],
    status: 'published',
    published_at: NOW,
    entity_id: entityId,
    entity_slug: 'private-slug',
    entity_name: 'Private Entity',
    entity_type: 'asset',
    entity_category: null,
    source_memory_ids: ['memory-1'],
    source_memory_hash: 'hash-1',
    source: null,
    source_area: null,
    angle: null,
    reasoning: 'why',
    evidence_quality: null,
    confidence: null,
  }
}

interface PublisherFakeOptions {
  publicEntityRow: { id: string } | null
  managedRows: ManagedEntityRow[]
  managedError: string | null
  existingNarrativeDraftIds: string[]
}

// Covers every table call publishDraft/fetchEntity chain: existing-narrative
// read, entity existence check, narrative insert, history upsert, plus the
// redirect and managed-store rpc reads.
class PublisherFakeBuilder implements PromiseLike<{ data: unknown, error: null }> {
  private mode: 'read' | 'insert' | 'upsert' = 'read'
  private id: string | null = null
  private payload: unknown = null
  constructor(private readonly result: (call: {
    mode: 'read' | 'insert' | 'upsert'
    id: string | null
    payload: unknown
  }) => { data: unknown, error: null }) {}
  select(): this { return this }
  eq(_column: string, value: unknown): this { this.id = value as string; return this }
  insert(payload: unknown): this { this.mode = 'insert'; this.payload = payload; return this }
  upsert(payload: unknown): this { this.mode = 'upsert'; this.payload = payload; return this }
  single(): this { return this }
  maybeSingle(): this { return this }
  order(): this { return this }
  limit(): this { return this }
  then<TResult1 = { data: unknown, error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown, error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result({ mode: this.mode, id: this.id, payload: this.payload }))
      .then(onfulfilled ?? undefined)
  }
}

function publisherFake(options: PublisherFakeOptions): { db: SupabaseClient, inserts: unknown[], upserts: unknown[] } {
  const inserts: unknown[] = []
  const upserts: unknown[] = []
  const db = {
    from(table: string) {
      return new PublisherFakeBuilder(({ mode, id, payload }) => {
        if (table === 'published_narratives') {
          if (mode === 'insert') {
            inserts.push(payload)
            return { data: { id: 'narrative-1', editor_draft_id: 'draft-1', created_at: NOW, published_at: NOW }, error: null }
          }
          return {
            data: id !== null && options.existingNarrativeDraftIds.includes(id) ? { id: 'narrative-0' } : null,
            error: null,
          }
        }
        if (table === 'entities') {
          return {
            data: options.publicEntityRow && id !== null && id === options.publicEntityRow.id ? options.publicEntityRow : null,
            error: null,
          }
        }
        if (table === 'entity_published_history') {
          if (mode === 'upsert') upserts.push(payload)
          return { data: null, error: null }
        }
        return { data: null, error: null }
      })
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === 'resolve_entity_redirect_v1') return { data: null, error: null }
      assert.equal(name, 'read_managed_entities_v1')
      const ids = args.p_entity_ids as string[]
      if (options.managedError) return { data: null, error: { message: options.managedError } }
      return { data: options.managedRows.filter((row) => ids.includes(row.id)), error: null }
    },
  } as unknown as SupabaseClient
  return { db, inserts, upserts }
}

function publisherStore(fake: { db: SupabaseClient }): SupabasePublisherStore {
  return new SupabasePublisherStore(fake.db, {} as PipelineStore, { async getEntityMemoriesByIds() { return [] } })
}

function publishingPipelineStore(published: string[]): PipelineStore {
  return {
    async setDraftPublished(draftId: string) { published.push(draftId) },
  } as unknown as PipelineStore
}

test('publisher publishes a draft whose entity only exists in the managed store', async () => {
  const published: string[] = []
  const fake = publisherFake({
    publicEntityRow: null,
    managedRows: [managedEntityRow()],
    managedError: null,
    existingNarrativeDraftIds: [],
  })
  const store = new SupabasePublisherStore(fake.db, publishingPipelineStore(published), {
    async getEntityMemoriesByIds() { return [] },
  })

  const result = await store.publishDraft(publicationInput(MANAGED_ENTITY_ID))

  assert.deepEqual(result, {
    narrative: { id: 'narrative-1', editor_draft_id: 'draft-1', created_at: NOW, published_at: NOW },
    existing: false,
  })
  assert.equal(fake.inserts.length, 1)
  assert.equal((fake.inserts[0] as Record<string, unknown>).entity_id, MANAGED_ENTITY_ID)
  assert.equal(fake.upserts.length, 1)
  assert.deepEqual(published, ['draft-1'])
})

test('publisher refuses to publish an entity id that exists in neither store and inserts nothing', async () => {
  const fake = publisherFake({
    publicEntityRow: null,
    managedRows: [],
    managedError: null,
    existingNarrativeDraftIds: [],
  })
  const store = publisherStore(fake)

  await assert.rejects(
    store.publishDraft(publicationInput(MANAGED_ENTITY_ID)),
    (error: unknown) => error instanceof Error
      && error.message === `publisher entity check failed: ${MANAGED_ENTITY_ID} exists in neither public.entities nor the managed store`,
  )
  assert.deepEqual(fake.inserts, [])
  assert.deepEqual(fake.upserts, [])
})

test('publisher fetchEntity falls back to an active managed row when the redirect returns null', async () => {
  const fake = publisherFake({
    publicEntityRow: null,
    managedRows: [managedEntityRow('review'), managedEntityRow()],
    managedError: null,
    existingNarrativeDraftIds: [],
  })
  const store = publisherStore(fake)

  assert.deepEqual(await store.fetchEntity(MANAGED_ENTITY_ID), {
    id: MANAGED_ENTITY_ID,
    slug: 'private-slug',
    name: 'Private Entity',
    type: 'asset',
    metadata: { source: 'managed_v4' },
  })
})

test('publisher fails closed on a managed entity check error without inserting', async () => {
  const fake = publisherFake({
    publicEntityRow: null,
    managedRows: [],
    managedError: 'temporary outage',
    existingNarrativeDraftIds: [],
  })
  const store = publisherStore(fake)

  await assert.rejects(
    store.publishDraft(publicationInput(MANAGED_ENTITY_ID)),
    (error: unknown) => error instanceof Error
      && error.message === 'publisher entity check failed: managed entity lookup failed: temporary outage',
  )
  assert.deepEqual(fake.inserts, [])
  assert.deepEqual(fake.upserts, [])
})
