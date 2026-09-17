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
  it('anchors exact candle timestamps and clusters nearby bubbles', () => {
    const layouts = createMarketChartAnnotationLayouts([
      annotation('a', 10),
      annotation('b', 11),
      annotation('c', 80),
    ], candles, geometry);

    assert.equal(layouts.length, 2);
    assert.deepEqual(layouts[0].annotations.map((item) => item.id), ['a', 'b']);
    assert.equal(layouts[0].count, 2);
    assert.deepEqual(layouts[1].annotations.map((item) => item.id), ['c']);
    layouts.forEach((layout) => {
      assert.ok(layout.x >= geometry.plotLeft);
      assert.ok(layout.x <= geometry.plotRight);
      assert.ok(layout.y >= geometry.plotTop);
      assert.ok(layout.y <= geometry.priceBottom);
    });
  });

  it('omits unknown timestamps and malformed display contracts', () => {
    const layouts = createMarketChartAnnotationLayouts([
      annotation('visible', 50),
      { ...annotation('outside', 50), timeMs: 123 },
      { ...annotation('blank', 51), label: '' },
    ], candles, geometry);

    assert.deepEqual(layouts.flatMap((layout) => layout.annotations.map((item) => item.id)), ['visible']);
  });

  it('hit-tests the nearest cluster and cycles its annotations', () => {
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
