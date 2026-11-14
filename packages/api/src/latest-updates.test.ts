import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Hono } from 'hono'
import type { LatestUpdatesResponse } from '@myboon/shared/latest-updates'
import { createLatestUpdateRoutes } from './latest-updates.js'
import { createNarrativeRoutes } from './narratives.js'
import { createStoryRoutes } from './stories.js'

type Row = Record<string, unknown>
interface Db {
  latest_updates: Row[]
  latest_update_items: Row[]
  entities: Row[]
  entity_items: Row[]
  item_signals: Row[]
  signals: Row[]
}
interface Seen { method: string, table: string, params: URLSearchParams, headers: Headers, hasBody: boolean }

const ENTITY_A = '01a17278-8e25-7492-bfb0-d207605a92a1'
const ENTITY_B = '01a17278-8e25-7492-bfb0-d207605a92a2'
const ENTITY_C = '01a17278-8e25-7492-bfb0-d207605a92a3'
const SERVICE_KEY = 'service-role-test-key'
const SIGNAL_1 = 'a'.repeat(64)
const SIGNAL_2 = 'b'.repeat(64)
const SIGNAL_3 = 'c'.repeat(64)

let counter = 0
function uuid(): string {
  counter += 1
  return `01a1d000-0000-7000-8000-${String(counter).padStart(12, '0')}`
}

function emptyDb(): Db {
  return { latest_updates: [], latest_update_items: [], entities: [], entity_items: [], item_signals: [], signals: [] }
}

function addEntity(db: Db, id: string, slug: string, name: string, type = 'asset', status = 'active'): void {
  db.entities.push({ id, slug, name, type, status })
}

function addItem(db: Db, id: string, title: string, occurredAt: string, signalId: string | null): void {
  db.entity_items.push({ id, title, occurred_at: occurredAt, signal_id: signalId })
}

function addUpdate(
  db: Db,
  entityId: string,
  visibility: 'live' | 'dark',
  publishedAt: string,
  itemIds: string[] = [],
  overrides: Row = {},
): string {
  const id = uuid()
  db.latest_updates.push({
    id,
    entity_id: entityId,
    headline: `Headline ${id.slice(-4)}`,
    what_happened: 'What happened.',
    how_we_got_here: 'How we got here.',
    what_to_watch: 'Watch the Dec 10 decision.',
    // Internal columns a leaky route could return.
    claims: [{ text: 'secret claim' }],
    model: 'glm-5.3-flash',
    run_id: uuid(),
    editor_version: 'v1',
    newest_entity_item_id: itemIds[0] ?? uuid(),
    visibility,
    published_at: publishedAt,
    created_at: publishedAt,
    ...overrides,
  })
  for (const itemId of itemIds) db.latest_update_items.push({ latest_update_id: id, entity_item_id: itemId })
  return id
}

/** A small in-memory PostgREST: eq / in / not-null filters, order, limit and offset on the six tables. */
function fakeRest(db: Db, options: { failTable?: string } = {}) {
  const seen: Seen[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const table = url.pathname.split('/').pop() as keyof Db
    seen.push({
      method: init?.method ?? 'GET',
      table,
      params: url.searchParams,
      headers: new Headers(init?.headers),
      hasBody: init?.body !== undefined && init?.body !== null,
    })
    if (options.failTable === table) return new Response('boom', { status: 503 })
    let rows = [...(db[table] ?? [])]
    for (const [key, value] of url.searchParams) {
      if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset') continue
      if (value.startsWith('eq.')) rows = rows.filter((row) => String(row[key]) === value.slice(3))
      else if (value.startsWith('in.(')) {
        const wanted = new Set(value.slice(4, -1).split(','))
        rows = rows.filter((row) => wanted.has(String(row[key])))
      } else throw new Error(`unsupported filter ${key}=${value}`)
    }
    const order = url.searchParams.get('order')
    if (order) {
      const keys = order.split(',').map((part) => part.split('.') as [string, string])
      rows.sort((a, b) => {
        for (const [column, direction] of keys) {
          const x = String(a[column])
          const y = String(b[column])
          if (x !== y) return (x < y ? -1 : 1) * (direction === 'desc' ? -1 : 1)
        }
        return 0
      })
    }
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const limit = url.searchParams.get('limit')
    rows = rows.slice(offset, limit ? offset + Number(limit) : undefined)
    const select = (url.searchParams.get('select') ?? '').split(',').filter(Boolean)
    const projected = rows.map((row) => select.length ? Object.fromEntries(select.map((column) => [column, row[column]])) : row)
    return new Response(JSON.stringify(projected), { headers: { 'Content-Type': 'application/json' } })
  }
  return { fetchImpl: fetchImpl as typeof fetch, seen }
}

