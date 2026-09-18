import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import Animated, { FadeIn, FadeOut, useReducedMotion } from 'react-native-reanimated';
import {
  IconChartCandle,
  IconChartLine,
  IconCheck,
  IconChevronDown,
  IconRefresh,
  IconSparkles,
} from '@tabler/icons-react-native';
import {
  MarketChart,
  type MarketCandle,
  type MarketChartAnnotation,
  type MarketChartMode,
  type MarketChartSelection,
  type MarketChartStatus,
} from '@/features/charts';
import {
  adaptPhoenixCandles,
  mergePhoenixCandlePages,
  reconcilePhoenixCandleSnapshot,
  upsertPhoenixLiveCandle,
} from '@/features/perps/phoenix.chart-adapter';
import {
  DEFAULT_PHOENIX_CHART_TIMEFRAME_INDEX,
  formatPhoenixAxisPrice,
  formatPhoenixChartTime,
  PHOENIX_CHART_TIMEFRAMES,
} from '@/features/perps/phoenix.chart-config';
import {
  mapPhoenixStoryToChartMarkers,
  type PhoenixChartStoryMarker,
} from '@/features/perps/phoenix.chart-stories';
import {
  fetchPhoenixCandles,
  formatPhoenixPrice,
  type PhoenixCandle,
} from '@/features/perps/phoenix.api';
import {
  normalizePhoenixLiveSymbol,
  type PhoenixLiveConnectionStatus,
  type PhoenixLiveMarketStats,
} from '@/features/perps/phoenix.live';
import { usePhoenixLiveMarket } from '@/features/perps/use-phoenix-live-market';
import { usePhoenixChartStories } from '@/features/perps/use-phoenix-chart-stories';
import { marketChartTheme } from '@/features/charts/market-chart.theme';
import { tokens } from '@/theme';

/*
 * PhoenixPriceChart owns the venue-specific realtime and Story adapters.
 * MarketChart stays transport- and product-agnostic and only renders normalized
 * candles plus generic annotations supplied by this parent.
 */

const DEFAULT_CHART_HEIGHT = 320;
const EMPTY_MARKET_CANDLES: readonly MarketCandle[] = [];

interface PhoenixCandleHistoryState {
  readonly rawCandles: PhoenixCandle[];
  readonly hasMoreHistory: boolean;
}

interface PhoenixResyncReplay {
  readonly controller: AbortController;
  readonly liveUpdates: PhoenixCandle[];
}

interface PhoenixPriceChartProps {
  symbol: string;
  height?: number;
  onScrub?: (price: number | null, time: number | null) => void;
  onLatestPrice?: (price: number | null) => void;
  onLiveMarketStats?: (stats: PhoenixLiveMarketStats) => void;
  onLiveStatusChange?: (status: PhoenixLiveConnectionStatus) => void;
}

