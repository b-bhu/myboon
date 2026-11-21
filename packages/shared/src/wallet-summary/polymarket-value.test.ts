import assert from 'node:assert/strict';
import test from 'node:test';

import { polymarketValueUsd } from './polymarket-value.js';

/**
 * polymarketValueUsd is new in shared (#723) and used by nothing in the Expo
 * app yet — the server composes Polymarket's account value with it. It takes
 * ONLY cash, open-positions value and ready-to-collect: no open-order-cost
 * parameter exists, because the server cannot see open orders and cash
 * already counts money reserved by an order. The Orders tab shows orders on
 * their own.
 */

test('all present: cash + open positions + ready to collect', () => {
  assert.equal(polymarketValueUsd({ cashUsd: 100, openPositionsValueUsd: 20, readyToCollectUsd: 3 }), 123);
  assert.equal(polymarketValueUsd({ cashUsd: 12.5, openPositionsValueUsd: 0.25, readyToCollectUsd: 2.25 }), 15);
});

test('zero inputs are a real zero, not unknown', () => {
  assert.equal(polymarketValueUsd({ cashUsd: 0, openPositionsValueUsd: 0, readyToCollectUsd: 0 }), 0);
});

test('cashUsd null -> null, whatever the other inputs are', () => {
  assert.equal(polymarketValueUsd({ cashUsd: null, openPositionsValueUsd: 20, readyToCollectUsd: 3 }), null);
  assert.equal(polymarketValueUsd({ cashUsd: null, openPositionsValueUsd: null }), null);
});

test('openPositionsValueUsd null -> null, whatever the other inputs are', () => {
  assert.equal(polymarketValueUsd({ cashUsd: 100, openPositionsValueUsd: null, readyToCollectUsd: 3 }), null);
  assert.equal(polymarketValueUsd({ cashUsd: 100, openPositionsValueUsd: null }), null);
});

test('readyToCollectUsd null or omitted counts as 0', () => {
  assert.equal(polymarketValueUsd({ cashUsd: 10, openPositionsValueUsd: 4, readyToCollectUsd: null }), 14);
  assert.equal(polymarketValueUsd({ cashUsd: 10, openPositionsValueUsd: 4 }), 14);
});
