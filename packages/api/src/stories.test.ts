import assert from 'node:assert/strict'
import test from 'node:test'
import type { StoryMarket } from '@myboon/shared/stories'
import type { HyperliquidQuotes } from './hyperliquid.js'
import { createStoryRoutes, storySummary } from './stories.js'

const entityIds = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
]

// Prod Atlas ids are UUIDv7 (e.g. 01a17278-acb3-7ccd-8ec1-4a9d8baf672f); the legacy Entity ids above are v4.
const atlasEntityIds = [
  '01a17278-acb3-7ccd-8ec1-4a9d8baf672f',
  '01a17278-acb3-7ccd-8ec1-4a9d8baf6730',
  '01a17278-acb3-7ccd-8ec1-4a9d8baf6731',
  '01a17278-acb3-7ccd-8ec1-4a9d8baf6732',
]

function app(fetchImpl: typeof fetch, prices?: HyperliquidQuotes) {
  return createStoryRoutes({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-test-key',
    ...(prices ? { prices } : {}),
    fetch: fetchImpl,
    now: () => ATLAS_NOW,
  })
}

// Fixed clock for the Atlas 7-day window: items dated 2026-07-06T00:00Z or later (and not after this) count.
const ATLAS_NOW = Date.parse('2026-07-13T00:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

/** True for the one bounded 7-day eligibility read of atlas.entity_items. */
function isWindowRead(url: URL): boolean {
  return url.pathname.endsWith('/entity_items') && url.searchParams.get('select') === 'main_entity_id,occurred_at'
}

/** Window rows for `entityId`: `count` active items, newest at `latest`, one hour apart going back. */
function windowRows(entityId: string, count: number, latest = '2026-07-12T00:00:00.000Z') {
  return Array.from({ length: count }, (_, index) => ({
    main_entity_id: entityId,
    occurred_at: new Date(Date.parse(latest) - index * 3_600_000).toISOString(),
  }))
}

/** Serves `rows` on the first window page and nothing after it, like PostgREST paging past the end. */
function windowResponse(url: URL, rows: unknown[]): Response {
  return jsonResponse(Number(url.searchParams.get('offset')) === 0 ? rows : [])
}

test('Story detail rejects an unsafe slug without reading the database', async () => {
  let requests = 0
  const fetchImpl = async () => {
    requests += 1
    throw new Error('database should not be called')
  }
  const response = await app(fetchImpl).request('/us-and-iran.or.id.not.is.null')
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'Invalid story slug' })
  assert.equal(requests, 0)
})

test('Story detail returns 404 when the Entity is not selected', async () => {
  let requests = 0
  const fetchImpl = async () => {
    requests += 1
    return jsonResponse([])
  }
  const response = await app(fetchImpl).request('/bitcoin')
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Story not found' })
  assert.equal(requests, 1)
})

test('Story routes return a generic 500 response for database failures', async () => {
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const response = await app(async () => new Response('database detail', { status: 503 })).request('/')
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'Unable to load Stories' })
  } finally {
    console.error = originalConsoleError
  }
})

const SUMMARY_NOW = Date.parse('2026-10-20T00:00:00.000Z')
const summaryEntity = { id: entityIds[0], slug: 'bitcoin', name: 'Bitcoin' } as unknown as Parameters<typeof storySummary>[0]
function summaryMemory(summary: string, eventAt: string) {
  return { entityId: entityIds[0], summary, eventAt, imageUrl: null, imageKind: null, imageAttribution: null } as unknown as Parameters<typeof storySummary>[1][number]
}

test('Story summary tracks the latest reported memory; a future-dated one never becomes updatedAt', () => {
  const summary = storySummary(summaryEntity, [
    summaryMemory('Scheduled announcement', '2099-10-29T21:00:00.000Z'),
    summaryMemory('Latest reported development', '2026-07-12T00:00:00.000Z'),
    summaryMemory('Older development', '2026-07-10T00:00:00.000Z'),
  ], 3, SUMMARY_NOW)
  assert.deepEqual(summary, {
    storySlug: 'bitcoin',
    name: 'Bitcoin',
    latestDevelopment: 'Latest reported development',
    eventCount: 3,
    updatedAt: '2026-07-12T00:00:00.000Z',
    imageUrl: null,
    imageKind: null,
    imageAttribution: null,
    entityType: null,
    markets: [],
  })
})

test('Story summary moves updatedAt forward when a new later reported memory arrives', () => {
  const before = storySummary(summaryEntity, [
    summaryMemory('Latest development', '2026-07-12T00:00:00.000Z'),
    summaryMemory('Older development', '2026-07-10T00:00:00.000Z'),
  ], 2, SUMMARY_NOW)
  assert.equal(before?.updatedAt, '2026-07-12T00:00:00.000Z')

  const after = storySummary(summaryEntity, [
    summaryMemory('New development', '2026-07-13T09:30:00.000Z'),
    summaryMemory('Latest development', '2026-07-12T00:00:00.000Z'),
    summaryMemory('Older development', '2026-07-10T00:00:00.000Z'),
  ], 3, SUMMARY_NOW)
  assert.equal(after?.latestDevelopment, 'New development')
  assert.equal(after?.updatedAt, '2026-07-13T09:30:00.000Z')
})

