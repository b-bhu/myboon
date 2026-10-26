import assert from 'node:assert/strict'
import test from 'node:test'
import type { EntityKnowledgeMemoryV1, EntityKnowledgeReader } from '@myboon/collectors/entity-manager'
import entityManager from '@myboon/collectors/entity-manager'
import { createStoryRoutes, storySummary } from './stories.js'

const { ENTITY_KNOWLEDGE_SCHEMA_VERSION } = entityManager

const entityIds = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
]

// Prod Atlas ids are UUIDv7 (e.g. 01a17278-acb3-7ccd-8ec1-4a9d8baf672f); the legacy Entity ids above are v4.
const atlasShelfIds = [
  '01a17278-acb3-7ccd-8ec1-4a9d8baf672f',
  '01a17278-acb3-7ccd-8ec1-4a9d8baf6730',
  '01a17278-acb3-7ccd-8ec1-4a9d8baf6731',
  '01a17278-acb3-7ccd-8ec1-4a9d8baf6732',
]

type StoryMemoryReader = Pick<EntityKnowledgeReader, 'getEntityMemoryEvents'>

function app(
  fetchImpl: typeof fetch,
  memoryReader: StoryMemoryReader = {
    async getEntityMemoryEvents() {
      return { schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION, items: [], totalCount: 0, nextCursor: null, hasMore: false }
    },
  },
  source?: 'legacy' | 'atlas',
) {
  return createStoryRoutes({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-test-key',
    memoryReader,
    ...(source ? { source } : {}),
    fetch: fetchImpl,
  })
}

test('Story list selects and caps Entities, reads bounded latest memories, and allowlists output', async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({ url, init })

    if (url.pathname.endsWith('/entities')) {
      assert.equal(url.searchParams.get('select'), 'id,slug,name')
      assert.equal(url.searchParams.has('status'), false)
      assert.equal(url.searchParams.get('show_in_carousel'), 'eq.true')
      assert.equal(url.searchParams.get('limit'), '5')
      return jsonResponse(entityIds.map((id, index) => ({
        id,
        slug: `story-${index + 1}`,
        name: `Story ${index + 1}`,
        summary: 'private Entity summary',
        metadata: { private: true },
      })))
    }

    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl, {
    async getEntityMemoryEvents(input) {
      if (input.entityId === entityIds[0]) return eventPage([
        memory(entityIds[0], 'Latest development', '2026-07-12T00:00:00.000Z', {
          media: { imageUrl: 'https://cdn.example.com/latest.jpg', imageKind: 'content', attribution: 'Example News' },
        }),
      ], 2, 'story-1-next', true)
      if (input.entityId === entityIds[1]) return eventPage([
        memory(entityIds[1], 'Only development', '2026-07-09T00:00:00.000Z'),
      ], 1)
      return eventPage([], 0)
    },
  }).request('/')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    stories: [
      {
        storySlug: 'story-1',
        name: 'Story 1',
        latestDevelopment: 'Latest development',
        eventCount: 2,
        updatedAt: '2026-07-12T00:00:00.000Z',
        imageUrl: 'https://cdn.example.com/latest.jpg',
        imageKind: 'content',
        imageAttribution: 'Example News',
        shelfType: null,
      },
      {
        storySlug: 'story-2',
        name: 'Story 2',
        latestDevelopment: 'Only development',
        eventCount: 1,
        updatedAt: '2026-07-09T00:00:00.000Z',
        imageUrl: null,
        imageKind: null,
        imageAttribution: null,
        shelfType: null,
      },
    ],
  })
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith('/entities')).length, 1)
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith('/entity_memories')).length, 0)
  assert.equal(requests[0]?.init?.headers instanceof Headers, false)
  assert.deepEqual(requests[0]?.init?.headers, {
    apikey: 'service-role-test-key',
    Authorization: 'Bearer service-role-test-key',
    Accept: 'application/json',
  })
})

