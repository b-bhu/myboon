import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PolymarketCatalogCollectionState,
  PolymarketCatalogItemInput,
  PolymarketCatalogStore,
} from '../polymarket/catalog/contracts.js'
import type { HydratedPolymarketCollection } from '../polymarket/catalog/hydrate.js'
import { PolymarketCatalogConflictError } from '../polymarket/catalog/contracts.js'
import { createInternalPolymarketCatalogRoutes } from './polymarket-catalog.js'

const readToken = 'r'.repeat(48)
const writeToken = 'w'.repeat(48)

const publishedState: PolymarketCatalogCollectionState = {
  collection: {
    key: 'featured',
    name: 'Featured markets',
    description: null,
    isEnabled: true,
    defaultLimit: 20,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  },
  draft: null,
  published: {
    id: 'release-1',
    version: 1,
    revision: 1,
    status: 'published',
    note: null,
    createdBy: 'migration',
    publishedBy: 'migration',
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    publishedAt: '2026-07-15T00:00:00.000Z',
    items: [],
  },
  hasUnpublishedChanges: false,
}

function testStore(overrides: Partial<PolymarketCatalogStore> = {}): PolymarketCatalogStore {
  return {
    async getCollection() { return publishedState },
    async saveDraft() { return publishedState },
    async publish() { return publishedState },
    ...overrides,
  }
}

function app(store = testStore(), resolveItems?: (items: PolymarketCatalogItemInput[]) => Promise<PolymarketCatalogItemInput[]>) {
  return createInternalPolymarketCatalogRoutes({
    internalReadToken: readToken,
    internalWriteToken: writeToken,
    store,
    resolveItems: resolveItems ?? (async (items) => items.map((item) => ({ ...item, title: item.sourceSlug }))),
  })
}

