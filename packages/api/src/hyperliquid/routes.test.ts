import assert from 'node:assert/strict'
import test from 'node:test'
import { createHyperliquidPrices, parseCandleCount } from './prices.js'
import { createHyperliquidRoutes } from './routes.js'

const T0 = Date.parse('2026-11-20T10:00:00.000Z')
const HOUR_MS = 60 * 60 * 1000

interface FakeUpstream {
  core?: Array<{ name: string, markPx?: string, prevDayPx?: string, isDelisted?: boolean }> | Error
  xyz?: Array<{ name: string, markPx?: string, prevDayPx?: string, isDelisted?: boolean }> | Error
  candles?: unknown[] | Error
}

function fakeUpstream(upstream: FakeUpstream = {}) {
  const calls: Array<{ type: unknown, dex: unknown, req: unknown }> = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { type?: unknown, dex?: unknown, req?: unknown }
    calls.push({ type: body.type, dex: body.dex, req: body.req })
    assert.equal(String(input), 'https://api.hyperliquid.xyz/info')
    if (body.type === 'metaAndAssetCtxs') {
      const fixture = body.dex === 'xyz' ? upstream.xyz : upstream.core
      if (fixture instanceof Error) throw fixture
      return jsonResponse([
        {
          universe: (fixture ?? []).map(({ name, isDelisted, ...rest }) => (
            isDelisted ? { name, isDelisted: true } : { name, ...rest }
          )),
        },
        (fixture ?? []).map(({ markPx = '100', prevDayPx = '100' }) => ({ markPx, prevDayPx })),
      ])
    }
    if (body.type === 'candleSnapshot') {
      if (upstream.candles instanceof Error) throw upstream.candles
      return jsonResponse(upstream.candles ?? [])
    }
    throw new Error(`Unexpected request type: ${String(body.type)}`)
  }
  return { fetchImpl, calls }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

/** The candles route behind one shared price cache per app, like create-app.ts wires it. */
function routeApp(upstream: FakeUpstream) {
  let nowMs = T0
  const fake = fakeUpstream(upstream)
  const app = createHyperliquidRoutes({
    prices: createHyperliquidPrices({ fetch: fake.fetchImpl, now: () => nowMs }),
  })
  return {
    app,
    calls: fake.calls,
    advance(ms: number) {
      nowMs += ms
    },
  }
}

test('Candle count parsing defaults to 168 and clamps to 1..500', () => {
  assert.equal(parseCandleCount(undefined), 168)
  assert.equal(parseCandleCount('24'), 24)
  assert.equal(parseCandleCount('0'), 1)
  assert.equal(parseCandleCount('1'), 1)
  assert.equal(parseCandleCount('168'), 168)
  assert.equal(parseCandleCount('9999'), 500)
  assert.equal(parseCandleCount('-5'), 168)
  assert.equal(parseCandleCount('abc'), 168)
  assert.equal(parseCandleCount(''), 168)
})

test('Candles maps the upstream snapshot to MarketCandle rows oldest first', async () => {
  const { app, calls } = routeApp({
    core: [{ name: 'BTC', markPx: '85023.5', prevDayPx: '80500' }],
    xyz: [],
    candles: [
      { t: 1763632800000, T: 1763636399999, s: 'BTC', i: '1h', o: '63830.0', c: '63760.0', h: '63948.0', l: '63753.0', v: '584.75741', n: 7129 },
      { t: 1763629200000, T: 1763632799999, s: 'BTC', i: '1h', o: '64620.0', c: '63830.0', h: '64700.0', l: '63700.0', v: '311.4', n: 4021 },
      // A non-finite close and a non-numeric time are dropped.
      { t: 1, T: 2, s: 'BTC', i: '1h', o: '1', c: 'x', h: '1', l: '1', v: '1' },
      { t: 'later', T: 2, s: 'BTC', i: '1h', o: '1', c: '1', h: '1', l: '1', v: '1' },
      // Volume that is not finite maps to null.
      { t: 1763636400000, T: 1763639999999, s: 'BTC', i: '1h', o: '63760.0', c: '61770.0', h: '63800.0', l: '61600.0', v: 'nope', n: 1 },
    ],
  })
  const response = await app.request('/candles?symbol=BTC')
  assert.equal(response.status, 200)
  const body = await response.json() as { symbol: string, interval: string, candles: Array<Record<string, unknown>> }
  assert.deepEqual(body, {
    symbol: 'BTC',
    interval: '1h',
    candles: [
      { timeMs: 1763629200000, open: 64620, high: 64700, low: 63700, close: 63830, volume: 311.4 },
      { timeMs: 1763632800000, open: 63830, high: 63948, low: 63753, close: 63760, volume: 584.75741 },
      { timeMs: 1763636400000, open: 63760, high: 63800, low: 61600, close: 61770, volume: null },
    ],
  })
  assert.deepEqual(Object.keys(body.candles[0]!).sort(), ['close', 'high', 'low', 'open', 'timeMs', 'volume'])
  // Defaults: no interval → 1h, no count → 168 hours of start time.
  assert.deepEqual(
    calls.find((call) => call.type === 'candleSnapshot')?.req,
    { coin: 'BTC', interval: '1h', startTime: T0 - 168 * HOUR_MS, endTime: T0 },
  )
})

