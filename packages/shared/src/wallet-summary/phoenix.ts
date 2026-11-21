/**
 * Phoenix (collateral-margin perps) value helpers (issue #723), moved
 * verbatim from the Expo app so the server keeps one definition:
 * - sumPhoenixPortfolioValue / toNumber / toUsd from
 *   apps/hybrid-expo/features/wallet/wallet.sources.ts (lines 188-266),
 * - sumUsd / accountSummary (+ the worstRiskLabel and statusText string
 *   helpers they lean on) from
 *   apps/hybrid-expo/features/portfolio/phoenix.portfolio.tsx (lines 1211+).
 *
 * Moves are pure: same inputs, same outputs, same rounding. toUsd's rule of
 * dividing integers of 1,000,000 or more by 1e6 is deliberately preserved
 * unchanged (tests pin the threshold); see wallet-value.test.ts.
 */

export type PhoenixTraderRecord = Record<string, unknown>;

export interface PhoenixAccountSummary {
  portfolioValue: number | null;
  collateralBalance: number | null;
  effectiveCollateral: number | null;
  withdrawable: number | null;
  unrealizedPnl: number;
  initialMargin: number | null;
  maintenanceMargin: number | null;
  accountLeverage: number | null;
  riskLabel: string;
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function asString(input: unknown): string | null {
  if (typeof input === 'number' && Number.isFinite(input)) return String(input);
  return typeof input === 'string' && input.trim().length > 0 ? input : null;
}

function statusText(value: unknown): string {
  const text = asString(value);
  if (!text) return '--';
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function worstRiskLabel(traders: PhoenixTraderRecord[]): string {
  const order = ['Safe', 'At Risk', 'Cancellable', 'Liquidatable', 'Backstop Liquidatable', 'High Risk'];
  let worst = 'Safe';
  for (const trader of traders) {
    const label = statusText(trader.riskTier ?? trader.riskState);
    if (!label || label === '--') continue;
    if (order.indexOf(label) > order.indexOf(worst)) worst = label;
  }
  return traders.length > 0 ? worst : '--';
}

/**
 * Phoenix equity (collateral + unrealized PnL) is reported per-trader-PDA as
 * `portfolioValue` on each record in `traders`. Mirrors the same field name
 * and USD-lots convention PhoenixProfileScreen's own (unexported) summary
 * uses, summed across every trader record for this authority.
 *
 * A wallet with zero trader-PDA records (never traded on Phoenix) is a
 * legitimate $0, not a failure — mirrors the same `records.length > 0` check
 * PhoenixProfileScreen's own `worstRiskLabel` uses for the same reason.
 * `null` is reserved for the genuinely ambiguous case: trader records exist
 * but none of them had a parseable `portfolioValue`, which PhoenixProfileScreen
 * itself has never had to disambiguate (it only renders once an account is
 * known to exist), but Wallet's row must, since it represents any connected
 * wallet including ones that have never touched Phoenix at all.
 */
export function sumPhoenixPortfolioValue(traders: unknown[]): number | null {
  if (traders.length === 0) return 0;
  const values = traders
    .map((trader) => toUsd(asRecord(trader)?.portfolioValue))
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

export function toNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const record = asRecord(input);
  if (record) {
    const ui = toNumber(record.ui);
    if (ui !== null) return ui;

    const rawValue = toNumber(record.value);
    const decimals = toNumber(record.decimals);
    if (rawValue !== null && decimals !== null) {
      const scaled = rawValue / (10 ** decimals);
      return Number.isFinite(scaled) ? scaled : null;
    }
  }
  if (typeof input !== 'string' || input.trim() === '') return null;
  const parsed = Number.parseFloat(input);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Fragile USD scaling: an integer (or dot-less string) of magnitude
 * 1,000,000 or more is treated as Phoenix raw USD-lots and divided by 1e6;
 * anything else (dot-carrying strings, {ui} records, smaller values) is used
 * as parsed. Kept unchanged; wallet-value.test.ts pins it.
 */
export function toUsd(input: unknown): number | null {
  const value = toNumber(input);
  if (value === null) return null;
  if (
    ((typeof input === 'string' && !input.includes('.')) || typeof input === 'number')
    && Math.abs(value) >= 1_000_000
  ) {
    return value / 1_000_000;
  }
  return value;
}

export function sumUsd(records: PhoenixTraderRecord[], key: string): number | null {
  const values = records
    .map((record) => toUsd(record[key]))
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

export function accountSummary(traders: PhoenixTraderRecord[]): PhoenixAccountSummary {
  const portfolioValue = sumUsd(traders, 'portfolioValue');
  const effectiveCollateral = sumUsd(traders, 'effectiveCollateral');
  const initialMargin = sumUsd(traders, 'initialMargin');

  return {
    portfolioValue,
    collateralBalance: sumUsd(traders, 'collateralBalance'),
    effectiveCollateral,
    withdrawable: sumUsd(traders, 'effectiveCollateralForWithdrawals'),
    unrealizedPnl: sumUsd(traders, 'unrealizedPnl') ?? 0,
    initialMargin,
    maintenanceMargin: sumUsd(traders, 'maintenanceMargin'),
    accountLeverage: effectiveCollateral && effectiveCollateral > 0 && initialMargin !== null
      ? initialMargin / effectiveCollateral
      : null,
    riskLabel: worstRiskLabel(traders),
  };
}
