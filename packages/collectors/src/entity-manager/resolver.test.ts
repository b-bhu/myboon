import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanonEntity } from './canon'
import { __testing, writeExtraction } from './resolver'
import { InMemoryEntityMemoryStore } from './test-helpers'
import type {
  EntityMemoryExtraction,
  EntityMemoryInput,
  EntityMemoryRecord,
  ExtractionProvider,
  ResearchPacket,
} from './types'

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
  eventAt: '2026-06-21T00:00:00.000Z',
  evidence: [],
  metrics: {},
  context: {},
}

function provider(extraction: EntityMemoryExtraction): ExtractionProvider {
  return {
    async extract() {
      return extraction
    },
  }
}

function reconciliationMemory(overrides: Partial<EntityMemoryRecord> = {}): EntityMemoryRecord {
  return {
    id: 'memory-recent',
    entity_id: 'entity-bitcoin',
    source: 'news',
    source_area: 'news_feed:articles',
    source_type: 'article',
    source_ref_id: 'source-1',
    source_research_id: 'research-existing',
    memory_type: 'news_event',
    title: 'Existing story',
    summary: 'Existing story summary.',
    body: 'Existing story body.',
    event_at: '2026-08-16T09:00:00.000Z',
    observed_at: '2026-08-16T10:00:00.000Z',
    confidence: 0.8,
    evidence: [],
    mentions: [],
    metrics: {},
    context: {},
    ...overrides,
  }
}

function incomingReconciliationMemory(overrides: Partial<EntityMemoryInput> = {}): EntityMemoryInput {
  return {
    entity_id: 'entity-bitcoin',
    source: 'news',
    source_area: 'news_feed:articles',
    source_type: 'article',
    source_ref_id: 'source-2',
    source_research_id: 'research-incoming',
    memory_type: 'news_event',
    title: 'Incoming story',
    summary: 'Incoming story summary.',
    body: 'Incoming story body.',
    event_at: '2026-08-16T10:30:00.000Z',
    observed_at: '2026-08-16T11:00:00.000Z',
    confidence: 0.9,
    evidence: [],
    mentions: [],
    metrics: {},
    context: {},
    ...overrides,
  }
}

test('writeExtraction creates entities and writes memory items without a source_marker row', async () => {
  const store = new InMemoryEntityMemoryStore()
  const result = await writeExtraction(store, packet, provider({
    primaryEntities: [{
      name: 'Federal Reserve',
      type: 'organization',
      slug: 'federal-reserve',
      aliases: ['Fed'],
      summary: 'US central bank.',
    }],
    memories: [{
      entitySlug: 'federal-reserve',
      memoryType: 'market_signal',
      title: 'Rate cut odds moved',
      summary: 'Research noted a repricing in rate cut odds.',
      context: { market: packet.title },
      evidence: [{ url: 'https://example.com' }],
    }],
  }))

  assert.equal(result.entitiesCreated, 1)
  // entity_memories forbids memory_type = 'source_marker' post-migration, so
  // writeExtraction no longer writes a processed marker - only the real
  // memory item survives.
  assert.equal(result.memoriesWritten, 1)
  assert.equal(result.markerStatus, 'processed')
  assert.equal(store.entities.some((entity) => entity.slug === 'federal-reserve'), true)
  assert.equal(store.entities[0].show_in_carousel, false)
  assert.equal(store.memories.some((memory) => memory.memory_type === 'source_marker'), false)
})

test('writeExtraction is idempotent for the same packet and memory item keys', async () => {
  const store = new InMemoryEntityMemoryStore()
  const extraction: EntityMemoryExtraction = {
    primaryEntities: [{
      name: 'Federal Reserve',
      type: 'organization',
      slug: 'federal-reserve',
      aliases: ['Fed'],
    }],
    memories: [{
      entitySlug: 'federal-reserve',
      memoryType: 'research_note',
      title: 'Rate cut odds moved',
      summary: 'Research noted a repricing in rate cut odds.',
    }],
  }

  const first = await writeExtraction(store, packet, provider(extraction))
  const second = await writeExtraction(store, packet, provider(extraction))

  assert.equal(first.memoriesWritten, 1)
  assert.equal(second.memoriesWritten, 0)
  assert.equal(store.memories.length, 1)
})

