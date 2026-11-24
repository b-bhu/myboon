/**
 * Pure helpers over the Polymarket Data API v2 held-position rows.
 *
 * Moved verbatim from the Expo app's
 * apps/hybrid-expo/features/polymarket/portfolio-summary.ts (issue #723) so
 * the server can run the same merge/map/summarize pipeline — one definition
 * of the app's value, P&L and position sums.
 *
 * Shared defines small local types instead of importing the SDK: the SDK's
 * branded shapes (EvmAddress, DecimalString, ...) are structurally
 * compatible with them, so app-side call sites keep passing SDK `Position`
 * rows unchanged.
 */

import { toNumber } from '../guards.js';

/**
 * Structural stand-in for the SDK's parsed `Position`. Only the fields the
 * helpers touch are declared. The DecimalString-ish fields are typed
 * `unknown` on purpose: they go through toNumber(), which accepts both
 * decimal strings ("0.99") and numbers.
 */
export interface SdkPosition {
  wallet: string;
  assetId: string;
  conditionId: string;
  currentSize: unknown;
  avgPrice: unknown;
  currentValue: unknown;
  unrealizedPnl: unknown;
  percentPnl: unknown;
  currentPrice: unknown;
  title?: string | null;
  slug?: string | null;
  eventSlug?: string | null;
  outcome?: string | null;
  /** The SDK declares this optional; a missing outcome index counts as 0. */
  outcomeIndex?: unknown;
  icon?: string | null;
  endDate?: string | null;
  negativeRisk: boolean;
}

/** The app's PortfolioPosition shape (moved copy: one definition). */
export interface PortfolioPosition {
  proxyWallet: string;
  /** Token ID — used as tokenID for sell orders */
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  curPrice: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  icon: string | null;
  endDate: string | null;
  /** Whether this market uses the neg-risk exchange contract */
  negativeRisk: boolean;
}

// toNumber used to be a duplicated private helper from the app's
// polymarket.api.ts; it is @myboon/shared's guards.toNumber since #896 —
// identical on every input guards.test.ts pins. numberOrZero stays local.

function numberOrZero(value: unknown): number {
  return toNumber(value) ?? 0;
}

export function mapSdkPosition(value: SdkPosition): PortfolioPosition {
  return {
    proxyWallet: value.wallet,
    asset: value.assetId,
    conditionId: value.conditionId,
    size: numberOrZero(value.currentSize),
    avgPrice: numberOrZero(value.avgPrice),
    currentValue: numberOrZero(value.currentValue),
    cashPnl: numberOrZero(value.unrealizedPnl),
    percentPnl: numberOrZero(value.percentPnl),
    curPrice: numberOrZero(value.currentPrice),
    title: value.title ?? '',
    slug: value.slug ?? '',
    eventSlug: value.eventSlug ?? '',
    outcome: value.outcome ?? '',
    outcomeIndex: numberOrZero(value.outcomeIndex),
    icon: value.icon ?? null,
    endDate: value.endDate ?? null,
    negativeRisk: value.negativeRisk,
  };
}

/**
 * Old v1 GET /positions returned every held position in one list, redeemable
 * rows included. Data API v2 splits them across the OPEN and REDEEMABLE status
 * pages, and (verified live) it currently lists redeemable held rows on both
 * pages. So the union must be deduped by assetId — OPEN rows first, then only
 * redeemable rows whose assetId is not already present (first occurrence wins).
 */
export function mergeHeldPositions(open: SdkPosition[], redeemable: SdkPosition[]): SdkPosition[] {
  const seen = new Set<SdkPosition['assetId']>();
  const merged: SdkPosition[] = [];
  for (const position of [...open, ...redeemable]) {
    if (seen.has(position.assetId)) continue;
    seen.add(position.assetId);
    merged.push(position);
  }
  return merged;
}

/**
 * Upper bound on Data API v2 pages walked per held-position status (issue #426,
 * PR #445): summary totals must cover every held position, but the walk is
 * bounded so a pathological backend cannot make it unbounded.
 */
export const HELD_POSITIONS_PAGE_CEILING = 20;

/**
 * Accumulate every page of a paginated SDK list without a list cap. Stops at
 * maxPages pages: if that last consumed page still reported hasMore, the
 * result is partial: true (totals built from it are lower bounds) — page
 * maxPages + 1 is never requested. A page that reports hasMore but has no
 * successor (paginator exhausted under the ceiling) is not partial.
 */
export async function walkAllPages<T>(
  paginator: AsyncIterable<{ items: T[]; hasMore: boolean }>,
  maxPages = HELD_POSITIONS_PAGE_CEILING,
): Promise<{ items: T[]; partial: boolean }> {
  const items: T[] = [];
  let pages = 0;
  let stoppedAtCeiling = false;
  for await (const page of paginator) {
    items.push(...page.items);
    pages += 1;
    if (pages >= maxPages) {
      // Never request page maxPages + 1: whether more pages exist is taken
      // from the flag on the last consumed page.
      stoppedAtCeiling = page.hasMore;
      break;
    }
  }
  return { items, partial: stoppedAtCeiling };
}

export interface HeldPositionSummary {
  totalPnl: number;
  cashOutNow: number;
  activePickCount: number;
  openPositions: number;
  /**
   * True when the held-position page walk stopped at HELD_POSITIONS_PAGE_CEILING
   * while the last page still reported more pages: the totals (including the
   * readyToCollect sum over every walked redeemable page) and
   * totalPositionCount are then lower bounds, not exact totals.
   */
  totalsPartial: boolean;
  /** Held-position count over all walked pages (deduped by assetId). */
  totalPositionCount: number;
}

/**
 * Summary over the merged held positions, using exactly the old v1 formulas:
 * totalPnl = sum cashPnl, cashOutNow = sum currentValue,
 * activePickCount = openPositions = held positions count. `positions` is the
 * deduped union from mergeHeldPositions(), so totalPositionCount equals its
 * length; `partial` marks totals that the page ceiling truncated.
 */
export function summarizeHeldPositions(positions: PortfolioPosition[], partial = false): HeldPositionSummary {
  return {
    totalPnl: positions.reduce((sum, position) => sum + position.cashPnl, 0),
    cashOutNow: positions.reduce((sum, position) => sum + position.currentValue, 0),
    activePickCount: positions.length,
    openPositions: positions.length,
    totalsPartial: partial,
    totalPositionCount: positions.length,
  };
}

/**
 * Sum of the collectible value over redeemable rows, excluding rows below
 * $0.01 (the same threshold fetchPortfolio() applies to the returned
 * redeemablePositions list). Called over every walked redeemable page so the
 * sum covers the full REDEEMABLE walk, not just the rows that fit in the
 * returned 50-row list.
 */
export function sumReadyToCollect(redeemable: PortfolioPosition[]): number {
  return redeemable
    .filter((position) => position.currentValue >= 0.01)
    .reduce((sum, position) => sum + position.currentValue, 0);
}
