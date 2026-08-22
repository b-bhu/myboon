import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  createMemorySwapExecutionStore,
  createSwapRoutes,
  type SwapIdentityService,
} from './swap.js'
import { createSqliteSwapExecutionStore } from './swap/store.js'
import type { TokenIdentity } from './tokens/types.js'

const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
const WALLET = '7iNJ7CLNT8UBPANxkkrsURjzaktbomCVa93N1sKcVo9C'

function identityFor(mint: string): TokenIdentity {
  return {
    key: `mint:${mint}`,
    assetId: mint === SOL ? 'sol' : null,
    symbol: mint === SOL ? 'SOL' : 'USDC',
    name: mint === SOL ? 'Solana' : 'USD Coin',
    iconUrl: `/tokens/icon/mint/${mint}`,
    decimals: mint === SOL ? 9 : 6,
    mint,
    verified: true,
    category: mint === USDC ? 'stablecoin' : 'crypto',
    fallbackLetter: mint === SOL ? 'S' : 'U',
    source: 'venue',
  }
}

const identity: SwapIdentityService = {
  resolveRef(ref) {
    const mint = ref.slice('mint:'.length)
    return identityFor(mint)
  },
  async warmMintIdentities() {},
}

function buildApp(config: Parameters<typeof createSwapRoutes>[0]) {
  const app = new Hono()
  app.route('/swap', createSwapRoutes({ identity, ...config }))
  return app
}

function providerToken(mint: string, symbol = 'USDC') {
  return {
    id: mint,
    symbol,
    name: symbol === 'SOL' ? 'Solana' : 'USD Coin',
    usdPrice: 1.25,
    isVerified: true,
    organicScoreLabel: 'high',
    audit: { isSus: true },
    firstPool: { id: WALLET },
    mcap: 10_000,
    liquidity: 20_000,
    stats5m: { priceChange: 1.1 },
    stats1h: { priceChange: 2.2 },
    stats6h: { priceChange: -3.3 },
    stats24h: { priceChange: 4.4, buyVolume: 100, sellVolume: 50 },
    updatedAt: '2026-08-18T00:00:00.000Z',
  }
}

test('GET /swap/tokens normalizes toptrending rows, identity, warnings and momentum', async () => {
  const urls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return Response.json([providerToken(USDC)])
  }) as typeof fetch
  const response = await buildApp({ fetchImpl }).request('/swap/tokens?limit=1')
  assert.equal(response.status, 200)
  assert.equal(urls[0], 'https://api.jup.ag/tokens/v2/toptrending/1h?limit=1')
  const body = await response.json() as { ranking: string; partial: boolean; items: any[] }
  assert.equal(body.ranking, 'toptrending_1h')
  assert.equal(body.partial, false)
  assert.equal(body.items[0].identity.iconUrl, `/tokens/icon/mint/${USDC}`)
  assert.equal(body.items[0].momentumPct.h1, 2.2)
  assert.equal(body.items[0].momentumPct.h6, -3.3)
  assert.equal(body.items[0].market.volume24hUsd, 150)
  assert.equal(body.items[0].warnings.suspicious, true)
})

test('default discovery applies liquidity, organic, spam, and pool-route eligibility', async () => {
  const eligible = providerToken(USDC)
  const lowLiquidity = { ...providerToken(SOL, 'SOL'), liquidity: 9_999 }
  const lowOrganic = { ...providerToken(JUP, 'JUP'), organicScoreLabel: 'low' }
  const spam = { ...providerToken(SOL, 'SOL'), tags: ['spam'] }
  const noPool = { ...providerToken(JUP, 'JUP'), firstPool: null }
  const fetchImpl = (async () => Response.json([eligible, lowLiquidity, lowOrganic, spam, noPool])) as typeof fetch
  const response = await buildApp({ fetchImpl }).request('/swap/tokens?limit=5')
  assert.equal(response.status, 200)
  const body = await response.json() as { items: { identity: { mint: string } }[]; partial: boolean }
  assert.deepEqual(body.items.map((item) => item.identity.mint), [USDC])
  assert.equal(body.partial, false)
})