test('writeExtraction reuses entities by alias and merges aliases', async () => {
  const store = new InMemoryEntityMemoryStore()
  await store.createEntities([{
    slug: 'federal-reserve',
    name: 'Federal Reserve',
    type: 'organization',
    aliases: ['Federal Reserve'],
    summary: null,
    status: 'active',
    metadata: {},
  }])

  const result = await writeExtraction(store, packet, provider({
    primaryEntities: [{
      name: 'Fed',
      type: 'organization',
      slug: 'fed',
      aliases: ['Federal Reserve', 'FOMC'],
      summary: 'US central bank.',
    }],
    memories: [{
      entitySlug: 'fed',
      memoryType: 'research_note',
      title: 'FOMC evidence',
      summary: 'Evidence mentions the FOMC.',
    }],
  }))

  assert.equal(result.entitiesCreated, 0)
  assert.equal(result.entitiesReused, 1)
  const entity = store.entities.find((item) => item.slug === 'federal-reserve')
  assert.ok(entity)
  assert.deepEqual(entity.aliases, ['Federal Reserve', 'Fed', 'FOMC'])
})

test('writeExtraction preserves carousel selection while reusing and enriching an entity', async () => {
  const store = new InMemoryEntityMemoryStore()
  const [selected] = await store.createEntities([{
    slug: 'bitcoin',
    name: 'Bitcoin',
    type: 'asset',
    aliases: ['Bitcoin'],
    summary: null,
    status: 'active',
    metadata: {},
  }])
  await store.updateEntity({ ...selected, show_in_carousel: true })

  await writeExtraction(store, packet, provider({
    primaryEntities: [{
      name: 'Bitcoin',
      type: 'asset',
      slug: 'bitcoin',
      aliases: ['BTC'],
      summary: 'A decentralized cryptocurrency.',
    }],
    memories: [{
      entitySlug: 'bitcoin',
      memoryType: 'market_signal',
      title: 'Bitcoin market moved',
      summary: 'Bitcoin market odds moved.',
    }],
  }))

  assert.equal(store.entities[0].show_in_carousel, true)
  assert.deepEqual(store.entities[0].aliases, ['Bitcoin', 'BTC'])
})

test('writeExtraction consolidates a same-window Polymarket market_signal into the existing entity memory instead of inserting a new row', async () => {
  const store = new InMemoryEntityMemoryStore()
  const first = await writeExtraction(store, {
    ...packet,
    sourceResearchId: 'research-wti-60',
    context: { candidate: { tag_slug: 'commodities' } },
  }, provider({
    primaryEntities: [{ name: 'Crude Oil (WTI)', type: 'asset', slug: 'crude-oil-wti', aliases: ['WTI'] }],
    memories: [{
      entitySlug: 'crude-oil-wti',
      memoryType: 'market_signal',
      title: 'WTI hit $60 low',
      summary: 'WTI $60 low odds moved from 41.5% to 22.5%.',
      evidence: [{ url: 'https://polymarket.com/market/wti-60-low' }],
      mentions: ['Polymarket'],
    }],
  }))
  assert.equal(first.entitiesCreated, 1)
  assert.equal(first.memoriesConsolidated, 0)

  const second = await writeExtraction(store, {
    ...packet,
    sourceResearchId: 'research-wti-80',
    observedAt: new Date(Date.parse(packet.observedAt) + 3_600_000).toISOString(),
    context: { candidate: { tag_slug: 'commodities' } },
  }, provider({
    primaryEntities: [{ name: 'Crude Oil (WTI)', type: 'asset', slug: 'crude-oil-wti', aliases: ['WTI'] }],
    memories: [{
      entitySlug: 'crude-oil-wti',
      memoryType: 'market_signal',
      title: 'WTI hit $80 high',
      summary: 'WTI $80 high odds moved from 19% to 9%.',
      evidence: [{ url: 'https://polymarket.com/market/wti-80-high' }],
      mentions: ['Polymarket'],
    }],
  }))

  assert.equal(second.entitiesCreated, 0)
  assert.equal(second.memoriesConsolidated, 1)
  const marketSignals = store.memories.filter((memory) => memory.memory_type === 'market_signal')
  assert.equal(marketSignals.length, 1, 'the second observation should fold into the first row, not add a new one')
  assert.equal(marketSignals[0].summary, 'WTI $80 high odds moved from 19% to 9%.')
  assert.equal(marketSignals[0].context.consolidated_observation_count, 2)
  assert.deepEqual(marketSignals[0].evidence, [
    { url: 'https://polymarket.com/market/wti-60-low' },
    { url: 'https://polymarket.com/market/wti-80-high' },
  ])
})

