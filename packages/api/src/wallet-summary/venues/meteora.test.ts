import assert from 'node:assert/strict'
import test from 'node:test'

// The shared MeteoraDataApiClient (`new MeteoraDataApiClient()` in
// meteora.ts) is module-level and caches per URL, so every test below uses
// its own wallet address and no answer can leak between tests. The client
// defers to `globalThis.fetch` at call time, so the tests swap it and
// restore in a finally — same setup as venues/spot.test.ts.
const { meteoraVenue } = await import('./meteora.js')

// Valid base58 (32-44 chars, no 0/O/I/l) from the shared meteora suite —
// the client decodes the address before calling upstream.
const WALLET_MAPPED = '7iNJ7CLNT8UBPANxkkrsURjzaktbomCVa93N1sKcVo9C'
const WALLET_NULL_PNL = '4xQzFC8N9Y1qeKQMKzBz6iUZmoDXe5vJp4bJvHfxAcnf'
const WALLET_EMPTY = 'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1'
const WALLET_MORE = 'EYj9xKw6ZszwpyNibHY7JD5o3QgTVrSdcBp1fMJhrR9o'
const WALLET_DOWN = 'CoaxzEh8p5YyGLcj36Eo3cUThVJxeKCs7qvLAGDYwBcz'

const context = (solana: string | null) => ({ solana, evm: null, signal: new AbortController().signal })

function stub_fetch(calls: URL[], body: unknown): (input: unknown) => Promise<Response> {
  return async (input) => {
    calls.push(new URL(String(input)))
    return Response.json(body)
  }
}

