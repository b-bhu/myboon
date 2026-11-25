import assert from 'node:assert/strict';
import test from 'node:test';
import { nextSwapPrefillStep } from './swap-prefill';

const base = { prefillMint: 'MINT', loadedMint: 'MINT', payMint: 'SOL', phase: 'compose', pickerSide: 'input' as const };

test('does nothing without a prefill or before the token has loaded', () => {
  assert.equal(nextSwapPrefillStep({ ...base, prefillMint: null }), null);
  assert.equal(nextSwapPrefillStep({ ...base, loadedMint: null }), null);
});

test('opens the pay picker, then selects the token, then stops', () => {
  assert.equal(nextSwapPrefillStep(base), 'open-picker');
  assert.equal(nextSwapPrefillStep({ ...base, phase: 'picker' }), 'select');
  assert.equal(nextSwapPrefillStep({ ...base, phase: 'picker', pickerSide: 'output' }), null);
  assert.equal(nextSwapPrefillStep({ ...base, payMint: 'MINT' }), null);
  assert.equal(nextSwapPrefillStep({ ...base, phase: 'review' }), null);
});
