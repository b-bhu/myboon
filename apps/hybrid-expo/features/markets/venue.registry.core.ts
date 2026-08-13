/**
 * Venue adapter registry. Generalizes `features/perps/perps.registry.ts`
 * beyond perps — registering a venue is `createVenueRegistry([...adapters])`,
 * not a new screen.
 *
 * PURE — no react-native imports, `tsx --test`-able.
 */

import type { VenueAdapter } from '@/features/markets/venue.contract';

export interface VenueRegistry {
  get(venueId: string): VenueAdapter | undefined;
  list(): readonly VenueAdapter[];
  isVenueId(value: string | null | undefined): boolean;
}

/**
 * Build a registry from a list of adapters. Throws at construction time on
 * a duplicate `venueId` or a `routeBase` collision — both are configuration
 * bugs, not runtime states callers should have to handle.
 */
export function createVenueRegistry(adapters: readonly VenueAdapter[]): VenueRegistry {
  const byId = new Map<string, VenueAdapter>();
  const routeBases = new Map<string, string>();

  for (const adapter of adapters) {
    if (byId.has(adapter.venueId)) {
      throw new Error(`createVenueRegistry: duplicate venueId "${adapter.venueId}"`);
    }
    const existingVenueForRoute = routeBases.get(adapter.routeBase);
    if (existingVenueForRoute) {
      throw new Error(
        `createVenueRegistry: routeBase "${adapter.routeBase}" is used by both ` +
          `"${existingVenueForRoute}" and "${adapter.venueId}"`,
      );
    }
    byId.set(adapter.venueId, adapter);
    routeBases.set(adapter.routeBase, adapter.venueId);
  }

  const ids = new Set(byId.keys());

  return {
    get(venueId: string): VenueAdapter | undefined {
      return byId.get(venueId);
    },
    list(): readonly VenueAdapter[] {
      return adapters;
    },
    isVenueId(value: string | null | undefined): boolean {
      return typeof value === 'string' && ids.has(value);
    },
  };
}
