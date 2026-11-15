/**
 * Unit tests for cross-venue total aggregation (issue #653).
 *
 * Covers the combined total across venues, a venue failing, a venue returning
 * no positions, a retry in flight, and the partial-total signal.
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 *
 * Only React-free modules are imported — the screen that renders these totals
 * is verified on device, not here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeWalletTotals, isTotalPartial } from './wallet.totals';
import type {
  WalletProtocolId,
  WalletSourceState,
  WalletSourcesState,
} from './wallet.types';

const T0 = 1_700_000_000_000;

function idle(): WalletSourceState {
  return { status: 'idle', valueUsd: null, resolvedAt: null, error: null, detail: null };
}

function resolved(valueUsd: number, resolvedAt = T0): WalletSourceState {
  return { status: 'resolved', valueUsd, resolvedAt, error: null, detail: null };
}

/** Never resolved, then failed — nothing to retain. */
function failedCold(): WalletSourceState {
  return { status: 'failed', valueUsd: null, resolvedAt: null, error: 'boom', detail: null };
}

/** Resolved once, then a refresh failed — keeps its last known value. */
function stale(valueUsd: number, resolvedAt = T0): WalletSourceState {
  return { status: 'stale', valueUsd, resolvedAt, error: 'boom', detail: null };
}

/** Retry in flight over a previously resolved value. */
function loadingWarm(valueUsd: number, resolvedAt = T0): WalletSourceState {
  return { status: 'loading', valueUsd, resolvedAt, error: null, detail: null };
}

function loadingCold(): WalletSourceState {
  return { status: 'loading', valueUsd: null, resolvedAt: null, error: null, detail: null };
}

function sources(overrides: Partial<Record<WalletProtocolId, WalletSourceState>> = {}): WalletSourcesState {
  return {
    spot: idle(),
    meteora: idle(),
    phoenix: idle(),
    pacifica: idle(),
    polymarket: idle(),
    ...overrides,
  };
}

describe('computeWalletTotals', () => {
  it('sums every venue that holds a value, and the mix shares add to 1', () => {
    const totals = computeWalletTotals(sources({
      spot: resolved(100),
      phoenix: resolved(300),
      polymarket: resolved(100),
    }));

    assert.equal(totals.totalUsd, 500);
    assert.equal(totals.mix.spot, 0.2);
    assert.equal(totals.mix.phoenix, 0.6);
    assert.equal(totals.mix.polymarket, 0.2);
    const shares = Object.values(totals.mix).reduce((sum, share) => sum + share, 0);
    assert.ok(Math.abs(shares - 1) < 1e-9);
  });

  it('is null — not zero — when nothing has resolved yet', () => {
    const totals = computeWalletTotals(sources());
    assert.equal(totals.totalUsd, null);
    assert.deepEqual(totals.mix, {});
    assert.equal(totals.lastResolvedAt, null);
  });

  it('a venue that failed without ever resolving is excluded, the rest still total', () => {
    const totals = computeWalletTotals(sources({
      spot: resolved(250),
      pacifica: failedCold(),
    }));

    assert.equal(totals.totalUsd, 250);
    assert.equal(totals.mix.pacifica, undefined);
  });

  it('a venue holding no positions counts as a real zero, not as missing', () => {
    const totals = computeWalletTotals(sources({
      spot: resolved(80),
      polymarket: resolved(0),
    }));

    assert.equal(totals.totalUsd, 80);
    // It resolved, so it appears in the mix — at a 0 share.
    assert.equal(totals.mix.polymarket, 0);
  });

  it('a stale venue keeps contributing its last known value', () => {
    const totals = computeWalletTotals(sources({
      spot: resolved(100),
      meteora: stale(50),
    }));

    assert.equal(totals.totalUsd, 150);
  });

  it('a retry in flight never makes the total dip', () => {
    const before = computeWalletTotals(sources({ spot: resolved(100), phoenix: resolved(100) }));
    const during = computeWalletTotals(sources({ spot: resolved(100), phoenix: loadingWarm(100) }));

    assert.equal(before.totalUsd, 200);
    assert.equal(during.totalUsd, 200);
  });

  it('reports the most recent resolve time across venues', () => {
    const totals = computeWalletTotals(sources({
      spot: resolved(10, T0),
      phoenix: resolved(10, T0 + 5_000),
      polymarket: resolved(10, T0 - 5_000),
    }));

    assert.equal(totals.lastResolvedAt, T0 + 5_000);
  });

  it('every venue at zero gives a zero total with zero shares, not a divide-by-zero', () => {
    const totals = computeWalletTotals(sources({ spot: resolved(0), phoenix: resolved(0) }));

    assert.equal(totals.totalUsd, 0);
    assert.equal(totals.mix.spot, 0);
    assert.equal(totals.mix.phoenix, 0);
  });
});

describe('isTotalPartial', () => {
  it('is false when every venue with a request has resolved', () => {
    assert.equal(isTotalPartial(sources({ spot: resolved(100), phoenix: resolved(50) })), false);
  });

  it('is false before anything resolves — there is no total to qualify yet', () => {
    assert.equal(isTotalPartial(sources({ spot: loadingCold() })), false);
  });

  it('is true when one venue failed while another has a value', () => {
    assert.equal(isTotalPartial(sources({ spot: resolved(100), pacifica: failedCold() })), true);
  });

  it('is true when one venue is still loading cold while another has a value', () => {
    assert.equal(isTotalPartial(sources({ spot: resolved(100), meteora: loadingCold() })), true);
  });

  it('is true when a venue is stale, since its value may be out of date', () => {
    assert.equal(isTotalPartial(sources({ spot: resolved(100), meteora: stale(20) })), true);
  });

  it('is false for a retry over a value we already have', () => {
    assert.equal(isTotalPartial(sources({ spot: resolved(100), phoenix: loadingWarm(40) })), false);
  });

  it('an unconnected venue sitting idle does not make the total partial', () => {
    // Polymarket with no authenticated client stays idle — that is the normal
    // state for a venue the user has not connected, not a missing value.
    assert.equal(isTotalPartial(sources({ spot: resolved(100), polymarket: idle() })), false);
  });
});
