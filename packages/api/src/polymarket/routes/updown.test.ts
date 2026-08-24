import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyUpDownSlug,
  PolymarketUpDownService,
  UP_DOWN_SERIES,
  type UpDownReadService,
} from '../read/updown.js'
import {
  parseRtdsCryptoPriceMessage,
  SupabaseUpDownReferencePriceStore,
  UpDownPriceService,
  type UpDownReferencePrice,
  type UpDownRoundIdentity,
} from '../read/updown-prices.js'
import { createPolymarketUpDownRoutes } from './updown.js'

const NOW = Date.parse('2026-08-24T12:22:00.000Z')

test('classifies dated hourly slugs with a year and keeps daily slugs separate', () => {
  assert.deepEqual(classifyUpDownSlug('bitcoin-up-or-down-august-24-2026-8am-et'), {
    asset: 'btc',
    duration: 'hourly',
  })
  assert.deepEqual(classifyUpDownSlug('ethereum-up-or-down-on-august-24-2026'), {
    asset: 'eth',
    duration: 'daily',
  })
})

test('selects the current event by market boundary and refreshes Higher/Lower with CLOB midpoints', async () => {
  const requestedSeries: string[] = []
  const priceService = {
    async getReferencePrice(round: UpDownRoundIdentity): Promise<UpDownReferencePrice> {
      return {
        value: round.duration === 'hourly' ? 78_443.65 : 77_196.92,
        source: 'binance',
        symbol: round.asset === 'btc' ? 'BTCUSDT' : 'ETHUSDT',
        interval: round.duration === 'hourly' ? '1h' : '1m',
        valueType: round.duration === 'hourly' ? 'open' : 'close',
        boundaryTime: round.startDate,
        observedAt: round.startDate,
      }
    },
    async getCurrentPrice(asset: 'btc' | 'eth') {
      return {
        value: asset === 'btc' ? 78_500 : 4_200,
        source: 'polymarket_rtds_binance' as const,
        symbol: asset === 'btc' ? 'BTCUSDT' as const : 'ETHUSDT' as const,
        observedAt: new Date(NOW).toISOString(),
      }
    },
    async getHistory() {
      return { source: 'binance' as const, symbol: 'BTCUSDT' as const, interval: '1m' as const, points: [] }
    },
  }
  const service = new PolymarketUpDownService({
    now: () => NOW,
    cacheTtlMs: 0,
    priceService,
    fetchSeries: async (seriesId) => {
      requestedSeries.push(seriesId)
      const asset = seriesId === UP_DOWN_SERIES.btc.hourly || seriesId === UP_DOWN_SERIES.btc.daily
        ? 'bitcoin'
        : 'ethereum'
      const duration = seriesId === UP_DOWN_SERIES.btc.hourly || seriesId === UP_DOWN_SERIES.eth.hourly
        ? 'hourly'
        : 'daily'
      return [
        fixtureEvent(asset, duration, '2026-08-24T13:00:00.000Z', '2026-08-24T14:00:00.000Z', 'future'),
        fixtureEvent(
          asset,
          duration,
          duration === 'hourly' ? '2026-08-24T12:00:00.000Z' : '2026-08-23T16:00:00.000Z',
          duration === 'hourly' ? '2026-08-24T13:00:00.000Z' : '2026-08-24T16:00:00.000Z',
          'current',
        ),
      ]
    },
    fetchMidpoints: async (tokenIds) => new Map(tokenIds.map((tokenId) => (
      [tokenId, tokenId.includes('up-token') ? 0.61 : 0.39]
    ))),
  })

  const result = await service.getRounds()

  assert.deepEqual(new Set(requestedSeries), new Set(['10114', '41', '10117', '40']))
  assert.equal(result.btc.hourly?.slug, 'bitcoin-hourly-current')
  assert.equal(result.btc.hourly?.startDate, '2026-08-24T12:00:00.000Z')
  assert.equal(result.btc.hourly?.upPrice, 0.61)
  assert.equal(result.btc.hourly?.downPrice, 0.39)
  assert.deepEqual(result.btc.hourly?.clobTokenIds, ['bitcoin-hourly-up-token', 'bitcoin-hourly-down-token'])
  assert.equal(result.btc.hourly?.priceToBeat, 78_443.65)
  assert.equal(result.btc.hourly?.currentPrice, 78_500)
  assert.equal(result.eth.daily?.slug, 'ethereum-daily-current')
})

