import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { createPacificaRoutes } from './routes.js'

// #831: the upstream bases arrive as options (bootstrap/config.ts reads the
// env), so these tests fake globalThis.fetch and assert the URLs it receives.

const API_BASE = 'https://pacifica.example.test/api/v1'
const ICON_BASE = 'https://icons.example.test/tokens'

function okJson(body: unknown): Response {
  return Response.json({ success: true, data: body, error: null, code: null })
}

function appWith(options: Parameters<typeof createPacificaRoutes>[0]) {
  const app = new Hono()
  app.route('/perps/pacifica', createPacificaRoutes(options))
  return app
}

test('GET /markets reads /info and /info/prices from the configured base and maps perpetuals', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (url === `${API_BASE}/info`) {
      return okJson([
        { symbol: 'SOL', tick_size: '0.01', lot_size: '0.1', max_leverage: 20, min_order_size: '10', instrument_type: 'perpetual' },
        { symbol: 'SPOTX', tick_size: '1', lot_size: '1', max_leverage: 1, min_order_size: '1', instrument_type: 'spot' },
      ])
    }
    if (url === `${API_BASE}/info/prices`) {
      return okJson([
        { symbol: 'SOL', oracle: '100', mark: '110', mid: '109', funding: '0.0001', open_interest: '5', volume_24h: '1000', yesterday_price: '100' },
      ])
    }
    return new Response('unexpected', { status: 500 })
  }) as typeof fetch
  try {
    const res = await appWith({ apiBase: API_BASE, iconBase: ICON_BASE }).request('/perps/pacifica/markets')
    assert.equal(res.status, 200)
    const body = await res.json() as Array<Record<string, unknown>>
    assert.equal(body.length, 1)
    assert.equal(body[0].symbol, 'SOL')
    assert.equal(body[0].markPrice, 110)
    assert.equal(body[0].change24h, 10)
    assert.deepEqual([...urls].sort(), [`${API_BASE}/info`, `${API_BASE}/info/prices`])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GET /markets answers 502 with the same error body when the upstream fails', async () => {
  const originalFetch = globalThis.fetch
  const originalError = console.error
  globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch
  console.error = () => {}
  try {
    const res = await appWith({ apiBase: API_BASE }).request('/perps/pacifica/markets')
    assert.equal(res.status, 502)
    assert.deepEqual(await res.json(), { error: 'Pacifica markets unavailable' })
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
  }
})

test('GET /icons/:file proxies the SVG from the configured icon base and negative-caches a miss', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    return url === `${ICON_BASE}/SOL.svg` ? new Response('<svg/>') : new Response('nope', { status: 404 })
  }) as typeof fetch
  try {
    const app = appWith({ apiBase: API_BASE, iconBase: ICON_BASE })
    const hit = await app.request('/perps/pacifica/icons/sol.svg')
    assert.equal(hit.status, 200)
    assert.equal(hit.headers.get('Content-Type'), 'image/svg+xml; charset=utf-8')
    assert.equal(await hit.text(), '<svg/>')

    assert.equal((await app.request('/perps/pacifica/icons/NOPE.svg')).status, 404)
    assert.equal((await app.request('/perps/pacifica/icons/NOPE.svg')).status, 404)
    assert.deepEqual(urls, [`${ICON_BASE}/SOL.svg`, `${ICON_BASE}/NOPE.svg`], 'the miss is served from cache')

    assert.equal((await app.request('/perps/pacifica/icons/!!!.svg')).status, 400)
  } finally {
    globalThis.fetch = originalFetch
  }
})