function routes(fetchImpl: typeof fetch): Hono {
  return createLatestUpdateRoutes({ supabaseUrl: 'https://project.supabase.co/', serviceRoleKey: SERVICE_KEY, fetch: fetchImpl })
}

async function get(app: Hono, path = '/'): Promise<{ status: number, body: LatestUpdatesResponse & { error?: string } }> {
  const response = await app.request(path)
  return { status: response.status, body: await response.json() as LatestUpdatesResponse & { error?: string } }
}

function seedBasics(db: Db): void {
  addEntity(db, ENTITY_A, 'bitcoin', 'Bitcoin')
  addEntity(db, ENTITY_B, 'ethereum', 'Ethereum')
  addEntity(db, ENTITY_C, 'solana', 'Solana')
  db.signals.push(
    { signal_id: SIGNAL_1, link: 'https://example.com/a' },
    { signal_id: SIGNAL_2, link: 'https://example.com/b' },
    { signal_id: SIGNAL_3, link: 'https://example.com/c' },
  )
}

test('only dark rows: returns an empty list with HTTP 200 and reads nothing beyond the update list', async () => {
  const db = emptyDb()
  seedBasics(db)
  addUpdate(db, ENTITY_A, 'dark', '2026-11-14T01:00:00+00:00')
  addUpdate(db, ENTITY_B, 'dark', '2026-11-14T02:00:00+00:00')
  const { fetchImpl, seen } = fakeRest(db)

  const { status, body } = await get(routes(fetchImpl))

  assert.equal(status, 200)
  assert.deepEqual(body, { updates: [] })
  assert.deepEqual(seen.map((read) => read.table), ['latest_updates'])
  assert.equal(seen[0]!.params.get('visibility'), 'eq.live')
})

test('empty database: returns an empty list with HTTP 200', async () => {
  const { fetchImpl } = fakeRest(emptyDb())
  const { status, body } = await get(routes(fetchImpl))
  assert.equal(status, 200)
  assert.deepEqual(body, { updates: [] })
})

