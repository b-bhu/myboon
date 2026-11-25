import assert from 'node:assert/strict'
import test from 'node:test'

// The venue reads globalThis.fetch at call time (through pacificaGetJson),
// so the tests swap it and restore in a finally — same setup as
// venues/spot.test.ts. Each test uses its own address so nothing leaks
// between tests.
const { pacificaVenue, toPacificaPositionDetails } = await import('./pacifica.js')
const { createWalletSummaryRoutes } = await import('../routes.js')
const { createWalletSummaryService } = await import('../service.js')

const WALLET = '7iNJ7CLNT8UBPANxkkrsURjzaktbomCVa93N1sKcVo9C'
const WALLET_EMPTY = 'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1'
const WALLET_DOWN = 'EYj9xKw6ZszwpyNibHY7JD5o3QgTVrSdcBp1fMJhrR9o'
const WALLET_LIMITED = 'CoaxzEh8p5YyGLcj36Eo3cUThVJxeKCs7qvLAGDYwBcz'

const context = (solana: string | null) => ({ solana, evm: null, signal: new AbortController().signal })

const ACCOUNT = {
  balance: '100',
  account_equity: '1234.5',
  available_to_spend: '500.25',
  available_to_withdraw: '500.25',
  total_margin_used: '734.25',
  positions_count: 2,
}

const POSITIONS = [
  { symbol: 'SOL-PERP', side: 'bid', amount: '10', entry_price: '100' },
  { symbol: 'ETH-PERP', side: 'ask', amount: '2', entry_price: '3000' },
]

const PRICES = [
  { symbol: 'SOL-PERP', mark: '110' },
  { symbol: 'ETH-PERP', mark: '2900' },
]

function okJson(body: unknown): Response {
  return Response.json({ success: true, data: body, error: null, code: null })
}

/** Routes the three upstream paths the venue calls; anything else 404s. */
function stubUpstream(handler: (path: string) => Response) {
  const calls: string[] = []
  const stub = async (input: unknown): Promise<Response> => {
    const url = new URL(String(input))
    const path = url.pathname.replace(/^\/api\/v1/, '') + url.search
    calls.push(path)
    return handler(path)
  }
  return { calls, stub }
}

function upstreamOk() {
  return stubUpstream((path) => {
    if (path.startsWith('/account')) return okJson(ACCOUNT)
    if (path.startsWith('/positions')) return okJson(POSITIONS)
    if (path.startsWith('/info/prices')) return okJson(PRICES)
    return Response.json({ success: false, error: 'not found' }, { status: 404 })
  })
}

