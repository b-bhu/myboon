// curated.ts — hand-picked Polymarket config for Predict routes.
// Geopolitics uses curated market slugs. Sports uses supported league keys.
//
// Last refreshed: 2026-04-02
// Source: Polymarket, sorted by weekly volume, filtered active (end time in the future)

// Geopolitics slugs disabled — most expired. Will refresh when we add back.
// export const CURATED_GEOPOLITICS_SLUGS = [
//   'us-forces-enter-iran-by-april-30-899',
//   'will-the-iranian-regime-fall-by-april-30',
//   'us-x-iran-ceasefire-by-april-15-182-528-637',
//   'us-x-iran-ceasefire-by-april-7-278',
//   'us-forces-enter-iran-by-december-31-573-642-385-371-179-425-262',
//   'netanyahu-out-by-april-30',
//   'will-trump-visit-china-by-april-30',
//   'will-china-invade-taiwan-before-2027',
// ] as const
// V2 preprod test markets (have liquidity on clob-v2.polymarket.com)
export const CURATED_GEOPOLITICS_SLUGS: readonly string[] = [
  'us-iran-nuclear-deal-before-2027',
  'will-avengers-doomsday-be-the-top-grossing-movie-of-2026',
  'will-wicked-for-good-be-the-top-grossing-movie-of-2026',
]

export const SUPPORTED_SPORTS = ['epl', 'ucl', 'ipl', 'fifwc'] as const
export type SupportedSport = (typeof SUPPORTED_SPORTS)[number]

export const CURATED_SLUGS = {
  geopolitics: [...CURATED_GEOPOLITICS_SLUGS],
  sports: [...SUPPORTED_SPORTS],
}

/**
 * Derive a display category from market tags.
 */
export function deriveCategory(tags: string[]): string {
  const t = new Set(tags.map((s) => s.toLowerCase()))
  if (t.has('crypto') || t.has('bitcoin') || t.has('ethereum') || t.has('solana')) return 'crypto'
  if (t.has('politics') || t.has('geopolitics')) return 'politics'
  if (t.has('sports') || t.has('epl') || t.has('cricket') || t.has('soccer') || t.has('fifa-world-cup')) return 'sports'
  if (t.has('ai') || t.has('tech')) return 'tech'
  if (t.has('economics') || t.has('fed') || t.has('macro')) return 'macro'
  return tags[0]?.toLowerCase() ?? 'other'
}

/**
 * Derive category from slug + question text (for Gamma markets that lack tags).
 * Used by the Polymarket featured-market selection for pinned binary markets.
 *
 * Categories returned: crypto | politics | sports | tech | macro | entertainment | other
 *
 * To add a new category or keyword: add a regex line below.
 * Order matters — first match wins (e.g. "crypto" is checked before "tech").
 */
export function deriveCategoryFromText(slug: string, question: string): string {
  const text = `${slug} ${question}`.toLowerCase()

  if (/bitcoin|btc|ethereum|eth\b|solana|sol\b|crypto|token|defi|nft|binance|coinbase|hyperliquid|stablecoin|altcoin|memecoin|meme coin|doge|xrp|cardano|polkadot|avalanche|polygon|matic|aave|uniswap/.test(text)) return 'crypto'
  if (/trump|biden|president|congress|senate|election|vote|democrat|republican|geopolit|iran|china|nato|ukraine|russia|war|ceasefire|regime|invade|invasion|netanyahu|tariff/.test(text)) return 'politics'
  if (/epl|ipl|cricket|nba|nfl|nhl|mlb|football|soccer|fifa|world cup|tennis|f1|formula|championship|league|match|premier|ucl|la liga|serie a|bundesliga|sport/.test(text)) return 'sports'
  if (/\bai\b|openai|chatgpt|google|apple|microsoft|meta|nvidia|tech|artificial intelligence/.test(text)) return 'tech'
  if (/fed\b|interest rate|inflation|gdp|recession|unemployment|cpi|fomc|treasury|macro|economic/.test(text)) return 'macro'
  if (/oscar|emmy|grammy|movie|film|box office|grossing|avenger|wicked|entertainment/.test(text)) return 'entertainment'

  return 'other'
}