test('newest live row per entity with sources joined, ordered by publishedAt across entities, exact public shape', async () => {
  const db = emptyDb()
  seedBasics(db)
  const itemOld = uuid()
  const itemNew = uuid()
  const itemOther = uuid()
  addItem(db, itemOld, 'Older source', '2026-11-10T10:00:00+00:00', SIGNAL_1)
  addItem(db, itemNew, 'Newer source', '2026-11-10T14:26:06+00:00', SIGNAL_2)
  addItem(db, itemOther, 'Ethereum source', '2026-11-10T12:00:00+00:00', null)
  // Origin link comes from item_signals (role origin) and wins over the item's own signal_id.
  db.item_signals.push(
    { item_id: itemNew, signal_id: SIGNAL_3, role: 'origin' },
    { item_id: itemOther, signal_id: SIGNAL_2, role: 'origin' },
  )
  const staleBitcoin = addUpdate(db, ENTITY_A, 'live', '2026-11-13T00:00:00+00:00', [itemOld])
  const newestBitcoin = addUpdate(db, ENTITY_A, 'live', '2026-11-14T01:00:00+00:00', [itemOld, itemNew])
  const ethereum = addUpdate(db, ENTITY_B, 'live', '2026-11-14T03:00:00+00:00', [itemOther])
  const { fetchImpl } = fakeRest(db)

  const { status, body } = await get(routes(fetchImpl))

  assert.equal(status, 200)
  assert.deepEqual(body.updates.map((update) => update.id), [ethereum, newestBitcoin])
  assert.ok(!body.updates.some((update) => update.id === staleBitcoin))
  assert.deepEqual(body.updates[1], {
    id: newestBitcoin,
    entitySlug: 'bitcoin',
    entityName: 'Bitcoin',
    entityType: 'asset',
    headline: `Headline ${newestBitcoin.slice(-4)}`,
    whatHappened: 'What happened.',
    howWeGotHere: 'How we got here.',
    whatToWatch: 'Watch the Dec 10 decision.',
    sources: [
      { itemId: itemNew, title: 'Newer source', link: 'https://example.com/c', occurredAt: '2026-11-10T14:26:06+00:00' },
      { itemId: itemOld, title: 'Older source', link: 'https://example.com/a', occurredAt: '2026-11-10T10:00:00+00:00' },
    ],
    publishedAt: '2026-11-14T01:00:00+00:00',
  })
  assert.deepEqual(body.updates[0]!.sources, [
    { itemId: itemOther, title: 'Ethereum source', link: 'https://example.com/b', occurredAt: '2026-11-10T12:00:00+00:00' },
  ])
  for (const update of body.updates) {
    assert.deepEqual(Object.keys(update).sort(), [
      'entityName', 'entitySlug', 'entityType', 'headline', 'howWeGotHere', 'id',
      'publishedAt', 'sources', 'whatHappened', 'whatToWatch',
    ])
  }
  const text = JSON.stringify(body)
  for (const forbidden of ['claims', 'secret claim', 'model', 'glm-5.3', 'run_id', 'visibility', 'editor_version']) {
    assert.ok(!text.includes(forbidden), `${forbidden} must not be returned`)
  }
})

test('an earlier dark row and a newer live row: the live row is returned; a newer dark row never hides or replaces the live one', async () => {
  const db = emptyDb()
  seedBasics(db)
  const liveNewer = addUpdate(db, ENTITY_A, 'live', '2026-11-14T02:00:00+00:00')
  addUpdate(db, ENTITY_A, 'dark', '2026-11-14T01:00:00+00:00')
  addUpdate(db, ENTITY_B, 'dark', '2026-11-14T05:00:00+00:00')
  const liveOlder = addUpdate(db, ENTITY_B, 'live', '2026-11-13T05:00:00+00:00')
  addUpdate(db, ENTITY_C, 'dark', '2026-11-14T06:00:00+00:00')
  const { fetchImpl } = fakeRest(db)

  const { body } = await get(routes(fetchImpl))

  assert.deepEqual(body.updates.map((update) => update.id), [liveNewer, liveOlder])
  assert.deepEqual(body.updates.map((update) => update.entitySlug), ['bitcoin', 'ethereum'])
})

test('a live row whose source has no usable link keeps the update and drops only that source', async () => {
  const db = emptyDb()
  seedBasics(db)
  const good = uuid()
  const noSignal = uuid()
  const badLink = uuid()
  addItem(db, good, 'Good', '2026-11-10T10:00:00+00:00', SIGNAL_1)
  addItem(db, noSignal, 'No signal', '2026-11-10T09:00:00+00:00', null)
  addItem(db, badLink, 'Bad link', '2026-11-10T08:00:00+00:00', 'd'.repeat(64))
  db.signals.push({ signal_id: 'd'.repeat(64), link: 'javascript:alert(1)' })
  addUpdate(db, ENTITY_A, 'live', '2026-11-14T01:00:00+00:00', [good, noSignal, badLink])
  const { fetchImpl } = fakeRest(db)

  const { body } = await get(routes(fetchImpl))

  assert.equal(body.updates.length, 1)
  assert.deepEqual(body.updates[0]!.sources.map((source) => source.itemId), [good])
})

