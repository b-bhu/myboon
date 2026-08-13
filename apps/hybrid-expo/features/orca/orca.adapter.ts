/**
 * Orca VenueAdapter — the plug-and-play PROOF (PRD acceptance criterion 7 /
 * Sequencing step 5). Registering Orca is this adapter file plus a registry
 * entry: no new screen, no new style block. See
 * docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md.
 */

import type { MarketPage, MarketQuery, VenueAdapter } from '@/features/markets/venue.contract';

import { ORCA_COLUMNS, orcaListMarkets, orcaToRow, type OrcaStubMarket } from '@/features/orca/orca.rows';

export const orcaAdapter: VenueAdapter<OrcaStubMarket> = {
  venueId: 'orca',
  displayName: 'Orca',
  kind: 'lp',
  routeBase: '/markets/orca',
  capabilities: { pagination: false, remoteSearch: false, filters: false },

  async listMarkets(_query: MarketQuery): Promise<MarketPage<OrcaStubMarket>> {
    return orcaListMarkets(__DEV__);
  },

  identityRefs(markets: readonly OrcaStubMarket[]): string[] {
    return markets.map((market) => market.address);
  },

  toRow: orcaToRow,

  search: { mode: 'local', placeholder: 'Search Orca pools' },
  columns: ORCA_COLUMNS,
};
