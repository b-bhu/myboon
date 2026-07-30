import type { Hono } from 'hono'
import { CLOB_HOST } from '../contracts.js'

export function registerProxyRoutes(routes: Hono) {
  routes.get('/book', async (c) => {
    const tokenId = c.req.query('token_id')
    if (!tokenId) return c.json({ error: 'Missing token_id query param' }, 400)
    try {
      const res = await fetch(`${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`)
      const data = await res.json()
      return c.json(data, (res.ok ? 200 : res.status) as any)
    } catch (err: any) {
      return c.json({ error: 'CLOB book proxy failed', detail: err.message }, 502)
    }
  })

  routes.get('/midpoint', async (c) => {
    const tokenId = c.req.query('token_id')
    if (!tokenId) return c.json({ error: 'Missing token_id query param' }, 400)
    try {
      const res = await fetch(`${CLOB_HOST}/midpoint?token_id=${encodeURIComponent(tokenId)}`)
      const data = await res.json()
      return c.json(data, (res.ok ? 200 : res.status) as any)
    } catch (err: any) {
      return c.json({ error: 'CLOB midpoint proxy failed', detail: err.message }, 502)
    }
  })

  routes.get('/last-trade-price', async (c) => {
    const tokenId = c.req.query('token_id')
    if (!tokenId) return c.json({ error: 'Missing token_id query param' }, 400)
    try {
      const res = await fetch(`${CLOB_HOST}/last-trade-price?token_id=${encodeURIComponent(tokenId)}`)
      const data = await res.json()
      return c.json(data, (res.ok ? 200 : res.status) as any)
    } catch (err: any) {
      return c.json({ error: 'CLOB last-trade-price proxy failed', detail: err.message }, 502)
    }
  })

  routes.get('/markets/:conditionId', async (c) => {
    const conditionId = c.req.param('conditionId')
    try {
      const res = await fetch(`${CLOB_HOST}/markets/${encodeURIComponent(conditionId)}`)
      const data = await res.json()
      return c.json(data, (res.ok ? 200 : res.status) as any)
    } catch (err: any) {
      return c.json({ error: 'CLOB market info proxy failed', detail: err.message }, 502)
    }
  })

  routes.get('/rewards/markets', async (c) => {
    try {
      const incomingUrl = new URL(c.req.url)
      const upstreamUrl = new URL('https://polymarket.com/api/rewards/markets')
      upstreamUrl.search = incomingUrl.search
      const res = await fetch(upstreamUrl)
      const body = await res.text()
      return new Response(body, {
        status: res.status,
        headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
      })
    } catch (err: any) {
      return c.json({ error: 'Polymarket rewards markets proxy failed', detail: err.message }, 502)
    }
  })

  routes.get('/gamma/events/:eventId', async (c) => {
    const eventId = c.req.param('eventId')
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/events/${encodeURIComponent(eventId)}`)
      const data = await res.json()
      return c.json(data, res.ok ? 200 : (res.status as any))
    } catch (err: any) {
      return c.json({ error: 'Gamma proxy failed', detail: err.message }, 502)
    }
  })

  routes.get('/v2/health', async (c) => {
    try {
      const res = await fetch(`${CLOB_HOST}/time`)
      const data = await res.json().catch(() => null)
      return c.json({ ok: res.ok, host: CLOB_HOST, status: res.status, serverTime: data })
    } catch (err: any) {
      return c.json({ ok: false, host: CLOB_HOST, error: err.message }, 502)
    }
  })

  /**
   * CLOB L1 auth relay — `/auth/derive-api-key` and `/auth/api-key`.
   *
   * The device cannot reach `clob.polymarket.com` directly on some networks, so
   * these two calls fail where every other Polymarket read already succeeds
   * through the proxies above. This closes that gap: the phone points its
   * `ClobClient` at this host and the request is relayed unchanged.
   *
   * The EIP-712 signature is still produced on the device and travels in the
   * `POLY_SIGNATURE` header. This server relays those headers verbatim and never
   * sees key material — the spec's trust boundary is unaffected. Only the L1
   * auth headers are forwarded, so nothing else about the caller leaks upstream.
   */
  // Signed with the user's key (L1) or their CLOB session secret (L2). Relayed
  // verbatim — the signature covers the method and path, so altering either
  // would invalidate it.
  const POLY_AUTH_HEADERS = [
    'POLY_ADDRESS',
    'POLY_SIGNATURE',
    'POLY_TIMESTAMP',
    'POLY_NONCE',
    'POLY_API_KEY',
    'POLY_PASSPHRASE',
  ]

  /**
   * Catch-all relay for the CLOB client.
   *
   * Registered last so the explicit routes above keep their own behaviour, and
   * deliberately path-agnostic: `createOrder` alone hits `/tick-size`,
   * `/neg-risk`, and `/fee-rate`, and enumerating the SDK's endpoints here would
   * leave the next one to fail in production. Anything the client asks for is
   * forwarded as-is.
   */
  async function relayToClob(c: any) {
    const url = new URL(c.req.url)
    // `/clob` is this router's mount prefix; upstream expects the path without it.
    const path = url.pathname.replace(/^\/clob/, '') || '/'
    const target = `${CLOB_HOST}${path}${url.search}`

    const headers: Record<string, string> = { Accept: 'application/json' }
    for (const name of POLY_AUTH_HEADERS) {
      const value = c.req.header(name) ?? c.req.header(name.toLowerCase())
      if (value) headers[name] = value
    }

    const method = c.req.method
    let body: string | undefined
    if (method !== 'GET' && method !== 'HEAD') {
      body = await c.req.text()
      if (body) headers['Content-Type'] = c.req.header('content-type') ?? 'application/json'
    }

    try {
      const res = await fetch(target, { method, headers, body })
      const text = await res.text()
      // Upstream status passes through untouched: a 401 is a real auth failure
      // the client must act on, not a proxy error to flatten into a 502.
      return new Response(text, {
        status: res.status,
        headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
      })
    } catch (err: any) {
      return c.json({ error: 'CLOB proxy failed', detail: err.message, path }, 502)
    }
  }

  routes.all('/auth/*', relayToClob)
  routes.get('/tick-size', relayToClob)
  routes.get('/neg-risk', relayToClob)
  routes.get('/fee-rate', relayToClob)
  routes.get('/price', relayToClob)
  routes.get('/spread', relayToClob)
  routes.get('/time', relayToClob)
}
