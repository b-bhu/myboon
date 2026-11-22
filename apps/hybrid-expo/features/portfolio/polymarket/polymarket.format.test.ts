import assert from 'node:assert/strict';
import test from 'node:test';

import { truncateUsd } from '@/features/polymarket/formatPolymarketMoney';
import type { ActivityItem, OpenOrder, PortfolioPosition } from '@/features/polymarket/polymarket.api';
import {
  activityCashValue,
  activityLabel,
  EMPTY_PORTFOLIO_POSITIONS,
  fetchUsdToInrRate,
  formatAge,
  formatProfileCurrency,
  getOrderCost,
  maskEmail,
  orderCost,
  POLYMARKET_PROFILE_FALLBACK_USD_TO_INR,
  positionKey,
  truncate,
} from './polymarket.format';

function makePosition(overrides: Partial<PortfolioPosition> = {}): PortfolioPosition {
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

function makeActivity(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    timestamp: 1_700_000_000,
    type: 'trade',
    side: 'buy',
    size: 5,
    usdcSize: 3,
    price: 0.6,
    title: 'Will X happen?',
    slug: 'will-x-happen',
    outcome: 'Yes',
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

test('truncate masks addresses with 6/4 by default and honours overrides', () => {
  assert.equal(truncate('0x1234567890abcdef'), '0x1234···cdef');
  assert.equal(truncate('0x1234567890abcdef', 4, 4), '0x12···cdef');
});

test('maskEmail keeps the first two locals and null-guards broken inputs', () => {
  assert.equal(maskEmail('alice@example.com'), 'al•••@example.com');
  assert.equal(maskEmail('a@b.co'), 'a•••@b.co');
  assert.equal(maskEmail(null), null);
  assert.equal(maskEmail('@example.com'), null);
  assert.equal(maskEmail('nope'), null);
});

test('formatProfileCurrency USD delegates to truncateUsd', () => {
  assert.equal(formatProfileCurrency(123.456, 'USD'), truncateUsd(123.456));
  assert.equal(formatProfileCurrency(null, 'USD'), truncateUsd(null));
  assert.equal(formatProfileCurrency(123.456, 'USD'), '$123.45');
});

test('formatProfileCurrency INR converts with the given rate and shortens large values', () => {
  assert.equal(formatProfileCurrency(100, 'INR', 1), '₹100');
  assert.equal(formatProfileCurrency(2000, 'INR', 1), '₹2.0K');
  assert.equal(formatProfileCurrency(200000, 'INR', 1), '₹2.0L');
  assert.equal(formatProfileCurrency(-1000, 'INR', 1), '-₹1.0K');
  assert.equal(formatProfileCurrency(-5, 'INR', 1), '-₹5');
  assert.equal(formatProfileCurrency(-5.6, 'INR', 1), '-₹6');
  assert.equal(formatProfileCurrency(100, 'INR'), '₹9.6K', 'the default fallback rate applies');
});

test('formatProfileCurrency falls back to -- for null and non-finite INR values', () => {
  assert.equal(formatProfileCurrency(null, 'INR'), '--');
  assert.equal(formatProfileCurrency(undefined, 'INR'), '--');
  assert.equal(formatProfileCurrency(Number.NaN, 'INR'), '--');
});

test('POLYMARKET_PROFILE_FALLBACK_USD_TO_INR keeps its pinned value', () => {
  assert.equal(POLYMARKET_PROFILE_FALLBACK_USD_TO_INR, 95.67);
});

test('fetchUsdToInrRate returns the parsed positive rate and null on failures', async () => {
  const originalFetch = globalThis.fetch;
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  try {
    globalThis.fetch = (async () => respond({ rates: { INR: '83.5' } })) as typeof fetch;
    assert.equal(await fetchUsdToInrRate(), 83.5);

    globalThis.fetch = (async () => respond({ rates: { INR: '-2' } })) as typeof fetch;
    assert.equal(await fetchUsdToInrRate(), null, 'non-positive rate is rejected');

    globalThis.fetch = (async () => respond({}, 503)) as typeof fetch;
    assert.equal(await fetchUsdToInrRate(), null, 'non-ok response yields null');

    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    assert.equal(await fetchUsdToInrRate(), null, 'thrown fetch yields null');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getOrderCost zero-fills missing costs; orderCost keeps null', () => {
  const live: OpenOrder = makeOpenOrder();
  assert.equal(orderCost(live), 3);
  assert.equal(getOrderCost(live), 3);
  const unpriceable: OpenOrder = makeOpenOrder({ price: 'n/a' });
  assert.equal(orderCost(unpriceable), null);
  assert.equal(getOrderCost(unpriceable), 0);
});

test('formatAge distinguishes seconds from milliseconds inputs and buckets forward', () => {
  const now = Date.now();
  assert.equal(formatAge(now), 'just now');
  assert.equal(formatAge(Math.floor(now / 1000)), 'just now', 'values below 10e9 are treated as seconds');
  assert.equal(formatAge(now - 95_000), '1m ago');
  assert.equal(formatAge(now - 65 * 60_000), '1h ago');
  assert.equal(formatAge(now - 30 * 3_600_000), '1d ago');
});

test('positionKey joins conditionId, outcomeIndex and asset', () => {
  assert.equal(positionKey(makePosition()), '0xcondition:0:0xasset');
  assert.equal(positionKey(makePosition({ outcomeIndex: 3, asset: '0xother' })), '0xcondition:3:0xother');
});

test('activityLabel maps entry types to the profile copy', () => {
  assert.equal(activityLabel(makeActivity({ type: 'REDEEM' })), 'Payout collected');
  assert.equal(activityLabel(makeActivity({ type: 'Trade', side: 'sell' })), 'Position sold');
  assert.equal(activityLabel(makeActivity({ type: 'Trade', side: 'buy' })), 'Position bought');
  assert.equal(activityLabel(makeActivity({ type: 'SPLIT' })), 'Position prepared');
  assert.equal(activityLabel(makeActivity({ type: 'MERGE' })), 'Position settled');
  assert.equal(activityLabel(makeActivity({ type: 'reward_claim' })), 'Reward Claim');
});

test('activityCashValue signs by entry type and side', () => {
  assert.equal(activityCashValue(makeActivity({ type: 'redeem', usdcSize: 9 })), 9);
  assert.equal(activityCashValue(makeActivity({ type: 'merge', usdcSize: 9 })), 9);
  assert.equal(activityCashValue(makeActivity({ type: 'split', usdcSize: 9 })), -9);
  assert.equal(activityCashValue(makeActivity({ type: 'trade', side: 'sell', usdcSize: 9 })), 9);
  assert.equal(activityCashValue(makeActivity({ type: 'trade', side: ' BUY ', usdcSize: 9 })), -9);
  assert.equal(activityCashValue(makeActivity({ type: 'other', usdcSize: -4 })), -4);
});

test('EMPTY_PORTFOLIO_POSITIONS is a stable shared empty list', () => {
  assert.deepEqual(EMPTY_PORTFOLIO_POSITIONS, []);
  assert.equal(EMPTY_PORTFOLIO_POSITIONS.length, 0);
});
