import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import type { WalletSummary } from '@myboon/shared/wallet-summary'
import type { WalletVenue } from './service.js'

// These modules read no env vars and make no upstream calls (every venue is
// a stub this issue), so no env setup or globalThis.fetch mock is needed —
// the throwing-venue case is injected through the service's venues option.
const { createWalletSummaryRoutes } = await import('./routes.js')
const { createWalletSummaryService } = await import('./service.js')
const { walletVenues } = await import('./venues/index.js')

// Valid base58 (32-44 chars, as /spot accepts) and a valid EVM address.
const SOL = '7iNJ7CLNT8UBPANxkkrsURjzaktbomCVa93N1sKcVo9C'
const EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

function app(service = createWalletSummaryService({ now: () => new Date('2026-11-21T12:34:56.789Z') })) {
  const routes = new Hono()
  routes.route('/wallet', createWalletSummaryRoutes({ service }))
  return routes
}

const unavailable = {
  status: 'unavailable',
  valueUsd: null,
  summary: null,
  error: 'not_available_yet',
} as const

test('GET /wallet/summary without any address returns 400', async () => {
  const response = await app().request('/wallet/summary')
  assert.equal(response.status, 400)
  const body = await response.json() as { error: string; code: string }
  assert.ok(body.error.length > 0)
  assert.equal(body.code, 'MISSING_ADDRESS')
})

test('GET /wallet/summary with a bad address returns 400', async () => {
  // Solana pattern is the base58 one from spot.ts: length 32-44, no 0/O/I/l.
  for (const query of [
    `solana=${'short'}`,
    `solana=${'l0Oa1b2c3d4e5f6g7h8i9j0k1l2m3456'}`, // 32-44 chars but not all in the alphabet
    `evm=${'0x1234'}`,
    `evm=${'0xzzdA6BF26964aF9D7eEd9e03E53415D37aA96045'}`, // 40 chars but not hex
  ]) {
    const response = await app().request(`/wallet/summary?${query}`)
    assert.equal(response.status, 400, query)
    const body = await response.json() as { error: string; code: string }
    assert.ok(body.error.length > 0, query)
    assert.equal(body.code, 'INVALID_ADDRESS', query)
  }
})

test('GET /wallet/summary with only solana returns stubs and Polymarket not_connected', async () => {
  const response = await app().request(`/wallet/summary?solana=${SOL}`)
  assert.equal(response.status, 200)
  const body = await response.json() as WalletSummary
  assert.equal(body.solana, SOL)
  assert.equal(body.evm, null)
  // ISO-8601 (shape is final as of #722).
  assert.equal(body.fetchedAt, new Date('2026-11-21T12:34:56.789Z').toISOString())
  assert.deepEqual(body.apps.polymarket, { status: 'not_connected', valueUsd: null, summary: null })
  for (const id of ['phoenix', 'pacifica', 'meteora', 'spot'] as const) {
    assert.deepEqual(body.apps[id], unavailable)
  }
})

test('GET /wallet/summary still answers when one venue throws', async () => {
  // Replace one entry with a venue that throws; the others must still return.
  const venues: WalletVenue[] = filterVenues('phoenix')
  venues.push({ id: 'phoenix', fetch: async () => { throw new Error('phoenix upstream 503') } })

  const consoleErrors: string[] = []
  const originalConsoleError = console.error
  console.error = (...parts: unknown[]) => { consoleErrors.push(parts.map(String).join(' ')) }
  try {
    const service = createWalletSummaryService({ venues, now: () => new Date('2026-11-21T12:34:56.789Z') })
    const response = await app(service).request(`/wallet/summary?solana=${SOL}&evm=${EVM}`)
    assert.equal(response.status, 200)
    const body = await response.json() as WalletSummary
    assert.equal(body.solana, SOL)
    assert.equal(body.evm, EVM)
    assert.deepEqual(body.apps.phoenix, unavailable)
    // The failing app is one slot among five — never the whole response.
    // Polymarket has an evm address here, so it answers unavailable too.
    assert.deepEqual(body.apps.polymarket, unavailable)
    assert.deepEqual(body.apps.spot, unavailable)
    // Rule: log detail carries the [api] prefix, wire stays short.
    assert.equal(consoleErrors.length, 1)
    assert.match(consoleErrors[0], /\[api\] wallet-summary phoenix failed:.*phoenix upstream 503/)
  } finally {
    console.error = originalConsoleError
  }
})

function filterVenues(id: WalletVenue['id']): WalletVenue[] {
  return walletVenues().filter((venue) => venue.id !== id)
}
