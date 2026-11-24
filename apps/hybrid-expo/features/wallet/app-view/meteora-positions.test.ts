/**
 * Pure test for the Meteora positions data hook's helpers (issue #901).
 *
 * Covers the cases the issue names — the URL helper (address present,
 * address null) and applyMeteoraPositionsResponse for `ok`, `not_connected`,
 * `unavailable` and a failed refresh — plus the failure before any good
 * load (positions stay null) and the standard fallback texts. No hook
 * rendering test and no UI: the tab itself is issue #902.
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMeteoraPositionsResponse,
  meteoraPositionsUrl,
  type MeteoraPositionsState,
} from './meteora-positions';
import type {
  MeteoraPositionsResponse,
  WalletMeteoraPosition,
} from '@myboon/shared/wallet-summary';

const SOL = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

function positionAt(address: string): WalletMeteoraPosition {
  return {
    address,
    poolAddress: `pool-${address}`,
    poolName: 'SOL/USDC',
    minPrice: 100,
    maxPrice: 200,
    lowerBinId: 8388608,
    upperBinId: 8388650,
    outOfRange: false,
    pnlUsd: 1.5,
    pnlPct: 0.4,
    feeTvl24hPct: 0.2,
    poolUnclaimedFeesUsd: 0.3,
  };
}

const POSITIONS: WalletMeteoraPosition[] = [positionAt('pos-1'), positionAt('pos-2')];

const INITIAL: MeteoraPositionsState = { positions: null, totalPools: 0, hasMore: false, error: null };
const LOADED: MeteoraPositionsState = { positions: POSITIONS, totalPools: 12, hasMore: true, error: null };

describe('meteoraPositionsUrl', () => {
  it('builds the positions request for an address', () => {
    assert.equal(
      meteoraPositionsUrl('https://api.myboon.app', SOL),
      `https://api.myboon.app/wallet/meteora/positions?solana=${SOL}`,
    );
  });

  it('gives null for a null address (no request)', () => {
    assert.equal(meteoraPositionsUrl('https://api.myboon.app', null), null);
  });
});

describe('applyMeteoraPositionsResponse', () => {
  it('ok: takes the response list, totals and hasMore, clears the error', () => {
    const ok: MeteoraPositionsResponse = {
      status: 'ok',
      positions: POSITIONS,
      totalPools: 12,
      hasMore: true,
    };
    assert.deepEqual(applyMeteoraPositionsResponse(INITIAL, ok), LOADED);
    assert.deepEqual(applyMeteoraPositionsResponse({ ...INITIAL, error: 'gone' }, ok), LOADED);
  });

  it('not_connected: empty list and no error', () => {
    const next = applyMeteoraPositionsResponse(LOADED, {
      status: 'not_connected',
      positions: [],
      totalPools: 0,
      hasMore: false,
    });
    assert.deepEqual(next, { positions: [], totalPools: 0, hasMore: false, error: null });
  });

  it('unavailable: empty list and the response error text', () => {
    const next = applyMeteoraPositionsResponse(LOADED, {
      status: 'unavailable',
      positions: [],
      totalPools: 0,
      hasMore: false,
      error: 'upstream failed',
    });
    assert.deepEqual(next, { positions: [], totalPools: 0, hasMore: false, error: 'upstream failed' });
  });

  it('unavailable without an error text uses the standard message', () => {
    const next = applyMeteoraPositionsResponse(INITIAL, {
      status: 'unavailable',
      positions: [],
      totalPools: 0,
      hasMore: false,
    });
    assert.deepEqual(next, { positions: [], totalPools: 0, hasMore: false, error: 'Meteora positions are unavailable.' });
  });

  it('a failed refresh with an error body keeps the held list', () => {
    // What GET /wallet/meteora/positions answers on 400/429: no status field.
    const rateLimited = { error: 'Wallet summary rate limit exceeded' } as unknown as MeteoraPositionsResponse;
    const next = applyMeteoraPositionsResponse(LOADED, rateLimited);
    assert.deepEqual(next, { ...LOADED, error: 'Wallet summary rate limit exceeded' });
  });

  it('a dropped network call keeps the held list and uses the failure text', () => {
    assert.deepEqual(applyMeteoraPositionsResponse(LOADED, null), {
      ...LOADED,
      error: 'Meteora positions request failed.',
    });
  });

  it('a failure before any good load leaves positions null', () => {
    assert.deepEqual(applyMeteoraPositionsResponse(INITIAL, null), {
      positions: null,
      totalPools: 0,
      hasMore: false,
      error: 'Meteora positions request failed.',
    });
  });
});
