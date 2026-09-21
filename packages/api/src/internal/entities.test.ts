import assert from 'node:assert/strict'
import test from 'node:test'
import { createInternalEntityRoutes } from './entities.js'

const token = 'a'.repeat(48)
const entityId = '00000000-0000-4000-8000-000000000001'
const secondEntityId = '00000000-0000-4000-8000-000000000002'
const archivedEntityId = '00000000-0000-4000-8000-000000000003'

function createApp(internalToken: string | undefined = token) {
  return createInternalEntityRoutes({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: 'service-role-test-key',
    internalToken,
  })
}

test('internal entity routes reject absent, invalid, and weak credentials', async () => {
  assert.equal((await createApp().request('/entities')).status, 401)
  assert.equal((await createApp().request('/entities', {
    headers: { Authorization: 'Bearer invalid-token' },
  })).status, 401)
  assert.equal((await createApp('short').request('/entities')).status, 503)
})

test('internal entity routes return private, aggregate-backed folder data', async (context) => {
  const originalFetch = globalThis.fetch
  const requests: URL[] = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    requests.push(url)

    if (url.pathname.endsWith('/entities')) {
      return jsonResponse([{
        id: entityId,
        slug: 'ethereum',
        name: 'Ethereum',
        type: 'asset',
        aliases: ['ETH'],
        summary: 'A programmable settlement network.',
        status: 'active',
        show_in_carousel: false,
        metadata: {},
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-10T00:00:00.000Z',
      }])
    }

    if (url.pathname.endsWith('/entity_memories')) {
      return jsonResponse([])
    }

    if (url.pathname.endsWith('/rpc/internal_entity_memory_stats')) {
      return jsonResponse([{
        entity_id: entityId,
        memory_count: 12,
        latest_memory_at: '2026-07-10T00:00:00.000Z',
        source_count: 3,
        evidence_count: 8,
      }])
    }

    if (url.pathname.endsWith('/rpc/entity_manager_lookup_entities_v1')) {
      return jsonResponse([{
        id: entityId,
        slug: 'ethereum',
        name: 'Ethereum',
        type: 'asset',
        aliases: ['ETH'],
        summary: 'A programmable settlement network.',
        status: 'active',
        show_in_carousel: false,
        metadata: {},
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-10T00:00:00.000Z',
        total_count: 1,
      }])
    }

    throw new Error(`Unexpected fetch: ${url}`)
  }
  context.after(() => { globalThis.fetch = originalFetch })

  const response = await createApp().request('/entities?q=ethereum&limit=1', {
    headers: { Authorization: `Bearer ${token}` },
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
  assert.deepEqual(await response.json(), {
    entities: [{
      id: entityId,
      slug: 'ethereum',
      name: 'Ethereum',
      type: 'asset',
      status: 'active',
      showInCarousel: false,
      aliases: ['ETH'],
      summary: 'A programmable settlement network.',
      memoryCount: 12,
      latestMemoryAt: '2026-07-10T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
    }],
    nextCursor: null,
  })
  assert.equal(requests.some((request) => request.pathname.endsWith('/rpc/internal_entity_memory_stats')), true)
})

test('internal entity routes reject unsafe entity identifiers before a database read', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('database should not be called') }

  try {
    const response = await createApp().request('/entities/ethereum.or.id.not.is.null', {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(response.status, 400)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('internal entity routes provide a next cursor for standard list pagination', async (context) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/entities')) {
      return jsonResponse(url.searchParams.get('offset') === '1'
        ? [entityRow(secondEntityId, 'Solana', '2026-07-09T00:00:00.000Z')]
        : [
            entityRow(entityId, 'Ethereum', '2026-07-10T00:00:00.000Z'),
            entityRow(secondEntityId, 'Solana', '2026-07-09T00:00:00.000Z'),
          ])
    }
    if (url.pathname.endsWith('/rpc/internal_entity_memory_stats')) {
      return jsonResponse([
        { entity_id: entityId, memory_count: 12, latest_memory_at: '2026-07-10T00:00:00.000Z', source_count: 3, evidence_count: 8 },
        { entity_id: secondEntityId, memory_count: 9, latest_memory_at: '2026-07-09T00:00:00.000Z', source_count: 2, evidence_count: 4 },
      ])
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  context.after(() => { globalThis.fetch = originalFetch })

  const first = await createApp().request('/entities?limit=1', { headers: { Authorization: `Bearer ${token}` } })
  const firstBody = await first.json() as { entities: Array<{ id: string }>; nextCursor: string | null }
  assert.equal(firstBody.entities[0]?.id, entityId)
  assert.notEqual(firstBody.nextCursor, null)

  const second = await createApp().request(`/entities?limit=1&cursor=${firstBody.nextCursor}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const secondBody = await second.json() as { entities: Array<{ id: string }>; nextCursor: string | null }
  assert.equal(secondBody.entities[0]?.id, secondEntityId)
  assert.equal(secondBody.nextCursor, null)
})

test('archived UUID and stale alias timelines resolve to the active canonical Entity', async (context) => {
  const originalFetch = globalThis.fetch
  const requests: URL[] = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    requests.push(url)
    if (url.pathname.endsWith('/rpc/resolve_entity_redirects_v1')) {
      return jsonResponse([{
        input_entity_id: archivedEntityId,
        resolved_entity_id: secondEntityId,
      }])
    }
    if (url.pathname.endsWith('/rpc/entity_manager_lookup_entities_v1')) {
      return jsonResponse([{ ...entityRow(secondEntityId, 'Solana', '2026-07-10T00:00:00.000Z'), total_count: 1 }])
    }
    if (url.pathname.endsWith('/entities')) {
      if (url.searchParams.get('id') === `eq.${archivedEntityId}`) {
        return jsonResponse([{
          ...entityRow(archivedEntityId, 'Old Solana', '2026-07-09T00:00:00.000Z'),
          slug: 'old-solana',
          aliases: ['OLD-SOL'],
          status: 'archived',
        }])
      }
      if (url.searchParams.get('id') === `in.(${secondEntityId})`) {
        return jsonResponse([entityRow(secondEntityId, 'Solana', '2026-07-10T00:00:00.000Z')])
      }
    }
    if (url.pathname.endsWith('/entity_memories')) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${url}`)
  }
  context.after(() => { globalThis.fetch = originalFetch })

  const byUuid = await createApp().request(`/entities/${archivedEntityId}/timeline`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const byAlias = await createApp().request('/entities/OLD-SOL/timeline', {
    headers: { Authorization: `Bearer ${token}` },
  })

  assert.equal(byUuid.status, 200)
  assert.equal(byAlias.status, 200)
  const memoryRequests = requests.filter((request) => request.pathname.endsWith('/entity_memories'))
  assert.equal(memoryRequests.length, 2)
  assert.ok(memoryRequests.every((request) => request.searchParams.get('entity_id') === `eq.${secondEntityId}`))
})

test('Entity list canonicalizes archived rows and deduplicates their active target', async (context) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/rpc/resolve_entity_redirects_v1')) {
      return jsonResponse([{
        input_entity_id: archivedEntityId,
        resolved_entity_id: secondEntityId,
      }])
    }
    if (url.pathname.endsWith('/rpc/internal_entity_memory_stats')) {
      return jsonResponse([{
        entity_id: secondEntityId,
        memory_count: 1,
        latest_memory_at: '2026-07-10T00:00:00.000Z',
        source_count: 1,
        evidence_count: 1,
      }])
    }
    if (url.pathname.endsWith('/entities')) {
      if (url.searchParams.get('id') === `in.(${secondEntityId})`) {
        return jsonResponse([entityRow(secondEntityId, 'Solana', '2026-07-10T00:00:00.000Z')])
      }
      return jsonResponse([
        { ...entityRow(archivedEntityId, 'Old Solana', '2026-07-09T00:00:00.000Z'), status: 'archived' },
        entityRow(secondEntityId, 'Solana', '2026-07-10T00:00:00.000Z'),
      ])
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  context.after(() => { globalThis.fetch = originalFetch })

  const response = await createApp().request('/entities?limit=10', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await response.json() as { entities: Array<{ id: string; status: string }> }

  assert.equal(response.status, 200)
  assert.deepEqual(body.entities.map((entity) => entity.id), [secondEntityId])
  assert.equal(body.entities[0]?.status, 'active')
})

test('archived Entity resolution fails closed when the redirect RPC is unavailable', async (context) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/entities')) {
      return jsonResponse([{
        ...entityRow(archivedEntityId, 'Old Solana', '2026-07-09T00:00:00.000Z'),
        status: 'archived',
      }])
    }
    if (url.pathname.endsWith('/rpc/resolve_entity_redirects_v1')) {
      return new Response('unavailable', { status: 503 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  context.after(() => { globalThis.fetch = originalFetch })

  const response = await createApp().request(`/entities/${archivedEntityId}/timeline`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  assert.equal(response.status, 500)
})

function entityRow(id: string, name: string, updatedAt: string) {
  return {
    id,
    slug: name.toLowerCase(),
    name,
    type: 'asset',
    aliases: [],
    summary: null,
    status: 'active',
    show_in_carousel: false,
    metadata: {},
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: updatedAt,
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}
