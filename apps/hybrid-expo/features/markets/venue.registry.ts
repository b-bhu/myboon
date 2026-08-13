/**
 * The app's venue registry — instantiates `createVenueRegistry` with every
 * registered adapter. Adding a venue is adding one entry here. See
 * docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md.
 */

import { pacificaAdapter } from '@/features/perps/pacifica.adapter';
import { phoenixAdapter } from '@/features/perps/phoenix.adapter';
import { meteoraAdapter } from '@/features/meteora/meteora.adapter';
import { orcaAdapter } from '@/features/orca/orca.adapter';

import { createVenueRegistry } from '@/features/markets/venue.registry.core';

export const venueRegistry = createVenueRegistry([
  pacificaAdapter,
  phoenixAdapter,
  meteoraAdapter,
  orcaAdapter,
]);
