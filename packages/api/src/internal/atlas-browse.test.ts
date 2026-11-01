import assert from 'node:assert/strict'
import test from 'node:test'
import { createInternalAtlasBrowseRoutes } from './atlas-browse.js'

const token = 'a'.repeat(48)
const NOW = Date.parse('2026-11-01T12:00:00.000Z')
const HOUR_MS = 60 * 60 * 1000
const ENTITY_ID = '00000000-0000-4000-8000-00000000000a'

const SIGNALS_SELECT = 'signal_id,source,source_id,type,status,priority,occurred_at,fetched_at,created_at,text,excerpt,link,unusual_score,parked_reason,attempts'
const DECISIONS_SELECT = 'id,signal_id,decision,action,reason,summary,targets,confidence,model_name,analyst_version,outcome,entity_outcome,created_at'
const ENTITIES_SELECT = 'id,slug,name,type,aliases,summary,status,show_in_carousel,created_at,updated_at,entity_reviewed_at'
const ENTITY_ITEMS_SELECT = 'id,title,note,angle,signal_id,occurred_at,created_at,status,main_entity_id,entity:entities!entity_items_main_entity_id_fkey(slug,name)'

interface TestConfig {
  internalToken?: string
  fetchImpl?: typeof fetch
  now?: () => Date
}

function createApp(overrides: TestConfig = {}): ReturnType<typeof createInternalAtlasBrowseRoutes> {
  return createInternalAtlasBrowseRoutes({
    supabaseUrl: 'https://atlas-project.supabase.co',
    serviceRoleKey: 'service-role-test-key',
    internalToken: token,
    ...overrides,
  })
}

interface CapturedRequest {
  url: URL
  headers: Record<string, string>
}

function testFetch(collected: CapturedRequest[], handler: (url: URL) => Response): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input))
    collected.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    return handler(url)
  }
}

