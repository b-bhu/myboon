/**
 * Shared types for `GET /calendar/history` (#703): an entity's last (up to 3)
 * saved releases before a date, each with the 24h move of every Hyperliquid
 * market linked to that entity (Feed calendar "Last 3 times", part 3).
 */

/** One Hyperliquid market linked to the entity, lead first. */
export interface CalendarHistoryMarket {
  /** Exact Hyperliquid name, e.g. `BTC`, `xyz:CL`. */
  symbol: string
  /** Chip text, e.g. `BTC`, `WTI`. */
  displaySymbol: string
  /** Long name, e.g. `Bitcoin`, `WTI crude oil`. */
  displayName: string
  /** Link rank, 1 = lead. */
  rank: 1 | 2 | 3
}

/** The 24h after-print move of one linked market for one release. */
export interface CalendarHistoryMove {
  /** Exact Hyperliquid name, matches the entry in `markets`. */
  symbol: string
  /**
   * Percent change vs the market close just before the print, 2 decimals.
   * Null when there is no exact release time, the window has not finished, a
   * candle is missing, or the Hyperliquid read failed.
   */
  changePct: number | null
}

/** One saved past release of the entity's series (`atlas.event_releases`). */
export interface CalendarHistoryRelease {
  /** Release date, YYYY-MM-DD. */
  date: string
  /** Exact release time (ISO 8601) or null when only the date is known. */
  startsAt: string | null
  /** The source title (`source_title`). */
  title: string
  /** Release period, e.g. `Oct`, `Q3`; null when the title carried no period. */
  period: string | null
  unit: string | null
  actual: number | null
  estimate: number | null
  previous: number | null
  /** One move per linked market, in market rank order. */
  moves: CalendarHistoryMove[]
}

/** `GET /calendar/history` response. Releases are newest first. */
export interface CalendarHistoryResponse {
  entity: { slug: string, name: string }
  markets: CalendarHistoryMarket[]
  releases: CalendarHistoryRelease[]
}
