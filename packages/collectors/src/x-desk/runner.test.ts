import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  EntityKnowledgeMemoryV1,
  EntityMemoryChangePage,
} from '../entity-manager/entity-knowledge-reader'
import { ENTITY_MEMORY_CHANGES_START_CURSOR } from '../entity-manager/entity-knowledge-reader'
import { isNewsMemory, runXDesk, xDeskCliConfig } from './runner'
import { XDeskStore } from './store'
import type { XDeskDecision, XDeskProvider, XDeskSource } from './types'

function memory(id: string, sourceType: string): EntityKnowledgeMemoryV1 {
  return {
    schemaVersion: 'myboon.entity_knowledge.v1',
    id,
    entityId: `entity-${id}`,
    memoryType: 'news_event',
    title: `Title ${id}`,
    summary: `Summary ${id}`,
    body: null,
    eventAt: '2026-09-05T10:00:00.000Z',
    observedAt: '2026-09-05T10:01:00.000Z',
    confidence: 0.8,
    evidence: [],
    mentions: [],
    metrics: {},
    context: {},
    media: { imageUrl: null, imageKind: null, attribution: null },
    provenance: {
      provider: sourceType, sourceArea: 'feed', sourceType,
      sourceRefId: `ref-${id}`, researchPacketId: `packet-${id}`,
    },
    priorityClass: 'P2',
    createdAt: '2026-09-05T10:02:00.000Z',
    updatedAt: '2026-09-05T10:02:00.000Z',
  }
}

class FakeSource implements XDeskSource {
  calls = 0

  async getChanges(_afterCursor: string, _limit: number): Promise<EntityMemoryChangePage> {
    this.calls += 1
    if (this.calls > 1) return { schemaVersion: 'myboon.entity_knowledge.v1', changes: [], nextCursor: 'cursor-2', hasMore: false }
    return {
      schemaVersion: 'myboon.entity_knowledge.v1',
      changes: [memory('news-1', 'news'), memory('poly-1', 'polymarket')].map((item) => ({
        changeType: 'upsert' as const,
        changedAt: item.updatedAt,
        cursor: `cursor-${item.id}`,
        memory: item,
      })),
      nextCursor: 'cursor-1',
      hasMore: false,
    }
  }

  async getEntities(ids: string[]) {
    return new Map(ids.map((id) => [id, { id, slug: id, name: `Name ${id}`, type: 'topic', summary: null }]))
  }
}

class RecommendingProvider implements XDeskProvider {
  async decide(inputs: Array<{ candidateId: string }>): Promise<XDeskDecision[]> {
    return inputs.map((input) => ({
      candidateId: input.candidateId,
      action: 'recommend',
      postText: 'A useful, review-only X post.',
      rationale: 'Timely and specific.',
      confidence: 0.85,
    }))
  }
}

test('X desk queues only news changes and creates review-only recommendations', async () => {
  const store = new XDeskStore(':memory:')
  try {
    const result = await runXDesk({
      source: new FakeSource(),
      store,
      provider: new RecommendingProvider(),
      now: '2026-09-05T12:00:00.000Z',
      initialLookbackHours: 24,
      batchSize: 10,
      maxRecommendations: 3,
    })
    assert.equal(result.changesScanned, 2)
    assert.equal(result.newsChangesQueued, 1)
    assert.equal(result.recommended, 1)
    assert.equal(store.list('ready', 10).length, 1)
    assert.equal(store.list('ready', 10)[0]?.memory.provenance.sourceType, 'news')
  } finally {
    store.close()
  }
})

test('provider failures enter a bounded retry state without losing intake', async () => {
  const store = new XDeskStore(':memory:')
  const provider: XDeskProvider = { async decide() { throw new Error('provider unavailable') } }
  try {
    const result = await runXDesk({
      source: new FakeSource(), store, provider,
      now: '2026-09-05T12:00:00.000Z', maxAttempts: 3,
    })
    assert.equal(result.failed, 1)
    const retries = store.list('retry_wait', 10)
    assert.equal(retries.length, 1)
    assert.equal(retries[0]?.attemptCount, 1)
    assert.match(retries[0]?.lastError ?? '', /provider unavailable/)
  } finally {
    store.close()
  }
})

test('CLI defaults to a five-post, 24-hour on-demand review', () => {
  const config = xDeskCliConfig({} as NodeJS.ProcessEnv)
  assert.equal(config.maxRecommendations, 5)
  assert.equal(config.initialLookbackHours, 24)
})

test('first initialization starts the change feed at the lookback boundary', () => {
  const store = new XDeskStore(':memory:')
  try {
    assert.equal(store.cursor(), ENTITY_MEMORY_CHANGES_START_CURSOR)
    store.initialCutoff('2026-09-04T12:00:00.000Z', '2026-09-05T12:00:00.000Z')
    assert.notEqual(store.cursor(), ENTITY_MEMORY_CHANGES_START_CURSOR)
    const decoded = JSON.parse(Buffer.from(store.cursor(), 'base64url').toString('utf8'))
    assert.equal(decoded.at, '2026-09-04T12:00:00.000Z')
  } finally {
    store.close()
  }
})

test('news gate accepts the durable article label only from the news provider', () => {
  const article = memory('article-1', 'article')
  article.provenance.provider = 'news'
  const market = memory('market-1', 'article')
  market.provenance.provider = 'polymarket'
  const change = (item: EntityKnowledgeMemoryV1) => ({
    changeType: 'upsert' as const, changedAt: item.updatedAt, cursor: 'cursor', memory: item,
  })
  assert.equal(isNewsMemory(change(article)), true)
  assert.equal(isNewsMemory(change(market)), false)
})
