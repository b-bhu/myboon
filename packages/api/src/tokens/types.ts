// Token identity types. TokenIdentity is frozen per the PRD
// (docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md)
// — the client is building against this shape, do not change field names or
// types without updating the PRD and the client together.
//
// source is frozen at exactly 'snapshot' | 'venue' | 'helius' | 'static' —
// it exists for production observability, not to enumerate every internal
// resolution layer. The three-layer resolution this package implements maps
// onto it as follows:
//   - a hit against a snapshot table row (public.token_identities, written
//     by the nightly job)        -> 'snapshot'
//   - a hit against the checked-in seed JSON with no table row loaded
//     -> 'static' (it is checked-in static data — that is what 'static'
//     means; do not widen this union to add a 'seed' value)
//   - a computed fallback with no data at all (symbol from the ref,
//     fallbackLetter, iconUrl null) -> 'static'
// If "seed file" needs to be told apart from "no data at all" for debugging,
// do it with a separate non-contract field or a log line — never by
// widening this type.
export type TokenIdentitySource = 'snapshot' | 'venue' | 'helius' | 'static'

export interface TokenIdentity {
  key: string // echo the caller's ref back verbatim
  assetId: string | null // canonical id; null when unresolved
  symbol: string // always present
  name: string // falls back to symbol
  iconUrl: string | null // ALWAYS our origin, never a third-party host
  decimals: number | null // null for perp markets — they have none
  mint: string | null
  verified: boolean
  category: 'crypto' | 'stablecoin' | 'equity' | 'commodity' | 'unknown'
  fallbackLetter: string // computed server-side so every client agrees
  source: TokenIdentitySource
}

// --- Token ref grammar -------------------------------------------------
//
// A ref identifies a token either by SPL mint or by venue perp symbol:
//   mint:<base58>
//   perp:<symbol>       (accepted with or without a trailing -PERP suffix, case preserved)

export type TokenRef =
  | { kind: 'mint'; mint: string; raw: string }
  | { kind: 'perp'; symbol: string; raw: string }
  | { kind: 'unknown'; raw: string }

const MINT_PREFIX = 'mint:'
const PERP_PREFIX = 'perp:'

/** Parse a token ref string per the ref grammar. Never throws. */
export function parseTokenRef(ref: string): TokenRef {
  const raw = ref
  if (ref.startsWith(MINT_PREFIX)) {
    const mint = ref.slice(MINT_PREFIX.length).trim()
    if (mint.length > 0) return { kind: 'mint', mint, raw }
    return { kind: 'unknown', raw }
  }
  if (ref.startsWith(PERP_PREFIX)) {
    const symbol = ref.slice(PERP_PREFIX.length).trim()
    if (symbol.length > 0) return { kind: 'perp', symbol, raw }
    return { kind: 'unknown', raw }
  }
  return { kind: 'unknown', raw }
}

// --- Fallback letter -----------------------------------------------------

/**
 * First alphanumeric character of the display symbol, uppercased.
 * kPEPE -> K, 2Z -> 2. Computed server-side so every client agrees.
 */
export function fallbackLetter(displaySymbol: string): string {
  const match = displaySymbol.match(/[A-Za-z0-9]/)
  return match ? match[0].toUpperCase() : '?'
}

// --- Category mapping ------------------------------------------------------
//
// The perp symbol union this maps over is frozen (see perp-symbol-map.ts).
// Do not add members here without re-verifying against the live venue lists.

const COMMODITY_SYMBOLS = new Set([
  'XAU', 'GOLD', 'XAG', 'SILVER', 'COPPER', 'NATGAS', 'CL', 'WTIOIL',
  'PLATINUM', 'PAXG', 'URNM',
])

const EQUITY_SYMBOLS = new Set([
  'TSLA', 'NVDA', 'AAPL', 'AMZN', 'META', 'MSFT', 'GOOGL', 'COIN', 'HOOD',
  'MSTR', 'PLTR', 'AMD', 'INTC', 'MU', 'QCOM', 'ARM', 'ASML', 'AMAT', 'NBIS',
  'CRWV', 'SNDK', 'BP', 'CRCL', 'SPCX',
])

const STABLECOIN_SYMBOLS = new Set(['USDC', 'USDT', 'USD'])

const FOREX_INDEX_SYMBOLS = new Set(['EURUSD', 'USDJPY', 'SP500'])