test('Story detail returns the selected Entity timeline newest-first with pagination and public fields only', async () => {
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/entities')) {
      assert.equal(url.searchParams.get('slug'), 'eq.us-and-iran')
      assert.equal(url.searchParams.has('status'), false)
      assert.equal(url.searchParams.get('show_in_carousel'), 'eq.true')
      return jsonResponse([{
        id: entityIds[0],
        slug: 'us-and-iran',
        name: 'US and Iran',
        aliases: ['private'],
      }])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl, {
    async getEntityMemoryEvents() {
      return eventPage([
        memory(entityIds[0], 'Third event', '2026-07-12T00:00:00.000Z'),
        memory(entityIds[0], 'Second event', '2026-07-11T00:00:00.000Z'),
        memory(entityIds[0], 'First event', '2026-07-10T00:00:00.000Z', {
          media: { imageUrl: 'https://pbs.twimg.com/profile_images/123/avatar.jpg', imageKind: 'source_avatar', attribution: '@tokens' },
        }),
      ], 3)
    },
  }).request('/us-and-iran')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    story: {
      storySlug: 'us-and-iran',
      name: 'US and Iran',
      latestDevelopment: 'Third event',
      eventCount: 3,
      updatedAt: '2026-07-12T00:00:00.000Z',
      imageUrl: null,
      imageKind: null,
      imageAttribution: null,
      shelfType: null,
    },
    events: [
      {
        text: 'Third event',
        eventAt: '2026-07-12T00:00:00.000Z',
        imageUrl: null,
        imageKind: null,
        imageAttribution: null,
      },
      {
        text: 'Second event',
        eventAt: '2026-07-11T00:00:00.000Z',
        imageUrl: null,
        imageKind: null,
        imageAttribution: null,
      },
      {
        text: 'First event',
        eventAt: '2026-07-10T00:00:00.000Z',
        imageUrl: 'https://pbs.twimg.com/profile_images/123/avatar.jpg',
        imageKind: 'source_avatar',
        imageAttribution: '@tokens',
      },
    ],
    pagination: {
      limit: 20,
      offset: 0,
      total: 3,
      hasMore: false,
      nextOffset: null,
    },
  })
})

test('Story detail bounds pagination and keeps the Story summary anchored to the latest memory', async () => {
  const calls: unknown[] = []
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/entities')) {
      return jsonResponse([{ id: entityIds[0], slug: 'bitcoin', name: 'Bitcoin' }])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl, {
    async getEntityMemoryEvents(input) {
      calls.push(input)
      return eventPage([
        memory(entityIds[0], 'Latest event', '2026-07-12T00:00:00.000Z'),
        memory(entityIds[0], 'Third event', '2026-07-10T00:00:00.000Z'),
        memory(entityIds[0], 'Fourth event', '2026-07-09T00:00:00.000Z'),
      ], 5, 'next', true)
    },
  }).request('/bitcoin?limit=2&offset=1')
  assert.equal(response.status, 200)
  const body = await response.json() as Record<string, unknown>
  assert.equal((body.story as { latestDevelopment: string }).latestDevelopment, 'Latest event')
  assert.deepEqual(body.pagination, {
    limit: 2,
    offset: 1,
    total: 5,
    hasMore: true,
    nextOffset: 3,
  })
  assert.deepEqual(calls, [{ entityId: entityIds[0], limit: 3 }])
})

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

test('Story detail returns 404 when the selected Entity has no eligible timeline items', async () => {
  let requests = 0
  const fetchImpl = async (input: RequestInfo | URL) => {
    requests += 1
    const url = new URL(String(input))
    if (url.pathname.endsWith('/entities')) {
      return jsonResponse([{ id: entityIds[0], slug: 'bitcoin', name: 'Bitcoin' }])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl).request('/bitcoin')
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Story not found' })
  assert.equal(requests, 1)
})

test('Story detail fails closed on an incomplete cursor page', async () => {
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const response = await app(
      async () => jsonResponse([{ id: entityIds[0], slug: 'bitcoin', name: 'Bitcoin' }]),
      { async getEntityMemoryEvents() {
        return eventPage([memory(entityIds[0], 'Latest', '2026-07-12T00:00:00.000Z')], 5, null, true)
      } },
    ).request('/bitcoin?limit=2&offset=1')
    assert.equal(response.status, 500)
  } finally {
    console.error = originalConsoleError
  }
})

