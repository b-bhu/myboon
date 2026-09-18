import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PHOENIX_CHART_TIMEFRAME_INDEX,
  formatPhoenixAxisPrice,
  formatPhoenixChartTime,
  PHOENIX_CHART_TIMEFRAMES,
} from './phoenix.chart-config';

describe('PHOENIX_CHART_TIMEFRAMES', () => {
  it('keeps the approved interval and count mapping', () => {
    assert.deepEqual(PHOENIX_CHART_TIMEFRAMES, [
      { label: '1m', interval: '1m', count: 180 },
      { label: '5m', interval: '5m', count: 180 },
      { label: '15m', interval: '15m', count: 180 },
      { label: '1h', interval: '1h', count: 180 },
      { label: '4h', interval: '4h', count: 180 },
      { label: '1d', interval: '1d', count: 180 },
    ]);
  });

  it('defaults to actual one-hour candles', () => {
    assert.equal(
      PHOENIX_CHART_TIMEFRAMES[DEFAULT_PHOENIX_CHART_TIMEFRAME_INDEX]?.interval,
      '1h',
    );
  });
});

describe('formatPhoenixChartTime', () => {
  it('uses time-only labels for intraday intervals and date plus time for hourly data', () => {
    const epoch = Date.UTC(2026, 8, 5, 5, 48, 0);
    assert.doesNotMatch(formatPhoenixChartTime(epoch, '15m'), /Sep/);
    assert.match(formatPhoenixChartTime(epoch, '1h'), /Sep 5/);
  });

  it('keeps hourly labels compact enough for a mobile time axis', () => {
    const epoch = Date.UTC(2026, 8, 5, 5, 48, 0);
    const label = formatPhoenixChartTime(epoch, '1h');
    assert.doesNotMatch(label, /:48/);
    assert.doesNotMatch(label, /,/);
  });
});

describe('formatPhoenixAxisPrice', () => {
  it('compacts thousands, millions, and billions for the narrow price axis', () => {
    assert.equal(formatPhoenixAxisPrice(75_973), '$76.0K');
    assert.equal(formatPhoenixAxisPrice(3_400_000), '$3.4M');
    assert.equal(formatPhoenixAxisPrice(1_200_000_000), '$1.2B');
  });
});