test('Story Atlas list selects eligible active entities by latest development and maps latest items', async () => {
  const requests: Array<{ url: URL; headers: Record<string, string> }> = []
  const entityRows = [
    { id: atlasEntityIds[2], slug: 'story-3', name: 'Story 3', status: 'active', show_in_carousel: false },
    { id: atlasEntityIds[1], slug: 'story-2', name: 'Story 2', status: 'active', show_in_carousel: false },
    { id: atlasEntityIds[0], slug: 'story-1', name: 'Story 1', status: 'active', show_in_carousel: false },
  ]
  const itemsByEntity: Record<string, { latest: unknown; total: number }> = {
    [atlasEntityIds[0]]: {
      latest: { id: 'item-1', title: 'Latest development', summary: '  Latest summary  ', occurred_at: '2026-07-12T00:00:00.000Z' },
      total: 2,
    },
    [atlasEntityIds[1]]: {
      latest: { id: 'item-2', title: 'Only title', summary: null, occurred_at: '2026-07-09T00:00:00.000Z' },
      total: 1,
    },
    [atlasEntityIds[2]]: { latest: null, total: 0 },
  }
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    requests.push({ url, headers })
    assert.equal(headers['Accept-Profile'], 'atlas')
    if (url.pathname.endsWith('/entities')) {
      assert.equal(url.searchParams.get('select'), 'id,slug,name,type,image:card->image->>url')
      assert.equal(url.searchParams.has('show_in_carousel'), false)
      assert.equal(url.searchParams.get('status'), 'eq.active')
      assert.equal(url.searchParams.get('id'), `in.(${atlasEntityIds[0]},${atlasEntityIds[1]},${atlasEntityIds[2]})`)
      return jsonResponse(entityRows)
    }
    if (isWindowRead(url)) {
      return windowResponse(url, [
        ...windowRows(atlasEntityIds[2], 3, '2026-07-08T00:00:00.000Z'),
        ...windowRows(atlasEntityIds[0], 3, '2026-07-12T00:00:00.000Z'),
        ...windowRows(atlasEntityIds[1], 3, '2026-07-09T00:00:00.000Z'),
      ])
    }
    if (url.pathname.endsWith('/entity_items')) {
      const entityId = String(url.searchParams.get('main_entity_id') ?? '').replace(/^eq\./, '')
      assert.ok(entityId in itemsByEntity, `unexpected entity: ${entityId}`)
      assert.equal(url.searchParams.get('status'), 'eq.active')
      assert.equal(url.searchParams.get('merged_into_id'), 'is.null')
      assert.equal(url.searchParams.get('occurred_at'), 'not.is.null')
      assert.equal(url.searchParams.get('order'), 'occurred_at.desc,id.desc')
      if (headers.Prefer === 'count=exact') {
        assert.equal(headers.Range, '0-0')
        assert.equal(url.searchParams.has('limit'), false)
        return jsonResponse([], itemsByEntity[entityId].total)
      }
      assert.equal(url.searchParams.get('limit'), '1')
      assert.equal(url.searchParams.get('offset'), '0')
      return jsonResponse(itemsByEntity[entityId].latest ? [itemsByEntity[entityId].latest] : [])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl).request('/')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    stories: [
      {
        storySlug: 'story-1',
        name: 'Story 1',
        latestDevelopment: 'Latest summary',
        eventCount: 2,
        updatedAt: '2026-07-12T00:00:00.000Z',
        imageUrl: null,
        imageKind: null,
        imageAttribution: null,
        entityType: null,
        markets: [],
      },
      {
        storySlug: 'story-2',
        name: 'Story 2',
        latestDevelopment: 'Only title',
        eventCount: 1,
        updatedAt: '2026-07-09T00:00:00.000Z',
        imageUrl: null,
        imageKind: null,
        imageAttribution: null,
        entityType: null,
        markets: [],
      },
    ],
  })
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith('/entities')).length, 1)
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith('/entity_items') && !isWindowRead(url)).length, 6)
  assert.equal(requests.filter(({ url }) => isWindowRead(url)).length, 1)
})

test('Story Atlas list returns an entity with a production UUIDv7 id', async () => {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    assert.equal(headers['Accept-Profile'], 'atlas')
    if (url.pathname.endsWith('/entities')) {
      return jsonResponse([{ id: atlasEntityIds[0], slug: 'story-v7', name: 'Story v7' }])
    }
    if (isWindowRead(url)) return windowResponse(url, windowRows(atlasEntityIds[0], 3))
    if (url.pathname.endsWith('/entity_items')) {
      assert.equal(url.searchParams.get('main_entity_id'), `eq.${atlasEntityIds[0]}`)
      if (headers.Prefer === 'count=exact') return jsonResponse([], 1)
      return jsonResponse([
        { id: 'item-1', title: 'Latest development', summary: 'Latest summary', occurred_at: '2026-07-12T00:00:00.000Z' },
      ])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl).request('/')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    stories: [
      {
        storySlug: 'story-v7',
        name: 'Story v7',
        latestDevelopment: 'Latest summary',
        eventCount: 1,
        updatedAt: '2026-07-12T00:00:00.000Z',
        imageUrl: null,
        imageKind: null,
        imageAttribution: null,
        entityType: null,
        markets: [],
      },
    ],
  })
})

