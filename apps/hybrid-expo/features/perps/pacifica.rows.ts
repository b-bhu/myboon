/**
 * Pure row-building logic for the Pacifica venue adapter — columns, toRow,
 * search matching, sort. No react-native, no fetching, fully unit-testable.
 * See docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md
 * ("Venue adapter contract" / Sequencing step 3).
 *
 * Closes two gaps the PRD calls out for Pacifica specifically:
 * - No empty state today because search only matched `symbol` — this module
 *   also matches `baseSymbol` (the part before `-`), same as Phoenix.
 * - No accessibility label on rows — `pacificaToRow` always produces one.
 *
 * Pacifica's numeric fields use `0` as a missing-data sentinel (never a real
 * price/OI/change of exactly zero), so `pacificaToRow` treats `0` as "no
 * data" before handing values to the shared formatters — otherwise a
 * legitimate NO_DATA case would render as "$0.00" instead of "—".
 *
 * Imports the ref grammar from `@/lib/token-identity.core`, not
 * `@/lib/token-identity` — the latter pulls in `@/lib/api` and therefore
 * react-native, which crashes `tsx --test`. The core module is pure and
 * import-free precisely so this file can share the real builders rather than
 * keeping a private copy of a wire contract.
 */

import { formatPercent, formatPrice, formatUsdAccessible, formatUsdCompact } from '@/lib/format';

import type { PerpsMarket } from '@/features/perps/perps.types';
import type { MarketListRow, ColumnSpec } from '@/features/markets/venue.contract';
import { perpRef, type TokenIdentity } from '@/lib/token-identity.core';

import { sortByOpenInterestDesc as sharedSortByOpenInterestDesc } from '@/features/perps/perps.rows-shared';

export const PACIFICA_COLUMNS: [ColumnSpec, ColumnSpec, ColumnSpec] = [
  { key: 'price', label: 'Price', width: 80 },
  { key: 'change', label: '24h', width: 58, active: true },
  { key: 'oi', label: 'OI', width: 60 },
];

/** Pacifica's 0-is-missing sentinel — pass 0 through as no-data. */
function nullIfZero(value: number): number | null {
  return value === 0 ? null : value;
}

/** The part before `-` — e.g. `BTC` from `BTC-PERP`, `kPEPE` from `kPEPE-PERP`. */
export function pacificaBaseSymbol(symbol: string): string {
  const idx = symbol.indexOf('-');
  return idx === -1 ? symbol : symbol.slice(0, idx);
}

export function pacificaToRow(
  market: PerpsMarket,
  identities: ReadonlyMap<string, TokenIdentity>,
): MarketListRow {
  const baseSymbol = pacificaBaseSymbol(market.symbol);
  const ref = perpRef(market.symbol);
  const identity = identities.get(ref);

  const markPrice = nullIfZero(market.markPrice);
  const change24h = nullIfZero(market.change24h);
  const openInterest = nullIfZero(market.openInterest);

  const changeTone = change24h === null ? 'dim' : change24h >= 0 ? 'pos' : 'neg';

  return {
    key: market.symbol,
    lead: {
      kind: 'token',
      identityRef: ref,
      identityIconUrl: identity?.iconUrl ?? null,
      venueIconUrl: market.iconPath ?? null,
      letter: identity?.fallbackLetter ?? (baseSymbol.charAt(0) || '?'),
    },
    // Pacifica keeps its raw venue symbol ("BTC-PERP") while Phoenix strips the
    // suffix ("BTC"). That difference is preserved on purpose: the PRD lists the
    // three row-label conventions as a known inconsistency but scopes P0 to
    // "bones only — rows, states, formatters, icons", and never asks for labels
    // to be unified. Changing user-visible copy here would be a product decision
    // smuggled in under a refactor. Unifying is a one-line change in each rows
    // module once someone actually decides which convention wins.
    title: market.symbol,
    titleSuffix: `${market.maxLeverage}×`,
    cells: [
      { text: formatPrice(markPrice), width: PACIFICA_COLUMNS[0].width },
      { text: formatPercent(change24h), tone: changeTone, width: PACIFICA_COLUMNS[1].width },
      { text: formatUsdCompact(openInterest), width: PACIFICA_COLUMNS[2].width },
    ],
    href: `/markets/pacifica/${encodeURIComponent(market.symbol)}`,
    a11yLabel: `Open ${market.symbol}. ${formatUsdAccessible(openInterest)} open interest. ${formatPercent(change24h)} 24 hour change.`,
  };
}

/** Matches on the full venue symbol AND the base symbol (before `-`), case-insensitive. */
export function pacificaMatchesQuery(market: PerpsMarket, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    market.symbol.toLowerCase().includes(q) || pacificaBaseSymbol(market.symbol).toLowerCase().includes(q)
  );
}

/**
 * Descending open-interest sort, shared with Phoenix — Pacifica gains the
 * same sort with zero new UI (PRD Sequencing step 3 / "Explicitly
 * Postponed" sort-sheets note).
 */
export function sortByOpenInterestDesc(a: PerpsMarket, b: PerpsMarket): number {
  return sharedSortByOpenInterestDesc(
    { openInterest: nullIfZero(a.openInterest), sortLabel: a.symbol },
    { openInterest: nullIfZero(b.openInterest), sortLabel: b.symbol },
  );
}
