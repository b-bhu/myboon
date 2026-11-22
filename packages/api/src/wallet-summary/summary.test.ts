import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import type { WalletSummary } from '@myboon/shared/wallet-summary'
import { unavailableApp, type WalletVenue } from './service.js'

// These route tests make no upstream calls either: spot is a real venue as
// of #742, so every test that reaches the service injects the venue list
// without it (its own venue is covered in venues/spot.test.ts); the
// throwing-venue case is injected through the service's venues option.
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
  // #742 / #726: spot and meteora are real now and would call their
  // upstreams here; the stub check is about the wiring, so the registry is
  // injected without them (their own venues are covered in venues/*.test.ts).
  const service = createWalletSummaryService({
    now: () => new Date('2026-11-21T12:34:56.789Z'),
    venues: walletVenues().filter((venue) => venue.id !== 'spot' && venue.id !== 'meteora'),
  })
  const response = await app(service).request(`/wallet/summary?solana=${SOL}`)
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
  // Replace phoenix with a venue that throws; the others must still return.
  // The real spot (#742) and meteora (#726) venues are left out too, so
  // their upstream calls cannot log a failure into this test's
  // console-error count.
  const venues: WalletVenue[] = walletVenues().filter(
    (venue) => venue.id !== 'phoenix' && venue.id !== 'spot' && venue.id !== 'meteora',
  )
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

test('a second call inside 15 seconds does not call upstream, and same-key calls share one fetch', async () => {
  const clock = { ms: 0 }
  const calls: string[] = []
  const venues: WalletVenue[] = [{
    id: 'spot',
    fetch: async (ctx) => { calls.push(ctx.solana ?? ''); return unavailableApp() },
  }]
  const service = createWalletSummaryService({ venues, now: () => new Date(clock.ms) })

  // Two requests for the same key at the same time share one fetch.
  const [first, shared] = await Promise.all([
    service.getSummary({ solana: SOL, evm: null }),
    service.getSummary({ solana: SOL, evm: null }),
  ])
  assert.equal(calls.length, 1)
  assert.equal(shared.fetchedAt, first.fetchedAt)
  // The whole summary is cached: a repeat inside the 15s TTL is the stored
  // response (same fetchedAt), not a refetch.
  const second = await service.getSummary({ solana: SOL, evm: null })
  assert.equal(calls.length, 1)
  assert.equal(second.fetchedAt, first.fetchedAt)
  // Keyed by both addresses: the other address pair is its own entry.
  await service.getSummary({ solana: SOL, evm: EVM })
  assert.equal(calls.length, 2)
  // After 15 seconds the entry has expired and the upstream is called again.
  clock.ms = 15_001
  await service.getSummary({ solana: SOL, evm: null })
  assert.equal(calls.length, 3)
})

test('the 501st key evicts the oldest cache entry', async () => {
  const hits = new Map<string, number>()
  const venues: WalletVenue[] = [{
    id: 'spot',
    fetch: async (ctx) => {
      const key = ctx.solana ?? ''
      hits.set(key, (hits.get(key) ?? 0) + 1)
      return unavailableApp()
    },
  }]
  const service = createWalletSummaryService({ venues, now: () => new Date(0) })
  const key = (index: number) => `address-${index}`

  for (let index = 1; index <= 500; index++) await service.getSummary({ solana: key(index), evm: null })
  // The 501st key pushes the cache past its cap and drops the oldest entry.
  await service.getSummary({ solana: key(501), evm: null })
  // The next-oldest entry survived the eviction of key(1).
  await service.getSummary({ solana: key(2), evm: null })
  assert.equal(hits.get(key(2)), 1)
  // The evicted oldest is recomputed on its next request (and re-inserted
  // as the newest, which evicts key(2) — not asserted here).
  await service.getSummary({ solana: key(1), evm: null })
  assert.equal(hits.get(key(1)), 2)
})

test('a slow app becomes unavailable and the others return', async () => {
  const consoleErrors: string[] = []
  const originalConsoleError = console.error
  console.error = (...parts: unknown[]) => { consoleErrors.push(parts.map(String).join(' ')) }
  try {
    const venues: WalletVenue[] = [
      { id: 'phoenix', fetch: () => new Promise<never>(() => {}) }, // slower than any real deadline
      { id: 'spot', fetch: async () => ({ status: 'unavailable', valueUsd: null, summary: null, error: 'spot answered' }) },
    ]
    const service = createWalletSummaryService({ venues, now: () => new Date(0), timeoutMs: 20 })
    const response = await app(service).request(`/wallet/summary?solana=${SOL}&evm=${EVM}`)
    assert.equal(response.status, 200)
    const body = await response.json() as WalletSummary
    // The timed-out app is the only `unavailable` slot; the others returned.
    assert.deepEqual(body.apps.phoenix, unavailable)
    assert.equal(body.apps.spot.error, 'spot answered')
    // Apps absent from the injected registry list stay the seeded stub.
    assert.deepEqual(body.apps.pacifica, unavailable)
    // Rule: log detail carries the [api] prefix, wire stays short.
    assert.equal(consoleErrors.length, 1)
    assert.match(consoleErrors[0], /\[api\] wallet-summary phoenix failed:.*timed out/)
  } finally {
    console.error = originalConsoleError
  }
})