test('malformed live rows and rows whose entity is missing are skipped; the rest are returned', async () => {
  const db = emptyDb()
  seedBasics(db)
  const ghostEntity = '01a17278-8e25-7492-bfb0-d207605a9999'
  addUpdate(db, ghostEntity, 'live', '2026-11-14T09:00:00+00:00')
  addUpdate(db, ENTITY_C, 'live', '2026-11-14T08:00:00+00:00', [], { headline: '   ' })
  addUpdate(db, ENTITY_C, 'live', 'not-a-date')
  const ok = addUpdate(db, ENTITY_A, 'live', '2026-11-14T01:00:00+00:00')
  const { fetchImpl } = fakeRest(db)

  const { status, body } = await get(routes(fetchImpl))

  assert.equal(status, 200)
  assert.deepEqual(body.updates.map((update) => update.id), [ok])
})

test('limit: default 12, missing or non-numeric uses 12, 0 becomes 1, over 30 becomes 30', async () => {
  const db = emptyDb()
  for (let i = 0; i < 40; i += 1) {
    const entityId = `01a17278-8e25-7492-bfb0-d207605b${String(i).padStart(4, '0')}`
    addEntity(db, entityId, `entity-${i}`, `Entity ${i}`)
    addUpdate(db, entityId, 'live', new Date(Date.parse('2026-11-14T00:00:00Z') + i * 60_000).toISOString())
  }
  const { fetchImpl } = fakeRest(db)
  const app = routes(fetchImpl)
  const count = async (query: string) => (await get(app, `/${query}`)).body.updates.length

  assert.equal(await count(''), 12)
  assert.equal(await count('?limit=abc'), 12)
  assert.equal(await count('?limit=-5'), 12)
  assert.equal(await count('?limit=1.5'), 12)
  assert.equal(await count('?limit='), 12)
  assert.equal(await count('?limit=0'), 1)
  assert.equal(await count('?limit=1'), 1)
  assert.equal(await count('?limit=7'), 7)
  assert.equal(await count('?limit=30'), 30)
  assert.equal(await count('?limit=31'), 30)
  assert.equal(await count('?limit=100000'), 30)
  assert.equal(await count('?limit=99999999999999999999'), 12)
  const newest = (await get(app, '/?limit=3')).body.updates.map((update) => update.entitySlug)
  assert.deepEqual(newest, ['entity-39', 'entity-38', 'entity-37'])
})

test('one entity with more live rows than a page does not crowd out other entities', async () => {
  const db = emptyDb()
  seedBasics(db)
  for (let i = 0; i < 130; i += 1) {
    addUpdate(db, ENTITY_A, 'live', new Date(Date.parse('2026-11-14T12:00:00Z') - i * 60_000).toISOString())
  }
  const other = addUpdate(db, ENTITY_B, 'live', '2026-11-14T08:00:00+00:00')
  const { fetchImpl, seen } = fakeRest(db)

  const { body } = await get(routes(fetchImpl))

  assert.deepEqual(body.updates.map((update) => update.entitySlug), ['bitcoin', 'ethereum'])
  assert.equal(body.updates[1]!.id, other)
  assert.equal(seen.filter((read) => read.table === 'latest_updates').length, 2)
})

