import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { Hono } from 'hono'

const PORT = 39519
const BUILDER_CODE = '0xpublic-builder-code'
let upstream: Server
let app: Hono
let received: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }

process.env.POLYMARKET_BRIDGE_URL = `http://127.0.0.1:${PORT}`
process.env.POLYMARKET_BUILDER_CODE = BUILDER_CODE

before(async () => {
  upstream = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk.toString() })
    request.on('end', () => {
      received = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      if (request.url === '/supported-assets') {
        response.end(JSON.stringify({ supportedAssets: [] }))
      } else if (request.url === '/quote') {
        response.end(JSON.stringify({ quoteId: 'quote-1' }))
      } else {
        response.end(JSON.stringify({ address: { evm: '0xabc', svm: 'sol' } }))
      }
    })
  })
  await new Promise<void>((resolve) => upstream.listen(PORT, resolve))
  const { registerFundRoutes } = await import('./funds.js')
  const routes = new Hono()
  registerFundRoutes(routes)
  app = new Hono().route('/clob', routes)
})

after(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

describe('stateless Bridge relays', () => {
  test('relays live supported assets with public Builder attribution', async () => {
    const response = await app.request('/clob/bridge/supported-assets')
    assert.equal(response.status, 200)
    assert.equal(received.method, 'GET')
    assert.equal(received.url, '/supported-assets')
    assert.equal(received.headers['x-builder-code'], BUILDER_CODE)
  })

  test('validates and transparently relays quote fields', async () => {
    const quote = {
      fromAmountBaseUnit: '5000000',
      fromChainId: '137',
      fromTokenAddress: '0xfrom',
      recipientAddress: 'recipient',
      toChainId: '1151111081099710',
      toTokenAddress: 'to-token',
    }
    const response = await app.request('/clob/bridge/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(quote),
    })
    assert.equal(response.status, 200)
    assert.equal(received.method, 'POST')
    assert.equal(received.url, '/quote')
    assert.deepEqual(JSON.parse(received.body), quote)
    assert.equal(received.headers['x-builder-code'], BUILDER_CODE)

    const invalid = await app.request('/clob/bridge/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromChainId: '137' }),
    })
    assert.equal(invalid.status, 400)
  })

  test('attaches Builder attribution to deposit and withdrawal creation', async () => {
    const deposit = await app.request('/clob/deposit/0xwallet')
    assert.equal(deposit.status, 200)
    assert.equal(received.url, '/deposit')
    assert.equal(received.headers['x-builder-code'], BUILDER_CODE)

    const withdrawal = await app.request('/clob/bridge/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: '0xwallet',
        toChainId: '1151111081099710',
        toTokenAddress: 'usdc',
        recipientAddr: 'solana',
      }),
    })
    assert.equal(withdrawal.status, 200)
    assert.equal(received.url, '/withdraw')
    assert.equal(received.headers['x-builder-code'], BUILDER_CODE)
  })
})
