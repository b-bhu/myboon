import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  IconChartCandle,
  IconChartLine,
  IconCheck,
  IconChevronDown,
  IconRefresh,
} from '@tabler/icons-react-native';
import {
  MarketChart,
  type MarketCandle,
  type MarketChartMode,
  type MarketChartSelection,
  type MarketChartStatus,
} from '@/features/charts';
import {
  adaptPhoenixCandles,
  mergePhoenixCandlePages,
} from '@/features/perps/phoenix.chart-adapter';
import {
  DEFAULT_PHOENIX_CHART_TIMEFRAME_INDEX,
  formatPhoenixAxisPrice,
  formatPhoenixChartTime,
  PHOENIX_CHART_TIMEFRAMES,
} from '@/features/perps/phoenix.chart-config';
import {
  fetchPhoenixCandles,
  formatPhoenixPrice,
  type PhoenixCandle,
} from '@/features/perps/phoenix.api';
import { marketChartTheme } from '@/features/charts/market-chart.theme';

const DEFAULT_CHART_HEIGHT = 320;
const EMPTY_MARKET_CANDLES: readonly MarketCandle[] = [];

interface PhoenixPriceChartProps {
  symbol: string;
  height?: number;
  onScrub?: (price: number | null, time: number | null) => void;
  onLatestPrice?: (price: number | null) => void;
}

