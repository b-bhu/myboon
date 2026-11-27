/**
 * Polymarket venue tests (#745): one file, mocked data-api and mocked RPC
 * (the venue factory takes `fetch` in its options, so nothing here replaces
 * globalThis.fetch and no upstream call happens). Cases the issue names:
 * rows under $0.01 do not count as ready to collect · many pages stop at
 * the ceiling · cash from the RPC result (6 decimals) · no `evm` is
 * `not_connected` · RPC failure gives a null cash and value · data-api
 * failure is `unavailable` · the `evm` address is used as given (no
 * re-derivation) and the RPC is called with that exact address.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppSummary, PolymarketSummary } from '@myboon/shared/wallet-summary'
import { PUSD_TOKEN_ADDRESS } from '../../polymarket/read/cash-balance.js'
import { DATA_API_V2_HOST } from '../../polymarket/read/data-api-v2.js'
import { createPolymarketVenue } from './polymarket.js'
import type { WalletFetchContext } from '../service.js'

// The deposit wallet as the phone sends it — checksummed, mixed case. The
// address is passed as given everywhere (no re-derivation, no rewrite).
const EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

const DATA_HOST = new URL(DATA_API_V2_HOST).host
const POLYGON_RPC = 'https://polygon-test.example'
const RPC_HOST = new URL(POLYGON_RPC).host
// balanceOf(address) data prefix on an eth_call to the pUSD token.
const CASH_CALLDATA_PREFIX = `0x70a08231${EVM.slice(2).padStart(64, '0')}`

// File-wide counter: unique token ids keep the merge's assetId dedupe
// honest (identical rows would collapse and make the sums lie).
let tokenSeq = 0

const row = (overrides: Record<string, unknown> = {}) => {
  tokenSeq += 1
  return {
    proxy_wallet: EVM,
    token_id: String(tokenSeq),
    condition_id: `0xc${tokenSeq}`,
    current_size: 10,
    avg_price: 0.4,
    current_value: 4,
    unrealized_pnl: 0.5,
    percent_pnl: 12.5,
    current_price: 0.45,
    title: 'T',
    slug: 's',
    event_slug: 'e',
    outcome: 'Yes',
    outcome_index: 0,
    icon: null,
    end_date: '2026-12-01',
    negative_risk: false,
    ...overrides,
  }
}

interface Call {
  url: URL
  init: RequestInit | undefined
}

type Responder = (call: Call) => Response | Promise<Response>

/** A venue whose every fetch is routed through the test responder. */
function venueFor(respond: Responder) {
  const calls: Call[] = []
  const venue = createPolymarketVenue({
    polygonRpcUrl: POLYGON_RPC,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: new URL(String(input)), init }
      calls.push(call)
      return respond(call)
    },
  })
  return { venue, calls }
}

// Envelope shape checked live (Nov 27, 2026): data + pagination cursor.
const v2Page = (rows: unknown[], hasMore: boolean, cursor: string | null = null): Response =>
  Response.json({ data: rows, pagination: { limit: 500, offset: 0, has_more: hasMore, next_cursor: cursor } })

// A real-looking eth_call answer: the balance is the hex of the 6-decimal
// micro-USD integer, zero-padded to 32 bytes.
const cashCall = (microUsd: number): Response =>
  Response.json({ jsonrpc: '2.0', id: 1, result: `0x${BigInt(microUsd).toString(16).padStart(64, '0')}` })

const ok = (slot: AppSummary<PolymarketSummary>) => {
  assert.equal(slot.status, 'ok')
  assert.ok(slot.summary, 'expected an ok summary')
  return slot.summary
}

const context = (evm: string | null): WalletFetchContext => ({
  solana: null,
  evm,
  signal: new AbortController().signal,
})

// Router helpers: the two upstreams the venue is allowed to call.
const isData = (call: Call) => call.url.host === DATA_HOST
const isCash = (call: Call) => call.url.host === RPC_HOST

