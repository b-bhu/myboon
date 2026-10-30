// #505 entity timeline API, tests first: GET /entities/:slug/timeline returns one entity's items
// (angle, note, signal link, time) and its stories, newest first. PostgREST (atlas profile) is faked.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createEntityTimelineRoutes } from './entity-timeline.js'

const SHELF = '01a17278-acb3-7ccd-8ec1-4a9d8baf672f'
const ITEM_NEW = '01a17278-acb3-7ccd-8ec1-4a9d8baf6801'
const ITEM_OLD = '01a17278-acb3-7ccd-8ec1-4a9d8baf6802'
const STORY = '01a17278-acb3-7ccd-8ec1-4a9d8baf6901'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function app(fetchImpl: typeof fetch) {
  return createEntityTimelineRoutes({ supabaseUrl: 'https://project.supabase.co', serviceRoleKey: 'service-role-test-key', fetch: fetchImpl })
}

function fakeAtlas(o: { shelves?: unknown[]; failOn?: string } = {}) {
  const requests: Array<{ url: URL; init?: RequestInit }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({ url, init })
    const table = url.pathname.split('/').pop()
    if (o.failOn === table) return json({ message: 'boom' }, 500)
    if (table === 'shelves') return json(o.shelves ?? [{ id: SHELF, slug: 'hyperliquid', name: 'Hyperliquid', type: 'token' }])
    if (table === 'items') return json([
      { id: ITEM_NEW, title: 'HYPE unlock', angle: 'existing_story', note: 'The Block says the unlock is next week.', occurred_at: '2026-10-30T08:00:00Z', created_at: '2026-10-30T08:01:00Z', signal: { link: 'https://theblock.co/x' } },
      { id: ITEM_OLD, title: 'HYPE volume', angle: 'plain_update', note: 'Volume stats per DefiLlama.', occurred_at: '2026-10-29T08:00:00Z', created_at: '2026-10-29T08:01:00Z', signal: null },
    ])
    if (table === 'stories') return json([
      { id: STORY, slug: 'hyperliquid-01a17278', title: 'HYPE unlock', summary: 'The Block says the unlock is next week.', status: 'open', created_at: '2026-10-29T09:00:00Z', updated_at: '2026-10-30T08:02:00Z', story_items: [{ item_id: ITEM_NEW }] },
    ])
    return json({ message: `unexpected ${table}` }, 404)
  }) as typeof fetch
  return { requests, fetchImpl }
}

test('hyperliquid: items and stories come back newest first with angle, note, signal link and time', async () => {
  const { requests, fetchImpl } = fakeAtlas()
  const res = await app(fetchImpl).request('/hyperliquid/timeline')
  assert.equal(res.status, 200)
  const body = await res.json() as Record<string, any>
  assert.deepEqual(body.entity, { slug: 'hyperliquid', name: 'Hyperliquid', type: 'token' })
  assert.deepEqual(body.items.map((i: any) => i.id), [ITEM_NEW, ITEM_OLD])
  assert.deepEqual(body.items[0], { id: ITEM_NEW, title: 'HYPE unlock', angle: 'existing_story', note: 'The Block says the unlock is next week.', signalLink: 'https://theblock.co/x', occurredAt: '2026-10-30T08:00:00Z' })
  assert.equal(body.items[1].signalLink, null)
  assert.deepEqual(body.stories, [{ id: STORY, slug: 'hyperliquid-01a17278', title: 'HYPE unlock', summary: 'The Block says the unlock is next week.', status: 'open', itemIds: [ITEM_NEW], createdAt: '2026-10-29T09:00:00Z', updatedAt: '2026-10-30T08:02:00Z' }])

  for (const r of requests) assert.equal(new Headers(r.init?.headers).get('Accept-Profile'), 'atlas')
  const items = requests.find((r) => r.url.pathname.endsWith('/items'))!.url.searchParams
  assert.equal(items.get('main_shelf_id'), `eq.${SHELF}`)
  assert.equal(items.get('status'), 'eq.active')
  assert.match(items.get('order') ?? '', /^occurred_at\.desc/)
  const stories = requests.find((r) => r.url.pathname.endsWith('/stories'))!.url.searchParams
  assert.equal(stories.get('shelf_id'), `eq.${SHELF}`)
  assert.match(stories.get('order') ?? '', /^updated_at\.desc/)
})

test('plain_update items show in the timeline even with no story', async () => {
  const { fetchImpl } = fakeAtlas()
  const body = await (await app(fetchImpl).request('/hyperliquid/timeline')).json() as Record<string, any>
  assert.ok(body.items.some((i: any) => i.angle === 'plain_update'))
})

test('unknown entity returns 404', async () => {
  const { fetchImpl } = fakeAtlas({ shelves: [] })
  assert.equal((await app(fetchImpl).request('/nope/timeline')).status, 404)
})

test('invalid slug returns 400 without reading Supabase', async () => {
  const { requests, fetchImpl } = fakeAtlas()
  assert.equal((await app(fetchImpl).request('/Bad%20Slug!/timeline')).status, 400)
  assert.equal(requests.length, 0)
})

test('a Supabase failure returns 502 and does not leak the key', async () => {
  const { fetchImpl } = fakeAtlas({ failOn: 'stories' })
  const res = await app(fetchImpl).request('/hyperliquid/timeline')
  assert.equal(res.status, 502)
  assert.doesNotMatch(await res.text(), /service-role-test-key/)
})
