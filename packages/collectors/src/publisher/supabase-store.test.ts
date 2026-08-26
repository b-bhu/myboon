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
import { SupabasePublisherStore } from './supabase-store'

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
