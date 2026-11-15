/**
 * Pacifica price chart on the shared MarketChart (#651).
 *
 * Replaces the retired standalone react-native-svg chart: same timeframes and
 * candle source (perps.public-api fetchCandles), now rendered by the shared
 * chart library so all four venues serve one chart implementation. The
 * timeframe control is lifted to the shared range strip when the parent passes
 * timeframeIndex/onTimeframeIndexChange.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildRsiPaneData,
  MarketChart,
  type MarketChartSelection,
  type MarketCandle,
  type MarketChartStatus,
  type RsiPaneData,
} from '@/features/charts';
import { fetchCandles, formatPrice } from '@/features/perps/perps.public-api';
import type { CandleInterval } from '@/features/perps/perps.public-api';

export interface PacificaChartTimeframe {
  readonly label: '1H' | '1D' | '1W' | '1M' | 'ALL';
  readonly interval: CandleInterval;
  readonly count: number;
}

/** Same five ranges the retired inline chart offered (kept verbatim). */
export const PACIFICA_CHART_TIMEFRAMES: readonly PacificaChartTimeframe[] = [
  { label: '1H', interval: '1m', count: 60 },
  { label: '1D', interval: '15m', count: 96 },
  { label: '1W', interval: '1h', count: 168 },
  { label: '1M', interval: '4h', count: 180 },
  { label: 'ALL', interval: '1d', count: 365 },
];

export const DEFAULT_PACIFICA_CHART_TIMEFRAME_INDEX = 1; // 1D, as before

interface PacificaPriceChartProps {
  symbol: string;
  timeframeIndex?: number;
  onTimeframeIndexChange?: (index: number) => void;
  onScrub?: (price: number | null, time: number | null) => void;
  /** Reports the RSI pane inputs computed from this chart's candles (#656). */
  onRsiData?: (data: RsiPaneData) => void;
}

export function PacificaPriceChart({
  symbol,
  timeframeIndex: controlledTimeframeIndex,
  onTimeframeIndexChange,
  onScrub,
  onRsiData,
}: PacificaPriceChartProps) {
  const [internalTimeframeIndex] = useState(
    DEFAULT_PACIFICA_CHART_TIMEFRAME_INDEX,
  );
  const [candles, setCandles] = useState<readonly MarketCandle[]>([]);
  const [status, setStatus] = useState<MarketChartStatus>({
    kind: 'loading',
    accessibilityLabel: `Loading ${symbol} chart`,
  });
  const [reloadSignal, setReloadSignal] = useState(0);

  const timeframeIndex = controlledTimeframeIndex ?? internalTimeframeIndex;
  const timeframe = PACIFICA_CHART_TIMEFRAMES[timeframeIndex] ?? PACIFICA_CHART_TIMEFRAMES[0];
  const seriesKey = `pacifica:${symbol}:${timeframe.interval}:${timeframe.count}`;
  const scrubCallbackRef = useRef(onScrub);
  scrubCallbackRef.current = onScrub;

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: 'loading', accessibilityLabel: `Loading ${symbol} chart` });
    scrubCallbackRef.current?.(null, null);
    void fetchCandles(symbol, timeframe.interval, timeframe.count)
      .then((data) => {
        if (cancelled) return;
        const marketCandles = data.map((candle) => ({
          timeMs: candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        }));
        setCandles(marketCandles);
        setStatus(marketCandles.length > 0
          ? { kind: 'ready' }
          : {
              kind: 'empty',
              title: 'No candle history',
              description: 'Pacifica returned no candles for this range.',
            });
      })
      .catch(() => {
        if (cancelled) return;
        setCandles([]);
        setStatus({
          kind: 'error',
          title: 'Chart unavailable',
          description: 'Pacifica candle history could not be loaded.',
          retryLabel: 'Retry',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadSignal, seriesKey, symbol, timeframe.count, timeframe.interval]);

  const handleSelectionChange = useCallback((selection: MarketChartSelection) => {
    scrubCallbackRef.current?.(
      selection.candle?.close ?? null,
      selection.candle?.timeMs ?? null,
    );
  }, []);

  const rsiData = useMemo(
    () => buildRsiPaneData(candles, status.kind),
    [candles, status.kind],
  );
  const rsiDataCallbackRef = useRef(onRsiData);
  rsiDataCallbackRef.current = onRsiData;

  useEffect(() => {
    rsiDataCallbackRef.current?.(rsiData);
  }, [rsiData]);

  const handleRetry = useCallback(() => {
    setReloadSignal((value) => value + 1);
  }, []);

  const formatTime = useCallback(
    (timeMs: number) => formatPacificChartTime(timeMs, timeframe.interval),
    [timeframe.interval],
  );

  return (
    <MarketChart
      seriesKey={seriesKey}
      candles={candles}
      mode="line"
      status={status}
      formatPrice={formatPrice}
      formatTime={formatTime}
      accessibilityLabel={`${symbol} Pacifica price chart`}
      onSelectionChange={handleSelectionChange}
      onRetry={handleRetry}
    />
  );
}

function formatPacificChartTime(timeMs: number, interval: CandleInterval): string {
  const date = new Date(timeMs);
  if (!Number.isFinite(date.getTime())) return '';
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (interval === '1m' || interval === '3m' || interval === '5m' || interval === '15m' || interval === '30m') {
    return time;
  }
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (interval === '1d') return day;
  return `${day}, ${time}`;
}
