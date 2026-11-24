/**
 * Shared types for the wallet summary response (#722): one server response
 * describes every app the wallet aggregates, so the phone stops computing
 * per-app values itself. Rules: every USD amount is a `number` (never a
 * string), `null` means unknown, times are ISO-8601 strings. `not_connected`
 * means this person has no account at that venue (for example no `evm`
 * address was sent) and is not an error; `unavailable` means the upstream
 * call failed.
 */

/** Per-app state inside a wallet summary. */
export type VenueStatus = 'ok' | 'unavailable' | 'not_connected';

/**
 * One app's slot in a wallet summary. `summary` is set only while `status` is
 * 'ok'; `error` is a human-readable failure reason for 'unavailable'.
 */
export interface AppSummary<T> {
  status: VenueStatus
  /** Total USD value of the app (venue's own definition); null when unknown. */
  valueUsd: number | null
  summary: T | null
  error?: string
}

/** Everything the wallet needs about one person's accounts. */
export interface WalletSummary {
  /** Solana address backing phoenix/pacifica/meteora/spot, or null. */
  solana: string | null
  /** EVM address backing polymarket, or null. */
  evm: string | null
  /** ISO-8601 time the server assembled this summary. */
  fetchedAt: string
  apps: {
    polymarket: AppSummary<PolymarketSummary>
    phoenix: AppSummary<PhoenixSummary>
    pacifica: AppSummary<PacificaSummary>
    meteora: AppSummary<MeteoraSummary>
    spot: AppSummary<SpotSummary>
  }
}

/** Polymarket totals: cash, open positions and redeemable winnings. */
export interface PolymarketSummary {
  cashUsd: number | null
  openPositionsValueUsd: number | null
  readyToCollectUsd: number | null
  totalPnlUsd: number | null
  openPositionCount: number
}

/** One open perpetual position, shared by Phoenix and Pacifica; size is in the base asset. */
export interface WalletPerpPosition {
  symbol: string
  size: number
  unrealizedPnlUsd: number | null
}

/** Phoenix (perps DEX) account totals. */
export interface PhoenixSummary {
  equityUsd: number | null
  collateralUsd: number | null
  unrealizedPnlUsd: number | null
  positionCount: number
  positions: WalletPerpPosition[]
}

/** Pacifica (perps DEX) account totals. */
export interface PacificaSummary {
  equityUsd: number | null
  availableToSpendUsd: number | null
  unrealizedPnlUsd: number | null
  positionCount: number
  positions: WalletPerpPosition[]
}

/** One Meteora LP position; `outOfRange` is null when unknown. */
export interface WalletMeteoraPool {
  name: string
  valueUsd: number | null
  unclaimedFeesUsd: number | null
  outOfRange: boolean | null
}

/** Meteora LP account totals (`poolCount` = pools in this response). */
export interface MeteoraSummary {
  poolCount: number
  totalPools: number
  hasMore: boolean
  unclaimedFeesUsd: number | null
  totalPnlUsd: number | null
  pools: WalletMeteoraPool[]
}

/**
 * One open Meteora position (#867) for GET /wallet/meteora/positions. The
 * upstream position answer has no fee field, so `poolUnclaimedFeesUsd` is
 * the owning pool's unclaimed fees (the same number the summary's pool row
 * carries), repeated on each of that pool's positions. Prices and
 * percentages are numbers; `null` means unknown.
 */
export interface WalletMeteoraPosition {
  address: string
  poolAddress: string
  poolName: string
  minPrice: number | null
  maxPrice: number | null
  lowerBinId: number
  upperBinId: number
  outOfRange: boolean | null
  pnlUsd: number | null
  pnlPct: number | null
  feeTvl24hPct: number | null
  poolUnclaimedFeesUsd: number | null
}

/**
 * GET /wallet/meteora/positions (#867): every open position across the
 * first 50 pools. `status` follows the summary's Meteora slot: `ok`,
 * `not_connected` (no solana address) or `unavailable` (with `error`).
 * `hasMore` is true when pools (or one pool's positions) sit beyond what
 * this response returns.
 */
export interface MeteoraPositionsResponse {
  status: VenueStatus
  positions: WalletMeteoraPosition[]
  totalPools: number
  hasMore: boolean
  error?: string
}

/** One spot token holding; icon URL when the upstream provides one. */
export interface WalletSpotToken {
  mint: string
  symbol: string | null
  iconUrl: string | null
  valueUsd: number | null
}

/** Spot wallet totals (the largest holdings are listed as tokens). */
export interface SpotSummary {
  tokenCount: number
  tokens: WalletSpotToken[]
}
