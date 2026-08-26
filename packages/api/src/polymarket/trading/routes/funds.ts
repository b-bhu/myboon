import type { Hono } from 'hono'

const BRIDGE_HOST = 'https://bridge.polymarket.com'

async function relayBridgeResponse(response: Response): Promise<Response> {
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json' },
  })
}

export function registerFundRoutes(routes: Hono) {
  routes.get('/deposit/:walletAddress', async (c) => {
    const walletAddress = c.req.param('walletAddress')
    try {
      const response = await fetch(`${BRIDGE_HOST}/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: walletAddress }),
      })
      if (!response.ok) console.warn(`[bridge-proxy] POST /deposit -> ${response.status}`)
      return relayBridgeResponse(response)
    } catch (error) {
      return c.json({ error: 'Bridge deposit proxy failed', detail: error instanceof Error ? error.message : String(error) }, 502)
    }
  })

  routes.get('/deposit-status/:depositAddress', async (c) => {
    const depositAddress = c.req.param('depositAddress')
    try {
      const response = await fetch(`${BRIDGE_HOST}/status/${encodeURIComponent(depositAddress)}`)
      if (!response.ok) console.warn(`[bridge-proxy] GET /status/:address -> ${response.status}`)
      return relayBridgeResponse(response)
    } catch (error) {
      return c.json({ error: 'Bridge status proxy failed', detail: error instanceof Error ? error.message : String(error) }, 502)
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
      const response = await fetch(`${BRIDGE_HOST}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, toChainId, toTokenAddress, recipientAddr }),
      })
      if (!response.ok) console.warn(`[bridge-proxy] POST /withdraw -> ${response.status}`)
      return relayBridgeResponse(response)
    } catch (error) {
      return c.json({ error: 'Bridge withdrawal proxy failed', detail: error instanceof Error ? error.message : String(error) }, 502)
    }
  })
}
