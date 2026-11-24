import assert from 'node:assert/strict'
import test from 'node:test'
import { createHyperliquidPrices } from './prices.js'

const T0 = Date.parse('2026-11-20T10:00:00.000Z')

interface PriceFixture {
  name: string
  markPx: string
  prevDayPx: string
  isDelisted?: boolean
}

/** A metaAndAssetCtxs response: `[meta, ctxs]`, ctx rows zipped by index with the universe names. */
function snapshotResponse(fixture: PriceFixture[]): unknown {
  return [
    {
      universe: fixture.map(({ name, isDelisted }) => (
        isDelisted ? { name, isDelisted: true } : { name }
      )),
    },
    fixture.map(({ markPx, prevDayPx }) => ({ markPx, prevDayPx })),
  ]
}

interface FakeUpstream {
  core?: PriceFixture[] | Error | 'hang'
  xyz?: PriceFixture[] | Error | 'hang'
  candles?: unknown[] | Error
}

function fakeUpstream(upstream: FakeUpstream = {}) {
  const calls: Array<{ type: unknown, dex: unknown, req?: unknown }> = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { type?: unknown, dex?: unknown, req?: unknown }
    calls.push({ type: body.type, dex: body.dex, req: body.req })
    if (body.type === 'metaAndAssetCtxs') {
      const fixture = body.dex === 'xyz' ? upstream.xyz : upstream.core
      if (fixture === 'hang') return new Promise<Response>(() => undefined)
      if (fixture instanceof Error) throw fixture
      return jsonResponse(snapshotResponse(fixture ?? []))
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

function clock() {
  let nowMs = T0
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms
    },
  }
}

const BTC: PriceFixture = { name: 'BTC', markPx: '85023.5', prevDayPx: '80500' }
const ETH: PriceFixture = { name: 'ETH', markPx: '3000.25', prevDayPx: '3060.5' }
const CL: PriceFixture = { name: 'xyz:CL', markPx: '82.542', prevDayPx: '83.61' }
const DELISTED: PriceFixture = { name: 'xyz:TLT', markPx: '91.2', prevDayPx: '90.5', isDelisted: true }

test('quotes prices core and xyz dex markets, zipping universe names with ctx rows by index', async () => {
  const upstream = fakeUpstream({ core: [BTC, ETH], xyz: [CL, DELISTED] })
  const time = clock()
  const prices = createHyperliquidPrices({ fetch: upstream.fetchImpl, now: time.now })
  const quotes = await prices.quotes(['BTC', 'ETH', 'xyz:CL', 'xyz:TLT'], { waitMs: 1500 })

  assert.deepEqual(quotes.get('BTC'), {
    price: 85023.5,
    change24hPct: Math.round((85023.5 / 80500 - 1) * 10000) / 100, // 5.62
    asOf: new Date(T0).toISOString(),
  })
  assert.deepEqual(quotes.get('ETH'), {
    price: 3000.25,
    change24hPct: Math.round((3000.25 / 3060.5 - 1) * 10000) / 100, // -1.97
    asOf: new Date(T0).toISOString(),
  })
  // core + xyz merged into one snapshot, per-dex fetch times kept per entry.
  assert.deepEqual(quotes.get('xyz:CL'), {
    price: 82.542,
    change24hPct: Math.round((82.542 / 83.61 - 1) * 10000) / 100, // -1.28
    asOf: new Date(T0).toISOString(),
  })
  assert.deepEqual(quotes.get('xyz:TLT'), { price: null, change24hPct: null, asOf: null })

  // One refresh = two POSTs: core without dex, xyz with dex.
  assert.deepEqual(upstream.calls.map((call) => ({ type: call.type, dex: call.dex })), [
    { type: 'metaAndAssetCtxs', dex: undefined },
    { type: 'metaAndAssetCtxs', dex: 'xyz' },
  ])
})

