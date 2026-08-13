/**
 * Our seed slug -> the Tokens registry's canonical assetId.
 *
 * Why this exists: our seed invented its own slugs (`btc`, `nvda`,
 * `tesla-stock`) before we had API access. The live registry uses different
 * ids (`bitcoin`, `nvidia`, `tesla`). The snapshot job stores rows under THEIR
 * ids, so without this translation our lookups miss and every token falls
 * through to the venue icon tier — which is exactly what happened: 9 of 104
 * resolving from Tokens instead of 34, including BTC.
 *
 * Every entry below was verified against the live API on 2026-08-12 by
 * requesting `GET /v1/assets/<our slug>` and recording the returned
 * `asset.assetId`. Only assets that actually carry an `imageUrl` are listed —
 * a mapping to an iconless asset buys nothing and would shadow the venue icon
 * that does exist.
 *
 * NOT fuzzy-matched, and never to be. `GET /v1/assets/search?q=BONK` returns
 * SOL; `q=TRUMP` returns SOL; `q=GOLD` returns Goldman Sachs. A confidently
 * wrong logo is worse than a letter box. Adding an entry here is a one-line
 * change with a hand-verified source.
 *
 * Deliberate many-to-one groupings (the registry's canonical grouping at work):
 *   paxg, xau -> gold      both are gold; one icon is correct
 *   xag       -> silver
 *
 * NOT mapped, on purpose: `usdc` and `usdt`. The registry groups both under
 * `usd`, which is right for canonical grouping and wrong on a market row —
 * it gave USDC and USDT the same generic dollar icon (verified: byte-identical
 * files), so a SOL/USDC pool was indistinguishable from a SOL/USDT one. They
 * keep their own logos instead. The lesson generalises: this map is for
 * "different name for the same asset", never for "related assets a user still
 * has to tell apart".
 */
export const SEED_SLUG_TO_CANONICAL_ASSET_ID: Readonly<Record<string, string>> = {
  aapl: 'apple',
  amd: 'amd',
  amzn: 'amazon',
  asml: 'asml',
  bnb: 'bnb',
  btc: 'bitcoin',
  coin: 'coinbase',
  copper: 'copper',
  crcl: 'circle',
  eth: 'ethereum',
  gold: 'gold',
  googl: 'alphabet',
  hood: 'robinhood',
  hype: 'hyperliquid',
  intc: 'intel',
  meta: 'meta',
  mon: 'monad',
  msft: 'microsoft',
  mstr: 'microstrategy',
  mu: 'micron',
  nvda: 'nvidia',
  paxg: 'gold',
  pltr: 'palantir',
  silver: 'silver',
  sol: 'solana',
  sp500: 'sp500',
  spcx: 'spacex',
  sui: 'sui',
  trx: 'tron',
  uni: 'uniswap',
  xag: 'silver',
  xau: 'gold',
  // Our seed slug for Tesla is 'tesla-stock'; the registry's id is 'tesla'.
  // Verified: GET /v1/assets/tesla -> imageUrl logos/xstocks/TSLAx.png
  'tesla-stock': 'tesla',
}

/**
 * Translate one of our seed slugs to the registry's canonical assetId.
 * Returns null when we have no verified mapping — the caller must then fall
 * through to the next icon tier rather than guess.
 */
export function canonicalAssetIdFor(seedSlug: string): string | null {
  return SEED_SLUG_TO_CANONICAL_ASSET_ID[seedSlug.toLowerCase()] ?? null
}
