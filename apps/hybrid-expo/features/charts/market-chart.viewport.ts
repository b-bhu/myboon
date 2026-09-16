import type {
  IndexViewport,
  MarketCandle,
  MarketChartViewport,
} from '@/features/charts/market-chart.types';

export const DEFAULT_INITIAL_VISIBLE_CANDLES = 90;
export const DEFAULT_MINIMUM_VISIBLE_CANDLES = 14;
export const LIVE_EDGE_THRESHOLD = 0.25;

export function createInitialViewport(
  candleCount: number,
  initialVisibleCandles = DEFAULT_INITIAL_VISIBLE_CANDLES,
  minimumVisibleCandles = DEFAULT_MINIMUM_VISIBLE_CANDLES,
): IndexViewport {
  if (candleCount <= 0) return { start: 0, end: 0 };
  const span = boundedSpan(
    initialVisibleCandles,
    candleCount,
    minimumVisibleCandles,
  );
  return { start: candleCount - span, end: candleCount };
}

export function clampViewport(
  viewport: IndexViewport,
  candleCount: number,
  minimumVisibleCandles = DEFAULT_MINIMUM_VISIBLE_CANDLES,
): IndexViewport {
  if (candleCount <= 0) return { start: 0, end: 0 };
  const requestedSpan = Number.isFinite(viewport.end - viewport.start)
    ? viewport.end - viewport.start
    : candleCount;
  const span = boundedSpan(requestedSpan, candleCount, minimumVisibleCandles);
  const start = clamp(viewport.start, 0, Math.max(0, candleCount - span));
  return { start, end: start + span };
}

export function panViewport(
  initial: IndexViewport,
  translationX: number,
  plotWidth: number,
  candleCount: number,
  minimumVisibleCandles = DEFAULT_MINIMUM_VISIBLE_CANDLES,
): IndexViewport {
  if (plotWidth <= 0 || candleCount <= 0) {
    return clampViewport(initial, candleCount, minimumVisibleCandles);
  }
  const span = initial.end - initial.start;
  const shift = -(translationX / plotWidth) * span;
  return clampViewport(
    { start: initial.start + shift, end: initial.end + shift },
    candleCount,
    minimumVisibleCandles,
  );
}

export function zoomViewport(
  initial: IndexViewport,
  scale: number,
  anchorRatio: number,
  candleCount: number,
  minimumVisibleCandles = DEFAULT_MINIMUM_VISIBLE_CANDLES,
): IndexViewport {
  if (candleCount <= 0) return { start: 0, end: 0 };
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const safeAnchor = clamp(anchorRatio, 0, 1);
  const initialSpan = initial.end - initial.start;
  const nextSpan = boundedSpan(
    initialSpan / safeScale,
    candleCount,
    minimumVisibleCandles,
  );
  const anchor = initial.start + initialSpan * safeAnchor;
  return clampViewport(
    {
      start: anchor - nextSpan * safeAnchor,
      end: anchor + nextSpan * (1 - safeAnchor),
    },
    candleCount,
    minimumVisibleCandles,
  );
}

export function isViewportAtLiveEdge(
  viewport: IndexViewport,
  candleCount: number,
): boolean {
  return candleCount <= 0 || viewport.end >= candleCount - LIVE_EDGE_THRESHOLD;
}

export function reconcileViewportForCandles(
  viewport: IndexViewport,
  previousCandles: readonly MarketCandle[],
  nextCandles: readonly MarketCandle[],
  options: {
    readonly followLatest: boolean;
    readonly initialVisibleCandles?: number;
    readonly minimumVisibleCandles?: number;
  },
): IndexViewport {
  const minimum = options.minimumVisibleCandles ?? DEFAULT_MINIMUM_VISIBLE_CANDLES;
  if (nextCandles.length === 0) return { start: 0, end: 0 };
  if (previousCandles.length === 0) {
    return createInitialViewport(
      nextCandles.length,
      options.initialVisibleCandles,
      minimum,
    );
  }

  const current = clampViewport(viewport, previousCandles.length, minimum);
  const span = boundedSpan(current.end - current.start, nextCandles.length, minimum);
  if (options.followLatest) {
    return { start: nextCandles.length - span, end: nextCandles.length };
  }

  const previousAnchorIndex = clamp(
    Math.floor(current.start),
    0,
    previousCandles.length - 1,
  );
  const anchorTime = previousCandles[previousAnchorIndex].timeMs;
  const fractionalOffset = current.start - previousAnchorIndex;
  const nextAnchorIndex = findTimestampInsertionIndex(nextCandles, anchorTime);
  return clampViewport(
    {
      start: nextAnchorIndex + fractionalOffset,
      end: nextAnchorIndex + fractionalOffset + span,
    },
    nextCandles.length,
    minimum,
  );
}

export function toMarketChartViewport(
  viewport: IndexViewport,
  candles: readonly MarketCandle[],
): MarketChartViewport {
  if (candles.length === 0) {
    return {
      startTimeMs: null,
      endTimeMs: null,
      visibleStartIndex: 0,
      visibleEndIndex: -1,
      atLiveEdge: true,
    };
  }
  const clamped = clampViewport(viewport, candles.length, 1);
  const visibleStartIndex = clamp(Math.floor(clamped.start), 0, candles.length - 1);
  const visibleEndIndex = clamp(Math.ceil(clamped.end) - 1, 0, candles.length - 1);
  return {
    startTimeMs: candles[visibleStartIndex].timeMs,
    endTimeMs: candles[visibleEndIndex].timeMs,
    visibleStartIndex,
    visibleEndIndex,
    atLiveEdge: isViewportAtLiveEdge(clamped, candles.length),
  };
}

export function findCandleIndexByTime(
  candles: readonly MarketCandle[],
  timeMs: number | null,
): number | null {
  if (timeMs === null) return null;
  const index = binarySearchExact(candles, timeMs);
  return index >= 0 ? index : null;
}

function boundedSpan(
  requested: number,
  candleCount: number,
  minimumVisibleCandles: number,
): number {
  const minimum = Math.min(
    candleCount,
    Math.max(1, Math.floor(minimumVisibleCandles)),
  );
  return clamp(requested, minimum, candleCount);
}

function findTimestampInsertionIndex(
  candles: readonly MarketCandle[],
  timeMs: number,
): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].timeMs < timeMs) low = middle + 1;
    else high = middle;
  }
  return clamp(low, 0, candles.length - 1);
}

function binarySearchExact(
  candles: readonly MarketCandle[],
  timeMs: number,
): number {
  let low = 0;
  let high = candles.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = candles[middle].timeMs;
    if (value === timeMs) return middle;
    if (value < timeMs) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
