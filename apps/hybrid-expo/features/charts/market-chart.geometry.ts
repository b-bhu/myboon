import type { IndexViewport, MarketCandle } from '@/features/charts/market-chart.types';
import { marketChartTheme } from '@/features/charts/market-chart.theme';
import { clamp, clampViewport } from '@/features/charts/market-chart.viewport';

export interface MarketChartGeometry {
  readonly width: number;
  readonly height: number;
  readonly plotLeft: number;
  readonly plotRight: number;
  readonly plotTop: number;
  readonly priceBottom: number;
  readonly volumeTop: number;
  readonly volumeBottom: number;
  readonly timeAxisY: number;
  readonly plotWidth: number;
  readonly horizontalSpan: number;
  readonly rightPaddingWidth: number;
  readonly priceHeight: number;
  readonly viewport: IndexViewport;
  readonly visibleStartIndex: number;
  readonly visibleEndIndex: number;
  readonly minimumPrice: number;
  readonly maximumPrice: number;
  readonly maximumVolume: number;
  readonly candleWidth: number;
}

export interface MarketChartPaths {
  readonly positive: string;
  readonly negative: string;
}

const PLOT_LEFT = 8;
export const MARKET_CHART_PRICE_AXIS_WIDTH = marketChartTheme.metrics.priceAxisWidth;
export const MARKET_CHART_TIME_AXIS_HEIGHT = marketChartTheme.metrics.timeAxisHeight;

const PLOT_RIGHT_RESERVE = MARKET_CHART_PRICE_AXIS_WIDTH;
const PLOT_TOP = 8;
const TIME_AXIS_RESERVE = MARKET_CHART_TIME_AXIS_HEIGHT;
const VOLUME_GAP = 6;

export function hasVisibleCandleVolume(
  candles: readonly MarketCandle[],
  viewport: IndexViewport,
  minimumVisibleCandles = 1,
): boolean {
  if (candles.length === 0) return false;
  const visibleViewport = clampViewport(
    viewport,
    candles.length,
    minimumVisibleCandles,
  );
  const first = Math.max(0, Math.floor(visibleViewport.start));
  const last = Math.min(candles.length - 1, Math.ceil(visibleViewport.end) - 1);
  for (let index = first; index <= last; index += 1) {
    const volume = candles[index]?.volume;
    if (volume !== null && volume !== undefined && volume > 0) return true;
  }
  return false;
}

