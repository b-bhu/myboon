import assert from 'node:assert/strict'
import test from 'node:test'
import { __testing } from './extractor'
import { normalizeExtraction } from './normalization'
import type { ResearchPacket } from './types'

const packet: ResearchPacket = {
  id: 'polymarket:markets:research-1',
  source: 'polymarket',
  sourceArea: 'markets',
  sourceResearchId: 'research-1',
  sourceType: 'market_signal',
  sourceRefId: 'will-fed-cut-rates',
  title: 'Will Fed cut rates?',
  summary: 'Fed odds moved.',
  body: 'Fed odds moved.',
  observedAt: '2026-06-22T00:00:00.000Z',
  evidence: [],
  metrics: {},
  context: {},
}

test('normalizeExtraction normalizes aliases, slugs, item types, and drops orphan memory items', () => {
  const normalized = normalizeExtraction({
    primary_entities: [{
      name: 'Federal Reserve',
      type: 'organization',
      aliases: ['Fed', 'Federal Reserve', 'fed'],
      metadata: { region: 'US' },
    }],
    memories: [{
      entity_slug: 'federal-reserve',
      memory_type: 'unsupported',
      title: 'Rate cut odds moved',
      summary: 'Traders repriced\nrate cut odds.',
      body: 'Detailed source-native observations remain here.',
      evidence: [{ url: 'https://example.com' }],
      metrics: { previous: 0.4, current: 0.6 },
      context: { source_title: packet.title },
      mentions: ['FOMC', 'fomc'],
    }, {
      entity_slug: 'missing',
      memory_type: 'research_note',
      title: 'Dropped',
      summary: 'No entity candidate.',
    }],
  }, packet)

  assert.equal(normalized.primaryEntities.length, 1)
  assert.equal(normalized.primaryEntities[0].slug, 'federal-reserve')
  assert.deepEqual(normalized.primaryEntities[0].aliases, ['Fed', 'Federal Reserve'])
  assert.equal(normalized.memories.length, 1)
  assert.equal(normalized.memories[0].memoryType, 'market_signal')
  assert.equal(normalized.memories[0].summary, 'Traders repriced rate cut odds.')
  assert.equal(normalized.memories[0].body, 'Detailed source-native observations remain here.')
  assert.deepEqual(normalized.memories[0].evidence, [{ url: 'https://example.com' }])
  assert.deepEqual(normalized.memories[0].metrics, { previous: 0.4, current: 0.6 })
  assert.deepEqual(normalized.memories[0].context, { source_title: packet.title })
  assert.deepEqual(normalized.memories[0].mentions, ['FOMC'])
  assert.deepEqual(normalized.memories[0].reconciliation, {
    action: 'new_story',
    existingMemoryId: null,
    confidence: undefined,
    reason: '',
  })
})

test('normalizeExtraction preserves a bounded story-reconciliation decision', () => {
  const normalized = normalizeExtraction({
    primaryEntities: [{ name: 'CLARITY Act', type: 'regulation', slug: 'clarity-act' }],
    memories: [{
      entitySlug: 'clarity-act',
      memoryType: 'news_event',
      title: 'CLARITY Act odds decline',
      summary: 'Passage odds declined amid political divisions.',
      reconciliation: {
        action: 'update_existing_story',
        existing_memory_id: 'memory-7',
        confidence: 1.4,
        reason: 'Same passage-odds development with added regulatory context.',
      },
    }],
  }, { ...packet, source: 'news', sourceType: 'article' })

  assert.deepEqual(normalized.memories[0].reconciliation, {
    action: 'update_existing_story',
    existingMemoryId: 'memory-7',
    confidence: 1,
    reason: 'Same passage-odds development with added regulatory context.',
  })
})

test('shared extraction prompt requires neutral standalone summaries and keeps research detail separate', () => {
  const prompt = __testing.buildPrompt(packet)

  assert.match(prompt, /concise, neutral, standalone one- or two-line description/)
  assert.match(prompt, /reader who cannot see the research packet/)
  assert.match(prompt, /without source\/pipeline framing/)
  assert.match(prompt, /Keep research detail in body, evidence, metrics, and context/)
  assert.doesNotMatch(prompt, /what source produced it/)
})
