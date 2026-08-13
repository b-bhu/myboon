/**
 * Pure row-building logic for the Orca venue adapter — the plug-and-play
 * PROOF (PRD acceptance criterion 7 / Sequencing step 5). Orca is a stub: a
 * fourth venue registers with a new adapter file and a registry entry, no
 * new screen, no new style block.
 *
 * PURE — no react-native imports, `tsx --test`-able.
 */

import { formatUsdCompact } from '@/lib/format';
import { mintRef } from '@/lib/token-identity.core';

import type { ColumnSpec, MarketListRow, MarketPage } from '@/features/markets/venue.contract';

export const ORCA_COLUMNS: [ColumnSpec, ColumnSpec, ColumnSpec] = [
  { key: 'fees', label: 'Fees', width: 58 },
  { key: 'tvl', label: 'TVL', width: 58, active: true },
  { key: 'volume', label: 'Volume', width: 62 },
];

/** Minimal stub market shape — enough to prove a row renders, nothing more. */
export interface OrcaStubMarket {
  address: string;
  pair: string;
  feesUsd: number;
  tvlUsd: number;
  volumeUsd: number;
}

/** Clearly-labelled stub data, shown only under `__DEV__` so plug-and-play is provable without shipping fake markets. */
export const ORCA_STUB_MARKETS: readonly OrcaStubMarket[] = [
  { address: 'orca-stub-sol-usdc', pair: 'SOL / USDC (stub)', feesUsd: 1200, tvlUsd: 450_000, volumeUsd: 88_000 },
  { address: 'orca-stub-jup-usdc', pair: 'JUP / USDC (stub)', feesUsd: 340, tvlUsd: 120_000, volumeUsd: 21_000 },
];

export function orcaToRow(market: OrcaStubMarket): MarketListRow {
  const [xSymbol, ySymbol] = market.pair.replace(' (stub)', '').split(' / ');

  return {
    key: market.address,
    lead: {
      kind: 'pair',
      x: { identityRef: mintRef(`stub-${xSymbol}`), venueIconUrl: null, letter: xSymbol?.charAt(0) ?? '?' },
      y: { identityRef: mintRef(`stub-${ySymbol}`), venueIconUrl: null, letter: ySymbol?.charAt(0) ?? '?' },
    },
    title: market.pair,
    subtitle: 'Stub — plug-and-play proof, not a real market',
    cells: [
      { text: formatUsdCompact(market.feesUsd), width: ORCA_COLUMNS[0].width },
      { text: formatUsdCompact(market.tvlUsd), width: ORCA_COLUMNS[1].width },
      { text: formatUsdCompact(market.volumeUsd), width: ORCA_COLUMNS[2].width },
    ],
    href: `/markets/orca/${encodeURIComponent(market.address)}`,
    a11yLabel: `Open ${market.pair} Orca pool. Stub market, not yet tradeable.`,
  };
}

/**
 * Returns a small static page of stub rows under `__DEV__`, and an empty
 * page otherwise — so the shared empty state renders and the venue "works"
 * with zero new UI in production.
 */
export function orcaListMarkets(isDev: boolean): MarketPage<OrcaStubMarket> {
  if (!isDev) return { items: [], hasNext: false, page: 0 };
  return { items: ORCA_STUB_MARKETS, hasNext: false, page: 0 };
}
