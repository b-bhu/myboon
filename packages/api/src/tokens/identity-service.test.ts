import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRef } from './identity-service.js'
import seedEntries from './seed/token-identities.seed.json' with { type: 'json' }

const USDT_ENTRY = (seedEntries as Array<{ assetId: string; mint: string | null }>).find((e) => e.assetId === 'usdt')

test('resolve hit for a seeded mint ref returns the full identity, iconUrl starts /tokens/icon/, source static', () => {
  const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const identity = resolveRef(`mint:${usdcMint}`)

  assert.equal(identity.key, `mint:${usdcMint}`)
  assert.equal(identity.assetId, 'usdc')
  assert.equal(identity.symbol, 'USDC')
  assert.equal(identity.name, 'USD Coin')
  assert.equal(identity.mint, usdcMint)
  assert.equal(identity.category, 'stablecoin')
  assert.ok(identity.iconUrl?.startsWith('/tokens/icon/'))
  assert.equal(identity.iconUrl, '/tokens/icon/usdc')
  // No snapshot table row is loaded in this test process, so the hit comes
  // from the checked-in seed file — which reports as 'static' per the
  // frozen TokenIdentitySource union (checked-in seed data is static data).
  assert.equal(identity.source, 'static')
})

test('miss for a garbage ref returns assetId null, correct fallbackLetter, source static, key echoed verbatim', () => {
  const garbage = 'mint:NotARealMintAddressAtAll1111111111111'
  const identity = resolveRef(garbage)

  assert.equal(identity.key, garbage)
  assert.equal(identity.assetId, null)
  assert.equal(identity.source, 'static')
  assert.equal(identity.iconUrl, null)
  assert.equal(identity.fallbackLetter, identity.symbol.charAt(0).toUpperCase())
})

test('an unresolved ref reports category "unknown", never a guessed one', () => {
  // categoryForSymbol() defaults unrecognized symbols to 'crypto', which is
  // right for a listed market but wrong for a ref we resolved nothing for —
  // that would assert a category we do not know. Guard against a regression
  // that wires the optimistic helper into the static fallback path.
  for (const ref of ['mint:NotARealMintAddressAtAll1111111111111', 'garbage-ref-no-prefix', 'perp:ZZZZNOTLISTED']) {
    const identity = resolveRef(ref)
    assert.equal(identity.assetId, null, `${ref} should not resolve`)
    assert.equal(identity.category, 'unknown', `${ref} should not claim a category`)
  }
})

test('a resolved token keeps its real category rather than falling back to unknown', () => {
  assert.equal(resolveRef('perp:TSLA').category, 'equity')
  assert.equal(resolveRef('perp:GOLD').category, 'commodity')
  assert.equal(resolveRef('perp:BTC').category, 'crypto')
})

test('perp:BTC-PERP and perp:BTC resolve to the same assetId', () => {
  const withSuffix = resolveRef('perp:BTC-PERP')
  const withoutSuffix = resolveRef('perp:BTC')

  assert.equal(withSuffix.assetId, 'btc')
  assert.equal(withoutSuffix.assetId, 'btc')
  assert.equal(withSuffix.assetId, withoutSuffix.assetId)
})

test('perp:kPEPE-PERP resolves to pepe\'s assetId with fallbackLetter K', () => {
  const identity = resolveRef('perp:kPEPE-PERP')

  assert.equal(identity.assetId, 'pepe')
  assert.equal(identity.fallbackLetter, 'K')
  assert.equal(identity.source, 'static')
  assert.equal(identity.iconUrl, '/tokens/icon/pepe')
})

test('a perp symbol outside the frozen union falls through to the static fallback, not fuzzy search', () => {
  const identity = resolveRef('perp:NOTASYMBOL-PERP')

  assert.equal(identity.assetId, null)
  assert.equal(identity.source, 'static')
  assert.equal(identity.symbol, 'NOTASYMBOL')
  assert.equal(identity.fallbackLetter, 'N')
})

test('USDT seed mint is Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', () => {
  assert.equal(USDT_ENTRY?.mint, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')

  const identity = resolveRef('mint:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')
  assert.equal(identity.assetId, 'usdt')
  assert.equal(identity.symbol, 'USDT')
  assert.equal(identity.source, 'static')
})

test('perp markets always resolve with decimals null', () => {
  const identity = resolveRef('perp:ETH')
  assert.equal(identity.decimals, null)
})

test('an unparseable ref (no mint:/perp: prefix) still echoes the key verbatim in the static fallback', () => {
  const identity = resolveRef('garbage-ref-no-prefix')
  assert.equal(identity.key, 'garbage-ref-no-prefix')
  assert.equal(identity.assetId, null)
  assert.equal(identity.source, 'static')
})
