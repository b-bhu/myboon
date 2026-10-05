import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_POSITION_DRAFT } from './meteora.form';
import { createMeteoraPositionCostKey, getMeteoraPositionCostShape } from './meteora.position-cost';

test('native-cost shape treats Auto-Fill as a two-token create transaction', () => {
  assert.deepEqual(getMeteoraPositionCostShape({ ...EMPTY_POSITION_DRAFT, amountX: '1' }), {
    depositMode: 'single_sided', inputToken: 'x',
  });
  assert.deepEqual(getMeteoraPositionCostShape({ ...EMPTY_POSITION_DRAFT, amountY: '1' }), {
    depositMode: 'single_sided', inputToken: 'y',
  });
  assert.deepEqual(getMeteoraPositionCostShape({ ...EMPTY_POSITION_DRAFT, autoFill: true, amountX: '1' }), {
    depositMode: 'two_token', inputToken: 'x',
  });
});

test('native-cost cache key changes when the create transaction shape changes', () => {
  const base = {
    poolAddress: 'pool', walletAddress: 'wallet', freshness: 'now', minPrice: '1', maxPrice: '2', strategy: 'spot', retry: 0,
  };
  assert.notEqual(
    createMeteoraPositionCostKey({ ...base, depositMode: 'single_sided', inputToken: 'x' }),
    createMeteoraPositionCostKey({ ...base, depositMode: 'two_token', inputToken: 'x' }),
  );
});
