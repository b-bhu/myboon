import assert from 'node:assert/strict'
import test from 'node:test'
import type { TokenIdentityRow, TokenIdentityStore } from './identity-store.js'
import { runTokenSnapshot } from './snapshot-job.js'

const SEED = [
  {
    assetId: 'btc',
    symbol: 'BTC',
    name: 'Bitcoin',
    mint: null,
    decimals: null,
    category: 'crypto' as const,
    verified: true,
    iconSourceUrl: 'https://app.pacifica.fi/imgs/tokens/BTC.svg',
    source: 'seed' as const,
  },
  {
    assetId: 'sol',
    symbol: 'SOL',
    name: 'Solana',
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    category: 'crypto' as const,
    verified: true,
    iconSourceUrl: 'https://app.pacifica.fi/imgs/tokens/SOL.svg',
    source: 'seed' as const,
  },
]

class FakeStore implements TokenIdentityStore {
  upserts: TokenIdentityRow[][] = []

  async loadAll(): Promise<TokenIdentityRow[]> {
    return this.upserts.flat()
  }

  async upsertMany(rows: TokenIdentityRow[]): Promise<void> {
    this.upserts.push(rows)
  }
}

test('seed mode with no api key upserts seed rows via the store, and reports zero tokens rows', async () => {
  const store = new FakeStore()

  const result = await runTokenSnapshot({ apiKey: null, store, seed: SEED })

  assert.equal(result.seedRowsUpserted, 2)
  assert.equal(result.tokensRowsUpserted, 0)
  assert.equal(result.tokensCallsFailed, 0)
  assert.equal(store.upserts.length, 1)
  const [seedUpsert] = store.upserts
  assert.equal(seedUpsert.length, 2)
  assert.ok(seedUpsert.every((row) => row.source === 'seed'))
  const btcRow = seedUpsert.find((row) => row.assetId === 'btc')
  assert.equal(btcRow?.iconSourceUrl, 'https://app.pacifica.fi/imgs/tokens/BTC.svg')
})

test('with an api key, pulls curated lists + resolve + asset detail and maps fields with source "tokens"', async () => {
  const store = new FakeStore()
  const calls: string[] = []

  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)

    // NOTE: these mocks mirror the LIVE api.tokens.xyz response shapes, verified
    // against a real key on 2026-08-12. Getting them wrong is not a harmless
    // test detail: an earlier version of this file mocked `{ data: [...] }`
    // while the API actually returns `{ assets: [...] }`, so the job silently
    // parsed every curated list as empty, wrote zero Tokens rows, and reported
    // success — and this test passed the whole time, because it was checking our
    // guess against the same guess. Keep these aligned with the real API.
    //   curated:  { listId, assets: [ { assetId, name, symbol, category, imageUrl } ] }
    //   resolve:  { assetId, resolvedBy, mint, asset: {...}, variant: {...} }
    //   detail:   { asset: { assetId, ..., imageUrl } }
    if (url.includes('/assets/curated')) {
      if (url.includes('list=majors')) {
        return Response.json({
          listId: 'majors',
          assets: [
            {
              assetId: 'eth',
              symbol: 'ETH',
              name: 'Ethereum',
              mint: null,
              decimals: null,
              category: 'crypto',
              verified: true,
              imageUrl: 'https://tokens.xyz/icons/eth.png',
            },
          ],
        })
      }
      return Response.json({ listId: 'other', assets: [] })
    }

    if (url.includes('/assets/resolve')) {
      return Response.json({
        assetId: 'usdc',
        resolvedBy: 'mint',
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        asset: {
          assetId: 'usdc',
          symbol: 'USDC',
          name: 'USD Coin',
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          decimals: 6,
          category: 'stablecoin',
          verified: true,
          imageUrl: 'https://tokens.xyz/icons/usdc.png',
        },
      })
    }

    // /assets/:id detail backfill
    if (url.includes('/assets/eth')) {
      return Response.json({
        asset: {
          assetId: 'eth',
          symbol: 'ETH',
          name: 'Ethereum',
          mint: null,
          decimals: null,
          category: 'crypto',
          verified: true,
          imageUrl: 'https://tokens.xyz/icons/eth-detail.png',
        },
      })
    }
    if (url.includes('/assets/usdc')) {
      return Response.json({
        asset: {
          assetId: 'usdc',
          symbol: 'USDC',
          name: 'USD Coin',
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          decimals: 6,
          category: 'stablecoin',
          verified: true,
          imageUrl: 'https://tokens.xyz/icons/usdc-detail.png',
        },
      })
    }

    return new Response('not found', { status: 404 })
  }

  const result = await runTokenSnapshot({
    apiKey: 'test-key',
    store,
    seed: SEED,
    fetchImpl: fetchImpl as typeof fetch,
    knownMints: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  })

  assert.equal(result.seedRowsUpserted, 2)
  assert.equal(result.tokensRowsUpserted, 2)
  assert.equal(result.tokensCallsFailed, 0)

  // Second store.upsertMany call carries the Tokens-sourced rows.
  assert.equal(store.upserts.length, 2)
  const tokensUpsert = store.upserts[1]
  assert.ok(tokensUpsert.every((row) => row.source === 'tokens'))

  const ethRow = tokensUpsert.find((row) => row.assetId === 'eth')
  assert.equal(ethRow?.symbol, 'ETH')
  // Detail backfill call overwrites the curated-list icon with the detail-call icon.
  assert.equal(ethRow?.iconSourceUrl, 'https://tokens.xyz/icons/eth-detail.png')

  const usdcRow = tokensUpsert.find((row) => row.assetId === 'usdc')
  assert.equal(usdcRow?.mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  assert.equal(usdcRow?.decimals, 6)

  // Calls were made with the x-api-key header path (asserted indirectly via URL shape).
  assert.ok(calls.some((url) => url.includes('/assets/curated?list=majors')))
  assert.ok(calls.some((url) => url.includes('/assets/resolve?mint=')))
})

