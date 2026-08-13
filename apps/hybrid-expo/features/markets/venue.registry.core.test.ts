/**
 * Unit tests for the venue adapter registry.
 *
 * Run: pnpm --filter hybrid-expo test:markets
 *
 * React-free, react-native-free — only imports venue.contract.ts and
 * venue.registry.core.ts, both pure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createVenueRegistry } from './venue.registry.core';
import type { VenueAdapter } from './venue.contract';

function stubAdapter(overrides: Partial<VenueAdapter> = {}): VenueAdapter {
  return {
    venueId: 'orca',
    displayName: 'Orca',
    kind: 'spot',
    routeBase: '/markets/orca',
    capabilities: { pagination: false, remoteSearch: false, filters: false },
    async listMarkets() {
      return { items: [], hasNext: false, page: 1 };
    },
    identityRefs() {
      return [];
    },
    toRow() {
      return {
        key: 'stub',
        lead: { kind: 'token', identityRef: 'mint:stub', venueIconUrl: null, letter: 'S' },
        title: 'Stub',
        cells: [
          { text: '--', width: 10 },
          { text: '--', width: 10 },
          { text: '--', width: 10 },
        ],
        href: '/markets/orca/stub',
        a11yLabel: 'Stub market',
      };
    },
    search: { mode: 'local', placeholder: 'Search' },
    columns: [
      { key: 'price', label: 'Price', width: 80 },
      { key: 'change', label: 'Change', width: 58 },
      { key: 'vol', label: 'Vol', width: 60 },
    ],
    ...overrides,
  };
}

describe('createVenueRegistry', () => {
  it('registers adapters and looks them up by venueId', () => {
    const pacifica = stubAdapter({ venueId: 'pacifica', routeBase: '/markets/pacifica' });
    const phoenix = stubAdapter({ venueId: 'phoenix', routeBase: '/markets/phoenix' });
    const registry = createVenueRegistry([pacifica, phoenix]);

    assert.equal(registry.get('pacifica'), pacifica);
    assert.equal(registry.get('phoenix'), phoenix);
    assert.equal(registry.get('meteora'), undefined);
  });

  it('list() returns every registered adapter in order', () => {
    const pacifica = stubAdapter({ venueId: 'pacifica', routeBase: '/markets/pacifica' });
    const phoenix = stubAdapter({ venueId: 'phoenix', routeBase: '/markets/phoenix' });
    const meteora = stubAdapter({ venueId: 'meteora', routeBase: '/markets/meteora' });
    const registry = createVenueRegistry([pacifica, phoenix, meteora]);

    assert.deepEqual(registry.list(), [pacifica, phoenix, meteora]);
  });

  it('isVenueId is true for registered ids and false otherwise', () => {
    const registry = createVenueRegistry([
      stubAdapter({ venueId: 'pacifica', routeBase: '/markets/pacifica' }),
    ]);

    assert.equal(registry.isVenueId('pacifica'), true);
    assert.equal(registry.isVenueId('orca'), false);
    assert.equal(registry.isVenueId(null), false);
    assert.equal(registry.isVenueId(undefined), false);
    assert.equal(registry.isVenueId(''), false);
  });

  it('a stub fourth venue (Orca) registers with no new screen — proves plug-and-play', () => {
    const pacifica = stubAdapter({ venueId: 'pacifica', routeBase: '/markets/pacifica' });
    const phoenix = stubAdapter({ venueId: 'phoenix', routeBase: '/markets/phoenix' });
    const meteora = stubAdapter({ venueId: 'meteora', routeBase: '/markets/meteora' });
    const orca = stubAdapter({ venueId: 'orca', routeBase: '/markets/orca' });
    const registry = createVenueRegistry([pacifica, phoenix, meteora, orca]);

    assert.equal(registry.isVenueId('orca'), true);
    assert.equal(registry.get('orca'), orca);
    assert.equal(registry.list().length, 4);
  });

  it('rejects duplicate venueId at construction time', () => {
    assert.throws(
      () =>
        createVenueRegistry([
          stubAdapter({ venueId: 'pacifica', routeBase: '/markets/pacifica' }),
          stubAdapter({ venueId: 'pacifica', routeBase: '/markets/pacifica-2' }),
        ]),
      /duplicate venueId "pacifica"/,
    );
  });

  it('rejects a routeBase collision across two different venueIds', () => {
    assert.throws(
      () =>
        createVenueRegistry([
          stubAdapter({ venueId: 'pacifica', routeBase: '/markets/shared' }),
          stubAdapter({ venueId: 'phoenix', routeBase: '/markets/shared' }),
        ]),
      /routeBase "\/markets\/shared" is used by both "pacifica" and "phoenix"/,
    );
  });

  it('an empty adapter list produces a registry with nothing registered', () => {
    const registry = createVenueRegistry([]);
    assert.equal(registry.list().length, 0);
    assert.equal(registry.isVenueId('pacifica'), false);
    assert.equal(registry.get('pacifica'), undefined);
  });
});