test('inactive entity: its live update is hidden, active entities still show, and the guard is sent to PostgREST', async () => {
  const db = emptyDb()
  seedBasics(db)
  db.entities.find((row) => row.id === ENTITY_B)!.status = 'inactive'
  addUpdate(db, ENTITY_A, 'live', '2026-11-14T01:00:00+00:00')
  const hidden = addUpdate(db, ENTITY_B, 'live', '2026-11-14T03:00:00+00:00')
  addUpdate(db, ENTITY_B, 'live', '2026-11-13T03:00:00+00:00')
  const { fetchImpl, seen } = fakeRest(db)

  const { status, body } = await get(routes(fetchImpl))

  assert.equal(status, 200)
  assert.deepEqual(body.updates.map((update) => update.entitySlug), ['bitcoin'])
  assert.ok(!body.updates.some((update) => update.id === hidden))
  const entityReads = seen.filter((read) => read.table === 'entities')
  assert.ok(entityReads.length > 0)
  for (const read of entityReads) assert.equal(read.params.get('status'), 'eq.active')
})

test('inactive entity does not use up a limit slot', async () => {
  const db = emptyDb()
  seedBasics(db)
  db.entities.find((row) => row.id === ENTITY_B)!.status = 'inactive'
  const active = addUpdate(db, ENTITY_A, 'live', '2026-11-13T01:00:00+00:00')
  addUpdate(db, ENTITY_B, 'live', '2026-11-14T03:00:00+00:00')
  const { fetchImpl } = fakeRest(db)

  const { body } = await get(routes(fetchImpl), '/?limit=1')

  assert.deepEqual(body.updates.map((update) => update.id), [active])
})

test('only inactive entities: empty list with HTTP 200', async () => {
  const db = emptyDb()
  seedBasics(db)
  for (const row of db.entities) row.status = 'inactive'
  addUpdate(db, ENTITY_A, 'live', '2026-11-14T01:00:00+00:00')
  addUpdate(db, ENTITY_B, 'live', '2026-11-14T02:00:00+00:00')
  const { fetchImpl } = fakeRest(db)

  const { status, body } = await get(routes(fetchImpl))

  assert.equal(status, 200)
  assert.deepEqual(body, { updates: [] })
})

test('read-only: GET only, no body, allowed tables only, service-role headers on the atlas schema', async () => {
  const db = emptyDb()
  seedBasics(db)
  const item = uuid()
  addItem(db, item, 'Source', '2026-11-10T10:00:00+00:00', SIGNAL_1)
  db.item_signals.push({ item_id: item, signal_id: SIGNAL_1, role: 'origin' })
  addUpdate(db, ENTITY_A, 'live', '2026-11-14T01:00:00+00:00', [item])
  const { fetchImpl, seen } = fakeRest(db)

  const { status } = await get(routes(fetchImpl))

  assert.equal(status, 200)
  assert.deepEqual([...new Set(seen.map((read) => read.table))].sort(), [
    'entities', 'entity_items', 'item_signals', 'latest_update_items', 'latest_updates', 'signals',
  ])
  for (const read of seen) {
    assert.equal(read.method, 'GET')
    assert.equal(read.hasBody, false)
    assert.equal(read.headers.get('Accept-Profile'), 'atlas')
    assert.equal(read.headers.get('apikey'), SERVICE_KEY)
    assert.equal(read.headers.get('Prefer'), null)
  }
})

test('non-GET methods are not served by the route', async () => {
  const { fetchImpl, seen } = fakeRest(emptyDb())
  const app = routes(fetchImpl)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await app.request('/', { method })
    assert.equal(response.status, 404, method)
  }
  assert.equal(seen.length, 0)
})

