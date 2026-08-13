/**
 * Pure row-building logic for the Meteora venue adapter — columns, toRow,
 * theme. No react-native, no fetching, fully unit-testable. See
 * docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md
 * ("Venue adapter contract" / Sequencing step 4).
 *
 * Meteora keeps its own palette (acceptance criterion 8) and keeps its own
 * icon as a second-tier fallback behind the shared token identity (per the
 * PRD's "long-tail coverage is thin by design" risk note) — that's the UI
 * layer's job once it has `venueIconUrl`, not this module's.
 *
 * `meteoraToRow`'s a11yLabel is ported verbatim from
 * `MeteoraPoolsScreen.tsx` `PoolRow` (lines 85-91).
 *
 * The ref grammar comes from `@/lib/token-identity.core` — a pure, import-free
 * module that exists so this file can share the real builders under
 * `tsx --test` (importing `@/lib/token-identity` would pull `@/lib/api` and
 * therefore react-native).
 *
 * The palette below IS reproduced locally, deliberately: the canonical
 * `METEORA_COLORS` lives in `MeteoraExecutionControls.tsx`, and importing a
 * react-native/`@expo/vector-icons` component file would drag its whole module
 * graph into a test that only needs six hex strings. Colour values drifting is
 * a visible, harmless-to-detect problem; a drifted wire contract is not.
 */

import { formatFee, formatUsdAccessible, formatUsdCompact } from '@/lib/format';

import type { MeteoraPoolSummary } from '@myboon/shared/meteora';
import type { ColumnSpec, MarketListRow, MarketListTheme } from '@/features/markets/venue.contract';
import { mintRef, type TokenIdentity } from '@/lib/token-identity.core';

export const METEORA_COLUMNS: [ColumnSpec, ColumnSpec, ColumnSpec] = [
  { key: 'fees', label: 'Fees', width: 58 },
  { key: 'tvl', label: 'TVL', width: 58 },
  { key: 'volume', label: 'Volume', width: 62, active: true },
];

/**
 * Meteora's own palette — kept in sync by hand with
 * `METEORA_COLORS` in `features/meteora/components/MeteoraExecutionControls.tsx`,
 * which this file cannot import (see file header). If that palette changes,
 * update both.
 */
const METEORA_COLORS = {
  screen: '#103D4C',
  surface: '#151B30',
  surfaceLift: '#1D2540',
  surfaceQuiet: '#11162A',
  border: '#2B3453',
  text: '#F6F3FF',
  textDim: '#9AA3BD',
  textFaint: '#68728E',
  violet: '#7A6CFF',
  cyan: '#29C6D1',
  coral: '#FF6B4A',
  green: '#34D399',
  red: '#FF627D',
  amber: '#F6B94A',
} as const;

/** Meteora's own palette, carried onto the shared shell via `adapter.theme` (acceptance criterion 8). */
export const METEORA_THEME: MarketListTheme = {
  screen: METEORA_COLORS.screen,
  surface: METEORA_COLORS.surface,
  surfaceLift: METEORA_COLORS.surfaceLift,
  border: METEORA_COLORS.border,
  rowDivider: METEORA_COLORS.border,
  rowPressed: METEORA_COLORS.surfaceQuiet,
  text: METEORA_COLORS.text,
  textDim: METEORA_COLORS.textDim,
  textFaint: METEORA_COLORS.textFaint,
  accent: METEORA_COLORS.violet,
  pos: METEORA_COLORS.green,
  neg: METEORA_COLORS.red,
};

export function meteoraToRow(
  pool: MeteoraPoolSummary,
  identities: ReadonlyMap<string, TokenIdentity>,
): MarketListRow {
  const xRef = mintRef(pool.tokenX.address);
  const yRef = mintRef(pool.tokenY.address);
  const xIdentity = identities.get(xRef);
  const yIdentity = identities.get(yRef);

  return {
    key: pool.address,
    lead: {
      kind: 'pair',
      x: {
        identityRef: xRef,
        venueIconUrl: pool.tokenX.iconUrl,
        letter: xIdentity?.fallbackLetter ?? (pool.tokenX.symbol.charAt(0) || '?'),
        tint: METEORA_COLORS.cyan,
      },
      y: {
        identityRef: yRef,
        venueIconUrl: pool.tokenY.iconUrl,
        letter: yIdentity?.fallbackLetter ?? (pool.tokenY.symbol.charAt(0) || '?'),
        tint: METEORA_COLORS.violet,
      },
    },
    title: `${pool.tokenX.symbol} / ${pool.tokenY.symbol}`,
    subtitle: `${formatFee(pool.baseFeePct)} fee${pool.hasFarm ? ' · Farm' : ''}`,
    cells: [
      { text: formatUsdCompact(pool.fees24hUsd), width: METEORA_COLUMNS[0].width },
      { text: formatUsdCompact(pool.tvlUsd), width: METEORA_COLUMNS[1].width },
      { text: formatUsdCompact(pool.volume24hUsd), width: METEORA_COLUMNS[2].width },
    ],
    href: `/markets/meteora/${pool.address}`,
    // Ported verbatim from MeteoraPoolsScreen.tsx PoolRow (lines 85-91).
    a11yLabel: [
      `Open ${pool.tokenX.symbol} ${pool.tokenY.symbol} Meteora pool.`,
      `${formatFee(pool.baseFeePct)} base fee.`,
      `${formatUsdAccessible(pool.fees24hUsd)} fees in 24 hours.`,
      `${formatUsdAccessible(pool.tvlUsd)} total liquidity.`,
      `${formatUsdAccessible(pool.volume24hUsd)} volume in 24 hours.`,
    ].join(' '),
  };
}
