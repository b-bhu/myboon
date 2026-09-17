import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { marketChartTheme } from './market-chart.theme';

function source(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url).href), 'utf8');
}

describe('shared chart boundary', () => {
  it('does not import venue, wallet, route, API, or analytics concerns', () => {
    const chart = source('./market-chart.tsx');
    assert.doesNotMatch(chart, /features\/(?:perps|wallet|predict|meteora)/);
    assert.doesNotMatch(chart, /fetchPhoenix|fetchPacifica|useRouter|useWallet|analytics/i);
    assert.doesNotMatch(chart, /\b(?:1H|1D|1W|1M)\b/);
  });

  it('keeps Phoenix as a container around the shared renderer', () => {
    const phoenix = source('../perps/PhoenixPriceChart.tsx');
    assert.match(phoenix, /<MarketChart/);
    assert.doesNotMatch(phoenix, /<Svg|PanResponder|GestureDetector/);
    assert.match(phoenix, /fetchPhoenixCandles/);
  });

  it('keeps compact chart chrome independent of generic Paper control geometry', () => {
    const phoenix = source('../perps/PhoenixPriceChart.tsx');
    assert.doesNotMatch(phoenix, /react-native-paper/);
    assert.match(phoenix, /IconChartCandle/);
    assert.match(phoenix, /IconChartLine/);
    assert.equal(marketChartTheme.metrics.toolbarHeight, 48);
    assert.equal(marketChartTheme.metrics.controlHeight, 32);
    assert.equal(marketChartTheme.metrics.priceAxisWidth, 48);
    assert.equal(marketChartTheme.metrics.liveEdgeGap, 24);
  });

  it('contains the approved gesture and keyboard grammar', () => {
    const chart = source('./market-chart.tsx');
    assert.match(chart, /LONG_PRESS_DURATION_MS = 330/);
    assert.match(chart, /activateAfterLongPress\(LONG_PRESS_DURATION_MS\)/);
    assert.match(chart, /Gesture\.Pinch\(\)/);
    assert.match(chart, /numberOfTaps\(2\)/);
    assert.match(chart, /key === 'ArrowLeft'/);
    assert.match(chart, /key === 'ArrowRight'/);
    assert.match(chart, /key === 'Escape'/);
    assert.match(chart, /key === 'End'/);
    assert.match(chart, /key === 'Enter'/);
  });

  it('registers web wheel zoom as non-passive before preventing scroll', () => {
    const chart = source('./market-chart.tsx');
    assert.match(chart, /addEventListener\('wheel', handleWheel, \{ passive: false \}\)/);
    assert.match(chart, /removeEventListener\('wheel', handleWheel\)/);
    assert.doesNotMatch(chart, /onWheel: handleWheel/);
  });

  it('keeps loading, empty, error, and retry presentation generic', () => {
    const chart = source('./market-chart.tsx');
    assert.match(chart, /effectiveStatus\.kind !== 'ready'/);
    assert.match(chart, /status\.kind === 'loading'/);
    assert.match(chart, /status\.kind === 'error'/);
    assert.match(chart, /status\.kind === 'error' && onRetry/);
    assert.doesNotMatch(chart, /Phoenix returned|Candles unavailable/);
  });
});
