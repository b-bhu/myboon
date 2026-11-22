import assert from 'node:assert/strict';
import test from 'node:test';

import { accountSummary, sumPhoenixPortfolioValue, sumUsd, toNumber, toUsd } from './phoenix.js';

/**
 * toUsd's fragile rule, pinned from today's app behaviour before the move
 * (issue #723): a NUMBER, or a dot-less string, whose magnitude is
 * 1,000,000 or more is treated as raw USD-lots and divided by 1e6.
 * Dot-carrying strings and {ui}/{value} records are NEVER divided, even at
 * or above the threshold — that quirk is deliberately preserved unchanged.
 */

test('toUsd divides integers of 1,000,000 or more by 1e6', () => {
  assert.equal(toUsd(1_000_000), 1); // exactly at the threshold divides
  assert.equal(toUsd(2_500_000), 2.5);
  assert.equal(toUsd(999_999_500_000), 999_999.5);
  assert.equal(toUsd(999_999), 999_999); // below the threshold, unchanged
  assert.equal(toUsd(999_999.5), 999_999.5);
  assert.equal(toUsd(0), 0);
});

test('toUsd applies the threshold to negative magnitudes', () => {
  assert.equal(toUsd(-1_000_000), -1);
  assert.equal(toUsd(-999_999), -999_999);
});

test('toUsd divides dot-less strings at or above the threshold', () => {
  assert.equal(toUsd('1000000'), 1);
  assert.equal(toUsd('3000000'), 3);
  assert.equal(toUsd('-4000000'), -4);
  assert.equal(toUsd('999999'), 999_999);
});

test('toUsd never divides strings that carry a decimal point (pinned fragility)', () => {
  assert.equal(toUsd('1500000.5'), 1_500_000.5);
  assert.equal(toUsd('999999.5'), 999_999.5);
  assert.equal(toUsd('2.5'), 2.5);
});

test('toUsd never divides record values, even at threshold (pinned fragility)', () => {
  assert.equal(toUsd({ ui: '2000000' }), 2_000_000);
  assert.equal(toUsd({ value: 3_000_000, decimals: 6 }), 3);
  assert.equal(toUsd({ value: '3.5', decimals: 0 }), 3.5);
});

test('toNumber parses numbers, strings, ui-prefixed records and value/decimals pairs', () => {
  assert.equal(toNumber(5), 5);
  assert.equal(toNumber(2.5), 2.5);
  assert.equal(toNumber('12.5'), 12.5);
  assert.equal(toNumber({ ui: '2.5' }), 2.5);
  assert.equal(toNumber({ value: 3_000_000, decimals: 6 }), 3);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('   '), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber([1, 2]), null); // arrays are not records (wallet.sources semantics)
});

test('sumPhoenixPortfolioValue: no traders is $0, unparseable-only is null, values are toUsd-scaled', () => {
  assert.equal(sumPhoenixPortfolioValue([]), 0);
  assert.equal(sumPhoenixPortfolioValue([{ other: 'x' }]), null);
  assert.equal(sumPhoenixPortfolioValue([{ portfolioValue: 2.5 }, { portfolioValue: 1 }]), 3.5);
  assert.equal(sumPhoenixPortfolioValue([{ portfolioValue: '2000000' }]), 2);
  assert.equal(sumPhoenixPortfolioValue([{ portfolioValue: 1 }, { nope: true }]), 1);
});

test('sumUsd: null when no record has the key, otherwise the toUsd sum of present rows', () => {
  assert.equal(sumUsd([], 'portfolioValue'), null);
  assert.equal(sumUsd([{ portfolioValue: 2.5 }], 'collateralBalance'), null);
  assert.equal(sumUsd([{ portfolioValue: 2.5 }, { portfolioValue: 1 }], 'portfolioValue'), 3.5);
  assert.equal(sumUsd([{ portfolioValue: '2000000' }], 'portfolioValue'), 2);
  // Dot-carrying strings are never scaled, even past 1e6 (toUsd rule).
  assert.equal(sumUsd([{ portfolioValue: '2000000.25' }], 'portfolioValue'), 2_000_000.25);
});

test('accountSummary: sums every trader, leverage is initialMargin / effectiveCollateral, riskLabel is the worst tier', () => {
  const traders = [
    {
      portfolioValue: '2500000', // -> 2.5
      effectiveCollateral: 1_000_000, // -> 1
      initialMargin: 250_000, // below threshold, unchanged
      unrealizedPnl: 1.25,
      riskTier: 'AT_RISK',
    },
    {
      portfolioValue: 1, // -> 1
      effectiveCollateral: '1000000', // -> 1
      initialMargin: '250000', // below threshold, unchanged
      unrealizedPnl: null,
      riskTier: 'SAFE',
    },
  ];
  const summary = accountSummary(traders);
  assert.equal(summary.portfolioValue, 3.5);
  assert.equal(summary.effectiveCollateral, 2);
  assert.equal(summary.initialMargin, 500_000);
  assert.equal(summary.accountLeverage, 250_000); // per-record toUsd scaling, as in the app
  assert.equal(summary.withdrawable, null); // no trader carries the key
  assert.equal(summary.unrealizedPnl, 1.25);
  assert.equal(summary.maintenanceMargin, null);
  assert.equal(summary.riskLabel, 'At Risk');
});

test('accountSummary: no traders -> null sums, 0 unrealized PnL, "--" risk label', () => {
  const summary = accountSummary([]);
  assert.equal(summary.portfolioValue, null);
  assert.equal(summary.collateralBalance, null);
  assert.equal(summary.unrealizedPnl, 0);
  assert.equal(summary.accountLeverage, null);
  assert.equal(summary.riskLabel, '--');
});

test('accountSummary: all-unrealized-pnl missing reports 0 (sumUsd null ?? 0)', () => {
  const summary = accountSummary([{ portfolioValue: 5 }, { riskTier: 'SAFE' }]);
  assert.equal(summary.portfolioValue, 5);
  assert.equal(summary.unrealizedPnl, 0);
  assert.equal(summary.riskLabel, 'Safe');
});
