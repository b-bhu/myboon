import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import {
  fetchJupiterVerifiedSnapshot,
  JupiterProviderError,
  MAX_PROVIDER_BODY_BYTES,
  MAX_PROVIDER_ROWS,
  normalizeJupiterSnapshot,
} from './jupiter.js'
import { createMarketHeatmapRoutes } from './routes.js'
import { MarketHeatmapService } from './service.js'
import type { MarketHeatmapInterval, MarketHeatmapResponse } from './types.js'

const API_KEY = 'test-jupiter-key'
const API_BASE = 'https://jupiter.test'
const MINT_A = 'So11111111111111111111111111111111111111112'
const MINT_B = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const MINT_C = '11111111111111111111111111111111'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

const INTERVALS: readonly MarketHeatmapInterval[] = ['5m', '1h', '6h', '24h']

function metric(buyVolume: unknown = 10, sellVolume: unknown = 5, priceChange: unknown = 1) {
  return { buyVolume, sellVolume, priceChange }
}

function token(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    symbol: 'AAA',
    name: 'Alpha',
    isVerified: true,
    usdPrice: 1,
    mcap: 1_000,
    liquidity: 500,
    stats5m: metric(),
    stats1h: metric(),
    stats6h: metric(),
    stats24h: metric(),
    ...overrides,
  }
}

function payload(items: unknown[]) {
  return items
}

function response(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, { status, headers })
}

function routeApp(options: ConstructorParameters<typeof MarketHeatmapService>[0] = {}) {
  const app = new Hono()
  app.route('/market', createMarketHeatmapRoutes(options))
  return app
}

test('uses the fixed verified-token endpoint and server API key', async () => {
  let calledUrl = ''
  let calledInit: RequestInit | undefined
  await fetchJupiterVerifiedSnapshot({
    jupApiKey: API_KEY,
    jupApiBase: `${API_BASE}/`,
    fetchImpl: async (input, init) => {
      calledUrl = String(input)
      calledInit = init
      return response(payload([token(MINT_A)]))
    },
  })
  const url = new URL(calledUrl)
  assert.equal(url.origin, API_BASE)
  assert.equal(url.pathname, '/tokens/v2/tag')
  assert.equal(url.searchParams.get('query'), 'verified')
  assert.deepEqual(calledInit?.headers, { Accept: 'application/json', 'x-api-key': API_KEY })
})

test('shares one normalized provider snapshot across all windows with distinct volume/change values', async () => {
  let calls = 0
  const service = new MarketHeatmapService({
    jupApiKey: API_KEY,
    jupApiBase: API_BASE,
    fetchImpl: async () => {
      calls++
      return response(payload([token(MINT_A, {
        stats5m: metric(2, 1, -2),
        stats1h: metric(20, 10, 4),
        stats6h: metric(6, 1, 8),
        stats24h: metric(40, 20, 12),
      })]))
    },
  })
  const [short, long] = await Promise.all([service.getHeatmap('5m'), service.getHeatmap('24h')])
  assert.equal(calls, 1)
  assert.equal(short.tokens[0]!.volumeUsd, 3)
  assert.equal(short.tokens[0]!.priceChangePct, -2)
  assert.equal(long.tokens[0]!.volumeUsd, 60)
  assert.equal(long.tokens[0]!.priceChangePct, 12)
  assert.equal(short.fetchedAt, long.fetchedAt)
})

