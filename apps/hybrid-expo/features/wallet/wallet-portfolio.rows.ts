/**
 * Pure helpers for the wallet Portfolio list (issue #768): one summary line
 * per app, the Apps and Spot groups with the $1 dust filter, and the top-5
 * cut. Plain functions on a `WalletSummary` — no React anywhere; no screen
 * consumes these yet (they wire up in #769/#770).
 *
 * Money formatting reuses the wallet area's existing format —
 * toLocaleString('en-US', { style: 'currency', currency: 'USD', 2 fixed
 * decimals }), the exact config of WalletHero.formatUsd and
 * CombinedPortfolioScreen.formatUsd — with the sign prefix in front of P&L
 * (the app's signed-money convention: lib/format.ts formatPercent and the
 * Polymarket detail screen treat zero as non-negative, so it shows +$0.00).
 * Unknown (null) amounts render the app-wide NO_DATA glyph.
 *
 * Meteora: the response lists `poolCount` of `totalPools` pools, so when
 * `hasMore` is true the count shows a trailing '+': "2+ pools".
 */

import { NO_DATA } from '@/lib/format';
import type {
  MeteoraSummary,
  PacificaSummary,
  PolymarketSummary,
  PhoenixSummary,
  WalletSummary,
} from '@myboon/shared/wallet-summary';

/** Apps that carry a summary line and a Portfolio row; spot is its own group. */
export type PortfolioAppKey = 'polymarket' | 'phoenix' | 'pacifica' | 'meteora';

export const PORTFOLIO_APP_KEYS: readonly PortfolioAppKey[] = [
  'polymarket',
  'phoenix',
  'pacifica',
  'meteora',
];

/** Dust rule: values under this many dollars stay off the Portfolio list. */
export const DUST_USD = 1;

/** One row in the Apps group (id = app key) or the Spot group (id = chain). */
export interface AppPortfolioRow {
  group: 'apps';
  id: PortfolioAppKey;
  valueUsd: number;
  /** The per-app line, e.g. "Cash $120.00 · Bets $292.00 · +$18.00". */
  summaryLine: string;
}

/**
 * One row in the Spot group: one per chain with a Spot value at or above
 * the dust line. v1 lists Solana only — the summary's spot slot holds the
 * Solana address, and the owner decided no EVM row (issue #770).
 */
export interface SpotPortfolioRow {
  group: 'spot';
  chain: 'solana';
  /** The chain's Spot value; null keeps the row so its value slot can show the no-data glyph. */
  valueUsd: number | null;
}

export type WalletPortfolioRow = AppPortfolioRow | SpotPortfolioRow;

/** { top: the first `limit` rows in the given order, moreCount: rest count. } */
export interface TopFive<R> {
  top: R[];
  moreCount: number;
}

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Signed P&L: "+$18.00" / "-$3.00"; zero is non-negative (="+$0.00"). */
export function formatPnlUsd(value: number | null): string {
  if (value === null) return NO_DATA;
  const sign = value >= 0 ? '+' : '-';
  return `${sign}${formatUsd(Math.abs(value))}`;
}

function moneyOrNoData(value: number | null): string {
  return value === null ? NO_DATA : formatUsd(value);
}

function countEntry(count: number, one: string, many: string): string {
  return count === 1 ? `${count} ${one}` : `${count} ${many}`;
}

function polymarketLine(s: PolymarketSummary): string {
  return [
    `Cash ${moneyOrNoData(s.cashUsd)}`,
    `Bets ${moneyOrNoData(s.openPositionsValueUsd)}`,
    formatPnlUsd(s.totalPnlUsd),
  ].join(' · ');
}

function phoenixLine(s: PhoenixSummary): string {
  return [
    `Equity ${moneyOrNoData(s.equityUsd)}`,
    countEntry(s.positionCount, 'position', 'positions'),
    formatPnlUsd(s.unrealizedPnlUsd),
  ].join(' · ');
}

