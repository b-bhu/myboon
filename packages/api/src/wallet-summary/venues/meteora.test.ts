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
