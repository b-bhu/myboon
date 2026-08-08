import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Wallet } from 'ethers'

/**
 * `/clob/builder/sign` hands out authorization billed to this app's Builder
 * account. These tests pin the two properties that keep it from being a
 * public signing oracle: it refuses callers who cannot prove wallet control,
 * and it refuses to sign relayer operations the SDK never legitimately asks
 * for.
 */

const SECRET_B64 = Buffer.from('test-builder-secret-material').toString('base64')

process.env.POLYMARKET_BUILDER_API_KEY = 'test-key'
process.env.POLYMARKET_BUILDER_SECRET = SECRET_B64
process.env.POLYMARKET_BUILDER_PASSPHRASE = 'test-passphrase'

let app: Hono
const wallet = Wallet.createRandom()

function proofMessage(address: string, timestamp: number): string {
  return [
    'myboon:predict:server-session',
    `address:${address.toLowerCase()}`,
    `timestamp:${timestamp}`,
  ].join('\n')
}

async function signedHeaders(w = wallet, timestamp = Date.now()) {
  const signature = await w.signMessage(proofMessage(w.address, timestamp))
  return {
    'Content-Type': 'application/json',
    'X-Predict-Address': w.address,
    'X-Predict-Timestamp': `${timestamp}`,
    'X-Predict-Signature': signature,
  }
}

function post(headers: Record<string, string>, body: unknown) {
  return app.request('/builder/sign', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

const DEPLOYED = { method: 'GET', path: '/deployed?address=0xabc' }

before(async () => {
  const { registerBuilderSignRoutes } = await import('./builder-sign.js')
  app = new Hono()
  registerBuilderSignRoutes(app)
})

describe('/builder/sign authentication', () => {
  test('rejects a request with no proof headers', async () => {
    const res = await post({ 'Content-Type': 'application/json' }, DEPLOYED)
    assert.equal(res.status, 401)
  })

  test('rejects a signature that does not match the claimed address', async () => {
    const attacker = Wallet.createRandom()
    const timestamp = Date.now()
    // Valid signature, but over the attacker's own address while claiming
    // the victim's — the recover step must catch the mismatch.
    const signature = await attacker.signMessage(proofMessage(attacker.address, timestamp))
    const res = await post({
      'Content-Type': 'application/json',
      'X-Predict-Address': wallet.address,
      'X-Predict-Timestamp': `${timestamp}`,
      'X-Predict-Signature': signature,
    }, DEPLOYED)
    assert.equal(res.status, 401)
  })

  test('rejects a garbage signature', async () => {
    const res = await post({
      'Content-Type': 'application/json',
      'X-Predict-Address': wallet.address,
      'X-Predict-Timestamp': `${Date.now()}`,
      'X-Predict-Signature': '0xdeadbeef',
    }, DEPLOYED)
    assert.equal(res.status, 401)
  })

  test('rejects a stale proof', async () => {
    // Older than AUTH_PROOF_MAX_AGE_MS (5 min), so a captured proof cannot
    // be replayed indefinitely.
    const stale = Date.now() - 10 * 60 * 1000
    const res = await post(await signedHeaders(wallet, stale), DEPLOYED)
    assert.equal(res.status, 401)
  })

  test('accepts a valid proof and returns all four builder headers', async () => {
    const res = await post(await signedHeaders(), DEPLOYED)
    assert.equal(res.status, 200)
    const json = await res.json() as Record<string, string>
    assert.equal(json.POLY_BUILDER_API_KEY, 'test-key')
    assert.equal(json.POLY_BUILDER_PASSPHRASE, 'test-passphrase')
    assert.ok(json.POLY_BUILDER_SIGNATURE?.length > 0)
    assert.ok(json.POLY_BUILDER_TIMESTAMP?.length > 0)
    // base64url — a raw base64 '+' or '/' would be rejected upstream.
    assert.doesNotMatch(json.POLY_BUILDER_SIGNATURE, /[+/]/)
  })
})

describe('/builder/sign path allowlist', () => {
  test('permits the two relayer paths the SDK actually uses', async () => {
    for (const req of [DEPLOYED, { method: 'POST', path: '/submit', body: '{}' }]) {
      const res = await post(await signedHeaders(), req)
      assert.equal(res.status, 200, `expected ${req.method} ${req.path} to be allowed`)
    }
  })

  test('permits both credential paths, so returning users are not locked out', async () => {
    // The SDK creates a key first and falls back to deriving when one already
    // exists (Polymarket answers the POST with a 400 in that case). A first-time
    // signer only ever needs the POST, so allowlisting that alone still passes a
    // new-account test while breaking every returning account — issue #275.
    const credentialCalls = [
      { method: 'POST', path: '/auth/api-key', body: '{}' },
      { method: 'GET', path: '/auth/derive-api-key' },
    ]
    for (const req of credentialCalls) {
      const res = await post(await signedHeaders(), req)
      assert.equal(res.status, 200, `expected ${req.method} ${req.path} to be allowed`)
    }
  })

  test('refuses an arbitrary path even with a valid proof', async () => {
    const res = await post(await signedHeaders(), { method: 'POST', path: '/withdraw', body: '{}' })
    assert.equal(res.status, 403)
  })

  test('refuses a disallowed method on an allowed path', async () => {
    const res = await post(await signedHeaders(), { method: 'DELETE', path: '/submit' })
    assert.equal(res.status, 403)
  })

  test('refuses a path that merely starts with an allowed one', async () => {
    // `/submit-anything` must not pass by prefix match.
    const res = await post(await signedHeaders(), { method: 'POST', path: '/submit-anything' })
    assert.equal(res.status, 403)
  })

  test('rejects a non-string body rather than signing "[object Object]"', async () => {
    const res = await post(await signedHeaders(), { method: 'POST', path: '/submit', body: { a: 1 } })
    assert.equal(res.status, 400)
  })
})

describe('/builder/sign rate limiting', () => {
  test('caps a single address and leaves a different address unaffected', async () => {
    const heavy = Wallet.createRandom()
    let limited = 0
    for (let i = 0; i < 25; i++) {
      const res = await post(await signedHeaders(heavy), DEPLOYED)
      if (res.status === 429) limited++
    }
    assert.ok(limited > 0, 'expected the address to be rate limited within 25 requests')

    // The cap is per-address, so an unrelated wallet still succeeds.
    const bystander = Wallet.createRandom()
    const res = await post(await signedHeaders(bystander), DEPLOYED)
    assert.equal(res.status, 200)
  })
})
