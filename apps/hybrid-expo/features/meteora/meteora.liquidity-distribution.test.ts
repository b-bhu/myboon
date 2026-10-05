import assert from 'node:assert/strict';
import test from 'node:test';
import { getMeteoraLiquidityDistribution, getMeteoraPoolLiquidityDistribution, getMeteoraSdkLiquidityDistribution } from './meteora.liquidity-distribution';

const base = {
  strategy: 'spot' as const,
  mode: 'both' as const,
  amountX: '0.02',
  amountY: '10',
  tokenXDecimals: 9,
  tokenYDecimals: 6,
  currentPrice: '100',
  minPrice: '95',
  maxPrice: '105',
  binStep: 100,
};

function sum<T extends 'xValue' | 'yValue'>(bars: readonly { [key in T]: number }[], key: T): number {
  return bars.reduce((total, bar) => total + bar[key], 0);
}

test('allocates X and Y independently and conserves each entered amount', () => {
  const result = getMeteoraLiquidityDistribution(base);
  assert.ok(Math.abs(result.allocatedX - 0.02) < 1e-12);
  assert.ok(Math.abs(result.allocatedY - 10) < 1e-9);
  assert.ok(Math.abs(sum(result.bars, 'xValue') - 0.02) < 1e-12);
  assert.ok(Math.abs(sum(result.bars, 'yValue') - 10) < 1e-9);
  assert.ok(result.bars.every((bar) => Number.isFinite(bar.height) && bar.height >= 0 && bar.height <= 1));
  assert.ok(result.bars.some((bar) => bar.xValue > 0));
  assert.ok(result.bars.some((bar) => bar.yValue > 0));
});

test('default range boundary bins conserve amounts at every display resolution', () => {
  for (const strategy of ['spot', 'curve', 'bid_ask'] as const) {
    for (const barCount of [1, 56, 512]) {
      const result = getMeteoraLiquidityDistribution({
        ...base, strategy, barCount,
        minPrice: String(100 * 1.01 ** -34), maxPrice: String(100 * 1.01 ** 34),
      });
      assert.ok(Math.abs(result.allocatedX - Number(base.amountX)) < 1e-12);
      assert.ok(Math.abs(result.allocatedY - Number(base.amountY)) < 1e-9);
    }
  }
});

test('preserves decimal precision and leaves opposite sides unallocated', () => {
  const xOnly = getMeteoraLiquidityDistribution({
    ...base, mode: 'x_only', amountX: '0.000000001', amountY: '', tokenYDecimals: 6,
  });
  assert.ok(Math.abs(xOnly.allocatedX - 0.000000001) < 1e-18);
  assert.equal(xOnly.allocatedY, 0);
  assert.equal(sum(xOnly.bars, 'yValue'), 0);

  const yOnly = getMeteoraLiquidityDistribution({
    ...base, mode: 'y_only', amountX: '', amountY: '10.123456', tokenXDecimals: 9, tokenYDecimals: 6,
  });
  assert.ok(Math.abs(yOnly.allocatedY - 10.123456) < 1e-9);
  assert.equal(yOnly.allocatedX, 0);
  assert.equal(sum(yOnly.bars, 'xValue'), 0);
  const validZero = getMeteoraLiquidityDistribution({
    ...base, mode: 'x_only', amountX: '1', amountY: '0.000000', tokenYDecimals: 6,
  });
  assert.ok(validZero.allocatedX > 0);
  const plainZero = getMeteoraLiquidityDistribution({ ...base, mode: 'x_only', amountY: '0' });
  assert.ok(Math.abs(plainZero.allocatedX - 0.02) < 1e-12);
  assert.equal(plainZero.allocatedY, 0);
  const overprecisionZero = getMeteoraLiquidityDistribution({
    ...base, mode: 'x_only', amountX: '1', amountY: '0.0000000', tokenYDecimals: 6,
  });
  assert.equal(overprecisionZero.allocatedX, 0);
});

test('narrowing a funded side redistributes the same total over fewer columns', () => {
  const wide = getMeteoraLiquidityDistribution({
    ...base, mode: 'y_only', amountX: '0', minPrice: '90', maxPrice: '100',
  });
  const narrow = getMeteoraLiquidityDistribution({
    ...base, mode: 'y_only', amountX: '0', minPrice: '99', maxPrice: '100',
  });
  const wideColumns = wide.bars.filter((bar) => bar.yValue > 0).length;
  const narrowColumns = narrow.bars.filter((bar) => bar.yValue > 0).length;
  assert.ok(narrowColumns < wideColumns);
  assert.ok(Math.abs(wide.allocatedY - narrow.allocatedY) < 1e-9);
});