test('Story offset compatibility cursor-walks with every knowledge page capped at 100', async () => {
  const calls: Array<{ limit: number, cursor?: string }> = []
  const items = Array.from({ length: 102 }, (_, index) => memory(
    entityIds[0],
    `Event ${index + 1}`,
    new Date(Date.parse('2026-07-12T00:00:00.000Z') - index * 60_000).toISOString(),
  ))
  const response = await app(
    async () => jsonResponse([{ id: entityIds[0], slug: 'bitcoin', name: 'Bitcoin' }]),
    { async getEntityMemoryEvents(input) {
      calls.push({ limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) })
      const offset = input.cursor ? 100 : 0
      return eventPage(
        items.slice(offset, offset + input.limit),
        150,
        offset === 0 ? 'page-2' : 'page-3',
        true,
      )
    } },
  ).request('/bitcoin?limit=2&offset=100')

  assert.equal(response.status, 200)
  const body = await response.json() as { events: unknown[], pagination: { nextOffset: number | null } }
  assert.equal(body.events.length, 2)
  assert.equal(body.pagination.nextOffset, 102)
  assert.deepEqual(calls, [{ limit: 100 }, { limit: 2, cursor: 'page-2' }])
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
    shelfType: null,
  })
})

test('Story detail clamps updatedAt to the request time when the newest memory is future-dated', async () => {
  const startedAt = Date.now()
  const response = await app(
    async (input) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/entities')) {
        return jsonResponse([{ id: entityIds[0], slug: 'bitcoin', name: 'Bitcoin' }])
      }
      throw new Error(`Unexpected request: ${url}`)
    },
    {
      async getEntityMemoryEvents() {
        return eventPage([
          memory(entityIds[0], 'Scheduled announcement', '2099-10-29T21:00:00.000Z'),
          memory(entityIds[0], 'Older reported development', '2026-07-10T00:00:00.000Z'),
        ], 2)
      },
    },
  ).request('/bitcoin')
  assert.equal(response.status, 200)
  const body = await response.json() as {
    story: { latestDevelopment: string, updatedAt: string },
    events: Array<{ eventAt: string }>,
  }
  assert.equal(body.story.latestDevelopment, 'Scheduled announcement')
  const updatedAt = Date.parse(body.story.updatedAt)
  assert.ok(
    Number.isFinite(updatedAt) && updatedAt >= startedAt && updatedAt <= Date.now(),
    `updatedAt should be clamped to the request time, got ${body.story.updatedAt}`,
  )
  assert.deepEqual(body.events.map((event) => event.eventAt), [
    '2099-10-29T21:00:00.000Z',
    '2026-07-10T00:00:00.000Z',
  ])
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

test('Story Atlas list selects active carousel shelves, caps and orders them, and maps latest items', async () => {
  const requests: Array<{ url: URL; headers: Record<string, string> }> = []
  const shelfRows = [
    { id: atlasShelfIds[0], slug: 'story-1', name: 'Story 1', status: 'active', show_in_carousel: true },
    { id: atlasShelfIds[1], slug: 'story-2', name: 'Story 2', status: 'active', show_in_carousel: true },
    { id: atlasShelfIds[2], slug: 'story-3', name: 'Story 3', status: 'active', show_in_carousel: true },
  ]
  const itemsByShelf: Record<string, { latest: unknown; total: number }> = {
    [atlasShelfIds[0]]: {
      latest: { id: 'item-1', title: 'Latest development', summary: '  Latest summary  ', occurred_at: '2026-07-12T00:00:00.000Z' },
      total: 2,
    },
    [atlasShelfIds[1]]: {
      latest: { id: 'item-2', title: 'Only title', summary: null, occurred_at: '2026-07-09T00:00:00.000Z' },
      total: 1,
    },
    [atlasShelfIds[2]]: { latest: null, total: 0 },
  }
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    requests.push({ url, headers })
    assert.equal(headers['Accept-Profile'], 'atlas')
    if (url.pathname.endsWith('/shelves')) {
      assert.equal(url.searchParams.get('select'), 'id,slug,name,type,image:card->image->>url')
      assert.equal(url.searchParams.get('show_in_carousel'), 'eq.true')
      assert.equal(url.searchParams.get('status'), 'eq.active')
      assert.equal(url.searchParams.get('order'), 'updated_at.desc')
      assert.equal(url.searchParams.get('limit'), '5')
      return jsonResponse(shelfRows)
    }
    if (url.pathname.endsWith('/items')) {
      const shelfId = String(url.searchParams.get('main_shelf_id') ?? '').replace(/^eq\./, '')
      assert.ok(shelfId in itemsByShelf, `unexpected shelf: ${shelfId}`)
      assert.equal(url.searchParams.get('status'), 'eq.active')
      assert.equal(url.searchParams.get('merged_into_id'), 'is.null')
      assert.equal(url.searchParams.get('occurred_at'), 'not.is.null')
      assert.equal(url.searchParams.get('order'), 'occurred_at.desc,id.desc')
      if (headers.Prefer === 'count=exact') {
        assert.equal(headers.Range, '0-0')
        assert.equal(url.searchParams.has('limit'), false)
        return jsonResponse([], itemsByShelf[shelfId].total)
      }
      assert.equal(url.searchParams.get('limit'), '1')
      assert.equal(url.searchParams.get('offset'), '0')
      return jsonResponse(itemsByShelf[shelfId].latest ? [itemsByShelf[shelfId].latest] : [])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl, undefined, 'atlas').request('/')
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
        shelfType: null,
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
        shelfType: null,
      },
    ],
  })
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith('/shelves')).length, 1)
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith('/items')).length, 6)
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith('/entities')).length, 0)
})

