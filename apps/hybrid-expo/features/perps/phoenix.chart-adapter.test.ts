import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptPhoenixCandles,
  mergePhoenixCandlePages,
  normalizePhoenixCandleEpoch,
  reconcilePhoenixCandleSnapshot,
  upsertPhoenixLiveCandle,
} from './phoenix.chart-adapter';
import type { PhoenixCandle } from './phoenix.api';

function candle(time: number, overrides: Partial<PhoenixCandle> = {}): PhoenixCandle {
  return {
    time,
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 5,
    volumeQuote: null,
    tradeCount: null,
    externalSource: null,
    ...overrides,
  };
}

describe('adaptPhoenixCandles', () => {
  it('normalizes second epochs, orders rows, and keeps the last duplicate', () => {
    const result = adaptPhoenixCandles([
      candle(1_700_000_060),
      candle(1_700_000_000, { close: 10.5 }),
      candle(1_700_000_000, { close: 11.5 }),
    ]);

    assert.deepEqual(result.candles.map((entry) => entry.timeMs), [
      1_700_000_000_000,
      1_700_000_060_000,
    ]);
    assert.equal(result.candles[0].close, 11.5);
    assert.deepEqual(result.duplicateTimes, [1_700_000_000_000]);
  });

  it('reports malformed rows without fabricating a candle', () => {
    const result = adaptPhoenixCandles([
      candle(1),
      candle(2, { high: 8 }),
      candle(3, { close: Number.NaN }),
    ]);
    assert.equal(result.candles.length, 1);
    assert.equal(result.rejectedRows, 2);
  });

  it('leaves millisecond epochs unchanged', () => {
    assert.equal(normalizePhoenixCandleEpoch(1_700_000_000_000), 1_700_000_000_000);
  });
});

describe('mergePhoenixCandlePages', () => {
  it('prepends older rows, sorts them, and lets the current page win duplicates', () => {
    const merged = mergePhoenixCandlePages(
      [candle(1), candle(2, { close: 20 })],
      [candle(2, { close: 22 }), candle(3)],
    );

    assert.deepEqual(merged.map((entry) => entry.time), [1, 2, 3]);
    assert.equal(merged[1].close, 22);
  });

  it('deduplicates equivalent second and millisecond timestamps', () => {
    const merged = mergePhoenixCandlePages(
      [candle(1_700_000_000)],
      [candle(1_700_000_000_000, { close: 14 })],
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].close, 14);
  });
});

describe('upsertPhoenixLiveCandle', () => {
  it('replaces the active candle without changing its position', () => {
    const current = [candle(1), candle(2, { close: 11 })];
    const next = upsertPhoenixLiveCandle(current, candle(2, { close: 13, volume: 9 }));

    assert.deepEqual(next.map((entry) => entry.time), [1, 2]);
    assert.equal(next[1].close, 13);
    assert.equal(next[1].volume, 9);
    assert.equal(current[1].close, 11);
  });

  it('appends a newly opened candle and accepts a historical correction', () => {
    const current = [candle(2), candle(3)];
    const appended = upsertPhoenixLiveCandle(current, candle(4));
    const corrected = upsertPhoenixLiveCandle(appended, candle(1, { close: 8 }));

    assert.deepEqual(appended.map((entry) => entry.time), [2, 3, 4]);
    assert.deepEqual(corrected.map((entry) => entry.time), [1, 2, 3, 4]);
    assert.equal(corrected[0].close, 8);
  });
});

describe('reconcilePhoenixCandleSnapshot', () => {
  it('lets a reconnect snapshot correct stale cached OHLCV values', () => {
    const reconciled = reconcilePhoenixCandleSnapshot(
      [candle(1), candle(2, { close: 20, volume: 4 })],
      [candle(2, { close: 22, volume: 9 }), candle(3)],
    );

    assert.deepEqual(reconciled.map((entry) => entry.time), [1, 2, 3]);
    assert.equal(reconciled[1].close, 22);
    assert.equal(reconciled[1].volume, 9);
  });
});
