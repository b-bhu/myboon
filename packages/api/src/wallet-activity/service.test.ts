import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { createWalletActivityRoutes } from './routes.js'
import { createWalletActivityService } from './service.js'
import type { SeedToken } from './types.js'

const TOKEN_A = 'A'.repeat(32)
const TOKEN_B = 'B'.repeat(32)
const WALLET = 'C'.repeat(32)
const WALLET_2 = 'D'.repeat(32)
const SIG_1 = 'E'.repeat(88)
const SIG_2 = 'F'.repeat(88)
const NOW = Date.parse('2026-10-08T10:00:00.000Z')
const TOKENS: SeedToken[] = [
  { address: TOKEN_A, symbol: 'AAA', name: 'Alpha' },
  { address: TOKEN_B, symbol: 'BBB', name: 'Beta' },
]

type RequestHandler = (url: URL, calls: number) => Response | Promise<Response>

function service(handler: RequestHandler, overrides: Record<string, unknown> = {}) {
  let calls = 0
  const fetchImpl: typeof fetch = async (input) => {
    calls += 1
    return handler(new URL(String(input)), calls)
  }
  const instance = createWalletActivityService({
    apiKey: 'test-key',
    apiBaseUrl: 'https://birdeye.test',
    getSeedTokens: () => ({ tokens: TOKENS, fetchedAt: '2026-10-08T09:59:00.000Z', stale: false }),
    fetchImpl,
    now: () => NOW,
    sleep: async () => undefined,
    requestSpacingMs: 0,
    ...overrides,
  })
  return { instance, calls: () => calls }
}

function holders(rows: unknown[]) {
  return Response.json({ success: true, data: rows })
}

function txs(rows: unknown[]) {
  return Response.json({ success: true, data: { items: rows } })
}

function tx(overrides: Record<string, unknown> = {}) {
  return {
    tx_hash: SIG_1,
    block_unix_time: Math.floor(NOW / 1000) - 60,
    owner: WALLET,
    tx_type: 'swap',
    ins_index: 1,
    inner_ins_index: 0,
    base: {
      address: TOKEN_A,
      symbol: 'AAA',
      ui_amount: 2,
      ui_change_amount: 2,
      type_swap: 'to',
      price: 1.5,
    },
    quote: { address: TOKEN_B, type_swap: 'from', ui_amount: 3, price: 1 },
    ...overrides,
  }
}

test('discovers tagged wallets and parses supported buys/sells with filters and ordering', async () => {
  const fixture = service((url) => {
    if (url.pathname.includes('/holder-positions')) {
      return holders([
        { wallet_address: WALLET, labels: ['kol'] },
        { wallet_address: WALLET, labels: ['smart_trader'] },
      ])
    }
    return txs([
      tx(),
      tx({ tx_hash: SIG_2, block_unix_time: Math.floor(NOW / 1000) - 120, owner: WALLET, base: { address: TOKEN_A, ui_amount: null, ui_change_amount: -4, type_swap: 'from', price: '2' } }),
      tx({ tx_hash: SIG_2, owner: WALLET, tx_type: 'transfer' }),
      tx({ tx_hash: SIG_2, owner: WALLET, block_unix_time: Math.floor(NOW / 1000) + 1 }),
      tx({ tx_hash: SIG_2, owner: WALLET_2 }),
    ])
  })
  const result = await fixture.instance.getActivity()
  assert.equal(result.status, 'ready')
  assert.equal(result.activities.length, 4)
  const buy = result.activities.find((activity) => activity.action === 'buy')
  const sell = result.activities.find((activity) => activity.action === 'sell' && activity.tokenAddress === TOKEN_A)
  assert.equal(buy?.amount, 2)
  assert.deepEqual(buy?.walletLabels, ['kol', 'smart_trader'])
  assert.equal(sell?.amount, 4)
  assert.equal(sell?.priceUsd, 2)
  assert.equal(sell?.valueUsd, 8)
  assert.equal(fixture.calls(), 3)
})

test('uses at most three holders and caps duplicate events deterministically', async () => {
  const seenWallets: string[] = []
  const fixture = service((url) => {
    if (url.pathname.includes('/holder-positions')) {
      return holders([
        { wallet_address: WALLET, labels: ['kol'] },
        { wallet_address: WALLET_2, labels: ['smart_trader'] },
        { wallet_address: 'G'.repeat(32), labels: ['kol'] },
        { wallet_address: 'H'.repeat(32), labels: ['kol'] },
      ])
    }
    const wallet = url.searchParams.get('address')!
    seenWallets.push(wallet)
    const signature = wallet === WALLET ? SIG_1 : wallet === WALLET_2 ? SIG_2 : 'J'.repeat(88)
    return txs([tx({ owner: wallet, tx_hash: signature }), tx({ owner: wallet, tx_hash: signature })])
  })
  const result = await fixture.instance.getActivity()
  assert.equal(result.status, 'ready')
  assert.equal(result.coverage.walletCount, 3)
  assert.equal(result.activities.length, 6)
  assert.equal(new Set(result.activities.map((item) => item.id)).size, 6)
  assert.equal(seenWallets.length, 3)
})

