import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mapPhoenixChartEvents } from './phoenix.chart-events';

const candles = [
  { time: 1_700_000_000, close: 100 },
  { time: 1_700_000_060, close: 101 },
  { time: 1_700_000_120, close: 102 },
];

describe('mapPhoenixChartEvents', () => {
  it('normalizes seconds candles, assigns nearest prices, and groups memories', () => {
    const markers = mapPhoenixChartEvents(candles, [
      { text: 'older', eventAt: '2023-11-14T22:13:25.000Z' },
      { text: 'newer', eventAt: '2023-11-14T22:13:45.000Z' },
      { text: 'next candle', eventAt: '2023-11-14T22:14:20.000Z' },
    ]);

    assert.equal(markers.length, 2);
    assert.equal(markers[0].candleIndex, 0);
    assert.equal(markers[0].time, 1_700_000_000_000);
    assert.equal(markers[0].price, 100);
    assert.equal(markers[0].chartPosition, null);
    assert.deepEqual(markers[0].events.map((event) => event.text), ['newer', 'older']);
    assert.equal(markers[1].candleIndex, 1);
    assert.equal(markers[1].price, 101);
    assert.notEqual(markers[0].id, markers[1].id);
  });

  it('accepts millisecond candles with the same canonical marker identity', () => {
    const first = mapPhoenixChartEvents(
      [{ time: 1_700_000_000, close: 100 }],
      [{ text: 'memory', eventAt: '2023-11-14T22:13:20.000Z' }],
    )[0];
    const second = mapPhoenixChartEvents(
      [{ time: 1_700_000_000_000, close: 100 }],
      [{ text: 'memory', eventAt: '2023-11-14T22:13:20.000Z' }],
    )[0];

    assert.equal(first.time, 1_700_000_000_000);
    assert.equal(first.id, second.id);
  });

  it('filters malformed and out-of-visible-range memories', () => {
    const markers = mapPhoenixChartEvents(candles, [
      { text: '', eventAt: '2023-11-14T22:13:20.000Z' },
      { text: 'invalid date', eventAt: 'not a date' },
      { text: 'before', eventAt: '2023-11-14T22:12:00.000Z' },
      { text: 'after', eventAt: '2023-11-14T22:16:00.000Z' },
      { text: 'valid', eventAt: '2023-11-14T22:14:00.000Z' },
    ]);

    assert.deepEqual(markers.map((marker) => marker.events.map((event) => event.text)), [['valid']]);
  });

  it('handles empty, invalid, and flat inputs without fabricating data', () => {
    assert.deepEqual(mapPhoenixChartEvents([], [{ text: 'memory', eventAt: '2023-11-14T22:13:20.000Z' }]), []);
    assert.deepEqual(mapPhoenixChartEvents([{ time: Number.NaN, close: 1 }], []), []);

    const markers = mapPhoenixChartEvents(
      [{ time: 1_700_000_000, close: 7 }, { time: 1_700_000_060, close: 7 }],
      [{ text: 'flat chart', eventAt: '2023-11-14T22:13:50.000Z' }],
    );
    assert.equal(markers.length, 1);
    assert.equal(markers[0].price, 7);
  });
});

describe('demo chart positions', () => {
  it('spaces events by presentation position and preserves their images', () => {
    const markers = mapPhoenixChartEvents(candles, [
      {
        text: 'left',
        eventAt: '2020-01-01T00:00:00.000Z',
        imageUrl: 'https://example.com/left.png',
        chartPosition: 0,
      },
      {
        text: 'right',
        eventAt: '2020-01-01T00:00:00.000Z',
        imageUrl: 'https://example.com/right.png',
        chartPosition: 1,
      },
    ]);

    assert.deepEqual(markers.map((marker) => marker.candleIndex), [0, 2]);
    assert.deepEqual(markers.map((marker) => marker.chartPosition), [0, 1]);
    assert.deepEqual(markers.map((marker) => marker.events[0].imageUrl), [
      'https://example.com/left.png',
      'https://example.com/right.png',
    ]);
  });

  it('keeps all positioned memories distinct on a partial candle response', () => {
    const positions = [0.07, 0.16, 0.25, 0.35, 0.45, 0.56, 0.67, 0.77, 0.87, 0.96];
    const markers = mapPhoenixChartEvents(candles.slice(0, 2), positions.map((chartPosition, index) => ({
      text: `memory ${index}`,
      eventAt: '2020-01-01T00:00:00.000Z',
      chartPosition,
    })));

    assert.equal(markers.length, 10);
    assert.deepEqual(markers.map((marker) => marker.chartPosition), positions);
    assert.equal(new Set(markers.map((marker) => marker.id)).size, 10);
  });
});
