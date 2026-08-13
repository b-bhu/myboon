import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'

// createTokenRoutes({ enabled: true, ... }) calls into resolveRef(), which
// reads process.env.TOKEN_IDENTITY_ENABLED via perpIconPath() for icon
// paths. Set the flag BEFORE importing so module-level env reads see it —
// tsx --test shares a process per file, so flag-ON and flag-OFF tests must
// stay in separate files (see routes-flag-off.test.ts).
process.env.TOKEN_IDENTITY_ENABLED = '1'

const { createTokenRoutes } = await import('./routes.js')
const { resolveRef, iconSourceUrlForAssetId, resolveCatalog } = await import('./identity-service.js')
const seedEntries = (await import('./seed/token-identities.seed.json', { with: { type: 'json' } })).default as Array<{ assetId: string; mint: string | null }>

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function buildApp() {
  const app = new Hono()
  app.route('/tokens', createTokenRoutes({ enabled: true, service: { resolveRef, iconSourceUrlForAssetId, resolveCatalog } }))
  return app
}

test('GET /resolve hit returns full identity with iconUrl starting /tokens/icon/', async () => {
  const app = buildApp()
  const response = await app.request(`/tokens/resolve?refs=${encodeURIComponent(`mint:${USDC_MINT}`)}`)
  assert.equal(response.status, 200)
  const body = await response.json() as { identities: Array<{ assetId: string | null; iconUrl: string | null }> }
  assert.equal(body.identities.length, 1)
  assert.equal(body.identities[0].assetId, 'usdc')
  assert.ok(body.identities[0].iconUrl?.startsWith('/tokens/icon/'))
})

test('GET /resolve miss returns 200 with assetId null, correct fallbackLetter, and key echoed verbatim', async () => {
  const app = buildApp()
  const ref = 'mint:NotARealMintAddressAtAll1111111111111'
  const response = await app.request(`/tokens/resolve?refs=${encodeURIComponent(ref)}`)
  assert.equal(response.status, 200)
  const body = await response.json() as { identities: Array<{ key: string; assetId: string | null; fallbackLetter: string; symbol: string }> }
  assert.equal(body.identities.length, 1)
  const identity = body.identities[0]
  assert.equal(identity.key, ref)
  assert.equal(identity.assetId, null)
  assert.equal(identity.fallbackLetter, identity.symbol.charAt(0).toUpperCase())
})

test('POST /resolve preserves input order across hits and misses', async () => {
  const app = buildApp()
  const refs = [
    'perp:ETH',
    'mint:NotARealMintAddressAtAll1111111111111',
    `mint:${USDC_MINT}`,
    'perp:BTC-PERP',
  ]
  const response = await app.request('/tokens/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs }),
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { identities: Array<{ key: string }> }
  assert.deepEqual(body.identities.map((identity) => identity.key), refs)
})

test('GET /resolve rejects more than 100 refs cleanly', async () => {
  const app = buildApp()
  const refs = Array.from({ length: 101 }, (_, i) => `perp:SYM${i}`).join(',')
  const response = await app.request(`/tokens/resolve?refs=${encodeURIComponent(refs)}`)
  assert.equal(response.status, 400)
  const body = await response.json() as { error: string }
  assert.ok(body.error)
})

test('POST /resolve rejects more than 500 refs cleanly', async () => {
  const app = buildApp()
  const refs = Array.from({ length: 501 }, (_, i) => `perp:SYM${i}`)
  const response = await app.request('/tokens/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs }),
  })
  assert.equal(response.status, 400)
})

test('perp:BTC-PERP and perp:BTC resolve identically', async () => {
  const app = buildApp()
  const response = await app.request('/tokens/resolve?refs=perp%3ABTC-PERP%2Cperp%3ABTC')
  assert.equal(response.status, 200)
  const body = await response.json() as { identities: Array<{ assetId: string | null }> }
  assert.equal(body.identities.length, 2)
  assert.equal(body.identities[0].assetId, body.identities[1].assetId)
  assert.equal(body.identities[0].assetId, 'btc')
})

test('GET /icon/:assetId 404s for an unknown assetId', async () => {
  const app = buildApp()
  const response = await app.request('/tokens/icon/not-a-real-asset-id')
  assert.equal(response.status, 404)
})

