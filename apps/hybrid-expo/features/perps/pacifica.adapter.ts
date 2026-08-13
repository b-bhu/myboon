/**
 * Pacifica VenueAdapter — assembles the pure row logic in `pacifica.rows.ts`
 * with Pacifica's existing fetcher (`fetchPerpsMarkets`). Thin by design:
 * all the testable logic lives in the rows module. See
 * docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md.
 */

import { fetchPerpsMarkets } from '@/features/perps/perps.public-api';
import { perpRef } from '@/lib/token-identity';

import type { PerpsMarket } from '@/features/perps/perps.types';
import type { MarketPage, MarketQuery, VenueAdapter } from '@/features/markets/venue.contract';

import {
  PACIFICA_COLUMNS,
  pacificaMatchesQuery,
  pacificaToRow,
  sortByOpenInterestDesc,
} from '@/features/perps/pacifica.rows';

export const pacificaAdapter: VenueAdapter<PerpsMarket> = {
  venueId: 'pacifica',
  displayName: 'Pacifica',
  kind: 'perps',
  routeBase: '/markets/pacifica',
  capabilities: { pagination: false, remoteSearch: false, filters: false },

  async listMarkets(_query: MarketQuery): Promise<MarketPage<PerpsMarket>> {
    const items = await fetchPerpsMarkets();
    return { items, hasNext: false, page: 0 };
  },

  identityRefs(markets: readonly PerpsMarket[]): string[] {
    return Array.from(new Set(markets.map((market) => perpRef(market.symbol))));
  },

  toRow: pacificaToRow,
  sortRows(rows, markets) {
    const order = new Map(
      [...markets].sort(sortByOpenInterestDesc).map((market, index) => [market.symbol, index]),
    );
    return [...rows].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  },
  matchesQuery: pacificaMatchesQuery,

  search: { mode: 'local', placeholder: 'Search markets...' },
  columns: PACIFICA_COLUMNS,
};