test('Story Atlas list returns a shelf with a production UUIDv7 id', async () => {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    assert.equal(headers['Accept-Profile'], 'atlas')
    if (url.pathname.endsWith('/shelves')) {
      return jsonResponse([{ id: atlasShelfIds[0], slug: 'story-v7', name: 'Story v7' }])
    }
    if (url.pathname.endsWith('/items')) {
      assert.equal(url.searchParams.get('main_shelf_id'), `eq.${atlasShelfIds[0]}`)
      if (headers.Prefer === 'count=exact') return jsonResponse([], 1)
      return jsonResponse([
        { id: 'item-1', title: 'Latest development', summary: 'Latest summary', occurred_at: '2026-07-12T00:00:00.000Z' },
      ])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl, undefined, 'atlas').request('/')
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
        shelfType: null,
      },
    ],
  })
})

test('Story Atlas list carries the shelf card image with kind content and the shelf type', async () => {
  const shelfRows = [
    { id: atlasShelfIds[0], slug: 'story-1', name: 'Story 1', type: 'news', image: 'https://cdn.example.com/shelf.jpg' },
    { id: atlasShelfIds[1], slug: 'story-2', name: 'Story 2', type: 'topic', image: null },
  ]
  const itemShelfIds = shelfRows.map((row) => row.id)
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    assert.equal(headers['Accept-Profile'], 'atlas')
    if (url.pathname.endsWith('/shelves')) {
      assert.equal(url.searchParams.get('select'), 'id,slug,name,type,image:card->image->>url')
      assert.equal(url.searchParams.get('status'), 'eq.active')
      return jsonResponse(shelfRows)
    }
    if (url.pathname.endsWith('/items')) {
      const shelfId = String(url.searchParams.get('main_shelf_id') ?? '').replace(/^eq\./, '')
      assert.ok(itemShelfIds.includes(shelfId))
      if (headers.Prefer === 'count=exact') return jsonResponse([], 1)
      return jsonResponse([
        { id: 'item-1', title: 'Latest development', summary: 'Latest summary', occurred_at: '2026-07-12T00:00:00.000Z' },
      ])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl, undefined, 'atlas').request('/')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    stories: [
      {
        storySlug: 'story-1',
        name: 'Story 1',
        latestDevelopment: 'Latest summary',
        eventCount: 1,
        updatedAt: '2026-07-12T00:00:00.000Z',
        imageUrl: 'https://cdn.example.com/shelf.jpg',
        imageKind: 'content',
        imageAttribution: null,
        shelfType: 'news',
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
        shelfType: 'topic',
      },
    ],
  })
})

