import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createMarketChartAnnotationLayouts,
  findMarketChartAnnotationAtPoint,
  nextAnnotationInLayout,
} from './market-chart.annotations';
import { createMarketChartGeometry } from './market-chart.geometry';
import type { MarketCandle, MarketChartAnnotation } from './market-chart.types';

const candles: MarketCandle[] = Array.from({ length: 100 }, (_, index) => ({
  timeMs: 1_700_000_000_000 + index * 60_000,
  open: 100 + index,
  high: 102 + index,
  low: 99 + index,
  close: 101 + index,
  volume: 10 + index,
}));

const geometry = createMarketChartGeometry(
  candles,
  { start: 0, end: 100 },
  400,
  320,
  true,
);

describe('market chart annotation layout', () => {
  it('clusters nearby candles on a shared volume rail', () => {
    const layouts = createMarketChartAnnotationLayouts([
      annotation('a', 10),
      annotation('b', 11),
      annotation('c', 80),
    ], candles, geometry);

    assert.equal(layouts.length, 2);
    assert.deepEqual(layouts[0].annotations.map((item) => item.id), ['a', 'b']);
    assert.deepEqual(layouts[1].annotations.map((item) => item.id), ['c']);
    assert.deepEqual(layouts.map((layout) => layout.count), [2, 1]);
    layouts.forEach((layout) => {
      assert.ok(layout.x >= geometry.plotLeft);
      assert.ok(layout.x <= geometry.plotRight);
      assert.equal(layout.y, geometry.volumeTop + 8);
    });
  });

  it('preserves same-candle annotations inside their rail cluster', () => {
    const layouts = createMarketChartAnnotationLayouts([
      annotation('a', 10),
      annotation('b', 10),
      annotation('c', 30),
    ], candles, geometry);

    assert.equal(layouts.length, 2);
    assert.deepEqual(layouts[0].annotations.map((item) => item.id), ['a', 'b']);
    assert.deepEqual(layouts[1].annotations.map((item) => item.id), ['c']);
    assert.equal(layouts[0].count, 2);
    assert.equal(layouts[1].count, 1);
  });

  it('collapses a dense run into one compact rail marker', () => {
    const layouts = createMarketChartAnnotationLayouts(
      Array.from({ length: 6 }, (_, index) => annotation(`dense-${index}`, 40 + index)),
      candles,
      geometry,
    );

    assert.equal(layouts.length, 1);
    assert.equal(layouts[0].annotations.length, 6);
    assert.equal(layouts[0].count, 6);
  });

  it('separates a cluster as candle spacing grows under zoom', () => {
    const zoomedGeometry = createMarketChartGeometry(
      candles,
      { start: 8, end: 18 },
      400,
      320,
      true,
    );
    const layouts = createMarketChartAnnotationLayouts([
      annotation('a', 10),
      annotation('b', 11),
    ], candles, zoomedGeometry);

    assert.equal(layouts.length, 2);
    assert.deepEqual(layouts.map((layout) => layout.annotations[0].id), ['a', 'b']);
  });

  it('omits unknown timestamps and malformed display contracts', () => {
    const layouts = createMarketChartAnnotationLayouts([
      annotation('visible', 50),
      { ...annotation('outside', 50), timeMs: 123 },
      { ...annotation('blank', 51), label: '' },
    ], candles, geometry);

    assert.deepEqual(layouts.flatMap((layout) => layout.annotations.map((item) => item.id)), ['visible']);
  });

  it('hit-tests the rail marker and cycles annotations inside a cluster', () => {
    const [layout] = createMarketChartAnnotationLayouts([
      annotation('a', 10),
      annotation('b', 11),
    ], candles, geometry);

    assert.equal(findMarketChartAnnotationAtPoint([layout], layout.x, layout.y)?.id, layout.id);
    assert.equal(findMarketChartAnnotationAtPoint([layout], layout.x + 100, layout.y), null);
    assert.equal(nextAnnotationInLayout(layout, null).id, 'a');
    assert.equal(nextAnnotationInLayout(layout, 'a').id, 'b');
    assert.equal(nextAnnotationInLayout(layout, 'b').id, 'a');
  });
});

function annotation(id: string, candleIndex: number): MarketChartAnnotation {
  return {
    id,
    timeMs: candles[candleIndex].timeMs,
    label: `Story ${id}`,
    accessibilityLabel: `Story ${id}`,
    imageUrl: null,
  };
}
