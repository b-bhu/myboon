import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { MarketCandle } from './market-chart.types';
import {
  buildCandlestickPaths,
  buildLinePath,
  buildVolumePaths,
  candleIndexForX,
  createMarketChartGeometry,
  createPriceTicks,
  createTimeTickIndices,
  hasVisibleCandleVolume,
  xForCandleIndex,
  yForPrice,
} from './market-chart.geometry';

function candles(count: number): MarketCandle[] {
  return Array.from({ length: count }, (_, index) => ({
    timeMs: index * 60_000,
    open: 100 + index,
    high: 103 + index,
    low: 98 + index,
    close: 101 + index * (index % 2 === 0 ? 1 : 0.5),
    volume: index * 10,
  }));
}

describe('createMarketChartGeometry', () => {
  it('reserves price, volume, and axis regions with a visible-only domain', () => {
    const data = candles(40);
    const geometry = createMarketChartGeometry(data, { start: 10, end: 30 }, 400, 300, true);

    assert.equal(geometry.plotLeft, 8);
    assert.equal(geometry.plotRight, 352);
    assert.ok(geometry.priceBottom < geometry.volumeTop);
    assert.equal(geometry.volumeBottom, 276);
    assert.equal(geometry.visibleStartIndex, 9);
    assert.equal(geometry.visibleEndIndex, 30);
    assert.ok(geometry.minimumPrice < data[10].low);
    assert.ok(geometry.maximumPrice > data[29].high);
    assert.equal(geometry.maximumVolume, data[29].volume);
  });

  it('creates a finite padded domain for one flat candle', () => {
    const data: MarketCandle[] = [{
      timeMs: 1,
      open: 0.000_01,
      high: 0.000_01,
      low: 0.000_01,
      close: 0.000_01,
      volume: null,
    }];
    const geometry = createMarketChartGeometry(data, { start: 0, end: 1 }, 320, 180, false);
    assert.ok(Number.isFinite(geometry.minimumPrice));
    assert.ok(Number.isFinite(geometry.maximumPrice));
    assert.ok(geometry.maximumPrice > geometry.minimumPrice);
  });

  it('shows volume only when the visible window contains usable volume', () => {
    const data = candles(40).map((candle, index) => ({
      ...candle,
      volume: index === 35 ? 100 : null,
    }));

    assert.equal(hasVisibleCandleVolume(data, { start: 0, end: 20 }), false);
    assert.equal(hasVisibleCandleVolume(data, { start: 20, end: 40 }), true);
    assert.equal(hasVisibleCandleVolume([], { start: 0, end: 0 }), false);
  });
});

describe('coordinate mapping', () => {
  it('maps candle slots and prices into the plot', () => {
    const data = candles(20);
    const geometry = createMarketChartGeometry(data, { start: 0, end: 20 }, 400, 300, false);
    assert.ok(xForCandleIndex(geometry, 0) > geometry.plotLeft);
    assert.ok(xForCandleIndex(geometry, 19) < geometry.plotRight);
    assert.equal(candleIndexForX(geometry, geometry.plotLeft, data.length), 0);
    assert.equal(candleIndexForX(geometry, geometry.plotRight, data.length), 19);
    assert.ok(yForPrice(geometry, geometry.maximumPrice) <= geometry.plotTop + 0.001);
    assert.ok(yForPrice(geometry, geometry.minimumPrice) >= geometry.priceBottom - 0.001);
  });

  it('keeps live-edge breathing room and supports a manual price scale', () => {
    const data = candles(20);
    const automatic = createMarketChartGeometry(
      data,
      { start: 0, end: 20 },
      400,
      300,
      true,
    );
    const adjusted = createMarketChartGeometry(
      data,
      { start: 0, end: 20 },
      400,
      300,
      true,
      { rightPaddingCandles: 5, priceScale: 2 },
    );

    assert.ok(xForCandleIndex(adjusted, 19) < xForCandleIndex(automatic, 19));
    assert.equal(adjusted.horizontalSpan, 25);
    assert.ok(
      adjusted.maximumPrice - adjusted.minimumPrice
      < automatic.maximumPrice - automatic.minimumPrice,
    );
  });

  it('keeps a stable minimum live-edge gap across zoom levels', () => {
    const data = candles(120);
    const wideViewport = createMarketChartGeometry(
      data,
      { start: 30, end: 120 },
      390,
      320,
      true,
      { rightPaddingPixels: 16 },
    );
    const zoomedViewport = createMarketChartGeometry(
      data,
      { start: 100, end: 120 },
      390,
      320,
      true,
      { rightPaddingPixels: 16 },
    );

    assert.ok(wideViewport.rightPaddingWidth >= 16);
    assert.ok(zoomedViewport.rightPaddingWidth >= 16);
    assert.ok(wideViewport.rightPaddingWidth < 17);
    assert.ok(zoomedViewport.rightPaddingWidth < 17);
  });
});

describe('render paths and ticks', () => {
  it('builds positive and negative candle and volume paths', () => {
    const data = [
      { timeMs: 1, open: 10, high: 12, low: 9, close: 11, volume: 10 },
      { timeMs: 2, open: 11, high: 12, low: 8, close: 9, volume: 20 },
    ];
    const geometry = createMarketChartGeometry(data, { start: 0, end: 2 }, 360, 220, true);
    const candlesPath = buildCandlestickPaths(data, geometry);
    const volumePath = buildVolumePaths(data, geometry);

    assert.match(candlesPath.positive, /^M/);
    assert.match(candlesPath.negative, /^M/);
    assert.match(volumePath.positive, /^M/);
    assert.match(volumePath.negative, /^M/);
  });

  it('builds an unsmoothed line and de-duplicated ticks', () => {
    const data = candles(3);
    const geometry = createMarketChartGeometry(data, { start: 0, end: 3 }, 320, 180, false);
    const line = buildLinePath(data, geometry);
    assert.equal((line.match(/M/g) ?? []).length, 1);
    assert.equal((line.match(/L/g) ?? []).length, 2);
    assert.equal(createPriceTicks(geometry).length, 5);
    assert.deepEqual(createTimeTickIndices(geometry, data.length, 4), [0, 1, 2]);
  });

  it('keeps historical time ticks inside the exclusive viewport end', () => {
    const data = candles(40);
    const geometry = createMarketChartGeometry(
      data,
      { start: 10, end: 30 },
      400,
      300,
      false,
    );

    assert.deepEqual(createTimeTickIndices(geometry, data.length, 4), [10, 16, 23, 29]);
    createTimeTickIndices(geometry, data.length, 4).forEach((index) => {
      assert.ok(xForCandleIndex(geometry, index) < geometry.plotRight);
    });
  });
});
