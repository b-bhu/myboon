import assert from 'node:assert/strict'
import test from 'node:test'
import { createNarrativeRoutes } from './narratives.js'

const firstId = '00000000-0000-4000-8000-000000000001'
const secondId = '00000000-0000-4000-8000-000000000002'

function createApp(fetchImpl: typeof globalThis.fetch) {
  return createNarrativeRoutes({
    supabaseUrl: 'https://project.supabase.co/',
    serviceRoleKey: 'service-role-test-key',
    fetch: fetchImpl,
  })
}

test('GET / applies public Feed gates, deterministic ordering, pagination, and a strict DTO mapping', async () => {
  let requestUrl: URL | undefined
  let requestInit: RequestInit | undefined
  const app = createApp(async (input, init) => {
    requestUrl = new URL(String(input))
    requestInit = init
    return jsonResponse([
      narrativeRow(firstId, 'Bitcoin moves', 'Short update', 'Full update', '2026-07-14T12:00:00.000Z'),
      narrativeRow(secondId, 'Ethereum moves', 'Second summary', 'Second full update', '2026-07-14T11:00:00.000Z'),
    ])
  })

  const response = await app.request('/?limit=4&offset=3')

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), [
    {
      updateKey: firstId,
      title: 'Bitcoin moves',
      summary: 'Short update',
      publishedAt: '2026-07-14T12:00:00.000Z',
      imageUrl: null,
      imageKind: null,
      imageAttribution: null,
    },
    {
      updateKey: secondId,
      title: 'Ethereum moves',
      summary: 'Second summary',
      publishedAt: '2026-07-14T11:00:00.000Z',
      imageUrl: null,
      imageKind: null,
      imageAttribution: null,
    },
  ])

  assert.equal(requestUrl?.pathname, '/rest/v1/published_narratives')
  assert.equal(requestUrl?.searchParams.get('select'), 'id,title,content_small,published_at,source_memory_ids')
  assert.equal(requestUrl?.searchParams.get('status'), 'eq.published')
  assert.equal(requestUrl?.searchParams.get('entity_id'), 'not.is.null')
  assert.equal(requestUrl?.searchParams.get('title'), 'not.is.null')
  assert.equal(requestUrl?.searchParams.get('content_small'), 'not.is.null')
  assert.equal(requestUrl?.searchParams.get('content_full'), 'not.is.null')
  assert.equal(requestUrl?.searchParams.get('published_at'), 'not.is.null')
  assert.equal(requestUrl?.searchParams.get('order'), 'published_at.desc,id.desc')
  assert.equal(requestUrl?.searchParams.get('limit'), '4')
  assert.equal(requestUrl?.searchParams.get('offset'), '3')
  assert.equal(new Headers(requestInit?.headers).get('apikey'), 'service-role-test-key')
  assert.equal(new Headers(requestInit?.headers).get('authorization'), 'Bearer service-role-test-key')
})

test('GET / bounds limit and offset and uses safe defaults for invalid values', async () => {
  const urls: URL[] = []
  const app = createApp(async (input) => {
    urls.push(new URL(String(input)))
    return jsonResponse([])
  })

  assert.equal((await app.request('/?limit=999&offset=999999')).status, 200)
  assert.equal((await app.request('/?limit=-1&offset=nope')).status, 200)

  assert.equal(urls[0]?.searchParams.get('limit'), '50')
  assert.equal(urls[0]?.searchParams.get('offset'), '10000')
  assert.equal(urls[1]?.searchParams.get('limit'), '20')
  assert.equal(urls[1]?.searchParams.get('offset'), '0')
})

test('GET / skips malformed publications without taking down valid Feed items', async () => {
  const app = createApp(async () => jsonResponse([
    narrativeRow(firstId, 'Bitcoin moves', 'Short update', 'Full update', '2026-07-14T12:00:00.000Z'),
    narrativeRow(secondId, 'Missing summary', '', 'Full update', '2026-07-14T11:00:00.000Z'),
    { broken: true },
  ]))

  const response = await app.request('/')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), [{
    updateKey: firstId,
    title: 'Bitcoin moves',
    summary: 'Short update',
    publishedAt: '2026-07-14T12:00:00.000Z',
    imageUrl: null,
    imageKind: null,
    imageAttribution: null,
  }])
})

