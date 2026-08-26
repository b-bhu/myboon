import assert from 'node:assert/strict';
import { mergeOpenOrders, prunePendingOpenOrders, reconcilePendingActions } from './pendingOpenOrders';
import type { OpenOrder } from './predict.api';

function order(id: string, assetId: string): OpenOrder {
  return {
    id,
    status: 'local-pending',
    market: 'market',
    asset_id: assetId,
    side: 'BUY',
    original_size: '1',
    size_matched: '0',
    price: '0.5',
    outcome: 'Yes',
    created_at: Date.now(),
    order_type: 'GTC',
  };
}

const pending = [
  order('op_pending_1', 'token-1'),
  order('op_pending_2', 'token-1'),
  order('op_pending_3', 'token-2'),
];

assert.deepEqual(
  prunePendingOpenOrders(pending, [order('remote-order-1', 'token-1')], []).map((item) => item.id),
  ['op_pending_2', 'op_pending_3'],
);

assert.deepEqual(
  prunePendingOpenOrders(pending, [order('op_pending_2', 'token-1')], []).map((item) => item.id),
  ['op_pending_1', 'op_pending_3'],
);

assert.deepEqual(
  prunePendingOpenOrders(pending, [], [], [{
    id: 'trade-1',
    conditionId: 'condition',
    tokenId: 'token-2',
    takerOrderId: 'op_pending_3',
    makerOrderIds: [],
    side: 'BUY',
    price: 0.5,
    size: 1,
    status: 'MATCHED',
    matchedAt: Date.now(),
  }]).map((item) => item.id),
  ['op_pending_1', 'op_pending_2'],
);

assert.deepEqual(
  mergeOpenOrders(pending, [order('remote-order-1', 'token-1')]).map((item) => item.id),
  ['op_pending_2', 'op_pending_3', 'remote-order-1'],
);

assert.deepEqual(
  reconcilePendingActions(
    [
      { id: 'a1', type: 'buy', tokenId: 'token-1', marketSlug: 'market', outcome: 'Yes', amount: 1, shares: 1, createdAt: 1 },
      { id: 'a2', type: 'buy', tokenId: 'token-1', marketSlug: 'market', outcome: 'Yes', amount: 1, shares: 1, createdAt: 1 },
    ],
    [{
      id: 'remote',
      status: 'waiting_to_match',
      marketSlug: 'market',
      eventSlug: null,
      marketTitle: 'Market',
      outcome: 'Yes',
      tokenId: 'token-1',
      conditionId: null,
      putIn: 1,
      currentValue: null,
      pnl: null,
      shares: 1,
      avgPrice: null,
      currentPrice: null,
      createdAt: 1,
      source: 'order',
    }],
  ).map((item) => item.id),
  ['a2'],
);

console.log('pending open order tests passed');
