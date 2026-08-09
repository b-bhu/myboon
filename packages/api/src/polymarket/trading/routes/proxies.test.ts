import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createServer, type Server } from 'node:http'

/**
 * The CLOB relay forwards a fixed set of auth headers and drops everything
 * else, so the app cannot leak unrelated request metadata upstream. That
 * allowlist is also the failure mode nobody sees: a header missing from it
 * doesn't error here, it produces an upstream rejection that looks like the
 * device signed something wrong.
 *
 * These tests stand a stub in for `clob.polymarket.com` and assert on exactly
 * what arrives.
 */

let app: Hono
let upstream: Server
let received: Record<string, string | undefined> = {}

const PORT = 39517

before(async () => {
  upstream = createServer((req, res) => {
    received = req.headers as Record<string, string | undefined>
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => upstream.listen(PORT, resolve))

  // Point the relay at the stub before the module reads it at import time.
  process.env.CLOB_HOST = `http://127.0.0.1:${PORT}`
  const { registerProxyRoutes } = await import('./proxies.js')
  app = new Hono()
  const clob = new Hono()
  registerProxyRoutes(clob)
  app.route('/clob', clob)
})

after(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

/** Every header the SDK attaches to a builder-authenticated CLOB request. */
const L1_HEADERS = {
  POLY_ADDRESS: '0xDd79A1287e691A3f0eD3CFeeD72C67b6c2851E40',
  POLY_SIGNATURE: '0xsig',
  POLY_TIMESTAMP: '1754661600',
  POLY_NONCE: '0',
}

const BUILDER_HEADERS = {
  POLY_BUILDER_API_KEY: 'builder-key',
  POLY_BUILDER_SIGNATURE: 'builder-sig',
  POLY_BUILDER_TIMESTAMP: '1754661600',
  POLY_BUILDER_PASSPHRASE: 'builder-pass',
}

describe('CLOB auth relay header forwarding', () => {
  test('forwards the builder credential alongside the L1 headers', async () => {
    // `createSecureClient()` sends both sets on POST /auth/api-key. Dropping the
    // builder four made Polymarket answer "Invalid L1 Request headers" — an
    // error naming L1 for a fault that was entirely in the builder credential.
    const res = await app.request('/clob/auth/api-key', {
      method: 'POST',
      headers: { ...L1_HEADERS, ...BUILDER_HEADERS, 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(res.status, 200)

    for (const name of Object.keys(BUILDER_HEADERS)) {
      assert.equal(
        received[name.toLowerCase()],
        BUILDER_HEADERS[name as keyof typeof BUILDER_HEADERS],
        `${name} must reach upstream`,
      )
    }
    for (const name of Object.keys(L1_HEADERS)) {
      assert.equal(
        received[name.toLowerCase()],
        L1_HEADERS[name as keyof typeof L1_HEADERS],
        `${name} must reach upstream`,
      )
    }
  })

  test('forwards the builder credential on the derive fallback too', async () => {
    // The returning-user path (GET /auth/derive-api-key) is builder-signed the
    // same way, and is the one a repeat login actually takes.
    const res = await app.request('/clob/auth/derive-api-key', {
      method: 'GET',
      headers: { ...L1_HEADERS, ...BUILDER_HEADERS },
    })
    assert.equal(res.status, 200)
    assert.equal(received['poly_builder_signature'], 'builder-sig')
    assert.equal(received['poly_address'], L1_HEADERS.POLY_ADDRESS)
  })

  test('still drops headers outside the allowlist', async () => {
    // The allowlist is the reason nothing else about the caller reaches
    // Polymarket; widening it for the builder set must not have opened it up.
    const res = await app.request('/clob/auth/api-key', {
      method: 'POST',
      headers: {
        ...L1_HEADERS,
        ...BUILDER_HEADERS,
        Cookie: 'session=should-not-leak',
        Authorization: 'Bearer should-not-leak',
        'X-Device-Id': 'should-not-leak',
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(res.status, 200)
    assert.equal(received['cookie'], undefined)
    assert.equal(received['authorization'], undefined)
    assert.equal(received['x-device-id'], undefined)
  })
})
