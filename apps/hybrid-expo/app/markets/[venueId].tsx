import { Redirect, useLocalSearchParams } from 'expo-router';

import { VenueMarketListScreen } from '@/features/markets/VenueMarketListScreen';
import { venueRegistry } from '@/features/markets/venue.registry';

/**
 * Catch-all venue list route. Static routes (`markets/pacifica.tsx`,
 * `markets/phoenix.tsx`, `markets/meteora.tsx`) take precedence over this
 * dynamic segment in expo-router, so this only ever matches an id without
 * its own file — `/markets/orca` today, and every future venue with no new
 * screen. This is PRD acceptance criterion 7: adding a venue is a registry
 * entry, not a screen. See
 * docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md.
 */
export default function VenueRoute() {
  const { venueId } = useLocalSearchParams<{ venueId: string }>();

  if (!venueRegistry.isVenueId(venueId)) {
    return <Redirect href="/" />;
  }

  return <VenueMarketListScreen venueId={venueId as string} />;
}