test('healthy empty is ready, while a failed provider call is partial or unavailable', async () => {
  const empty = service((url) => url.pathname.includes('/holder-positions') ? holders([]) : txs([]))
  const emptyResult = await empty.instance.getActivity()
  assert.equal(emptyResult.status, 'ready')
  assert.deepEqual(emptyResult.activities, [])

  const failed = service((url) => url.pathname.includes('/holder-positions')
    ? new Response('nope', { status: 500 })
    : txs([]))
  const failedResult = await failed.instance.getActivity()
  assert.equal(failedResult.status, 'unavailable')
  assert.equal(failedResult.error?.code, 'BIRDEYE_HTTP_ERROR')
})

test('cache and in-flight deduplicate refreshes, and route validates chain', async () => {
  let resolveFirst: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { resolveFirst = resolve })
  const fixture = service(async (url) => {
    if (url.pathname.includes('/holder-positions')) await gate
    return url.pathname.includes('/holder-positions') ? holders([]) : txs([])
  })
  const first = fixture.instance.getActivity()
  const second = fixture.instance.getActivity()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(fixture.calls(), 1)
  resolveFirst?.()
  await Promise.all([first, second])
  assert.equal(fixture.calls(), 2)
  assert.equal(fixture.calls(), 2)

  const app = new Hono().route('/market', createWalletActivityRoutes({ service: fixture.instance }))
  const invalid = await app.request('/market/wallet-activity?chain=ethereum')
  assert.equal(invalid.status, 400)
  const valid = await app.request('/market/wallet-activity?chain=solana')
  assert.equal(valid.status, 200)
})

test('missing key is unavailable without calling Birdeye', async () => {
  let calls = 0
  const instance = createWalletActivityService({
    getSeedTokens: () => ({ tokens: TOKENS, fetchedAt: null, stale: false }),
    fetchImpl: async () => { calls += 1; return Response.json({}) },
  })
  const result = await instance.getActivity()
  assert.equal(result.status, 'unavailable')
  assert.equal(result.error?.code, 'BIRDEYE_NOT_CONFIGURED')
  assert.equal(calls, 0)
})

test('classification is token scoped and raw atomic amounts are ignored', async () => {
  const fixture = service((url) => {
    if (url.pathname.includes('/holder-positions')) {
      const token = url.searchParams.get('token_address')
      return holders([{ wallet_address: WALLET, labels: token === TOKEN_A ? ['kol'] : ['smart_trader'] }])
    }
    return txs([tx({
      base: { address: TOKEN_A, type_swap: 'to', ui_amount: 2, price: 1 },
      quote: { address: TOKEN_B, type_swap: 'from', ui_amount: 3, price: 2 },
    }), tx({
      tx_hash: 'K'.repeat(88),
      base: { address: TOKEN_A, type_swap: 'to', amount: '2000000', decimals: 6 },
      quote: { address: TOKEN_B, type_swap: 'from', amount: '3000000', decimals: 6 },
    })])
  })
  const result = await fixture.instance.getActivity()
  assert.equal(result.status, 'partial')
  assert.equal(result.activities.length, 2)
  assert.deepEqual(result.activities.find((item) => item.tokenAddress === TOKEN_A)?.walletLabels, ['kol'])
  assert.deepEqual(result.activities.find((item) => item.tokenAddress === TOKEN_B)?.walletLabels, ['smart_trader'])
})

test('malformed envelopes are unavailable rather than healthy empty', async () => {
  const fixture = service((url) => url.pathname.includes('/holder-positions')
    ? Response.json({ success: true, data: { items: [] } })
    : Response.json({ success: true, data: [] }))
  const result = await fixture.instance.getActivity()
  assert.equal(result.status, 'unavailable')
  assert.equal(result.error?.code, 'BIRDEYE_MALFORMED_RESPONSE')
})

test('nonempty malformed holder rows cannot become a ready empty result', async () => {
  const fixture = service((url) => url.pathname.includes('/holder-positions')
    ? holders([{ wallet_address: 'bad', labels: ['kol'] }])
    : txs([]))
  const result = await fixture.instance.getActivity()
  assert.equal(result.status, 'unavailable')
  assert.equal(result.error?.code, 'BIRDEYE_MALFORMED_RESPONSE')
})

