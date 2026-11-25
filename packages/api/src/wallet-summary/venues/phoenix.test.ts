import assert from 'node:assert/strict'
import test from 'node:test'
import { createPhoenixConfig, createPhoenixUpstream } from '../../phoenix/index.js'
import { createWalletSummaryService } from '../service.js'
import { createPhoenixVenue, toPhoenixPositionDetails } from './phoenix.js'

// getPhoenixTraderState (the shared trader-state reader, #727) takes its
// upstream by option (#831); pin the base so the tests never depend on a
// developer's environment. The tests stub globalThis.fetch, so no request
// leaves the process. The legacy trader-state call and the optional v1 call
// go to distinct paths; the v1 answer below is a 404 every time, which the
// reader swallows (triggerSource stays 'legacy').
const phoenixVenue = createPhoenixVenue(createPhoenixUpstream(createPhoenixConfig({ apiBase: 'https://phoenix.test' })))

const WALLET = '7iNJ7CLNT8UBPANxkkrsURjzaktbomCVa93N1sKcVo9C'
const WALLET_EMPTY = 'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1'
const WALLET_DOWN = 'EYj9xKw6ZszwpyNibHY7JD5o3QgTVrSdcBp1fMJhrR9o'

const context = (solana: string | null) => ({ solana, evm: null, signal: new AbortController().signal })

function stubFetch(handler: (url: URL) => Response): { calls: URL[]; restore: () => void } {
  const calls: URL[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input))
    calls.push(url)
    return handler(url)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = originalFetch } }
}

const legacyPath = (address: string) => `/trader/${encodeURIComponent(address)}/state`

// Two traders on the same wallet: portfolioValue, collateralBalance and
// unrealizedPnl are summed across both, matching what the phone shows.
const TRADER_A = {
  traderPdaIndex: 0,
  traderSubaccountIndex: 0,
  portfolioValue: 1500.25,
  collateralBalance: 1000,
  effectiveCollateral: 900,
  unrealizedPnl: 12.5,
  positions: [
    { symbol: 'SOL-PERP', positionSize: '2.5', unrealizedPnl: '12.5', positionValue: '500' },
    // Zero-size rows are not open positions and are skipped.
    { symbol: 'JUP-PERP', positionSize: '0', unrealizedPnl: '0', positionValue: '0' },
  ],
}
const TRADER_B = {
  traderPdaIndex: 1,
  traderSubaccountIndex: 0,
  portfolioValue: '250.75',
  collateralBalance: '250',
  effectiveCollateral: '225',
  unrealizedPnl: '-2.25',
  positions: [
    { symbol: 'BTC-PERP', positionSize: '-0.5', unrealizedPnl: '-2.25', positionValue: '30000' },
  ],
}

test('several traders are summed into one slot, with the position list', async () => {
  const { calls, restore } = stubFetch((url) => {
    if (url.pathname === legacyPath(WALLET)) {
      return Response.json({ slot: 100, slotIndex: 1, traders: [TRADER_A, TRADER_B] })
    }
    return new Response('not found', { status: 404 })
  })

  try {
    const slot = await phoenixVenue.fetch(context(WALLET))

    assert.deepEqual(
      calls.map((url) => url.pathname).sort(),
      [legacyPath(WALLET), `/v1/trader/state/${WALLET}`].sort(),
    )

    assert.equal(slot.status, 'ok')
    assert.equal(slot.error, undefined)
    assert.equal(slot.valueUsd, 1751)
    assert.deepEqual(slot.summary, {
      equityUsd: 1751,
      collateralUsd: 1250,
      unrealizedPnlUsd: 10.25,
      positionCount: 2,
      positions: [
        // Sorted by absolute notional, like the phone's position list.
        { symbol: 'BTC-PERP', size: 0.5, unrealizedPnlUsd: -2.25 },
        { symbol: 'SOL-PERP', size: 2.5, unrealizedPnlUsd: 12.5 },
      ],
    })
  } finally {
    restore()
  }
})

