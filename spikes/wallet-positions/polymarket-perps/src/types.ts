/** Documented and observed shapes from the Polymarket Perps public HTTP API. */

export const PERPS_HTTP_BASE = "https://api.perpetuals.polymarket.com";

export type DecimalString = string;
export type Side = "long" | "short";

export type ApiErrorBody = {
  status: "err";
  error: string;
  arts?: number;
  ts?: number;
  ref?: unknown;
};

export type RegisteredResponse = {
  registered: boolean;
};

export type PublicPortfolioPosition = {
  instrument_id: number;
  symbol: string;
  /** Signed size: positive = long, negative = short. */
  size: DecimalString;
  entry_price: DecimalString;
  unrealized_pnl: DecimalString;
  return_on_equity: DecimalString;
  /**
   * Present on the live public portfolio payload (Nov 2026).
   * Not listed among the documented required fields of PublicPortfolioPosition.
   */
  leverage?: number | null;
};

export type PublicPortfolioCoverage = {
  metadata_available?: boolean;
  missing_instrument_ids?: number[];
  collateral?: string;
};

export type PublicPortfolio = {
  positions: PublicPortfolioPosition[];
  equity: DecimalString;
  timestamp: number;
  /** Present on the live public portfolio payload; not in the documented required set. */
  coverage?: PublicPortfolioCoverage;
};

export type Ticker = {
  instrument_id: number;
  symbol: string;
  index_price: DecimalString;
  mark_price: DecimalString;
  last_price: DecimalString;
  mid_price: DecimalString;
  open_interest: DecimalString;
  funding_rate: DecimalString;
  next_funding: number;
  timestamp: number;
};

export type AccountTrade = {
  trade_id: string;
  order_id: string;
  instrument_id: number;
  side: Side;
  price: DecimalString;
  quantity: DecimalString;
  taker: boolean;
  fee: DecimalString;
  builder_fee: DecimalString;
  total_fee: DecimalString;
  fee_asset: string;
  previous_size: DecimalString;
  previous_entry_price: DecimalString;
  pnl: DecimalString;
  liquidation: boolean;
  adl: boolean;
  settlement: boolean;
  timestamp: number;
  hash: string;
};

export type AccountTrades = {
  data: AccountTrade[];
  more: boolean;
  cursor?: string;
};

export type PositionCardSnapshot = {
  position_cycle_id: string;
  side: Side;
  started_at: number;
  as_of_at: number;
  is_closed: boolean;
  size_after: DecimalString;
  entry_price: DecimalString;
  as_of_price: DecimalString;
  pnl: DecimalString;
  pnl_percent: DecimalString | null;
  leverage: number | null;
};

export type PositionSnapshotResult = {
  instrument_id?: number;
  trade_id?: string;
  status:
    | "ok"
    | "not_found"
    | "history_pending"
    | "history_limit"
    | "resource_limit"
    | "temporarily_unavailable"
    | "unavailable";
  snapshot?: PositionCardSnapshot;
};

export type PositionSnapshots = {
  history_as_of_at: number;
  active: PositionSnapshotResult[];
  history: PositionSnapshotResult[];
};

export type LeaderboardAccount = {
  account: string;
  pnl: DecimalString;
  notional: DecimalString;
  account_value: DecimalString;
  roi: DecimalString;
  rank?: number;
  instruments_traded?: number;
  top_instrument_ids?: number[];
};

export type Leaderboard = {
  window: string;
  sort_by: string;
  timestamp: number;
  total: number;
  entries: unknown[];
  account?: LeaderboardAccount;
};

export type FillAction = "open" | "close" | "increase" | "reduce" | "flip";

export type ClassifiedFill = AccountTrade & {
  symbol: string;
  size_after: DecimalString;
  action: FillAction;
};

export type ReportedPosition = {
  instrument_id: number;
  symbol: string;
  side: Side;
  size: DecimalString;
  abs_size: DecimalString;
  entry_price: DecimalString;
  mark_price: DecimalString | null;
  notional: DecimalString | null;
  unrealized_pnl: DecimalString;
  return_on_equity: DecimalString;
  leverage: number | null;
  liquidation_price: null;
  started_at: number | null;
  snapshot_status: string | null;
};

export type WalletSnapshot = {
  fetched_at: string;
  wallet: string;
  registered: boolean;
  account_error: string | null;
  equity: DecimalString | null;
  portfolio_timestamp: number | null;
  coverage: PublicPortfolioCoverage | null;
  leaderboard_all: LeaderboardAccount | null;
  positions: ReportedPosition[];
  fills: ClassifiedFill[];
  fills_truncated: boolean;
  fills_window_note: string;
  missing: string[];
  endpoints: string[];
};