function pacificaLine(s: PacificaSummary): string {
  return [
    `Available ${moneyOrNoData(s.availableToSpendUsd)}`,
    countEntry(s.positionCount, 'position', 'positions'),
    formatPnlUsd(s.unrealizedPnlUsd),
  ].join(' · ');
}

function meteoraLine(s: MeteoraSummary): string {
  const pools = `${s.poolCount}${s.hasMore ? '+' : ''} ${s.poolCount === 1 ? 'pool' : 'pools'}`;
  return `${pools} · ${moneyOrNoData(s.unclaimedFeesUsd)} fees`;
}

/**
 * One summary line per status-ok app ("Cash $120 · Bets $292 · +$18"
 * style); apps that are `not_connected` or `unavailable` have no entry.
 */
export function appSummaryLines(summary: WalletSummary): Partial<Record<PortfolioAppKey, string>> {
  const lines: Partial<Record<PortfolioAppKey, string>> = {};
  const apps = summary.apps;
  if (apps.polymarket.status === 'ok' && apps.polymarket.summary) {
    lines.polymarket = polymarketLine(apps.polymarket.summary);
  }
  if (apps.phoenix.status === 'ok' && apps.phoenix.summary) {
    lines.phoenix = phoenixLine(apps.phoenix.summary);
  }
  if (apps.pacifica.status === 'ok' && apps.pacifica.summary) {
    lines.pacifica = pacificaLine(apps.pacifica.summary);
  }
  if (apps.meteora.status === 'ok' && apps.meteora.summary) {
    lines.meteora = meteoraLine(apps.meteora.summary);
  }
  return lines;
}

/** Sorts by the value with nulls (unknown) last, without mutating the input. */
function descByValue<R>(rows: readonly R[], value: (row: R) => number | null): R[] {
  const key = (row: R): number => value(row) ?? -Infinity;
  return [...rows].sort((a, b) => key(b) - key(a));
}

function isListed(valueUsd: number | null): valueUsd is number {
  return valueUsd !== null && valueUsd >= DUST_USD;
}

/**
 * The Apps and Spot groups, dust-hidden and sorted by value (desc). An app
 * with status `not_connected` (or `unavailable`, or a null value) produces
 * no row; the Spot group holds one row per chain, listed from the spot
 * app's value (Solana only in v1, #770).
 */
export function portfolioRows(summary: WalletSummary): {
  apps: AppPortfolioRow[];
  spot: SpotPortfolioRow[];
} {
  const lines = appSummaryLines(summary);
  const apps: AppPortfolioRow[] = [];
  for (const key of PORTFOLIO_APP_KEYS) {
    const app = summary.apps[key];
    if (app.status !== 'ok' || !isListed(app.valueUsd)) continue;
    const summaryLine = lines[key];
    if (summaryLine === undefined) continue;
    apps.push({ group: 'apps', id: key, valueUsd: app.valueUsd, summaryLine });
  }
  // One row per chain above the dust line; v1 lists Solana only (#770).
  // A null (failed) value keeps the row — its value slot shows the
  // no-data glyph; a real value under $1 is dust-hidden like the apps'.
  const spot: SpotPortfolioRow[] = [];
  if (summary.apps.spot.status === 'ok') {
    const valueUsd = summary.apps.spot.valueUsd;
    if (valueUsd === null || valueUsd >= DUST_USD) {
      spot.push({ group: 'spot', chain: 'solana', valueUsd });
    }
  }
  return { apps: descByValue(apps, (row) => row.valueUsd), spot: descByValue(spot, (row) => row.valueUsd) };
}

/**
 * The top `limit` (default 5) rows in the given order plus a count for the
 * "+N more" row (0 when everything fits).
 */
export function topFive<R extends { valueUsd: number }>(
  rows: readonly R[],
  limit = 5,
): TopFive<R> {
  return { top: rows.slice(0, limit), moreCount: Math.max(0, rows.length - limit) };
}
