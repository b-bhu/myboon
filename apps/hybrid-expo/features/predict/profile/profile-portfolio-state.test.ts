import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OpenOrder } from '@/features/predict/predict.api';
import { remainingOrderCost, remainingOrderShares } from './profile-portfolio-state';

function order(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    id: 'order-1',
    status: 'open',
    market: 'market',
    asset_id: 'asset',
    side: 'BUY',
    original_size: '20',
    size_matched: '5',
    price: '0.40',
    outcome: 'Yes',
    created_at: 1,
    order_type: 'GTC',
    ...overrides,
  };
}

describe('Predict profile order reserves', () => {
  it('reserves only the unmatched portion of a partially filled order', () => {
    assert.equal(remainingOrderShares(order()), 15);
    assert.equal(remainingOrderCost(order()), 6);
  });

  it('never reports a negative reserve when matched size exceeds original size', () => {
    assert.equal(remainingOrderCost(order({ original_size: '2', size_matched: '3' })), 0);
  });

  it('returns null for malformed server values', () => {
    assert.equal(remainingOrderCost(order({ original_size: 'not-a-number' })), null);
    assert.equal(remainingOrderCost(order({ price: 'not-a-number' })), null);
  });
});
