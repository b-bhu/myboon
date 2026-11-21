/**
 * Pure tests for the wallet source-state mapping (issue #767): ok,
 * unavailable, not connected, and the rule that a failed refresh never blanks
 * the value a previous response delivered — it becomes stale and keeps it.
 *
 * Only the mapping is tested here; the hook and the screens are verified by
 * review and on device, per the issue. Never blanked also means a stale state
 * keeps its `asOf` while the venue keeps failing, and the next success
 * replaces it with a fresh `ok` value.
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { walletSummaryFixture } from '@myboon/shared/wallet-summary';
import type { WalletSummary } from '@myboon/shared/wallet-summary';

import { mapWalletSummaryApps } from './wallet-summary.mapping';
import type { WalletAppSourceStates } from './wallet-summary.mapping';

function cloneWith(mutate: (summary: WalletSummary) => void): WalletSummary {
  const summary = structuredClone(walletSummaryFixture);
  mutate(summary);
  return summary;
}

const FETCHED_AT = walletSummaryFixture.fetchedAt;

describe('mapWalletSummaryApps', () => {
  it('maps every ok app to its value, summary and the server fetchedAt', () => {
    const mapped = mapWalletSummaryApps(walletSummaryFixture);

    const keys = ['polymarket', 'phoenix', 'pacifica', 'meteora', 'spot'] as const;
    for (const key of keys) {
      const state = mapped[key] as WalletAppSourceStates['polymarket'];
      assert.equal(state.status, 'ok', key);
      assert.equal(state.valueUsd, walletSummaryFixture.apps[key].valueUsd, key);
      assert.deepEqual(state.summary, walletSummaryFixture.apps[key].summary, key);
      assert.equal(state.asOf, FETCHED_AT, key);
      assert.equal(state.error, null, key);
    }
  });

  it('maps a venue that could not be served with its error, when nothing was known', () => {
    const failed = cloneWith((summary) => {
      summary.apps.spot = {
        status: 'unavailable',
        valueUsd: null,
        summary: null,
        error: 'The spot data provider is down.',
      };
    });

    const mapped = mapWalletSummaryApps(failed);
    assert.equal(mapped.spot.status, 'unavailable');
    assert.equal(mapped.spot.error, 'The spot data provider is down.');
    assert.equal(mapped.spot.valueUsd, null);
    assert.equal(mapped.spot.summary, null);
    assert.equal(mapped.spot.asOf, null);
    // The other apps never blocked or waited on the failing one.
    assert.equal(mapped.phoenix.status, 'ok');

    // Still nothing shown after a second failure, so still not stale.
    const again = mapWalletSummaryApps(failed, mapped);
    assert.equal(again.spot.status, 'unavailable');
    assert.equal(again.spot.valueUsd, null);
  });

  it('maps not_connected with no value and no error, and never carries an old value forward', () => {
    const disconnected = cloneWith((summary) => {
      summary.apps.phoenix = { status: 'not_connected', valueUsd: null, summary: null };
    });

    const mapped = mapWalletSummaryApps(disconnected);
    assert.equal(mapped.phoenix.status, 'not_connected');
    assert.equal(mapped.phoenix.valueUsd, null);
    assert.equal(mapped.phoenix.summary, null);
    assert.equal(mapped.phoenix.asOf, null);
    assert.equal(mapped.phoenix.error, null);

    // A previous ok value disappears with the account: not_connected is not a
    // failure, it is a state, and the design gives it no row.
    const afterOk = mapWalletSummaryApps(disconnected, mapWalletSummaryApps(walletSummaryFixture));
    assert.equal(afterOk.phoenix.status, 'not_connected');
    assert.equal(afterOk.phoenix.valueUsd, null);
    assert.equal(afterOk.phoenix.summary, null);
  });

  it('keeps the last good value as stale when a refresh fails after it resolved', () => {
    const first = mapWalletSummaryApps(walletSummaryFixture);
    const refresh = cloneWith((summary) => {
      summary.fetchedAt = '2026-07-21T12:05:00Z';
      summary.apps.spot = { status: 'unavailable', valueUsd: null, summary: null, error: 'HTTP_502' };
      summary.apps.phoenix.valueUsd = 43100.1;
    });

    const mapped = mapWalletSummaryApps(refresh, first);
    assert.equal(mapped.spot.status, 'stale');
    // The value the person is looking at is not blanked.
    assert.equal(mapped.spot.valueUsd, first.spot.valueUsd);
    assert.equal(mapped.spot.valueUsd, walletSummaryFixture.apps.spot.valueUsd);
    assert.deepEqual(mapped.spot.summary, walletSummaryFixture.apps.spot.summary);
    // The age keeps pointing at the last good fetch, not the failed one.
    assert.equal(mapped.spot.asOf, first.spot.asOf);
    assert.equal(mapped.spot.asOf, FETCHED_AT);
    assert.equal(mapped.spot.error, null);
    // A failing app never blocks or pollutes an app that answered.
    assert.equal(mapped.phoenix.status, 'ok');
    assert.equal(mapped.phoenix.valueUsd, 43100.1);
    assert.equal(mapped.phoenix.asOf, refresh.fetchedAt);
  });

  it('stays stale with the same asOf while the venue keeps failing, and recovers to ok on the next success', () => {
    const first = mapWalletSummaryApps(walletSummaryFixture);
    const failing = cloneWith((summary) => {
      summary.apps.meteora = { status: 'unavailable', valueUsd: null, summary: null, error: 'Meteora is unreachable.' };
    });
    const stale = mapWalletSummaryApps(failing, first);
    assert.equal(stale.meteora.status, 'stale');

    const stillFailing = mapWalletSummaryApps(failing, stale);
    assert.equal(stillFailing.meteora.status, 'stale');
    assert.equal(stillFailing.meteora.valueUsd, stale.meteora.valueUsd);
    assert.deepEqual(stillFailing.meteora.summary, stale.meteora.summary);
    assert.equal(stillFailing.meteora.asOf, stale.meteora.asOf);

    const recovered = cloneWith((summary) => {
      summary.fetchedAt = '2026-07-21T12:10:00Z';
      summary.apps.meteora.valueUsd = 10600;
    });
    const fresh = mapWalletSummaryApps(recovered, stale);
    assert.equal(fresh.meteora.status, 'ok');
    assert.equal(fresh.meteora.valueUsd, 10600);
    assert.equal(fresh.meteora.asOf, recovered.fetchedAt);
    assert.equal(fresh.meteora.error, null);
  });
});
