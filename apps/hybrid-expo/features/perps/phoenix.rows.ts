/**
 * Pure row-building logic for the Phoenix venue adapter — columns, toRow,
 * search matching, sort. No react-native, no fetching, fully unit-testable.
 * See docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md
 * ("Venue adapter contract" / Sequencing step 3).
 *
 * `phoenixMarketLabel` is ported from `PhoenixMarketListScreen.tsx:217`
 * (Phoenix's "BTC" row-label convention, vs. Pacifica's raw "BTC-PERP").
 * `sortByOpenInterestDesc` is ported from `PhoenixMarketListScreen.tsx:221-232`
 * and shared with Pacifica via `perps.rows-shared.ts`.
 *
 * Imports the ref grammar from `@/lib/token-identity.core`, not
 * `@/lib/token-identity` — the latter pulls in `@/lib/api` and therefore
 * react-native, which crashes `tsx --test`. The core module is pure and
 * import-free precisely so this file can share the real builders rather than
 * keeping a private copy of a wire contract.
 */

import { formatPercent, formatPrice, formatUsdAccessible, formatUsdCompact, NO_DATA } from '@/lib/format';

import type { PhoenixMarket } from '@/features/perps/phoenix.api';
import type { MarketListRow, ColumnSpec } from '@/features/markets/venue.contract';
import { perpRef, type TokenIdentity } from '@/lib/token-identity.core';

import { sortByOpenInterestDesc as sharedSortByOpenInterestDesc } from '@/features/perps/perps.rows-shared';

export const PHOENIX_COLUMNS: [ColumnSpec, ColumnSpec, ColumnSpec] = [
  { key: 'price', label: 'Price', width: 80 },
  { key: 'change', label: '24h', width: 58, active: true },
  { key: 'oi', label: 'OI', width: 60 },
];

/** Ported verbatim from `PhoenixMarketListScreen.tsx:217` — Phoenix's "BTC" convention. */
export function phoenixMarketLabel(market: PhoenixMarket): string {
  return market.baseSymbol || market.venueSymbol || market.symbol.replace(/-PERP$/i, '');
}

export function phoenixToRow(
  market: PhoenixMarket,
  identities: ReadonlyMap<string, TokenIdentity>,
): MarketListRow {
  const label = phoenixMarketLabel(market);
  const ref = perpRef(market.venueSymbol || market.symbol);
  const identity = identities.get(ref);

  const hasChange = typeof market.change24h === 'number' && Number.isFinite(market.change24h);
  const changeTone = !hasChange ? 'dim' : (market.change24h as number) >= 0 ? 'pos' : 'neg';

  return {
    key: market.symbol,
    lead: {
      kind: 'token',
      identityRef: ref,
      identityIconUrl: identity?.iconUrl ?? null,
      venueIconUrl: market.iconPath ?? null,
      letter: identity?.fallbackLetter ?? (label.charAt(0) || '?'),
    },
    title: label,
    titleSuffix: market.maxLeverage ? `${market.maxLeverage}×` : NO_DATA,
    cells: [
      { text: formatPrice(market.markPrice), width: PHOENIX_COLUMNS[0].width },
      { text: formatPercent(market.change24h), tone: changeTone, width: PHOENIX_COLUMNS[1].width },
      { text: formatUsdCompact(market.openInterest), width: PHOENIX_COLUMNS[2].width },
    ],
    href: `/markets/phoenix/${encodeURIComponent(market.symbol)}`,
    a11yLabel: `Open ${market.symbol}. ${formatUsdAccessible(market.openInterest)} open interest. ${formatPercent(market.change24h)} 24 hour change.`,
  };
}

/** Matches on the full venue symbol AND the base symbol, case-insensitive. */
export function phoenixMatchesQuery(market: PhoenixMarket, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return market.symbol.toLowerCase().includes(q) || market.baseSymbol.toLowerCase().includes(q);
}

/** Descending open-interest sort, shared with Pacifica. */
export function sortByOpenInterestDesc(a: PhoenixMarket, b: PhoenixMarket): number {
  return sharedSortByOpenInterestDesc(
    { openInterest: a.openInterest, sortLabel: phoenixMarketLabel(a) },
    { openInterest: b.openInterest, sortLabel: phoenixMarketLabel(b) },
  );
}
