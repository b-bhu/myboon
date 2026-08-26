import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  EntityKnowledgeMemoryV1,
  EntityKnowledgeReader,
  GetEntityMemoriesInput,
  GetEntityMemoryChangesInput,
  GetRecentEntityMemoriesInput,
} from '@myboon/collectors/entity-manager'
import entityManager from '@myboon/collectors/entity-manager'
import { createEntityKnowledgeRoutes } from './entity-knowledge.js'

const { ENTITY_KNOWLEDGE_SCHEMA_VERSION } = entityManager
const token = 'entity-knowledge-test-token-000000000000'

const memory: EntityKnowledgeMemoryV1 = {
  schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
  id: 'mem-1',
  entityId: '00000000-0000-4000-8000-000000000001',
  memoryType: 'news_event',
  title: 'CPI cools',
  summary: 'US CPI cooled in July.',
  body: 'Public body',
  eventAt: '2026-08-26T08:00:00.000Z',
  observedAt: '2026-08-26T08:01:00.000Z',
  confidence: 0.94,
  evidence: [{ privateUrl: 'https://internal.example/evidence' }],
  mentions: ['US CPI'],
  metrics: { actual: 2.7 },
  context: { privateReasoning: 'never expose this' },
  media: { imageUrl: 'https://cdn.example/cpi.jpg', imageKind: 'content', attribution: 'BLS' },
  provenance: {
    provider: 'tokens_xyz', sourceArea: 'macro', sourceType: 'news', sourceRefId: 'source-1', researchPacketId: 'packet-1',
  },
  priorityClass: 'P0',
  createdAt: '2026-08-26T08:02:00.000Z',
  updatedAt: '2026-08-26T08:03:00.000Z',
}

class FakeReader implements EntityKnowledgeReader {
  entityInput: GetEntityMemoriesInput | null = null
  recentInput: GetRecentEntityMemoriesInput | null = null
  changesInput: GetEntityMemoryChangesInput | null = null

  async getEntityMemories(input: GetEntityMemoriesInput) {
    this.entityInput = input
    return { schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION, items: [memory], nextCursor: 'next', hasMore: true }
  }
  async getRecentEntityMemories(input: GetRecentEntityMemoriesInput) {
    this.recentInput = input
    return { schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION, items: [memory], nextCursor: null, hasMore: false }
  }
  async getEntityMemoryChanges(input: GetEntityMemoryChangesInput) {
    this.changesInput = input
    return {
      schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
      changes: [{ changeType: 'upsert' as const, changedAt: memory.updatedAt, cursor: 'change-1', memory }],
      nextCursor: 'change-1',
      hasMore: false,
    }
  }
}

function request(reader: EntityKnowledgeReader, path: string, authorization = `Bearer ${token}`) {
  return createEntityKnowledgeRoutes({ reader, internalToken: token }).request(path, {
    headers: { Authorization: authorization },
  })
}

test('recent knowledge is versioned, filtered, and strips private internals', async () => {
  const reader = new FakeReader()
  const response = await request(reader,
    '/recent?limit=5&since=2026-08-26T00:00:00Z&priority=P0&priority=P1',
  )
  assert.equal(response.status, 200)
  assert.deepEqual(reader.recentInput, {
    limit: 5,
    since: '2026-08-26T00:00:00.000Z',
    priorityClasses: ['P0', 'P1'],
  })
  const body = await response.json() as { items: Array<Record<string, unknown>> }
  assert.equal(body.items[0]?.summary, memory.summary)
  assert.equal('context' in body.items[0]!, false)
  assert.equal('evidence' in body.items[0]!, false)
  assert.equal('provenance' in body.items[0]!, false)
})

test('entity timeline delegates cursor and memory filters', async () => {
  const reader = new FakeReader()
  const response = await request(reader,
    `/entities/${memory.entityId}/memories?limit=10&cursor=opaque&memoryType=news_event,metric_change`,
  )
  assert.equal(response.status, 200)
  assert.deepEqual(reader.entityInput, {
    entityId: memory.entityId,
    limit: 10,
    cursor: 'opaque',
    memoryTypes: ['news_event', 'metric_change'],
  })
})

test('changes use the reader start cursor by default and expose an allowlisted memory', async () => {
  const reader = new FakeReader()
  const response = await request(reader, '/changes?limit=2')
  assert.equal(response.status, 200)
  assert.equal(reader.changesInput?.limit, 2)
  assert.ok(reader.changesInput?.afterCursor)
  const body = await response.json() as { changes: Array<{ memory: Record<string, unknown> }> }
  assert.equal(body.changes[0]?.memory.title, memory.title)
  assert.equal('context' in body.changes[0]!.memory, false)
})

test('invalid filters fail closed before calling the reader', async () => {
  const reader = new FakeReader()
  const response = await request(reader, '/recent?priority=P9')
  assert.equal(response.status, 400)
  assert.equal(reader.recentInput, null)
})

test('knowledge endpoints fail closed without the internal bearer token', async () => {
  const reader = new FakeReader()
  const response = await request(reader, '/recent', '')
  assert.equal(response.status, 401)
  assert.equal(reader.recentInput, null)
})