test('a wallet with no trader records is a legitimate $0 ok summary', async () => {
  const { restore } = stubFetch((url) => {
    if (url.pathname === legacyPath(WALLET_EMPTY)) {
      return Response.json({ slot: 101, slotIndex: 2, traders: [] })
    }
    return new Response('not found', { status: 404 })
  })

  try {
    const slot = await phoenixVenue.fetch(context(WALLET_EMPTY))
    assert.deepEqual(slot, {
      status: 'ok',
      valueUsd: 0,
      summary: { equityUsd: 0, collateralUsd: 0, unrealizedPnlUsd: 0, positionCount: 0, positions: [] },
    })
  } finally {
    restore()
  }
})

test('an upstream 429 makes this app unavailable, nothing else', async () => {
  const { restore } = stubFetch(() => new Response('{"error":"rate limited"}', { status: 429 }))

  try {
    const service = createWalletSummaryService({ venues: [phoenixVenue] })
    const summary = await service.getSummary({ solana: WALLET_DOWN, evm: null })
    assert.equal(summary.apps.phoenix.status, 'unavailable')
    assert.equal(summary.apps.phoenix.valueUsd, null)
    assert.equal(summary.apps.phoenix.summary, null)
    // The other apps keep their own (stub) slots.
    assert.equal(summary.apps.spot.status, 'unavailable')
  } finally {
    restore()
  }
})

// One row per open position across traders (#916): the raw keys the phone's
// normalizePositions reads, |valueUsd| descending, zero-size rows skipped,
// a field the upstream does not give null. Numbers are chosen so every
// pnlPct is float-exact: -1875/15000 = -0.125, 25/100 = 0.25.
test('toPhoenixPositionDetails maps every open position with full detail', () => {
  const traders = [
    {
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
      positions: [
        {
          symbol: 'SOL-PERP',
          positionSize: '2',
          entryPrice: '50',
          markPrice: '62.5',
          liquidationPrice: '40',
          positionValue: '125',
          unrealizedPnl: '25',
          takeProfitPrice: '80',
          stopLossPrice: '45',
          leverage: '2',
        },
        // Zero-size rows are not open positions and are skipped.
        { symbol: 'JUP-PERP', positionSize: '0', positionValue: '0' },
      ],
    },
    // No traderPdaIndex / traderSubaccountIndex: falls back to the list
    // index and 0.
    {
      positions: [
        {
          symbol: 'BTC-PERP',
          positionSize: '-0.5',
          entryPrice: '30000',
          markPrice: null,
          oraclePrice: '33750',
          positionValue: '16875',
          unrealizedPnl: '-1875',
          // liquidationPrice, takeProfitPrice, stopLossPrice and leverage
          // are missing: null, never 0.
        },
        {
          symbol: 'DOGE-PERP',
          positionSize: '100',
          entryPrice: '0',
          positionValue: '6',
          unrealizedPnl: '1.5',
          // markPrice and oraclePrice missing: null; entry 0 makes
          // pnlPct null.
        },
      ],
    },
  ]

  assert.deepEqual(toPhoenixPositionDetails(traders), [
    // Sorted by absolute valueUsd, largest first.
    {
      symbol: 'BTC-PERP',
      side: 'short',
      size: 0.5,
      leverage: null,
      valueUsd: 16875,
      entryPriceUsd: 30000,
      markPriceUsd: 33750,
      liquidationPriceUsd: null,
      unrealizedPnlUsd: -1875,
      pnlPct: -12.5,
      takeProfitPriceUsd: null,
      stopLossPriceUsd: null,
      traderPdaIndex: 1,
      traderSubaccountIndex: 0,
    },
    {
      symbol: 'SOL-PERP',
      side: 'long',
      size: 2,
      leverage: 2,
      valueUsd: 125,
      entryPriceUsd: 50,
      markPriceUsd: 62.5,
      liquidationPriceUsd: 40,
      unrealizedPnlUsd: 25,
      pnlPct: 25,
      takeProfitPriceUsd: 80,
      stopLossPriceUsd: 45,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    },
    {
      symbol: 'DOGE-PERP',
      side: 'long',
      size: 100,
      leverage: null,
      valueUsd: 6,
      entryPriceUsd: 0,
      markPriceUsd: null,
      liquidationPriceUsd: null,
      unrealizedPnlUsd: 1.5,
      pnlPct: null,
      takeProfitPriceUsd: null,
      stopLossPriceUsd: null,
      traderPdaIndex: 1,
      traderSubaccountIndex: 0,
    },
  ])
})