test('writeExtraction inserts a fresh Polymarket market_signal once the consolidation window has elapsed', async () => {
  const store = new InMemoryEntityMemoryStore()
  await writeExtraction(store, {
    ...packet,
    sourceResearchId: 'research-wti-early',
    context: { candidate: { tag_slug: 'commodities' } },
  }, provider({
    primaryEntities: [{ name: 'Crude Oil (WTI)', type: 'asset', slug: 'crude-oil-wti', aliases: ['WTI'] }],
    memories: [{
      entitySlug: 'crude-oil-wti',
      memoryType: 'market_signal',
      title: 'WTI hit $60 low',
      summary: 'First observation.',
    }],
  }))

  const later = await writeExtraction(store, {
    ...packet,
    sourceResearchId: 'research-wti-later',
    // commodities window is 12h — 13h later must not consolidate.
    observedAt: new Date(Date.parse(packet.observedAt) + 13 * 3_600_000).toISOString(),
    context: { candidate: { tag_slug: 'commodities' } },
  }, provider({
    primaryEntities: [{ name: 'Crude Oil (WTI)', type: 'asset', slug: 'crude-oil-wti', aliases: ['WTI'] }],
    memories: [{
      entitySlug: 'crude-oil-wti',
      memoryType: 'market_signal',
      title: 'WTI hit $90 high',
      summary: 'Second, later observation.',
    }],
  }))

  assert.equal(later.memoriesConsolidated, 0)
  const marketSignals = store.memories.filter((memory) => memory.memory_type === 'market_signal')
  assert.equal(marketSignals.length, 2, 'observations outside the window should remain separate rows')
})

test('writeExtraction uses the default 24h window for a Polymarket tag not in the shortened list', async () => {
  const store = new InMemoryEntityMemoryStore()
  await writeExtraction(store, {
    ...packet,
    sourceResearchId: 'research-politics-1',
    context: { candidate: { tag_slug: 'politics' } },
  }, provider({
    primaryEntities: [{ name: 'US Election', type: 'event', slug: 'us-election' }],
    memories: [{
      entitySlug: 'us-election',
      memoryType: 'market_signal',
      title: 'Election odds moved',
      summary: 'First observation.',
    }],
  }))

  // 13h later is inside the 24h default window (unlike the 12h commodities window).
  const second = await writeExtraction(store, {
    ...packet,
    sourceResearchId: 'research-politics-2',
    observedAt: new Date(Date.parse(packet.observedAt) + 13 * 3_600_000).toISOString(),
    context: { candidate: { tag_slug: 'politics' } },
  }, provider({
    primaryEntities: [{ name: 'US Election', type: 'event', slug: 'us-election' }],
    memories: [{
      entitySlug: 'us-election',
      memoryType: 'market_signal',
      title: 'Election odds moved again',
      summary: 'Second observation.',
    }],
  }))

  assert.equal(second.memoriesConsolidated, 1)
  assert.equal(store.memories.filter((memory) => memory.memory_type === 'market_signal').length, 1)
})

