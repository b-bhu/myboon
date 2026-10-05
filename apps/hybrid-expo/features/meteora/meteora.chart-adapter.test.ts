import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MeteoraOhlcvCandle } from '@myboon/shared/meteora';

import { adaptMeteoraCandles } from './meteora.chart-adapter';

function candle(timestamp: number, overrides: Partial<MeteoraOhlcvCandle> = {}): MeteoraOhlcvCandle {
  return {
    timestamp,
    timestampIso: '',
    open: '10',
    high: '12',
    low: '8',
    close: '11',
    volume: '1250',
    ...overrides,
  };
}

test('Meteora candles preserve OHLCV and normalize seconds to chart milliseconds', () => {
  assert.deepEqual(adaptMeteoraCandles([candle(1_700_000_000)]).candles, [{
    timeMs: 1_700_000_000_000,
    open: 10,
    high: 12,
    low: 8,
    close: 11,
    volume: 1250,
  }]);
});

test('inverted quotes reciprocate prices and reverse high/low without changing volume', () => {
  assert.deepEqual(adaptMeteoraCandles([candle(1_700_000_000)], true).candles, [{
    timeMs: 1_700_000_000_000,
    open: 1 / 10,
    high: 1 / 8,
    low: 1 / 12,
    close: 1 / 11,
    volume: 1250,
  }]);
});

test('out-of-order timestamps are sorted and second/millisecond duplicates keep the last candle', () => {
  const result = adaptMeteoraCandles([
    candle(1_700_000_060),
    candle(1_700_000_000),
    candle(1_700_000_000_000, { close: '10.5' }),
  ]);
  assert.deepEqual(result.candles.map((entry) => entry.timeMs), [1_700_000_000_000, 1_700_000_060_000]);
  assert.equal(result.candles[0].close, 10.5);
  assert.deepEqual(result.duplicateTimes, [1_700_000_000_000]);
});

test('invalid or zero prices and malformed ranges are rejected in either quote direction', () => {
  for (const inverted of [false, true]) {
    const result = adaptMeteoraCandles([
      candle(1),
      candle(2, { close: '0' }),
      candle(3, { open: 'bad' }),
      candle(4, { high: '9' }),
    ], inverted);
    assert.equal(result.candles.length, 1);
    assert.equal(result.rejectedRows, 3);
  }
});
