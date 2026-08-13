/**
 * Bits shared between the Pacifica and Phoenix row modules — currently just
 * the open-interest sort, ported from `PhoenixMarketListScreen.tsx:221-232`.
 * Pacifica gets the same sort with zero new UI (per the PRD, "Explicitly
 * Postponed" section: no sort sheets, but *make the existing Phoenix OI sort
 * visible and give Pacifica the same sort").
 *
 * PURE — no react-native imports, `tsx --test`-able.
 */

/** Minimal shape both venues' markets satisfy for sorting purposes. */
export interface OpenInterestSortable {
  openInterest: number | null | undefined;
  /** Label used as the tie-breaker when open interest is equal (or both missing). */
  sortLabel: string;
}

function sortableOpenInterest(market: OpenInterestSortable): number {
  return typeof market.openInterest === 'number' && Number.isFinite(market.openInterest)
    ? market.openInterest
    : -1;
}

/**
 * Descending open-interest sort; missing/invalid OI sorts last (as -1), ties
 * (including the all-missing case) broken by label ascending. Ported
 * verbatim from Phoenix's `sortByOpenInterestDesc` / `marketOpenInterest`.
 */
export function sortByOpenInterestDesc<T extends OpenInterestSortable>(a: T, b: T): number {
  const aOi = sortableOpenInterest(a);
  const bOi = sortableOpenInterest(b);
  if (aOi !== bOi) return bOi - aOi;
  return a.sortLabel.localeCompare(b.sortLabel);
}