test('Story Atlas shelf image and shelf type also flow into the detail story summary', async () => {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    assert.equal(headers['Accept-Profile'], 'atlas')
    if (url.pathname.endsWith('/shelves')) {
      assert.equal(url.searchParams.get('select'), 'id,slug,name,type,image:card->image->>url')
      assert.equal(url.searchParams.get('slug'), 'eq.us-and-iran')
      assert.equal(url.searchParams.get('status'), 'eq.active')
      return jsonResponse([
        { id: atlasShelfIds[0], slug: 'us-and-iran', name: 'US and Iran', type: 'news', image: 'https://cdn.example.com/shelf.jpg' },
      ])
    }
    if (url.pathname.endsWith('/items')) {
      if (headers.Prefer === 'count=exact') return jsonResponse([], 1)
      return jsonResponse([
        { id: 'item-1', title: 'Latest development', summary: 'Latest event', occurred_at: '2026-07-12T00:00:00.000Z' },
      ])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl, undefined, 'atlas').request('/us-and-iran')
  assert.equal(response.status, 200)
  const body = await response.json() as { story: Record<string, unknown> }
  assert.deepEqual(body.story, {
    storySlug: 'us-and-iran',
    name: 'US and Iran',
    latestDevelopment: 'Latest event',
    eventCount: 1,
    updatedAt: '2026-07-12T00:00:00.000Z',
    imageUrl: 'https://cdn.example.com/shelf.jpg',
    imageKind: 'content',
    imageAttribution: null,
    shelfType: 'news',
  })
})

test('Story Atlas shelf images fail closed on empty and non-https values', async () => {
  const shelfRows = [
    { id: atlasShelfIds[0], slug: 'story-1', name: 'Story 1', type: 'news', image: '' },
    { id: atlasShelfIds[1], slug: 'story-2', name: 'Story 2', type: 'news', image: '   ' },
    { id: atlasShelfIds[2], slug: 'story-3', name: 'Story 3', type: 'news', image: 'http://cdn.example.com/shelf.jpg' },
    { id: atlasShelfIds[3], slug: 'story-4', name: 'Story 4', type: 'news', image: { url: 'https://cdn.example.com/shelf.jpg' } },
  ]
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    assert.equal(headers['Accept-Profile'], 'atlas')
    if (url.pathname.endsWith('/shelves')) {
      return jsonResponse(shelfRows)
    }
    if (url.pathname.endsWith('/items')) {
      if (headers.Prefer === 'count=exact') return jsonResponse([], 1)
      return jsonResponse([
        { id: 'item-1', title: 'Latest development', summary: 'Latest summary', occurred_at: '2026-07-12T00:00:00.000Z' },
      ])
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const response = await app(fetchImpl, undefined, 'atlas').request('/')
  assert.equal(response.status, 200)
  const body = await response.json() as { stories: Array<{ storySlug: string; imageUrl: string | null; imageKind: string | null; imageAttribution: string | null; shelfType: string | null }> }
  assert.deepEqual(body.stories.map((story) => [
    story.storySlug,
    story.imageUrl,
    story.imageKind,
    story.imageAttribution,
    story.shelfType,
  ]), [
    ['story-1', null, null, null, 'news'],
    ['story-2', null, null, null, 'news'],
    ['story-3', null, null, null, 'news'],
    ['story-4', null, null, null, 'news'],
  ])
})

test('Story Atlas shelves select the card image through card->image->>url; the legacy Entity select does not', async () => {
  const atlasShelfSelects: Array<string | null> = []
  const atlasResponse = await app(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/shelves')) {
      atlasShelfSelects.push(url.searchParams.get('select'))
      return jsonResponse([])
    }
    throw new Error(`Unexpected request: ${url}`)
  }, undefined, 'atlas').request('/')
  assert.equal(atlasResponse.status, 200)
  assert.deepEqual(await atlasResponse.json(), { stories: [] })
  assert.deepEqual(atlasShelfSelects, ['id,slug,name,type,image:card->image->>url'])
  assert.equal(atlasShelfSelects[0]?.includes('card->image->>url'), true)

  const legacyEntitySelects: Array<string | null> = []
  const legacyResponse = await app(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/entities')) {
      legacyEntitySelects.push(url.searchParams.get('select'))
      return jsonResponse([])
    }
    throw new Error(`Unexpected request: ${url}`)
  }).request('/')
  assert.equal(legacyResponse.status, 200)
  assert.deepEqual(await legacyResponse.json(), { stories: [] })
  assert.deepEqual(legacyEntitySelects, ['id,slug,name'])
  assert.equal(legacyEntitySelects[0]?.includes('card->image->>url'), false)
})

