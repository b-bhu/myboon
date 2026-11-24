import assert from 'node:assert/strict'
import test from 'node:test'

import { configureSpotBalances, createSpotBalances, fetchWalletBalances } from '../../spot/balances.js'

// The venue reads through the shared balances instance createApp installs
// (#831); install one here — the tests below fake globalThis.fetch, so the
// URL only needs to exist.
configureSpotBalances(createSpotBalances({ heliusRpcUrl: 'https://example.test/helius' }))

const { spotVenue } = await import('./spot.js')

// Each test uses its own wallet address so the module-level balances cache
// (keyed by wallet) cannot leak state between tests in this process.
const WALLET_MAPPED = '7iNJ7CLNT8UBPANxkkrsURjzaktbomCVa93N1sKcVo9C'
const WALLET_EMPTY = 'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1'
const WALLET_DOWN = 'EYj9xKw6ZszwpyNibHY7JD5o3QgTVrSdcBp1fMJhrR9o'

const SOL_MINT = 'So11111111111111111111111111111111111111112'

const AAA_MINT = 'AAA111111111111111111111111111111111111111'
const BBB_MINT = 'BBB111111111111111111111111111111111111111'
const CCC_MINT = 'CCC111111111111111111111111111111111111111'

// Two priced tokens, one real-but-unpriced holding, one NFT (excluded) and
// priced native SOL — the same upstream answer /spot/:wallet/balances maps.
function heliusResponse() {
  return {
    jsonrpc: '2.0',
    id: 'myboon-spot',
    result: {
      // 2 SOL at $150 → valueUsd 300 (total_price absent, computed in spot.ts).
      nativeBalance: { lamports: 2_000_000_000, price_per_sol: 150 },
      items: [
        {
          id: AAA_MINT,
          interface: 'FungibleToken',
          content: { metadata: { name: 'Token A', symbol: 'AAA' }, links: { image: 'https://img.test/aaa.png' } },
          token_info: { symbol: 'AAA', balance: 5, decimals: 0, price_info: { price_per_token: 2 } },
        },
        {
          id: BBB_MINT,
          interface: 'FungibleAsset',
          content: { metadata: { name: 'Token B', symbol: 'BBB' } },
          token_info: { symbol: 'BBB', balance: 750, decimals: 2, price_info: { total_price: 7.5 } },
        },
        {
          // A real holding Helius has no price for: listed with valueUsd null.
          id: CCC_MINT,
          interface: 'FungibleToken',
          content: { metadata: { name: 'Token C', symbol: 'CCC' }, links: { image: 'https://img.test/ccc.png' } },
          token_info: { symbol: 'CCC', balance: 10, decimals: 0 },
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

const context = (solana: string | null) => ({ solana, evm: null, signal: new AbortController().signal })

test('maps the /spot balances answer into the summary shape, tokens largest first', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json(heliusResponse())

  try {
    const slot = await spotVenue.fetch(context(WALLET_MAPPED))
    assert.equal(slot.status, 'ok')
    assert.equal(slot.error, undefined)
    assert.equal(slot.valueUsd, 317.5)
    assert.deepEqual(slot.summary, {
      tokenCount: 4,
      tokens: [
        { mint: SOL_MINT, symbol: 'SOL', iconUrl: null, valueUsd: 300 },
        { mint: AAA_MINT, symbol: 'AAA', iconUrl: 'https://img.test/aaa.png', valueUsd: 10 },
        { mint: BBB_MINT, symbol: 'BBB', iconUrl: null, valueUsd: 7.5 },
        { mint: CCC_MINT, symbol: 'CCC', iconUrl: 'https://img.test/ccc.png', valueUsd: null },
      ],
    })

    // Done means (#742): the tokens equal /spot/:wallet/balances for the
    // same address — shared `fetchWalletBalances`, `icon` mapped onto
    // `iconUrl` field by field. The repeat call reads the balance cache,
    // so no second upstream call is made.
    const balances = await fetchWalletBalances(WALLET_MAPPED)
    assert.deepEqual(
      slot.summary!.tokens,
      balances.tokens.map((token) => ({
        mint: token.mint,
        symbol: token.symbol,
        iconUrl: token.icon,
        valueUsd: token.valueUsd,
      })),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an empty wallet answers ok with valueUsd 0 and no tokens', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({
    jsonrpc: '2.0',
    id: 'myboon-spot',
    result: { nativeBalance: { lamports: 0 }, items: [] },
  })

  try {
    const slot = await spotVenue.fetch(context(WALLET_EMPTY))
    // #742 Done means: an empty wallet is a real $0 with status 'ok',
    // never unavailable.
    assert.deepEqual(slot, { status: 'ok', valueUsd: 0, summary: { tokenCount: 0, tokens: [] } })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an upstream failure propagates: the summary service maps it to this app being unavailable', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('boom', { status: 500 })

  try {
    // The venue reuses fetchWalletBalances; its thrown Helius error is
    // what the service's Promise.allSettled turns into the spot app's
    // `unavailable` slot (service behaviour covered in ../summary.test.ts).
    await assert.rejects(
      spotVenue.fetch(context(WALLET_DOWN)),
      /Helius getAssetsByOwner failed \(500\)/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a summary request without a solana address answers not_connected and calls no upstream', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('spot venue must not call Helius without a solana address')
  }

  try {
    const slot = await spotVenue.fetch(context(null))
    // Same no-account state Polymarket serves for a missing `evm` (#725).
    assert.deepEqual(slot, { status: 'not_connected', valueUsd: null, summary: null })
  } finally {
    globalThis.fetch = originalFetch
  }
})
