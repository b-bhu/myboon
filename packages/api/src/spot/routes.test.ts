import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'

import { createSpotRoutes } from './routes.js'

// createSpotRoutes takes the Helius URL as an option (#831) — pass a dummy
// value so requests reach the (mocked) fetch call instead of short-circuiting
// on "not configured".
const spotRoutes = createSpotRoutes({ heliusRpcUrl: 'https://example.test/helius' })

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// Each test uses its own wallet address so the module-level balances cache
// (keyed by wallet) can't leak state between tests in this process.
const WALLET_ALL = '7iNJ7CLNT8UBPANxkkrsURjzaktbomCVa93N1sKcVo9C'
const WALLET_SINGLE = '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6'
const WALLET_MISSING = 'CoaxzEh8p5YyGLcj36Eo3cUThVJxeKCs7qvLAGDYwBcz'
const WALLET_UPSTREAM_DOWN = 'EYj9xKw6ZszwpyNibHY7JD5o3QgTVrSdcBp1fMJhrR9o'
const WALLET_EMPTY = 'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1'
const WALLET_UNPRICED = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'

function heliusResponse() {
  return {
    jsonrpc: '2.0',
    id: 'myboon-spot',
    result: {
      nativeBalance: {
        lamports: 500_000_000,
        price_per_sol: 100,
        total_price: 50,
      },
      items: [
        {
          id: MINT,
          interface: 'FungibleToken',
          content: { metadata: { name: 'USD Coin', symbol: 'USDC' }, links: { image: 'https://example.com/usdc.png' } },
          token_info: {
            symbol: 'USDC',
            balance: 100_500_000,
            decimals: 6,
            price_info: { price_per_token: 1, total_price: 100.5, currency: 'USDC' },
          },
        },
        {
          id: 'NonFungibleMintAddress1111111111111111111',
          interface: 'V1_NFT',
          content: { metadata: { name: 'Some NFT' } },
        },
      ],
    },
  }
}

test('GET /:wallet/balances returns all token balances priced in USD, largest first', async () => {
  const app = new Hono()
  app.route('/spot', spotRoutes)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json(heliusResponse())

  try {
    const response = await app.request(`/spot/${WALLET_ALL}/balances`)
    assert.equal(response.status, 200)
    const body = await response.json() as { wallet: string; totalValueUsd: number; tokens: Array<{ mint: string; valueUsd: number }> }
    assert.equal(body.wallet, WALLET_ALL)
    assert.equal(body.totalValueUsd, 150.5)
    assert.equal(body.tokens.length, 2)
    // USDC (100.5) sorts before SOL (50) — largest value first, NFT excluded.
    assert.equal(body.tokens[0].mint, MINT)
    assert.equal(body.tokens[0].valueUsd, 100.5)
    assert.equal(body.tokens[1].valueUsd, 50)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GET /:wallet/balances/:mint returns a single token balance', async () => {
  const app = new Hono()
  app.route('/spot', spotRoutes)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json(heliusResponse())

  try {
    const response = await app.request(`/spot/${WALLET_SINGLE}/balances/${MINT}`)
    assert.equal(response.status, 200)
    const body = await response.json() as { mint: string; valueUsd: number }
    assert.equal(body.mint, MINT)
    assert.equal(body.valueUsd, 100.5)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GET /:wallet/balances/:mint returns 404 when the wallet does not hold that mint', async () => {
  const app = new Hono()
  app.route('/spot', spotRoutes)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json(heliusResponse())
  const unheldMint = 'So11111111111111111111111111111111111111113'

  try {
    const response = await app.request(`/spot/${WALLET_MISSING}/balances/${unheldMint}`)
    assert.equal(response.status, 404)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects invalid wallet and mint addresses with 400', async () => {
  const app = new Hono()
  app.route('/spot', spotRoutes)

  assert.equal((await app.request('/spot/not-an-address/balances')).status, 400)
  assert.equal((await app.request(`/spot/${WALLET_ALL}/balances/not-an-address`)).status, 400)
})

test('GET /:wallet/balances returns totalValueUsd: 0 (not null) for a wallet holding nothing', async () => {
  const app = new Hono()
  app.route('/spot', spotRoutes)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({
    jsonrpc: '2.0',
    id: 'myboon-spot',
    result: { nativeBalance: { lamports: 0 }, items: [] },
  })

  try {
    const response = await app.request(`/spot/${WALLET_EMPTY}/balances`)
    assert.equal(response.status, 200)
    const body = await response.json() as { totalValueUsd: number | null; tokens: unknown[] }
    // A genuinely empty wallet must report a real $0, never null — null is
    // reserved for an actual upstream/parse failure (see the 502 test below),
    // so a client can't tell "nothing here" apart from "something broke."
    assert.equal(body.totalValueUsd, 0)
    assert.equal(body.tokens.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GET /:wallet/balances returns totalValueUsd: 0 for a wallet holding only unpriced tokens', async () => {
  const app = new Hono()
  app.route('/spot', spotRoutes)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({
    jsonrpc: '2.0',
    id: 'myboon-spot',
    result: {
      nativeBalance: { lamports: 0 },
      items: [
        {
          id: 'UnpricedMintAddress111111111111111111111',
          interface: 'FungibleToken',
          content: { metadata: { name: 'No Price Token', symbol: 'NPT' } },
          // No price_info at all — Helius has no known price for this token.
          token_info: { symbol: 'NPT', balance: 1_000_000, decimals: 6 },
        },
      ],
    },
  })

  try {
    const response = await app.request(`/spot/${WALLET_UNPRICED}/balances`)
    assert.equal(response.status, 200)
    const body = await response.json() as { totalValueUsd: number | null; tokens: Array<{ valueUsd: number | null }> }
    // Holding a real token that just has no known price is also a real $0
    // total, not an "unavailable" state — the token itself still shows up
    // in `tokens` with valueUsd: null, but the aggregate total is honest 0.
    assert.equal(body.totalValueUsd, 0)
    assert.equal(body.tokens.length, 1)
    assert.equal(body.tokens[0].valueUsd, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('returns 502 when the upstream Helius call fails', async () => {
  const app = new Hono()
  app.route('/spot', spotRoutes)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('boom', { status: 500 })

  try {
    const response = await app.request(`/spot/${WALLET_UPSTREAM_DOWN}/balances`)
    assert.equal(response.status, 502)
  } finally {
    globalThis.fetch = originalFetch
  }
})