test('Story Atlas list carries the entity card image with kind content and the entity type', async () => {
  const entityRows = [
    { id: atlasEntityIds[0], slug: 'story-1', name: 'Story 1', type: 'news', image: 'https://cdn.example.com/entity.jpg' },
    { id: atlasEntityIds[1], slug: 'story-2', name: 'Story 2', type: 'topic', image: null },
  ]
  const itemEntityIds = entityRows.map((row) => row.id)
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    assert.equal(headers['Accept-Profile'], 'atlas')
    if (url.pathname.endsWith('/entities')) {
      assert.equal(url.searchParams.get('select'), 'id,slug,name,type,image:card->image->>url')
      assert.equal(url.searchParams.get('status'), 'eq.active')
      return jsonResponse(entityRows)
    }
    if (isWindowRead(url)) {
      return windowResponse(url, [...windowRows(atlasEntityIds[0], 3), ...windowRows(atlasEntityIds[1], 3, '2026-07-11T00:00:00.000Z')])
    }
    if (url.pathname.endsWith('/entity_items')) {
      const entityId = String(url.searchParams.get('main_entity_id') ?? '').replace(/^eq\./, '')
      assert.ok(itemEntityIds.includes(entityId))
      if (headers.Prefer === 'count=exact') return jsonResponse([], 1)
      return jsonResponse([
        { id: 'item-1', title: 'Latest development', summary: 'Latest summary', occurred_at: '2026-07-12T00:00:00.000Z' },
      ])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl).request('/')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    stories: [
      {
        storySlug: 'story-1',
        name: 'Story 1',
        latestDevelopment: 'Latest summary',
        eventCount: 1,
        updatedAt: '2026-07-12T00:00:00.000Z',
        imageUrl: 'https://cdn.example.com/entity.jpg',
        imageKind: 'content',
        imageAttribution: null,
        entityType: 'news',
        markets: [],
      },
      {
        storySlug: 'story-2',
        name: 'Story 2',
        latestDevelopment: 'Latest summary',
        eventCount: 1,
        updatedAt: '2026-07-12T00:00:00.000Z',
        imageUrl: null,
        imageKind: null,
        imageAttribution: null,
        entityType: 'topic',
        markets: [],
      },
    ],
  })
})

test('Story Atlas entity image and entity type also flow into the detail story summary', async () => {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    assert.equal(headers['Accept-Profile'], 'atlas')
    if (url.pathname.endsWith('/entities')) {
      assert.equal(url.searchParams.get('select'), 'id,slug,name,type,image:card->image->>url')
      assert.equal(url.searchParams.get('slug'), 'eq.us-and-iran')
      assert.equal(url.searchParams.get('status'), 'eq.active')
      return jsonResponse([
        { id: atlasEntityIds[0], slug: 'us-and-iran', name: 'US and Iran', type: 'news', image: 'https://cdn.example.com/entity.jpg' },
      ])
    }
    if (url.pathname.endsWith('/entity_items')) {
      if (headers.Prefer === 'count=exact') return jsonResponse([], 1)
      return jsonResponse([
        { id: 'item-1', title: 'Latest development', summary: 'Latest event', occurred_at: '2026-07-12T00:00:00.000Z' },
      ])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl).request('/us-and-iran')
  assert.equal(response.status, 200)
  const body = await response.json() as { story: Record<string, unknown> }
  assert.deepEqual(body.story, {
    storySlug: 'us-and-iran',
    name: 'US and Iran',
    latestDevelopment: 'Latest event',
    eventCount: 1,
    updatedAt: '2026-07-12T00:00:00.000Z',
    imageUrl: 'https://cdn.example.com/entity.jpg',
    imageKind: 'content',
    imageAttribution: null,
    entityType: 'news',
    markets: [],
  })
})

test('Story Atlas entity images fail closed on empty and non-https values', async () => {
  const entityRows = [
    { id: atlasEntityIds[0], slug: 'story-1', name: 'Story 1', type: 'news', image: '' },
    { id: atlasEntityIds[1], slug: 'story-2', name: 'Story 2', type: 'news', image: '   ' },
    { id: atlasEntityIds[2], slug: 'story-3', name: 'Story 3', type: 'news', image: 'http://cdn.example.com/entity.jpg' },
    { id: atlasEntityIds[3], slug: 'story-4', name: 'Story 4', type: 'news', image: { url: 'https://cdn.example.com/entity.jpg' } },
  ]
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    assert.equal(headers['Accept-Profile'], 'atlas')
    if (url.pathname.endsWith('/entities')) {
      return jsonResponse(entityRows)
    }
    if (isWindowRead(url)) {
      return windowResponse(url, entityRows.flatMap((row, index) => windowRows(row.id, 3, new Date(Date.parse('2026-07-12T00:00:00.000Z') - index * 3_600_000).toISOString())))
    }
    if (url.pathname.endsWith('/entity_items')) {
      if (headers.Prefer === 'count=exact') return jsonResponse([], 1)
      return jsonResponse([
        { id: 'item-1', title: 'Latest development', summary: 'Latest summary', occurred_at: '2026-07-12T00:00:00.000Z' },
      ])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl).request('/')
  assert.equal(response.status, 200)
  const body = await response.json() as { stories: Array<{ storySlug: string; imageUrl: string | null; imageKind: string | null; imageAttribution: string | null; entityType: string | null }> }
  assert.deepEqual(body.stories.map((story) => [
    story.storySlug,
    story.imageUrl,
    story.imageKind,
    story.imageAttribution,
    story.entityType,
  ]), [
    ['story-1', null, null, null, 'news'],
    ['story-2', null, null, null, 'news'],
    ['story-3', null, null, null, 'news'],
    ['story-4', null, null, null, 'news'],
  ])
})

