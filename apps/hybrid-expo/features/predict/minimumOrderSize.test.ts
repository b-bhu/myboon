import assert from 'node:assert/strict';
import test from 'node:test';
import { getMinimumOrderGuardrail } from './minimumOrderSize';

test('uses Polymarket share minimum and reports approximate required spend', () => {
  assert.deepEqual(getMinimumOrderGuardrail({
    orderSize: 2 / 0.61,
    minimumOrderSize: 5,
    executionPrice: 0.61,
  }), {
    blocking: true,
    title: 'Below market minimum',
    message: 'This market requires at least 5 shares (about $3.05 at this price).',
  });
});

test('allows an order at the market minimum', () => {
  assert.equal(getMinimumOrderGuardrail({
    orderSize: 5,
    minimumOrderSize: 5,
    executionPrice: 0.61,
  }), null);
});

test('does not invent a fallback when market metadata is unavailable', () => {
  assert.equal(getMinimumOrderGuardrail({
    orderSize: 2,
    minimumOrderSize: null,
    executionPrice: 0.61,
  }), null);
});
