import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMarketChartAccessibilityValue } from '@/features/charts/market-chart.accessibility';
import type { MarketCandle } from '@/features/charts/market-chart.types';

const candle: MarketCandle = {
  timeMs: 1_780_000_000_000,
  open: 100,
  high: 112,
  low: 96,
  close: 108,
  volume: 12_500,
};

describe('buildMarketChartAccessibilityValue', () => {
  it('announces timestamp and OHLCV with consumer formatters', () => {
    assert.equal(
      buildMarketChartAccessibilityValue(
        candle,
        (value) => `$${value.toFixed(2)}`,
        (timeMs) => `time:${timeMs}`,
        (value) => `${value / 1000}K`,
      ),
      'time:1780000000000, open $100.00, high $112.00, low $96.00, '
        + 'close $108.00, volume 12.5K',
    );
  });

  it('omits missing volume and returns null without a candle', () => {
    assert.equal(
      buildMarketChartAccessibilityValue(
        { ...candle, volume: null },
        String,
        String,
      ),
      '1780000000000, open 100, high 112, low 96, close 108',
    );
    assert.equal(
      buildMarketChartAccessibilityValue(null, String, String),
      null,
    );
  });
});