test('writeExtraction does not consolidate memories from non-Polymarket sources', async () => {
  const store = new InMemoryEntityMemoryStore()
  const newsPacket: ResearchPacket = {
    ...packet,
    source: 'news',
    sourceArea: 'crypto',
    sourceResearchId: 'news-1',
  }
  await writeExtraction(store, newsPacket, provider({
    primaryEntities: [{ name: 'Bitcoin', type: 'asset', slug: 'bitcoin' }],
    memories: [{
      entitySlug: 'bitcoin',
      memoryType: 'market_signal',
      title: 'Bitcoin news event one',
      summary: 'First article.',
    }],
  }))

  const second = await writeExtraction(store, {
    ...newsPacket,
    sourceResearchId: 'news-2',
    observedAt: new Date(Date.parse(packet.observedAt) + 3_600_000).toISOString(),
  }, provider({
    primaryEntities: [{ name: 'Bitcoin', type: 'asset', slug: 'bitcoin' }],
    memories: [{
      entitySlug: 'bitcoin',
      memoryType: 'market_signal',
      title: 'Bitcoin news event two',
      summary: 'Second article.',
    }],
  }))

  assert.equal(second.memoriesConsolidated, 0)
  assert.equal(store.memories.filter((memory) => memory.memory_type === 'market_signal').length, 2)
})

test('writeExtraction reconciles two publishers covering the same CLARITY Act story into one entity memory', async () => {
  const store = new InMemoryEntityMemoryStore()
  const firstPacket: ResearchPacket = {
    ...packet,
    id: 'news:clarity-lookonchain',
    source: 'news',
    sourceArea: 'news_feed:articles',
    sourceType: 'article',
    sourceResearchId: 'clarity-lookonchain',
    sourceRefId: 'lookonchain-68528',
    title: 'Galaxy Research Director lowers probability of CLARITY Act passing this year to 10%',
    summary: 'Political divisions lowered the estimated chance of passage to 10%.',
    body: 'The estimate cited political divisions as the main obstacle.',
    url: 'https://lookonchain.com/feeds/68528',
    observedAt: '2026-08-16T10:00:00.000Z',
    context: {
      image_url: 'https://assets.coingecko.com/articles/images/clarity-lookonchain.png',
      provider_id: 'tokens_xyz',
      upstream_source_name: 'Lookonchain',
    },
  }

  await writeExtraction(store, firstPacket, provider({
    primaryEntities: [{
      name: 'CLARITY Act',
      type: 'regulation',
      slug: 'clarity-act',
      aliases: ['Digital Asset Market Clarity Act'],
    }],
    memories: [{
      entitySlug: 'clarity-act',
      memoryType: 'news_event',
      title: 'CLARITY Act passage estimate falls to 10%',
      summary: 'Galaxy Research lowered its estimate of the CLARITY Act passing this year to 10%, citing political divisions.',
      evidence: [{ url: firstPacket.url }],
    }],
  }))

  const secondPacket: ResearchPacket = {
    ...firstPacket,
    id: 'news:clarity-blockchain-reporter',
    sourceResearchId: 'clarity-blockchain-reporter',
    sourceRefId: 'clarity-act-interim-fixes',
    title: 'CLARITY Act Odds Decline as SEC and CFTC Build Interim Fixes',
    summary: 'Passage odds declined while regulators explored interim measures.',
    body: 'The article connected falling passage expectations with SEC and CFTC interim approaches.',
    url: 'https://blockchainreporter.net/clarity-act-odds-decline-as-sec-and-cftc-build-interim-fixes',
    observedAt: '2026-08-16T11:00:00.000Z',
    context: {
      provider_id: 'tokens_xyz',
      upstream_source_name: 'Blockchain Reporter',
    },
  }
  let recentMemoryId = ''
  const second = await writeExtraction(store, secondPacket, {
    async extract(_packet, canon) {
      assert.equal(canon?.recentMemories?.length, 1)
      assert.equal(canon?.recentMemories?.[0].entitySlug, 'clarity-act')
      recentMemoryId = canon?.recentMemories?.[0].id ?? ''
      return {
        primaryEntities: [{ name: 'CLARITY Act', type: 'regulation', slug: 'clarity-act' }],
        memories: [{
          entitySlug: 'clarity-act',
          memoryType: 'market_signal',
          title: 'CLARITY Act odds decline amid interim regulatory fixes',
          summary: 'CLARITY Act passage expectations remained weak while the SEC and CFTC developed interim regulatory approaches.',
          body: secondPacket.body,
          evidence: [{ url: secondPacket.url }],
          reconciliation: {
            action: 'update_existing_story',
            existingMemoryId: recentMemoryId,
            confidence: 0.94,
            reason: 'Same CLARITY Act passage-odds development with material added context about interim fixes.',
          },
        }],
      }
    },
  })

  assert.equal(second.entitiesReused, 1)
  assert.equal(second.memoriesConsolidated, 1)
  assert.equal(store.memories.length, 1, 'the second publisher updates the existing story instead of creating a duplicate row')
  assert.equal(store.memories[0].id, recentMemoryId)
  assert.equal(
    store.memories[0].summary,
    'CLARITY Act passage expectations remained weak while the SEC and CFTC developed interim regulatory approaches.',
  )
  assert.deepEqual(store.memories[0].evidence, [
    { url: firstPacket.url },
    { url: secondPacket.url },
  ])
  assert.equal(store.memories[0].context.story_source_count, 2)
  assert.equal(
    store.memories[0].context.image_url,
    'https://assets.coingecko.com/articles/images/clarity-lookonchain.png',
    'a later update without media must not erase the existing usable story image',
  )
  assert.deepEqual(store.memories[0].context.story_source_research_ids, [
    'clarity-lookonchain',
    'clarity-blockchain-reporter',
  ])
  assert.equal(store.memories[0].context.last_story_reconciliation, 'update_existing_story')
})