test('GET /:updateKey returns the full published Feed item and allowlists all output fields', async () => {
  let requestUrl: URL | undefined
  const app = createApp(async (input) => {
    requestUrl = new URL(String(input))
    return jsonResponse([
      narrativeRow(firstId, 'Bitcoin moves', 'Short update', 'The complete published update.', '2026-07-14T12:00:00.000Z'),
    ])
  })

  const response = await app.request(`/${firstId}`)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    updateKey: firstId,
    title: 'Bitcoin moves',
    summary: 'Short update',
    content: 'The complete published update.',
    publishedAt: '2026-07-14T12:00:00.000Z',
    imageUrl: null,
    imageKind: null,
    imageAttribution: null,
  })
  assert.equal(requestUrl?.searchParams.get('select'), 'id,title,content_small,content_full,published_at,source_memory_ids')
  assert.equal(requestUrl?.searchParams.get('id'), `eq.${firstId}`)
  assert.equal(requestUrl?.searchParams.get('status'), 'eq.published')
  assert.equal(requestUrl?.searchParams.get('entity_id'), 'not.is.null')
  assert.equal(requestUrl?.searchParams.get('limit'), '1')
})

test('GET /:updateKey rejects an invalid UUID without contacting Supabase', async () => {
  let fetchCalls = 0
  const app = createApp(async () => {
    fetchCalls += 1
    return jsonResponse([])
  })

  const response = await app.request('/not-a-uuid')

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'Bad request' })
  assert.equal(fetchCalls, 0)
})

test('GET / enriches Feed items with the preferred source-memory image', async () => {
  const contentMemoryId = '00000000-0000-4000-8000-000000000010'
  const avatarMemoryId = '00000000-0000-4000-8000-000000000011'
  const requests: URL[] = []
  const app = createApp(async (input) => {
    const url = new URL(String(input))
    requests.push(url)
    if (url.pathname.endsWith('/published_narratives')) {
      return jsonResponse([{
        ...narrativeRow(firstId, 'Bitcoin moves', 'Short update', 'Full update', '2026-07-14T12:00:00.000Z'),
        source_memory_ids: [avatarMemoryId, contentMemoryId],
      }])
    }
    assert.equal(url.pathname, '/rest/v1/entity_memories')
    assert.equal(url.searchParams.get('select'), 'id,context')
    return jsonResponse([{
      id: avatarMemoryId,
      context: {
        image_url: 'https://pbs.twimg.com/profile_images/123/avatar.jpg',
        image_kind: 'source_avatar',
        image_attribution: '@tokens',
      },
    }, {
      id: contentMemoryId,
      context: {
        image_url: 'https://pbs.twimg.com/media/story.jpg',
        image_kind: 'content',
        image_attribution: '@tokens',
      },
    }])
  })

  const response = await app.request('/')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), [{
    updateKey: firstId,
    title: 'Bitcoin moves',
    summary: 'Short update',
    publishedAt: '2026-07-14T12:00:00.000Z',
    imageUrl: 'https://pbs.twimg.com/media/story.jpg',
    imageKind: 'content',
    imageAttribution: '@tokens',
  }])
  assert.equal(requests.length, 2)
})

test('GET /:updateKey hides missing, unlinked, and archived narratives behind 404', async (context) => {
  await context.test('missing', async () => assertHidden(firstId))
  await context.test('unlinked', async () => assertHidden(firstId))
  await context.test('archived', async () => assertHidden(firstId))
})

test('GET /:updateKey hides a malformed publication behind 404', async () => {
  const app = createApp(async () => jsonResponse([
    narrativeRow(firstId, 'Missing full content', 'Short update', '', '2026-07-14T12:00:00.000Z'),
  ]))

  const response = await app.request(`/${firstId}`)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Not found' })
})

test('routes return a generic 500 when Supabase fails', async () => {
  const app = createApp(async () => new Response('database unavailable', { status: 503 }))

  const listResponse = await app.request('/')
  const detailResponse = await app.request(`/${firstId}`)

  assert.equal(listResponse.status, 500)
  assert.deepEqual(await listResponse.json(), { error: 'Internal server error' })
  assert.equal(detailResponse.status, 500)
  assert.deepEqual(await detailResponse.json(), { error: 'Internal server error' })
})

async function assertHidden(id: string): Promise<void> {
  let requestUrl: URL | undefined
  const app = createApp(async (input) => {
    requestUrl = new URL(String(input))
    return jsonResponse([])
  })
  const response = await app.request(`/${id}`)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Not found' })
  assert.equal(requestUrl?.searchParams.get('status'), 'eq.published')
  assert.equal(requestUrl?.searchParams.get('entity_id'), 'not.is.null')
}

function narrativeRow(id: string, title: string, summary: string, content: string, publishedAt: string) {
  return {
    id,
    title,
    content_small: summary,
    content_full: content,
    published_at: publishedAt,
    entity_id: 'private-entity-id',
    source_memory_ids: ['private-memory-id'],
    reasoning: 'private reasoning',
    confidence: 0.95,
    evidence: { private: true },
    status: 'published',
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}
