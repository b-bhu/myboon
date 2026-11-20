/**
 * Shared types for the Hyperliquid market data the API serves (#691):
 * `StoryMarket` on `GET /stories` and `GET /stories/:storySlug`, and the
 * candles payload for `GET /market/hyperliquid/candles`.
 */

/** One Hyperliquid market linked to a story, priced from the 30 s API snapshot. */
export interface StoryMarket {
  /** Exact Hyperliquid name, e.g. `BTC`, `xyz:CL`. */
  symbol: string
  /** Chip text, e.g. `BTC`, `WTI`. */
  displaySymbol: string
  /** Long name, e.g. `Bitcoin`, `WTI crude oil`. */
  displayName: string
  /** Link rank, 1 = lead. */
  rank: 1 | 2 | 3
  /** Mark price; null when there is no price or the price snapshot is older than 15 minutes. */
  price: number | null
  /** 2-decimal percent move vs `prevDayPx`; null whenever price is null. */
  change24hPct: number | null
  /** ISO time of the price snapshot; null whenever price is null. */
  asOf: string | null
}

/**
 * One OHLCV candle, matching the app chart's `MarketCandle`
 * (`apps/hybrid-expo/features/charts/market-chart.types.ts`) with volume kept
 * required but nullable.
 */
export interface MarketCandle {
  timeMs: number
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

/** `GET /market/hyperliquid/candles` response. `candles` is oldest first. */
export interface HyperliquidCandlesResponse {
  symbol: string
  interval: string
  candles: MarketCandle[]
}
