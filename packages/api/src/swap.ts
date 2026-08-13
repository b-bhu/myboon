import { Hono } from 'hono'

// Server-side proxy to Jupiter, replacing direct client calls from
// apps/hybrid-expo/features/swap/swap.api.ts. The Jupiter key must stay
// server-side for the same reason spot.ts keeps the Helius key server-side
// (see spot.ts:3-7): `EXPO_PUBLIC_*` env vars are inlined into the shipped
// JS bundle at build time, so a client-side key is extractable from any
// release build. Jupiter works keyless at lower rate limits, so the key is
// injected only when configured, not required.

const JUP_API_BASE = process.env.JUP_API_BASE || 'https://api.jup.ag'
const REQUEST_TIMEOUT_MS = 10_000

export interface CreateSwapRoutesConfig {
  jupApiKey?: string
  fetchImpl?: typeof fetch
}

function jupiterHeaders(jupApiKey?: string): Record<string, string> {
  return jupApiKey ? { 'x-api-key': jupApiKey } : {}
}

async function proxyGet(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const body = await res.text()
  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
  })
}

export function createSwapRoutes(config: CreateSwapRoutesConfig): Hono {
  const routes = new Hono()
  const fetchImpl = config.fetchImpl ?? globalThis.fetch
  const headers = jupiterHeaders(config.jupApiKey)

  // GET /swap/tokens/search?query= -> GET https://api.jup.ag/tokens/v2/search?query=
  routes.get('/tokens/search', async (c) => {
    const query = c.req.query('query') ?? ''
    try {
      const url = `${JUP_API_BASE}/tokens/v2/search?query=${encodeURIComponent(query)}`
      return await proxyGet(fetchImpl, url, headers)
    } catch (err) {
      console.error('[api] Jupiter token search unavailable:', err instanceof Error ? err.message : err)
      return c.json({ error: 'Token search unavailable' }, 502)
    }
  })

  // GET /swap/prices?ids= -> GET https://api.jup.ag/price/v3?ids=
  routes.get('/prices', async (c) => {
    const ids = c.req.query('ids') ?? ''
    try {
      const url = `${JUP_API_BASE}/price/v3?ids=${encodeURIComponent(ids)}`
      return await proxyGet(fetchImpl, url, headers)
    } catch (err) {
      console.error('[api] Jupiter price lookup unavailable:', err instanceof Error ? err.message : err)
      return c.json({ error: 'Price lookup unavailable' }, 502)
    }
  })

  // GET /swap/quote?inputMint=&outputMint=&amount=&slippageBps= -> GET https://api.jup.ag/swap/v1/quote?...
  routes.get('/quote', async (c) => {
    const inputMint = c.req.query('inputMint') ?? ''
    const outputMint = c.req.query('outputMint') ?? ''
    const amount = c.req.query('amount') ?? ''
    const slippageBps = c.req.query('slippageBps') ?? ''
    try {
      const url = `${JUP_API_BASE}/swap/v1/quote`
        + `?inputMint=${encodeURIComponent(inputMint)}`
        + `&outputMint=${encodeURIComponent(outputMint)}`
        + `&amount=${encodeURIComponent(amount)}`
        + `&slippageBps=${encodeURIComponent(slippageBps)}`
      return await proxyGet(fetchImpl, url, headers)
    } catch (err) {
      console.error('[api] Jupiter quote unavailable:', err instanceof Error ? err.message : err)
      return c.json({ error: 'Quote unavailable' }, 502)
    }
  })

  return routes
}