test('requires verified rows, excludes canonical stables, backfills, deduplicates and caps each window at twenty', () => {
  const suffixes = '123456789ABCDEFGHJKLMNPQRSTUVWX'.split('')
  const rows = suffixes.slice(0, 22).map((suffix, index) => token(`${MINT_A.slice(0, -1)}${suffix}`, {
    symbol: `T${index}`,
    stats5m: metric(100 - index, 0, index - 10),
  }))
  rows.push(token(USDC_MINT, { symbol: 'USDC', stats5m: metric(10_000, 0, 0) }))
  rows.push(token(USDT_MINT, { symbol: 'USDT', stats5m: metric(9_000, 0, 0) }))
  rows.push(token(MINT_B, { isVerified: false, stats5m: metric(50_000, 0, 0) }))
  rows.push({ id: MINT_C, symbol: 'UNKNOWN', name: 'Unknown', isVerified: false, stats5m: metric(40_000, 0, 0) })
  const result = normalizeJupiterSnapshot(payload(rows))
  const fiveMinute = result.tokens
    .filter((row) => (row.metrics['5m'].volumeUsd ?? 0) > 0)
    .sort((left, right) => (right.metrics['5m'].volumeUsd! - left.metrics['5m'].volumeUsd!))
  assert.equal(fiveMinute.length, 20)
  assert.equal(fiveMinute.some((row) => row.address === USDC_MINT || row.address === USDT_MINT), false)
  assert.equal(fiveMinute.some((row) => row.address === MINT_B || row.address === MINT_C), false)
  assert.equal(result.partial, false)
})

test('marks missing or invalid metrics partial while retaining valid signed changes', () => {
  const result = normalizeJupiterSnapshot(payload([
    token(MINT_A, {
      usdPrice: -1,
      stats5m: { buyVolume: 10, sellVolume: -2, priceChange: -4 },
      stats1h: undefined,
    }),
  ]))
  assert.equal(result.partial, true)
  const normalized = result.tokens.find((row) => row.address === MINT_A)!
  assert.equal(normalized.priceUsd, null)
  assert.equal(normalized.metrics['5m'].volumeUsd, null)
  assert.equal(normalized.metrics['5m'].priceChangePct, -4)
  assert.equal(normalized.metrics['1h'].volumeUsd, null)
})

test('does not rank metrics with a missing volume leg or overflowing total', () => {
  const result = normalizeJupiterSnapshot(payload([
    token(MINT_A, {
      stats5m: { buyVolume: 10, priceChange: 4 },
      stats1h: metric(Number.MAX_VALUE, Number.MAX_VALUE, 5),
    }),
  ]))
  const normalized = result.tokens.find((row) => row.address === MINT_A)!
  assert.equal(normalized.metrics['5m'].volumeUsd, null)
  assert.equal(normalized.metrics['5m'].partial, true)
  assert.equal(normalized.metrics['1h'].volumeUsd, null)
  assert.equal(normalized.metrics['1h'].partial, true)
  assert.equal(result.partialByInterval['5m'], true)
  assert.equal(result.partialByInterval['1h'], true)
})

test('keeps partial state scoped to the affected window and preserves healthy zero volume', async () => {
  const row = token(MINT_A, {
    stats5m: metric(0, 0, 0),
    stats1h: undefined,
  })
  const normalized = normalizeJupiterSnapshot(payload([row]))
  assert.equal(normalized.partialByInterval['5m'], false)
  assert.equal(normalized.partialByInterval['1h'], true)
  assert.equal(normalized.tokens[0]!.metrics['5m'].volumeUsd, 0)
  assert.equal(normalized.tokens[0]!.metrics['5m'].partial, false)

  const service = new MarketHeatmapService({
    jupApiKey: API_KEY,
    fetchImpl: async () => response(payload([row])),
  })
  assert.equal((await service.getHeatmap('5m')).status, 'ready')
  assert.equal((await service.getHeatmap('1h')).status, 'partial')
})

test('rejects oversized bodies and provider row floods before retaining payload data', async () => {
  await assert.rejects(fetchJupiterVerifiedSnapshot({
    jupApiKey: API_KEY,
    fetchImpl: async () => new Response(`[${' '.repeat(MAX_PROVIDER_BODY_BYTES)}]`),
  }), (error) => error instanceof JupiterProviderError
    && error.detail.code === 'UPSTREAM_RESPONSE_TOO_LARGE')

  assert.throws(
    () => normalizeJupiterSnapshot(Array.from({ length: MAX_PROVIDER_ROWS + 1 }, () => token(MINT_A))),
    (error) => error instanceof JupiterProviderError
      && error.detail.code === 'UPSTREAM_RESPONSE_TOO_LARGE',
  )
})

