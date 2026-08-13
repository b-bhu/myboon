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
