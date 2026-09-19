import assert from 'node:assert/strict'
import test from 'node:test'
import type { EntityKnowledgeMemoryV1 } from '../entity-manager/entity-knowledge-reader'
import { buildOnDemandResponse, requestedSuggestionCount } from './on-demand'
import type { XDeskRunResult, XDeskStoredCandidate } from './types'

const NOW = '2026-09-05T12:00:00.000Z'

function candidate(): XDeskStoredCandidate {
  const memory: EntityKnowledgeMemoryV1 = {
    schemaVersion: 'myboon.entity_knowledge.v1',
    id: 'memory-1',
    entityId: 'entity-1',
    memoryType: 'news_event',
    title: 'Protocol ships a useful upgrade',
    summary: 'The upgrade reduces settlement time.',
    body: null,
    eventAt: NOW,
    observedAt: NOW,
    confidence: 0.9,
    evidence: [{ url: 'https://www.cointribune.com/en/protocol-upgrade' }],
    mentions: [],
    metrics: {},
    context: {},
    media: { imageUrl: null, imageKind: null, attribution: null },
    provenance: {
      provider: 'news',
      sourceArea: 'feed',
      sourceType: 'article',
      sourceRefId: 'https://www.cointribune.com/en/protocol-upgrade',
      researchPacketId: 'packet-1',
    },
    priorityClass: 'P1',
    createdAt: NOW,
    updatedAt: NOW,
  }
  return {
    id: 'x_123',
    memoryId: memory.id,
    memoryUpdatedAt: NOW,
    changedAt: NOW,
    entityId: memory.entityId,
    entitySlug: 'protocol',
    entityName: 'Protocol',
    status: 'ready',
    postText: 'Protocol just cut settlement time with its latest upgrade.',
    rationale: 'Specific and timely.',
    confidence: 0.9,
    attemptCount: 1,
    lastError: null,
    memory,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

const run: XDeskRunResult = {
  observedAt: NOW,
  changesScanned: 1,
  newsChangesQueued: 1,
  candidatesReviewed: 1,
  recommended: 1,
  skipped: 0,
  failed: 0,
  intakeHasMore: false,
  recommendations: [],
}

test('on-demand suggestion count defaults to five and rejects larger batches', () => {
  assert.equal(requestedSuggestionCount(undefined), 5)
  assert.equal(requestedSuggestionCount('3'), 3)
  assert.throws(() => requestedSuggestionCount('6'), /1 to 5/)
  assert.throws(() => requestedSuggestionCount('five'), /1 to 5/)
})

test('on-demand response includes a plain publisher label and no source URL', () => {
  const response = buildOnDemandResponse({
    requested: 5,
    lookbackStart: '2026-09-04T12:00:00.000Z',
    run,
    candidates: [candidate()],
  })
  assert.equal(response.returned, 1)
  assert.equal(response.suggestions[0]?.source, 'Cointribune')
  assert.equal(response.suggestions[0]?.candidateId, 'x_123')
  assert.doesNotMatch(JSON.stringify(response), /https?:\/\//)
  assert.equal(response.publication, 'human_review_only')
})