test('rows under $0.01 do not count as ready to collect', async () => {
  // Exact dyadic floats keep the sum asserts exact: 0.0078125 is the
  // under-threshold row; 0.03125 and 4.5 collect (the $0.01 bar is
  // inclusive, so a row at exactly the bar still counts).
  const redeemable = [
    row({ current_value: 0.0078125, unrealized_pnl: 0 }),
    row({ current_value: 0.03125, unrealized_pnl: 0.0625 }),
    row({ current_value: 4.5, unrealized_pnl: 0.0625 }),
  ]
  const open = [
    row({ current_value: 4, unrealized_pnl: 0.5 }),
    row({ current_value: 2.25, unrealized_pnl: -0.25 }),
  ]
  const { venue, calls } = venueFor((call) => {
    if (isCash(call)) return cashCall(12_500_000)
    if (isData(call)) {
      const status = call.url.searchParams.get('status')
      if (status === 'open') return v2Page(open, false)
      if (status === 'redeemable') return v2Page(redeemable, false)
    }
    throw new Error(`unexpected call ${call.url.host}${call.url.pathname}`)
  })

  const slot = await venue.fetch(context(EVM))
  const summary = ok(slot)
  assert.deepEqual(summary, {
    cashUsd: 12.5,
    openPositionsValueUsd: 10.7890625, // merged walk: open 6.25 + redeemable rows too
    readyToCollectUsd: 4.53125, // the 0.0078125 row is not ready to collect
    totalPnlUsd: 0.375,
    openPositionCount: 5,
  })
  // valueUsd is cash + open positions + ready to collect (shared definition).
  assert.equal(slot.valueUsd, 27.8203125)
})

test('many pages stop at the ceiling', async () => {
  // 25 open pages exist (2 rows of 1.00 each, always has_more) but the
  // shared walkAllPages 20-page ceiling must stop after 20 consumed pages —
  // page 21 is never requested. Redeemable ends after one empty page.
  let openPagesServed = 0
  const { venue, calls } = venueFor((call) => {
    if (isCash(call)) return cashCall(12_500_000)
    if (isData(call)) {
      if (call.url.searchParams.get('status') === 'redeemable') return v2Page([], false)
      if (openPagesServed >= 25) throw new Error('walked past the fixture pages')
      openPagesServed += 1
      return v2Page(
        [row({ current_value: 1, unrealized_pnl: 0 }), row({ current_value: 1, unrealized_pnl: 0 })],
        true,
        'cursor-next',
      )
    }
    throw new Error(`unexpected call ${call.url.host}${call.url.pathname}`)
  })

  const slot = await venue.fetch(context(EVM))
  const summary = ok(slot)
  const openCalls = calls.filter((call) => isData(call) && call.url.searchParams.get('status') === 'open')
  assert.equal(openCalls.length, 20) // 20 pages consumed, page 21 never fetched
  assert.equal(openCalls[0]?.url.searchParams.get('cursor'), null)
  assert.equal(openCalls[1]?.url.searchParams.get('cursor'), 'cursor-next')
  assert.equal(summary.openPositionCount, 40) // exactly the 20 walked pages
  assert.equal(summary.openPositionsValueUsd, 40)
  assert.equal(summary.readyToCollectUsd, 0)
  // The cash read still runs once next to the bounded position walks.
  assert.equal(calls.filter(isCash).length, 1)
})

test('cash from the RPC result (6 decimals)', async () => {
  const { venue, calls } = venueFor((call) => {
    if (isCash(call)) return cashCall(12_500_000) // 12500000 micro = 12.5 USD
    if (isData(call)) {
      const status = call.url.searchParams.get('status')
      if (status === 'open') return v2Page([row({ current_value: 4, unrealized_pnl: 0.5 })], false)
      if (status === 'redeemable') return v2Page([row({ current_value: 2.25, unrealized_pnl: 0.25 })], false)
    }
    throw new Error(`unexpected call ${call.url.host}${call.url.pathname}`)
  })

  const slot = await venue.fetch(context(EVM))
  const summary = ok(slot)
  assert.equal(summary.cashUsd, 12.5)
  assert.equal(summary.openPositionsValueUsd, 6.25)
  assert.equal(summary.readyToCollectUsd, 2.25)
  assert.equal(summary.totalPnlUsd, 0.75)
  assert.equal(summary.openPositionCount, 2)
  assert.equal(slot.valueUsd, 21)

  // One eth_call to the pUSD token: balanceOf selector, the exact address,
  // latest block.
  const cashCalls = calls.filter(isCash)
  assert.equal(cashCalls.length, 1)
  assert.equal(cashCalls[0]?.init?.method, 'POST')
  const body = JSON.parse(String(cashCalls[0]?.init?.body)) as {
    method: string
    params: [{ to: string; data: string }, string]
  }
  assert.equal(body.method, 'eth_call')
  assert.equal(body.params[0].to, PUSD_TOKEN_ADDRESS)
  assert.equal(body.params[0].data, CASH_CALLDATA_PREFIX)
  assert.equal(body.params[1], 'latest')
})