export function PhoenixPriceChart({
  symbol,
  height = DEFAULT_CHART_HEIGHT,
  onScrub,
  onLatestPrice,
}: PhoenixPriceChartProps) {
  const [timeframeIndex, setTimeframeIndex] = useState(
    DEFAULT_PHOENIX_CHART_TIMEFRAME_INDEX,
  );
  const [timeframeOpen, setTimeframeOpen] = useState(false);
  const [mode, setMode] = useState<MarketChartMode>('candles');
  const [rawCandles, setRawCandles] = useState<PhoenixCandle[]>([]);
  const [resolvedSeriesKey, setResolvedSeriesKey] = useState<string | null>(null);
  const [status, setStatus] = useState<MarketChartStatus>({ kind: 'loading' });
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [reloadSignal, setReloadSignal] = useState(0);
  const [timeframeAnchor, setTimeframeAnchor] = useState({ x: 0, y: 0 });
  const timeframeAnchorRef = useRef<View | null>(null);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const latestPriceCallbackRef = useRef(onLatestPrice);
  const scrubCallbackRef = useRef(onScrub);
  const historyLoadingRef = useRef(false);
  const historyControllerRef = useRef<AbortController | null>(null);
  latestPriceCallbackRef.current = onLatestPrice;
  scrubCallbackRef.current = onScrub;

  const timeframe = PHOENIX_CHART_TIMEFRAMES[timeframeIndex];
  const seriesKey = `${symbol}:${timeframe.interval}:${timeframe.count}`;

  useEffect(() => {
    const controller = new AbortController();
    historyControllerRef.current?.abort();
    historyControllerRef.current = null;
    historyLoadingRef.current = false;
    setResolvedSeriesKey(null);
    setStatus({ kind: 'loading', accessibilityLabel: `Loading ${symbol} chart` });
    setRawCandles([]);
    setHasMoreHistory(true);
    setIsLoadingHistory(false);
    setHistoryError(false);
    scrubCallbackRef.current?.(null, null);
    latestPriceCallbackRef.current?.(null);

    fetchPhoenixCandles(symbol, timeframe.interval, timeframe.count, {
      signal: controller.signal,
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        const normalizedResponse = adaptPhoenixCandles(data);
        setRawCandles(data);
        setResolvedSeriesKey(seriesKey);
        latestPriceCallbackRef.current?.(normalizedResponse.candles.at(-1)?.close ?? null);
        setStatus(normalizedResponse.candles.length > 0
          ? { kind: 'ready' }
          : {
              kind: 'empty',
              title: 'No candle history',
              description: data.length > 0
                ? 'Phoenix returned no usable candles for this range.'
                : 'Phoenix returned no candles for this range.',
            });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setRawCandles([]);
        setResolvedSeriesKey(seriesKey);
        latestPriceCallbackRef.current?.(null);
        setStatus({
          kind: 'error',
          title: 'Chart unavailable',
          description: error instanceof Error
            ? error.message
            : 'Phoenix candle history could not be loaded.',
          retryLabel: 'Retry',
        });
      });

    return () => {
      controller.abort();
      historyControllerRef.current?.abort();
    };
  }, [reloadSignal, seriesKey, symbol, timeframe.count, timeframe.interval]);

  const adapted = useMemo(() => adaptPhoenixCandles(rawCandles), [rawCandles]);
  const candles = resolvedSeriesKey === seriesKey
    ? adapted.candles
    : EMPTY_MARKET_CANDLES;

  useEffect(() => {
    if (!__DEV__ || (adapted.rejectedRows === 0 && adapted.duplicateTimes.length === 0)) {
      return;
    }
    console.warn('[PhoenixPriceChart] normalized malformed candle response', {
      rejectedRows: adapted.rejectedRows,
      duplicateTimes: adapted.duplicateTimes.length,
    });
  }, [adapted.duplicateTimes.length, adapted.rejectedRows]);

  const chartStatus = useMemo<MarketChartStatus>(() => (
    resolvedSeriesKey !== seriesKey
      ? { kind: 'loading', accessibilityLabel: `Loading ${symbol} chart` }
      : status.kind === 'ready' && candles.length === 0
      ? {
          kind: 'empty',
          title: 'No candle history',
          description: 'Phoenix returned no usable candles for this range.',
        }
      : status
  ), [candles.length, resolvedSeriesKey, seriesKey, status, symbol]);

  const handleSelectionChange = useCallback((next: MarketChartSelection) => {
    scrubCallbackRef.current?.(
      next.candle?.close ?? null,
      next.candle?.timeMs ?? null,
    );
  }, []);

  const handleTimeframeChange = useCallback((index: number) => {
    setTimeframeOpen(false);
    if (index === timeframeIndex) return;
    setTimeframeIndex(index);
    scrubCallbackRef.current?.(null, null);
  }, [timeframeIndex]);

  const openTimeframeMenu = useCallback(() => {
    timeframeAnchorRef.current?.measureInWindow((x, y, width, height) => {
      setTimeframeAnchor({
        x: Math.max(
          marketChartTheme.metrics.toolbarInset,
          Math.min(
            x,
            windowWidth
              - marketChartTheme.metrics.toolbarInset
              - marketChartTheme.metrics.menuWidth,
          ),
        ),
        y: Math.max(
          marketChartTheme.metrics.toolbarInset,
          Math.min(
            y + height + marketChartTheme.metrics.menuOffset,
            windowHeight
              - marketChartTheme.metrics.toolbarInset
              - PHOENIX_CHART_TIMEFRAMES.length * marketChartTheme.metrics.menuRowHeight,
          ),
        ),
      });
      setTimeframeOpen(true);
    });
  }, [windowHeight, windowWidth]);

  const loadMoreHistory = useCallback(() => {
    if (
      historyLoadingRef.current
      || !hasMoreHistory
      || rawCandles.length === 0
      || resolvedSeriesKey !== seriesKey
    ) {
      return;
    }

    const controller = new AbortController();
    const currentCandles = rawCandles;
    const oldestCandle = currentCandles[0];
    historyControllerRef.current = controller;
    historyLoadingRef.current = true;
    setIsLoadingHistory(true);
    setHistoryError(false);

    void fetchPhoenixCandles(symbol, timeframe.interval, timeframe.count, {
      signal: controller.signal,
      endTime: oldestCandle.time - 1,
    })
      .then((olderCandles) => {
        if (controller.signal.aborted) return;
        const merged = mergePhoenixCandlePages(olderCandles, currentCandles);
        const addedCount = merged.length - currentCandles.length;
        if (addedCount <= 0) {
          setHasMoreHistory(false);
          return;
        }
        setRawCandles(merged);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setHistoryError(true);
        setHasMoreHistory(false);
      })
      .finally(() => {
        if (historyControllerRef.current !== controller) return;
        historyControllerRef.current = null;
        historyLoadingRef.current = false;
        setIsLoadingHistory(false);
      });
  }, [
    hasMoreHistory,
    rawCandles,
    resolvedSeriesKey,
    seriesKey,
    symbol,
    timeframe.count,
    timeframe.interval,
  ]);

  const handleHistoryRetry = useCallback(() => {
    setHistoryError(false);
    setHasMoreHistory(true);
  }, []);

  const handleRetry = useCallback(() => {
    setReloadSignal((value) => value + 1);
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.controls}>
        <View ref={timeframeAnchorRef} collapsable={false}>
          <Pressable
            style={({ pressed }) => [
              styles.timeframeButton,
              pressed && styles.controlPressed,
            ]}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`Candle interval, ${timeframe.label}`}
            accessibilityHint="Opens candle interval options"
            accessibilityState={{ expanded: timeframeOpen }}
            onPress={openTimeframeMenu}
          >
            <Text style={styles.timeframeButtonLabel}>{timeframe.label}</Text>
            <IconChevronDown
              size={16}
              strokeWidth={2}
              color={marketChartTheme.colors.secondaryText}
            />
          </Pressable>
        </View>

        <View style={styles.controlGroup}>
          {historyError ? (
            <Pressable
              style={({ pressed }) => [styles.iconButton, pressed && styles.controlPressed]}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Retry loading older candles"
              onPress={handleHistoryRetry}
            >
              <IconRefresh
                size={marketChartTheme.metrics.iconSize}
                strokeWidth={2}
                color={marketChartTheme.colors.secondaryText}
              />
            </Pressable>
          ) : null}

          <View
            style={styles.modeToggle}
            accessibilityRole="radiogroup"
            accessibilityLabel="Chart type"
          >
            <ChartModeButton
              mode="candles"
              selected={mode === 'candles'}
              label="Candlestick chart"
              onPress={() => setMode('candles')}
            />
            <View style={styles.modeDivider} />
            <ChartModeButton
              mode="line"
              selected={mode === 'line'}
              label="Line chart"
              onPress={() => setMode('line')}
            />
          </View>

        </View>
      </View>

      <Modal
        visible={timeframeOpen}
        transparent
        animationType="fade"
        presentationStyle="overFullScreen"
        statusBarTranslucent
        onRequestClose={() => setTimeframeOpen(false)}
      >
        <View style={styles.menuLayer} accessibilityViewIsModal>
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel="Close candle interval menu"
            onPress={() => setTimeframeOpen(false)}
          />
          <View
            style={[
              styles.timeframeMenu,
              { left: timeframeAnchor.x, top: timeframeAnchor.y },
            ]}
          >
            {PHOENIX_CHART_TIMEFRAMES.map((candidate, index) => {
              const selected = index === timeframeIndex;
              return (
                <Pressable
                  key={candidate.label}
                  style={({ pressed }) => [
                    styles.timeframeMenuRow,
                    selected && styles.timeframeMenuRowSelected,
                    pressed && styles.timeframeMenuRowPressed,
                  ]}
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected }}
                  onPress={() => handleTimeframeChange(index)}
                >
                  <Text style={[
                    styles.timeframeMenuLabel,
                    selected && styles.timeframeMenuLabelSelected,
                  ]}>
                    {candidate.label}
                  </Text>
                  {selected ? (
                    <IconCheck
                      size={17}
                      strokeWidth={2.25}
                      color={marketChartTheme.colors.accent}
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      </Modal>

      <View style={[styles.chartWrap, { height }]}>
        <MarketChart
          seriesKey={seriesKey}
          candles={candles}
          mode={mode}
          status={chartStatus}
          layers={{
            volume: true,
            currentPrice: true,
          }}
          height={height}
          formatPrice={formatPhoenixPrice}
          formatAxisPrice={formatPhoenixAxisPrice}
          formatTime={(timeMs) => formatPhoenixChartTime(timeMs, timeframe.interval)}
          formatVolume={formatCompactVolume}
          accessibilityLabel={`${symbol} Phoenix price chart`}
          onSelectionChange={handleSelectionChange}
          onLoadMoreHistory={loadMoreHistory}
          hasMoreHistory={hasMoreHistory}
          isLoadingHistory={isLoadingHistory}
          onRetry={handleRetry}
        />
      </View>
    </View>
  );
}

function ChartModeButton({
  mode,
  selected,
  label,
  onPress,
}: {
  readonly mode: MarketChartMode;
  readonly selected: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  const Icon = mode === 'candles' ? IconChartCandle : IconChartLine;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.modeButton,
        selected && styles.modeButtonSelected,
        pressed && styles.controlPressed,
      ]}
      hitSlop={{ top: 6, bottom: 6 }}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
    >
      <Icon
        size={marketChartTheme.metrics.iconSize}
        strokeWidth={2}
        color={selected
          ? marketChartTheme.colors.primaryText
          : marketChartTheme.colors.secondaryText}
      />
    </Pressable>
  );
}

function formatCompactVolume(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError';
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: marketChartTheme.colors.canvas,
  },
  controls: {
    height: marketChartTheme.metrics.toolbarHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: marketChartTheme.metrics.controlGap,
    paddingHorizontal: marketChartTheme.metrics.toolbarInset,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: marketChartTheme.colors.divider,
    backgroundColor: marketChartTheme.colors.toolbar,
  },
  timeframeButton: {
    width: marketChartTheme.metrics.timeframeWidth,
    height: marketChartTheme.metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: marketChartTheme.colors.border,
    borderRadius: marketChartTheme.metrics.controlRadius,
    backgroundColor: marketChartTheme.colors.control,
    borderCurve: 'continuous',
  },
  timeframeButtonLabel: {
    color: marketChartTheme.colors.primaryText,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  timeframeMenu: {
    position: 'absolute',
    width: marketChartTheme.metrics.menuWidth,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: marketChartTheme.colors.border,
    borderRadius: marketChartTheme.metrics.menuRadius,
    backgroundColor: marketChartTheme.colors.menu,
    borderCurve: 'continuous',
    shadowColor: '#000',
    shadowOpacity: 0.32,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  menuLayer: {
    flex: 1,
  },
  timeframeMenuRow: {
    height: marketChartTheme.metrics.menuRowHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
  },
  timeframeMenuRowSelected: {
    backgroundColor: marketChartTheme.colors.menuSelected,
  },
  timeframeMenuRowPressed: {
    backgroundColor: marketChartTheme.colors.controlSelected,
  },
  timeframeMenuLabel: {
    color: marketChartTheme.colors.secondaryText,
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  timeframeMenuLabelSelected: {
    color: marketChartTheme.colors.primaryText,
  },
  controlGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: marketChartTheme.metrics.controlGap,
  },
  modeToggle: {
    width: marketChartTheme.metrics.modeWidth,
    height: marketChartTheme.metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: marketChartTheme.colors.border,
    borderRadius: marketChartTheme.metrics.controlRadius,
    backgroundColor: marketChartTheme.colors.control,
    borderCurve: 'continuous',
  },
  modeButton: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeButtonSelected: {
    backgroundColor: marketChartTheme.colors.controlSelected,
  },
  modeDivider: {
    width: StyleSheet.hairlineWidth,
    height: 20,
    backgroundColor: marketChartTheme.colors.border,
  },
  iconButton: {
    width: marketChartTheme.metrics.controlHeight,
    height: marketChartTheme.metrics.controlHeight,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: marketChartTheme.colors.border,
    borderRadius: marketChartTheme.metrics.controlRadius,
    backgroundColor: marketChartTheme.colors.control,
    borderCurve: 'continuous',
  },
  controlPressed: {
    opacity: 0.72,
  },
  chartWrap: {
    position: 'relative',
  },
});
