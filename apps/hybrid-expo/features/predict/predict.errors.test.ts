import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePredictError } from './predict.errors';

test('normalizes SDK user cancellation', () => {
  assert.equal(normalizePredictError(new Error('User rejected request')).kind, 'user_rejected');
});

test('normalizes FOK and balance rejections', () => {
  assert.equal(normalizePredictError({ code: 'fok_not_filled' }).kind, 'liquidity');
  assert.equal(normalizePredictError({ code: 'insufficient_balance_or_allowance' }).kind, 'insufficient_balance');
});

test('normalizes builder auth and proxy transport failures', () => {
  assert.equal(normalizePredictError({ status: 403, message: 'remote signer rejected' }).kind, 'authentication');
  assert.equal(normalizePredictError(new Error('Network request failed')).kind, 'network');
});