test('GET /icon/:assetId serves checked-in bytes from disk without any network call', async () => {
  // The primary path: icons live in packages/api/assets/token-icons/ (populated
  // by `pnpm --filter @myboon/api run tokens:icons`) and are served straight
  // from disk. Asserting that no fetch happens IS the point — a token's logo
  // does not change, so the API must not hold a live dependency on an image
  // host just to render a market row.
  const app = buildApp()
  const seededWithIcon = seedEntries.find((entry) => entry.assetId === 'btc')
  assert.ok(seededWithIcon, 'expected a seeded btc entry')

  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls += 1
    return new Response(null, { status: 500 })
  }) as typeof fetch

  try {
    const response = await app.request('/tokens/icon/btc')
    assert.equal(response.status, 200)
    assert.equal(fetchCalls, 0, 'a checked-in icon must not trigger an upstream fetch')
    assert.ok(
      response.headers.get('content-type')?.startsWith('image/'),
      'serves real image bytes',
    )
    assert.ok((await response.arrayBuffer()).byteLength > 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GET /icon/:assetId 404s cleanly for an asset with no file and no seed row', async () => {
  // Fallback path. A synthetic id so it cannot collide with a real checked-in
  // file: nothing on disk, no seed row, so no URL to fetch — 404, never a
  // guessed or arbitrary image.
  const app = buildApp()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => (
    new Response('<svg>should-not-be-used</svg>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } })
  )) as typeof fetch

  try {
    const response = await app.request('/tokens/icon/not-on-disk-test-asset')
    assert.equal(response.status, 404)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GET /icon/:assetId rejects path traversal in the assetId', async () => {
  // assetIds reach the filesystem now, and a ref is caller-controlled input.
  const app = buildApp()
  for (const bad of ['..%2F..%2Fpackage', '..', 'foo%2F..%2F..%2Fsecret']) {
    const response = await app.request(`/tokens/icon/${bad}`)
    assert.ok(response.status === 404 || response.status === 400, `${bad} must not resolve to a file`)
  }
})

test('GET /catalog returns every identity in one response, with a long max-age and an ETag', async () => {
  const app = buildApp()
  const response = await app.request('/tokens/catalog')
  assert.equal(response.status, 200)

  const cacheControl = response.headers.get('cache-control') ?? ''
  const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1] ?? 0)
  assert.ok(maxAge >= 24 * 60 * 60, 'identity is static — cache for at least a day')
  assert.ok(response.headers.get('etag'), 'must ship a validator so a warm client can 304')

  const body = await response.json() as { identities: Array<{ key: string; iconUrl: string | null }> }
  // Big enough to actually be the catalog, and every entry is a real ref.
  assert.ok(body.identities.length > 50, `expected the full catalog, got ${body.identities.length}`)
  for (const identity of body.identities) {
    assert.ok(identity.key.startsWith('perp:') || identity.key.startsWith('mint:'))
    // Acceptance criterion 1: icons only ever come from our own origin.
    if (identity.iconUrl) assert.ok(identity.iconUrl.startsWith('/tokens/icon/'))
  }
})

test('GET /catalog revalidates to a bodyless 304 when the ETag matches', async () => {
  const app = buildApp()
  const first = await app.request('/tokens/catalog')
  const etag = first.headers.get('etag')
  assert.ok(etag)

  const revalidated = await app.request('/tokens/catalog', { headers: { 'If-None-Match': etag } })
  assert.equal(revalidated.status, 304)
  assert.equal((await revalidated.arrayBuffer()).byteLength, 0, '304 must not resend the payload')

  // A stale validator must still get the full body, or clients would never update.
  const stale = await app.request('/tokens/catalog', { headers: { 'If-None-Match': 'W/"stale"' } })
  assert.equal(stale.status, 200)
  assert.ok((await stale.arrayBuffer()).byteLength > 0)
})

test('GET /catalog agrees with GET /resolve for the same ref', async () => {
  // One code path: a catalog entry must be byte-identical to what /resolve
  // returns, or the client would see different identities depending on which
  // endpoint filled its cache.
  const app = buildApp()
  const catalog = await (await app.request('/tokens/catalog')).json() as { identities: Array<{ key: string }> }
  const sample = catalog.identities.find((identity) => identity.key === 'perp:BTC')
  assert.ok(sample, 'expected perp:BTC in the catalog')

  const resolved = await (await app.request('/tokens/resolve?refs=perp%3ABTC')).json() as { identities: unknown[] }
  assert.deepEqual(sample, resolved.identities[0])
})
