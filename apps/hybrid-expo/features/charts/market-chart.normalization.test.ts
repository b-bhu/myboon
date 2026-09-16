import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeMarketCandles,
  validateMarketCandle,
} from './market-chart.normalization';
import type { MarketCandle } from './market-chart.types';

function candle(timeMs: number, overrides: Partial<MarketCandle> = {}): MarketCandle {
  return {
    timeMs,
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 5,
    ...overrides,
  };
}

describe('validateMarketCandle', () => {
  it('accepts a valid flat candle and missing volume', () => {
    assert.equal(validateMarketCandle(candle(1, {
      open: 10,
      high: 10,
      low: 10,
      close: 10,
      volume: null,
    })), null);
  });

  it('distinguishes time, OHLC, range, and volume failures', () => {
    assert.equal(validateMarketCandle(candle(Number.NaN)), 'invalid-time');
    assert.equal(validateMarketCandle(candle(1, { close: Number.POSITIVE_INFINITY })), 'invalid-ohlc');
    assert.equal(validateMarketCandle(candle(1, { high: 10 })), 'invalid-range');
    assert.equal(validateMarketCandle(candle(1, { volume: -1 })), 'invalid-volume');
  });
});

describe('normalizeMarketCandles', () => {
  it('sorts, rejects malformed rows, and keeps the last duplicate timestamp', () => {
    const source = [
      candle(30),
      candle(10),
      candle(20, { close: 11 }),
      candle(20, { close: 11.5 }),
      candle(40, { low: 13 }),
      candle(50, { volume: -2 }),
    ];
    const result = normalizeMarketCandles(source);

    assert.deepEqual(result.candles.map((entry) => entry.timeMs), [10, 20, 30]);
    assert.equal(result.candles[1].close, 11.5);
    assert.deepEqual(result.duplicateTimes, [20]);
    assert.deepEqual(result.issues, [
      { index: 4, code: 'invalid-range' },
      { index: 5, code: 'invalid-volume' },
    ]);
  });

  it('does not mutate source objects and normalizes absent volume to null', () => {
    const original = candle(1, { volume: undefined });
    const source = Object.freeze([Object.freeze(original)]);
    const result = normalizeMarketCandles(source);

    assert.notEqual(result.candles[0], original);
    assert.equal(result.candles[0].volume, null);
    assert.equal(original.volume, undefined);
  });
});
