import assert from 'node:assert/strict';
import test from 'node:test';

import type { OpenOrder, PortfolioData } from '@/features/polymarket/polymarket.api';
import type { PolymarketProfileAccountState } from '@/features/polymarket/portfolio/profile-state';
import { formatShowingLabel } from '@/features/polymarket/portfolio/portfolio-totals';
import { EMPTY_PORTFOLIO_POSITIONS, getOrderCost } from './polymarket.format';
import { derivePolymarketTotals } from './polymarket.totals';

function makePosition(overrides: Partial<PortfolioData['positions'][number]> = {}): PortfolioData['positions'][number] {
  return {
    proxyWallet: '0xproxy',
    asset: '0xasset',
    conditionId: '0xcondition',
    size: 10,
    avgPrice: 0.5,
    currentValue: 7,
    cashPnl: 2,
    percentPnl: 40,
    curPrice: 0.7,
    title: 'Will X happen?',
    slug: 'will-x-happen',
    eventSlug: 'will-x-happen-event',
    outcome: 'Yes',
    outcomeIndex: 0,
    icon: null,
    endDate: null,
    negativeRisk: false,
    ...overrides,
  };
}

function makeOpenOrder(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    id: 'order-1',
    status: 'live',
    market: '0xcondition',
    asset_id: '0xasset',
    side: 'buy',
    original_size: '10',
    size_matched: '4',
    price: '0.5',
    outcome: 'Yes',
    created_at: Date.parse('2024-01-01T00:00:00Z'),
    order_type: 'GTC',
    ...overrides,
  };
}

function makePortfolio(overrides: Partial<PortfolioData> = {}): PortfolioData {
  return {
    address: '0xaddr',
    portfolioValue: 48,
    positions: [],
    redeemablePositions: [],
    closedPositions: [],
    activity: [],
    recentTrades: [],
    profile: null,
    summary: {
      openPositions: 2,
      totalPnl: 3,
      totalsPartial: false,
      totalPositionCount: 5,
    },
    ...overrides,
  };
}

test('an empty store yields the stable empty list and a null-value portfolio visible as ready', () => {
  const derived = derivePolymarketTotals({
    portfolio: null,
    openOrders: [],
    cashBalance: null,
    accountState: 'ready',
  });

  assert.equal(derived.positions, EMPTY_PORTFOLIO_POSITIONS, 'identity is stable for the sell-quote hook');
  assert.deepEqual(derived.redeemablePositions, []);
  assert.deepEqual(derived.closedPositions, []);
  assert.equal(derived.portfolioSummary, null);
  assert.equal(derived.cashOutNow, null);
  assert.equal(derived.showingLabel, null);
  assert.equal(derived.readyToCollect, 0);
  assert.equal(derived.waitingPickValue, 0);
  assert.equal(derived.activePicksValue, null, 'no cashOutNow means picks value is unknown, not 0');
  assert.equal(derived.polymarketValue, null);
  assert.equal(derived.portfolioVisible, true);
  assert.equal(derived.accountStateLabel, 'Account protected');
  assert.equal(derived.accountStatePositive, true);
  assert.equal(derived.actionsDisabled, false);
});

test('account-state labels, visibility and gating cover every profile state', () => {
  const labels: Record<PolymarketProfileAccountState, {
    label: string;
    visible: boolean;
    disabled: boolean;
    positive: boolean;
  }> = {
    ready: { label: 'Account protected', visible: true, disabled: false, positive: true },
    session_expired: { label: 'Reconnect needed', visible: true, disabled: true, positive: false },
    preparing: { label: 'Checking account', visible: false, disabled: true, positive: false },
    signed_out: { label: 'Not connected', visible: false, disabled: true, positive: false },
    unsupported: { label: 'Wallet unsupported', visible: false, disabled: true, positive: false },
    wallet_setup: { label: 'Setup needed', visible: false, disabled: true, positive: false },
    polymarket_setup: { label: 'Setup needed', visible: false, disabled: true, positive: false },
  };

  for (const [accountState, expected] of Object.entries(labels) as [PolymarketProfileAccountState, (typeof labels)[PolymarketProfileAccountState]][]) {
    const derived = derivePolymarketTotals({ portfolio: null, openOrders: [], cashBalance: null, accountState });
    assert.equal(derived.accountStateLabel, expected.label, `label for ${accountState}`);
    assert.equal(derived.portfolioVisible, expected.visible, `visibility for ${accountState}`);
    assert.equal(derived.actionsDisabled, expected.disabled, `actionsDisabled for ${accountState}`);
    assert.equal(derived.accountStatePositive, expected.positive, `positive for ${accountState}`);
  }
});

test('API summary drives the totals and the snapshot references pass through unchanged', () => {
  const portfolio = makePortfolio({
    positions: [makePosition()],
    redeemablePositions: [makePosition({ currentValue: 12 })],
    summary: {
      openPositions: 2,
      totalPnl: 3,
      totalsPartial: false,
      totalPositionCount: 5,
      readyToCollect: 12,
      cashOutNow: 20,
    },
  });
  const orders: OpenOrder[] = [makeOpenOrder()];
  assert.equal(getOrderCost(orders[0]), 3);

  const derived = derivePolymarketTotals({
    portfolio,
    openOrders: orders,
    cashBalance: 10,
    accountState: 'ready',
  });

  assert.equal(derived.positions, portfolio.positions);
  assert.equal(derived.redeemablePositions, portfolio.redeemablePositions);
  assert.equal(derived.closedPositions, portfolio.closedPositions);
  assert.equal(derived.portfolioSummary, portfolio.summary);
  assert.equal(derived.cashOutNow, 20);
  assert.equal(derived.showingLabel, formatShowingLabel(portfolio.summary));
  assert.equal(derived.readyToCollect, 12, 'summary.readyToCollect wins over any local sum');
  assert.equal(derived.waitingPickValue, 3);
  assert.equal(derived.activePicksValue, 23);
  assert.equal(derived.polymarketValue, 45);
});

test('readyToCollect falls back to summing redeemable currentValue and missing cashOutNow blocks picks', () => {
  const portfolio = makePortfolio({
    redeemablePositions: [
      makePosition({ currentValue: 5 }),
      makePosition({ asset: '0xother', currentValue: 7 }),
    ],
  });

  const derived = derivePolymarketTotals({
    portfolio,
    openOrders: [makeOpenOrder()],
    cashBalance: 10,
    accountState: 'ready',
  });

  assert.equal(derived.readyToCollect, 12);
  assert.equal(derived.cashOutNow, null, 'a summary without cashOutNow is unknown');
  assert.equal(derived.activePicksValue, null);
  assert.equal(derived.polymarketValue, null, 'cash balance cannot build a value without cashOutNow');
  assert.equal(derived.waitingPickValue, 3);
});

test('a null cash balance leaves the total value unknown while picks stay priced', () => {
  const portfolio = makePortfolio({
    summary: {
      openPositions: 1,
      totalPnl: 0,
      totalsPartial: false,
      totalPositionCount: 3,
      readyToCollect: 12,
      cashOutNow: 20,
    },
  });

  const derived = derivePolymarketTotals({
    portfolio,
    openOrders: [makeOpenOrder()],
    cashBalance: null,
    accountState: 'ready',
  });

  assert.equal(derived.activePicksValue, 23);
  assert.equal(derived.polymarketValue, null);
  assert.equal(derived.showingLabel, formatShowingLabel(portfolio.summary));
});