test('returns ready empty for a valid empty or fully unverified result, but unavailable for incompatible payloads', async () => {
  const empty = await routeApp({
    jupApiKey: API_KEY,
    fetchImpl: async () => response(payload([])),
  }).request('/market/token-heatmap?interval=1h')
  assert.equal(empty.status, 200)
  assert.equal((await empty.json() as MarketHeatmapResponse).status, 'ready')

  const unverified = await routeApp({
    jupApiKey: API_KEY,
    fetchImpl: async () => response(payload([{ id: MINT_A, isVerified: false }])),
  }).request('/market/token-heatmap')
  assert.equal(unverified.status, 200)
  assert.equal((await unverified.json() as MarketHeatmapResponse).status, 'ready')

  assert.throws(
    () => normalizeJupiterSnapshot([{ id: 'foo' }]),
    (error) => error instanceof JupiterProviderError
      && error.detail.code === 'INVALID_UPSTREAM_RESPONSE',
  )

  const incompatible = await routeApp({
    jupApiKey: API_KEY,
    fetchImpl: async () => response({ data: 'wrong-shape', secret: 'never expose' }),
  }).request('/market/token-heatmap')
  assert.equal(incompatible.status, 503)
  const body = await incompatible.json() as MarketHeatmapResponse
  assert.equal(body.status, 'unavailable')
  assert.equal(JSON.stringify(body).includes('never expose'), false)
})

test('rejects invalid interval and non-Solana chain before provider calls', async () => {
  let calls = 0
  const app = routeApp({
    jupApiKey: API_KEY,
    fetchImpl: async () => { calls++; return response(payload([])) },
  })
  assert.equal((await app.request('/market/token-heatmap?interval=12h')).status, 400)
  assert.equal((await app.request('/market/token-heatmap?chain=ethereum')).status, 400)
  assert.equal(calls, 0)
})

test('serves stale cached data through a 429 cooldown and recovers after cooldown', async () => {
  let now = 0
  let calls = 0
  const service = new MarketHeatmapService({
    jupApiKey: API_KEY,
    now: () => now,
    ttlMs: 100,
    maxStaleMs: 5_000,
    cooldownMs: 60,
    fetchImpl: async () => {
      calls++
      return calls === 1
        ? response(payload([token(MINT_A)]))
        : calls === 2 ? response('provider secret', 429) : response(payload([token(MINT_B)]))
    },
  })
  assert.equal((await service.getHeatmap('24h')).status, 'ready')
  now = 101
  const stale = await service.getHeatmap('1h')
  assert.equal(stale.status, 'stale')
  assert.equal(stale.error?.code, 'RATE_LIMITED')
  assert.equal(stale.tokens.length, 1)
  await service.getHeatmap('5m')
  assert.equal(calls, 2)
  now = 162
  assert.equal((await service.getHeatmap('1h')).status, 'ready')
  assert.equal(calls, 3)
})

test('times out and sanitizes provider failures without exposing credentials', async () => {
  await assert.rejects(fetchJupiterVerifiedSnapshot({
    jupApiKey: API_KEY,
    timeoutMs: 5,
    fetchImpl: async (_input, init) => {
      assert.ok(init?.signal)
      return new Promise<Response>(() => {})
    },
  }), (error) => error instanceof JupiterProviderError && error.detail.code === 'UPSTREAM_TIMEOUT')

  const noKey = await new MarketHeatmapService().getHeatmap('1h')
  assert.equal(noKey.error?.code, 'CONFIGURATION')
  assert.equal(JSON.stringify(noKey).includes(API_KEY), false)
})