test('writeExtraction fails open to a new row when a same-story decision is below the reconciliation threshold', async () => {
  const store = new InMemoryEntityMemoryStore()
  const newsPacket: ResearchPacket = {
    ...packet,
    source: 'news',
    sourceArea: 'news_feed:articles',
    sourceType: 'article',
    sourceResearchId: 'bitcoin-story-1',
    sourceRefId: 'bitcoin-story-1',
    title: 'Bitcoin ETF flows rise',
    summary: 'Bitcoin ETF flows rose.',
    body: 'Bitcoin ETF flows rose.',
    observedAt: '2026-08-16T10:00:00.000Z',
  }
  await writeExtraction(store, newsPacket, provider({
    primaryEntities: [{ name: 'Bitcoin', type: 'asset', slug: 'bitcoin', aliases: ['BTC'] }],
    memories: [{ entitySlug: 'bitcoin', memoryType: 'news_event', title: 'ETF flows rise', summary: 'Bitcoin ETF flows rose.' }],
  }))

  const second = await writeExtraction(store, {
    ...newsPacket,
    sourceResearchId: 'bitcoin-story-2',
    sourceRefId: 'bitcoin-story-2',
    title: 'Bitcoin price rises',
    summary: 'Bitcoin price rose.',
    observedAt: '2026-08-16T11:00:00.000Z',
  }, {
    async extract(_packet, canon) {
      return {
        primaryEntities: [{ name: 'Bitcoin', type: 'asset', slug: 'bitcoin' }],
        memories: [{
          entitySlug: 'bitcoin',
          memoryType: 'news_event',
          title: 'Bitcoin price rises',
          summary: 'Bitcoin price rose.',
          reconciliation: {
            action: 'duplicate_source',
            existingMemoryId: canon?.recentMemories?.[0].id,
            confidence: 0.62,
            reason: 'Same entity but uncertain event match.',
          },
        }],
      }
    },
  })

  assert.equal(second.memoriesConsolidated, 0)
  assert.equal(store.memories.length, 2)
})

