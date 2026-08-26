import type { Hono } from 'hono'
import { BRIDGE_URL, POLYMARKET_BUILDER_CODE } from '../contracts.js'

function bridgeHeaders(withBody = false): Record<string, string> {
  return {
    Accept: 'application/json',
    ...(withBody ? { 'Content-Type': 'application/json' } : {}),
    ...(POLYMARKET_BUILDER_CODE ? { 'X-Builder-Code': POLYMARKET_BUILDER_CODE } : {}),
  }
}

async function relayBridgeResponse(response: Response): Promise<Response> {
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' },
  })
}

export function registerFundRoutes(routes: Hono) {
  routes.get('/bridge/supported-assets', async (c) => {
    try {
      return relayBridgeResponse(await fetch(`${BRIDGE_URL}/supported-assets`, {
        headers: bridgeHeaders(),
      }))
    } catch {
      return c.json({ error: 'Bridge supported-assets proxy failed' }, 502)
    }
  })

  routes.post('/bridge/quote', async (c) => {
    let rawBody: string
    try {
      rawBody = await c.req.text()
      const parsed = JSON.parse(rawBody) as Record<string, unknown>
      const required = [
        'fromAmountBaseUnit',
        'fromChainId',
        'fromTokenAddress',
        'recipientAddress',
        'toChainId',
        'toTokenAddress',
      ]
      if (required.some((field) => typeof parsed[field] !== 'string' || !parsed[field])) {
        return c.json({ error: 'Missing bridge quote fields' }, 400)
      }
    } catch {
      return c.json({ error: 'Invalid bridge quote request' }, 400)
    }
    try {
      return relayBridgeResponse(await fetch(`${BRIDGE_URL}/quote`, {
        method: 'POST',
        headers: bridgeHeaders(true),
        body: rawBody,
      }))
    } catch {
      return c.json({ error: 'Bridge quote proxy failed' }, 502)
    }
  })

  routes.get('/deposit/:walletAddress', async (c) => {
    const walletAddress = c.req.param('walletAddress')
    try {
      const response = await fetch(`${BRIDGE_URL}/deposit`, {
        method: 'POST',
        headers: bridgeHeaders(true),
        body: JSON.stringify({ address: walletAddress }),
      })
      if (!response.ok) console.warn(`[bridge-proxy] POST /deposit -> ${response.status}`)
      return relayBridgeResponse(response)
    } catch (error) {
      return c.json({ error: 'Bridge deposit proxy failed' }, 502)
    }
  })

  routes.get('/deposit-status/:depositAddress', async (c) => {
    const depositAddress = c.req.param('depositAddress')
    try {
      const response = await fetch(`${BRIDGE_URL}/status/${encodeURIComponent(depositAddress)}`, {
        headers: bridgeHeaders(),
      })
      if (!response.ok) console.warn(`[bridge-proxy] GET /status/:address -> ${response.status}`)
      return relayBridgeResponse(response)
    } catch (error) {
      return c.json({ error: 'Bridge status proxy failed' }, 502)
    }
  })

  routes.post('/bridge/withdraw', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid bridge request' }, 400)
    }
    const { address, toChainId, toTokenAddress, recipientAddr } = body
    if (
      typeof address !== 'string'
      || typeof toChainId !== 'string'
      || typeof toTokenAddress !== 'string'
      || typeof recipientAddr !== 'string'
    ) {
      return c.json({ error: 'Missing bridge withdrawal fields' }, 400)
    }
    try {
      const response = await fetch(`${BRIDGE_URL}/withdraw`, {
        method: 'POST',
        headers: bridgeHeaders(true),
        body: JSON.stringify({ address, toChainId, toTokenAddress, recipientAddr }),
      })
      if (!response.ok) console.warn(`[bridge-proxy] POST /withdraw -> ${response.status}`)
      return relayBridgeResponse(response)
    } catch (error) {
      return c.json({ error: 'Bridge withdrawal proxy failed' }, 502)
    }
  })
}
