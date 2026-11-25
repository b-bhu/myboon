import assert from 'node:assert/strict'
import test from 'node:test'
import { createPhoenixConfig, createPhoenixUpstream } from '../../phoenix/index.js'
import { createWalletSummaryRoutes } from '../routes.js'
import { createWalletSummaryService } from '../service.js'
import { createPhoenixOrdersReader, toPhoenixOrders } from './phoenix-orders.js'

// The conditional rows below sit directly in `limitOrders`, the shape
// mergePhoenixTraderState produces, so the stubbed legacy answer carries
// them as the merged state would. The v1 call is a 404 the reader swallows.
const WALLET = '7iNJ7CLNT8UBPANxkkrsURjzaktbomCVa93N1sKcVo9C'
const WALLET_EMPTY = 'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1'
const WALLET_DOWN = 'EYj9xKw6ZszwpyNibHY7JD5o3QgTVrSdcBp1fMJhrR9o'

const legacyPath = (address: string) => `/trader/${encodeURIComponent(address)}/state`

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

const conditional = (
  sequence: string,
  kind: 'take_profit' | 'stop_loss',
  price: string,
  cancel: { conditionalOrderIndex?: number; executionDirection?: string } = { conditionalOrderIndex: 0, executionDirection: 'less_than' },
) => ({
  orderSequenceNumber: sequence,
  price,
  triggerPrice: price,
  isConditionalOrder: true,
  conditionalOrderKind: kind,
  ...cancel,
})

// Numbers are chosen so every P&L is float-exact.
const TRADERS = [
  {
    traderPdaIndex: 0,
    traderSubaccountIndex: 0,
    positions: [
      { symbol: 'SOL-PERP', positionSize: '2', entryPrice: '50' },
      { symbol: 'JUP-PERP', positionSize: '0', entryPrice: '1' },
    ],
    limitOrders: {
      // Stop loss listed before take profit: the answer sorts take profit first.
      'SOL-PERP': [
        conditional('sl-1', 'stop_loss', '45'),
        conditional('tp-1', 'take_profit', '80', { conditionalOrderIndex: 1, executionDirection: 'greater_than' }),
        // A plain limit order is not listed.
        { orderSequenceNumber: 'limit-1', price: '49', isConditionalOrder: false },
      ],
      // No open position on this symbol (size 0): position fields are null.
      'JUP-PERP': [conditional('tp-2', 'take_profit', '2')],
    },
  },
  // No traderPdaIndex / traderSubaccountIndex: list index and 0.
  {
    positions: [{ symbol: 'BTC-PERP', positionSize: '-0.5', entryPrice: '30000' }],
    limitOrders: {
      // A short's take profit below entry is a gain. No cancel keys: still
      // listed, canCancel false. Only `price` given: it is the trigger.
      'BTC-PERP': [{
        orderSequenceNumber: 'tp-3',
        price: '27000',
        isConditionalOrder: true,
        conditionalOrderKind: 'take_profit',
      }],
    },
  },
]

test('toPhoenixOrders lists conditional TP and SL orders joined to their position', () => {
  assert.deepEqual(toPhoenixOrders(TRADERS), [
    {
      id: 'tp-3',
      symbol: 'BTC-PERP',
      kind: 'take_profit',
      triggerPriceUsd: 27000,
      positionSide: 'short',
      size: 0.5,
      entryPriceUsd: 30000,
      pnlAtTriggerUsd: 1500,
      conditionalOrderIndex: null,
      executionDirection: null,
      canCancel: false,
      traderPdaIndex: 1,
      traderSubaccountIndex: 0,
    },
    {
      id: 'tp-2',
      symbol: 'JUP-PERP',
      kind: 'take_profit',
      triggerPriceUsd: 2,
      positionSide: null,
      size: null,
      entryPriceUsd: null,
      pnlAtTriggerUsd: null,
      conditionalOrderIndex: 0,
      executionDirection: 'less_than',
      canCancel: true,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    },
    {
      id: 'tp-1',
      symbol: 'SOL-PERP',
      kind: 'take_profit',
      triggerPriceUsd: 80,
      positionSide: 'long',
      size: 2,
      entryPriceUsd: 50,
      pnlAtTriggerUsd: 60,
      conditionalOrderIndex: 1,
      executionDirection: 'greater_than',
      canCancel: true,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    },
    {
      id: 'sl-1',
      symbol: 'SOL-PERP',
      kind: 'stop_loss',
      triggerPriceUsd: 45,
      positionSide: 'long',
      size: 2,
      entryPriceUsd: 50,
      pnlAtTriggerUsd: -10,
      conditionalOrderIndex: 0,
      executionDirection: 'less_than',
      canCancel: true,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    },
  ])
})

test('GET /wallet/phoenix/orders answers every state', async () => {
  const upstream = createPhoenixUpstream(createPhoenixConfig({ apiBase: 'https://phoenix.test' }))
  const routes = createWalletSummaryRoutes({
    service: createWalletSummaryService({ venues: [] }),
    phoenixOrders: createPhoenixOrdersReader(upstream),
  })
  const get = async (query: string) => {
    const response = await routes.request(`/phoenix/orders${query}`)
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }

  // No address: not connected, HTTP 200, no upstream call. Malformed: 400.
  const idle = stubFetch(() => new Response('not found', { status: 404 }))
  try {
    assert.deepEqual(await get(''), { status: 200, body: { status: 'not_connected', orders: [] } })
    assert.deepEqual(await get('?solana=not-an-address'), {
      status: 400,
      body: { error: 'Invalid solana address', code: 'INVALID_ADDRESS' },
    })
    assert.equal(idle.calls.length, 0)
  } finally {
    idle.restore()
  }

  // Orders on the wallet's trader state: ok, rows from toPhoenixOrders.
  const ok = stubFetch((url) => url.pathname === legacyPath(WALLET)
    ? Response.json({ slot: 100, slotIndex: 1, traders: TRADERS })
    : new Response('not found', { status: 404 }))
  try {
    const { status, body } = await get(`?solana=${WALLET}`)
    assert.equal(status, 200)
    assert.equal(body.status, 'ok')
    assert.deepEqual(body.orders, toPhoenixOrders(TRADERS))
  } finally {
    ok.restore()
  }

  // A trader with no conditional orders: ok and empty.
  const empty = stubFetch((url) => url.pathname === legacyPath(WALLET_EMPTY)
    ? Response.json({ slot: 101, slotIndex: 2, traders: [{ positions: [], limitOrders: {} }] })
    : new Response('not found', { status: 404 }))
  try {
    assert.deepEqual(await get(`?solana=${WALLET_EMPTY}`), { status: 200, body: { status: 'ok', orders: [] } })
  } finally {
    empty.restore()
  }

  // The trader state call answers 429: unavailable, HTTP 200, logged.
  const down = stubFetch(() => new Response('{"error":"rate limited"}', { status: 429 }))
  const originalError = console.error
  console.error = () => {}
  try {
    assert.deepEqual(await get(`?solana=${WALLET_DOWN}`), {
      status: 200,
      body: { status: 'unavailable', orders: [], error: 'phoenix_orders_failed' },
    })
  } finally {
    console.error = originalError
    down.restore()
  }
})
