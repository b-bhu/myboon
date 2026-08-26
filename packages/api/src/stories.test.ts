import assert from 'node:assert/strict'
import test from 'node:test'
import type { EntityKnowledgeMemoryV1, EntityKnowledgeReader } from '@myboon/collectors/entity-manager'
import entityManager from '@myboon/collectors/entity-manager'
import { createStoryRoutes } from './stories.js'

const { ENTITY_KNOWLEDGE_SCHEMA_VERSION } = entityManager

const entityIds = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
]

type StoryMemoryReader = Pick<EntityKnowledgeReader, 'getEntityMemoryEvents'>

function app(
  fetchImpl: typeof fetch,
  memoryReader: StoryMemoryReader = {
    async getEntityMemoryEvents() {
      return { schemaVersion: ENTITY_KNOWLEDGE_SCHEMA_VERSION, items: [], totalCount: 0, nextCursor: null, hasMore: false }
    },
  },
) {
  return createStoryRoutes({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-test-key',
    memoryReader,
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