test('quotes rounds change24hPct to 2 decimals in both directions', async () => {
  const upstream = fakeUpstream({
    core: [
      { name: 'BTC', markPx: '101.234', prevDayPx: '100' },
      { name: 'ETH', markPx: '50', prevDayPx: '60' },
      { name: 'SOL', markPx: '1.005', prevDayPx: '1' },
    ],
  })
  const time = clock()
  const prices = createHyperliquidPrices({ fetch: upstream.fetchImpl, now: time.now })
  const quotes = await prices.quotes(['BTC', 'ETH', 'SOL'], { waitMs: 1500 })
  assert.equal(quotes.get('BTC')?.change24hPct, 1.23)
  assert.equal(quotes.get('ETH')?.change24hPct, -16.67)
  assert.equal(quotes.get('SOL')?.change24hPct, 0.5)
})

test('quotes gives a null move when prevDayPx is 0 or not finite', async () => {
  const upstream = fakeUpstream({
    core: [
      { name: 'BTC', markPx: '85000', prevDayPx: '0' },
      { name: 'ETH', markPx: '3000', prevDayPx: '' },
    ],
  })
  const time = clock()
  const prices = createHyperliquidPrices({ fetch: upstream.fetchImpl, now: time.now })
  const quotes = await prices.quotes(['BTC', 'ETH'], { waitMs: 1500 })
  assert.equal(quotes.get('BTC')?.price, 85000)
  assert.equal(quotes.get('BTC')?.change24hPct, null)
  assert.equal(quotes.get('ETH')?.price, 3000)
  assert.deepEqual(quotes.get('ETH')?.change24hPct, null)
})

test('quotes never prices delisted names and isListed reports them as unlisted', async () => {
  const upstream = fakeUpstream({ core: [BTC, DELISTED] })
  const time = clock()
  const prices = createHyperliquidPrices({ fetch: upstream.fetchImpl, now: time.now })
  const quotes = await prices.quotes(['BTC', 'xyz:TLT'], { waitMs: 1500 })
  assert.deepEqual(quotes.get('xyz:TLT'), { price: null, change24hPct: null, asOf: null })
  assert.equal(await prices.isListed('BTC'), true)
  assert.equal(await prices.isListed('xyz:TLT'), false)
  assert.equal(await prices.isListed('UNKNOWN'), false)
})

test('a fresh snapshot answers quotes without fetching', async () => {
  const upstream = fakeUpstream({ core: [BTC], xyz: [] })
  const time = clock()
  const prices = createHyperliquidPrices({ fetch: upstream.fetchImpl, now: time.now })
  const first = await prices.quotes(['BTC'], { waitMs: 1500 })
  assert.ok(first.get('BTC')?.price)

  time.advance(10_000)
  const second = await prices.quotes(['BTC'], { waitMs: 1500 })
  assert.equal(upstream.calls.length, 2, 'a fresh snapshot must not fetch')
  assert.deepEqual(second.get('BTC'), first.get('BTC'))

  time.advance(30_000)
  await prices.quotes(['BTC'], { waitMs: 1500 })
  assert.equal(upstream.calls.length, 4, 'an expired snapshot triggers a refresh')
})

test('a ttlMs option widens the freshness window', async () => {
  const upstream = fakeUpstream({ core: [BTC], xyz: [] })
  const time = clock()
  // #833: the TTL now arrives through createHyperliquidPrices options
  // (bootstrap/config.ts parses HYPERLIQUID_PRICES_TTL_MS for production).
  const prices = createHyperliquidPrices({ fetch: upstream.fetchImpl, now: time.now, ttlMs: 60_000 })
  await prices.quotes(['BTC'], { waitMs: 1500 })
  time.advance(45_000)
  await prices.quotes(['BTC'], { waitMs: 1500 })
  assert.equal(upstream.calls.length, 2, 'still fresh at 45 s with a 60 s TTL')
  time.advance(20_000)
  await prices.quotes(['BTC'], { waitMs: 1500 })
  assert.equal(upstream.calls.length, 4, 'refreshes past the 60 s TTL')
})

test('parallel quotes calls share one refresh in flight', async () => {
  const upstream = fakeUpstream({ core: [BTC], xyz: [] })
  const time = clock()
  const prices = createHyperliquidPrices({ fetch: upstream.fetchImpl, now: time.now })
  const [first, second] = await Promise.all([
    prices.quotes(['BTC'], { waitMs: 500 }),
    prices.quotes(['BTC'], { waitMs: 500 }),
  ])
  assert.equal(upstream.calls.length, 2, 'one POST per dex, not one per call')
  assert.deepEqual(first.get('BTC'), second.get('BTC'))
})

