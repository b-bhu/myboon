/**
 * Polymarket VenueAdapter — the list-side seam over the existing featured
 * feed (`fetchFeaturedMarkets`). Polymarket keeps its own screens (the static
 * `app/markets/polymarket` route renders `PolymarketDiscoverScreen`), so
 * registering this adapter joins the venue to the shared list contract
 * without touching routing. See issue #650.
 */

import { fetchFeaturedMarkets } from './polymarket.api';
import type { FeedItem } from './polymarket.types';
import {
  POLYMARKET_COLUMNS,
  POLYMARKET_THEME,
  polymarketMatchesQuery,
  polymarketToRow,
  sortFeedItems,
} from './polymarket.rows';
import type { MarketPage, MarketQuery, VenueAdapter } from '@/features/markets/venue.contract';

export const polymarketAdapter: VenueAdapter<FeedItem> = {
  venueId: 'polymarket',
  displayName: 'Polymarket',
  kind: 'prediction',
  routeBase: '/markets/polymarket',
  theme: POLYMARKET_THEME,
  capabilities: { pagination: false, remoteSearch: true, filters: true },

  async listMarkets(query: MarketQuery): Promise<MarketPage<FeedItem>> {
    const feed = await fetchFeaturedMarkets();
    // One fetch, no pagination; closed markets stay out of the list.
    const items = sortFeedItems(feed.items.filter((market) => market.status !== 'closed'));
    return { items, hasNext: false, page: query.page ?? 0 };
  },

  // Prediction markets resolve no token identities — rows carry the feed's
  // own market/team imagery with letter fallbacks.
  identityRefs() {
    return [];
  },

  toRow: polymarketToRow,

  matchesQuery: polymarketMatchesQuery,

  // Remote search lives in `fetchPolymarketSearch`; the discover screen owns
  // it today. The placeholder mirrors the discover screen's main search field.
  search: { mode: 'remote', placeholder: 'Team, coin, person, or question' },
  columns: POLYMARKET_COLUMNS,
};