test('search is normalized, capped, cached, and exact mint ranks first', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return Response.json([providerToken(SOL, 'SOL'), providerToken(USDC)])
  }) as typeof fetch
  const app = buildApp({ fetchImpl })
  const first = await app.request(`/swap/tokens/search?query=${USDC}`)
  const second = await app.request(`/swap/tokens/search?query=${USDC}`)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(calls, 1)
  const body = await first.json() as { query: string; items: any[]; partial: boolean }
  assert.equal(body.query, USDC)
  assert.equal(body.items[0].identity.mint, USDC)
  assert.equal(body.partial, false)
})

test('prices preserve request order and represent omitted provider prices as null', async () => {
  const urls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return Response.json({ [USDC]: { usdPrice: 1, blockId: 9 } })
  }) as typeof fetch
  const response = await buildApp({ fetchImpl }).request(`/swap/prices?ids=${SOL},${USDC}`)
  assert.equal(response.status, 200)
  assert.match(urls[0], /price\/v3\?ids=So111.*%2CEPj/)
  assert.deepEqual(await response.json().then((body: any) => body.prices), [
    { mint: SOL, usdPrice: null, blockId: null },
    { mint: USDC, usdPrice: 1, blockId: 9 },
  ])
})

test('auto orders use Jupiter defaults while explicit slippage opts into manual mode', async () => {
  const urls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const url = String(input)
    if (url.includes('/swap/v2/order')) {
      const taker = new URL(url).searchParams.get('taker')
      return Response.json({
        requestId: 'provider-request',
        inputMint: SOL,
        outputMint: USDC,
        inAmount: '100',
        outAmount: '200',
        otherAmountThreshold: '190',
        priceImpact: -0.2,
        feeBps: 5,
        feeMint: USDC,
        platformFee: { amount: '1', feeBps: 5, feeMint: USDC },
        router: 'metis',
        routePlan: [{ swapInfo: { label: 'Raydium' }, bps: 10_000 }],
        prioritizationFeeLamports: '900000',
        signatureFeeLamports: '5000',
        slippageBps: 25,
        expireAt: '2026-08-18T00:01:00.000Z',
        ...(taker ? { taker, transaction: 'AA==', lastValidBlockHeight: 123 } : { transaction: null }),
      })
    }
    return Response.json([])
  }) as typeof fetch
  const app = buildApp({ fetchImpl, priorityFeeMaxLamports: '1000000' })
  const quote = await app.request('/swap/order', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputMint: SOL, outputMint: USDC, amountAtomic: '100', slippageBps: 25 }),
  })
  assert.equal(quote.status, 200)
  const quoteBody = await quote.json() as any
  assert.equal(quoteBody.kind, 'quote')
  assert.equal(quoteBody.transaction, null)
  assert.equal(quoteBody.fees.priorityFeeLamports, '900000')
  assert.equal(quoteBody.fees.providerFeeBps, 5)
  assert.equal(quoteBody.fees.providerFeeAtomic, '1')
  assert.equal(quoteBody.route[0].percent, 100)
  assert.equal(quoteBody.priceImpactPct, -0.2)
  assert.equal(quoteBody.expiresAt, '2026-08-18T00:01:00.000Z')
  const signable = await app.request('/swap/order', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputMint: SOL, outputMint: USDC, amountAtomic: '100', taker: WALLET }),
  })
  assert.equal(signable.status, 200)
  const signableBody = await signable.json() as any
  assert.equal(signableBody.kind, 'signable')
  assert.equal(signableBody.requestId, 'provider-request')
  assert.equal(signableBody.lastValidBlockHeight, '123')
  assert.ok(urls.every((url) => url.includes('/swap/v2/order')))
  const quoteUrl = new URL(urls[0])
  const signableUrl = new URL(urls[1])
  assert.equal(quoteUrl.searchParams.get('slippageBps'), '25')
  assert.equal(signableUrl.searchParams.has('slippageBps'), false)
  assert.equal(signableUrl.searchParams.has('priorityFeeLamports'), false)
  assert.equal(signableUrl.searchParams.has('broadcastFeeType'), false)
})