test('shared quote scale reflects unequal token values and range redistribution', () => {
  const both = getMeteoraLiquidityDistribution(base);
  const xPeak = Math.max(...both.bars.map((bar) => bar.height * bar.xFraction));
  const yPeak = Math.max(...both.bars.map((bar) => bar.height * bar.yFraction));
  assert.ok(yPeak > xPeak, '10 Y at the current price should dominate .02 X at 100');

  const wide = getMeteoraLiquidityDistribution({ ...base, minPrice: '90', maxPrice: '110' });
  const narrow = getMeteoraLiquidityDistribution({ ...base, minPrice: '99', maxPrice: '110' });
  const wideXPeak = Math.max(...wide.bars.map((bar) => bar.height * bar.xFraction));
  const narrowXPeak = Math.max(...narrow.bars.map((bar) => bar.height * bar.xFraction));
  assert.ok(narrowXPeak < wideXPeak, 'narrower Y allocation should lower X relative height');
  assert.ok(Math.abs(wide.allocatedX - narrow.allocatedX) < 1e-12);
  assert.ok(Math.abs(wide.allocatedY - narrow.allocatedY) < 1e-9);
  const widened = getMeteoraLiquidityDistribution({ ...base, minPrice: '80', maxPrice: '110' });
  const widenedXPeak = Math.max(...widened.bars.map((bar) => bar.height * bar.xFraction));
  assert.ok(widenedXPeak > narrowXPeak);

  const largerX = getMeteoraLiquidityDistribution({ ...base, amountX: '0.2' });
  const largerXPeak = Math.max(...largerX.bars.map((bar) => bar.height * bar.xFraction));
  assert.ok(largerXPeak > xPeak, 'increasing X must increase its visible share of the chart');
});

test('Spot has uniform value density without tall endpoint artifacts', () => {
  const result = getMeteoraLiquidityDistribution({
    ...base, mode: 'x_only', amountY: '', minPrice: '100', maxPrice: String(100 * 1.01 ** 34),
  });
  const interior = result.bars.filter((bar) => bar.xValue > 0).slice(2, -2);
  assert.ok(interior.length > 5);
  assert.ok(Math.max(...interior.map((bar) => bar.height)) - Math.min(...interior.map((bar) => bar.height)) < 1e-10);
});

test('Curve concentrates at the active edge and BidAsk at the far edge', () => {
  const curve = getMeteoraLiquidityDistribution({
    ...base, mode: 'x_only', amountY: '0', strategy: 'curve', minPrice: '100', maxPrice: '110',
  });
  const bidAsk = getMeteoraLiquidityDistribution({
    ...base, mode: 'x_only', amountY: '0', strategy: 'bid_ask', minPrice: '100', maxPrice: '110',
  });
  const curveValues = curve.bars.filter((bar) => bar.xValue > 0).map((bar) => bar.xValue);
  const bidAskValues = bidAsk.bars.filter((bar) => bar.xValue > 0).map((bar) => bar.xValue);
  assert.ok(curveValues[0] > curveValues[curveValues.length - 1]);
  assert.ok(bidAskValues[0] < bidAskValues[bidAskValues.length - 1]);
});

test('singleton boundaries, inversion, and empty modes remain finite', () => {
  const single = getMeteoraLiquidityDistribution({
    ...base, mode: 'x_only', amountY: '0', minPrice: '100', maxPrice: '101',
  });
  assert.ok(single.bars.some((bar) => bar.xValue > 0));
  assert.ok(single.bars.every((bar) => bar.yValue === 0));
  const wrongSideX = getMeteoraLiquidityDistribution({
    ...base, mode: 'x_only', amountY: '', minPrice: '90', maxPrice: '99',
  });
  const wrongSideY = getMeteoraLiquidityDistribution({
    ...base, mode: 'y_only', amountX: '', minPrice: '101', maxPrice: '110',
  });
  assert.equal(wrongSideX.allocatedX, 0);
  assert.equal(wrongSideY.allocatedY, 0);

  const normal = getMeteoraLiquidityDistribution({ ...base, mode: 'x_only', amountY: '0' });
  const inverted = getMeteoraLiquidityDistribution({ ...base, mode: 'x_only', amountY: '0', inverted: true });
  assert.deepEqual(inverted.bars.map((bar) => bar.xValue), normal.bars.map((bar) => bar.xValue).reverse());

  const none = getMeteoraLiquidityDistribution({ ...base, mode: 'none' });
  assert.equal(none.bars.every((bar) => bar.height === 0), true);
});

