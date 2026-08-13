/**
 * Meteora VenueAdapter — assembles the pure row logic in `meteora.rows.ts`
 * with Meteora's existing data-api client (`meteoraClient`). Meteora keeps
 * its own remote search, server-side sort, and pagination (per the PRD: "the
 * seam is at the row model, not at data fetching"). See
 * docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md.
 */

import type { MeteoraPoolSummary } from '@myboon/shared/meteora';

import { meteoraClient } from '@/features/meteora/meteora.client';
import { mintRef } from '@/lib/token-identity';

import type { MarketPage, MarketQuery, VenueAdapter } from '@/features/markets/venue.contract';

import { METEORA_COLUMNS, METEORA_THEME, meteoraToRow } from '@/features/meteora/meteora.rows';

/** Meteora's page is 1-based; `MarketQuery.page` follows the shared contract's convention (0-based, defaulting to 0). */
function toMeteoraPage(page: number | undefined): number {
  return (page ?? 0) + 1;
}

export const meteoraAdapter: VenueAdapter<MeteoraPoolSummary> = {
  venueId: 'meteora',
  displayName: 'Meteora',
  kind: 'lp',
  routeBase: '/markets/meteora',
  theme: METEORA_THEME,
  capabilities: { pagination: true, remoteSearch: true, filters: true },

  async listMarkets(query: MarketQuery): Promise<MarketPage<MeteoraPoolSummary>> {
    const result = await meteoraClient.listPools({
      page: toMeteoraPage(query.page),
      pageSize: query.pageSize,
      query: query.query || undefined,
      sortBy: query.sortBy ?? 'volume_24h:desc',
    });

    return {
      items: result.data.items,
      hasNext: result.data.hasNext,
      page: result.data.page - 1,
    };
  },

  identityRefs(markets: readonly MeteoraPoolSummary[]): string[] {
    const refs = new Set<string>();
    for (const pool of markets) {
      refs.add(mintRef(pool.tokenX.address));
      refs.add(mintRef(pool.tokenY.address));
    }
    return Array.from(refs);
  },

  toRow: meteoraToRow,

  search: { mode: 'remote', placeholder: 'Search Meteora pools' },
  columns: METEORA_COLUMNS,
};
