import assert from 'node:assert/strict'
import test from 'node:test'
import { createStoryRoutes } from './stories.js'

const entityIds = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
]

function app(fetchImpl: typeof fetch) {
  return createStoryRoutes({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-test-key',
    fetch: fetchImpl,
  })
}

test('Story list selects and caps Entities, batch-loads memories, excludes markers, and allowlists output', async () => {
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

    if (url.pathname.endsWith('/entity_memories')) {
      assert.equal(url.searchParams.get('select'), 'entity_id,memory_type,summary,event_at,context')
      assert.equal(url.searchParams.get('memory_type'), 'neq.source_marker')
      assert.equal(url.searchParams.get('order'), 'event_at.asc')
      assert.match(url.searchParams.get('entity_id') ?? '', /^in\.\(.+\)$/)
      return jsonResponse([
        memory(entityIds[0], 'Latest development', '2026-07-12T00:00:00.000Z', {
          source: 'private source',
          evidence: [{ private: true }],
          body: 'private body',
          context: {
            image_url: 'https://cdn.example.com/latest.jpg',
            image_kind: 'content',
            image_attribution: 'Example News',
            private: true,
          },
        }),
        memory(entityIds[0], 'Processing marker', '2026-07-11T12:00:00.000Z', {
          memory_type: 'source_marker',
        }),
        memory(entityIds[0], 'First development', '2026-07-10T00:00:00.000Z'),
        memory(entityIds[1], 'Only development', '2026-07-09T00:00:00.000Z', {
          context: {
            image_kind: 'content',
            image_origin: 'hallucinated',
            image_attribution: 'Fake Outlet',
          },
        }),
        memory(entityIds[5], 'Outside the five-Story cap', '2026-07-13T00:00:00.000Z'),
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
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith('/entity_memories')).length, 1)
  assert.equal(requests[0]?.init?.headers instanceof Headers, false)
  assert.deepEqual(requests[0]?.init?.headers, {
    apikey: 'service-role-test-key',
    Authorization: 'Bearer service-role-test-key',
    Accept: 'application/json',
  })
})

test('Story detail returns the selected Entity timeline oldest-to-newest with public fields only', async () => {
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
    if (url.pathname.endsWith('/entity_memories')) {
      return jsonResponse([
        memory(entityIds[0], 'Third event', '2026-07-12T00:00:00.000Z', { metrics: { private: true } }),
        memory(entityIds[0], 'First event', '2026-07-10T00:00:00.000Z', {
          context: {
            image_url: 'https://pbs.twimg.com/profile_images/123/avatar.jpg',
            image_kind: 'source_avatar',
            image_attribution: '@tokens',
            private: true,
          },
        }),
        memory(entityIds[0], 'Marker', '2026-07-10T12:00:00.000Z', { memory_type: 'source_marker' }),
        memory(entityIds[0], 'Second event', '2026-07-11T00:00:00.000Z', { reasoning: 'private' }),
      ])
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const response = await app(fetchImpl).request('/us-and-iran')
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
        text: 'First event',
        eventAt: '2026-07-10T00:00:00.000Z',
        imageUrl: 'https://pbs.twimg.com/profile_images/123/avatar.jpg',
        imageKind: 'source_avatar',
        imageAttribution: '@tokens',
      },
      {
        text: 'Second event',
        eventAt: '2026-07-11T00:00:00.000Z',
        imageUrl: null,
        imageKind: null,
        imageAttribution: null,
      },
      {
        text: 'Third event',
        eventAt: '2026-07-12T00:00:00.000Z',
        imageUrl: null,
        imageKind: null,
        imageAttribution: null,
      },
    ],
  })
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
    return jsonResponse([
      memory(entityIds[0], 'Marker only', '2026-07-12T00:00:00.000Z', { memory_type: 'source_marker' }),
    ])
  }
  const response = await app(fetchImpl).request('/bitcoin')
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Story not found' })
  assert.equal(requests, 2)
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
) {
  return {
    entity_id: entityId,
    memory_type: 'timeline_event',
    summary,
    event_at: eventAt,
    id: 'private-memory-id',
    ...extra,
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}
