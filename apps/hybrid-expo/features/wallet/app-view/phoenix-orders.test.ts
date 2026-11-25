/**
 * Pure test for the Phoenix Orders tab strings (issue #850): trigger sign for
 * the four side and kind cases, a null side, the P&L format, and the orders
 * state helpers.
 *
 * Run: pnpm --filter hybrid-expo exec tsx --test features/wallet/app-view/phoenix-orders.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPhoenixOrdersResponse,
  phoenixOrderFigures,
  phoenixOrdersUrl,
  triggerSign,
} from './phoenix-orders';
import { NO_DATA } from '@/lib/format';
import type { WalletPhoenixOrder } from '@myboon/shared/wallet-summary';

function order(over: Partial<WalletPhoenixOrder> = {}): WalletPhoenixOrder {
  return {
    id: 'o1',
    symbol: 'SOL-PERP',
    kind: 'take_profit',
    triggerPriceUsd: 175,
    positionSide: 'long',
    size: 1.24,
    entryPriceUsd: 150,
    pnlAtTriggerUsd: 33.23,
    conditionalOrderIndex: 1,
    executionDirection: 'greater_than',
    canCancel: true,
    traderPdaIndex: 0,
    traderSubaccountIndex: 0,
    ...over,
  };
}

describe('triggerSign', () => {
  it('covers the four side and kind cases', () => {
    assert.equal(triggerSign('take_profit', 'long'), '≥');
    assert.equal(triggerSign('stop_loss', 'long'), '≤');
    assert.equal(triggerSign('take_profit', 'short'), '≤');
    assert.equal(triggerSign('stop_loss', 'short'), '≥');
  });
  it('has no sign without a side', () => {
    assert.equal(triggerSign('take_profit', null), null);
  });
});

describe('phoenixOrderFigures', () => {
  it('formats a take profit on a long', () => {
    const c = phoenixOrderFigures(order());
    assert.equal(c.title, 'SOL-PERP · Take profit');
    assert.equal(c.trigger, 'Mark ≥ 175.00');
    assert.equal(c.pnl, '+$33.23');
    assert.equal(c.pnlTone, 'up');
  });
  it('formats a stop loss on a long with a negative P&L', () => {
    const c = phoenixOrderFigures(order({ kind: 'stop_loss', triggerPriceUsd: 140, pnlAtTriggerUsd: -12.4 }));
    assert.equal(c.title, 'SOL-PERP · Stop loss');
    assert.equal(c.trigger, 'Mark ≤ 140.00');
    assert.equal(c.pnl, '−$12.40');
    assert.equal(c.pnlTone, 'down');
  });
  it('shows "Mark" with no sign and the glyph for nulls', () => {
    const c = phoenixOrderFigures(order({ positionSide: null, pnlAtTriggerUsd: null }));
    assert.equal(c.trigger, 'Mark 175.00');
    assert.equal(c.pnl, NO_DATA);
    assert.equal(c.pnlTone, null);
  });
});

describe('phoenix orders state', () => {
  const held = { orders: [order()], error: null };

  it('builds the URL and skips a null address', () => {
    assert.equal(phoenixOrdersUrl('https://api.x', 'ABC'), 'https://api.x/wallet/phoenix/orders?solana=ABC');
    assert.equal(phoenixOrdersUrl('https://api.x', null), null);
  });
  it('takes the array on ok', () => {
    assert.deepEqual(
      applyPhoenixOrdersResponse({ orders: null, error: 'x' }, { status: 'ok', orders: [order()] }),
      held,
    );
  });
  it('keeps the held list on a failure and sets the error', () => {
    assert.deepEqual(applyPhoenixOrdersResponse(held, null), {
      orders: held.orders,
      error: 'Phoenix orders request failed.',
    });
  });
});
