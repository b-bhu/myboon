import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'

// Flag OFF. Must live in a separate file from routes.test.ts (flag ON) —
// tsx --test shares one process per file, and modules cache their env reads
// at import time, so flag-ON and flag-OFF tests cannot coexist in one file.
process.env.TOKEN_IDENTITY_ENABLED = '0'
delete process.env.TOKEN_IDENTITY_ENABLED

const { createTokenRoutes } = await import('./routes.js')
const { resolveRef, iconSourceUrlForAssetId, resolveCatalog } = await import('./identity-service.js')

function buildApp() {
  const app = new Hono()
  app.route('/tokens', createTokenRoutes({ enabled: false, service: { resolveRef, iconSourceUrlForAssetId, resolveCatalog } }))
  return app
}

test('flag off: GET /resolve returns well-formed static identities with iconUrl null', async () => {
  const app = buildApp()
  const response = await app.request('/tokens/resolve?refs=perp%3ABTC-PERP%2Cmint%3AEPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  assert.equal(response.status, 200)
  const body = await response.json() as { identities: Array<{ assetId: string | null; iconUrl: string | null; source: string; symbol: string }> }
  assert.equal(body.identities.length, 2)
  for (const identity of body.identities) {
    assert.equal(identity.assetId, null)
    assert.equal(identity.iconUrl, null)
    assert.equal(identity.source, 'static')
    assert.ok(identity.symbol.length > 0)
  }
})

test('flag off: POST /resolve returns well-formed static identities in order, nothing 500s', async () => {
  const app = buildApp()
  const refs = ['perp:ETH', 'mint:garbage', 'unparseable-ref']
  const response = await app.request('/tokens/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs }),
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { identities: Array<{ key: string; iconUrl: string | null }> }
  assert.deepEqual(body.identities.map((identity) => identity.key), refs)
  for (const identity of body.identities) assert.equal(identity.iconUrl, null)
})

test('flag off: GET /icon/:assetId 404s', async () => {
  const app = buildApp()
  const response = await app.request('/tokens/icon/btc')
  assert.equal(response.status, 404)
})

test('flag off: empty refs param returns an empty, well-formed list', async () => {
  const app = buildApp()
  const response = await app.request('/tokens/resolve')
  assert.equal(response.status, 200)
  const body = await response.json() as { identities: unknown[] }
  assert.deepEqual(body.identities, [])
})

test('flag off: the ref is parsed for its symbol, so the letter box matches flag-on', async () => {
  // Regression: deriving fallbackLetter from the raw ref gave every perp row
  // a 'P' (from "perp:") and every spot row an 'M' (from "mint:"). Acceptance
  // criterion 3 requires the same box, colour and letter in every venue —
  // that has to hold with the flag off too, since flag-off is the default
  // deploy state and the client renders whatever letter it is handed.
  const app = buildApp()
  const cases: Array<[string, string, string]> = [
    // ref, expected symbol, expected letter
    ['perp:BTC', 'BTC', 'B'],
    ['perp:BTC-PERP', 'BTC-PERP', 'B'],
    ['perp:kPEPE', 'kPEPE', 'K'],
    ['perp:2Z', '2Z', '2'],
    ['mint:So11111111111111111111111111111111111111112', 'So11111111111111111111111111111111111111112', 'S'],
  ]
  const response = await app.request(
    `/tokens/resolve?refs=${encodeURIComponent(cases.map(([ref]) => ref).join(','))}`,
  )
  assert.equal(response.status, 200)
  const body = await response.json() as {
    identities: Array<{ key: string; symbol: string; fallbackLetter: string }>
  }
  cases.forEach(([ref, symbol, letter], index) => {
    const identity = body.identities[index]
    assert.equal(identity.key, ref, `${ref}: key echoed verbatim`)
    assert.equal(identity.symbol, symbol, `${ref}: symbol parsed out of the ref`)
    assert.equal(identity.fallbackLetter, letter, `${ref}: letter matches the flag-on path`)
  })
})

test('flag off: GET /catalog is a well-formed empty catalog, not an error', async () => {
  // Degradation must be boring: the client asks for the catalog on every cold
  // start, so with the flag off it needs a valid empty answer rather than a
  // failure it has to special-case.
  const app = buildApp()
  const response = await app.request('/tokens/catalog')
  assert.equal(response.status, 200)
  const body = await response.json() as { identities: unknown[] }
  assert.deepEqual(body.identities, [])
})
