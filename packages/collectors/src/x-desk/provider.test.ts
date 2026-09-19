import assert from 'node:assert/strict'
import test from 'node:test'
import type { EntityKnowledgeMemoryV1 } from '../entity-manager/entity-knowledge-reader'
import { __xDeskProviderTesting, buildXDeskPrompt } from './provider'
import type { XDeskReviewInput } from './types'

function input(id = 'x_candidate'): XDeskReviewInput {
  const memory: EntityKnowledgeMemoryV1 = {
    schemaVersion: 'myboon.entity_knowledge.v1',
    id: 'memory-1',
    entityId: 'entity-1',
    memoryType: 'news_event',
    title: 'Protocol ships an upgrade',
    summary: 'The upgrade reduces settlement time.',
    body: null,
    eventAt: '2026-09-05T10:00:00.000Z',
    observedAt: '2026-09-05T10:01:00.000Z',
    confidence: 0.9,
    evidence: [{ url: 'https://example.com/story' }],
    mentions: [],
    metrics: {},
    context: {},
    media: { imageUrl: null, imageKind: null, attribution: null },
    provenance: {
      provider: 'news', sourceArea: 'feed', sourceType: 'news',
      sourceRefId: 'https://example.com/story', researchPacketId: 'packet-1',
    },
    priorityClass: 'P2',
    createdAt: '2026-09-05T10:02:00.000Z',
    updatedAt: '2026-09-05T10:02:00.000Z',
  }
  return {
    candidateId: id,
    entity: { id: 'entity-1', slug: 'protocol', name: 'Protocol', type: 'project', summary: null },
    memory,
  }
}

test('X desk validation requires one bounded decision per candidate', () => {
  const inputs = [input('x_one'), input('x_two')]
  const valid = __xDeskProviderTesting.decisionResponse({ decisions: [
    { candidateId: 'x_one', action: 'recommend', postText: 'Protocol just cut settlement time.', rationale: 'Material upgrade.', confidence: 0.9 },
    { candidateId: 'x_two', action: 'skip', postText: null, rationale: 'Duplicate angle.', confidence: 0.7 },
  ] }, inputs, 1)
  assert.equal(valid.valid, true)

  const tooMany = __xDeskProviderTesting.decisionResponse({ decisions: [
    { candidateId: 'x_one', action: 'recommend', postText: 'One', rationale: 'Useful.', confidence: 0.9 },
    { candidateId: 'x_two', action: 'recommend', postText: 'Two', rationale: 'Useful.', confidence: 0.9 },
  ] }, inputs, 1)
  assert.equal(tooMany.valid, false)
})

test('X desk prompt is news-focused and includes prior recommendations', async () => {
  const prompt = await buildXDeskPrompt([input()], ['Earlier post'], 2)
  assert.match(prompt, /standalone post on X/)
  assert.match(prompt, /Earlier post/)
  assert.match(prompt, /https:\/\/example\.com\/story/)
  assert.match(prompt, /"maxRecommendations": 2/)
})
