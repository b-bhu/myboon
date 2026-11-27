/**
 * Unit tests for walletSourcesFromSummary (issue #912).
 *
 * One case per mapped app status (ok, stale, unavailable, not_connected) plus
 * the three before-answer states, each checked through the total rule Home
 * actually runs (computeWalletTotals / isTotalPartial from wallet.totals.ts).
 *
 * Run: cd apps/hybrid-expo && npx tsx --test features/wallet/wallet-sources-from-summary.test.ts features/wallet/wallet.totals.test.ts
 *
 * Only React-free modules — the hook that calls these rules is exercised by
 * useWalletSummary's contract; no render or scroll test (issue #912).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { walletSourcesFromSummary } from './wallet-sources-from-summary';
import type {
  WalletAppSourceState,
  WalletAppSourceStates,
  WalletAppSourceStatus,
} from './wallet-summary.mapping';
import { computeWalletTotals, isTotalPartial } from './wallet.totals';
import { WALLET_PROTOCOL_IDS, type WalletSourcesState } from './wallet.types';

const T0 = 1_700_000_000_000;
const AS_OF = new Date(T0).toISOString();

/** A mapped app state; the per-app summary slot stays null (never used here). */
function appState(
  status: WalletAppSourceStatus,
  valueUsd: number | null,
  asOf: string | null = AS_OF,
  error: string | null = null,
): WalletAppSourceState<never> {
  return { status, valueUsd, summary: null, asOf, error };
}

/** Baseline: every app ok (100 + 200 + 300 + 50 + 150 = 800), spot overridden. */
function mappedStates(overrides: Partial<WalletAppSourceStates> = {}): WalletAppSourceStates {
  return {
    polymarket: appState('ok', 100),
    phoenix: appState('ok', 200),
    pacifica: appState('ok', 300),
    meteora: appState('ok', 50),
    spot: appState('ok', 150),
    ...overrides,
  };
}

describe('walletSourcesFromSummary', () => {
  it('every app ok: the total is the sum of the app values, nothing partial', () => {
    const sources = walletSourcesFromSummary(mappedStates(), 'loading');

    const totals = computeWalletTotals(sources);
    assert.equal(totals.totalUsd, 800);
    assert.equal(isTotalPartial(sources), false);
    // resolvedAt is Date.parse(asOf) — Home's "as of" label runs on it.
    assert.equal(sources.spot.status, 'resolved');
    assert.equal(sources.spot.valueUsd, 150);
    assert.equal(sources.spot.resolvedAt, T0);
    assert.equal(sources.spot.error, null);
    assert.equal(sources.spot.detail, null);
  });

  it('an unparsable asOf resolves at 0 and its value still counts', () => {
    const sources = walletSourcesFromSummary(
      mappedStates({ spot: appState('ok', 150, 'not-a-date') }),
      'loading',
    );

    assert.equal(sources.spot.resolvedAt, 0);
    assert.equal(computeWalletTotals(sources).totalUsd, 800);
  });

  it('a stale app keeps its last value in the total and marks it partial', () => {
    const sources = walletSourcesFromSummary(
      mappedStates({ meteora: appState('stale', 50, AS_OF, 'Meteora offline') }),
      'loading',
    );

    const totals = computeWalletTotals(sources);
    assert.equal(totals.totalUsd, 800);
    assert.equal(isTotalPartial(sources), true);
    assert.equal(sources.meteora.status, 'stale');
    assert.equal(sources.meteora.valueUsd, 50);
    // The stale state's error travels on, so the row can say why its value is stale.
    assert.equal(sources.meteora.error, 'Meteora offline');
  });

  it('an unavailable app with nothing held adds nothing and marks it partial', () => {
    const sources = walletSourcesFromSummary(
      mappedStates({ meteora: appState('unavailable', null, null, 'Meteora offline') }),
      'loading',
    );

    assert.equal(computeWalletTotals(sources).totalUsd, 750);
    assert.equal(isTotalPartial(sources), true);
    assert.equal(sources.meteora.status, 'failed');
    assert.equal(sources.meteora.valueUsd, null);
    assert.equal(sources.meteora.resolvedAt, null);
  });

  it('a not_connected app adds nothing and does not make the total partial', () => {
    const sources = walletSourcesFromSummary(
      mappedStates({ meteora: appState('not_connected', null, null) }),
      'loading',
    );

    assert.equal(computeWalletTotals(sources).totalUsd, 750);
    assert.equal(isTotalPartial(sources), false);
    assert.equal(sources.meteora.status, 'idle');
    assert.equal(sources.meteora.error, null);
  });

  describe('before the first answer (states null)', () => {
    function expectAll(
      sources: WalletSourcesState,
      status: 'loading' | 'idle' | 'failed',
    ) {
      for (const id of WALLET_PROTOCOL_IDS) {
        assert.equal(sources[id].status, status);
        assert.equal(sources[id].valueUsd, null);
        assert.equal(sources[id].resolvedAt, null);
        assert.equal(sources[id].error, null);
        assert.equal(sources[id].detail, null);
      }
      const totals = computeWalletTotals(sources);
      assert.equal(totals.totalUsd, null);
      assert.equal(isTotalPartial(sources), false);
    }

    it('loading: every source is loading and the total is null, not zero', () => {
      expectAll(walletSourcesFromSummary(null, 'loading'), 'loading');
    });

    it('idle: every source is idle when there is no address at all', () => {
      expectAll(walletSourcesFromSummary(null, 'idle'), 'idle');
    });

    it('failed: every source is failed when the first request failed with nothing held', () => {
      expectAll(walletSourcesFromSummary(null, 'failed'), 'failed');
    });
  });
});