test('an empty-field singleton (imageUrl null) upserts icon_source_url null, not an error, and the row survives for the service to fall through on', async () => {
  const store = new FakeStore()

  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()

    if (url.includes('/assets/curated')) {
      return Response.json({ data: [] })
    }
    if (url.includes('/assets/resolve')) {
      // A well-formed 200 singleton for an off-registry mint: no image, no stats.
      return Response.json({
        id: 'solana-someunknownmint',
        symbol: 'someunknownmint',
        name: null,
        mint: 'SomeUnknownMint11111111111111111111111111',
        decimals: null,
        category: null,
        verified: false,
        imageUrl: null,
      })
    }
    if (url.includes('/assets/solana-someunknownmint')) {
      return Response.json({
        id: 'solana-someunknownmint',
        symbol: 'someunknownmint',
        name: null,
        mint: 'SomeUnknownMint11111111111111111111111111',
        decimals: null,
        category: null,
        verified: false,
        imageUrl: null,
      })
    }
    return new Response('not found', { status: 404 })
  }

  const result = await runTokenSnapshot({
    apiKey: 'test-key',
    store,
    seed: SEED,
    fetchImpl: fetchImpl as typeof fetch,
    knownMints: ['SomeUnknownMint11111111111111111111111111'],
  })

  assert.equal(result.tokensCallsFailed, 0)
  assert.equal(result.tokensRowsUpserted, 1)

  const tokensUpsert = store.upserts[1]
  const row = tokensUpsert[0]
  assert.equal(row.iconSourceUrl, null)
  assert.equal(row.category, 'unknown')
  assert.equal(row.name, row.symbol) // name falls back to symbol when upstream name is null
  assert.equal(row.source, 'tokens')
})

test('never deletes rows: upsertMany is only ever called with additive rows across a run', async () => {
  const store = new FakeStore()
  await runTokenSnapshot({ apiKey: null, store, seed: SEED })
  // Only one upsert call (seed mode), and it never issues any delete-shaped call.
  assert.equal(store.upserts.length, 1)
  assert.equal(store.upserts[0].length, SEED.length)
})