test('Story Atlas detail pages items newest-first with pagination fields', async () => {
  const requests: Array<{ url: URL; headers: Record<string, string> }> = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    requests.push({ url, headers })
    assert.equal(headers['Accept-Profile'], 'atlas')
    if (url.pathname.endsWith('/entities')) {
      assert.equal(url.searchParams.get('slug'), 'eq.us-and-iran')
      assert.equal(url.searchParams.has('show_in_carousel'), false)
      assert.equal(url.searchParams.get('status'), 'eq.active')
      assert.equal(url.searchParams.get('limit'), '1')
      return jsonResponse([{ id: atlasEntityIds[0], slug: 'us-and-iran', name: 'US and Iran' }])
    }
    if (url.pathname.endsWith('/entity_items')) {
      assert.equal(url.searchParams.get('main_entity_id'), `eq.${atlasEntityIds[0]}`)
      assert.equal(url.searchParams.get('status'), 'eq.active')
      assert.equal(url.searchParams.get('merged_into_id'), 'is.null')
      assert.equal(url.searchParams.get('occurred_at'), 'not.is.null')
      assert.equal(url.searchParams.get('order'), 'occurred_at.desc,id.desc')
      if (headers.Prefer === 'count=exact') {
        assert.equal(headers.Range, '0-0')
        return jsonResponse([], 5)
      }
      const offset = Number(url.searchParams.get('offset'))
      if (offset === 0) {
        return jsonResponse([
          { id: 'item-newest', title: 'First', summary: 'Latest event', occurred_at: '2026-07-12T00:00:00.000Z' },
        ])
      }
      return jsonResponse([
        { id: 'item-2', title: 'Second', summary: 'Second event', occurred_at: '2026-07-11T00:00:00.000Z' },
        { id: 'item-3', title: 'Third', summary: 'Third event', occurred_at: '2026-07-10T00:00:00.000Z' },
      ])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl).request('/us-and-iran?limit=2&offset=1')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    story: {
      storySlug: 'us-and-iran',
      name: 'US and Iran',
      latestDevelopment: 'Latest event',
      eventCount: 5,
      updatedAt: '2026-07-12T00:00:00.000Z',
      imageUrl: null,
      imageKind: null,
      imageAttribution: null,
      entityType: null,
      markets: [],
    },
    events: [
      { text: 'Second event', eventAt: '2026-07-11T00:00:00.000Z', imageUrl: null, imageKind: null, imageAttribution: null },
      { text: 'Third event', eventAt: '2026-07-10T00:00:00.000Z', imageUrl: null, imageKind: null, imageAttribution: null },
    ],
    pagination: {
      limit: 2,
      offset: 1,
      total: 5,
      hasMore: true,
      nextOffset: 3,
    },
  })
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith('/entity_items')).length, 3)
})

test('Story Atlas detail reuses the first page row as the latest at offset 0', async () => {
  let itemRequests = 0
  const rows = [
    { id: 'item-1', title: 'First', summary: 'Latest event', occurred_at: '2026-07-12T00:00:00.000Z' },
    { id: 'item-2', title: 'Second', summary: 'Second event', occurred_at: '2026-07-11T00:00:00.000Z' },
    { id: 'item-3', title: 'Third', summary: 'Third event', occurred_at: '2026-07-10T00:00:00.000Z' },
  ]
  const response = await app(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (url.pathname.endsWith('/entities')) {
      return jsonResponse([{ id: atlasEntityIds[0], slug: 'bitcoin', name: 'Bitcoin' }])
    }
    if (url.pathname.endsWith('/entity_items')) {
      itemRequests += 1
      if (headers.Prefer === 'count=exact') return jsonResponse([], 3)
      assert.equal(url.searchParams.get('limit'), '20')
      assert.equal(url.searchParams.get('offset'), '0')
      return jsonResponse(rows)
    }
    throw new Error(`Unexpected request: ${url}`)
  }).request('/bitcoin')
  assert.equal(response.status, 200)
  const body = await response.json() as {
    story: { latestDevelopment: string, eventCount: number },
    events: Array<{ text: string, eventAt: string }>,
    pagination: { limit: number, offset: number, total: number, hasMore: boolean, nextOffset: number | null },
  }
  assert.equal(body.story.latestDevelopment, 'Latest event')
  assert.equal(body.story.eventCount, 3)
  assert.deepEqual(body.events.map((event) => [event.text, event.eventAt]), [
    ['Latest event', '2026-07-12T00:00:00.000Z'],
    ['Second event', '2026-07-11T00:00:00.000Z'],
    ['Third event', '2026-07-10T00:00:00.000Z'],
  ])
  assert.deepEqual(body.pagination, { limit: 20, offset: 0, total: 3, hasMore: false, nextOffset: null })
  assert.equal(itemRequests, 2)
})

test('Story Atlas detail returns 404 when the entity is not selected', async () => {
  let requests = 0
  const response = await app(async (input: RequestInfo | URL) => {
    requests += 1
    const url = new URL(String(input))
    if (url.pathname.endsWith('/entities')) return jsonResponse([])
    throw new Error(`Unexpected request: ${url}`)
  }).request('/bitcoin')
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Story not found' })
  assert.equal(requests, 1)
})

test('Story Atlas failures return the generic 500 response', async () => {
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const entitiesDown = await app(
      async () => new Response('atlas entities down', { status: 503 })).request('/')
    assert.equal(entitiesDown.status, 500)
    assert.deepEqual(await entitiesDown.json(), { error: 'Unable to load Stories' })

    const itemsDown = await app(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/entities')) {
        return jsonResponse([{ id: atlasEntityIds[0], slug: 'bitcoin', name: 'Bitcoin' }])
      }
      return new Response('atlas items down', { status: 503 })
    }).request('/bitcoin')
    assert.equal(itemsDown.status, 500)
    assert.deepEqual(await itemsDown.json(), { error: 'Unable to load Stories' })

    const countMissing = await app(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (url.pathname.endsWith('/entities')) {
        return jsonResponse([{ id: atlasEntityIds[0], slug: 'bitcoin', name: 'Bitcoin' }])
      }
      if (headers.Prefer === 'count=exact') {
        return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
      }
      return jsonResponse([
        { id: 'item-1', title: 'First', summary: 'Latest event', occurred_at: '2026-07-12T00:00:00.000Z' },
      ])
    }).request('/bitcoin')
    assert.equal(countMissing.status, 500)
    assert.deepEqual(await countMissing.json(), { error: 'Unable to load Stories' })
  } finally {
    console.error = originalConsoleError
  }
})

