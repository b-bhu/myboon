import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
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
let receivedMethod = ''
let receivedUrl = ''
let receivedBody = ''

const PORT = 39517
const BUILDER_SECRET = Buffer.from('test-builder-secret-material').toString('base64')

process.env.POLYMARKET_BUILDER_API_KEY = 'test-key'
process.env.POLYMARKET_BUILDER_SECRET = BUILDER_SECRET
process.env.POLYMARKET_BUILDER_PASSPHRASE = 'test-passphrase'

before(async () => {
  upstream = createServer((req, res) => {
    received = req.headers as Record<string, string | undefined>
    receivedMethod = req.method ?? ''
    receivedUrl = req.url ?? ''
    receivedBody = ''
    req.on('data', (chunk) => { receivedBody += chunk.toString() })
    req.on('end', () => {
      const rejected = receivedUrl.startsWith('/reject')
      res.writeHead(rejected ? 418 : 200, { 'Content-Type': 'application/json' })
      res.end(rejected ? JSON.stringify({ error: 'upstream rejection' }) : JSON.stringify({ ok: true }))
    })
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
  test('injects the real Builder passphrase only on the upstream hop', async () => {
    const timestamp = `${Math.floor(Date.now() / 1000)}`
    const method = 'POST'
    const path = '/auth/api-key'
    const body = '{}'
    const signature = createHmac('sha256', Buffer.from(BUILDER_SECRET, 'base64'))
      .update(`${timestamp}${method}${path}${body}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')

    const res = await app.request(`/clob/proxy${path}`, {
      method,
      headers: {
        ...L1_HEADERS,
        POLY_BUILDER_API_KEY: 'test-key',
        POLY_BUILDER_SIGNATURE: signature,
        POLY_BUILDER_TIMESTAMP: timestamp,
        POLY_BUILDER_PASSPHRASE: 'myboon-server-injected:test-request-id',
        'Content-Type': 'application/json',
      },
      body,
    })
    assert.equal(res.status, 200)
    assert.equal(received['poly_builder_passphrase'], 'test-passphrase')
    assert.equal(res.headers.get('x-predict-request-id'), 'test-request-id')
  })

  test('refuses a forged server-injection marker', async () => {
    const res = await app.request('/clob/proxy/auth/api-key', {
      method: 'POST',
      headers: {
        ...L1_HEADERS,
        POLY_BUILDER_API_KEY: 'test-key',
        POLY_BUILDER_SIGNATURE: 'forged',
        POLY_BUILDER_TIMESTAMP: `${Math.floor(Date.now() / 1000)}`,
        POLY_BUILDER_PASSPHRASE: 'myboon-server-injected:test-request-id',
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(res.status, 401)
  })

  test('forwards the builder credential alongside the L1 headers', async () => {
    // `createSecureClient()` sends both sets on POST /auth/api-key. Dropping the
    // builder four made Polymarket answer "Invalid L1 Request headers" — an
    // error naming L1 for a fault that was entirely in the builder credential.
    const res = await app.request('/clob/proxy/auth/api-key', {
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
    const res = await app.request('/clob/proxy/auth/derive-api-key', {
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
    const res = await app.request('/clob/proxy/auth/api-key', {
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

  test('preserves method, remaining path, query, body, status and response', async () => {
    const body = JSON.stringify({ signed: 'order-envelope' })
    const res = await app.request('/clob/proxy/reject?reason=test', {
      method: 'POST',
      headers: { ...L1_HEADERS, ...BUILDER_HEADERS, 'Content-Type': 'application/json' },
      body,
    })
    assert.equal(res.status, 418)
    assert.deepEqual(await res.json(), { error: 'upstream rejection' })
    assert.equal(receivedMethod, 'POST')
    assert.equal(receivedUrl, '/reject?reason=test')
    assert.equal(receivedBody, body)
  })
})
