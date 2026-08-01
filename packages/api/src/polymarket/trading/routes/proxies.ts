import type { Hono } from 'hono'
import { CLOB_HOST, RELAYER_URL } from '../contracts.js'

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

  /**
   * Relayer proxy — `@polymarket/client`'s `SecureClient` calls
   * `relayer-v2.polymarket.com` directly (e.g. `GET /deployed` to check
   * whether a signer's deposit wallet already exists), not through this
   * app's `/clob` proxy. Confirmed on-device: this host times out on the
   * same networks `clob.polymarket.com` did, which is exactly why the CLOB
   * relay above exists — the new SDK just talks to a second Polymarket host
   * the old one never did.
   *
   * Same trust shape as `relayToClob`: whatever headers/body the SDK sends
   * are forwarded verbatim, upstream status passes through untouched, and no
   * key material crosses this boundary — Builder-authorized calls carry
   * `POLY_BUILDER_*` headers computed on the server side already
   * (`relayerBuilderConfig` in `wallet.ts`), and this route does not
   * generate or need those; it only relays whatever the caller already
   * built. Path-agnostic for the same reason as the CLOB relay: enumerating
   * the SDK's relayer endpoints here would leave the next one (e.g. `/nonce`,
   * `/submit`) to fail in production exactly like `/deployed` just did.
   */
  async function relayToRelayer(c: any) {
    const url = new URL(c.req.url)
    const path = url.pathname.replace(/^\/clob\/relayer-proxy/, '') || '/'
    const target = `${RELAYER_URL}${path}${url.search}`

    const method = c.req.method
    const headers: Record<string, string> = { Accept: 'application/json' }
    const contentType = c.req.header('content-type')
    if (contentType) headers['Content-Type'] = contentType
    for (const [name, value] of Object.entries(c.req.header())) {
      if (name.toLowerCase().startsWith('poly_builder')) headers[name] = value as string
    }

    let body: string | undefined
    if (method !== 'GET' && method !== 'HEAD') {
      body = await c.req.text()
    }

    // Temporary diagnostic — remove once the on-device "invalid address"
    // failure is understood. curl and a Node script both succeed against
    // this exact route for the same address, so something about the real
    // phone request differs; logging it directly is faster than guessing.
    console.log('[relayer-proxy] incoming', { incomingUrl: c.req.url, method, path, target, headers })

    try {
      const res = await fetch(target, { method, headers, body })
      const text = await res.text()
      console.log('[relayer-proxy] upstream response', { status: res.status, text: text.slice(0, 500) })
      return new Response(text, {
        status: res.status,
        headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
      })
    } catch (err: any) {
      return c.json({ error: 'Relayer proxy failed', detail: err.message, path }, 502)
    }
  }

  routes.all('/relayer-proxy/*', relayToRelayer)
}
