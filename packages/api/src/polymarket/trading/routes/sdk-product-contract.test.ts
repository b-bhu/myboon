import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import {
  createPublicClient,
  forkEnvironmentConfig,
  remoteBuilderSigning,
} from '@polymarket/client'
import { Wallet } from 'ethers'

const PORT = 39523
const API_PORT = 39524
const wallet = Wallet.createRandom()
const secret = Buffer.from('sdk-contract-builder-secret').toString('base64')
let upstream: Server
let apiServer: Server
let app: Hono
let upstreamCalls = 0

process.env.CLOB_HOST = `http://127.0.0.1:${PORT}`
process.env.POLYMARKET_RELAYER_URL = `http://127.0.0.1:${PORT}`
process.env.POLYMARKET_BUILDER_API_KEY = 'sdk-contract-key'
process.env.POLYMARKET_BUILDER_SECRET = secret
process.env.POLYMARKET_BUILDER_PASSPHRASE = 'sdk-contract-passphrase'

function proofMessage(timestamp: number): string {
  return [
    'myboon:predict:builder-auth',
    `address:${wallet.address.toLowerCase()}`,
    `timestamp:${timestamp}`,
  ].join('\n')
}

async function proofHeaders(): Promise<Record<string, string>> {
  const timestamp = Date.now()
  return {
    'Content-Type': 'application/json',
    'X-Predict-Address': wallet.address,
    'X-Predict-Timestamp': `${timestamp}`,
    'X-Predict-Signature': await wallet.signMessage(proofMessage(timestamp)),
    'X-Predict-Request-ID': `sdk-contract-${timestamp}`,
  }
}

const require = createRequire(import.meta.url)
const sdkDistDirectory = dirname(require.resolve('@polymarket/client'))
const sdkSource = readdirSync(sdkDistDirectory)
  .filter((file) => file.endsWith('.js'))
  .map((file) => readFileSync(join(sdkDistDirectory, file), 'utf8'))
  .join('\n')