test('rejects a provider-selected priority fee above the server safety ceiling', async () => {
  const fetchImpl = (async () => Response.json({
    inputMint: SOL,
    outputMint: USDC,
    inAmount: '100',
    outAmount: '200',
    otherAmountThreshold: '190',
    prioritizationFeeLamports: '1000001',
    slippageBps: 25,
    transaction: null,
  })) as typeof fetch
  const response = await buildApp({ fetchImpl, priorityFeeMaxLamports: '1000000' }).request('/swap/order', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputMint: SOL, outputMint: USDC, amountAtomic: '100' }),
  })
  assert.equal(response.status, 422)
  assert.equal((await response.json() as any).error.code, 'NETWORK_FEE_TOO_HIGH')
})

test('identical quote previews share an upstream request and short cache', async () => {
  let calls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fetchImpl = (async () => {
    calls += 1
    await gate
    return Response.json({
      inputMint: SOL,
      outputMint: USDC,
      inAmount: '100',
      outAmount: '200',
      otherAmountThreshold: '190',
      prioritizationFeeLamports: '0',
      slippageBps: 25,
      transaction: null,
    })
  }) as typeof fetch
  const app = buildApp({ fetchImpl })
  const request = () => app.request('/swap/order', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputMint: SOL, outputMint: USDC, amountAtomic: '100' }),
  })
  const first = request()
  const second = request()
  release?.()
  assert.equal((await first).status, 200)
  assert.equal((await second).status, 200)
  assert.equal((await request()).status, 200)
  assert.equal(calls, 1)
})

test('signable provider refusal maps stable codes and status', async () => {
  const fetchImpl = (async () => Response.json({ router: 'jupiterz', errorCode: 2, transaction: null })) as typeof fetch
  const response = await buildApp({ fetchImpl }).request('/swap/order', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputMint: SOL, outputMint: USDC, amountAtomic: '100', taker: WALLET }),
  })
  assert.equal(response.status, 422)
  assert.deepEqual((await response.json() as any).error.code, 'TOKEN_ACCOUNT_REQUIRED')
})

test('order rejects a zero minimum received instead of creating an unbounded trade', async () => {
  const fetchImpl = (async () => Response.json({
    inputMint: SOL,
    outputMint: USDC,
    inAmount: '100',
    outAmount: '200',
    otherAmountThreshold: '0',
    slippageBps: 25,
    transaction: null,
  })) as typeof fetch
  const response = await buildApp({ fetchImpl }).request('/swap/order', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputMint: SOL, outputMint: USDC, amountAtomic: '100' }),
  })
  assert.equal(response.status, 502)
  assert.equal((await response.json() as any).error.code, 'ORDER_PROVIDER_INVALID')
})

test('execute confirms once and idempotently returns the persisted outcome', async () => {
  let calls = 0
  let executeProviderBody: Record<string, unknown> | null = null
  const store = createMemorySwapExecutionStore()
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1
    if (String(input).includes('/swap/v2/order')) {
      return Response.json({ requestId: 'provider-request', inputMint: SOL, outputMint: USDC, taker: WALLET, transaction: 'AA==', lastValidBlockHeight: '99', inAmount: '100', outAmount: '200', otherAmountThreshold: '190', slippageBps: 25 })
    }
    assert.equal(store.getExecution('provider-request')?.outcome, 'unknown')
    executeProviderBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({ status: 'Success', code: 0, signature: 'sig', slot: 42, inputAmountResult: '100', outputAmountResult: '200' })
  }) as typeof fetch
  const app = buildApp({ fetchImpl, store })
  await app.request('/swap/order', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputMint: SOL, outputMint: USDC, amountAtomic: '100', taker: WALLET }),
  })
  const execute = () => app.request('/swap/execute', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signedTransaction: 'AA==', requestId: 'provider-request', lastValidBlockHeight: '99' }),
  })
  const first = await execute()
  const second = await execute()
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(calls, 2) // one order request, one execute request; second execute is local
  assert.deepEqual(executeProviderBody, { signedTransaction: 'AA==', requestId: 'provider-request', lastValidBlockHeight: '99' })
  assert.equal((await second.json() as any).outcome, 'confirmed')
})