// ---- Atlas automatic story selection (#618): eligibility, window, cap, ordering, by-slug ----

interface FakeItem {
  main_entity_id: string
  occurred_at: string
  status?: string
  merged_into_id?: string | null
  title?: string
}

interface FakeEntity {
  id: string
  slug: string
  name: string
  status?: string
  show_in_carousel?: boolean
}

interface FakeMarket {
  entity_id: string
  rank: number
  symbol: string
}

/** Minimal PostgREST stand-in for the atlas reads the Stories route makes; honours the filters it is sent. */
function atlasFake(entities: FakeEntity[], items: FakeItem[], options: { maxRows?: number, entityMarkets?: FakeMarket[] } = {}) {
  const requests: URL[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push(url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (url.pathname.endsWith('/entity_markets')) {
      const entityFilter = url.searchParams.get('entity_id') ?? ''
      const requested = entityFilter.startsWith('in.(') ? entityFilter.slice(4, -1).split(',') : []
      return jsonResponse((options.entityMarkets ?? []).filter((row) => requested.includes(row.entity_id)))
    }
    if (url.pathname.endsWith('/entities')) {
      const id = url.searchParams.get('id')
      const slug = url.searchParams.get('slug')
      let rows = entities.filter((entity) => (url.searchParams.get('status') !== 'eq.active' || (entity.status ?? 'active') === 'active'))
      if (id?.startsWith('in.(')) rows = rows.filter((entity) => id.slice(4, -1).split(',').includes(entity.id))
      if (slug?.startsWith('eq.')) rows = rows.filter((entity) => entity.slug === slug.slice(3))
      const limit = Number(url.searchParams.get('limit') ?? rows.length)
      return jsonResponse(rows.slice(0, limit).map(({ id: rowId, slug: rowSlug, name }) => ({ id: rowId, slug: rowSlug, name })))
    }
    assert.ok(url.pathname.endsWith('/entity_items'), `unexpected table: ${url}`)
    const gte = url.searchParams.getAll('occurred_at').find((value) => value.startsWith('gte.'))
    const lte = url.searchParams.getAll('occurred_at').find((value) => value.startsWith('lte.'))
    const entityFilter = url.searchParams.get('main_entity_id') ?? ''
    let rows = items.filter((item) => {
      if (url.searchParams.get('status') === 'eq.active' && (item.status ?? 'active') !== 'active') return false
      if (url.searchParams.get('merged_into_id') === 'is.null' && item.merged_into_id) return false
      if (entityFilter.startsWith('eq.') && item.main_entity_id !== entityFilter.slice(3)) return false
      if (gte && Date.parse(item.occurred_at) < Date.parse(gte.slice(4))) return false
      if (lte && Date.parse(item.occurred_at) > Date.parse(lte.slice(4))) return false
      return true
    })
    rows = rows.sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))
    if (headers.Prefer === 'count=exact') return jsonResponse([], rows.length)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const limit = Math.min(Number(url.searchParams.get('limit') ?? rows.length), options.maxRows ?? Infinity)
    const page = rows.slice(offset, offset + limit)
    return jsonResponse(isWindowRead(url)
      ? page.map(({ main_entity_id, occurred_at }) => ({ main_entity_id, occurred_at }))
      : page.map((item) => ({ id: `item-${item.occurred_at}`, title: item.title ?? 'Item', summary: item.title ?? 'Item', occurred_at: item.occurred_at })))
  }
  return { fetchImpl, requests }
}

const entityUuid = (n: number) => `01a17278-acb3-7ccd-8ec1-${String(n).padStart(12, '0')}`
const hoursBeforeNow = (hours: number) => new Date(ATLAS_NOW - hours * 3_600_000).toISOString()
const fakeEntity = (n: number, extra: Partial<FakeEntity> = {}): FakeEntity => ({ id: entityUuid(n), slug: `topic-${n}`, name: `Topic ${n}`, ...extra })
const fakeItems = (n: number, count: number, latestHoursAgo: number, extra: Partial<FakeItem> = {}): FakeItem[] =>
  Array.from({ length: count }, (_, index) => ({ main_entity_id: entityUuid(n), occurred_at: hoursBeforeNow(latestHoursAgo + index), ...extra }))

async function listSlugs(fake: ReturnType<typeof atlasFake>): Promise<string[]> {
  const response = await app(fake.fetchImpl).request('/')
  assert.equal(response.status, 200)
  const body = await response.json() as { stories: Array<{ storySlug: string }> }
  return body.stories.map((story) => story.storySlug)
}

test('Story Atlas eligibility: 2 items in 7 days is excluded, 3 is included, and the carousel flag is ignored', async () => {
  const fake = atlasFake(
    [fakeEntity(1, { show_in_carousel: false }), fakeEntity(2, { show_in_carousel: true })],
    [...fakeItems(1, 3, 5), ...fakeItems(2, 2, 1)],
  )
  assert.deepEqual(await listSlugs(fake), ['topic-1'])
})

