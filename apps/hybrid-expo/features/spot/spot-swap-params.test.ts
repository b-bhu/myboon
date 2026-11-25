import assert from 'node:assert/strict';
import test from 'node:test';
import { spotSwapRoute } from './spot-swap-params';

test('spotSwapRoute opens the Wallet root with prefillMint, or nothing without a mint', () => {
  assert.deepEqual(spotSwapRoute('MINT1'), { pathname: '/', params: { prefillMint: 'MINT1' } });
  assert.equal(spotSwapRoute(''), null);
  assert.equal(spotSwapRoute(null), null);
  assert.equal(spotSwapRoute(undefined), null);
});
