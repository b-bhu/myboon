import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { rpcEndpointSecrets } from './policy.js'
import { createRpcRateLimiter, createRpcRoutes, type RpcRoutesOptions } from './routes.js'

const endpoints = {
  solanaRpcUrl: 'https://helius.example/rpc?api-key=secret-key',
  solanaDevnetRpcUrl: 'https://devnet.example/rpc?api-key=dev-secret',
  polygonRpcUrl: 'https://polygon.example/rpc?key=polygon-secret',
}

function app(fetchImpl: typeof fetch, rateLimiter = createRpcRateLimiter(), options: Partial<RpcRoutesOptions> = {}) {
  return new Hono().route('/rpc', createRpcRoutes({ ...endpoints, fetchImpl, rateLimiter, ...options }))
}

test('RPC proxy forwards a fixed credentialed endpoint without client credentials', async () => {
  let requested = ''
  let upstreamHeaders: Headers | undefined
  const response = await app(async (input, init) => {
    requested = String(input)
    upstreamHeaders = new Headers(init?.headers)
    return Response.json({ jsonrpc: '2.0', id: 7, result: { value: 42 } })
  }).request('/rpc/solana', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer client-secret',
      'x-api-key': 'client-api-key',
      'x-myboon-session': 'fixture-session',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'getBalance', params: ['wallet'] }),
  })
  assert.equal(response.status, 200)
  assert.equal(requested, endpoints.solanaRpcUrl)
  assert.equal(upstreamHeaders?.get('authorization'), null)
  assert.equal(upstreamHeaders?.get('x-api-key'), null)
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 7, result: { value: 42 } })
})

test('RPC proxy preserves provider result and error codes while redacting endpoint credentials', async () => {
  const response = await app(async () => Response.json({
    jsonrpc: '2.0',
    id: 3,
    error: { code: -32010, message: `provider ${endpoints.solanaRpcUrl} rejected request` },
  })).request('/rpc/solana', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'getSlot' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    jsonrpc: '2.0',
    id: 3,
    error: { code: -32010, message: 'provider [redacted] rejected request' },
  })
})

test('RPC secret redaction covers Alchemy-style path credentials without redacting ordinary paths', () => {
  const endpoint = 'https://polygon-mainnet.g.alchemy.com/v2/path-secret%2Fencoded'
  const secrets = rpcEndpointSecrets(endpoint)
  assert.ok(secrets.includes('path-secret%2Fencoded'))
  assert.ok(secrets.includes('path-secret/encoded'))
  assert.deepEqual(rpcEndpointSecrets('https://rpc.example/rpc'), ['https://rpc.example/rpc'])
})

test('RPC proxy rejects signing/admin methods and malformed ids before upstream access', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return Response.json({})
  }
  const proxy = app(fetchImpl)
  const denied = await proxy.request('/rpc/solana', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'signTransaction', params: [] }),
  })
  const malformed = await proxy.request('/rpc/solana', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: {}, method: 'getSlot' }),
  })
  assert.equal(denied.status, 400)
  assert.equal(malformed.status, 400)
  assert.equal(calls, 0)
})

test('RPC rate limits charge each batch method and bound public abuse', async () => {
  let calls = 0
  const proxy = app(async () => {
    calls += 1
    return Response.json([{ jsonrpc: '2.0', id: 1, result: 1 }, { jsonrpc: '2.0', id: 2, result: 2 }])
  }, createRpcRateLimiter(2, 60_000))
  const body = JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'getSlot' },
    { jsonrpc: '2.0', id: 2, method: 'getBlockHeight' },
  ])
  const first = await proxy.request('/rpc/solana', { method: 'POST', headers: { 'x-forwarded-for': 'fixture' }, body })
  const second = await proxy.request('/rpc/solana', {
    method: 'POST',
    headers: { 'x-forwarded-for': 'forged-new-ip', 'x-myboon-session': 'fresh-caller-controlled-value' },
    body,
  })
  assert.equal(first.status, 200)
  assert.equal(second.status, 429)
  assert.equal(calls, 1)
})

test('RPC proxy routes devnet and Polygon to their server-owned endpoints', async () => {
  const requested: string[] = []
  const proxy = app(async (input) => {
    requested.push(String(input))
    return Response.json({ jsonrpc: '2.0', id: 1, result: true })
  })
  for (const path of ['/rpc/solana-devnet', '/rpc/polygon']) {
    const response = await proxy.request(path, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: path.endsWith('polygon') ? 'eth_chainId' : 'getSlot' }),
    })
    assert.equal(response.status, 200)
  }
  assert.deepEqual(requested, [endpoints.solanaDevnetRpcUrl, endpoints.polygonRpcUrl])
})

test('account creation rent estimates required by wallet and liquidity SDKs remain available', async () => {
  let forwarded: unknown
  const response = await app(async (_url, init) => {
    forwarded = JSON.parse(String(init?.body))
    return Response.json({ jsonrpc: '2.0', id: 15, result: 2039280 })
  }).request('/rpc/solana', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'getMinimumBalanceForRentExemption', params: [165, { commitment: 'confirmed' }] }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(forwarded, { jsonrpc: '2.0', id: 15, method: 'getMinimumBalanceForRentExemption', params: [165, { commitment: 'confirmed' }] })
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 15, result: 2039280 })
})

test('RPC proxy preserves explicitly submitted signed payloads exactly once', async () => {
  const received: unknown[] = []
  const proxy = app(async (_input, init) => {
    received.push(JSON.parse(String(init?.body)))
    return Response.json({ jsonrpc: '2.0', id: 1, result: 'fixture-signature' })
  })
  const solanaPayload = { jsonrpc: '2.0', id: 'sol', method: 'sendTransaction', params: ['signed-solana-bytes', { encoding: 'base64' }] }
  const polygonPayload = { jsonrpc: '2.0', id: 'evm', method: 'eth_sendRawTransaction', params: ['0xdeadbeef'] }
  assert.equal((await proxy.request('/rpc/solana', { method: 'POST', body: JSON.stringify(solanaPayload) })).status, 200)
  assert.equal((await proxy.request('/rpc/polygon', { method: 'POST', body: JSON.stringify(polygonPayload) })).status, 200)
  assert.deepEqual(received, [solanaPayload, polygonPayload])
})

test('RPC proxy returns bounded errors for failed, malformed and oversized upstream responses', async () => {
  const failed = app(async () => new Response('gateway exploded', { status: 503 }))
  const failedResponse = await failed.request('/rpc/solana', {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
  })
  assert.equal(failedResponse.status, 502)
  assert.equal((await failedResponse.json()).error.code, -32002)

  const oversized = app(async () => new Response('{"jsonrpc":"2.0","id":1,"result":"large"}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }), createRpcRateLimiter(), { maxResponseBytes: 4 })
  const oversizedResponse = await oversized.request('/rpc/solana', {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
  })
  assert.equal(oversizedResponse.status, 502)
  assert.equal((await oversizedResponse.json()).error.code, -32001)

  const malformed = app(async () => new Response('{"jsonrpc":', { status: 200 }))
  const malformedResponse = await malformed.request('/rpc/solana', {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
  })
  assert.equal(malformedResponse.status, 502)
  assert.equal((await malformedResponse.json()).error.code, -32002)
})

test('RPC proxy aborts an upstream timeout without exposing provider details', async () => {
  const proxy = app(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')))
  }), createRpcRateLimiter(), { timeoutMs: 1 })
  const response = await proxy.request('/rpc/solana', {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
  })
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error.code, -32001)
})