test('oversized provider bodies are rejected before row parsing', async () => {
  const fixture = service((url) => url.pathname.includes('/holder-positions')
    ? Response.json({ success: true, data: [] })
    : txs([]), { maxResponseBytes: 10 })
  const result = await fixture.instance.getActivity()
  assert.equal(result.status, 'unavailable')
  assert.equal(result.error?.code, 'BIRDEYE_RESPONSE_TOO_LARGE')
})

test('partial refresh preserves last-good freshness and stale fallback expires', async () => {
  let clock = NOW
  let failed = false
  const fixture = service((url) => {
    if (failed && url.pathname.includes('/holder-positions')) return new Response('nope', { status: 503 })
    return url.pathname.includes('/holder-positions') ? holders([]) : txs([])
  }, {
    now: () => clock,
    cacheTtlMs: 0,
    maxStaleMs: 60 * 60 * 1000,
    getSeedTokens: () => ({ tokens: TOKENS, fetchedAt: new Date(clock - 1 * 60_000).toISOString(), stale: false }),
  })
  const first = await fixture.instance.getActivity()
  assert.equal(first.status, 'ready')
  const firstFetchedAt = first.fetchedAt
  failed = true
  clock += 30 * 60 * 1000
  const stale = await fixture.instance.getActivity()
  assert.equal(stale.status, 'stale')
  assert.equal(stale.fetchedAt, firstFetchedAt)
  clock += 31 * 60 * 1000
  const expired = await fixture.instance.getActivity()
  assert.equal(expired.status, 'unavailable')
})

test('seed-stale partial results keep stale and partial flags consistent', async () => {
  let clock = NOW
  const fixture = service((url) => {
    if (url.pathname.includes('/holder-positions')) {
      return url.searchParams.get('token_address') === TOKEN_A
        ? holders([{ wallet_address: WALLET, labels: ['kol'] }])
        : new Response('temporary', { status: 503 })
    }
    return txs([])
  }, {
    now: () => clock,
    getSeedTokens: () => ({ tokens: TOKENS, fetchedAt: new Date(clock - 10 * 60_000).toISOString(), stale: true }),
  })
  const result = await fixture.instance.getActivity()
  assert.equal(result.status, 'stale')
  assert.equal(result.stale, true)
  assert.equal(result.partial, true)
})

test('seed snapshots older than thirty minutes are unavailable', async () => {
  const fixture = service((url) => url.pathname.includes('/holder-positions') ? holders([]) : txs([]), {
    getSeedTokens: () => ({ tokens: TOKENS, fetchedAt: new Date(NOW - 31 * 60_000).toISOString(), stale: true }),
  })
  const result = await fixture.instance.getActivity()
  assert.equal(result.status, 'unavailable')
  assert.equal(result.error?.code, 'SEEDS_UNAVAILABLE')
  assert.equal(fixture.calls(), 0)
})

test('stale failure cache does not replay activities past the six-hour limit', async () => {
  let clock = NOW
  let failed = false
  const fixture = service((url) => {
    if (failed && url.pathname.includes('/holder-positions')) return new Response(null, { status: 429, headers: { 'retry-after': '86400' } })
    return url.pathname.includes('/holder-positions') ? holders([{ wallet_address: WALLET, labels: ['kol'] }]) : txs([tx()])
  }, {
    now: () => clock,
    cacheTtlMs: 0,
    maxStaleMs: 60 * 60 * 1000,
    getSeedTokens: () => ({ tokens: TOKENS, fetchedAt: new Date(clock - 1 * 60_000).toISOString(), stale: false }),
  })
  const ready = await fixture.instance.getActivity()
  assert.equal(ready.status, 'ready')
  assert.equal(ready.activities.length, 2)
  failed = true
  clock += 60 * 60 * 1000
  const stale = await fixture.instance.getActivity()
  assert.equal(stale.status, 'stale')
  assert.equal(stale.activities.length, 2)
  clock += 6 * 60 * 60 * 1000
  const expired = await fixture.instance.getActivity()
  assert.equal(expired.status, 'unavailable')
  assert.equal(expired.activities.length, 0)
})

test('access denial and 429 retry-after prevent repeated upstream calls', async () => {
  let clock = NOW
  let calls = 0
  const denied = createWalletActivityService({
    apiKey: 'test-key',
    getSeedTokens: () => ({ tokens: TOKENS, fetchedAt: '2026-10-08T09:59:00.000Z', stale: false }),
    now: () => clock,
    requestSpacingMs: 0,
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 403 }) },
  })
  const firstDenied = await denied.getActivity()
  const secondDenied = await denied.getActivity()
  assert.equal(firstDenied.status, 'unavailable')
  assert.equal(secondDenied.status, 'unavailable')
  assert.equal(calls, 1)

  calls = 0
  const limited = createWalletActivityService({
    apiKey: 'test-key',
    getSeedTokens: () => ({ tokens: TOKENS, fetchedAt: '2026-10-08T09:59:00.000Z', stale: false }),
    now: () => clock,
    requestSpacingMs: 0,
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 429, headers: { 'retry-after': '60' } }) },
  })
  const firstLimited = await limited.getActivity()
  const secondLimited = await limited.getActivity()
  assert.equal(firstLimited.status, 'unavailable')
  assert.equal(secondLimited.status, 'unavailable')
  assert.equal(calls, 1)
  clock += 61_000
  await limited.getActivity()
  assert.equal(calls, 2)
})