test('Story Atlas eligibility counts only items inside the last 7 days, never future-dated ones', async () => {
  const fake = atlasFake(
    [fakeEntity(1), fakeEntity(2), fakeEntity(3), fakeEntity(4)],
    [
      // 3 inside the window: included
      ...fakeItems(1, 3, 24),
      // 2 inside + 1 just older than 7 days (168h): excluded
      ...fakeItems(2, 2, 24), ...fakeItems(2, 1, 168.5),
      // 2 inside + 1 dated in the future: excluded
      ...fakeItems(3, 2, 24), ...fakeItems(3, 1, -6),
      // exactly on the 7-day boundary counts
      ...fakeItems(4, 1, 24), ...fakeItems(4, 1, 100), ...fakeItems(4, 1, 168),
    ],
  )
  assert.deepEqual(await listSlugs(fake), ['topic-1', 'topic-4'])
  const windowRead = fake.requests.find(isWindowRead)
  assert.ok(windowRead)
  const bounds = windowRead.searchParams.getAll('occurred_at')
  assert.deepEqual(bounds, [`gte.${hoursBeforeNow(168)}`, `lte.${hoursBeforeNow(0)}`])
})

test('Story Atlas eligibility ignores merged and inactive items and only lists active entities', async () => {
  const fake = atlasFake(
    [fakeEntity(1), fakeEntity(2), fakeEntity(3), fakeEntity(4, { status: 'archived' })],
    [
      ...fakeItems(1, 3, 10),
      // 2 active + 1 merged: excluded
      ...fakeItems(2, 2, 10), ...fakeItems(2, 1, 11, { merged_into_id: entityUuid(99) }),
      // 2 active + 1 inactive: excluded
      ...fakeItems(3, 2, 10), ...fakeItems(3, 1, 11, { status: 'rejected' }),
      // eligible items but the entity itself is not active
      ...fakeItems(4, 5, 2),
    ],
  )
  assert.deepEqual(await listSlugs(fake), ['topic-1'])
  const windowRead = fake.requests.find(isWindowRead)
  assert.equal(windowRead?.searchParams.get('status'), 'eq.active')
  assert.equal(windowRead?.searchParams.get('merged_into_id'), 'is.null')
})

test('Story Atlas list returns at most 12 topics, newest latest development first', async () => {
  const entities = Array.from({ length: 15 }, (_, index) => fakeEntity(index + 1))
  // Topic n's newest item is n hours old, so topic-1 is the freshest and topic-15 the stalest.
  const items = entities.flatMap((_, index) => fakeItems(index + 1, 3, index + 1))
  const fake = atlasFake(entities, items)
  const slugs = await listSlugs(fake)
  assert.equal(slugs.length, 12)
  assert.deepEqual(slugs, Array.from({ length: 12 }, (_, index) => `topic-${index + 1}`))
})

test('Story Atlas ordering uses the latest item, not the item count', async () => {
  const fake = atlasFake(
    [fakeEntity(1), fakeEntity(2), fakeEntity(3)],
    [...fakeItems(1, 40, 30), ...fakeItems(2, 3, 2), ...fakeItems(3, 5, 12)],
  )
  assert.deepEqual(await listSlugs(fake), ['topic-2', 'topic-3', 'topic-1'])
})

test('Story Atlas eligibility counts correctly across PostgREST pages when the server caps rows per read', async () => {
  const filler = Array.from({ length: 2300 }, (_, index) => ({
    main_entity_id: entityUuid(1),
    occurred_at: hoursBeforeNow(1 + index * 0.05),
  }))
  // Topic 2's three items are the oldest rows in the window, so they only show up on the third page.
  const fake = atlasFake([fakeEntity(1), fakeEntity(2)], [...filler, ...fakeItems(2, 3, 160)], { maxRows: 1000 })
  assert.deepEqual(await listSlugs(fake), ['topic-1', 'topic-2'])
  assert.ok(fake.requests.filter(isWindowRead).length >= 3)
})

test('Story Atlas list is empty, with no entity read, when nothing is eligible', async () => {
  const fake = atlasFake([fakeEntity(1)], fakeItems(1, 2, 3))
  assert.deepEqual(await listSlugs(fake), [])
  assert.equal(fake.requests.some((url) => url.pathname.endsWith('/entities')), false)
})

test('Story Atlas by-slug opens an entity that is not currently eligible but has items, flag or no flag', async () => {
  const fake = atlasFake(
    [fakeEntity(1, { show_in_carousel: false })],
    // 1 item in the window and 2 old ones: not eligible for the list, still has a timeline
    [...fakeItems(1, 1, 5), ...fakeItems(1, 2, 400)],
  )
  assert.deepEqual(await listSlugs(fake), [])
  const response = await app(fake.fetchImpl).request('/topic-1')
  assert.equal(response.status, 200)
  const body = await response.json() as { story: { storySlug: string; eventCount: number }; events: unknown[] }
  assert.equal(body.story.storySlug, 'topic-1')
  assert.equal(body.story.eventCount, 3)
  assert.equal(body.events.length, 3)
  const entityRead = fake.requests.find((url) => url.pathname.endsWith('/entities') && url.searchParams.get('slug') === 'eq.topic-1')
  assert.equal(entityRead?.searchParams.has('show_in_carousel'), false)
})

test('Story Atlas by-slug still returns 404 for an unknown, inactive or item-less entity', async () => {
  const fake = atlasFake(
    [fakeEntity(1), fakeEntity(2, { status: 'archived' }), fakeEntity(3)],
    [...fakeItems(2, 4, 3)],
  )
  for (const slug of ['topic-1', 'topic-2', 'topic-3', 'unknown']) {
    const response = await app(fake.fetchImpl).request(`/${slug}`)
    assert.equal(response.status, 404, slug)
  }
})

