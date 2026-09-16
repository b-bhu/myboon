export type MarketChartMode = 'candles' | 'line';

export interface MarketCandle {
  readonly timeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume?: number | null;
}

export type MarketChartStatus =
  | { readonly kind: 'ready' }
  | { readonly kind: 'loading'; readonly accessibilityLabel?: string }
  | { readonly kind: 'empty'; readonly title: string; readonly description?: string }
  | {
      readonly kind: 'error';
      readonly title: string;
      readonly description?: string;
      readonly retryLabel?: string;
    };

export interface MarketChartLayers {
  readonly volume?: boolean;
  readonly currentPrice?: boolean;
}

export interface MarketChartSelection {
  readonly candle: MarketCandle | null;
  readonly candleIndex: number | null;
}

export interface MarketChartViewport {
  readonly startTimeMs: number | null;
  readonly endTimeMs: number | null;
  readonly visibleStartIndex: number;
  readonly visibleEndIndex: number;
  readonly atLiveEdge: boolean;
}

export interface MarketChartProps {
  /** Changes only when the market or interval changes, not for ordinary refreshes. */
  readonly seriesKey: string;
  readonly candles: readonly MarketCandle[];
  readonly mode: MarketChartMode;
  readonly status?: MarketChartStatus;
  readonly layers?: MarketChartLayers;
  readonly height?: number;
  readonly minimumVisibleCandles?: number;
  readonly initialVisibleCandles?: number;
  /** Empty candle slots kept after the latest candle so live data is not pinned to the edge. */
  readonly rightPaddingCandles?: number;
  /** Minimum fixed space after the latest candle, stable across zoom levels. */
  readonly rightPaddingPixels?: number;
  readonly formatPrice: (value: number) => string;
  readonly formatAxisPrice?: (value: number) => string;
  readonly formatTime: (timeMs: number) => string;
  readonly formatVolume?: (value: number) => string;
  readonly accessibilityLabel: string;
  readonly onSelectionChange?: (selection: MarketChartSelection) => void;
  readonly onViewportChange?: (viewport: MarketChartViewport) => void;
  readonly onLoadMoreHistory?: () => void;
  readonly hasMoreHistory?: boolean;
  readonly isLoadingHistory?: boolean;
  readonly historyLoadThreshold?: number;
  readonly onRetry?: () => void;
  readonly resetSignal?: number;
}

export interface IndexViewport {
  /** Inclusive fractional candle-slot index. */
  readonly start: number;
  /** Exclusive fractional candle-slot index. */
  readonly end: number;
}