test('an upstream failure keeps the last good snapshot', async () => {
  const handlers: FakeUpstream = { core: [BTC], xyz: [] }
  const upstream = fakeUpstream(handlers)
  const time = clock()
  const prices = createHyperliquidPrices({ fetch: upstream.fetchImpl, now: time.now })
  const healthy = await prices.quotes(['BTC'], { waitMs: 1500 })
  const healthyQuote = healthy.get('BTC')

  handlers.core = new Error('upstream is down')
  handlers.xyz = new Error('upstream is down')
  const logged: string[] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    time.advance(31_000)
    const after = await prices.quotes(['BTC'], { waitMs: 200 })
    assert.deepEqual(after.get('BTC'), healthyQuote, 'the kept snapshot still answers')
    // Errors are logged once per refresh, not per request.
    assert.equal(logged.length, 2, 'one line per failing dex')
    assert.ok(logged.every((line) => line.includes('price refresh failed')))

    await prices.quotes(['BTC'], { waitMs: 200 })
    assert.equal(logged.length, 4, 'and again for the next refresh')
  } finally {
    console.error = originalConsoleError
  }
})

test('a snapshot older than 15 minutes answers with nulls; exactly 15 minutes old still answers', async () => {
  const handlers: FakeUpstream = { core: [BTC], xyz: [] }
  const upstream = fakeUpstream(handlers)
  const time = clock()
  const prices = createHyperliquidPrices({ fetch: upstream.fetchImpl, now: time.now })
  await prices.quotes(['BTC'], { waitMs: 1500 })

  // Exactly at 900_000 ms: not older than, so still priced.
  time.advance(900_000)
  handlers.core = new Error('down')
  handlers.xyz = new Error('down')
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const boundary = await prices.quotes(['BTC'], { waitMs: 200 })
    assert.equal(boundary.get('BTC')?.price, 85023.5)

    time.advance(1)
    const stale = await prices.quotes(['BTC'], { waitMs: 200 })
    assert.deepEqual(stale.get('BTC'), { price: null, change24hPct: null, asOf: null })
  } finally {
    console.error = originalConsoleError
  }
})

test('quotes returns within waitMs when the upstream is slow, and never throws on upstream failures', async () => {
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    for (const mode of ['hang', 'throw', 'garbage'] as const) {
      const upstream = mode === 'garbage'
        ? fakeUpstream()
        : fakeUpstream({ core: mode === 'hang' ? 'hang' : new Error('boom'), xyz: mode === 'hang' ? 'hang' : new Error('boom') })
      const time = clock()
      const fetchImpl = mode === 'garbage'
        ? async (): Promise<Response> => jsonResponse({ unexpected: 'shape' })
        : upstream.fetchImpl
      const prices = createHyperliquidPrices({ fetch: fetchImpl as typeof upstream.fetchImpl, now: time.now })

      const started = Date.now()
      const quotes = await prices.quotes(['BTC', 'xyz:CL'], { waitMs: 150 })
      const elapsed = Date.now() - started
      assert.ok(elapsed < 1000, `${mode}: quotes should resolve within waitMs, took ${elapsed}ms`)
      assert.deepEqual(quotes.get('BTC'), { price: null, change24hPct: null, asOf: null })
      assert.deepEqual(quotes.get('xyz:CL'), { price: null, change24hPct: null, asOf: null })
    }
  } finally {
    console.error = originalConsoleError
  }
})

test('isListed answers unavailable when no snapshot has ever loaded', async () => {
  const upstream = fakeUpstream({ core: new Error('down'), xyz: new Error('down') })
  const time = clock()
  const prices = createHyperliquidPrices({ fetch: upstream.fetchImpl, now: time.now })
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    assert.equal(await prices.isListed('BTC'), 'unavailable')
  } finally {
    console.error = originalConsoleError
  }
})