export function createMarketChartGeometry(
  candles: readonly MarketCandle[],
  viewport: IndexViewport,
  width: number,
  height: number,
  showVolume: boolean,
  options?: {
    readonly priceScale?: number;
    readonly rightPaddingCandles?: number;
    readonly rightPaddingPixels?: number;
  },
): MarketChartGeometry {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(80, height);
  const plotLeft = PLOT_LEFT;
  const plotRight = Math.max(plotLeft + 1, safeWidth - PLOT_RIGHT_RESERVE);
  const timeAxisY = safeHeight - 6;
  const contentBottom = Math.max(PLOT_TOP + 1, safeHeight - TIME_AXIS_RESERVE);
  const volumeHeight = showVolume ? Math.min(64, safeHeight * 0.18) : 0;
  const volumeBottom = contentBottom;
  const volumeTop = showVolume
    ? Math.max(PLOT_TOP + 1, volumeBottom - volumeHeight)
    : volumeBottom;
  const priceBottom = showVolume
    ? Math.max(PLOT_TOP + 1, volumeTop - VOLUME_GAP)
    : contentBottom;
  const clampedViewport = clampViewport(viewport, candles.length, 1);
  const domainStartIndex = candles.length === 0
    ? 0
    : clamp(Math.floor(clampedViewport.start), 0, candles.length - 1);
  const domainEndIndex = candles.length === 0
    ? -1
    : clamp(Math.ceil(clampedViewport.end) - 1, 0, candles.length - 1);
  const visibleStartIndex = candles.length === 0
    ? 0
    : clamp(domainStartIndex - 1, 0, candles.length - 1);
  const visibleEndIndex = candles.length === 0
    ? -1
    : clamp(domainEndIndex + 1, 0, candles.length - 1);
  const visible = domainEndIndex >= domainStartIndex
    ? candles.slice(domainStartIndex, domainEndIndex + 1)
    : [];

  let minimumPrice = Number.POSITIVE_INFINITY;
  let maximumPrice = Number.NEGATIVE_INFINITY;
  let maximumVolume = 0;
  visible.forEach((candle) => {
    minimumPrice = Math.min(minimumPrice, candle.low);
    maximumPrice = Math.max(maximumPrice, candle.high);
    if (candle.volume !== null && candle.volume !== undefined) {
      maximumVolume = Math.max(maximumVolume, candle.volume);
    }
  });

  if (!Number.isFinite(minimumPrice) || !Number.isFinite(maximumPrice)) {
    minimumPrice = 0;
    maximumPrice = 1;
  } else {
    const rawRange = maximumPrice - minimumPrice;
    const padding = rawRange > 0
      ? rawRange * 0.08
      : Math.max(Math.abs(maximumPrice) * 0.005, 0.000_001);
    minimumPrice -= padding;
    maximumPrice += padding;
  }

  const priceScale = clamp(options?.priceScale ?? 1, 0.25, 8);
  const priceCenter = (minimumPrice + maximumPrice) / 2;
  const scaledPriceRange = (maximumPrice - minimumPrice) / priceScale;
  minimumPrice = priceCenter - scaledPriceRange / 2;
  maximumPrice = priceCenter + scaledPriceRange / 2;

  const plotWidth = Math.max(1, plotRight - plotLeft);
  const priceHeight = Math.max(1, priceBottom - PLOT_TOP);
  const span = Math.max(1, clampedViewport.end - clampedViewport.start);
  const requestedPaddingCandles = Math.max(0, options?.rightPaddingCandles ?? 0);
  const requestedPaddingPixels = clamp(
    options?.rightPaddingPixels ?? 0,
    0,
    Math.max(0, plotWidth - 1),
  );
  const minimumPaddingCandles = requestedPaddingPixels <= 0
    ? 0
    : Math.max(
        0,
        (requestedPaddingPixels * span - plotWidth * 0.5)
          / Math.max(1, plotWidth - requestedPaddingPixels),
      );
  const paddingCandles = Math.max(requestedPaddingCandles, minimumPaddingCandles);
  const horizontalSpan = span + paddingCandles;
  const rightPaddingWidth = plotWidth * (paddingCandles + 0.5) / horizontalSpan;

  return {
    width: safeWidth,
    height: safeHeight,
    plotLeft,
    plotRight,
    plotTop: PLOT_TOP,
    priceBottom,
    volumeTop,
    volumeBottom,
    timeAxisY,
    plotWidth,
    horizontalSpan,
    rightPaddingWidth,
    priceHeight,
    viewport: clampedViewport,
    visibleStartIndex,
    visibleEndIndex,
    minimumPrice,
    maximumPrice,
    maximumVolume,
    candleWidth: clamp((plotWidth / horizontalSpan) * 0.7, 1.2, 10),
  };
}

export function xForCandleIndex(
  geometry: MarketChartGeometry,
  index: number,
): number {
  return geometry.plotLeft
    + ((index + 0.5 - geometry.viewport.start) / geometry.horizontalSpan) * geometry.plotWidth;
}

export function yForPrice(
  geometry: MarketChartGeometry,
  price: number,
): number {
  const range = geometry.maximumPrice - geometry.minimumPrice || 1;
  return geometry.plotTop
    + (1 - (price - geometry.minimumPrice) / range) * geometry.priceHeight;
}

export function candleIndexForX(
  geometry: MarketChartGeometry,
  x: number,
  candleCount: number,
): number | null {
  if (candleCount <= 0) return null;
  const ratio = clamp(
    (x - geometry.plotLeft) / Math.max(1, geometry.plotWidth),
    0,
    0.999_999,
  );
  return clamp(
    Math.floor(geometry.viewport.start + ratio * geometry.horizontalSpan),
    0,
    candleCount - 1,
  );
}

