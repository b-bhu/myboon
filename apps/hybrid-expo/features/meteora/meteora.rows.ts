/**
 * Pure row-building logic for the Meteora venue adapter. Colors come from
 * MyBoon's shared theme, while token icons retain the venue fallback behind
 * shared token identity. No React Native imports or fetching.
 */

import { formatFee, formatUsdAccessible, formatUsdCompact } from '@/lib/format';
import { DEFAULT_MARKET_LIST_THEME } from '@/features/markets/venue.theme';
import { METEORA_COLORS } from '@/features/meteora/meteora.theme';

import type { MeteoraPoolSummary } from '@myboon/shared/meteora';
import type { ColumnSpec, MarketListRow, MarketListTheme } from '@/features/markets/venue.contract';
import { mintRef, type TokenIdentity } from '@/lib/token-identity.core';

export const METEORA_COLUMNS: [ColumnSpec, ColumnSpec, ColumnSpec] = [
  { key: 'fees', label: 'Fees', width: 58 },
  { key: 'tvl', label: 'TVL', width: 58 },
  { key: 'volume', label: 'Volume', width: 62, active: true },
];

export const METEORA_THEME: MarketListTheme = DEFAULT_MARKET_LIST_THEME;

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
        // Meteora's own API carries NO icon field (confirmed against their
        // docs), so identity is the only icon source a pool row has.
        identityIconUrl: xIdentity?.iconUrl ?? null,
        venueIconUrl: pool.tokenX.iconUrl,
        letter: xIdentity?.fallbackLetter ?? (pool.tokenX.symbol.charAt(0) || '?'),
        tint: METEORA_COLORS.tokenX,
      },
      y: {
        identityRef: yRef,
        identityIconUrl: yIdentity?.iconUrl ?? null,
        venueIconUrl: pool.tokenY.iconUrl,
        letter: yIdentity?.fallbackLetter ?? (pool.tokenY.symbol.charAt(0) || '?'),
        tint: METEORA_COLORS.tokenY,
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
