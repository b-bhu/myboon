import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectNativeSolanaSource } from './walletSourceSelection';

const PRIVY_READY = {
  privyAuthenticated: true,
  privyPreparing: false,
  activationHydrated: true,
  privyConnected: true,
};

describe('native Solana signer selection', () => {
  it('keeps an explicitly connected external Solana wallet selected', () => {
    assert.equal(selectNativeSolanaSource({
      ...PRIVY_READY,
      hasExternalAccount: true,
      privySolanaActive: true,
    }), 'mwa');
  });

  it('does not silently fall back to embedded Solana after external disconnect', () => {
    assert.equal(selectNativeSolanaSource({
      ...PRIVY_READY,
      hasExternalAccount: false,
      privySolanaActive: false,
    }), 'none');
  });

  it('uses embedded Solana only after explicit activation', () => {
    assert.equal(selectNativeSolanaSource({
      ...PRIVY_READY,
      hasExternalAccount: false,
      privySolanaActive: true,
    }), 'privy');
  });
});
