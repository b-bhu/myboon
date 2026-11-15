import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getPolymarketProfileAccountState } from './profile-state';

const base = {
  signerStatus: 'needs_connection' as const,
  isPrivyUser: false,
  hasSigner: false,
  polymarketReady: false,
  polymarketLoading: false,
  sessionExpired: false,
};

describe('Polymarket profile account state', () => {
  it('keeps hook hydration separate from signed out', () => {
    assert.equal(getPolymarketProfileAccountState({ ...base, signerStatus: 'preparing' }), 'preparing');
  });

  it('distinguishes signed out from an authenticated dormant EVM wallet', () => {
    assert.equal(getPolymarketProfileAccountState(base), 'signed_out');
    assert.equal(getPolymarketProfileAccountState({ ...base, isPrivyUser: true }), 'wallet_setup');
  });

  it('distinguishes an EVM signer from a configured Polymarket session', () => {
    assert.equal(getPolymarketProfileAccountState({ ...base, signerStatus: 'ready', hasSigner: true }), 'polymarket_setup');
  });

  it('keeps an expired session visible as reconnectable rather than signed out', () => {
    assert.equal(getPolymarketProfileAccountState({
      ...base,
      signerStatus: 'ready',
      hasSigner: true,
      polymarketReady: true,
      sessionExpired: true,
    }), 'session_expired');
  });

  it('returns ready only after wallet and Polymarket setup are both ready', () => {
    assert.equal(getPolymarketProfileAccountState({
      ...base,
      signerStatus: 'ready',
      hasSigner: true,
      polymarketReady: true,
    }), 'ready');
  });

  it('surfaces an unsupported signer requirement directly', () => {
    assert.equal(getPolymarketProfileAccountState({ ...base, signerStatus: 'unsupported' }), 'unsupported');
  });
});