test('news reconciliation accepts confidence exactly at the 0.8 threshold', async () => {
  const store = new InMemoryEntityMemoryStore()
  const recent = reconciliationMemory()
  store.memories.push(recent)

  const result = await __testing.reconcileNewsStoryMemories(store, {
    ...packet,
    source: 'news',
  }, [{
    input: incomingReconciliationMemory(),
    reconciliation: {
      action: 'update_existing_story',
      existingMemoryId: recent.id,
      confidence: 0.8,
    },
  }], [recent])

  assert.equal(result.consolidated, 1)
  assert.deepEqual(result.remaining, [])
})

test('news reconciliation rejects a recent memory owned by a different entity', async () => {
  const store = new InMemoryEntityMemoryStore()
  const recent = reconciliationMemory({ entity_id: 'entity-ethereum' })
  store.memories.push(recent)
  const incoming = incomingReconciliationMemory({ entity_id: 'entity-bitcoin' })

  const result = await __testing.reconcileNewsStoryMemories(store, {
    ...packet,
    source: 'news',
  }, [{
    input: incoming,
    reconciliation: {
      action: 'duplicate_source',
      existingMemoryId: recent.id,
      confidence: 0.95,
    },
  }], [recent])

  assert.equal(result.consolidated, 0)
  assert.deepEqual(result.remaining, [incoming])
})

test('news reconciliation rejects an unlisted or stale memory ID', async () => {
  const store = new InMemoryEntityMemoryStore()
  const recent = reconciliationMemory()
  store.memories.push(recent)
  const incoming = incomingReconciliationMemory()

  const result = await __testing.reconcileNewsStoryMemories(store, {
    ...packet,
    source: 'news',
  }, [{
    input: incoming,
    reconciliation: {
      action: 'duplicate_source',
      existingMemoryId: 'memory-not-supplied-to-the-prompt',
      confidence: 0.95,
    },
  }], [recent])

  assert.equal(result.consolidated, 0)
  assert.deepEqual(result.remaining, [incoming])
})

test('news reconciliation rejects a target created by the same packet replay', async () => {
  const store = new InMemoryEntityMemoryStore()
  const recent = reconciliationMemory({
    source_research_id: 'research-incoming',
  })
  store.memories.push(recent)
  const incoming = incomingReconciliationMemory()

  const result = await __testing.reconcileNewsStoryMemories(store, {
    ...packet,
    source: 'news',
  }, [{
    input: incoming,
    reconciliation: {
      action: 'update_existing_story',
      existingMemoryId: recent.id,
      confidence: 0.95,
    },
  }], [recent])

  assert.equal(result.consolidated, 0)
  assert.deepEqual(result.remaining, [incoming])
})

test('recent news memory loading includes the exact 48-hour boundary and excludes older rows', async () => {
  const store = new InMemoryEntityMemoryStore()
  const boundary = reconciliationMemory({
    id: 'memory-at-boundary',
    observed_at: '2026-08-14T12:00:00.000Z',
  })
  const stale = reconciliationMemory({
    id: 'memory-before-boundary',
    observed_at: '2026-08-14T11:59:59.999Z',
  })
  store.memories.push(boundary, stale)
  const shortlist: CanonEntity[] = [{
    id: 'entity-bitcoin',
    slug: 'bitcoin',
    name: 'Bitcoin',
    type: 'asset',
    aliases: ['BTC'],
    summary: null,
  }]

  const recent = await __testing.loadRecentNewsMemories(store, {
    ...packet,
    source: 'news',
    observedAt: '2026-08-16T12:00:00.000Z',
  }, shortlist)

  assert.deepEqual(recent.map((memory) => memory.id), ['memory-at-boundary'])
})

test('recent news memory read failure fails open with no reconciliation context', async () => {
  class FailingRecentMemoryStore extends InMemoryEntityMemoryStore {
    override async listRecentMemories(): Promise<EntityMemoryRecord[]> {
      throw new Error('database unavailable')
    }
  }
  const shortlist: CanonEntity[] = [{
    id: 'entity-bitcoin',
    slug: 'bitcoin',
    name: 'Bitcoin',
    type: 'asset',
    aliases: ['BTC'],
    summary: null,
  }]

  const recent = await __testing.loadRecentNewsMemories(new FailingRecentMemoryStore(), {
    ...packet,
    source: 'news',
  }, shortlist)

  assert.deepEqual(recent, [])
})

