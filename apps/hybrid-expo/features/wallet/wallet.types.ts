/**
 * Shared types for Home's Wallet section orchestration (combined total + mix
 * bar shell — see docs/modules/wallet/PRDs/2026_07_21_beta_readiness_wallet_PRD.md,
 * decisions #1-4, #11-13).
 */

export type WalletProtocolId = 'spot' | 'meteora' | 'phoenix' | 'pacifica' | 'polymarket';

export const WALLET_PROTOCOL_IDS: readonly WalletProtocolId[] = [
  'spot',
  'meteora',
  'phoenix',
  'pacifica',
  'polymarket',
];

/**
 * Per-source fetch state. Each protocol is fully independent — one source's
 * failure or latency never blocks or delays another (issue #237 fetch
 * orchestration requirement).
 *
 * `stale` is distinct from `failed`: it means a refresh attempt failed (or is
 * pending retry) *after* this source had already resolved at least once —
 * the last-known value is retained and labeled stale rather than blanked or
 * downgraded to the "syncing" treatment (PRD Data and Trust Rules; TC-STATE-003).
 * `failed` means no value has ever resolved for this source yet.
 */
export type WalletSourceStatus = 'idle' | 'loading' | 'resolved' | 'failed' | 'stale';

export interface WalletSourceState {
  status: WalletSourceStatus;
  /** USD value for this protocol once resolved; null until then. */
  valueUsd: number | null;
  /** Timestamp (ms epoch) of the last successful fetch, for "as of" labels. */
  resolvedAt: number | null;
  error: string | null;
  /**
   * Protocol-specific row content (token chips, position pills) resolved
   * alongside valueUsd. Null until resolved; shape depends on the protocol
   * (see SpotRowDetail / MeteoraRowDetail / PerpsRowDetail).
   */
  detail: SpotRowDetail | MeteoraRowDetail | PerpsRowDetail | PredictionRowDetail | null;
}

export type WalletSourcesState = Record<WalletProtocolId, WalletSourceState>;

/**
 * Spot row content (issue #238): the 3 largest holdings by USD value, ranked
 * purely by value (no special-casing SOL), plus how many more tokens exist
 * beyond those shown as chips.
 */
export interface SpotChipToken {
  mint: string
  symbol: string | null
  logoUri: string | null
  valueUsd: number
}

export interface SpotRowDetail {
  topTokens: SpotChipToken[]
  /** Count of additional held tokens beyond topTokens, for the "+N" overflow chip. */
  overflowCount: number
}

/**
 * Meteora row content (issue #238): one pill per open LP position, plus the
 * unclaimed fees to surface on the row's signal line (PRD design decision
 * #17, PRD "Meteora" note in issue #238).
 */
export interface MeteoraRowPill {
  poolAddress: string
  pair: string
  /** True = in range (green ring), false = out of range (red ring), null = unknown. */
  inRange: boolean | null
}

export interface MeteoraRowDetail {
  pills: MeteoraRowPill[]
  unclaimedFeesUsd: number | null
}

/**
 * Perps row content (issue #239 — Phoenix and Pacifica share this shape):
 * one pill per open position, tinted by that position's own live PnL sign
 * (PRD design decision #17). Both protocols already share `PerpsPosition`'s
 * `side: 'long' | 'short'` / `unrealizedPnl` fields (features/perps/perps.types.ts),
 * so a single detail shape covers both rows.
 */
export interface PerpsRowPill {
  symbol: string;
  side: 'long' | 'short';
  /** Winning (>= 0) tints green, losing (< 0) tints red. */
  unrealizedPnl: number;
}

export interface PerpsRowDetail {
  pills: PerpsRowPill[];
}

/**
 * Polymarket row content (issue #653). Prediction markets have no size or
 * leverage, so a pill carries the market's question and the position's current
 * value instead. `readyToCollect` surfaces resolved markets awaiting redeem;
 * it is undefined when the portfolio summary did not report one, never 0 as a
 * stand-in for unknown.
 */
export interface PredictionRowPill {
  /** The market question, truncated by the row at render time. */
  title: string;
  /** Current USD value of the held shares. */
  valueUsd: number;
}

export interface PredictionRowDetail {
  pills: PredictionRowPill[];
  readyToCollect?: number;
}

export type WalletRowDetail =
  | { protocol: 'spot'; data: SpotRowDetail }
  | { protocol: 'meteora'; data: MeteoraRowDetail }
  | { protocol: 'phoenix' | 'pacifica'; data: PerpsRowDetail }
  | { protocol: 'polymarket'; data: PredictionRowDetail };

export interface WalletTotals {
  /** Sum of every currently-resolved source's valueUsd. Null if none resolved yet. */
  totalUsd: number | null;
  /** Per-protocol share of totalUsd (0-1), only for resolved sources. Empty if totalUsd is null. */
  mix: Partial<Record<WalletProtocolId, number>>;
  /** Most recent resolvedAt across all sources, for the total's "as of" label. */
  lastResolvedAt: number | null;
}