// ---- Markets on stories (#691) ----

interface PricesStubCall {
  symbols: readonly string[]
  waitMs: number
}

/** A `HyperliquidQuotes` stand-in: answers the recorded map, leaving other symbols out of the map. */
function pricesStub(quotes: Record<string, { price: number | null, change24hPct: number | null, asOf: string | null }>, calls: PricesStubCall[] = []): HyperliquidQuotes {
  return {
    async quotes(symbols, options) {
      calls.push({ symbols, waitMs: options.waitMs })
      return new Map(Object.entries(quotes).filter(([symbol]) => symbols.includes(symbol)))
    },
  }
}

test('Story Atlas list sends linked markets in rank order with prices from one quotes call', async () => {
  const quotesCalls: PricesStubCall[] = []
  const prices = pricesStub({
    'xyz:CL': { price: 82.54, change24hPct: -1.25, asOf: '2026-07-13T00:00:00.000Z' },
    BTC: { price: 61770, change24hPct: -3.15, asOf: '2026-07-13T00:00:00.000Z' },
    'xyz:SP500': { price: 6100, change24hPct: 0.4, asOf: '2026-07-13T00:00:00.000Z' },
  }, quotesCalls)
  const fake = atlasFake(
    [fakeEntity(1), fakeEntity(2)],
    [...fakeItems(1, 3, 5), ...fakeItems(2, 3, 4)],
    {
      entityMarkets: [
        { entity_id: entityUuid(1), rank: 2, symbol: 'BTC' },
        { entity_id: entityUuid(1), rank: 1, symbol: 'xyz:CL' },
        { entity_id: entityUuid(2), rank: 1, symbol: 'xyz:SP500' },
      ],
    },
  )
  const response = await app(fake.fetchImpl, prices).request('/')
  assert.equal(response.status, 200)
  const body = await response.json() as { stories: Array<{ storySlug: string, markets: StoryMarket[] }> }
  assert.deepEqual(body.stories.map((story) => [story.storySlug, story.markets]), [
    ['topic-2', [
      { symbol: 'xyz:SP500', displaySymbol: 'SPX', displayName: 'S&P 500', rank: 1, price: 6100, change24hPct: 0.4, asOf: '2026-07-13T00:00:00.000Z' },
    ]],
    ['topic-1', [
      { symbol: 'xyz:CL', displaySymbol: 'WTI', displayName: 'WTI crude oil', rank: 1, price: 82.54, change24hPct: -1.25, asOf: '2026-07-13T00:00:00.000Z' },
      { symbol: 'BTC', displaySymbol: 'BTC', displayName: 'Bitcoin', rank: 2, price: 61770, change24hPct: -3.15, asOf: '2026-07-13T00:00:00.000Z' },
    ]],
  ])
  // One entity_markets read per request with the exact atlas filter shape.
  const reads = fake.requests.filter((url) => url.pathname.endsWith('/entity_markets'))
  assert.equal(reads.length, 1)
  assert.equal(reads[0]?.searchParams.get('select'), 'entity_id,rank,symbol')
  assert.equal(reads[0]?.searchParams.get('entity_id'), `in.(${entityUuid(2)},${entityUuid(1)})`)
  assert.equal(reads[0]?.searchParams.get('order'), 'entity_id.asc,rank.asc')
  // One quotes call per request, every symbol together (rank-sorted per story), capped at 1.5 s.
  assert.equal(quotesCalls.length, 1)
  assert.deepEqual([...(quotesCalls[0]?.symbols ?? [])], ['xyz:CL', 'BTC', 'xyz:SP500'])
  assert.equal(quotesCalls[0]?.waitMs, 1500)
})

test('Story Atlas sends linked markets with null prices when prices is absent or a symbol is unpriced', async () => {
  // No prices injected at all: the link still ships, unpriced.
  const fake = atlasFake(
    [fakeEntity(1)],
    fakeItems(1, 3, 5),
    { entityMarkets: [{ entity_id: entityUuid(1), rank: 1, symbol: 'xyz:CL' }] },
  )
  const absentResponse = await app(fake.fetchImpl).request('/')
  assert.equal(absentResponse.status, 200)
  const absentBody = await absentResponse.json() as { stories: Array<{ markets: Array<Record<string, unknown>> }> }
  assert.deepEqual(absentBody.stories[0]?.markets, [
    { symbol: 'xyz:CL', displaySymbol: 'WTI', displayName: 'WTI crude oil', rank: 1, price: null, change24hPct: null, asOf: null },
  ])

  // A symbol missing from the snapshot keeps the link with null prices.
  const quotesCalls: PricesStubCall[] = []
  const partial = pricesStub({ BTC: { price: 61770, change24hPct: -3.15, asOf: '2026-07-13T00:00:00.000Z' } }, quotesCalls)
  const fakePartial = atlasFake(
    [fakeEntity(1)],
    fakeItems(1, 3, 5),
    {
      entityMarkets: [
        { entity_id: entityUuid(1), rank: 1, symbol: 'xyz:CL' },
        { entity_id: entityUuid(1), rank: 2, symbol: 'BTC' },
      ],
    },
  )
  const partialResponse = await app(fakePartial.fetchImpl, partial).request('/')
  assert.equal(partialResponse.status, 200)
  const partialBody = await partialResponse.json() as { stories: Array<{ markets: Array<Record<string, unknown>> }> }
  assert.deepEqual(partialBody.stories[0]?.markets, [
    { symbol: 'xyz:CL', displaySymbol: 'WTI', displayName: 'WTI crude oil', rank: 1, price: null, change24hPct: null, asOf: null },
    { symbol: 'BTC', displaySymbol: 'BTC', displayName: 'Bitcoin', rank: 2, price: 61770, change24hPct: -3.15, asOf: '2026-07-13T00:00:00.000Z' },
  ])
  assert.deepEqual([...(quotesCalls[0]?.symbols ?? [])], ['xyz:CL', 'BTC'])
})

