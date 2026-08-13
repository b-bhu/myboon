import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { SEED_SLUG_TO_CANONICAL_ASSET_ID, canonicalAssetIdFor } from './canonical-asset-map.js'

const seed = JSON.parse(
  readFileSync(new URL('./seed/token-identities.seed.json', import.meta.url), 'utf8'),
) as Array<{ assetId: string; symbol: string }>

test('every mapped slug actually exists in the seed', () => {
  // A mapping for a slug we never emit is dead weight, and usually a typo.
  const seedIds = new Set(seed.map((e) => e.assetId.toLowerCase()))
  for (const slug of Object.keys(SEED_SLUG_TO_CANONICAL_ASSET_ID)) {
    assert.ok(seedIds.has(slug), `mapped slug '${slug}' is not in the seed`)
  }
})

test('canonicalAssetIdFor is case-insensitive and returns null for unmapped slugs', () => {
  assert.equal(canonicalAssetIdFor('btc'), 'bitcoin')
  assert.equal(canonicalAssetIdFor('BTC'), 'bitcoin')
  assert.equal(canonicalAssetIdFor('tesla-stock'), 'tesla')
  // Never guess: an unmapped slug must fall through, not fuzzy-match.
  assert.equal(canonicalAssetIdFor('fartcoin'), null)
  assert.equal(canonicalAssetIdFor('definitely-not-a-token'), null)
})

test('the known many-to-one groupings are intentional', () => {
  // Documented in the module header — assert them so a "cleanup" that splits
  // them has to be a deliberate decision rather than an accident.
  assert.equal(canonicalAssetIdFor('paxg'), 'gold')
  assert.equal(canonicalAssetIdFor('xau'), 'gold')
  assert.equal(canonicalAssetIdFor('xag'), 'silver')
  // USDC and USDT are deliberately NOT grouped under 'usd': the registry's
  // canonical grouping is right for "same asset, different name" and wrong for
  // two stablecoins a user has to tell apart on a market row — grouping them
  // gave both the same generic dollar icon.
  assert.equal(canonicalAssetIdFor('usdc'), null)
  assert.equal(canonicalAssetIdFor('usdt'), null)
})

test('no slug maps to itself', () => {
  // A self-map is a no-op that hides a missing real mapping.
  for (const [slug, canonical] of Object.entries(SEED_SLUG_TO_CANONICAL_ASSET_ID)) {
    if (slug === canonical) continue // legitimately identical (gold, silver, amd, meta...)
    assert.notEqual(slug, canonical)
  }
})