test('maps value, pools and totals, asking the upstream for 50 pools', async () => {
  const calls: URL[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = stub_fetch(calls, {
    page: 1,
    pageSize: 50,
    hasNext: false,
    totalCount: 2,
    totalPositions: 3,
    total: { currentBalances: '123.75', unclaimedFees: '4.25', pnl: '18.2' },
    pools: [
      {
        poolAddress: 'POOL111111111111111111111111111111111111111',
        tokenX: 'SOL',
        tokenY: 'USDC',
        balances: '100',
        unclaimedFees: '4',
        pnl: '20',
        baseFee: '0.02',
        binStep: 10,
        poolPrice: '98.5',
        outOfRange: false,
        listPositions: ['position-1', 'position-2'],
        positionsOutOfRange: [],
      },
      {
        poolAddress: 'POOL222222222222222222222222222222222222222',
        tokenX: 'JUP',
        tokenY: 'USDC',
        balances: '23.75',
        unclaimedFees: '0.25',
        pnl: '-1.8',
        binStep: 25,
        poolPrice: '0.4',
        outOfRange: true,
      },
    ],
  })

  try {
    const slot = await meteoraVenue.fetch(context(WALLET_MAPPED))
    // The venue asks for the upstream's maximum portfolio page (#726).
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.pathname, '/portfolio/open')
    assert.equal(calls[0]?.searchParams.get('user'), WALLET_MAPPED)
    assert.equal(calls[0]?.searchParams.get('page_size'), '50')

    assert.equal(slot.status, 'ok')
    assert.equal(slot.error, undefined)
    assert.deepEqual(slot, {
      status: 'ok',
      valueUsd: 123.75,
      summary: {
        poolCount: 2,
        totalPools: 2,
        hasMore: false,
        unclaimedFeesUsd: 4.25,
        totalPnlUsd: 18.2,
        pools: [
          { name: 'SOL / USDC', valueUsd: 100, unclaimedFeesUsd: 4, outOfRange: false },
          { name: 'JUP / USDC', valueUsd: 23.75, unclaimedFeesUsd: 0.25, outOfRange: true },
        ],
      },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a nullable P&L stays null while the other totals stay numbers', async () => {
  const calls: URL[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = stub_fetch(calls, {
    page: 1,
    pageSize: 50,
    hasNext: false,
    totalCount: 1,
    totalPositions: 1,
    // The upstream's totals are optional per field; pnl is absent here
    // (some nullable totalPnlUsd, #726) and must map to null.
    total: { currentBalances: '50', unclaimedFees: '1.5' },
    pools: [
      {
        poolAddress: 'POOL333333333333333333333333333333333333333',
        tokenX: 'SOL',
        tokenY: 'USDC',
        balances: '50',
        unclaimedFees: '1.5',
        pnl: '5',
        binStep: 10,
        outOfRange: false,
      },
    ],
  })

  try {
    const slot = await meteoraVenue.fetch(context(WALLET_NULL_PNL))
    assert.deepEqual(slot, {
      status: 'ok',
      valueUsd: 50,
      summary: {
        poolCount: 1,
        totalPools: 1,
        hasMore: false,
        unclaimedFeesUsd: 1.5,
        totalPnlUsd: null,
        pools: [{ name: 'SOL / USDC', valueUsd: 50, unclaimedFeesUsd: 1.5, outOfRange: false }],
      },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an empty portfolio answers ok with valueUsd 0 and no pools', async () => {
  const calls: URL[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = stub_fetch(calls, {
    page: 1,
    pageSize: 50,
    hasNext: false,
    totalCount: 0,
    totalPositions: 0,
    pools: [],
  })

  try {
    const slot = await meteoraVenue.fetch(context(WALLET_EMPTY))
    // Done means (#726): no pools is a real $0 with status 'ok', never
    // unavailable; the absent upstream totals stay null.
    assert.deepEqual(slot, {
      status: 'ok',
      valueUsd: 0,
      summary: {
        poolCount: 0,
        totalPools: 0,
        hasMore: false,
        unclaimedFeesUsd: null,
        totalPnlUsd: null,
        pools: [],
      },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('upstream hasNext becomes hasMore with the true totalPools', async () => {
  const calls: URL[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = stub_fetch(calls, {
    page: 1,
    pageSize: 50,
    hasNext: true,
    totalCount: 3,
    totalPositions: 4,
    total: { currentBalances: '10', unclaimedFees: '0', pnl: '5' },
    pools: [
      {
        poolAddress: 'POOL444444444444444444444444444444444444444',
        tokenX: 'SOL',
        tokenY: 'USDC',
        balances: '7',
        unclaimedFees: '0',
        pnl: '4',
        binStep: 10,
        outOfRange: false,
      },
      {
        poolAddress: 'POOL555555555555555555555555555555555555555',
        tokenX: 'WIF',
        tokenY: 'USDC',
        balances: '3',
        unclaimedFees: '0',
        pnl: '1',
        binStep: 50,
        outOfRange: null,
      },
    ],
  })

  try {
    const slot = await meteoraVenue.fetch(context(WALLET_MORE))
    assert.deepEqual(slot, {
      status: 'ok',
      valueUsd: 10,
      summary: {
        poolCount: 2,
        totalPools: 3,
        hasMore: true,
        unclaimedFeesUsd: 0,
        totalPnlUsd: 5,
        pools: [
          { name: 'SOL / USDC', valueUsd: 7, unclaimedFeesUsd: 0, outOfRange: false },
          { name: 'WIF / USDC', valueUsd: 3, unclaimedFeesUsd: 0, outOfRange: null },
        ],
      },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an upstream failure propagates: the summary service maps it to this app being unavailable', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('db down', { status: 500 })

  try {
    // The venue throws the shared client's error; the service's
    // Promise.allSettled is what turns it into the meteora app's
    // `unavailable` slot while every other app still returns (covered in
    // ../summary.test.ts).
    await assert.rejects(
      meteoraVenue.fetch(context(WALLET_DOWN)),
      /db down/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a summary request without a solana address answers not_connected and calls no upstream', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('meteora venue must not call upstream without a solana address')
  }

  try {
    const slot = await meteoraVenue.fetch(context(null))
    // The same no-account state Polymarket serves for a missing `evm` (#725).
    assert.deepEqual(slot, { status: 'not_connected', valueUsd: null, summary: null })
  } finally {
    globalThis.fetch = originalFetch
  }
})

// --- GET /wallet/meteora/positions (#867) ---------------------------------
const { fetchMeteoraPositions } = await import('./meteora.js')
const { createWalletSummaryRoutes } = await import('../routes.js')
const { Hono } = await import('hono')

const POSITIONS_WALLET = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ'
const POSITIONS_WALLET_MORE = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH'
const POOL_A = 'BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y'
const POOL_B = '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6'

const portfolioPool = (poolAddress: string, tokenX: string, unclaimedFees: string) =>
  ({ poolAddress, tokenX, tokenY: 'USDC', balances: '10', unclaimedFees, pnl: '1', binStep: 10, outOfRange: false })
const upstreamPosition = (positionAddress: string, isOutOfRange: boolean) => ({
  positionAddress, minPrice: '90.5', maxPrice: '110', lowerBinId: -10, upperBinId: 10,
  isOutOfRange, isClosed: false, pnlUsd: '2.5', pnlPctChange: '-1.2', feePerTvl24h: '0.8',
})

// Serves /portfolio/open and /positions/<pool>/pnl from the given tables.
function positionsFetch(calls: URL[], portfolio: unknown, positions: Record<string, unknown>) {
  return async (input: unknown) => {
    const url = new URL(String(input))
    calls.push(url)
    if (url.pathname === '/portfolio/open') return Response.json(portfolio)
    const pool = url.pathname.split('/')[2] ?? ''
    return Response.json(positions[pool])
  }
}

test('positions: each row carries range, in-range flag, P&L, its pool and that pool\'s unclaimed fees', async () => {
  const calls: URL[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = positionsFetch(calls, {
    page: 1, pageSize: 50, hasNext: false, totalCount: 2, totalPositions: 3,
    pools: [portfolioPool(POOL_A, 'SOL', '4'), portfolioPool(POOL_B, 'JUP', '0.25')],
  }, {
    [POOL_A]: { page: 1, pageSize: 100, hasNext: false, totalCount: 2, positions: [upstreamPosition('pos-1', false), upstreamPosition('pos-2', true)] },
    [POOL_B]: { page: 1, pageSize: 100, hasNext: false, totalCount: 1, positions: [upstreamPosition('pos-3', false)] },
  })

  try {
    const body = await fetchMeteoraPositions(POSITIONS_WALLET)
    // One route, every pool read on the server: 1 portfolio call + 1 per pool, open positions only.
    assert.equal(calls.length, 3)
    assert.equal(calls.find((url) => url.pathname.endsWith('/pnl'))?.searchParams.get('status'), 'open')
    const row = (address: string, poolAddress: string, poolName: string, outOfRange: boolean, fees: number) => ({
      address, poolAddress, poolName, minPrice: 90.5, maxPrice: 110, lowerBinId: -10, upperBinId: 10,
      outOfRange, pnlUsd: 2.5, pnlPct: -1.2, feeTvl24hPct: 0.8, poolUnclaimedFeesUsd: fees,
    })
    assert.deepEqual(body, {
      status: 'ok',
      totalPools: 2,
      hasMore: false,
      positions: [
        row('pos-1', POOL_A, 'SOL / USDC', false, 4),
        row('pos-2', POOL_A, 'SOL / USDC', true, 4),
        row('pos-3', POOL_B, 'JUP / USDC', false, 0.25),
      ],
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('positions: hasMore is true past 50 pools and the true totalPools is returned', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = positionsFetch([], {
    page: 1, pageSize: 50, hasNext: true, totalCount: 63, totalPositions: 70,
    pools: [portfolioPool(POOL_A, 'SOL', '0')],
  }, {
    [POOL_A]: { page: 1, pageSize: 100, hasNext: false, totalCount: 1, positions: [upstreamPosition('pos-1', false)] },
  })

  try {
    const body = await fetchMeteoraPositions(POSITIONS_WALLET_MORE)
    assert.equal(body.hasMore, true)
    assert.equal(body.totalPools, 63)
    assert.equal(body.positions.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('positions route: no address answers not_connected, an upstream failure answers unavailable with a reason', async () => {
  const originalFetch = globalThis.fetch
  const routes = new Hono().route('/wallet', createWalletSummaryRoutes({ service: { getSummary: async () => { throw new Error('unused') } } }))
  try {
    globalThis.fetch = async () => { throw new Error('no address must not call upstream') }
    const none = await routes.request('/wallet/meteora/positions')
    assert.equal(none.status, 200)
    assert.deepEqual(await none.json(), { status: 'not_connected', positions: [], totalPools: 0, hasMore: false })

    assert.equal((await routes.request('/wallet/meteora/positions?solana=short')).status, 400)

    globalThis.fetch = async () => new Response('db down', { status: 500 })
    const down = await routes.request(`/wallet/meteora/positions?solana=${WALLET_DOWN}`)
    assert.equal(down.status, 200)
    const body = await down.json() as { status: string; positions: unknown[]; error?: string }
    assert.equal(body.status, 'unavailable')
    assert.deepEqual(body.positions, [])
    assert.ok(body.error && body.error.length > 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