test('parses only Binance crypto RTDS updates', () => {
  assert.deepEqual(parseRtdsCryptoPriceMessage(JSON.stringify({
    topic: 'crypto_prices',
    type: 'update',
    timestamp: NOW,
    payload: { symbol: 'btcusdt', timestamp: NOW, value: 78_500.25 },
  })), {
    asset: 'btc',
    value: 78_500.25,
    observedAt: '2026-08-24T12:22:00.000Z',
  })
  assert.equal(parseRtdsCryptoPriceMessage('PONG'), null)
  assert.equal(parseRtdsCryptoPriceMessage(JSON.stringify({ topic: 'crypto_prices_chainlink' })), null)
})

test('uses Binance candle open for hourly targets and candle close for daily targets', async () => {
  const requested: URL[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input))
    requested.push(url)
    const openTime = Number(url.searchParams.get('startTime'))
    return Response.json([[openTime, '78443.65', '0', '0', '77196.92', '0', openTime + 59_999]])
  }
  const service = new UpDownPriceService(undefined, fetchImpl, { get: () => null })
  const hourly = await service.getReferencePrice(round('hourly', '2026-08-24T12:00:00.000Z'))
  const daily = await service.getReferencePrice(round('daily', '2026-08-23T16:00:00.000Z'))

  assert.equal(hourly?.value, 78_443.65)
  assert.equal(hourly?.valueType, 'open')
  assert.equal(hourly?.interval, '1h')
  assert.equal(daily?.value, 77_196.92)
  assert.equal(daily?.valueType, 'close')
  assert.equal(daily?.interval, '1m')
  assert.equal(requested[0]?.hostname, 'api.binance.com')
})

test('persists reference prices through server-role-only Supabase REST requests', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    if (!init?.method) {
      return Response.json([{
        round_slug: 'bitcoin-hourly',
        asset: 'btc',
        duration: 'hourly',
        boundary_time: '2026-08-24T12:00:00.000Z',
        price: '78443.65',
        source: 'binance',
        source_symbol: 'BTCUSDT',
        source_interval: '1h',
        source_value_type: 'open',
        observed_at: '2026-08-24T12:00:01.000Z',
      }])
    }
    return new Response(null, { status: 201 })
  }
  const store = new SupabaseUpDownReferencePriceStore(
    'https://project.supabase.co/',
    'server-secret',
    fetchImpl,
  )

  const stored = await store.get('bitcoin-hourly')
  assert.equal(stored?.value, 78_443.65)
  await store.upsert(round('hourly', '2026-08-24T12:00:00.000Z'), stored!)

  assert.match(requests[0]?.url ?? '', /polymarket_updown_reference_prices\?/)
  assert.equal((requests[0]?.init?.headers as Record<string, string>).Authorization, 'Bearer server-secret')
  assert.equal(requests[1]?.init?.method, 'POST')
  assert.equal((requests[1]?.init?.headers as Record<string, string>).Prefer, 'resolution=merge-duplicates,return=minimal')
})

test('validates history selectors and returns 404 when no round is active', async () => {
  const service: UpDownReadService = {
    async getRounds() {
      return { btc: { hourly: null, daily: null }, eth: { hourly: null, daily: null } }
    },
    async getHistory() { return null },
  }
  const app = createPolymarketUpDownRoutes({ service })

  assert.equal((await app.request('/updown/sol/hourly/history')).status, 400)
  assert.equal((await app.request('/updown/btc/hourly/history')).status, 404)
})

function fixtureEvent(
  asset: string,
  duration: string,
  boundary: string,
  end: string,
  suffix: string,
) {
  return {
    slug: `${asset}-${duration}-${suffix}`,
    title: `${asset} ${duration}`,
    // Deliberately a publication timestamp: this must not become the round start.
    startDate: '2026-08-22T12:00:10.000Z',
    endDate: end,
    active: true,
    closed: false,
    volume24hr: 1234,
    markets: [{
      eventStartTime: boundary,
      endDate: end,
      active: true,
      closed: false,
      acceptingOrders: true,
      outcomes: JSON.stringify(['Down', 'Up']),
      outcomePrices: JSON.stringify(['0.55', '0.45']),
      clobTokenIds: JSON.stringify([`${asset}-${duration}-down-token`, `${asset}-${duration}-up-token`]),
      conditionId: `${asset}-${duration}-condition`,
      description: 'Binance candle rule',
      resolutionSource: `https://www.binance.com/en/trade/${asset.toUpperCase()}_USDT`,
    }],
  }
}

function round(duration: 'hourly' | 'daily', startDate: string): UpDownRoundIdentity {
  return {
    slug: `bitcoin-${duration}`,
    asset: 'btc',
    duration,
    startDate,
    endDate: '2026-08-24T16:00:00.000Z',
  }
}