test('maps the account and positions into the summary shape', async () => {
  const { stub } = upstreamOk()
  const originalFetch = globalThis.fetch
  globalThis.fetch = stub as typeof fetch

  try {
    const slot = await pacificaVenue.fetch(context(WALLET))
    assert.equal(slot.status, 'ok')
    assert.equal(slot.error, undefined)
    assert.equal(slot.valueUsd, 1234.5)
    assert.equal(slot.summary?.equityUsd, 1234.5)
    assert.equal(slot.summary?.availableToSpendUsd, 500.25)
    assert.equal(slot.summary?.positionCount, 2)
    // long: (110 - 100) * 10 * 1 = 100; short: (2900 - 3000) * 2 * -1 = 200
    assert.deepEqual(slot.summary?.positions, [
      { symbol: 'SOL-PERP', size: 10, unrealizedPnlUsd: 100 },
      { symbol: 'ETH-PERP', size: 2, unrealizedPnlUsd: 200 },
    ])
    assert.equal(slot.summary?.unrealizedPnlUsd, 300)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('long and short P&L signs follow the side', async () => {
  const { stub } = stubUpstream((path) => {
    if (path.startsWith('/account')) return okJson({ ...ACCOUNT, account_equity: '10', available_to_spend: '10' })
    if (path.startsWith('/positions')) {
      return okJson([
        { symbol: 'SOL-PERP', side: 'bid', amount: '1', entry_price: '100' },
        { symbol: 'ETH-PERP', side: 'ask', amount: '1', entry_price: '3000' },
      ])
    }
    if (path.startsWith('/info/prices')) {
      // Both moved against the long and the short would lose only if price fell;
      // here price fell, so the long loses and the short wins.
      return okJson([
        { symbol: 'SOL-PERP', mark: '90' },
        { symbol: 'ETH-PERP', mark: '2700' },
      ])
    }
    return Response.json({ success: false, error: 'not found' }, { status: 404 })
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = stub as typeof fetch

  try {
    const slot = await pacificaVenue.fetch(context(WALLET))
    assert.equal(slot.status, 'ok')
    assert.equal(slot.summary?.positions[0]?.unrealizedPnlUsd, -10)
    assert.equal(slot.summary?.positions[1]?.unrealizedPnlUsd, 300)
    assert.equal(slot.summary?.unrealizedPnlUsd, 290)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an address with no Pacifica account is ok with zero values', async () => {
  const { stub } = stubUpstream((path) => {
    if (path.startsWith('/account')) {
      return Response.json({ success: false, data: null, error: 'Account not found', code: 404 }, { status: 404 })
    }
    return okJson([])
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = stub as typeof fetch

  try {
    const slot = await pacificaVenue.fetch(context(WALLET_EMPTY))
    assert.deepEqual(slot, {
      status: 'ok',
      valueUsd: 0,
      summary: { equityUsd: 0, availableToSpendUsd: 0, unrealizedPnlUsd: 0, positionCount: 0, positions: [] },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a 429 answers unavailable and carries the retry hint in the error', async () => {
  const { stub } = stubUpstream(
    () =>
      new Response(JSON.stringify({ success: false, error: 'rate limited' }), {
        status: 429,
        headers: { 'retry-after': '17', 'content-type': 'application/json' },
      }),
  )
  const originalFetch = globalThis.fetch
  globalThis.fetch = stub as typeof fetch

  try {
    const slot = await pacificaVenue.fetch(context(WALLET_LIMITED))
    assert.equal(slot.status, 'unavailable')
    assert.equal(slot.valueUsd, null)
    assert.equal(slot.summary, null)
    assert.match(slot.error ?? '', /retry after 17s/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a 500 answers unavailable', async () => {
  const { stub } = stubUpstream(
    () => new Response('upstream boom', { status: 500 }),
  )
  const originalFetch = globalThis.fetch
  globalThis.fetch = stub as typeof fetch

  try {
    const slot = await pacificaVenue.fetch(context(WALLET_DOWN))
    assert.equal(slot.status, 'unavailable')
    assert.equal(slot.valueUsd, null)
    assert.equal(slot.summary, null)
    assert.ok(slot.error)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// Position detail (#868). The same long and short as the summary tests, plus
// a symbol with no mark price. Marks 110 / 2850 keep the percentages exact.
test('toPacificaPositionDetails maps side, size, entry, mark, value and P&L like the summary', async () => {
  const positions = [
    ...POSITIONS,
    // No mark price for this symbol: mark and value null, P&L 0 as in the summary.
    { symbol: 'BTC-PERP', side: 'bid', amount: '1', entry_price: '20000' },
  ] as Parameters<typeof toPacificaPositionDetails>[0]
  const prices = [
    { symbol: 'SOL-PERP', mark: '110' },
    { symbol: 'ETH-PERP', mark: '2850' },
  ]
  const nulls = {
    leverage: null,
    liquidationPriceUsd: null,
    takeProfitPriceUsd: null,
    stopLossPriceUsd: null,
    traderPdaIndex: null,
    traderSubaccountIndex: null,
  }

  const rows = toPacificaPositionDetails(positions, prices)
  assert.deepEqual(rows, [
    // Sorted by |valueUsd| descending, null counting as 0.
    { symbol: 'ETH-PERP', side: 'short', size: 2, valueUsd: 5700, entryPriceUsd: 3000, markPriceUsd: 2850, unrealizedPnlUsd: 300, pnlPct: 5, ...nulls },
    { symbol: 'SOL-PERP', side: 'long', size: 10, valueUsd: 1100, entryPriceUsd: 100, markPriceUsd: 110, unrealizedPnlUsd: 100, pnlPct: 10, ...nulls },
    { symbol: 'BTC-PERP', side: 'long', size: 1, valueUsd: null, entryPriceUsd: 20000, markPriceUsd: null, unrealizedPnlUsd: 0, pnlPct: 0, ...nulls },
  ])

  // Each P&L equals the summary's for the same position.
  const { stub } = stubUpstream((path) => {
    if (path.startsWith('/account')) return okJson(ACCOUNT)
    if (path.startsWith('/positions')) return okJson(positions)
    return okJson(prices)
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = stub as typeof fetch
  try {
    const slot = await pacificaVenue.fetch(context(WALLET))
    for (const position of slot.summary?.positions ?? []) {
      assert.equal(rows.find((row) => row.symbol === position.symbol)?.unrealizedPnlUsd, position.unrealizedPnlUsd)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GET /wallet/pacifica/positions answers every state', async () => {
  const routes = createWalletSummaryRoutes({ service: createWalletSummaryService({ venues: [] }) })
  const get = async (query: string) => {
    const response = await routes.request(`/pacifica/positions${query}`)
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const originalFetch = globalThis.fetch
  const originalError = console.error
  console.error = () => {}

  try {
    // No address: not connected, HTTP 200, no upstream call. Malformed: 400.
    const idle = upstreamOk()
    globalThis.fetch = idle.stub as typeof fetch
    assert.deepEqual(await get(''), { status: 200, body: { status: 'not_connected', positions: [] } })
    assert.deepEqual(await get('?solana=not-an-address'), {
      status: 400,
      body: { error: 'Invalid solana address', code: 'INVALID_ADDRESS' },
    })
    assert.equal(idle.calls.length, 0)

    // A long and a short position: ok, rows from toPacificaPositionDetails.
    const ok = upstreamOk()
    globalThis.fetch = ok.stub as typeof fetch
    const answer = await get(`?solana=${WALLET}`)
    assert.equal(answer.status, 200)
    assert.equal(answer.body.status, 'ok')
    assert.deepEqual(answer.body.positions, toPacificaPositionDetails(POSITIONS as Parameters<typeof toPacificaPositionDetails>[0], PRICES))

    // No Pacifica account (404): ok and empty.
    globalThis.fetch = stubUpstream(() =>
      Response.json({ success: false, data: null, error: 'Account not found', code: 404 }, { status: 404 }),
    ).stub as typeof fetch
    assert.deepEqual(await get(`?solana=${WALLET_EMPTY}`), { status: 200, body: { status: 'ok', positions: [] } })

    // The upstream answers 500: unavailable, HTTP 200.
    globalThis.fetch = stubUpstream(() => new Response('upstream boom', { status: 500 })).stub as typeof fetch
    assert.deepEqual(await get(`?solana=${WALLET_DOWN}`), {
      status: 200,
      body: { status: 'unavailable', positions: [], error: 'pacifica_positions_failed' },
    })
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
  }
})
