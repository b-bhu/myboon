import assert from 'node:assert/strict'
import test from 'node:test'
import { createOptionalTokenRegistry, TokenRegistry } from './token-registry.js'
import { UpstreamLimiter, UpstreamStatusError } from './limiter.js'
import { InMemoryTokenRegistryStore } from './store.js'
import type { TokenRegistryIncoming } from './merge.js'

const config = { lruMax: 1000, foundTtlMs: 604800000, missTtlMs: 600000, staleAfterMs: 86400000, maxConcurrency: 2, rpm: 30, cooldownMs: 300000, maxPerRequest: 50, requestBudgetMs: 2000, queueMax: 1000 }
const row = (mint: string, seen = new Date().toISOString()): TokenRegistryIncoming => ({ mint, symbol: `S${mint}`, name: `Name ${mint}`, decimals: 6, icon_source_url: null, verified: false, sources: { symbol: 'jupiter', name: 'jupiter', decimals: 'jupiter', verified: 'jupiter' }, upstream_seen_at: seen })

test('registry follows LRU then store then upstream, and persists upstream rows', async () => {
  const store = new InMemoryTokenRegistryStore(); await store.upsertMany([row('stored')])
  let calls = 0
  const registry = new TokenRegistry({ store, config, fetchBatch: async (mints) => { calls++; return mints.map((mint) => row(mint)) } })
  const result = await registry.resolve(['mint:stored', 'mint:cold'])
  assert.equal(calls, 1)
  assert.deepEqual(result.identities.map((x) => x.symbol), ['Sstored', 'Scold'])
  await store.upsertMany(Array.from({ length: 100 }, (_, i) => row(`known${i}`)))
  const afterRestart = new TokenRegistry({ store, config, fetchBatch: async () => { calls++; return [] } })
  await afterRestart.resolve(Array.from({ length: 100 }, (_, i) => `mint:known${i}`))
  assert.equal(calls, 1, 'all persisted mints resolve without upstream calls')
})

test('stale rows return immediately and trigger one deduped refresh', async () => {
  let now = Date.now()
  const store = new InMemoryTokenRegistryStore()
  await store.upsertMany([row('stale', new Date(now - 90_000_000).toISOString())])
  let calls = 0
  const registry = new TokenRegistry({ store, config: { ...config, staleAfterMs: 1 }, now: () => now, fetchBatch: async (mints) => { calls++; return mints.map((mint) => row(mint, new Date(now).toISOString())) } })
  const first = await registry.resolve(['mint:stale'])
  const second = await registry.resolve(['mint:stale'])
  assert.equal(first.identities[0].symbol, 'Sstale')
  assert.equal(second.identities[0].symbol, 'Sstale')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls, 1)
})

test('500 cold refs cap foreground to 50 mints and return exact unresolved refs', async () => {
  let calls = 0; let active = 0; let maximum = 0
  const registry = new TokenRegistry({ store: new InMemoryTokenRegistryStore(), config: { ...config, queueMax: 0 }, fetchBatch: async (mints) => {
    calls++; active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 1)); active--
    return mints.map((mint) => row(mint))
  } })
  const refs = Array.from({ length: 500 }, (_, i) => `mint:m${i}`)
  const result = await registry.resolve(refs)
  assert.ok(calls <= 5)
  assert.ok(maximum <= 2)
  assert.equal(result.partial, true)
  assert.deepEqual(result.unresolved, refs.slice(50))
  assert.equal(result.identities.length, 500)
})

test('open circuit uses seed and cached misses without upstream calls; counts actual calls', async () => {
  const store = new InMemoryTokenRegistryStore()
  const seed = { ...row('seed'), sources: { verified: 'seed' }, verified: true }
  let fetchCalls = 0
  const limiter = new UpstreamLimiter({ requestsPerMinute: 100 })
  const registry = new TokenRegistry({ store, config, limiter, seeds: [seed], fetchBatch: async () => { fetchCalls++; return [] } })
  for (let i = 0; i < 3; i++) await assert.rejects(limiter.schedule(async () => { throw new UpstreamStatusError(500) }))
  const result = await registry.resolve(['mint:seed', 'mint:miss'])
  assert.equal(result.identities[0].verified, true)
  assert.equal(fetchCalls, 0)
  await registry.resolve(['mint:miss'])
  assert.equal(fetchCalls, 0)
  assert.equal(registry.counter.snapshot()['jupiter,500'], undefined, 'limiter denials are not upstream calls')
})

test('each attempted upstream request increments its source/status counter', async () => {
  const registry = new TokenRegistry({ store: new InMemoryTokenRegistryStore(), config, fetchBatch: async (mints) => mints.map((mint) => row(mint)) })
  await registry.resolve(['mint:counter'])
  assert.equal(registry.counter.snapshot()['jupiter,200'], 1)
})


test('registry flag defaults off and does not construct a registry; legacy route response remains unchanged', async () => {
  const { loadApiConfig } = await import('../../bootstrap/config.js')
  const cfg = loadApiConfig({ SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'x', JUP_API_KEY: 'x' } as NodeJS.ProcessEnv)
  assert.equal(cfg.tokenRegistryEnabled, false)
  assert.equal(loadApiConfig({ SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'x', JUP_API_KEY: 'x', TOKEN_REGISTRY_ENABLED: 'true' } as NodeJS.ProcessEnv).tokenRegistryEnabled, true)
  assert.equal(loadApiConfig({ SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'x', JUP_API_KEY: 'x', TOKEN_REGISTRY_ENABLED: 'TRUE' } as NodeJS.ProcessEnv).tokenRegistryEnabled, false)
  let constructed = false
  assert.equal(createOptionalTokenRegistry(cfg.tokenRegistryEnabled, () => { constructed = true; return {} }), undefined)
  assert.equal(constructed, false)
  const { createTokenRoutes } = await import('../routes.js')
  const { Hono } = await import('hono')
  const app = new Hono()
  app.route('/tokens', createTokenRoutes({ enabled: false, service: { resolveRef: () => { throw new Error('must not resolve') }, iconSourceUrlForAssetId: () => null, resolveCatalog: () => [] } }))
  const response = await app.request('/tokens/resolve?refs=perp%3ABTC')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { identities: [{ key: 'perp:BTC', assetId: null, symbol: 'BTC', name: 'BTC', iconUrl: null, decimals: null, mint: null, verified: false, category: 'unknown', fallbackLetter: 'B', source: 'static' }] })
})


test('registry-warmed seed keeps the existing canonical identity contract', async () => {
  const { tokenRegistrySeeds } = await import('../identity-service.js')
  const { resolveRef } = await import('../identity-service.js')
  const seed = tokenRegistrySeeds().find((entry) => entry.symbol === 'USDC')
  assert.ok(seed?.mint)
  const registry = new TokenRegistry({ store: new InMemoryTokenRegistryStore(), config, seeds: tokenRegistrySeeds(), fetchBatch: async () => [] })
  await registry.lookupMany([seed.mint])
  const identity = resolveRef(`mint:${seed.mint}`, (mint) => registry.getCachedRow(mint))
  assert.equal(identity.assetId, 'usdc')
  assert.equal(identity.source, 'static')
  assert.equal(identity.iconUrl, '/tokens/icon/usdc')
})