before(async () => {
  upstream = createServer((request, response) => {
    upstreamCalls++
    assert.equal(request.headers['poly_builder_passphrase'], 'sdk-contract-passphrase')
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => upstream.listen(PORT, resolve))

  const [{ registerBuilderSignRoutes }, { registerProxyRoutes }] = await Promise.all([
    import('./builder-sign.js'),
    import('./proxies.js'),
  ])
  const routes = new Hono()
  registerBuilderSignRoutes(routes)
  registerProxyRoutes(routes)
  app = new Hono().route('/clob', routes)
  await new Promise<void>((resolve) => {
    apiServer = serve({ fetch: app.fetch, port: API_PORT }, () => resolve())
  })
})

after(async () => {
  await Promise.all([
    new Promise<void>((resolve) => upstream.close(() => resolve())),
    new Promise<void>((resolve) => apiServer.close(() => resolve())),
  ])
})

interface ProductOperation {
  name: string
  proxy: 'proxy' | 'relayer-proxy'
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  sdkPathFragment: string
  body?: string
}

const PRODUCT_OPERATIONS: ProductOperation[] = [
  { name: 'deposit wallet deployment check', proxy: 'relayer-proxy', method: 'GET', path: `/deployed?address=${wallet.address}`, sdkPathFragment: '/deployed' },
  { name: 'gasless transaction params', proxy: 'relayer-proxy', method: 'GET', path: `/v1/account/transactions/params?address=${wallet.address}&type=WALLET`, sdkPathFragment: '/v1/account/transactions/params' },
  { name: 'gasless transaction settlement', proxy: 'relayer-proxy', method: 'GET', path: '/v1/account/transactions/transaction-id', sdkPathFragment: '/v1/account/transactions/' },
  { name: 'gasless submit', proxy: 'relayer-proxy', method: 'POST', path: '/submit', sdkPathFragment: '/submit', body: JSON.stringify({ from: wallet.address }) },
  { name: 'create API key', proxy: 'proxy', method: 'POST', path: '/auth/api-key', sdkPathFragment: '/auth/api-key', body: '{}' },
  { name: 'derive returning API key', proxy: 'proxy', method: 'GET', path: '/auth/derive-api-key', sdkPathFragment: '/auth/derive-api-key' },
  { name: 'validate restored API key', proxy: 'proxy', method: 'GET', path: '/auth/api-keys', sdkPathFragment: '/auth/api-keys' },
  { name: 'revoke API key', proxy: 'proxy', method: 'DELETE', path: '/auth/api-key', sdkPathFragment: '/auth/api-key' },
  { name: 'market metadata', proxy: 'proxy', method: 'GET', path: '/markets-by-token/token-id', sdkPathFragment: '/markets-by-token/' },
  { name: 'CLOB market metadata', proxy: 'proxy', method: 'GET', path: '/clob-markets/token-id', sdkPathFragment: '/clob-markets/' },
  { name: 'Builder fee lookup', proxy: 'proxy', method: 'GET', path: `/fees/builder-fees/0x${'a'.repeat(64)}`, sdkPathFragment: '/fees/builder-fees/' },
  { name: 'collateral balance', proxy: 'proxy', method: 'GET', path: '/balance-allowance?asset_type=COLLATERAL', sdkPathFragment: '/balance-allowance' },
  { name: 'open-order reconciliation', proxy: 'proxy', method: 'GET', path: '/data/orders', sdkPathFragment: '/data/orders' },
  { name: 'order detail reconciliation', proxy: 'proxy', method: 'GET', path: '/data/order/order-id', sdkPathFragment: '/data/order/' },
  { name: 'recent-trade reconciliation', proxy: 'proxy', method: 'GET', path: '/data/trades', sdkPathFragment: '/data/trades' },
  { name: 'place order', proxy: 'proxy', method: 'POST', path: '/order', sdkPathFragment: '/order', body: '{}' },
  { name: 'cancel order', proxy: 'proxy', method: 'DELETE', path: '/order', sdkPathFragment: '/order', body: '{}' },
]

test('mobile SDK product contract passes remote signer policy and both fixed-host proxies', async () => {
  const authorization = remoteBuilderSigning({
    url: `http://127.0.0.1:${API_PORT}/clob/builder/sign`,
    headers: proofHeaders,
  })
  const client = createPublicClient({
    apiKey: authorization,
    environment: forkEnvironmentConfig({ name: 'sdk-contract' }),
  }) as unknown as {
    resolveClobHeaders(request: { method: ProductOperation['method']; path: string; body?: string }): Promise<HeadersInit>
    resolveRelayerHeaders(request: { method: ProductOperation['method']; path: string; body?: string }): Promise<HeadersInit>
  }

  for (const operation of PRODUCT_OPERATIONS) {
    assert.ok(
      sdkSource.includes(operation.sdkPathFragment),
      `${operation.name}: installed SDK no longer contains ${operation.sdkPathFragment}; update the product contract and policy`,
    )
    const requestUrl = new URL(operation.path, 'https://sdk-contract.invalid')
    const request = {
      method: operation.method,
      // Match ServiceClient exactly: URLSearchParams are sent separately and
      // are not part of the pathname passed to Builder authorization.
      path: requestUrl.pathname,
      ...(operation.body === undefined ? {} : { body: operation.body }),
    }
    const builderHeaders = await (operation.proxy === 'proxy'
      ? client.resolveClobHeaders(request)
      : client.resolveRelayerHeaders(request))
    const proxyResponse = await app.request(`/clob/${operation.proxy}${operation.path}`, {
      method: operation.method,
      headers: {
        ...Object.fromEntries(new Headers(builderHeaders)),
        ...(operation.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: operation.body,
    })
    assert.equal(
      proxyResponse.status,
      200,
      `${operation.name}: ${operation.proxy} rejected ${operation.method} ${operation.path}`,
    )
  }
  assert.equal(upstreamCalls, PRODUCT_OPERATIONS.length)
})