test('Story Atlas detail pages items newest-first with pagination fields', async () => {
  const requests: Array<{ url: URL; headers: Record<string, string> }> = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    requests.push({ url, headers })
    assert.equal(headers['Accept-Profile'], 'atlas')
    if (url.pathname.endsWith('/shelves')) {
      assert.equal(url.searchParams.get('slug'), 'eq.us-and-iran')
      assert.equal(url.searchParams.get('show_in_carousel'), 'eq.true')
      assert.equal(url.searchParams.get('status'), 'eq.active')
      assert.equal(url.searchParams.get('limit'), '1')
      return jsonResponse([{ id: atlasShelfIds[0], slug: 'us-and-iran', name: 'US and Iran' }])
    }
    if (url.pathname.endsWith('/items')) {
      assert.equal(url.searchParams.get('main_shelf_id'), `eq.${atlasShelfIds[0]}`)
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
  const response = await app(fetchImpl, undefined, 'atlas').request('/us-and-iran?limit=2&offset=1')
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
      shelfType: null,
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
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith('/items')).length, 3)
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
    if (url.pathname.endsWith('/shelves')) {
      return jsonResponse([{ id: atlasShelfIds[0], slug: 'bitcoin', name: 'Bitcoin' }])
    }
    if (url.pathname.endsWith('/items')) {
      itemRequests += 1
      if (headers.Prefer === 'count=exact') return jsonResponse([], 3)
      assert.equal(url.searchParams.get('limit'), '20')
      assert.equal(url.searchParams.get('offset'), '0')
      return jsonResponse(rows)
    }
    throw new Error(`Unexpected request: ${url}`)
  }, undefined, 'atlas').request('/bitcoin')
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

test('Story Atlas detail returns 404 when the shelf is not selected', async () => {
  let requests = 0
  const response = await app(async (input: RequestInfo | URL) => {
    requests += 1
    const url = new URL(String(input))
    if (url.pathname.endsWith('/shelves')) return jsonResponse([])
    throw new Error(`Unexpected request: ${url}`)
  }, undefined, 'atlas').request('/bitcoin')
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Story not found' })
  assert.equal(requests, 1)
})

test('Story Atlas failures return the generic 500 response', async () => {
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const shelvesDown = await app(
      async () => new Response('atlas shelves down', { status: 503 }),
      undefined,
      'atlas',
    ).request('/')
    assert.equal(shelvesDown.status, 500)
    assert.deepEqual(await shelvesDown.json(), { error: 'Unable to load Stories' })

    const itemsDown = await app(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/shelves')) {
        return jsonResponse([{ id: atlasShelfIds[0], slug: 'bitcoin', name: 'Bitcoin' }])
      }
      return new Response('atlas items down', { status: 503 })
    }, undefined, 'atlas').request('/bitcoin')
    assert.equal(itemsDown.status, 500)
    assert.deepEqual(await itemsDown.json(), { error: 'Unable to load Stories' })

    const countMissing = await app(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (url.pathname.endsWith('/shelves')) {
        return jsonResponse([{ id: atlasShelfIds[0], slug: 'bitcoin', name: 'Bitcoin' }])
      }
      if (headers.Prefer === 'count=exact') {
        return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
      }
      return jsonResponse([
        { id: 'item-1', title: 'First', summary: 'Latest event', occurred_at: '2026-07-12T00:00:00.000Z' },
      ])
    }, undefined, 'atlas').request('/bitcoin')
    assert.equal(countMissing.status, 500)
    assert.deepEqual(await countMissing.json(), { error: 'Unable to load Stories' })
  } finally {
    console.error = originalConsoleError
  }
})

