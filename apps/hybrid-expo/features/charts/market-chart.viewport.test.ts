import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { MarketCandle } from './market-chart.types';
import {
  clampViewport,
  createInitialViewport,
  findCandleIndexByTime,
  isViewportAtLiveEdge,
  panViewport,
  reconcileViewportForCandles,
  toMarketChartViewport,
  zoomViewport,
} from './market-chart.viewport';

function candles(count: number, offset = 0): MarketCandle[] {
  return Array.from({ length: count }, (_, index) => ({
    timeMs: (offset + index) * 1_000,
    open: index + 1,
    high: index + 2,
    low: index,
    close: index + 1.5,
    volume: index,
  }));
}

describe('initial and bounded viewport', () => {
  it('fits the latest 90 candles and handles a shorter series', () => {
    assert.deepEqual(createInitialViewport(100), { start: 10, end: 100 });
    assert.deepEqual(createInitialViewport(10), { start: 0, end: 10 });
    assert.deepEqual(createInitialViewport(0), { start: 0, end: 0 });
  });

  it('clamps spans and both data edges', () => {
    assert.deepEqual(clampViewport({ start: -20, end: 20 }, 100), { start: 0, end: 40 });
    assert.deepEqual(clampViewport({ start: 95, end: 105 }, 100), { start: 86, end: 100 });
    assert.deepEqual(clampViewport({ start: 0, end: 200 }, 100), { start: 0, end: 100 });
  });
});

describe('pan and zoom', () => {
  it('pans in candle slots and clamps at history', () => {
    assert.deepEqual(
      panViewport({ start: 40, end: 100 }, 100, 300, 100),
      { start: 20, end: 80 },
    );
    assert.deepEqual(
      panViewport({ start: 40, end: 100 }, -500, 300, 100),
      { start: 40, end: 100 },
    );
  });

  it('zooms around the requested anchor and respects the minimum span', () => {
    assert.deepEqual(
      zoomViewport({ start: 40, end: 100 }, 2, 0.25, 100),
      { start: 47.5, end: 77.5 },
    );
    assert.deepEqual(
      zoomViewport({ start: 40, end: 100 }, 100, 0.5, 100),
      { start: 63, end: 77 },
    );
  });
});

describe('live and timestamp preservation', () => {
  it('follows an append at live while preserving the visible count', () => {
    const previous = candles(100);
    const next = candles(101);
    assert.deepEqual(reconcileViewportForCandles(
      { start: 46, end: 100 },
      previous,
      next,
      { followLatest: true },
    ), { start: 47, end: 101 });
  });

  it('does not move a historical viewport when newer candles append', () => {
    const previous = candles(100);
    const next = candles(103);
    assert.deepEqual(reconcileViewportForCandles(
      { start: 10.5, end: 40.5 },
      previous,
      next,
      { followLatest: false },
    ), { start: 10.5, end: 40.5 });
  });

  it('preserves the visible timestamp anchor when history is prepended', () => {
    const previous = candles(100, 10);
    const next = candles(110, 0);
    assert.deepEqual(reconcileViewportForCandles(
      { start: 10.25, end: 40.25 },
      previous,
      next,
      { followLatest: false },
    ), { start: 20.25, end: 50.25 });
  });

  it('uses the quarter-slot live threshold', () => {
    assert.equal(isViewportAtLiveEdge({ start: 40, end: 99.75 }, 100), true);
    assert.equal(isViewportAtLiveEdge({ start: 40, end: 99.74 }, 100), false);
  });
});

describe('public viewport and selection identity', () => {
  it('reports visible timestamps, indices, and live state', () => {
    const data = candles(20);
    assert.deepEqual(toMarketChartViewport({ start: 5.2, end: 15.2 }, data), {
      startTimeMs: 5_000,
      endTimeMs: 15_000,
      visibleStartIndex: 5,
      visibleEndIndex: 15,
      atLiveEdge: false,
    });
  });

  it('finds exact timestamp identity only', () => {
    const data = candles(4);
    assert.equal(findCandleIndexByTime(data, 2_000), 2);
    assert.equal(findCandleIndexByTime(data, 2_500), null);
    assert.equal(findCandleIndexByTime(data, null), null);
  });
});