function refusingFetch(): typeof fetch {
  return async () => {
    throw new Error('upstream should not be called')
  }
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

function signalRow(signalId: string, createdAt: string): Record<string, unknown> {
  return {
    signal_id: signalId,
    source: 'twitter',
    source_id: 'x-1',
    type: 'news',
    status: 'new',
    priority: 1,
    occurred_at: '2026-11-01T10:00:00.000Z',
    fetched_at: '2026-11-01T10:05:00.000Z',
    created_at: createdAt,
    text: 'Aave governance proposal',
    excerpt: null,
    link: 'https://example.com/aave',
    unusual_score: 3,
    parked_reason: null,
    attempts: 1,
  }
}

function decisionRow(id: string, createdAt: string): Record<string, unknown> {
  return {
    id,
    signal_id: 'sig-1',
    decision: 'ignore',
    action: 'none',
    reason: 'already covered elsewhere',
    summary: 'covered by an earlier signal',
    targets: [{ entity: 'aave' }],
    confidence: 'medium',
    model_name: 'gpt-test',
    analyst_version: 'analyst-504-v1',
    outcome: null,
    entity_outcome: null,
    created_at: createdAt,
  }
}

function atlasEntityRow(id: string, updatedAt: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    slug: 'aave',
    name: 'Aave',
    type: 'protocol',
    aliases: ['AAVE'],
    summary: null,
    status: 'active',
    show_in_carousel: false,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: updatedAt,
    entity_reviewed_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

function atlasItemRow(id: string, createdAt: string): Record<string, unknown> {
  return {
    id,
    title: 'Aave ships a new version',
    note: 'worth a look',
    angle: 'new_story',
    signal_id: 'sig-1',
    occurred_at: '2026-11-01T10:00:00.000Z',
    created_at: createdAt,
    status: 'active',
    main_entity_id: ENTITY_ID,
    entity: { slug: 'aave', name: 'Aave' },
  }
}

test('internal atlas browse routes reject absent, wrong and weak internal tokens', async () => {
  const refuses = refusingFetch()
  for (const route of ['/signals', '/analyst', '/entities', '/entity-items']) {
    assert.equal((await createApp({ fetchImpl: refuses }).request(route)).status, 401)
    assert.equal((await createApp({ fetchImpl: refuses }).request(route, {
      headers: { Authorization: 'Bearer invalid-token' },
    })).status, 401)
    assert.equal((await createApp({ internalToken: 'short', fetchImpl: refuses }).request(route, {
      headers: bearer(),
    })).status, 503)
  }
})

test('atlas /signals applies since=24h as created_at gte with the atlas profile and passthrough rows', async () => {
  const collected: CapturedRequest[] = []
  const rows = [
    signalRow('sig-2', '2026-11-01T10:30:00.000Z'),
    signalRow('sig-1', '2026-11-01T10:00:00.000Z'),
  ]
  const app = createApp({
    now: () => new Date(NOW),
    fetchImpl: testFetch(collected, (url) => {
      assert.equal(url.pathname, '/rest/v1/signals')
      return jsonResponse(rows)
    }),
  })

  const response = await app.request('/signals?since=24h', { headers: bearer() })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
  assert.equal(response.headers.get('vary'), 'Authorization')

  const request = collected[0]
  assert.ok(request, 'signals upstream request was captured')
  assert.equal(request.headers['Accept-Profile'], 'atlas')
  assert.equal(request.headers['apikey'], 'service-role-test-key')
  assert.equal(request.headers['Authorization'], 'Bearer service-role-test-key')
  assert.equal(request.url.searchParams.get('created_at'), `gte.${new Date(NOW - 24 * HOUR_MS).toISOString()}`)
  assert.equal(request.url.searchParams.get('order'), 'created_at.desc,signal_id.desc')
  assert.equal(request.url.searchParams.get('limit'), '51')
  assert.equal(request.url.searchParams.get('select'), SIGNALS_SELECT)

  const body = await response.json() as { signals: unknown[]; nextCursor: string | null; limit: number }
  assert.deepEqual(body.signals, rows)
  assert.equal(body.nextCursor, null)
  assert.equal(body.limit, 50)
})

test('atlas /signals clamps limit in the body and the upstream request', async () => {
  const collected: CapturedRequest[] = []
  const app = createApp({
    now: () => new Date(NOW),
    fetchImpl: testFetch(collected, () => jsonResponse([signalRow('sig-1', '2026-11-01T11:00:00.000Z')])),
  })

  const capped = await app.request('/signals?limit=10000', { headers: bearer() })
  const cappedBody = await capped.json() as { limit: number; signals: unknown[] }
  assert.equal(capped.status, 200)
  assert.equal(collected[0]?.url.searchParams.get('limit'), '201')
  assert.equal(cappedBody.limit, 200)
  assert.equal(cappedBody.signals.length, 1)

  const fallthrough = await app.request('/signals?limit=not-a-number', { headers: bearer() })
  const fallthroughBody = await fallthrough.json() as { limit: number }
  assert.equal(collected[1]?.url.searchParams.get('limit'), '51')
  assert.equal(fallthroughBody.limit, 50)

  const minimum = await app.request('/signals?limit=0', { headers: bearer() })
  assert.equal(collected[2]?.url.searchParams.get('limit'), '2')
  assert.equal((await minimum.json() as { limit: number }).limit, 1)
})

test('atlas /analyst applies decision, entity and signal_id filters verbatim', async () => {
  const collected: CapturedRequest[] = []
  const rows = [decisionRow('decision-1', '2026-11-01T11:00:00.000Z')]
  const app = createApp({
    now: () => new Date(NOW),
    fetchImpl: testFetch(collected, () => jsonResponse(rows)),
  })

  const response = await app.request('/analyst?decision=ignore&entity=uniswap&signal_id=S-2026-x.1', { headers: bearer() })
  assert.equal(response.status, 200)

  const request = collected[0]
  assert.ok(request)
  assert.equal(request.url.pathname, '/rest/v1/decisions')
  assert.equal(request.url.searchParams.get('select'), DECISIONS_SELECT)
  assert.equal(request.url.searchParams.get('decision'), 'eq.ignore')
  assert.equal(request.url.searchParams.get('targets'), 'cs.[{"entity":"uniswap"}]')
  assert.equal(request.url.searchParams.get('signal_id'), 'eq.S-2026-x.1')
  assert.equal(request.url.searchParams.get('order'), 'created_at.desc,id.desc')

  const body = await response.json() as { decisions: unknown[]; nextCursor: string | null; limit: number }
  assert.deepEqual(body.decisions, rows)
  assert.equal(body.nextCursor, null)
  assert.equal(body.limit, 50)
})

test('atlas /analyst rejects unknown decision, bad entity slugs and unsafe signal ids', async () => {
  const refuses = refusingFetch()
  const app = createApp({ fetchImpl: refuses })

  const decision = await app.request('/analyst?decision=maybe', { headers: bearer() })
  assert.equal(decision.status, 400)
  assert.deepEqual(await decision.json(), { error: 'Invalid decision' })

  const entity = await app.request('/analyst?entity=UniSwap', { headers: bearer() })
  assert.equal(entity.status, 400)
  assert.deepEqual(await entity.json(), { error: 'Invalid entity' })

  const signalId = await app.request('/analyst?signal_id=bad id!', { headers: bearer() })
  assert.equal(signalId.status, 400)
  assert.deepEqual(await signalId.json(), { error: 'Invalid signal_id' })
})

test('atlas /entities applies type, status, carousel, q and since filters', async () => {
  const collected: CapturedRequest[] = []
  const rows = [
    atlasEntityRow('entity-1', '2026-11-01T09:00:00.000Z'),
    atlasEntityRow('entity-2', '2026-10-01T00:00:00.000Z', { slug: 'stable', name: 'Stable' }),
  ]
  const app = createApp({
    now: () => new Date(NOW),
    fetchImpl: testFetch(collected, () => jsonResponse(rows)),
  })

  const response = await app.request('/entities?carousel=true&type=protocol&status=retired&since=3d&q=stable', { headers: bearer() })
  assert.equal(response.status, 200)

  const request = collected[0]
  assert.ok(request)
  assert.equal(request.url.pathname, '/rest/v1/entities')
  assert.equal(request.url.searchParams.get('select'), ENTITIES_SELECT)
  assert.equal(request.url.searchParams.get('show_in_carousel'), 'eq.true')
  assert.equal(request.url.searchParams.get('type'), 'eq.protocol')
  assert.equal(request.url.searchParams.get('status'), 'eq.retired')
  assert.equal(request.url.searchParams.get('updated_at'), `gte.${new Date(NOW - 72 * HOUR_MS).toISOString()}`)
  assert.equal(request.url.searchParams.get('or'), '(name.ilike.*stable*,slug.ilike.*stable*,aliases.cs.{stable})')
  assert.equal(request.url.searchParams.get('order'), 'updated_at.desc,id.desc')

  const body = await response.json() as { entities: unknown[]; nextCursor: string | null; limit: number }
  assert.deepEqual(body.entities, rows)
  assert.equal(body.nextCursor, null)
  assert.equal(body.limit, 50)
})

test('atlas /entities rejects unknown type, unsafe status words and non-boolean carousel', async () => {
  const refuses = refusingFetch()
  const app = createApp({ fetchImpl: refuses })

  for (const [query, expected] of [
    ['type=token', 'Invalid type'],
    ['status=active;drop', 'Invalid status'],
    ['carousel=yes', 'Invalid carousel'],
  ] as const) {
    const response = await app.request(`/entities?${query}`, { headers: bearer() })
    assert.equal(response.status, 400, query)
    assert.deepEqual(await response.json(), { error: expected })
  }
})

test('atlas /entity-items resolves the entity slug, reads items and flattens the embed', async () => {
  const collected: CapturedRequest[] = []
  const row = atlasItemRow('item-1', '2026-11-01T11:00:00.000Z')
  const app = createApp({
    now: () => new Date(NOW),
    fetchImpl: testFetch(collected, (url) => {
      if (url.pathname === '/rest/v1/entities') {
        assert.equal(url.searchParams.get('select'), 'id')
        assert.equal(url.searchParams.get('slug'), 'eq.aave')
        assert.equal(url.searchParams.get('limit'), '1')
        return jsonResponse([{ id: ENTITY_ID }])
      }
      if (url.pathname === '/rest/v1/entity_items') return jsonResponse([row])
      throw new Error(`Unexpected fetch: ${url}`)
    }),
  })

  const response = await app.request('/entity-items?entity=aave&since=2d&until=1d', { headers: bearer() })
  assert.equal(response.status, 200)

  assert.equal(collected.length, 2)
  const lookup = collected[0]
  assert.equal(lookup?.url.pathname, '/rest/v1/entities')
  assert.equal(lookup?.headers['Accept-Profile'], 'atlas')
  const itemsRequest = collected[1]
  assert.ok(itemsRequest)
  assert.equal(itemsRequest.url.pathname, '/rest/v1/entity_items')
  assert.equal(itemsRequest.headers['Accept-Profile'], 'atlas')
  assert.equal(itemsRequest.url.searchParams.get('main_entity_id'), `eq.${ENTITY_ID}`)
  assert.deepEqual(itemsRequest.url.searchParams.getAll('created_at'), [
    `gte.${new Date(NOW - 48 * HOUR_MS).toISOString()}`,
    `lte.${new Date(NOW - 24 * HOUR_MS).toISOString()}`,
  ])
  assert.equal(itemsRequest.url.searchParams.get('order'), 'created_at.desc,id.desc')
  assert.equal(itemsRequest.url.searchParams.get('limit'), '51')
  assert.equal(itemsRequest.url.searchParams.get('select'), ENTITY_ITEMS_SELECT)

  const { entity: _entity, ...rest } = row
  const body = await response.json() as { items: unknown[]; nextCursor: string | null; limit: number }
  assert.deepEqual(body.items, [{ ...rest, entity_slug: 'aave', entity_name: 'Aave' }])
  assert.equal(body.nextCursor, null)
  assert.equal(body.limit, 50)
})

test('atlas /entity-items returns an empty page when the entity slug is unknown', async () => {
  const collected: CapturedRequest[] = []
  const app = createApp({
    fetchImpl: testFetch(collected, (url) => {
      if (url.pathname === '/rest/v1/entities') return jsonResponse([])
      throw new Error(`Unexpected fetch: ${url}`)
    }),
  })

  const response = await app.request('/entity-items?entity=ghost-entity&signal_id=bogus', { headers: bearer() })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { items: [], nextCursor: null, limit: 50 })
  assert.equal(collected.length, 1, 'no entity_items read happens for an unknown slug')
})

test('atlas /entity-items rejects bad slugs and unknown angles before reading', async () => {
  const refuses = refusingFetch()
  const app = createApp({ fetchImpl: refuses })

  const entity = await app.request('/entity-items?entity=aave?', { headers: bearer() })
  assert.equal(entity.status, 400)
  assert.deepEqual(await entity.json(), { error: 'Invalid entity' })

  const angle = await app.request('/entity-items?angle=duplicate', { headers: bearer() })
  assert.equal(angle.status, 400)
  assert.deepEqual(await angle.json(), { error: 'Invalid angle' })
})

test('atlas /signals paginates with a keyset cursor round-trip', async () => {
  const collected: CapturedRequest[] = []
  const rowA = signalRow('sig-aa', '2026-11-01T11:00:00.000Z')
  const rowB = signalRow('sig-bb', '2026-11-01T10:30:00.000Z')
  const app = createApp({
    fetchImpl: testFetch(collected, (url) => {
      return url.searchParams.get('or') ? jsonResponse([rowB]) : jsonResponse([rowA, rowB])
    }),
  })

  const first = await app.request('/signals?limit=1', { headers: bearer() })
  const firstBody = await first.json() as { signals: unknown[]; nextCursor: string | null }
  assert.deepEqual(firstBody.signals, [rowA])
  assert.ok(firstBody.nextCursor)
  assert.deepEqual(
    JSON.parse(Buffer.from(firstBody.nextCursor, 'base64url').toString('utf8')),
    { t: '2026-11-01T11:00:00.000Z', id: 'sig-aa' },
  )

  const second = await app.request(`/signals?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`, { headers: bearer() })
  const secondBody = await second.json() as { signals: unknown[]; nextCursor: string | null }
  assert.deepEqual(secondBody.signals, [rowB])
  assert.equal(secondBody.nextCursor, null)
  assert.equal(collected[1]?.url.searchParams.get('or'),
    '(created_at.lt.2026-11-01T11:00:00.000Z,and(created_at.eq.2026-11-01T11:00:00.000Z,signal_id.lt.sig-aa))')
})

test('atlas /entities paginates on updated_at instead of created_at', async () => {
  const collected: CapturedRequest[] = []
  const rowA = atlasEntityRow('entity-aa', '2026-11-01T09:00:00.000Z')
  const rowB = atlasEntityRow('entity-bb', '2026-10-01T00:00:00.000Z')
  const app = createApp({
    fetchImpl: testFetch(collected, (url) => {
      return url.searchParams.get('or') ? jsonResponse([rowB]) : jsonResponse([rowA, rowB])
    }),
  })

  const first = await app.request('/entities?limit=1', { headers: bearer() })
  const firstBody = await first.json() as { entities: unknown[]; nextCursor: string | null }
  assert.deepEqual(firstBody.entities, [rowA])
  assert.ok(firstBody.nextCursor)

  const second = await app.request(`/entities?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`, { headers: bearer() })
  const secondBody = await second.json() as { entities: unknown[]; nextCursor: string | null }
  assert.deepEqual(secondBody.entities, [rowB])
  assert.equal(collected[1]?.url.searchParams.get('or'),
    '(updated_at.lt.2026-11-01T09:00:00.000Z,and(updated_at.eq.2026-11-01T09:00:00.000Z,id.lt.entity-aa))')
})

test('atlas /signals text search requires a window of 7d or less and defaults to the last 7 days', async () => {
  const refuses = refusingFetch()
  const app = createApp({ fetchImpl: refuses, now: () => new Date(NOW) })

  const tooWide = await app.request('/signals?q=trading&since=30d', { headers: bearer() })
  assert.equal(tooWide.status, 400)
  assert.deepEqual(await tooWide.json(), { error: 'q search needs a window of 7d or less' })

  const collected: CapturedRequest[] = []
  const defaulting = createApp({
    now: () => new Date(NOW),
    fetchImpl: testFetch(collected, () => jsonResponse([])),
  })
  await defaulting.request('/signals?q=trading', { headers: bearer() })
  assert.equal(collected[0]?.url.searchParams.get('created_at'), `gte.${new Date(NOW - 7 * 24 * HOUR_MS).toISOString()}`)
  assert.equal(collected[0]?.url.searchParams.get('text'), 'ilike.*trading*')
})

test('atlas /signals rejects reserved characters and short or long q values', async () => {
  const refuses = refusingFetch()
  const app = createApp({ fetchImpl: refuses })

  for (const q of ['a*b', 'a,b', 'a)b', 'a(b', 'a{b}', 'a', '']) {
    if (!q) continue
    const response = await app.request(`/signals?q=${encodeURIComponent(q)}`, { headers: bearer() })
    assert.equal(response.status, 400, q)
    assert.deepEqual(await response.json(), { error: 'Invalid q' })
  }
})

test('atlas browse routes validate since, until and cursor at the boundary', async () => {
  const refuses = refusingFetch()
  const app = createApp({ fetchImpl: refuses })

  const badSince = await app.request('/signals?since=yesterday', { headers: bearer() })
  assert.equal(badSince.status, 400)
  assert.deepEqual(await badSince.json(), { error: 'Invalid since' })

  const badUntil = await app.request('/analyst?until=2026-13-05', { headers: bearer() })
  assert.equal(badUntil.status, 400)
  assert.deepEqual(await badUntil.json(), { error: 'Invalid until' })

  const backwards = await app.request('/analyst?since=1d&until=2d', { headers: bearer() })
  assert.equal(backwards.status, 400)

  const garbledCursor = Buffer.from('{').toString('base64url')
  const badCursor = await app.request(`/signals?cursor=${garbledCursor}`, { headers: bearer() })
  assert.equal(badCursor.status, 400)
  assert.deepEqual(await badCursor.json(), { error: 'Invalid cursor' })

  const unsafeIdCursor = Buffer.from(JSON.stringify({ t: '2026-11-01T00:00:00.000Z', id: 'a;b' }), 'utf8').toString('base64url')
  const badCursorId = await app.request(`/signals?cursor=${unsafeIdCursor}`, { headers: bearer() })
  assert.equal(badCursorId.status, 400)
  assert.deepEqual(await badCursorId.json(), { error: 'Invalid cursor' })
})

test('atlas browse routes answer upstream failures with a JSON 502', async () => {
  const signals = await createApp({
    fetchImpl: async () => new Response('boom', { status: 500 }),
  }).request('/signals', { headers: bearer() })
  assert.equal(signals.status, 502)
  assert.deepEqual(await signals.json(), { error: 'Upstream read failed' })
  assert.match(signals.headers.get('cache-control') ?? '', /no-store/)

  const items = await createApp({
    fetchImpl: async () => {
      throw new Error('connection reset')
    },
  }).request('/entity-items?entity=aave', { headers: bearer() })
  assert.equal(items.status, 502)
  assert.deepEqual(await items.json(), { error: 'Upstream read failed' })
})