import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPredictUserEvent,
  attemptUserStreamRecovery,
  DEGRADED_USER_STREAM_POLL_MS,
  recordUserStreamConnected,
  recordUserStreamLoss,
  recordUserStreamStable,
  userStreamRetryDelay,
} from './usePolymarketUserStream';
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

test('user stream retries use capped exponential backoff with jitter', () => {
  const midpoint = () => 0.5;
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((attempt) => userStreamRetryDelay(attempt, midpoint)),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
  );
  assert.equal(userStreamRetryDelay(20, () => 1), 30_000);
  assert.equal(DEGRADED_USER_STREAM_POLL_MS, 30_000);
});

test('repeated connection failures request only one resync at reconnect', () => {
  let recovery = { attempt: 0, needsResync: false };
  recovery = recordUserStreamLoss(recovery);
  recovery = recordUserStreamLoss(recovery);
  recovery = recordUserStreamLoss(recovery);
  assert.deepEqual(recovery, { attempt: 3, needsResync: true });

  const connected = recordUserStreamConnected(recovery);
  assert.equal(connected.shouldResync, true);
  assert.deepEqual(connected.state, { attempt: 3, needsResync: true });
  assert.equal(recordUserStreamConnected(connected.state).shouldResync, true);
  assert.deepEqual(recordUserStreamStable(connected.state), { attempt: 0, needsResync: true });
});

test('reconnect stays pending and degraded when REST resync rejects, then retries', async () => {
  const pending = recordUserStreamLoss({ attempt: 0, needsResync: false });
  let refreshAttempts = 0;
  const rejected = await attemptUserStreamRecovery(pending, [async () => {
    refreshAttempts += 1;
    throw new Error('REST unavailable');
  }]);
  assert.equal(rejected.succeeded, false);
  assert.equal(rejected.status, 'degraded');
  assert.equal(rejected.state.needsResync, true);

  const recovered = await attemptUserStreamRecovery(rejected.state, [async () => {
    refreshAttempts += 1;
  }]);
  assert.equal(recovered.succeeded, true);
  assert.equal(recovered.status, 'live');
  assert.equal(recovered.state.needsResync, false);
  assert.equal(refreshAttempts, 2);
});
