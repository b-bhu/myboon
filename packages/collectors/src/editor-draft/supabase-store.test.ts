import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ENTITY_KNOWLEDGE_SCHEMA_VERSION,
} from '../entity-manager/entity-knowledge-reader'
import type {
  EntityKnowledgeMemoryV1,
  EntityKnowledgeReader,
} from '../entity-manager/entity-knowledge-reader'
import type { PipelineStore } from '../pipeline-store/store'
import { SupabaseEditorDraftStore, __testing } from './supabase-store'

const NOW = '2026-08-26T12:00:00.000Z'

function knowledgeMemory(
  id: string,
  entityId = 'entity-1',
  observedAt = NOW,
  createdAt = observedAt,
): EntityKnowledgeMemoryV1 {
  return {
    schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
    id,
    entityId,
    memoryType: 'news_event',
    title: `Title ${id}`,
    summary: `Summary ${id}`,
    body: `Body ${id}`,
    eventAt: observedAt,
    observedAt,
    confidence: 0.85,
    evidence: [{ evidenceId: `evidence-${id}` }],
    mentions: ['Example'],
    metrics: { score: 1 },
    context: { priority_class: 'P1' },
    media: { imageUrl: null, imageKind: null, attribution: null },
    provenance: {
      provider: 'research_gateway',
      sourceArea: 'articles',
      sourceType: 'news',
      sourceRefId: `signal-${id}`,
      researchPacketId: `packet-${id}`,
    },
    priorityClass: 'P1',
    createdAt,
    updatedAt: createdAt,
  }
}

function entityRow() {
  return {
    id: 'entity-1',
    slug: 'bitcoin',
    name: 'Bitcoin',
    type: 'asset',
    aliases: ['BTC'],
    summary: null,
    status: 'active',
    show_in_carousel: true,
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
  }
}

class ReadBuilder implements PromiseLike<{ data: unknown[], error: null }> {
  constructor(private readonly rows: unknown[]) {}
  select(): this { return this }
  in(): this { return this }
  eq(): this { return this }
  order(): this { return this }
  limit(): this { return this }
  then<TResult1 = { data: unknown[], error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown[], error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.rows, error: null }).then(onfulfilled ?? undefined)
  }
}

function database(tables: string[]): SupabaseClient {
  return {
    from(table: string) {
      tables.push(table)
      assert.notEqual(table, 'entity_memories')
      return new ReadBuilder(table === 'entities' ? [entityRow()] : [])
    },
  } as unknown as SupabaseClient
}

function pipelineStore(): PipelineStore {
  return {
    async findReviewedMemoryIds() { return new Set<string>() },
    async fetchPriorDraftsByEntity() { return new Map() },
  } as unknown as PipelineStore
}

test('editor draft Entity reads include and normalize carousel selection', () => {
  const base = {
    id: 'entity-1',
    slug: 'bitcoin',
    name: 'Bitcoin',
    type: 'asset',
    aliases: ['BTC'],
    summary: null,
    status: 'active',
    metadata: {},
  }

  assert.match(__testing.ENTITY_SELECT, /show_in_carousel/)
  assert.equal(__testing.normalizeEntity(base).show_in_carousel, false)
  assert.equal(__testing.normalizeEntity({ ...base, show_in_carousel: true }).show_in_carousel, true)
})

test('Editor hydrates recent and lane memories through Entity Knowledge with legacy field parity', async () => {
  const directTables: string[] = []
  const recentCalls: unknown[] = []
  const entityCalls: unknown[] = []
  const newerWrite = knowledgeMemory(
    'memory-new-write',
    'entity-1',
    '2026-08-20T00:00:00.000Z',
    '2026-08-26T12:00:00.000Z',
  )
  const olderWrite = knowledgeMemory(
    'memory-old-write',
    'entity-1',
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T12:00:00.000Z',
  )
  const reader: Pick<EntityKnowledgeReader, 'getRecentEntityMemories' | 'getEntityMemories'> = {
    async getRecentEntityMemories(input) {
      recentCalls.push(input)
      return {
        schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
        items: [olderWrite, newerWrite],
        nextCursor: null,
        hasMore: false,
      }
    },
    async getEntityMemories(input) {
      entityCalls.push(input)
      return {
        schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
        items: [olderWrite, newerWrite],
        nextCursor: null,
        hasMore: false,
      }
    },
  }
  const store = new SupabaseEditorDraftStore(database(directTables), pipelineStore(), reader)

  const bundles = await store.fetchBundles({
    batchSize: 1,
    recentMemoryLimit: 2,
    laneMemoryLimit: 2,
    priorDraftLimit: 2,
    publishedHistoryLimit: 2,
  })

  assert.deepEqual(recentCalls, [{ limit: 20 }])
  assert.deepEqual(entityCalls, [{ entityId: 'entity-1', limit: 2 }])
  assert.deepEqual(directTables, ['entities', 'entity_published_history'])
  assert.equal(bundles.length, 1)
  assert.deepEqual(bundles[0]?.newMemories.map((memory) => memory.id), ['memory-new-write', 'memory-old-write'])
  assert.deepEqual(bundles[0]?.memoryLane.map((memory) => memory.id), ['memory-new-write', 'memory-old-write'])
  assert.deepEqual(bundles[0]?.newMemories[0], {
    id: 'memory-new-write',
    entity_id: 'entity-1',
    source: 'research_gateway',
    source_area: 'articles',
    source_type: 'news',
    source_ref_id: 'signal-memory-new-write',
    source_research_id: 'packet-memory-new-write',
    memory_type: 'news_event',
    title: 'Title memory-new-write',
    summary: 'Summary memory-new-write',
    body: 'Body memory-new-write',
    event_at: '2026-08-20T00:00:00.000Z',
    observed_at: '2026-08-20T00:00:00.000Z',
    confidence: 0.85,
    evidence: [{ evidenceId: 'evidence-memory-new-write' }],
    mentions: ['Example'],
    metrics: { score: 1 },
    context: { priority_class: 'P1' },
    created_at: '2026-08-26T12:00:00.000Z',
    updated_at: '2026-08-26T12:00:00.000Z',
  })
})