test('no evm is not_connected', async () => {
  const { venue, calls } = venueFor(() => {
    throw new Error('upstream must not be called without an evm address')
  })
  const slot = await venue.fetch(context(null))
  assert.equal(slot.status, 'not_connected')
  assert.equal(slot.valueUsd, null)
  assert.equal(slot.summary, null)
  assert.equal(slot.error, undefined)
  assert.equal(calls.length, 0)
})

test('RPC failure gives a null cash and value', async () => {
  const { venue } = venueFor((call) => {
    if (isCash(call)) return new Response('rpc boom', { status: 503 })
    if (isData(call)) {
      const status = call.url.searchParams.get('status')
      if (status === 'open') return v2Page([row({ current_value: 4, unrealized_pnl: 0.5 })], false)
      if (status === 'redeemable') return v2Page([row({ current_value: 2.25, unrealized_pnl: 0.25 })], false)
    }
    throw new Error(`unexpected call ${call.url.host}${call.url.pathname}`)
  })

  const slot = await venue.fetch(context(EVM))
  // Cash unknown, positions fine: ok with null cash and a null value, never
  // an error — positions value is still real and served.
  const summary = ok(slot)
  assert.equal(summary.cashUsd, null)
  assert.equal(slot.valueUsd, null)
  assert.equal(summary.openPositionsValueUsd, 6.25)
  assert.equal(summary.readyToCollectUsd, 2.25)
  assert.equal(summary.openPositionCount, 2)
})

test('data-api failure is unavailable', async () => {
  const consoleErrors: string[] = []
  const originalConsoleError = console.error
  console.error = (...parts: unknown[]) => { consoleErrors.push(parts.map(String).join(' ')) }
  try {
    const { venue } = venueFor((call) => {
      if (isCash(call)) return cashCall(12_500_000)
      if (isData(call)) return new Response('{"detail":"rate limited"}', { status: 429 })
      throw new Error(`unexpected call ${call.url.host}${call.url.pathname}`)
    })

    const slot = await venue.fetch(context(EVM))
    // This app alone: unavailable with a short reason, the positions and
    // cash numbers dropped together.
    assert.equal(slot.status, 'unavailable')
    assert.equal(slot.valueUsd, null)
    assert.equal(slot.summary, null)
    assert.equal(slot.error, 'data-api HTTP 429')
    // No [api] log here: the venue answers unavailable itself (the service
    // logs when a venue throws instead of answering).
    assert.equal(consoleErrors.length, 0)
  } finally {
    console.error = originalConsoleError
  }
})

test('evm is passed as given: the RPC is called with that exact address', async () => {
  const { venue, calls } = venueFor((call) => {
    if (isCash(call)) return cashCall(12_500_000)
    if (isData(call)) {
      const status = call.url.searchParams.get('status')
      if (status === 'open') return v2Page([row()], false)
      if (status === 'redeemable') return v2Page([], false)
    }
    throw new Error(`unexpected call ${call.url.host}${call.url.pathname}`)
  })

  const slot = await venue.fetch(context(EVM))
  ok(slot)
  // The data-api reads the same address, byte for byte (no derived wallet,
  // no lowercase rewrite — the caller owns the resolution).
  for (const call of calls.filter(isData)) {
    assert.equal(call.url.searchParams.get('user'), EVM)
  }
  // And the cash read's calldata carries the exact address after the
  // balanceOf selector, left-padded to 32 bytes.
  const cashBody = JSON.parse(String(calls.filter(isCash)[0]?.init?.body)) as {
    params: [{ to: string; data: string }, string]
  }
  assert.equal(cashBody.params[0].data, CASH_CALLDATA_PREFIX)
  // Only the two real upstreams: no CREATE2/beacon derivation call.
  assert.deepEqual([...new Set(calls.map((call) => call.url.host))].sort(), [DATA_HOST, RPC_HOST])
})