test('Story routes default to the legacy source when source is omitted or legacy', async () => {
  for (const source of [undefined, 'legacy'] as const) {
    const requests: Array<{ url: URL; init?: RequestInit }> = []
    const response = await app(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push({ url, init })
      if (url.pathname.endsWith('/entities')) return jsonResponse([])
      throw new Error(`Unexpected request: ${url}`)
    }, undefined, source).request('/')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { stories: [] })
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.url.pathname.endsWith('/entities'), true)
    assert.equal(requests[0]?.url.pathname.endsWith('/shelves'), false)
    assert.equal((requests[0]?.init?.headers as Record<string, string>)['Accept-Profile'], undefined)
  }
})

test('Contract: Atlas and legacy Story responses share key sets and value types', async () => {
  const legacyReader: StoryMemoryReader = {
    async getEntityMemoryEvents() {
      return eventPage([
        memory(entityIds[0], 'Latest development', '2026-07-12T00:00:00.000Z'),
      ], 1)
    },
  }
  const legacyRow = { id: entityIds[0], slug: 'contract-slug', name: 'Contract Story' }
  const atlasRow = { id: atlasShelfIds[0], slug: 'contract-slug', name: 'Contract Story' }
  const legacyFetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/entities')) return jsonResponse([legacyRow])
    throw new Error(`Unexpected request: ${url}`)
  }
  const atlasFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (url.pathname.endsWith('/shelves')) return jsonResponse([atlasRow])
    if (url.pathname.endsWith('/items')) {
      if (headers.Prefer === 'count=exact') return jsonResponse([], 1)
      return jsonResponse([
        { id: 'item-1', title: 'Latest development', summary: 'Latest development', occurred_at: '2026-07-12T00:00:00.000Z' },
      ])
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const legacyList = await app(legacyFetch, legacyReader).request('/')
  const atlasList = await app(atlasFetch, undefined, 'atlas').request('/')
  assert.equal(legacyList.status, 200)
  assert.equal(atlasList.status, 200)
  const legacyListBody = await legacyList.json()
  const atlasListBody = await atlasList.json()
  assert.deepEqual(atlasListBody, legacyListBody)
  assert.deepEqual(shapeOf(atlasListBody), shapeOf(legacyListBody))

  const legacyDetail = await app(legacyFetch, legacyReader).request('/contract-slug')
  const atlasDetail = await app(atlasFetch, undefined, 'atlas').request('/contract-slug')
  assert.equal(legacyDetail.status, 200)
  assert.equal(atlasDetail.status, 200)
  const legacyDetailBody = await legacyDetail.json()
  const atlasDetailBody = await atlasDetail.json()
  assert.deepEqual(atlasDetailBody, legacyDetailBody)
  assert.deepEqual(shapeOf(atlasDetailBody), shapeOf(legacyDetailBody))
})

/**
 * Structural fingerprint for the Atlas/legacy contract: keys and value types
 * per level, array element order preserved, `null` kept distinct from a
 * missing key.
 */
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

function memory(
  entityId: string,
  summary: string,
  eventAt: string,
  extra: Record<string, unknown> = {},
): EntityKnowledgeMemoryV1 {
  const media = extra.media && typeof extra.media === 'object'
    ? extra.media as EntityKnowledgeMemoryV1['media']
    : { imageUrl: null, imageKind: null, attribution: null }
  return {
    schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION,
    id: `${entityId}-${summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)}`,
    entityId,
    memoryType: 'timeline_event',
    title: summary,
    summary,
    body: null,
    eventAt,
    observedAt: eventAt,
    confidence: 0.8,
    evidence: [], mentions: [], metrics: {}, context: {}, media,
    provenance: { provider: 'test', sourceArea: 'test', sourceType: 'news', sourceRefId: 'ref', researchPacketId: 'packet' },
    priorityClass: 'P1', createdAt: eventAt, updatedAt: eventAt,
  }
}

function eventPage(
  items: EntityKnowledgeMemoryV1[],
  totalCount: number,
  nextCursor: string | null = null,
  hasMore = false,
) {
  return { schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION, items, totalCount, nextCursor, hasMore }
}

function jsonResponse(body: unknown, total?: number): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (total !== undefined) headers['Content-Range'] = `0-0/${total}`
  return new Response(JSON.stringify(body), {
    headers,
  })
}