test('invalid values and excessive ranges return finite empty output', () => {
  const invalid = getMeteoraLiquidityDistribution({ ...base, amountX: '0.0000000001' });
  assert.equal(invalid.bars.every((bar) => bar.height === 0), true);
  const hugeRange = getMeteoraLiquidityDistribution({
    ...base,
    binStep: 1,
    minPrice: '1',
    maxPrice: '10000',
  });
  assert.equal(hugeRange.bars.every((bar) => Number.isFinite(bar.height) && bar.height === 0), true);
  assert.equal(Number.isFinite(hugeRange.allocatedX), true);
  assert.equal(Number.isFinite(hugeRange.allocatedY), true);
});

test('real pool bins produce an independent normalized lower series', () => {
  const bins = [
    { binId: 99, price: '99', xAtomic: '1000000000', yAtomic: '0' },
    { binId: 100, price: '100', xAtomic: '0', yAtomic: '5000000' },
    { binId: 101, price: '101', xAtomic: '100000000', yAtomic: '0' },
  ];
  const normal = getMeteoraPoolLiquidityDistribution({
    bins, minBinId: 99, maxBinId: 101, currentPrice: '100', tokenXDecimals: 9, tokenYDecimals: 6, barCount: 3,
  });
  const inverted = getMeteoraPoolLiquidityDistribution({
    bins, minBinId: 99, maxBinId: 101, currentPrice: '100', tokenXDecimals: 9, tokenYDecimals: 6, barCount: 3, inverted: true,
  });
  assert.equal(normal.length, 3);
  assert.equal(Math.max(...normal), 1);
  assert.deepEqual(inverted, normal.slice().reverse());
});

test('retained canonical domains keep lower-pool columns aligned through inversion', () => {
  const bins = [
    { binId: 110, price: '110', xAtomic: '1000000000', yAtomic: '0' },
    { binId: 111, price: '111', xAtomic: '0', yAtomic: '4000000' },
  ];
  const normal = getMeteoraPoolLiquidityDistribution({
    bins, minBinId: 100, maxBinId: 119, currentPrice: '100', tokenXDecimals: 9, tokenYDecimals: 6, barCount: 20,
  });
  const inverted = getMeteoraPoolLiquidityDistribution({
    bins, minBinId: 100, maxBinId: 119, currentPrice: '100', tokenXDecimals: 9, tokenYDecimals: 6, barCount: 20, inverted: true,
  });
  assert.deepEqual(inverted, normal.slice().reverse());
  assert.equal(normal.slice(0, 10).every((value) => value === 0), true);
  assert.ok(normal.slice(10).some((value) => value > 0));
});

test('official allocator DTO bars preserve exact per-bin token mix and reverse canonically', () => {
  const allocations = [
    { binId: 100, xAtomic: '1000000000', yAtomic: '0' },
    { binId: 101, xAtomic: '0', yAtomic: '2500000' },
    { binId: 102, xAtomic: '500000000', yAtomic: '500000' },
  ];
  const normal = getMeteoraSdkLiquidityDistribution({
    allocations, minBinId: 99, maxBinId: 103, activeBinId: 100, activePrice: '100', binStep: 100,
    tokenXDecimals: 9, tokenYDecimals: 6, barCount: 5,
  });
  const inverted = getMeteoraSdkLiquidityDistribution({
    allocations, minBinId: 99, maxBinId: 103, activeBinId: 100, activePrice: '100', binStep: 100,
    tokenXDecimals: 9, tokenYDecimals: 6, barCount: 5, inverted: true,
  });
  assert.equal(normal.allocatedX, 1.5);
  assert.equal(normal.allocatedY, 3);
  assert.deepEqual(inverted.bars.map((bar) => bar.xValue), normal.bars.map((bar) => bar.xValue).reverse());
  assert.equal(normal.bars[1]?.xFraction, 1);
  assert.equal(normal.bars[2]?.yFraction, 1);
});

test('one display column per canonical bin keeps a 70-bin Spot DTO uniform', () => {
  const allocations = Array.from({ length: 70 }, (_, index) => ({
    binId: index,
    // Equal quote at a fixed active price makes any grouping alias obvious.
    xAtomic: '0', yAtomic: '1000000',
  }));
  const result = getMeteoraSdkLiquidityDistribution({
    allocations, minBinId: 0, maxBinId: 69, activeBinId: 0, activePrice: '100', binStep: 25,
    tokenXDecimals: 9, tokenYDecimals: 6, barCount: 70,
  });
  assert.equal(result.bars.length, 70);
  assert.ok(result.bars.every((bar) => bar.height === 1 && bar.yValue === 1));
});
