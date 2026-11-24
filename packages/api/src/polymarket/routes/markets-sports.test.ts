import assert from 'node:assert/strict'
import test from 'node:test'
import { createPolymarketMarketRoutes } from './markets.js'
import { createPolymarketSportsRoutes } from './sports.js'

type FetchStub = (url: string) => Response | Promise<Response>

async function withFetch<T>(stub: FetchStub, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => stub(String(input))) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

test('market price route reads token ids from Gamma and prices from CLOB', async () => {
  const app = createPolymarketMarketRoutes()
  const res = await withFetch(
    (url) => {
      if (url.includes('gamma-api.polymarket.com/markets?slug=demo')) {
        return json([{ clobTokenIds: '["yes-token","no-token"]' }])
      }
      if (url.includes('price?token_id=yes-token')) return json({ price: '0.62' })
      if (url.includes('price?token_id=no-token')) return json({ price: '0.38' })
      return json({}, 404)
    },
    () => Promise.resolve(app.request('/markets/demo/price')),
  )
  assert.equal(res.status, 200)
  const body = await res.json() as Record<string, unknown>
  assert.equal(body.slug, 'demo')
  assert.equal(body.yesPrice, 0.62)
  assert.equal(body.noPrice, 0.38)
})

test('market price route returns 404 when Gamma has no such market', async () => {
  const app = createPolymarketMarketRoutes()
  const res = await withFetch(() => json([]), () => Promise.resolve(app.request('/markets/missing/price')))
  assert.equal(res.status, 404)
})

test('trending route stays an empty list', async () => {
  const app = createPolymarketMarketRoutes()
  const res = await app.request('/trending')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), [])
})

test('sports list maps Gamma events and drops more-markets events', async () => {
  const app = createPolymarketSportsRoutes()
  const res = await withFetch(
    (url) => {
      if (url.includes('gamma-api.polymarket.com/events?series_id=10204')) {
        return json([
          { slug: 'ucl-a-b', title: 'A vs B', markets: [{ groupItemTitle: 'A', outcomePrices: '["0.5","0.5"]', clobTokenIds: '["t1","t2"]', conditionId: 'c1' }] },
          { slug: 'ucl-a-b-more-markets', title: 'More', markets: [] },
        ])
      }
      return json({}, 404)
    },
    () => Promise.resolve(app.request('/sports/ucl')),
  )
  assert.equal(res.status, 200)
  const body = await res.json() as Array<Record<string, unknown>>
  assert.equal(body.length, 1)
  assert.equal(body[0].slug, 'ucl-a-b')
  assert.equal(body[0]._source, 'gamma')
})

test('sports list rejects an unsupported sport', async () => {
  const app = createPolymarketSportsRoutes()
  const res = await app.request('/sports/curling')
  assert.equal(res.status, 400)
})
