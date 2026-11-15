import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { MarketCandle } from './market-chart.types';
import {
  buildRsiPaneData,
  computeRsiValues,
  RSI_MIN_CANDLES,
  RSI_PERIOD,
  type RsiPaneData,
} from './market-chart.rsi';

function candles(closes: readonly number[], startTimeMs = 1_000): MarketCandle[] {
  return closes.map((close, index) => ({
    timeMs: startTimeMs + index * 60_000,
    open: close,
    high: close,
    low: close,
    close,
  }));
}

/**
 * Fixture closes 100..107 alternating +2/-1 across 14 changes. The expected
 * seed averages are 14/14 = 1 gain, 7/14 = 0.5 loss; the value below is the
 * same double-precision expression production evaluates (verified bit-for-bit
 * against a Python reference walk: repr '66.66666666666666').
 */
const KNOWN_CLOSES = [100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105, 107, 106, 108, 107];
const KNOWN_EXPECTED = 100 - 100 / (1 + 1 / 0.5);

function assertInsufficient(data: RsiPaneData, have: number) {
  assert.equal(data.kind, 'insufficient-history');
  if (data.kind === 'insufficient-history') {
    assert.equal(data.have, have);
    assert.equal(data.need, RSI_MIN_CANDLES);
  }
}

describe('computeRsiValues', () => {
  it('matches the hand-checked Wilder value on a known series', () => {
    const values = computeRsiValues(KNOWN_CLOSES);
    assert.equal(values.length, KNOWN_CLOSES.length);
    for (let index = 0; index < RSI_PERIOD; index += 1) {
      assert.equal(values[index], null);
    }
    assert.equal(values[14], KNOWN_EXPECTED);
    assert.equal(values[14], 66.66666666666666);
  });

  it('continues the series with Wilder smoothing, not a re-seeded average', () => {
    const values = computeRsiValues([...KNOWN_CLOSES, 106]);
    // Wilder walk for the last delta of -1: gains (1*13+0)/14, losses
    // (0.5*13+1)/14 → RS 13/7.5 (Python-verified repr '63.41463414634146').
    const expected = 100 - 100 / (1 + (1 * 13) / 14 / ((0.5 * 13 + 1) / 14));
    assert.equal(values[15], expected);
    assert.equal(values[15], 63.41463414634146);
  });

  it('returns one value for a series exactly at the minimum length', () => {
    assert.equal(RSI_MIN_CANDLES, 15);
    const values = computeRsiValues(KNOWN_CLOSES);
    const nonNull = values.filter((value) => value !== null);
    assert.deepEqual(nonNull, [KNOWN_EXPECTED]);
  });

  it('returns no values for a series one candle short of the minimum', () => {
    const values = computeRsiValues(KNOWN_CLOSES.slice(0, 14));
    assert.deepEqual(values, new Array(14).fill(null));
  });

  it('returns no values for an empty series', () => {
    assert.deepEqual(computeRsiValues([]), []);
  });

  it('scores a flat series as 50', () => {
    const flat = new Array(20).fill(42);
    const values = computeRsiValues(flat);
    assert.equal(values[14], 50);
    assert.equal(values[19], 50);
  });

  it('scores a strictly rising series as 100 and strictly falling as 0', () => {
    const rising = Array.from({ length: 20 }, (_, index) => index + 1);
    const falling = Array.from({ length: 20 }, (_, index) => 100 - index);
    const risingValues = computeRsiValues(rising);
    const fallingValues = computeRsiValues(falling);
    assert.equal(risingValues[14], 100);
    assert.equal(fallingValues[14], 0);
  });

  it('honours an explicit period and moves the minimum with it', () => {
    // 5 deltas [+1,-2,+3,0,-1]: avgGain 0.8, avgLoss 0.6.
    const closes = [100, 101, 99, 102, 102, 101];
    const values = computeRsiValues(closes, 5);
    const expected = 100 - 100 / (1 + 0.8 / 0.6);
    assert.equal(values[5], expected);
    assert.equal(values[5], 57.142857142857146);
    assert.equal(values[4], null);
  });
});

describe('buildRsiPaneData', () => {
  it('maps loading through and hides on error or empty venue responses', () => {
    assert.deepEqual(buildRsiPaneData([], 'loading'), { kind: 'loading' });
    assert.deepEqual(buildRsiPaneData(candles(KNOWN_CLOSES), 'error'), { kind: 'error' });
    assert.deepEqual(buildRsiPaneData(candles(KNOWN_CLOSES), 'empty'), { kind: 'error' });
  });

  it('produces a ready snapshot with the latest value and aligned points', () => {
    const data = buildRsiPaneData(candles(KNOWN_CLOSES, 5_000), 'ready');
    assert.equal(data.kind, 'ready');
    if (data.kind === 'ready') {
      assert.equal(data.value, KNOWN_EXPECTED);
      assert.deepEqual(
        data.points.map((point) => point.value),
        [KNOWN_EXPECTED],
      );
      assert.deepEqual(
        data.points.map((point) => point.timeMs),
        [5_000 + 14 * 60_000],
      );
    }
  });

  it('reports insufficient history when fewer candles exist than the period needs', () => {
    assertInsufficient(buildRsiPaneData(candles(KNOWN_CLOSES.slice(0, 14)), 'ready'), 14);
    assertInsufficient(buildRsiPaneData(candles([]), 'ready'), 0);
    assertInsufficient(buildRsiPaneData(candles([1.5]), 'ready'), 1);
  });

  it('sorts by candle time before computing, so array order cannot skew RSI', () => {
    const reversed = candles(KNOWN_CLOSES).reverse();
    const forward = buildRsiPaneData(candles(KNOWN_CLOSES), 'ready');
    const shuffled = buildRsiPaneData(reversed, 'ready');
    assert.equal(shuffled.kind, 'ready');
    assert.equal(forward.kind, 'ready');
    if (forward.kind === 'ready' && shuffled.kind === 'ready') {
      assert.equal(shuffled.value, forward.value);
      assert.deepEqual(
        shuffled.points.map((point) => point.value),
        forward.points.map((point) => point.value),
      );
    }
  });

  it('hides the pane data entirely when a close is not a finite number', () => {
    const broken: MarketCandle[] = [...candles(KNOWN_CLOSES)];
    broken[7] = { ...broken[7]!, close: Number.NaN };
    assert.deepEqual(buildRsiPaneData(broken, 'ready'), { kind: 'error' });
  });
});