test('Story Atlas list stays 200 within the cap when prices throws or hangs', async () => {
  const fake = atlasFake(
    [fakeEntity(1)],
    fakeItems(1, 3, 5),
    { entityMarkets: [{ entity_id: entityUuid(1), rank: 1, symbol: 'BTC' }] },
  )
  const unpriced = [{ symbol: 'BTC', displaySymbol: 'BTC', displayName: 'Bitcoin', rank: 1, price: null, change24hPct: null, asOf: null }]

  const throwing: HyperliquidQuotes = {
    async quotes() {
      throw new Error('quotes exploded')
    },
  }
  const throwingResponse = await app(fake.fetchImpl, throwing).request('/')
  assert.equal(throwingResponse.status, 200)
  const throwingBody = await throwingResponse.json() as { stories: Array<{ markets: Array<Record<string, unknown>> }> }
  assert.deepEqual(throwingBody.stories[0]?.markets, unpriced)

  const hanging: HyperliquidQuotes = {
    quotes: () => new Promise(() => undefined),
  }
  const started = Date.now()
  const hangingResponse = await app(fake.fetchImpl, hanging).request('/')
  assert.equal(hangingResponse.status, 200)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2500, `the list should answer within the 1.5 s cap, took ${elapsed}ms`)
  const hangingBody = await hangingResponse.json() as { stories: Array<{ markets: Array<Record<string, unknown>> }> }
  assert.deepEqual(hangingBody.stories[0]?.markets, unpriced)
})

test('Story Atlas list stays 200 with empty markets when the entity_markets read fails', async () => {
  const fake = atlasFake([fakeEntity(1)], fakeItems(1, 3, 5))
  const quotesCalls: PricesStubCall[] = []
  const prices = pricesStub({ BTC: { price: 1, change24hPct: 0, asOf: '2026-07-13T00:00:00.000Z' } }, quotesCalls)
  const logged: string[] = []
  const reads: URL[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/entity_markets')) {
      reads.push(url)
      return new Response('link read down', { status: 503 })
    }
    return fake.fetchImpl(input, init)
  }
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    const response = await app(fetchImpl, prices).request('/')
    assert.equal(response.status, 200)
    const body = await response.json() as { stories: Array<{ storySlug: string, markets: Array<Record<string, unknown>> }> }
    assert.deepEqual(body.stories.map((story) => story.storySlug), ['topic-1'])
    assert.deepEqual(body.stories[0]?.markets, [])
    assert.equal(reads.length, 1)
    assert.equal(logged.filter((line) => line.includes('[stories] entity_markets read failed')).length, 1)
    // No links survived the failed read, so no quotes call was made.
    assert.equal(quotesCalls.length, 0)
  } finally {
    console.error = originalConsoleError
  }
})

test('Story Atlas detail carries markets the same way as the list', async () => {
  const quotesCalls: PricesStubCall[] = []
  const prices = pricesStub({
    ETH: { price: 3000.25, change24hPct: -1.97, asOf: '2026-07-13T00:00:00.000Z' },
    'xyz:CL': { price: null, change24hPct: null, asOf: null },
  }, quotesCalls)
  const fake = atlasFake(
    [fakeEntity(1)],
    fakeItems(1, 4, 6),
    {
      entityMarkets: [
        { entity_id: entityUuid(1), rank: 2, symbol: 'xyz:CL' },
        { entity_id: entityUuid(1), rank: 1, symbol: 'ETH' },
      ],
    },
  )
  const response = await app(fake.fetchImpl, prices).request('/topic-1')
  assert.equal(response.status, 200)
  const body = await response.json() as { story: { storySlug: string, markets: Array<Record<string, unknown>> }, events: unknown[] }
  assert.deepEqual(body.story.markets, [
    { symbol: 'ETH', displaySymbol: 'ETH', displayName: 'Ethereum', rank: 1, price: 3000.25, change24hPct: -1.97, asOf: '2026-07-13T00:00:00.000Z' },
    { symbol: 'xyz:CL', displaySymbol: 'WTI', displayName: 'WTI crude oil', rank: 2, price: null, change24hPct: null, asOf: null },
  ])
  assert.equal(fake.requests.filter((url) => url.pathname.endsWith('/entity_markets')).length, 1)
  assert.equal(quotesCalls.length, 1)
  assert.equal(body.events.length > 0, true)
})

test('Story Atlas list with no linked markets ships every story with markets: []', async () => {
  const fake = atlasFake([fakeEntity(1), fakeEntity(2)], [...fakeItems(1, 3, 5), ...fakeItems(2, 3, 4)])
  const response = await app(fake.fetchImpl).request('/')
  assert.equal(response.status, 200)
  const body = await response.json() as { stories: Array<{ storySlug: string, markets: unknown[] }> }
  assert.deepEqual(body.stories.map((story) => [story.storySlug, story.markets]), [
    ['topic-2', []],
    ['topic-1', []],
  ])
})

function shapeOf(value: unknown): unknown {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.map(shapeOf)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, shapeOf(entry)]),
    )
  }
  return typeof value
}

function jsonResponse(body: unknown, total?: number): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (total !== undefined) headers['Content-Range'] = `0-0/${total}`
  return new Response(JSON.stringify(body), {
    headers,
  })
}