test('Candles rejects a missing symbol with 400 and no upstream calls', async () => {
  const { app, calls } = routeApp({ core: [{ name: 'BTC' }] })
  for (const path of ['/candles', '/candles?symbol=', '/candles?interval=1h']) {
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    assert.deepEqual(await response.json(), { error: 'Missing symbol' })
  }
  assert.equal(calls.length, 0)
})

test('Candles 404 unknown and delisted symbols, 400 unsupported intervals before any candle read', async () => {
  const { app, calls } = routeApp({
    core: [{ name: 'BTC' }],
    xyz: [{ name: 'xyz:TLT', markPx: '91.2', prevDayPx: '90.5', isDelisted: true }],
  })
  for (const symbol of ['UNKNOWN', 'xyz:TLT']) {
    const response = await app.request(`/candles?symbol=${encodeURIComponent(symbol)}`)
    assert.equal(response.status, 404, symbol)
    assert.deepEqual(await response.json(), { error: 'Market not found' })
  }
  const badInterval = await app.request('/candles?symbol=BTC&interval=2h')
  assert.equal(badInterval.status, 400)
  assert.deepEqual(await badInterval.json(), {
    error: 'Unsupported interval',
    supportedIntervals: ['15m', '1h', '4h', '1d'],
  })
  // The 404s loaded the price snapshot once (one POST per dex); nothing read candles.
  assert.equal(calls.filter((call) => call.type === 'metaAndAssetCtxs').length, 2)
  assert.equal(calls.filter((call) => call.type === 'candleSnapshot').length, 0)
})

test('Candles clamps count before asking for a window', async () => {
  const { app, calls } = routeApp({
    core: [{ name: 'BTC' }],
    xyz: [],
    candles: [],
  })
  await app.request('/candles?symbol=BTC&count=24')
  await app.request('/candles?symbol=BTC&count=0')
  await app.request('/candles?symbol=BTC&count=9999')
  await app.request('/candles?symbol=BTC&count=abc')

  const starts = calls
    .filter((call) => call.type === 'candleSnapshot')
    .map((call) => (call.req as { startTime: number }).startTime)
  assert.deepEqual(starts, [
    T0 - 24 * HOUR_MS,
    T0 - 1 * HOUR_MS,
    T0 - 500 * HOUR_MS,
    T0 - 168 * HOUR_MS,
  ])
})

test('Candles 502 when the candle upstream fails', async () => {
  const { app } = routeApp({
    core: [{ name: 'BTC' }],
    xyz: [],
    candles: new Error('candle upstream down'),
  })
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const response = await app.request('/candles?symbol=BTC')
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), { error: 'Candles unavailable' })
  } finally {
    console.error = originalConsoleError
  }
})

test('Candles serves repeat requests from the 60 s candle cache', async () => {
  const { app, calls, advance } = routeApp({
    core: [{ name: 'BTC' }],
    xyz: [],
    candles: [{ t: 1763632800000, T: 1763636399999, s: 'BTC', i: '1h', o: '63830.0', c: '63760.0', h: '63948.0', l: '63753.0', v: '584.75741', n: 7129 }],
  })
  const first = await app.request('/candles?symbol=BTC&interval=1h&count=24')
  assert.equal(first.status, 200)
  assert.equal(calls.filter((call) => call.type === 'candleSnapshot').length, 1)
  const callsAfterFirst = calls.length
  const firstBody = await first.json()

  advance(10_000)
  const second = await app.request('/candles?symbol=BTC&interval=1h&count=24')
  assert.equal(second.status, 200)
  assert.deepEqual(await second.json(), firstBody)
  assert.equal(calls.length, callsAfterFirst, 'cache hit makes no second fetch')

  // A different cache key (count) fetches its own window.
  const third = await app.request('/candles?symbol=BTC&interval=1h&count=48')
  assert.equal(third.status, 200)
  assert.equal(calls.filter((call) => call.type === 'candleSnapshot').length, 2)
})

test('Candles 503 when no price snapshot can load at all', async () => {
  const { app } = routeApp({
    core: new Error('upstream down'),
    xyz: new Error('upstream down'),
  })
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const response = await app.request('/candles?symbol=BTC')
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'Prices unavailable' })
  } finally {
    console.error = originalConsoleError
  }
})