test('writeExtraction durably attaches trusted news image metadata to every entity memory', async () => {
  const store = new InMemoryEntityMemoryStore()
  const newsPacket: ResearchPacket = {
    ...packet,
    source: 'news',
    sourceArea: 'news_feed:social',
    sourceType: 'social_post',
    sourceResearchId: 'feed-post-1',
    url: 'https://x.com/tokens/status/123',
    context: {
      image_url: 'https://pbs.twimg.com/profile_images/123/avatar_normal.jpg',
      provider_id: 'tokens_xyz',
      upstream_source_name: '@tokens',
    },
  }

  await writeExtraction(store, newsPacket, provider({
    primaryEntities: [{ name: 'Bitcoin', type: 'asset', slug: 'bitcoin' }],
    memories: [{
      entitySlug: 'bitcoin',
      memoryType: 'social_signal',
      title: 'Bitcoin update',
      summary: 'A post reported a Bitcoin update.',
      context: {
        // Source media is authoritative; extraction cannot replace it.
        image_url: 'https://example.com/hallucinated.jpg',
      },
    }],
  }))

  assert.equal(store.memories.length, 1)
  assert.deepEqual(store.memories[0].context, {
    image_url: 'https://pbs.twimg.com/profile_images/123/avatar_normal.jpg',
    source_title: newsPacket.title,
    source_url: newsPacket.url,
    image_kind: 'source_avatar',
    image_origin: 'tokens_xyz',
    image_attribution: '@tokens',
  })
})

test('writeExtraction stores a null image for news packets with an unsafe upstream URL', async () => {
  const store = new InMemoryEntityMemoryStore()
  const newsPacket: ResearchPacket = {
    ...packet,
    source: 'news',
    sourceArea: 'news_feed:articles',
    sourceType: 'article',
    sourceResearchId: 'feed-article-1',
    context: { image_url: 'javascript:alert(1)' },
  }

  await writeExtraction(store, newsPacket, provider({
    primaryEntities: [{ name: 'Bitcoin', type: 'asset', slug: 'bitcoin' }],
    memories: [{
      entitySlug: 'bitcoin',
      memoryType: 'news_event',
      title: 'Bitcoin article',
      summary: 'An article reported a Bitcoin update.',
      context: {
        image_url: 'https://example.com/hallucinated.jpg',
        image_kind: 'content',
        image_origin: 'hallucinated',
        image_attribution: 'Fake Outlet',
      },
    }],
  }))

  assert.deepEqual(store.memories[0].context, {
    image_url: null,
    image_kind: null,
    image_origin: null,
    image_attribution: null,
    source_title: newsPacket.title,
    source_url: null,
  })
})

test('writeExtraction stores a market signal under the durable entity instead of the market', async () => {
  const store = new InMemoryEntityMemoryStore()
  await writeExtraction(store, {
    ...packet,
    title: 'Will Ethereum reach $3,000 by December 31?',
    sourceRefId: 'will-ethereum-reach-3000-by-december-31',
  }, provider({
    primaryEntities: [{
      name: 'Ethereum',
      type: 'asset',
      slug: 'ethereum',
      aliases: ['ETH'],
      summary: 'Ethereum network and ETH asset.',
    }],
    memories: [{
      entitySlug: 'ethereum',
      memoryType: 'market_signal',
      title: 'ETH $3,000 odds moved',
      summary: 'Polymarket research observed movement in an ETH $3,000 market.',
      mentions: ['Polymarket', 'Will Ethereum reach $3,000 by December 31?'],
      context: { source_market_slug: 'will-ethereum-reach-3000-by-december-31' },
    }],
  }))

  assert.deepEqual(store.entities.map((entity) => entity.slug), ['ethereum'])
  assert.equal(store.memories.filter((memory) => memory.memory_type !== 'source_marker').length, 1)
  assert.equal(store.memories.find((memory) => memory.memory_type === 'market_signal')?.entity_id, 'entity-1')
})
