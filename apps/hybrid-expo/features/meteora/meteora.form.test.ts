import assert from 'node:assert/strict';
import {
  applyRangeEdgeBinDelta,
  createCenteredRange,
  compareDecimalStrings,
  decimalToAtomic,
  dragPixelsToBinDelta,
  formatMeteoraRangePrice,
  liquidityDistributionWeight,
  movePriceByBins,
  relativeBinToRangePercent,
  sanitizeDecimalInput,
  validateAmount,
  validateLimitPrice,
  validateRange,
} from './meteora.form';

function testAmountBoundaries(): void {
  assert.equal(validateAmount('', 9, false), null);
  assert.equal(validateAmount('', 9, true), 'Enter an amount');
  assert.equal(validateAmount('0', 9, true), 'Amount must be greater than zero');
  assert.equal(validateAmount('0.000000001', 9, true), null);
  assert.equal(validateAmount('0.0000000001', 9, true), 'Use no more than 9 decimal places');
  assert.equal(validateAmount('-1', 9, true), 'Use a positive decimal amount');
  assert.equal(validateAmount('1e3', 9, true), 'Use a positive decimal amount');
  assert.equal(validateAmount('1.', 9, true), 'Use a positive decimal amount');
  assert.equal(validateAmount('18446744073.709551615', 9, true), null);
  assert.equal(validateAmount('18446744073.709551616', 9, true), 'Amount is too large');
  assert.equal(validateAmount('01.25', 9, true), 'Use a positive decimal amount');
  assert.equal(decimalToAtomic('0.000000001', 9), '1');
  assert.equal(decimalToAtomic('1.25', 6), '1250000');
  assert.throws(() => decimalToAtomic('1e3', 9));
  assert.throws(() => decimalToAtomic('01.25', 9));
  assert.throws(() => decimalToAtomic('18446744073.709551616', 9));
}

function testRangeBoundaries(): void {
  assert.equal(validateRange('', '', false), null);
  assert.equal(
    validateRange('', '', true),
    'Enter both minimum and maximum prices',
  );
  assert.equal(validateRange('0', '1', true), 'Prices must be greater than zero');
  assert.equal(validateRange('1', '1', true), 'Minimum price must be below maximum price');
  assert.equal(validateRange('1.000000001', '1.000000002', true), null);
  assert.equal(validateRange('2', '1', true), 'Minimum price must be below maximum price');
  assert.equal(validateRange('01', '2', true), 'Use positive decimal prices');
}

function testLimitBoundaries(): void {
  assert.equal(validateLimitPrice('99.99', '100', 'buy', true), null);
  assert.equal(
    validateLimitPrice('100', '100', 'buy', true),
    'Buy price must be below the current price',
  );
  assert.equal(
    validateLimitPrice('100', '100', 'sell', true),
    'Sell price must be above the current price',
  );
  assert.equal(validateLimitPrice('100.01', '100', 'sell', true), null);
}

function testInputAndComparisonBoundaries(): void {
  assert.equal(sanitizeDecimalInput(' 1,234.50', 6), '1234.50');
  assert.equal(sanitizeDecimalInput('-1', 6), '-1');
  assert.equal(compareDecimalStrings('001.2300', '1.23'), 0);
  assert.equal(compareDecimalStrings('0.999999999', '1'), -1);
  assert.equal(compareDecimalStrings('10000000000000000001', '10000000000000000000'), 1);
}

function testDefaultRangeAndHandleMovement(): void {
  const range = createCenteredRange('100', 100);
  assert.ok(range);
  assert.equal(range.binCount, 70);
  assert.equal(compareDecimalStrings(range.requestedMinPrice, '100'), -1);
  assert.equal(compareDecimalStrings(range.requestedMaxPrice, '100'), 1);
  assert.equal(movePriceByBins('100', 100, 1), '101');
  assert.equal(movePriceByBins('100', 100, 0), '100');
  assert.equal(movePriceByBins('0.00000001', 25, -34).includes('e'), false);
  assert.equal(createCenteredRange(null, 100), null);
  assert.equal(relativeBinToRangePercent(-34), 3);
  assert.equal(relativeBinToRangePercent(0), 50);
  assert.equal(relativeBinToRangePercent(34), 97);
  assert.equal(dragPixelsToBinDelta(0, 400), 0);
  assert.equal(dragPixelsToBinDelta(188, 400), 34);
  assert.equal(dragPixelsToBinDelta(-188, 400), -34);
  assert.equal(dragPixelsToBinDelta(1_000, 400), 68);

  const narrowed = applyRangeEdgeBinDelta({
    minPrice: range.requestedMinPrice,
    maxPrice: range.requestedMaxPrice,
    currentPrice: '100',
    binStep: 100,
    edge: 'min',
    deltaBins: 1,
    bounds: {
      minPrice: range.requestedMinPrice,
      maxPrice: range.requestedMaxPrice,
    },
  });
  assert.ok(narrowed);
  assert.equal(compareDecimalStrings(narrowed.minPrice, range.requestedMinPrice), 1);
  assert.equal(narrowed.maxPrice, range.requestedMaxPrice);
  assert.equal(applyRangeEdgeBinDelta({
    minPrice: range.requestedMinPrice,
    maxPrice: range.requestedMaxPrice,
    currentPrice: '100',
    binStep: 100,
    edge: 'min',
    deltaBins: -1,
    bounds: {
      minPrice: range.requestedMinPrice,
      maxPrice: range.requestedMaxPrice,
    },
  }), null);
  assert.equal(applyRangeEdgeBinDelta({
    minPrice: narrowed.minPrice,
    maxPrice: narrowed.maxPrice,
    currentPrice: '100',
    binStep: 100,
    edge: 'min',
    deltaBins: 100,
  }), null);
}

function testStrategyShapes(): void {
  const spotEdge = liquidityDistributionWeight('spot', 0);
  const spotCenter = liquidityDistributionWeight('spot', 0.5);
  assert.equal(spotEdge, spotCenter);

  const curveEdge = liquidityDistributionWeight('curve', 0);
  const curveCenter = liquidityDistributionWeight('curve', 0.5);
  assert.ok(curveCenter > curveEdge);

  const bidAskEdge = liquidityDistributionWeight('bid_ask', 0);
  const bidAskCenter = liquidityDistributionWeight('bid_ask', 0.5);
  assert.ok(bidAskEdge > bidAskCenter);
  assert.notEqual(curveCenter, bidAskCenter);
}

testAmountBoundaries();
testRangeBoundaries();
testLimitBoundaries();
testInputAndComparisonBoundaries();
testDefaultRangeAndHandleMovement();
testStrategyShapes();

function testAdaptiveRangeFormatter(): void {
  assert.equal(formatMeteoraRangePrice('121.678', false), '121.678');
  assert.notEqual(formatMeteoraRangePrice('123.4', true), formatMeteoraRangePrice('121.6', true));
  assert.match(formatMeteoraRangePrice('123.4', true), /^0\.008/);
}

testAdaptiveRangeFormatter();
console.log('Meteora form boundary tests passed');