test('uses separate strong read and write credentials with private response headers', async () => {
  assert.equal((await app().request('/featured')).status, 401)
  const read = await app().request('/featured', { headers: { Authorization: `Bearer ${readToken}` } })
  assert.equal(read.status, 200)
  assert.match(read.headers.get('cache-control') ?? '', /no-store/)
  assert.equal(read.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')

  assert.equal((await app().request('/featured/draft', {
    method: 'POST',
    headers: { Authorization: `Bearer ${readToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: null, items: [] }),
  })).status, 401)

  const unavailable = createInternalPolymarketCatalogRoutes({
    internalReadToken: 'short',
    internalWriteToken: 'short',
    store: testStore(),
  })
  assert.equal((await unavailable.request('/featured')).status, 503)
})

test('validates, resolves, and replaces an ordered draft', async () => {
  let saved: { expectedRevision: number | null; items: PolymarketCatalogItemInput[] } | null = null
  const store = testStore({
    async saveDraft(input) {
      saved = { expectedRevision: input.expectedRevision, items: input.items }
      return publishedState
    },
  })
  const response = await app(store).request('/featured/draft', {
    method: 'POST',
    headers: { Authorization: `Bearer ${writeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: null,
      items: [{ sourceKind: 'event', sourceSlug: 'match-one', category: 'sports', sport: 'cricket' }],
    }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(saved, {
    expectedRevision: null,
    items: [{
      sourceKind: 'event',
      sourceSlug: 'match-one',
      category: 'sports',
      sport: 'cricket',
      isEnabled: true,
      displayOverrides: {},
      title: 'match-one',
    }],
  })
})

test('maps malformed drafts and revision conflicts to actionable client errors', async () => {
  const duplicate = await app().request('/featured/draft', {
    method: 'POST',
    headers: { Authorization: `Bearer ${writeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: null,
      items: [
        { sourceKind: 'market', sourceSlug: 'same-slug' },
        { sourceKind: 'market', sourceSlug: 'same-slug' },
      ],
    }),
  })
  assert.equal(duplicate.status, 400)

  const conflict = app(testStore({
    async publish() { throw new PolymarketCatalogConflictError('Reload before publishing.') },
  }))
  const publish = await conflict.request('/featured/publish', {
    method: 'POST',
    headers: { Authorization: `Bearer ${writeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 2 }),
  })
  assert.equal(publish.status, 409)
  assert.deepEqual(await publish.json(), {
    error: 'Reload before publishing.',
    code: 'catalog_revision_conflict',
  })
})

test('accepts a mixed automatic rule and individual slug draft', async () => {
  let savedItems: PolymarketCatalogItemInput[] = []
  const response = await app(testStore({
    async saveDraft(input) {
      savedItems = input.items
      return publishedState
    },
  })).request('/featured/draft', {
    method: 'POST',
    headers: { Authorization: `Bearer ${writeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: null,
      items: [
        {
          sourceKind: 'sports_rule',
          sourceSlug: 'crint',
          ruleConfig: { windowDays: 14, limit: 20, marketType: 'moneyline' },
        },
        { sourceKind: 'market', sourceSlug: 'individual-market' },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(savedItems[0]?.ruleConfig, { windowDays: 14, limit: 20, marketType: 'moneyline' })
  assert.equal(savedItems[0]?.category, 'sports')
  assert.equal(savedItems[1]?.sourceSlug, 'individual-market')
  assert.equal(savedItems[1]?.ruleConfig, undefined)
})

test('serves Polymarket-derived automatic sports options through read auth', async () => {
  const routes = createInternalPolymarketCatalogRoutes({
    internalReadToken: readToken,
    internalWriteToken: writeToken,
    store: testStore(),
    listSportsOptions: async () => [{
      sportCode: 'crint',
      currentSeriesId: '10528',
      label: 'CRINT · icc-cricket.com',
      image: null,
    }],
  })
  const response = await routes.request('/options/sports', {
    headers: { Authorization: `Bearer ${readToken}` },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    options: [{
      sportCode: 'crint',
      currentSeriesId: '10528',
      label: 'CRINT · icc-cricket.com',
      image: null,
    }],
    defaults: { windowDays: 14, limit: 20, marketType: 'moneyline' },
  })
})

test('previews an automatic source through read auth without writing catalog state', async () => {
  let previewed: PolymarketCatalogItemInput | null = null
  const preview: HydratedPolymarketCollection = {
    items: [{
      type: 'match',
      slug: 'epl-ars-che-2026-08-23',
      title: 'Arsenal vs Chelsea',
      category: 'sports',
      tags: ['sports', 'epl'],
      sport: 'epl',
      status: 'upcoming',
      gameStartTime: '2026-08-23T15:30:00.000Z',
      volume: 12345,
      endDate: null,
      active: true,
      image: null,
      outcomes: [],
    }],
    categories: ['sports'],
  }
  const routes = createInternalPolymarketCatalogRoutes({
    internalReadToken: readToken,
    internalWriteToken: writeToken,
    store: testStore({
      async saveDraft() {
        assert.fail('preview must not write a draft')
      },
    }),
    resolveItems: async (items) => items.map((item) => ({
      ...item,
      sourceId: '10188',
      title: 'English Premier League',
      sport: 'epl',
    })),
    previewItem: async (item) => {
      previewed = item
      return preview
    },
  })

  const query = new URLSearchParams({
    sourceKind: 'sports_rule',
    sourceSlug: 'EPL',
    windowDays: '14',
    limit: '5',
  })
  assert.equal((await routes.request(`/preview?${query}`)).status, 401)

  const response = await routes.request(`/preview?${query}`, {
    headers: { Authorization: `Bearer ${readToken}` },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(previewed?.ruleConfig, { windowDays: 14, limit: 5, marketType: 'moneyline' })
  assert.equal(previewed?.sourceSlug, 'epl')
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.count, 1)
  assert.deepEqual(body.items, preview.items)
  assert.deepEqual(body.source, {
    sourceKind: 'sports_rule',
    sourceSlug: 'epl',
    title: 'English Premier League',
    category: 'sports',
    sport: 'epl',
    ruleConfig: { windowDays: 14, limit: 5, marketType: 'moneyline' },
  })
})

test('rejects invalid preview windows before calling Polymarket', async () => {
  let resolved = false
  const routes = createInternalPolymarketCatalogRoutes({
    internalReadToken: readToken,
    internalWriteToken: writeToken,
    store: testStore(),
    resolveItems: async (items) => {
      resolved = true
      return items
    },
  })
  const query = new URLSearchParams({
    sourceKind: 'sports_rule',
    sourceSlug: 'epl',
    windowDays: '0',
    limit: '20',
  })
  const response = await routes.request(`/preview?${query}`, {
    headers: { Authorization: `Bearer ${readToken}` },
  })
  assert.equal(response.status, 400)
  assert.equal(resolved, false)
})
