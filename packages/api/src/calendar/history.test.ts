import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CalendarHistoryEntityError, CalendarHistoryParamError, CalendarHistoryUnavailableError,
  createCalendarHistory, type CalendarHistoryPrices, type CalendarHistoryReader,
} from './history.js'
import { createHyperliquidPrices } from '../hyperliquid.js'
import type { MarketCandle } from '@myboon/shared/stories'

const HOUR_MS = 3_600_000
const SERVICE_KEY = 'test-service-role-key'
const SUPABASE_URL = 'https://project.supabase.co'
const ENTITY_ID = '0f10c100-0000-7000-8000-0000000000c1'
const ENTITY = { id: ENTITY_ID, slug: 'us-cpi', name: 'US CPI' }
/** A 13:30 UTC release. Its window has finished well before `NOW`. */
const RELEASE_AT = Date.parse('2026-10-13T13:30:00.000Z')
/** An exact-hour 18:00 UTC release. */
const RELEASE_18 = Date.parse('2026-10-13T18:00:00.000Z')
const NOW = RELEASE_AT + 48 * HOUR_MS
const NOW_18 = RELEASE_18 + 48 * HOUR_MS
const BEFORE = '2026-11-20'

function candle(timeMs: number, close: number): MarketCandle {
  return { timeMs, open: close - 1, high: close + 1, low: close - 2, close, volume: null }
}

function market(rank: 1 | 2 | 3, symbol: string): Record<string, unknown> {
  return { entity_id: ENTITY_ID, rank, symbol }
}

function releaseRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entity_id: ENTITY_ID,
    source_title: 'Inflation Rate YoY',
    period: 'Oct',
    release_date: '2026-10-13',
    starts_at: '2026-10-13T13:30:00+00:00',
    unit: '%',
    actual: 3.1,
    estimate: 3.0,
    previous: 2.9,
    ...over,
  }
}

interface RestState {
  entities: Record<string, unknown>[]
  releases: Record<string, unknown>[]
  markets: Record<string, unknown>[]
  /** Reject every read with a thrown error, or answer one table with a status. */
  reject?: boolean
  failWith?: Record<string, number>
}

interface RestRead {
  table: string
  params: URLSearchParams
}

/**
 * Fake PostgREST: answers the three atlas reads, honours the filters a real
 * database would (slug eq, entity_id eq, release_date lt) and ignores order /
 * limit so the module's own ordering and cap stay exercised. Records every
 * read and asserts the service-key + atlas-profile headers per call.
 */