export function PhoenixPriceChart({
  symbol,
  height = DEFAULT_CHART_HEIGHT,
  onScrub,
  onLatestPrice,
  onLiveMarketStats,
  onLiveStatusChange,
}: PhoenixPriceChartProps) {
  const [timeframeIndex, setTimeframeIndex] = useState(
    DEFAULT_PHOENIX_CHART_TIMEFRAME_INDEX,
  );
  const [timeframeOpen, setTimeframeOpen] = useState(false);
  const [mode, setMode] = useState<MarketChartMode>('candles');
  const [storiesVisible, setStoriesVisible] = useState(true);
  const [selectedStoryMarkerId, setSelectedStoryMarkerId] = useState<string | null>(null);
  const [selectedStoryEventIndex, setSelectedStoryEventIndex] = useState(0);
  const [{ rawCandles, hasMoreHistory }, setCandleHistory] = useState<PhoenixCandleHistoryState>({
    rawCandles: [],
    hasMoreHistory: true,
  });
  const [resolvedSeriesKey, setResolvedSeriesKey] = useState<string | null>(null);
  const [status, setStatus] = useState<MarketChartStatus>({ kind: 'loading' });
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [reloadSignal, setReloadSignal] = useState(0);
  const [timeframeAnchor, setTimeframeAnchor] = useState({ x: 0, y: 0 });
  const timeframeAnchorRef = useRef<View | null>(null);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const latestPriceCallbackRef = useRef(onLatestPrice);
  const scrubCallbackRef = useRef(onScrub);
  const liveMarketStatsCallbackRef = useRef(onLiveMarketStats);
  const liveStatusCallbackRef = useRef(onLiveStatusChange);
  const historyLoadingRef = useRef(false);
  const historyControllerRef = useRef<AbortController | null>(null);
  const resyncControllerRef = useRef<AbortController | null>(null);
  const resyncReplayRef = useRef<PhoenixResyncReplay | null>(null);
  const liveConnectionRef = useRef({ seriesKey: '', sequence: 0 });
  const latestLivePriceRef = useRef<number | null>(null);
  latestPriceCallbackRef.current = onLatestPrice;
  scrubCallbackRef.current = onScrub;
  liveMarketStatsCallbackRef.current = onLiveMarketStats;
  liveStatusCallbackRef.current = onLiveStatusChange;

  const timeframe = PHOENIX_CHART_TIMEFRAMES[timeframeIndex];
  const seriesKey = `${symbol}:${timeframe.interval}:${timeframe.count}`;
  const live = usePhoenixLiveMarket(symbol, timeframe.interval);
  const chartStories = usePhoenixChartStories(symbol);

  useEffect(() => {
    const controller = new AbortController();
    historyControllerRef.current?.abort();
    historyControllerRef.current = null;
    resyncControllerRef.current?.abort();
    resyncControllerRef.current = null;
    resyncReplayRef.current = null;
    historyLoadingRef.current = false;
    setResolvedSeriesKey(null);
    setStatus({ kind: 'loading', accessibilityLabel: `Loading ${symbol} chart` });
    setCandleHistory({ rawCandles: [], hasMoreHistory: true });
    setIsLoadingHistory(false);
    setHistoryError(false);
    latestLivePriceRef.current = null;
    scrubCallbackRef.current?.(null, null);
    latestPriceCallbackRef.current?.(null);

    fetchPhoenixCandles(symbol, timeframe.interval, timeframe.count, {
      signal: controller.signal,
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        const normalizedResponse = adaptPhoenixCandles(data);
        setCandleHistory((current) => ({
          ...current,
          rawCandles: mergePhoenixCandlePages(data, current.rawCandles),
        }));
        setResolvedSeriesKey(seriesKey);
        latestPriceCallbackRef.current?.(
          latestLivePriceRef.current ?? normalizedResponse.candles.at(-1)?.close ?? null,
        );
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
        setCandleHistory((current) => ({ ...current, rawCandles: [] }));
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
      resyncControllerRef.current?.abort();
      resyncReplayRef.current = null;
    };
  }, [reloadSignal, seriesKey, symbol, timeframe.count, timeframe.interval]);

  useEffect(() => {
    const update = live.candle;
    if (
      !update
      || update.timeframe !== timeframe.interval
      || update.symbol !== normalizePhoenixLiveSymbol(symbol)
    ) {
      return;
    }

    const resyncReplay = resyncReplayRef.current;
    if (resyncReplay && !resyncReplay.controller.signal.aborted) {
      resyncReplay.liveUpdates.push(update.candle);
    }
    setCandleHistory((current) => ({
      ...current,
      rawCandles: upsertPhoenixLiveCandle(current.rawCandles, update.candle),
    }));
    if (latestLivePriceRef.current === null) {
      latestPriceCallbackRef.current?.(update.candle.close);
    }
  }, [live.candle, symbol, timeframe.interval]);

  useEffect(() => {
    if (!live.marketStats) return;
    latestLivePriceRef.current = live.marketStats.markPrice;
    latestPriceCallbackRef.current?.(live.marketStats.markPrice);
    liveMarketStatsCallbackRef.current?.(live.marketStats);
  }, [live.marketStats]);

  useEffect(() => {
    liveStatusCallbackRef.current?.(live.status);
  }, [live.status]);

  useEffect(() => {
    const previous = liveConnectionRef.current;
    if (previous.seriesKey !== seriesKey) {
      liveConnectionRef.current = {
        seriesKey,
        sequence: live.connectionSequence,
      };
      return;
    }
    if (live.connectionSequence < previous.sequence) {
      liveConnectionRef.current = {
        seriesKey,
        sequence: live.connectionSequence,
      };
      return;
    }
    if (live.connectionSequence <= previous.sequence) return;

    const shouldResync = previous.sequence > 0;
    liveConnectionRef.current = {
      seriesKey,
      sequence: live.connectionSequence,
    };
    if (!shouldResync || resolvedSeriesKey !== seriesKey) return;

    const controller = new AbortController();
    resyncControllerRef.current?.abort();
    resyncControllerRef.current = controller;
    resyncReplayRef.current = { controller, liveUpdates: [] };
    void fetchPhoenixCandles(symbol, timeframe.interval, timeframe.count, {
      signal: controller.signal,
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        const liveUpdates = resyncReplayRef.current?.controller === controller
          ? [...resyncReplayRef.current.liveUpdates]
          : [];
        setCandleHistory((current) => ({
          ...current,
          rawCandles: reconcilePhoenixCandleSnapshot(
            current.rawCandles,
            data,
            liveUpdates,
          ),
        }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (__DEV__) {
          console.warn('[PhoenixPriceChart] reconnect candle resync failed', error);
        }
      })
      .finally(() => {
        if (resyncControllerRef.current === controller) {
          resyncControllerRef.current = null;
        }
        if (resyncReplayRef.current?.controller === controller) {
          resyncReplayRef.current = null;
        }
      });

    return () => {
      controller.abort();
      if (resyncReplayRef.current?.controller === controller) {
        resyncReplayRef.current = null;
      }
    };
  }, [
    live.connectionSequence,
    resolvedSeriesKey,
    seriesKey,
    symbol,
    timeframe.count,
    timeframe.interval,
  ]);

  const adapted = useMemo(() => adaptPhoenixCandles(rawCandles), [rawCandles]);
  const candles = resolvedSeriesKey === seriesKey
    ? adapted.candles
    : EMPTY_MARKET_CANDLES;
  const storyMarkers = useMemo<readonly PhoenixChartStoryMarker[]>(() => {
    if (rawCandles.length === 0 || !chartStories.story) return [];
    return mapPhoenixStoryToChartMarkers(
      rawCandles,
      chartStories.story,
      chartStories.events,
    );
  }, [chartStories.events, chartStories.story, rawCandles]);
  const storyAnnotations = useMemo<readonly MarketChartAnnotation[]>(() => (
    storyMarkers.map((marker) => ({
      id: marker.id,
      timeMs: marker.time,
      label: marker.events[0]?.text ?? marker.story.name,
      accessibilityLabel: `${marker.story.name}. ${marker.events[0]?.text ?? marker.story.latestDevelopment}`,
      imageUrl: marker.events[0]?.imageUrl ?? marker.story.imageUrl,
      fallbackText: '✦',
      tone: 'accent' as const,
    }))
  ), [storyMarkers]);
  const selectedStoryMarker = storyMarkers.find(
    (marker) => marker.id === selectedStoryMarkerId,
  ) ?? null;
  const selectedStoryEvent = selectedStoryMarker?.events[selectedStoryEventIndex]
    ?? selectedStoryMarker?.events[0]
    ?? null;

  useEffect(() => {
    if (
      selectedStoryMarkerId !== null
      && !storyMarkers.some((marker) => marker.id === selectedStoryMarkerId)
    ) {
      setSelectedStoryMarkerId(null);
      setSelectedStoryEventIndex(0);
    }
  }, [selectedStoryMarkerId, storyMarkers]);

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
    if (next.candle) {
      setSelectedStoryMarkerId(null);
      setSelectedStoryEventIndex(0);
    }
    scrubCallbackRef.current?.(
      next.candle?.close ?? null,
      next.candle?.timeMs ?? null,
    );
  }, []);

  const handleAnnotationSelectionChange = useCallback((
    annotation: MarketChartAnnotation | null,
  ) => {
    scrubCallbackRef.current?.(null, null);
    if (!annotation) {
      setSelectedStoryMarkerId(null);
      setSelectedStoryEventIndex(0);
      return;
    }

    const marker = storyMarkers.find((candidate) => candidate.id === annotation.id);
    if (!marker) return;
    if (annotation.id === selectedStoryMarkerId) {
      setSelectedStoryEventIndex((index) => (
        marker.events.length > 1 ? (index + 1) % marker.events.length : 0
      ));
    } else {
      setSelectedStoryMarkerId(annotation.id);
      setSelectedStoryEventIndex(0);
    }
  }, [selectedStoryMarkerId, storyMarkers]);

  const toggleStories = useCallback(() => {
    if (storiesVisible) {
      setSelectedStoryMarkerId(null);
      setSelectedStoryEventIndex(0);
    }
    setStoriesVisible(!storiesVisible);
  }, [storiesVisible]);

  const handleTimeframeChange = useCallback((index: number) => {
    setTimeframeOpen(false);
    if (index === timeframeIndex) return;
    setTimeframeIndex(index);
    setSelectedStoryMarkerId(null);
    setSelectedStoryEventIndex(0);
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
    const oldestCandle = rawCandles[0];
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
        setCandleHistory((current) => {
          const merged = mergePhoenixCandlePages(olderCandles, current.rawCandles);
          const addedCount = merged.length - current.rawCandles.length;
          return {
            rawCandles: merged,
            hasMoreHistory: addedCount > 0 && current.hasMoreHistory,
          };
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setHistoryError(true);
        setCandleHistory((current) => ({ ...current, hasMoreHistory: false }));
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
    setCandleHistory((current) => ({ ...current, hasMoreHistory: true }));
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

          {storyAnnotations.length > 0 ? (
            <Pressable
              style={({ pressed }) => [
                styles.storiesButton,
                storiesVisible && styles.storiesButtonSelected,
                pressed && styles.controlPressed,
              ]}
              hitSlop={{ top: 6, bottom: 6 }}
              accessibilityRole="switch"
              accessibilityLabel="Story annotations"
              accessibilityState={{ checked: storiesVisible }}
              onPress={toggleStories}
            >
              <IconSparkles
                size={14}
                strokeWidth={2}
                color={storiesVisible
                  ? tokens.colors.accent
                  : marketChartTheme.colors.secondaryText}
              />
              <Text style={[
                styles.storiesButtonLabel,
                storiesVisible && styles.storiesButtonLabelSelected,
              ]}>
                Stories
              </Text>
            </Pressable>
          ) : null}

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
            annotations: storiesVisible,
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
          annotations={storiesVisible ? storyAnnotations : []}
          selectedAnnotationId={storiesVisible ? selectedStoryMarkerId : null}
          onAnnotationSelectionChange={handleAnnotationSelectionChange}
        />
        {storiesVisible && selectedStoryEvent ? (
          <StoryAnnotationCard
            text={selectedStoryEvent.text}
            eventAt={selectedStoryEvent.eventAt}
            imageUrl={selectedStoryEvent.imageUrl}
            currentIndex={selectedStoryEventIndex}
            total={selectedStoryMarker?.events.length ?? 1}
          />
        ) : null}
      </View>
    </View>
  );
}

function StoryAnnotationCard({
  text,
  eventAt,
  imageUrl,
  currentIndex,
  total,
}: {
  readonly text: string;
  readonly eventAt: string;
  readonly imageUrl: string | null;
  readonly currentIndex: number;
  readonly total: number;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <Animated.View
      entering={reduceMotion ? undefined : FadeIn.duration(160)}
      exiting={reduceMotion ? undefined : FadeOut.duration(120)}
      pointerEvents="none"
      style={styles.storyCard}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {imageUrl ? (
        <Image
          source={imageUrl}
          style={styles.storyCardImage}
          contentFit="cover"
          transition={reduceMotion ? 0 : 120}
        />
      ) : (
        <View style={styles.storyCardFallback}>
          <Text style={styles.storyCardFallbackText}>S</Text>
        </View>
      )}
      <View style={styles.storyCardCopy}>
        <Text style={styles.storyCardTitle} numberOfLines={2} selectable>
          {text}
        </Text>
        <View style={styles.storyCardMeta}>
          <Text style={styles.storyCardTime} numberOfLines={1} selectable>
            {formatStoryTime(eventAt)}
          </Text>
          {total > 1 ? (
            <Text style={styles.storyCardCount}>
              {currentIndex + 1}/{total}
            </Text>
          ) : null}
        </View>
      </View>
    </Animated.View>
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

function formatStoryTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${day} · ${time}`;
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
  storiesButton: {
    width: 72,
    height: marketChartTheme.metrics.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: marketChartTheme.colors.border,
    borderRadius: marketChartTheme.metrics.controlRadius,
    backgroundColor: marketChartTheme.colors.control,
    borderCurve: 'continuous',
  },
  storiesButtonSelected: {
    borderColor: 'rgba(255, 209, 102, 0.42)',
    backgroundColor: 'rgba(255, 209, 102, 0.09)',
  },
  storiesButtonLabel: {
    color: marketChartTheme.colors.secondaryText,
    fontSize: 10,
    fontWeight: '700',
  },
  storiesButtonLabelSelected: {
    color: marketChartTheme.colors.primaryText,
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
  storyCard: {
    position: 'absolute',
    left: 12,
    right: marketChartTheme.metrics.priceAxisWidth + 8,
    bottom: marketChartTheme.metrics.timeAxisHeight + 8,
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 209, 102, 0.38)',
    borderRadius: 9,
    backgroundColor: 'rgba(5, 47, 59, 0.96)',
    borderCurve: 'continuous',
    boxShadow: '0 5px 14px rgba(0, 0, 0, 0.30)',
    zIndex: 4,
  },
  storyCardImage: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: marketChartTheme.colors.control,
  },
  storyCardFallback: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    backgroundColor: tokens.colors.accent,
  },
  storyCardFallbackText: {
    color: marketChartTheme.colors.canvas,
    fontSize: 13,
    fontWeight: '900',
  },
  storyCardCopy: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  storyCardTitle: {
    color: marketChartTheme.colors.primaryText,
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 13,
  },
  storyCardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  storyCardTime: {
    flex: 1,
    color: marketChartTheme.colors.secondaryText,
    fontSize: 9,
    fontVariant: ['tabular-nums'],
  },
  storyCardCount: {
    color: tokens.colors.accent,
    fontSize: 9,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
});
