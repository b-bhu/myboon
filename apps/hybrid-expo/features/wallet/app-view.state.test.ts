/**
 * Pure reducer test for the Wallet app-view state (issue #771).
 *
 * Covers the three behaviours the issue names: select, back, and "wallet
 * change resets it" — a different wallet id (or a disconnect) clears the
 * selection, re-syncing the same wallet id must not.
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { initialWalletAppView, walletAppViewReducer } from './app-view.state';

describe('walletAppViewReducer', () => {
  it('starts with no app selected (none)', () => {
    assert.deepEqual(initialWalletAppView, { walletId: null, selectedApp: null });
  });

  it('select opens an app by id, generically', () => {
    const opened = walletAppViewReducer(initialWalletAppView, {
      type: 'select',
      app: 'polymarket',
    });
    assert.equal(opened.selectedApp, 'polymarket');
  });

  it('select swaps the open app without needing back first', () => {
    const first = walletAppViewReducer(initialWalletAppView, { type: 'select', app: 'polymarket' });
    const second = walletAppViewReducer(first, { type: 'select', app: 'phoenix' });
    assert.equal(second.selectedApp, 'phoenix');
  });

  it('back clears the selection but keeps the wallet id', () => {
    const state = { walletId: 'wallet-a', selectedApp: 'polymarket' };
    assert.deepEqual(walletAppViewReducer(state, { type: 'back' }), {
      walletId: 'wallet-a',
      selectedApp: null,
    });
  });

  it('back with nothing selected stays clear', () => {
    assert.deepEqual(walletAppViewReducer(initialWalletAppView, { type: 'back' }), {
      walletId: null,
      selectedApp: null,
    });
  });

  it('a different wallet resets the selection', () => {
    const state = { walletId: 'wallet-a', selectedApp: 'polymarket' };
    const next = walletAppViewReducer(state, { type: 'wallet-change', walletId: 'wallet-b' });
    assert.deepEqual(next, { walletId: 'wallet-b', selectedApp: null });
  });

  it('the same wallet re-sync does not reset the selection', () => {
    const state = { walletId: 'wallet-a', selectedApp: 'polymarket' };
    assert.equal(
      walletAppViewReducer(state, { type: 'wallet-change', walletId: 'wallet-a' }),
      state,
    );
  });

  it('a disconnect (a null wallet id) resets the selection', () => {
    const state = { walletId: 'wallet-a', selectedApp: 'meteora' };
    const next = walletAppViewReducer(state, { type: 'wallet-change', walletId: null });
    assert.equal(next.selectedApp, null);
    assert.equal(next.walletId, null);
  });
});
