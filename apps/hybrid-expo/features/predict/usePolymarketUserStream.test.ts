import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPredictUserEvent } from './usePolymarketUserStream';
import type { OpenOrder } from './predict.api';

const order: OpenOrder = {
  id: 'order-1',
  status: 'live',
  market: 'condition',
  asset_id: 'token',
  side: 'BUY',
  original_size: '10',
  size_matched: '0',
  price: '0.5',
  outcome: 'Yes',
  created_at: 1,
  order_type: 'GTC',
};

test('user trade events reconcile partial and complete fills by order ID', () => {
  const partial = applyPredictUserEvent([order], {
    topic: 'user',
    type: 'trade',
    payload: { id: 'trade-1', takerOrderId: 'order-1', size: '4' },
  });
  assert.equal(partial[0]?.size_matched, '4');

  const repeatedStatus = applyPredictUserEvent(partial, {
    topic: 'user',
    type: 'trade',
    payload: { id: 'trade-1', takerOrderId: 'order-1', size: '4', status: 'CONFIRMED' },
  });
  assert.equal(repeatedStatus[0]?.size_matched, '4');

  const complete = applyPredictUserEvent(repeatedStatus, {
    topic: 'user',
    type: 'trade',
    payload: { id: 'trade-2', takerOrderId: 'order-1', size: '6' },
  });
  assert.deepEqual(complete, []);
});

test('user cancellation events remove the matching open order', () => {
  assert.deepEqual(applyPredictUserEvent([order], {
    topic: 'user',
    type: 'order',
    payload: { id: 'order-1', orderEventType: 'CANCELLATION' },
  }), []);
});
