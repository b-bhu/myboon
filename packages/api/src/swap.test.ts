import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { createSwapRoutes } from './swap.js'

function buildApp(config: Parameters<typeof createSwapRoutes>[0]) {
  const app = new Hono()
  app.route('/swap', createSwapRoutes(config))
  return app
}

test('GET /swap/tokens/search forwards query param to Jupiter tokens/v2/search', async () => {
  const seenUrls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    seenUrls.push(String(input))
    return Response.json([{ id: 'mint1', symbol: 'FOO', name: 'Foo' }])
  }) as typeof fetch

  const app = buildApp({ fetchImpl })
  const response = await app.request('/swap/tokens/search?query=foo')
  assert.equal(response.status, 200)
  assert.equal(seenUrls.length, 1)
  assert.equal(seenUrls[0], 'https://api.jup.ag/tokens/v2/search?query=foo')
  const body = await response.json()
  assert.deepEqual(body, [{ id: 'mint1', symbol: 'FOO', name: 'Foo' }])
})

test('GET /swap/prices forwards ids param to Jupiter price/v3', async () => {
  const seenUrls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    seenUrls.push(String(input))
    return Response.json({ mint1: { usdPrice: 1.23 } })
  }) as typeof fetch

  const app = buildApp({ fetchImpl })
  const response = await app.request('/swap/prices?ids=mint1,mint2')
  assert.equal(response.status, 200)
  assert.equal(seenUrls[0], 'https://api.jup.ag/price/v3?ids=mint1%2Cmint2')
})

test('GET /swap/quote forwards inputMint/outputMint/amount/slippageBps to Jupiter swap/v1/quote', async () => {
  const seenUrls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    seenUrls.push(String(input))
    return Response.json({ inAmount: '1000000', outAmount: '2000000', priceImpactPct: '0.01' })
  }) as typeof fetch

  const app = buildApp({ fetchImpl })
  const response = await app.request('/swap/quote?inputMint=mintA&outputMint=mintB&amount=1000000&slippageBps=50')
  assert.equal(response.status, 200)
  assert.equal(
    seenUrls[0],
    'https://api.jup.ag/swap/v1/quote?inputMint=mintA&outputMint=mintB&amount=1000000&slippageBps=50',
  )
})

test('injects x-api-key only when jupApiKey is configured', async () => {
  const seenHeaders: Array<Record<string, string>> = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenHeaders.push({ ...(init?.headers as Record<string, string> ?? {}) })
    return Response.json([])
  }) as typeof fetch

  const withKeyApp = buildApp({ fetchImpl, jupApiKey: 'secret-key' })
  await withKeyApp.request('/swap/tokens/search?query=x')
  assert.equal(seenHeaders[0]['x-api-key'], 'secret-key')

  const withoutKeyApp = buildApp({ fetchImpl })
  await withoutKeyApp.request('/swap/tokens/search?query=x')
  assert.equal(seenHeaders[1]['x-api-key'], undefined)
})

test('returns 502 on upstream failure', async () => {
  const fetchImpl = (async () => {
    throw new Error('network down')
  }) as typeof fetch

  const app = buildApp({ fetchImpl })
  const response = await app.request('/swap/quote?inputMint=a&outputMint=b&amount=1&slippageBps=50')
  assert.equal(response.status, 502)
  const body = await response.json() as { error: string }
  assert.ok(body.error)
})
