import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getPredictProfileAccountState } from './profile-state';

const base = {
  signerStatus: 'needs_connection' as const,
  isPrivyUser: false,
  hasSigner: false,
  predictReady: false,
  predictLoading: false,
  sessionExpired: false,
};

describe('Predict profile account state', () => {
  it('keeps hook hydration separate from signed out', () => {
    assert.equal(getPredictProfileAccountState({ ...base, signerStatus: 'preparing' }), 'preparing');
  });

  it('distinguishes signed out from an authenticated dormant EVM wallet', () => {
    assert.equal(getPredictProfileAccountState(base), 'signed_out');
    assert.equal(getPredictProfileAccountState({ ...base, isPrivyUser: true }), 'wallet_setup');
  });

  it('distinguishes an EVM signer from a configured Predict session', () => {
    assert.equal(getPredictProfileAccountState({ ...base, signerStatus: 'ready', hasSigner: true }), 'predict_setup');
  });

  it('keeps an expired session visible as reconnectable rather than signed out', () => {
    assert.equal(getPredictProfileAccountState({
      ...base,
      signerStatus: 'ready',
      hasSigner: true,
      predictReady: true,
      sessionExpired: true,
    }), 'session_expired');
  });

  it('returns ready only after wallet and Predict setup are both ready', () => {
    assert.equal(getPredictProfileAccountState({
      ...base,
      signerStatus: 'ready',
      hasSigner: true,
      predictReady: true,
    }), 'ready');
  });

  it('surfaces an unsupported signer requirement directly', () => {
    assert.equal(getPredictProfileAccountState({ ...base, signerStatus: 'unsupported' }), 'unsupported');
  });
});