test('unknown execute outcome is persisted and never auto-retried', async () => {
  let executeCalls = 0
  const store = createMemorySwapExecutionStore()
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/swap/v2/execute')) {
      executeCalls += 1
      return Response.json({ code: -1001, status: 'Failed', errorMessage: 'timeout' })
    }
    return Response.json({ requestId: 'unknown-request', inputMint: SOL, outputMint: USDC, taker: WALLET, inAmount: '1', outAmount: '2', otherAmountThreshold: '1', transaction: 'AA==', lastValidBlockHeight: '99', slippageBps: 25 })
  }) as typeof fetch
  const app = buildApp({ fetchImpl, store })
  await app.request('/swap/order', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputMint: SOL, outputMint: USDC, amountAtomic: '1', taker: WALLET }),
  })
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signedTransaction: 'AA==', requestId: 'unknown-request' }) }
  assert.equal((await app.request('/swap/execute', request)).status, 202)
  assert.equal((await app.request('/swap/execute', request)).status, 202)
  assert.equal(executeCalls, 1)
})

test('invalid order and execute inputs are correction-safe 400s', async () => {
  const app = buildApp({ fetchImpl: (async () => Response.json({})) as typeof fetch })
  const invalidOrder = await app.request('/swap/order', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputMint: 'bad', outputMint: USDC, amountAtomic: '1.2' }),
  })
  assert.equal(invalidOrder.status, 400)
  const invalidExecute = await app.request('/swap/execute', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signedTransaction: 'not base64', requestId: 'x' }),
  })
  assert.equal(invalidExecute.status, 400)
  assert.equal((await invalidExecute.json() as any).error.requestId !== null, true)
})

test('kill switch pauses only new signable orders and rate budgets are separate', async () => {
  let calls = 0
  const fetchImpl = (async () => { calls += 1; return Response.json({ inputMint: SOL, outputMint: USDC, transaction: null, inAmount: '1', outAmount: '1', otherAmountThreshold: '1', slippageBps: 25 }) }) as typeof fetch
  const app = buildApp({ fetchImpl, tradingEnabled: false, rateLimits: { quote: 1, signable: 1, discovery: 1, execute: 1, windowMs: 60_000 } })
  const signable = await app.request('/swap/order', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-myboon-session': 'kill-test' },
    body: JSON.stringify({ inputMint: SOL, outputMint: USDC, amountAtomic: '1', taker: WALLET }),
  })
  assert.equal(signable.status, 503)
  const quote = await app.request('/swap/order', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-myboon-session': 'kill-test' },
    body: JSON.stringify({ inputMint: SOL, outputMint: USDC, amountAtomic: '1' }),
  })
  assert.equal(quote.status, 200)
  assert.equal(calls, 1)
})

test('Jupiter key is server-only and upstream failures use the stable envelope', async () => {
  let seenKey: string | undefined
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenKey = (init?.headers as Record<string, string>)['x-api-key']
    throw new Error('network down')
  }) as typeof fetch
  const response = await buildApp({ fetchImpl, jupApiKey: 'secret-key' }).request(`/swap/prices?ids=${SOL}`)
  assert.equal(response.status, 502)
  assert.equal(seenKey, 'secret-key')
  const error = await response.json() as any
  assert.equal(error.error.retryable, true)
  assert.equal(typeof error.error.code, 'string')
})

test('SQLite execution metadata survives a store reopen without persisting transaction bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'myboon-swap-'))
  const path = join(dir, 'swap.sqlite')
  try {
    const first = createSqliteSwapExecutionStore(path)
    first.saveOrder({ requestId: 'durable', inputMint: SOL, outputMint: USDC, taker: WALLET, lastValidBlockHeight: '123', createdAt: '2026-08-18T00:00:00.000Z' })
    first.saveExecution({ requestId: 'durable', outcome: 'unknown', signature: 'sig', slot: null, code: -1001, message: 'unknown', totalInputAmountAtomic: null, totalOutputAmountAtomic: null, inputAmountResultAtomic: null, outputAmountResultAtomic: null, updatedAt: '2026-08-18T00:00:01.000Z' })
    const reopened = createSqliteSwapExecutionStore(path)
    assert.equal(reopened.getOrder('durable')?.lastValidBlockHeight, '123')
    assert.equal(reopened.getExecution('durable')?.outcome, 'unknown')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