test('HTTP 408 is reported as retryable', async () => {
  const fixture = service((url) => url.pathname.includes('/holder-positions')
    ? new Response(null, { status: 408 })
    : txs([]))
  const result = await fixture.instance.getActivity()
  assert.equal(result.status, 'unavailable')
  assert.equal(result.error?.code, 'BIRDEYE_HTTP_ERROR')
  assert.equal(result.error?.retryable, true)
})

test('request timeout aborts a hanging provider and completes the refresh', async () => {
  const fixture = service((_url, _calls) => new Promise<Response>(() => undefined), { requestTimeoutMs: 5, refreshDeadlineMs: 20, requestSpacingMs: 0 })
  const result = await fixture.instance.getActivity()
  assert.equal(result.status, 'unavailable')
  assert.ok(result.error?.code === 'BIRDEYE_TIMEOUT' || result.error?.code === 'BIRDEYE_REFRESH_TIMEOUT')
})

test('Jupiter outage preserves observed wallet activity until its original freshness expires', async () => {
  let clock = NOW
  let seedFailure = false
  const fixture = service((url) => url.pathname.includes('/holder-positions')
    ? holders([{ wallet_address: WALLET, labels: ['kol'] }]) : txs([tx()]), {
    now: () => clock, cacheTtlMs: 0, cooldownMs: 0,
    getSeedTokens: () => {
      if (seedFailure) throw new Error('Jupiter unavailable')
      return { tokens: TOKENS, fetchedAt: new Date(clock).toISOString(), stale: false }
    },
  })
  const first = await fixture.instance.getActivity()
  const reads = fixture.calls()
  seedFailure = true
  clock += 60_000
  const stale = await fixture.instance.getActivity()
  assert.equal(stale.status, 'stale')
  assert.deepEqual(stale.activities, first.activities)
  assert.equal(stale.fetchedAt, first.fetchedAt)
  assert.deepEqual(stale.coverage, first.coverage)
  assert.equal(fixture.calls(), reads)
  clock = NOW + 6 * 60 * 60_000 + 1
  const expired = await fixture.instance.getActivity()
  assert.equal(expired.status, 'unavailable')
  assert.deepEqual(expired.activities, [])
})

test('outage keeps the newest partial snapshot and expires that snapshot during rate-limit cooldown', async () => {
  let clock = NOW
  let phase = 0
  const fixture = service((url) => {
    if (phase === 2) return new Response(null, { status: 429, headers: { 'retry-after': '86400' } })
    if (url.pathname.includes('/holder-positions')) {
      if (phase === 1 && url.searchParams.get('token_address') === TOKEN_B) return new Response(null, { status: 503 })
      return holders([{ wallet_address: WALLET, labels: ['kol'] }])
    }
    return txs([tx({ base: { address: TOKEN_A, type_swap: 'to', ui_amount: phase === 1 ? 9 : 2, price: 1.5 } })])
  }, { now: () => clock, cacheTtlMs: 0,
    getSeedTokens: () => ({ tokens: TOKENS, fetchedAt: new Date(clock).toISOString(), stale: false }) })
  await fixture.instance.getActivity()
  phase = 1
  clock += 10 * 60_000
  const partial = await fixture.instance.getActivity()
  assert.equal(partial.status, 'partial')
  assert.equal(partial.activities[0]?.amount, 9)
  phase = 2
  clock += 10 * 60_000
  const stale = await fixture.instance.getActivity()
  assert.equal(stale.status, 'stale')
  assert.deepEqual(stale.activities, partial.activities)
  assert.equal(stale.fetchedAt, partial.fetchedAt)
  const reads = fixture.calls()
  clock = Date.parse(partial.fetchedAt!) + 6 * 60 * 60_000 + 1
  const expired = await fixture.instance.getActivity()
  assert.equal(expired.status, 'unavailable')
  assert.deepEqual(expired.activities, [])
  assert.equal(fixture.calls(), reads)
})

test('empty or unsupported chain is rejected before reading providers', async () => {
  let reads = 0
  const app = new Hono().route('/market', createWalletActivityRoutes({ service: { getActivity: async () => {
    reads += 1
    throw new Error('Must not load')
  } } }))
  for (const chain of ['', 'ethereum']) {
    const response = await app.request(`/market/wallet-activity?chain=${chain}`)
    assert.equal(response.status, 400)
  }
  assert.equal(reads, 0)
})