test('Editor cursor-drains large configured windows with strict per-call bounds', async () => {
  const directTables: string[] = []
  const recentLimits: number[] = []
  const laneLimits: number[] = []
  const recent = Array.from({ length: 120 }, (_, index) => knowledgeMemory(`recent-${index + 1}`))
  const lane = Array.from({ length: 101 }, (_, index) => knowledgeMemory(`lane-${index + 1}`))
  const reader: Pick<EntityKnowledgeReader, 'getRecentEntityMemories' | 'getEntityMemories'> = {
    async getRecentEntityMemories(input) {
      recentLimits.push(input.limit)
      const offset = input.cursor ? 100 : 0
      const items = recent.slice(offset, offset + input.limit)
      return {
        schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
        items,
        nextCursor: offset === 0 ? 'recent-page-2' : null,
        hasMore: offset === 0,
      }
    },
    async getEntityMemories(input) {
      laneLimits.push(input.limit)
      const offset = input.cursor ? 100 : 0
      const items = lane.slice(offset, offset + input.limit)
      return {
        schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
        items,
        nextCursor: offset === 0 ? 'lane-page-2' : null,
        hasMore: offset === 0,
      }
    },
  }
  const store = new SupabaseEditorDraftStore(database(directTables), pipelineStore(), reader)

  const bundles = await store.fetchBundles({
    batchSize: 2,
    recentMemoryLimit: 6,
    laneMemoryLimit: 101,
    priorDraftLimit: 1,
    publishedHistoryLimit: 0,
  })

  assert.deepEqual(recentLimits, [100, 20])
  assert.deepEqual(laneLimits, [100, 1])
  assert.deepEqual(directTables, ['entities'])
  assert.equal(bundles[0]?.memoryLane.length, 101)
  assert.equal(bundles[0]?.newMemories.length, 6)
})

test('Editor fails closed at the aggregate knowledge request ceiling', async () => {
  let recentCalls = 0
  const reader: Pick<EntityKnowledgeReader, 'getRecentEntityMemories' | 'getEntityMemories'> = {
    async getRecentEntityMemories() {
      recentCalls += 1
      return {
        schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
        items: [knowledgeMemory(`extreme-${recentCalls}`)],
        nextCursor: `cursor-${recentCalls}`,
        hasMore: true,
      }
    },
    async getEntityMemories() { throw new Error('lane must not be reached') },
  }
  const store = new SupabaseEditorDraftStore(database([]), pipelineStore(), reader)

  await assert.rejects(store.fetchBundles({
    batchSize: 101,
    recentMemoryLimit: 101,
    laneMemoryLimit: 1,
    priorDraftLimit: 1,
    publishedHistoryLimit: 0,
  }), /exceeds 100 bounded requests/)
  assert.equal(recentCalls, 100)
})

test('Editor fails closed when a knowledge cursor repeats', async () => {
  let recentCalls = 0
  const reader: Pick<EntityKnowledgeReader, 'getRecentEntityMemories' | 'getEntityMemories'> = {
    async getRecentEntityMemories() {
      recentCalls += 1
      return {
        schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
        items: [knowledgeMemory(`repeat-${recentCalls}`)],
        nextCursor: 'same-cursor',
        hasMore: true,
      }
    },
    async getEntityMemories() { throw new Error('lane must not be reached') },
  }
  const store = new SupabaseEditorDraftStore(database([]), pipelineStore(), reader)

  await assert.rejects(store.fetchBundles({
    batchSize: 2,
    recentMemoryLimit: 2,
    laneMemoryLimit: 1,
    priorDraftLimit: 1,
    publishedHistoryLimit: 0,
  }), /cursor repeated/)
  assert.equal(recentCalls, 2)
})
