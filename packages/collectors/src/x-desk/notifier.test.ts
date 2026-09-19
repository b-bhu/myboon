import assert from 'node:assert/strict'
import test from 'node:test'
import type { EntityKnowledgeMemoryV1 } from '../entity-manager/entity-knowledge-reader'
import {
  deliverXDeskNotifications,
  formatXDeskDiscordMessage,
  sourceLabelFromUrl,
  type XDeskNotificationConfig,
  type XDeskNotifier,
} from './notifier'
import { XDeskStore } from './store'

const NOW = '2026-09-05T12:00:00.000Z'
const TARGET = 'discord:hermes'

function memory(id: string): EntityKnowledgeMemoryV1 {
  return {
    schemaVersion: 'myboon.entity_knowledge.v1',
    id,
    entityId: `entity-${id}`,
    memoryType: 'news_event',
    title: `Title ${id}`,
    summary: `Summary ${id}`,
    body: null,
    eventAt: NOW,
    observedAt: NOW,
    confidence: 0.8,
    evidence: [{ url: `https://example.com/${id}` }],
    mentions: [],
    metrics: {},
    context: {},
    media: { imageUrl: null, imageKind: null, attribution: null },
    provenance: {
      provider: 'news', sourceArea: 'feed', sourceType: 'article',
      sourceRefId: `ref-${id}`, researchPacketId: `packet-${id}`,
    },
    priorityClass: 'P1',
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function seedReady(store: XDeskStore, ids: string[]): void {
  const changes = ids.map((id) => ({
    changeType: 'upsert' as const,
    changedAt: NOW,
    cursor: `cursor-${id}`,
    memory: memory(id),
  }))
  store.enqueuePage(changes, 'next-cursor', NOW)
  const candidates = store.fetchWork(ids.length, NOW, 3)
  store.recordDecisions(candidates.map((candidate) => ({
    candidateId: candidate.id,
    action: 'recommend' as const,
    postText: `Potential post ${candidate.memory.id}`,
    rationale: 'Timely and specific.',
    confidence: 0.85,
  })), new Map(candidates.map((candidate) => [candidate.entityId, {
    id: candidate.entityId,
    slug: candidate.entityId,
    name: `Entity ${candidate.memory.id}`,
    type: 'topic',
    summary: null,
  }])), candidates, NOW)
}

function config(overrides: Partial<XDeskNotificationConfig> = {}): XDeskNotificationConfig {
  return {
    target: TARGET,
    timeoutMs: 1000,
    batchSize: 3,
    retryDelayMs: 600_000,
    maxAttempts: 3,
    ...overrides,
  }
}

test('Discord formatter gives copyable drafts and states that nothing was auto-posted', () => {
  const store = new XDeskStore(':memory:')
  try {
    seedReady(store, ['one', 'two'])
    const message = formatXDeskDiscordMessage(store.list('ready', 10))
    assert.match(message, /X Desk found 2 potential X posts/)
    assert.match(message, /Potential post one/)
    assert.match(message, /Ref: x_[a-f0-9]{32}/)
    assert.match(message, /source- Example/)
    assert.doesNotMatch(message, /https?:\/\//)
    assert.match(message, /nothing was posted automatically/)
    assert.ok(message.length <= 1_900)
  } finally {
    store.close()
  }
})

test('source labels are human names rather than links', () => {
  assert.equal(sourceLabelFromUrl('https://www.cointribune.com/en/story'), 'Cointribune')
  assert.equal(sourceLabelFromUrl('https://cryptobriefing.com/story'), 'Crypto Briefing')
  assert.equal(sourceLabelFromUrl(null), 'News feed')
})

test('successful Discord delivery is durably deduplicated', async () => {
  const store = new XDeskStore(':memory:')
  const batches: string[][] = []
  const notifier: XDeskNotifier = {
    async send(candidates) { batches.push(candidates.map((candidate) => candidate.id)) },
  }
  try {
    seedReady(store, ['one', 'two'])
    const first = await deliverXDeskNotifications({ store, notifier, config: config(), now: NOW })
    const second = await deliverXDeskNotifications({ store, notifier, config: config(), now: NOW })
    assert.deepEqual(first, { attempted: 2, sent: 2, failed: 0, error: null })
    assert.deepEqual(second, { attempted: 0, sent: 0, failed: 0, error: null })
    assert.equal(batches.length, 1)
  } finally {
    store.close()
  }
})

test('failed Discord delivery waits before a bounded retry', async () => {
  const store = new XDeskStore(':memory:')
  let calls = 0
  const notifier: XDeskNotifier = {
    async send() { calls += 1; throw new Error('Discord unavailable') },
  }
  try {
    seedReady(store, ['one'])
    const failed = await deliverXDeskNotifications({ store, notifier, config: config(), now: NOW })
    const early = await deliverXDeskNotifications({
      store, notifier, config: config(), now: '2026-09-05T12:05:00.000Z',
    })
    assert.deepEqual(failed, {
      attempted: 1, sent: 0, failed: 1,
      error: 'Hermes notification failed: Discord unavailable',
    })
    assert.equal(early.attempted, 0)
    assert.equal(calls, 1)
  } finally {
    store.close()
  }
})

test('correcting a notification target immediately recovers unsent work', async () => {
  const store = new XDeskStore(':memory:')
  const delivered: string[][] = []
  const failing: XDeskNotifier = { async send() { throw new Error('wrong target') } }
  const working: XDeskNotifier = {
    async send(candidates) { delivered.push(candidates.map((candidate) => candidate.id)) },
  }
  try {
    seedReady(store, ['one'])
    await deliverXDeskNotifications({ store, notifier: failing, config: config(), now: NOW })
    const recovered = await deliverXDeskNotifications({
      store,
      notifier: working,
      config: config({ target: 'discord:1530185853920350368' }),
      now: '2026-09-05T12:01:00.000Z',
    })
    assert.equal(recovered.sent, 1)
    assert.equal(delivered.length, 1)
  } finally {
    store.close()
  }
})
