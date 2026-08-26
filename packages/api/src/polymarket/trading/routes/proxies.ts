import type { Hono } from 'hono'
import { CLOB_HOST, RELAYER_URL } from '../contracts.js'
import { materializeBuilderPassphrase } from './builder-sign.js'

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

  // The unified SecureClient owns L1/L2 auth on the phone. This proxy relays
  // only `POLY_*` headers and never logs their values or signed order bodies.
  // The one intentional transformation is the non-secret Builder passphrase
  // marker: after validating the Builder HMAC against this exact request, the
  // API injects the real passphrase only into the upstream request.
  //
  // The `POLY_BUILDER_*` four are a second, independent credential on the same
  // request: `@polymarket/client` calls `resolveClobHeaders()` before a
  // builder-authenticated CLOB request and merges the headers our own
  // `/clob/builder/sign` route returned into it. They are not interchangeable
  // with the L1 set — upstream wants both, and dropping them makes an otherwise
  // valid request fail as "Invalid L1 Request headers", which reads like a
  // signature problem on the device rather than a header the proxy discarded.
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
    const path = url.pathname.replace(/^\/clob\/proxy/, '') || '/'
    const target = `${CLOB_HOST}${path}${url.search}`

    const headers: Record<string, string> = { Accept: 'application/json' }
    for (const [name, value] of Object.entries(c.req.header())) {
      if (name.toLowerCase().startsWith('poly_')) headers[name] = value as string
    }

    const method = c.req.method
    let body: string | undefined
    if (method !== 'GET' && method !== 'HEAD') {
      body = await c.req.text()
      if (body) headers['Content-Type'] = c.req.header('content-type') ?? 'application/json'
    }

    if (!materializeBuilderPassphrase(headers, method, `${path}${url.search}`, body)) {
      console.warn(`[clob-proxy] refused invalid Builder authorization for ${method} ${path}`)
      return c.json({ error: 'Invalid Builder authorization' }, 401)
    }

    try {
      const res = await fetch(target, { method, headers, body })
      const text = await res.text()
      if (!res.ok) {
        console.warn(`[clob-proxy] ${method} ${path} -> ${res.status}`)
      }
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

  routes.all('/proxy/*', relayToClob)

  /**
   * Relayer proxy — `@polymarket/client`'s `SecureClient` calls
   * `relayer-v2.polymarket.com` directly (e.g. `GET /deployed` to check
   * whether a signer's deposit wallet already exists), not through this
   * app's `/clob` proxy. Confirmed on-device: this host times out on the
   * same networks `clob.polymarket.com` did, which is exactly why the CLOB
   * relay above exists — the new SDK just talks to a second Polymarket host
   * the old one never did.
   *
   * Same trust shape as `relayToClob`: upstream status passes through untouched,
   * auth values and transaction bodies are never logged, and the real Builder
   * passphrase is materialized only after the request HMAC is verified.
   * Path-agnostic for the same reason as the CLOB relay: enumerating
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

    if (!materializeBuilderPassphrase(headers, method, `${path}${url.search}`, body)) {
      console.warn(`[relayer-proxy] refused invalid Builder authorization for ${method} ${path}`)
      return c.json({ error: 'Invalid Builder authorization' }, 401)
    }

    try {
      const res = await fetch(target, { method, headers, body })
      const text = await res.text()
      // Status and path only. Request headers carry `POLY_BUILDER_*`
      // signature material and bodies carry transaction payloads, so neither
      // belongs in a log sink.
      if (!res.ok) console.warn(`[relayer-proxy] ${method} ${path} -> ${res.status}`)
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