/**
 * Map a venue symbol (perp ticker or spot token symbol) to a TokenIdentity
 * category. Falls back to 'crypto' for anything not explicitly a metal,
 * energy commodity, equity, stablecoin, or forex/index symbol — matching the
 * PRD's frozen category rules.
 */
export function categoryForSymbol(symbol: string): TokenIdentity['category'] {
  const upper = symbol.toUpperCase()
  if (COMMODITY_SYMBOLS.has(upper)) return 'commodity'
  if (EQUITY_SYMBOLS.has(upper)) return 'equity'
  if (STABLECOIN_SYMBOLS.has(upper)) return 'stablecoin'
  if (FOREX_INDEX_SYMBOLS.has(upper)) return 'unknown'
  return 'crypto'
}

// --- tokens.xyz news feed ----------------------------------------------
//
// Wire contract for `news-feed.ts`. These are OUR shapes, not the upstream's:
// the upstream field names (`title`, `posted_at`, `source_name`, `feed_source`,
// `related_coin_ids`) appear only inside news-feed.ts, so a rename on their
// side is a one-file change here rather than a sweep through the collectors.
//
// Articles and posts are separate types on purpose — see the news-feed.ts
// header. An article is third-party reporting with an outlet; a post is one
// account's timeline. Code that handles both should branch on `kind` rather
// than treat them as one loose shape.

/** A published press article, sourced from CoinGecko's news aggregation. */
export interface TokensNewsArticle {
  kind: 'article'
  title: string
  url: string
  /** ISO 8601, normalized. null when the upstream value was missing/unparseable. */
  publishedAt: string | null
  /** Publishing outlet, e.g. 'FXStreet', 'PANews (EN)'. */
  outlet: string | null
  author: string | null
  imageUrl: string | null
  /**
   * UNTRUSTED. CoinGecko's own coin tagging, passed through verbatim and
   * demonstrably noisy: a 2026-08-13 story about the MSCI China Index carried
   * ['2026-token', 'composite', 'micro', 'test-4', 'test-3'], and a CPI story
   * carried ['grok-2', '4', 'reserve-3', 'u', ...] alongside a correct
   * 'bitcoin'. It behaves like naive substring matching against a coin-id list,
   * so common English words map to junk ids.
   *
   * Usable as a weak prior for narrowing work. NEVER usable as entity truth —
   * writing these straight into the entity graph would poison it.
   */
  relatedCoinIds: string[]
}

/** A post from the @tokens account on X. One account's timeline, not a search. */
export interface TokensNewsPost {
  kind: 'post'
  /** Full post body. The upstream puts this in its `title` field. */
  text: string
  url: string
  /** ISO 8601, normalized. null when the upstream value was missing/unparseable. */
  postedAt: string | null
  /** Display handle, e.g. '@tokens'. */
  handle: string | null
  imageUrl: string | null
  /** UNTRUSTED — see TokensNewsArticle.relatedCoinIds. Usually empty for posts. */
  relatedCoinIds: string[]
}

/**
 * Upstream response metadata, kept because it is the only way to tell an
 * empty feed apart from a filter that matched nothing: `xCandidates: 0` with
 * `mode: 'token'` means the term filter excluded everything, which is a
 * different situation from the upstream having nothing to serve.
 */
export interface TokensNewsFeedMeta {
  /** 'token' when any token filter was sent, else 'global'. */
  mode: 'global' | 'token'
  /** The term list the upstream actually matched on, after its own dedupe. */
  terms: string[]
  /** The limit the upstream applied, after its own clamping. */
  limit: number
  coingeckoCandidates: number
  xCandidates: number
}

export interface TokensNewsFeedResult<TItem> {
  items: TItem[]
  meta: TokensNewsFeedMeta
}

/**
 * Every token filter here lands in one deduped term list upstream, and sending
 * any of them switches the response to token mode. `coinId` is the only one
 * that filters the article half at the source; the others filter the post half
 * on their end.
 */
export interface TokensNewsFetchOptions {
  /** 1..50. Values outside are clamped, not rejected. Defaults to 10. */
  limit?: number
  /** CoinGecko coin id, e.g. 'bitcoin'. */
  coinId?: string
  /** Ticker, e.g. 'BTC'. */
  symbol?: string
  /** Display name, e.g. 'Bitcoin'. */
  name?: string
  /** Canonical asset id. */
  assetId?: string
  /** Extra keywords; sent comma-joined. */
  terms?: string[]
  /** Defaults to process.env.TOKENS_API_KEY. */
  apiKey?: string
  /** Injection point for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}