export function buildCandlestickPaths(
  candles: readonly MarketCandle[],
  geometry: MarketChartGeometry,
): MarketChartPaths {
  let positive = '';
  let negative = '';
  for (
    let index = geometry.visibleStartIndex;
    index <= geometry.visibleEndIndex;
    index += 1
  ) {
    const candle = candles[index];
    if (!candle) continue;
    const x = xForCandleIndex(geometry, index);
    if (x < geometry.plotLeft - geometry.candleWidth || x > geometry.plotRight + geometry.candleWidth) {
      continue;
    }
    const highY = yForPrice(geometry, candle.high);
    const lowY = yForPrice(geometry, candle.low);
    const openY = yForPrice(geometry, candle.open);
    const closeY = yForPrice(geometry, candle.close);
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(1, Math.abs(openY - closeY));
    const halfWidth = geometry.candleWidth / 2;
    const path = [
      `M${round(x)},${round(highY)}V${round(lowY)}`,
      `M${round(x - halfWidth)},${round(bodyTop)}`,
      `H${round(x + halfWidth)}`,
      `V${round(bodyTop + bodyHeight)}`,
      `H${round(x - halfWidth)}Z`,
    ].join('');
    if (candle.close >= candle.open) positive += path;
    else negative += path;
  }
  return { positive, negative };
}

export function buildLinePath(
  candles: readonly MarketCandle[],
  geometry: MarketChartGeometry,
): string {
  let path = '';
  for (
    let index = geometry.visibleStartIndex;
    index <= geometry.visibleEndIndex;
    index += 1
  ) {
    const candle = candles[index];
    if (!candle) continue;
    const x = xForCandleIndex(geometry, index);
    if (x < geometry.plotLeft || x > geometry.plotRight) continue;
    path += `${path ? 'L' : 'M'}${round(x)},${round(yForPrice(geometry, candle.close))}`;
  }
  return path;
}

export function buildVolumePaths(
  candles: readonly MarketCandle[],
  geometry: MarketChartGeometry,
): MarketChartPaths {
  if (geometry.maximumVolume <= 0 || geometry.volumeBottom <= geometry.volumeTop) {
    return { positive: '', negative: '' };
  }
  let positive = '';
  let negative = '';
  const barWidth = Math.max(1, Math.min(geometry.candleWidth, 8));
  for (
    let index = geometry.visibleStartIndex;
    index <= geometry.visibleEndIndex;
    index += 1
  ) {
    const candle = candles[index];
    if (!candle || !candle.volume) continue;
    const x = xForCandleIndex(geometry, index);
    if (x < geometry.plotLeft - barWidth || x > geometry.plotRight + barWidth) continue;
    const height = Math.max(
      1,
      (candle.volume / geometry.maximumVolume)
      * (geometry.volumeBottom - geometry.volumeTop),
    );
    const path = [
      `M${round(x - barWidth / 2)},${round(geometry.volumeBottom)}`,
      `V${round(geometry.volumeBottom - height)}`,
      `H${round(x + barWidth / 2)}`,
      `V${round(geometry.volumeBottom)}Z`,
    ].join('');
    if (candle.close >= candle.open) positive += path;
    else negative += path;
  }
  return { positive, negative };
}

export function createPriceTicks(
  geometry: MarketChartGeometry,
  count = 5,
): { value: number; y: number }[] {
  const ticks = Math.max(2, count);
  return Array.from({ length: ticks }, (_, index) => {
    const ratio = index / (ticks - 1);
    return {
      value: geometry.maximumPrice
        - (geometry.maximumPrice - geometry.minimumPrice) * ratio,
      y: geometry.plotTop + geometry.priceHeight * ratio,
    };
  });
}

export function createTimeTickIndices(
  geometry: MarketChartGeometry,
  candleCount: number,
  count = 4,
): number[] {
  if (candleCount <= 0) return [];
  const tickCount = Math.max(2, count);
  const firstVisibleIndex = clamp(
    Math.floor(geometry.viewport.start),
    0,
    candleCount - 1,
  );
  const lastVisibleIndex = clamp(
    Math.ceil(geometry.viewport.end) - 1,
    firstVisibleIndex,
    candleCount - 1,
  );
  const indices = new Set<number>();
  for (let tick = 0; tick < tickCount; tick += 1) {
    const ratio = tick / (tickCount - 1);
    indices.add(clamp(
      Math.round(firstVisibleIndex + (lastVisibleIndex - firstVisibleIndex) * ratio),
      firstVisibleIndex,
      lastVisibleIndex,
    ));
  }
  return Array.from(indices);
}

function round(value: number): string {
  return value.toFixed(2);
}
