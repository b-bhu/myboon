import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isBannedEntitySlug,
  isNearDuplicate,
  nearestEntities,
  normalizeEntityType,
  shortlistForPacket,
} from './canon'
import type { CanonEntity } from './canon'
import type { ResearchPacket } from './types'

function entity(overrides: Partial<CanonEntity> & { slug: string }): CanonEntity {
  return {
    id: `id-${overrides.slug}`,
    name: overrides.slug,
    type: 'topic',
    aliases: [],
    summary: null,
    ...overrides,
  }
}

const CATALOG: CanonEntity[] = [
  entity({ slug: 'us-federal-reserve', name: 'Federal Reserve', type: 'organization', aliases: ['Fed', 'FOMC', 'Fed meeting', 'rate decision'] }),
  entity({ slug: 'bitcoin', name: 'Bitcoin', type: 'asset', aliases: ['BTC'] }),
  entity({ slug: 'nvidia', name: 'NVIDIA', type: 'organization', aliases: ['NVDA'] }),
  entity({ slug: 'china-taiwan', name: 'China-Taiwan tensions', type: 'topic', aliases: ['Taiwan strait'] }),
  entity({ slug: 'jerome-powell', name: 'Jerome Powell', type: 'person', aliases: ['Powell'] }),
  entity({ slug: 'ecuador', name: 'Ecuador', type: 'country' }),
]

function packet(overrides: Partial<ResearchPacket> = {}): ResearchPacket {
  return {
    id: 'p1',
    source: 'news',
    sourceArea: 'crypto',
    sourceResearchId: 'r1',
    sourceType: 'article',
    sourceRefId: 'ref-1',
    title: 'FOMC holds rates in a 9-3 vote',
    summary: 'The Federal Reserve held rates; Powell cited inflation risks.',
    body: '',
    observedAt: '2026-07-31T00:00:00.000Z',
    evidence: [],
    metrics: {},
    context: {},
    ...overrides,
  }
}

test('shortlist ranks entities whose aliases appear in the packet text', () => {
  const shortlist = shortlistForPacket(CATALOG, packet())
  const slugs = shortlist.map((entity) => entity.slug)

  assert.equal(slugs[0], 'us-federal-reserve', 'FOMC alias + Federal Reserve name should rank first')
  assert.ok(slugs.includes('jerome-powell'), 'Powell alias matches')
  assert.ok(!slugs.includes('ecuador'), 'unrelated entities are excluded')
  assert.ok(!slugs.includes('china-taiwan'))
})

test('shortlist matches single-word aliases on word boundaries, not substrings', () => {
  const catalog = [entity({ slug: 'us-economy', name: 'US economy', aliases: ['US'] })]
  const noMatch = shortlistForPacket(catalog, packet({ title: 'Confusing analysis', summary: 'Plus more.' }))
  assert.equal(noMatch.length, 0, '"US" must not match inside "confUSing" or "plUS"')

  const match = shortlistForPacket(catalog, packet({ title: 'US retail data lands', summary: '' }))
  assert.equal(match.length, 1)
})

test('shortlist respects the limit', () => {
  const catalog = Array.from({ length: 40 }, (_, i) => entity({ slug: `coin-${i}`, name: `Bitcoin fork ${i}`, aliases: ['Bitcoin'] }))
  const shortlist = shortlistForPacket(catalog, packet({ title: 'Bitcoin news', summary: '' }), 10)
  assert.equal(shortlist.length, 10)
})

test('nearestEntities ranks shared-token entities for a proposed new entity', () => {
  const nearest = nearestEntities(CATALOG, { slug: 'nvidia-h100', name: 'NVIDIA H100', aliases: ['H100'] }, 3)
  assert.equal(nearest[0]?.slug, 'nvidia')
})

test('isNearDuplicate catches granular variants of an existing entity', () => {
  const chinaTaiwanClash = { slug: 'china-taiwan-military-clash-2027', name: 'China Taiwan military clash 2027', aliases: [] }
  assert.equal(isNearDuplicate(chinaTaiwanClash, CATALOG.find((e) => e.slug === 'china-taiwan')!), true)

  const nvidiaH100 = { slug: 'nvidia-h100', name: 'NVIDIA H100', aliases: [] }
  assert.equal(isNearDuplicate(nvidiaH100, CATALOG.find((e) => e.slug === 'nvidia')!), true)
})

test('isNearDuplicate does NOT conflate genuinely different entities', () => {
  const unitedStates = { slug: 'united-states', name: 'United States', aliases: ['USA'] }
  assert.equal(isNearDuplicate(unitedStates, CATALOG.find((e) => e.slug === 'us-federal-reserve')!), false)
  assert.equal(isNearDuplicate({ slug: 'apple', name: 'Apple', aliases: [] }, CATALOG.find((e) => e.slug === 'nvidia')!), false)
})

test('normalizeEntityType collapses the historical type zoo into the fixed vocabulary', () => {
  assert.equal(normalizeEntityType('organization'), 'organization')
  assert.equal(normalizeEntityType('company'), 'organization')
  assert.equal(normalizeEntityType('nation'), 'country')
  assert.equal(normalizeEntityType('currency'), 'asset')
  assert.equal(normalizeEntityType('index'), 'asset')
  assert.equal(normalizeEntityType('legislation'), 'regulation')
  assert.equal(normalizeEntityType('ai_model'), 'product')
  assert.equal(normalizeEntityType('geopolitical_topic'), 'topic')
  assert.equal(normalizeEntityType('completely-made-up'), 'topic')
})

test('source objects are banned as entities', () => {
  assert.equal(isBannedEntitySlug('polymarket'), true)
  assert.equal(isBannedEntitySlug('telegram'), false, 'real organizations that happen to be platforms stay allowed')
})