test('database unavailable: generic 500, no partial data, no secrets in the body', async () => {
  const db = emptyDb()
  seedBasics(db)
  const item = uuid()
  addItem(db, item, 'Source', '2026-11-10T10:00:00+00:00', SIGNAL_1)
  addUpdate(db, ENTITY_A, 'live', '2026-11-14T01:00:00+00:00', [item])
  const originalError = console.error
  console.error = () => {}
  try {
    for (const failTable of ['latest_updates', 'entities', 'latest_update_items', 'entity_items', 'item_signals', 'signals']) {
      const { fetchImpl } = fakeRest(db, { failTable })
      const response = await routes(fetchImpl).request('/')
      const text = await response.text()
      assert.equal(response.status, 500, failTable)
      assert.deepEqual(JSON.parse(text), { error: 'Unable to load latest updates' }, failTable)
      assert.ok(!text.includes(SERVICE_KEY))
    }
    const throwing = (async () => { throw new Error('network down') }) as typeof fetch
    assert.equal((await routes(throwing).request('/')).status, 500)
    const notAnArray = (async () => new Response(JSON.stringify({ message: 'x' }))) as typeof fetch
    assert.equal((await routes(notAnArray).request('/')).status, 500)
  } finally {
    console.error = originalError
  }
})

test('/stories, /stories/:slug and /narratives are unchanged and never touch the latest-updates tables (and the reverse)', async () => {
  const seen: string[] = []
  const stub = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    seen.push(url.pathname.split('/').pop() as string)
    if (url.pathname.endsWith('/entities') && url.searchParams.get('slug')) return Response.json([])
    return Response.json([])
  }) as typeof fetch
  const memoryReader = {
    async getEntityMemoryEvents() { return { schemaVersion: 1, items: [], totalCount: 0, nextCursor: null, hasMore: false } },
    async getEntityMemoriesByIds() { return [] },
  }
  const app = new Hono()
  // Same mounting order as bootstrap/create-app.ts.
  app.route('/stories', createStoryRoutes({
    supabaseUrl: 'https://project.supabase.co', serviceRoleKey: SERVICE_KEY, source: 'atlas',
    memoryReader: memoryReader as never, fetch: stub,
  }))
  app.route('/latest-updates', routes(stub))
  app.route('/narratives', createNarrativeRoutes({
    supabaseUrl: 'https://project.supabase.co', serviceRoleKey: SERVICE_KEY, memoryReader, fetch: stub,
  }))

  const stories = await app.request('/stories')
  assert.equal(stories.status, 200)
  assert.deepEqual(await stories.json(), { stories: [] })
  const missing = await app.request('/stories/bitcoin')
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'Story not found' })
  const narratives = await app.request('/narratives')
  assert.equal(narratives.status, 200)
  assert.deepEqual(await narratives.json(), [])
  assert.ok(seen.length > 0)
  assert.ok(!seen.some((table) => table.startsWith('latest_update')), `stories/narratives read ${seen.join(',')}`)
  assert.ok(seen.includes('entity_items') && seen.includes('published_narratives'))

  seen.length = 0
  const latest = await app.request('/latest-updates')
  assert.equal(latest.status, 200)
  assert.deepEqual(await latest.json(), { updates: [] })
  assert.deepEqual(seen, ['latest_updates'])
})

test('create-app mounts /latest-updates and leaves the /stories and /narratives mounts as they were', () => {
  const source = readFileSync(new URL('./bootstrap/create-app.ts', import.meta.url), 'utf8')
  assert.match(source, /app\.route\('\/latest-updates', createLatestUpdateRoutes\(\{\s*supabaseUrl: config\.supabaseUrl,\s*serviceRoleKey: config\.supabaseServiceRoleKey,\s*\}\)\)/)
  assert.match(source, /app\.route\('\/stories', createStoryRoutes\(\{\s*supabaseUrl: config\.supabaseUrl,\s*serviceRoleKey: config\.supabaseServiceRoleKey,\s*memoryReader: entityKnowledgeReader,\s*source: process\.env\.STORIES_SOURCE === 'atlas' \? 'atlas' : 'legacy',\s*\}\)\)/)
  assert.match(source, /app\.route\('\/narratives', createNarrativeRoutes\(\{\s*supabaseUrl: config\.supabaseUrl,\s*serviceRoleKey: config\.supabaseServiceRoleKey,\s*memoryReader: entityKnowledgeReader,\s*\}\)\)/)
})
