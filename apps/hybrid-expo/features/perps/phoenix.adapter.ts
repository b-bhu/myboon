/**
 * Phoenix VenueAdapter — assembles the pure row logic in `phoenix.rows.ts`
 * with Phoenix's existing fetcher (`fetchPhoenixMarkets`). Thin by design:
 * all the testable logic lives in the rows module. See
 * docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md.
 */

import { fetchPhoenixMarkets, type PhoenixMarket } from '@/features/perps/phoenix.api';
import { perpRef } from '@/lib/token-identity';

import type { MarketPage, MarketQuery, VenueAdapter } from '@/features/markets/venue.contract';

import {
  PHOENIX_COLUMNS,
  phoenixMatchesQuery,
  phoenixToRow,
  sortByOpenInterestDesc,
} from '@/features/perps/phoenix.rows';

export const phoenixAdapter: VenueAdapter<PhoenixMarket> = {
  venueId: 'phoenix',
  displayName: 'Phoenix',
  kind: 'perps',
  routeBase: '/markets/phoenix',
  capabilities: { pagination: false, remoteSearch: false, filters: false },

  async listMarkets(_query: MarketQuery): Promise<MarketPage<PhoenixMarket>> {
    const items = await fetchPhoenixMarkets();
    return { items, hasNext: false, page: 0 };
  },

  identityRefs(markets: readonly PhoenixMarket[]): string[] {
    return Array.from(new Set(markets.map((market) => perpRef(market.venueSymbol || market.symbol))));
  },

  toRow: phoenixToRow,
  sortRows(rows, markets) {
    const order = new Map(
      [...markets].sort(sortByOpenInterestDesc).map((market, index) => [market.symbol, index]),
    );
    return [...rows].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  },
  matchesQuery: phoenixMatchesQuery,

  search: { mode: 'local', placeholder: 'Search Phoenix...' },
  columns: PHOENIX_COLUMNS,
};