function fakeRest(state: RestState): { fetchImpl: typeof fetch, reads: RestRead[] } {
  const reads: RestRead[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const table = url.pathname.replace(/^\/rest\/v1\//, '')
    assert.ok(['entities', 'event_releases', 'entity_markets'].includes(table), table)
    const headers = (init?.headers ?? {}) as Record<string, string>
    assert.equal(headers['apikey'], SERVICE_KEY)
    assert.equal(headers['Authorization'], `Bearer ${SERVICE_KEY}`)
    assert.equal(headers['Accept'], 'application/json')
    assert.equal(headers['Accept-Profile'], 'atlas')
    const params = url.searchParams
    reads.push({ table, params })
    if (state.reject) throw new Error('rest down')
    if (state.failWith?.[table]) return new Response(null, { status: state.failWith[table]! })
    if (table === 'entities') {
      const slug = params.get('slug')
      assert.ok(slug?.startsWith('eq.'), `entities slug filter: ${slug}`)
      assert.equal(params.get('status'), 'eq.active')
      return Response.json(state.entities.filter((row) => slug === `eq.${row['slug']}`))
    }
    const entityId = params.get('entity_id')
    assert.ok(entityId?.startsWith('eq.'), `entity_id filter: ${entityId}`)
    if (table === 'event_releases') {
      const cutoff = params.get('release_date')
      if (cutoff !== null && !cutoff.startsWith('lt.')) throw new Error(`release_date must be lt.<before>, got ${cutoff}`)
      return Response.json(state.releases
        .filter((row) => entityId === `eq.${row['entity_id']}`)
        .filter((row) => cutoff === null || String(row['release_date']) < cutoff.slice(3)))
    }
    return Response.json(state.markets.filter((row) => entityId === `eq.${row['entity_id']}`))
  }
  return { fetchImpl, reads }
}

interface PriceStub {
  prices: CalendarHistoryPrices
  calls: { symbol: string, interval: string, startMs: number, endMs: number }[]
  table: Map<string, MarketCandle[] | 'error'>
}

/** Candle source keyed by symbol; a missing key or 'error' throws like a failed Hyperliquid call. */
function fakePrices(spec: Record<string, MarketCandle[] | 'error'> = {}): PriceStub {
  const calls: PriceStub['calls'] = []
  const table = new Map(Object.entries(spec))
  const prices: CalendarHistoryPrices = {
    async candlesBetween(symbol, interval, startMs, endMs) {
      calls.push({ symbol, interval, startMs, endMs })
      const value = table.get(symbol)
      if (value === undefined || value === 'error') {
        throw new Error('Hyperliquid responded 500')
      }
      return value
    },
  }
  return { prices, calls, table }
}

function reader(options: {
  supabaseUrl?: string
  serviceRoleKey?: string
  prices?: CalendarHistoryPrices
  fetch?: typeof fetch
  now?: () => number
}): CalendarHistoryReader {
  return createCalendarHistory({
    supabaseUrl: options.supabaseUrl ?? SUPABASE_URL,
    serviceRoleKey: options.serviceRoleKey ?? SERVICE_KEY,
    ...(options.prices ? { prices: options.prices } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
}

test('rejects unknown slugs and invalid dates before any read', async () => {
  let calls = 0
  const fetchImpl: typeof fetch = async () => { calls++; return Response.json([]) }
  const history = reader({ fetch: fetchImpl })
  for (const [entity, before] of [
    ['', '2026-11-20'], ['cpi', '2026-11-20'], ['us-gdp-fake', '2026-11-20'],
    ['us-cpi', ''], ['us-cpi', '2026-13-01'], ['us-cpi', '2026-02-30'], ['us-cpi', 'not-a-date'],
  ] as const) {
    await assert.rejects(history.getHistory(entity, before), CalendarHistoryParamError, `${entity}|${before}`)
  }
  assert.equal(calls, 0)
})

test('answers 404 for an allowed slug with no active entity and 503 when a read fails', async () => {
  const missing = fakeRest({ entities: [], releases: [], markets: [] })
  const history = reader({ fetch: missing.fetchImpl })
  await assert.rejects(history.getHistory('us-cpi', BEFORE), CalendarHistoryEntityError)

  const rejected = fakeRest({ entities: [ENTITY], releases: [], markets: [], reject: true })
  await assert.rejects(reader({ fetch: rejected.fetchImpl }).getHistory('us-cpi', BEFORE), CalendarHistoryUnavailableError)

  const releasesFailing = fakeRest({
    entities: [ENTITY], releases: [], markets: [], failWith: { event_releases: 500 },
  })
  await assert.rejects(
    reader({ fetch: releasesFailing.fetchImpl }).getHistory('us-cpi', BEFORE),
    CalendarHistoryUnavailableError,
  )
})

test('returns the entity, its ranked markets and at most 3 releases strictly before the date', async () => {
  const rest = fakeRest({
    entities: [ENTITY],
    // One release ON the date itself plus five before it, intentionally out of order.
    releases: [
      releaseRow({ release_date: '2026-11-20', starts_at: '2026-11-20T13:30:00+00:00' }),
      releaseRow({ release_date: '2026-09-10', starts_at: '2026-09-10T13:30:00+00:00' }),
      releaseRow({ release_date: '2026-07-15', starts_at: '2026-07-15T13:30:00+00:00' }),
      releaseRow({ release_date: '2026-11-19', starts_at: '2026-11-19T13:30:00+00:00' }),
      releaseRow({ release_date: '2026-08-12', starts_at: '2026-08-12T13:30:00+00:00' }),
      releaseRow({ release_date: '2026-10-13' }),
    ],
    markets: [market(2, 'xyz:CL'), market(1, 'BTC')],
  })
  const prices = fakePrices({
    BTC: [candle(RELEASE_AT - HOUR_MS, 100), candle(RELEASE_AT + 23 * HOUR_MS, 102)],
    'xyz:CL': [candle(RELEASE_AT - HOUR_MS, 80), candle(RELEASE_AT + 23 * HOUR_MS, 79)],
  })
  const history = reader({ fetch: rest.fetchImpl, prices: prices.prices, now: () => NOW })
  const body = await history.getHistory('us-cpi', BEFORE)

  assert.deepEqual(body.entity, { slug: 'us-cpi', name: 'US CPI' })
  assert.deepEqual(body.markets, [
    { symbol: 'BTC', displaySymbol: 'BTC', displayName: 'Bitcoin', rank: 1 },
    { symbol: 'xyz:CL', displaySymbol: 'WTI', displayName: 'WTI crude oil', rank: 2 },
  ])
  assert.deepEqual(body.releases.map((release) => release.date), ['2026-11-19', '2026-10-13', '2026-09-10'])

  const entitiesRead = rest.reads.find((read) => read.table === 'entities')!
  assert.deepEqual(
    ['select', 'slug', 'status', 'limit'].map((key) => entitiesRead.params.get(key)),
    ['id,slug,name', 'eq.us-cpi', 'eq.active', '1'],
  )
  const releasesRead = rest.reads.find((read) => read.table === 'event_releases')!
  assert.deepEqual(
    ['select', 'entity_id', 'release_date', 'order', 'limit'].map((key) => releasesRead.params.get(key)),
    ['release_date,starts_at,source_title,period,unit,actual,estimate,previous', `eq.${ENTITY_ID}`, `lt.${BEFORE}`, 'release_date.desc,source_title.desc', '3'],
  )
  const marketsRead = rest.reads.find((read) => read.table === 'entity_markets')!
  assert.deepEqual(
    ['select', 'entity_id', 'order'].map((key) => marketsRead.params.get(key)),
    ['rank,symbol', `eq.${ENTITY_ID}`, 'rank.asc'],
  )
})

test('zero releases and zero markets answer 200 with empty lists', async () => {
  const rest = fakeRest({ entities: [ENTITY], releases: [], markets: [] })
  const prices = fakePrices({ BTC: [candle(RELEASE_AT, 1)] })
  const history = reader({ fetch: rest.fetchImpl, prices: prices.prices, now: () => NOW })
  const body = await history.getHistory('us-cpi', BEFORE)
  assert.deepEqual(body, { entity: { slug: 'us-cpi', name: 'US CPI' }, markets: [], releases: [] })
  assert.equal(prices.calls.length, 0)

  const noMarkets = fakeRest({ entities: [ENTITY], releases: [releaseRow()], markets: [] })
  const priced = fakePrices({ BTC: [candle(RELEASE_AT, 1)] })
  const marketless = reader({ fetch: noMarkets.fetchImpl, prices: priced.prices, now: () => NOW })
  const marketlessBody = await marketless.getHistory('us-cpi', '2026-11-01')
  assert.deepEqual(marketlessBody.markets, [])
  assert.deepEqual(marketlessBody.releases.map((release) => release.moves), [[]])
  assert.equal(priced.calls.length, 0)
})

test('the 24h move compares the close just before the print with the close just before 24h later', async () => {
  const rest = fakeRest({ entities: [ENTITY], releases: [releaseRow()], markets: [market(1, 'BTC')] })
  // Candle t covers t to t + 1h: base is the 13:00 candle's close (price at
  // 13:30's print), end the next day's 13:00 candle's close; the in-progress
  // candles never qualify.
  const prices = fakePrices({
    BTC: [
      candle(RELEASE_AT - 2 * HOUR_MS, 99), candle(RELEASE_AT - HOUR_MS, 100),
      candle(RELEASE_AT, 150), candle(RELEASE_AT + 23 * HOUR_MS, 102), candle(RELEASE_AT + 24 * HOUR_MS, 300),
    ],
  })
  const history = reader({ fetch: rest.fetchImpl, prices: prices.prices, now: () => NOW })
  const body = await history.getHistory('us-cpi', '2026-11-01')
  assert.deepEqual(prices.calls, [
    { symbol: 'BTC', interval: '1h', startMs: RELEASE_AT - 2 * HOUR_MS, endMs: RELEASE_AT + 24 * HOUR_MS },
  ])
  assert.deepEqual(body.releases[0]!.moves, [{ symbol: 'BTC', changePct: 2 }])
  assert.deepEqual(body.releases[0]!.period, 'Oct')
  assert.deepEqual(body.releases[0]!.actual, 3.1)
  assert.deepEqual(body.releases[0]!.estimate, 3.0)
  assert.deepEqual(body.releases[0]!.previous, 2.9)
  assert.deepEqual(body.releases[0]!.startsAt, '2026-10-13T13:30:00+00:00')
  assert.deepEqual(body.releases[0]!.title, 'Inflation Rate YoY')
})

test('an exact-hour release anchors on the hour closes: 18:00 compares 18:00 with the next day 18:00', async () => {
  const rest = fakeRest({
    entities: [ENTITY],
    releases: [releaseRow({ release_date: '2026-10-13', starts_at: '2026-10-13T18:00:00+00:00' })],
    markets: [market(1, 'BTC')],
  })
  const prices = fakePrices({
    BTC: [candle(RELEASE_18 - HOUR_MS, 50), candle(RELEASE_18, 75), candle(RELEASE_18 + 23 * HOUR_MS, 52), candle(RELEASE_18 + 24 * HOUR_MS, 80)],
  })
  const history = reader({ fetch: rest.fetchImpl, prices: prices.prices, now: () => NOW_18 })
  const body = await history.getHistory('us-cpi', '2026-11-01')
  assert.deepEqual(prices.calls, [
    { symbol: 'BTC', interval: '1h', startMs: RELEASE_18 - 2 * HOUR_MS, endMs: RELEASE_18 + 24 * HOUR_MS },
  ])
  assert.deepEqual(body.releases[0]!.moves, [{ symbol: 'BTC', changePct: 4 }])
})

test('no exact time, an unfinished window, a missing anchor or a non-positive base all give null without a change', async () => {
  // No startsAt: the move is skipped, never guessed, and no candle is read.
  const dateOnly = fakeRest({
    entities: [ENTITY],
    releases: [releaseRow({ starts_at: null })],
    markets: [market(1, 'BTC')],
  })
  const dateOnlyPrices = fakePrices({ BTC: [candle(RELEASE_AT, 1)] })
  const dateOnlyHistory = reader({ fetch: dateOnly.fetchImpl, prices: dateOnlyPrices.prices, now: () => NOW })
  let body = await dateOnlyHistory.getHistory('us-cpi', '2026-11-01')
  assert.deepEqual(body.releases[0]!.moves, [{ symbol: 'BTC', changePct: null }])
  assert.equal(dateOnlyPrices.calls.length, 0)

  // The window has not finished 24h after the print.
  const unfinished = fakeRest({ entities: [ENTITY], releases: [releaseRow()], markets: [market(1, 'BTC')] })
  const unfinishedPrices = fakePrices({ BTC: [candle(RELEASE_AT, 1)] })
  const unfinishedHistory = reader({ fetch: unfinished.fetchImpl, prices: unfinishedPrices.prices, now: () => RELEASE_AT + 23 * HOUR_MS })
  body = await unfinishedHistory.getHistory('us-cpi', '2026-11-01')
  assert.deepEqual(body.releases[0]!.moves, [{ symbol: 'BTC', changePct: null }])
  assert.equal(unfinishedPrices.calls.length, 0)

  // No candle at-or-before the print: base anchor missing.
  const lateOnly = fakeRest({ entities: [ENTITY], releases: [releaseRow()], markets: [market(1, 'BTC')] })
  const latePrices = fakePrices({ BTC: [candle(RELEASE_AT, 150), candle(RELEASE_AT + 23 * HOUR_MS, 300)] })
  body = await reader({ fetch: lateOnly.fetchImpl, prices: latePrices.prices, now: () => NOW }).getHistory('us-cpi', '2026-11-01')
  assert.deepEqual(body.releases[0]!.moves, [{ symbol: 'BTC', changePct: null }])

  // A base of zero is not a price.
  const zeroBase = fakeRest({ entities: [ENTITY], releases: [releaseRow()], markets: [market(1, 'BTC')] })
  const zeroPrices = fakePrices({
    BTC: [candle(RELEASE_AT - 2 * HOUR_MS, 0), candle(RELEASE_AT, 150), candle(RELEASE_AT + 23 * HOUR_MS, 300)],
  })
  body = await reader({ fetch: zeroBase.fetchImpl, prices: zeroPrices.prices, now: () => NOW }).getHistory('us-cpi', '2026-11-01')
  assert.deepEqual(body.releases[0]!.moves, [{ symbol: 'BTC', changePct: null }])
})

test('one market failing is contained: its move is null, the others fill, and the response is not cached', async () => {
  const rest = fakeRest({ entities: [ENTITY], releases: [releaseRow()], markets: [market(1, 'BTC'), market(2, 'ETH')] })
  const prices = fakePrices({
    BTC: 'error',
    ETH: [candle(RELEASE_AT - HOUR_MS, 100), candle(RELEASE_AT + 23 * HOUR_MS, 102)],
  })
  const history = reader({ fetch: rest.fetchImpl, prices: prices.prices, now: () => NOW })
  let body = await history.getHistory('us-cpi', '2026-11-01')
  assert.deepEqual(body.releases[0]!.moves, [
    { symbol: 'BTC', changePct: null },
    { symbol: 'ETH', changePct: 2 },
  ])
  assert.equal(prices.calls.length, 2)

  // The failed move is retried on the next request; the finished ETH move is not re-fetched.
  prices.table.delete('BTC')
  prices.table.set('BTC', [candle(RELEASE_AT - HOUR_MS, 200), candle(RELEASE_AT + 23 * HOUR_MS, 102)])
  body = await history.getHistory('us-cpi', '2026-11-01')
  assert.deepEqual(body.releases[0]!.moves, [
    { symbol: 'BTC', changePct: -49 },
    { symbol: 'ETH', changePct: 2 },
  ])
  assert.deepEqual(prices.calls.map((call) => call.symbol), ['BTC', 'ETH', 'BTC'])
})

test('moves follow market rank order and display names come from the names table', async () => {
  const rest = fakeRest({
    entities: [ENTITY],
    releases: [releaseRow()],
    markets: [market(3, 'xyz:CL'), market(1, 'BTC'), market(2, 'xyz:SP500')],
  })
  const prices = fakePrices({
    BTC: [candle(RELEASE_AT - HOUR_MS, 100), candle(RELEASE_AT + 23 * HOUR_MS, 102)],
    'xyz:SP500': [candle(RELEASE_AT - HOUR_MS, 5000), candle(RELEASE_AT + 23 * HOUR_MS, 5050)],
    'xyz:CL': [candle(RELEASE_AT - HOUR_MS, 80), candle(RELEASE_AT + 23 * HOUR_MS, 78.4)],
  })
  const history = reader({ fetch: rest.fetchImpl, prices: prices.prices, now: () => NOW })
  const body = await history.getHistory('us-cpi', '2026-11-01')
  assert.deepEqual(body.markets, [
    { symbol: 'BTC', displaySymbol: 'BTC', displayName: 'Bitcoin', rank: 1 },
    { symbol: 'xyz:SP500', displaySymbol: 'SPX', displayName: 'S&P 500', rank: 2 },
    { symbol: 'xyz:CL', displaySymbol: 'WTI', displayName: 'WTI crude oil', rank: 3 },
  ])
  assert.deepEqual(body.releases[0]!.moves.map((move) => move.symbol), ['BTC', 'xyz:SP500', 'xyz:CL'])
  assert.deepEqual(body.releases[0]!.moves.map((move) => move.changePct), [2, 1, -2])
})

test('a finished move is fetched once: the response cache serves 10 minutes and the move cache outlives it', async () => {
  const rest = fakeRest({ entities: [ENTITY], releases: [releaseRow()], markets: [market(1, 'BTC')] })
  const prices = fakePrices({ BTC: [candle(RELEASE_AT - HOUR_MS, 100), candle(RELEASE_AT + 23 * HOUR_MS, 102)] })
  let now = NOW
  const history = reader({ fetch: rest.fetchImpl, prices: prices.prices, now: () => now })
  const first = await history.getHistory('us-cpi', BEFORE)
  assert.equal(rest.reads.length, 3)
  assert.equal(prices.calls.length, 1)

  // Within the 10-minute response TTL: no reads, no candle calls at all.
  now += 60_000
  assert.deepEqual(await history.getHistory('us-cpi', BEFORE), first)
  assert.equal(rest.reads.length, 3)
  assert.equal(prices.calls.length, 1)

  // Past the response TTL the reads refresh, but the finished move stays cached.
  now += 15 * 60_000
  const third = await history.getHistory('us-cpi', BEFORE)
  assert.deepEqual(third, first)
  assert.equal(rest.reads.length, 6)
  assert.equal(prices.calls.length, 1)
})

test('a null move from a failed fetch is retried on the next request instead of being served cached', async () => {
  const rest = fakeRest({ entities: [ENTITY], releases: [releaseRow()], markets: [market(1, 'BTC')] })
  const prices = fakePrices({ BTC: 'error' })
  const now = NOW
  const history = reader({ fetch: rest.fetchImpl, prices: prices.prices, now: () => now })
  assert.deepEqual(
    (await history.getHistory('us-cpi', '2026-11-01')).releases[0]!.moves,
    [{ symbol: 'BTC', changePct: null }],
  )
  prices.table.delete('BTC')
  prices.table.set('BTC', [candle(RELEASE_AT - HOUR_MS, 100), candle(RELEASE_AT + 23 * HOUR_MS, 102)])
  const second = await history.getHistory('us-cpi', '2026-11-01')
  assert.deepEqual(second.releases[0]!.moves, [{ symbol: 'BTC', changePct: 2 }])
  assert.equal(prices.calls.length, 2)
  // The retryed request had no failure, so it is response-cached from here on.
  const readsBefore = rest.reads.length
  assert.deepEqual(await history.getHistory('us-cpi', '2026-11-01'), second)
  assert.equal(rest.reads.length, readsBefore)
})

test('candlesBetween posts candleSnapshot with the exact window and parses candles like `candles`', async () => {
  const bodies: unknown[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.hyperliquid.xyz/info')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(init?.headers, { 'Content-Type': 'application/json' })
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json([
      { t: '1763632800000', T: '1763636399999', s: 'BTC', i: '1h', o: '100.5', c: '101', h: '102', l: '100', v: '12.5', n: 60 },
      { t: '1763629200000', T: '1763632799999', s: 'BTC', i: '1h', o: '99.5', c: '100', h: '101', l: '99', v: '11.5', n: 61 },
    ])
  }
  const prices = createHyperliquidPrices({ fetch: fetchImpl })
  const candles = await prices.candlesBetween('BTC', '1h', 1763629200000, 1763715600000)
  assert.deepEqual(bodies, [{
    type: 'candleSnapshot',
    req: { coin: 'BTC', interval: '1h', startTime: 1763629200000, endTime: 1763715600000 },
  }])
  assert.deepEqual(candles, [
    { timeMs: 1763629200000, open: 99.5, high: 101, low: 99, close: 100, volume: 11.5 },
    { timeMs: 1763632800000, open: 100.5, high: 102, low: 100, close: 101, volume: 12.5 },
  ])
})

console.log('calendar history tests passed')
