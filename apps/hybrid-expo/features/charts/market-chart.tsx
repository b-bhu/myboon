import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AccessibilityActionEvent, LayoutChangeEvent } from 'react-native';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { FadeIn } from 'react-native-reanimated';
import Svg, {
  Circle,
  ClipPath,
  Defs,
  G,
  Line,
  Path,
  Rect,
  Text as SvgText,
} from 'react-native-svg';
import { buildMarketChartAccessibilityValue } from '@/features/charts/market-chart.accessibility';
import {
  createMarketChartAnnotationLayouts,
  findMarketChartAnnotationAtPoint,
  MARKET_CHART_ANNOTATION_DOT_SIZE,
  MARKET_CHART_ANNOTATION_SIZE,
  nextAnnotationInLayout,
  type MarketChartAnnotationLayout,
} from '@/features/charts/market-chart.annotations';
import {
  buildCandlestickPaths,
  buildLinePath,
  buildVolumePaths,
  candleIndexForX,
  createMarketChartGeometry,
  createPriceTicks,
  createTimeTickIndices,
  hasVisibleCandleVolume,
  MARKET_CHART_PRICE_AXIS_WIDTH,
  MARKET_CHART_TIME_AXIS_HEIGHT,
  xForCandleIndex,
  yForPrice,
} from '@/features/charts/market-chart.geometry';
import type {
  IndexViewport,
  MarketChartAnnotation,
  MarketChartProps,
  MarketChartStatus,
} from '@/features/charts/market-chart.types';
import {
  clamp,
  clampViewport,
  createInitialViewport,
  DEFAULT_INITIAL_VISIBLE_CANDLES,
  findCandleIndexByTime,
  isViewportAtLiveEdge,
  panViewport,
  reconcileViewportForCandles,
  toMarketChartViewport,
  zoomViewport,
} from '@/features/charts/market-chart.viewport';
import { marketChartTheme } from '@/features/charts/market-chart.theme';
import { semantic, tokens } from '@/theme';

const DEFAULT_HEIGHT = 320;
const LONG_PRESS_DURATION_MS = 330;
const PAN_DISTANCE = 6;
const CURRENT_PRICE_LABEL_HEIGHT = 20;
const DEFAULT_RIGHT_PADDING_CANDLES = 0;
const DEFAULT_RIGHT_PADDING_PIXELS = marketChartTheme.metrics.liveEdgeGap;
const AXIS_ZOOM_DISTANCE = 160;

type SelectionIdentity = {
  readonly timeMs: number | null;
};

type WebWheelEvent = {
  readonly deltaY: number;
  readonly offsetX?: number;
  readonly preventDefault: () => void;
};

type WebWheelTarget = {
  readonly addEventListener: (
    type: 'wheel',
    listener: (event: WebWheelEvent) => void,
    options: { readonly passive: false },
  ) => void;
  readonly removeEventListener: (
    type: 'wheel',
    listener: (event: WebWheelEvent) => void,
  ) => void;
};

type KeyLikeEvent = {
  readonly nativeEvent?: { readonly key?: string };
  readonly key?: string;
  readonly preventDefault?: () => void;
};

export function MarketChart({
  seriesKey,
  candles,
  mode,
  status = { kind: 'ready' },
  layers,
  height = DEFAULT_HEIGHT,
  minimumVisibleCandles = 14,
  initialVisibleCandles = DEFAULT_INITIAL_VISIBLE_CANDLES,
  rightPaddingCandles = DEFAULT_RIGHT_PADDING_CANDLES,
  rightPaddingPixels = DEFAULT_RIGHT_PADDING_PIXELS,
  formatPrice,
  formatAxisPrice = formatPrice,
  formatTime,
  formatVolume,
  accessibilityLabel,
  onSelectionChange,
  onViewportChange,
  onLoadMoreHistory,
  hasMoreHistory = false,
  isLoadingHistory = false,
  historyLoadThreshold = 30,
  onRetry,
  resetSignal = 0,
  annotations = [],
  selectedAnnotationId = null,
  onAnnotationSelectionChange,
}: MarketChartProps) {
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState<IndexViewport>(() => (
    createInitialViewport(candles.length, initialVisibleCandles, minimumVisibleCandles)
  ));
  const [selectionIdentity, setSelectionIdentity] = useState<SelectionIdentity>({
    timeMs: null,
  });
  const [priceScale, setPriceScale] = useState(1);

  const viewportRef = useRef(viewport);
  const previousCandlesRef = useRef(candles);
  const previousSeriesKeyRef = useRef(seriesKey);
  const previousResetSignalRef = useRef(resetSignal);
  const selectionIdentityRef = useRef(selectionIdentity);
  const chartHostRef = useRef<View | null>(null);
  const panStartViewportRef = useRef(viewport);
  const timeAxisStartViewportRef = useRef(viewport);
  const priceScaleRef = useRef(priceScale);
  const priceScaleStartRef = useRef(priceScale);
  const scheduledViewportRef = useRef<IndexViewport | null>(null);
  const viewportFrameRef = useRef<number | null>(null);
  const pinchStartRef = useRef<{ viewport: IndexViewport; anchorRatio: number }>({
    viewport,
    anchorRatio: 0.5,
  });
  const clipId = `market-chart-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const volumeRequested = layers?.volume ?? true;
  const currentPriceRequested = layers?.currentPrice ?? true;
  const annotationsRequested = layers?.annotations ?? true;
  const hasVisibleVolume = useMemo(() => {
    if (!volumeRequested) return false;
    return hasVisibleCandleVolume(
      candles,
      viewport,
      minimumVisibleCandles,
    );
  }, [candles, minimumVisibleCandles, viewport, volumeRequested]);

  const geometry = useMemo(() => createMarketChartGeometry(
    candles,
    viewport,
    width,
    height,
    hasVisibleVolume,
    {
      priceScale,
      rightPaddingCandles: isViewportAtLiveEdge(viewport, candles.length)
        ? rightPaddingCandles
        : 0,
      rightPaddingPixels: isViewportAtLiveEdge(viewport, candles.length)
        ? rightPaddingPixels
        : 0,
    },
  ), [
    candles,
    hasVisibleVolume,
    height,
    priceScale,
    rightPaddingCandles,
    rightPaddingPixels,
    viewport,
    width,
  ]);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  priceScaleRef.current = priceScale;

  const annotationLayouts = useMemo(() => (
    annotationsRequested
      ? createMarketChartAnnotationLayouts(annotations, candles, geometry)
      : []
  ), [annotations, annotationsRequested, candles, geometry]);
  const visibleAnnotations = useMemo(
    () => annotationLayouts.flatMap((layout) => layout.annotations),
    [annotationLayouts],
  );
  const selectedAnnotation = useMemo(() => (
    visibleAnnotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null
  ), [selectedAnnotationId, visibleAnnotations]);

  useEffect(() => {
    if (selectedAnnotationId !== null && !selectedAnnotation) {
      onAnnotationSelectionChange?.(null);
    }
  }, [onAnnotationSelectionChange, selectedAnnotation, selectedAnnotationId]);

  const selectedCandleIndex = useMemo(() => findCandleIndexByTime(
    candles,
    selectionIdentity.timeMs,
  ), [candles, selectionIdentity.timeMs]);
  const selectedCandle = selectedCandleIndex === null
    ? null
    : candles[selectedCandleIndex] ?? null;

  const commitViewport = useCallback((nextViewport: IndexViewport) => {
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
  }, []);

  const scheduleViewport = useCallback((nextViewport: IndexViewport) => {
    scheduledViewportRef.current = nextViewport;
    if (viewportFrameRef.current !== null) return;
    viewportFrameRef.current = requestAnimationFrame(() => {
      viewportFrameRef.current = null;
      const scheduled = scheduledViewportRef.current;
      scheduledViewportRef.current = null;
      if (scheduled) commitViewport(scheduled);
    });
  }, [commitViewport]);

  const flushScheduledViewport = useCallback(() => {
    if (viewportFrameRef.current !== null) {
      cancelAnimationFrame(viewportFrameRef.current);
      viewportFrameRef.current = null;
    }
    const scheduled = scheduledViewportRef.current;
    scheduledViewportRef.current = null;
    if (scheduled) commitViewport(scheduled);
  }, [commitViewport]);

  useEffect(() => () => {
    if (viewportFrameRef.current !== null) {
      cancelAnimationFrame(viewportFrameRef.current);
    }
  }, []);

  const emitSelection = useCallback((candleIndex: number | null) => {
    const candle = candleIndex === null ? null : candles[candleIndex] ?? null;
    const nextIdentity = {
      timeMs: candle?.timeMs ?? null,
    };
    const previous = selectionIdentityRef.current;
    if (previous.timeMs === nextIdentity.timeMs) {
      return;
    }
    selectionIdentityRef.current = nextIdentity;
    setSelectionIdentity(nextIdentity);
    onSelectionChange?.({
      candle,
      candleIndex: candle ? candleIndex : null,
    });
  }, [candles, onSelectionChange]);

  const clearSelection = useCallback(() => {
    const hadSelection = selectionIdentityRef.current.timeMs !== null;
    selectionIdentityRef.current = { timeMs: null };
    setSelectionIdentity({ timeMs: null });
    if (hadSelection) {
      onSelectionChange?.({ candle: null, candleIndex: null });
    }
  }, [onSelectionChange]);

  const clearAnnotationSelection = useCallback(() => {
    if (selectedAnnotationId !== null) onAnnotationSelectionChange?.(null);
  }, [onAnnotationSelectionChange, selectedAnnotationId]);

  const resetToLatest = useCallback(() => {
    commitViewport(createInitialViewport(
      candles.length,
      initialVisibleCandles,
      minimumVisibleCandles,
    ));
    clearSelection();
    clearAnnotationSelection();
  }, [
    candles.length,
    clearAnnotationSelection,
    clearSelection,
    commitViewport,
    initialVisibleCandles,
    minimumVisibleCandles,
  ]);

  const selectAtX = useCallback((x: number) => {
    const candleIndex = candleIndexForX(geometryRef.current, x, candles.length);
    if (candleIndex !== null) emitSelection(candleIndex);
  }, [candles.length, emitSelection]);

  const handleSingleTap = useCallback((x: number, y: number) => {
    const layout = findMarketChartAnnotationAtPoint(annotationLayouts, x, y);
    if (layout) {
      clearSelection();
      onAnnotationSelectionChange?.(
        nextAnnotationInLayout(layout, selectedAnnotationId),
      );
      return;
    }
    clearAnnotationSelection();
    clearSelection();
  }, [
    annotationLayouts,
    clearAnnotationSelection,
    clearSelection,
    onAnnotationSelectionChange,
    selectedAnnotationId,
  ]);

  const selectRelativeCandle = useCallback((direction: -1 | 1) => {
    if (candles.length === 0) return;
    clearAnnotationSelection();
    const currentIndex = findCandleIndexByTime(
      candles,
      selectionIdentityRef.current.timeMs,
    );
    const initialIndex = currentIndex ?? Math.max(
      0,
      Math.min(candles.length - 1, Math.ceil(viewportRef.current.end) - 1),
    );
    const nextIndex = clamp(initialIndex + direction, 0, candles.length - 1);
    emitSelection(nextIndex);

    const currentViewport = viewportRef.current;
    const span = currentViewport.end - currentViewport.start;
    if (nextIndex < currentViewport.start + 1) {
      commitViewport(clampViewport({
        start: Math.max(0, nextIndex - 1),
        end: nextIndex - 1 + span,
      }, candles.length, minimumVisibleCandles));
    } else if (nextIndex > currentViewport.end - 2) {
      const end = Math.min(candles.length, nextIndex + 2);
      commitViewport(clampViewport(
        { start: end - span, end },
        candles.length,
        minimumVisibleCandles,
      ));
    }
  }, [
    candles,
    clearAnnotationSelection,
    commitViewport,
    emitSelection,
    minimumVisibleCandles,
  ]);

  useLayoutEffect(() => {
    const previousCandles = previousCandlesRef.current;
    const seriesChanged = previousSeriesKeyRef.current !== seriesKey;
    if (seriesChanged) {
      previousSeriesKeyRef.current = seriesKey;
      previousCandlesRef.current = candles;
      commitViewport(createInitialViewport(
        candles.length,
        initialVisibleCandles,
        minimumVisibleCandles,
      ));
      setPriceScale(1);
      clearSelection();
      onAnnotationSelectionChange?.(null);
      return;
    }
    if (previousCandles === candles) return;

    const nextViewport = reconcileViewportForCandles(
      viewportRef.current,
      previousCandles,
      candles,
      {
        followLatest: isViewportAtLiveEdge(viewportRef.current, previousCandles.length),
        initialVisibleCandles,
        minimumVisibleCandles,
      },
    );
    previousCandlesRef.current = candles;
    commitViewport(nextViewport);

    const selectedTime = selectionIdentityRef.current.timeMs;
    if (selectedTime !== null) {
      const nextIndex = findCandleIndexByTime(candles, selectedTime);
      if (nextIndex === null) {
        clearSelection();
      } else {
        onSelectionChange?.({ candle: candles[nextIndex], candleIndex: nextIndex });
      }
    }
  }, [
    candles,
    clearSelection,
    commitViewport,
    initialVisibleCandles,
    minimumVisibleCandles,
    onSelectionChange,
    onAnnotationSelectionChange,
    seriesKey,
  ]);

  useEffect(() => {
    if (previousResetSignalRef.current === resetSignal) return;
    previousResetSignalRef.current = resetSignal;
    resetToLatest();
  }, [resetSignal, resetToLatest]);

  const publicViewport = useMemo(
    () => toMarketChartViewport(viewport, candles),
    [candles, viewport],
  );
  useEffect(() => {
    onViewportChange?.(publicViewport);
  }, [onViewportChange, publicViewport]);

  useEffect(() => {
    if (
      status.kind !== 'ready'
      || !hasMoreHistory
      || isLoadingHistory
      || publicViewport.visibleStartIndex > historyLoadThreshold
    ) {
      return;
    }
    onLoadMoreHistory?.();
  }, [
    hasMoreHistory,
    historyLoadThreshold,
    isLoadingHistory,
    onLoadMoreHistory,
    publicViewport.visibleStartIndex,
    status.kind,
  ]);

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .maxPointers(1)
      .activeOffsetX([-PAN_DISTANCE, PAN_DISTANCE])
      .failOffsetY([-16, 16])
      .runOnJS(true)
      .onBegin(() => {
        clearAnnotationSelection();
        panStartViewportRef.current = viewportRef.current;
      })
      .onUpdate((event) => {
        scheduleViewport(panViewport(
          panStartViewportRef.current,
          event.translationX,
          geometryRef.current.plotWidth,
          candles.length,
          minimumVisibleCandles,
        ));
      })
      .onFinalize(flushScheduledViewport);

    const inspect = Gesture.Pan()
      .maxPointers(1)
      .activateAfterLongPress(LONG_PRESS_DURATION_MS)
      .shouldCancelWhenOutside(false)
      .runOnJS(true)
      .onStart((event) => {
        clearAnnotationSelection();
        selectAtX(event.x);
      })
      .onUpdate((event) => {
        selectAtX(event.x);
      });

    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onStart((event) => {
        const activeGeometry = geometryRef.current;
        pinchStartRef.current = {
          viewport: viewportRef.current,
          anchorRatio: clamp(
            (event.focalX - activeGeometry.plotLeft) / activeGeometry.plotWidth,
            0,
            1,
          ),
        };
      })
      .onUpdate((event) => {
        scheduleViewport(zoomViewport(
          pinchStartRef.current.viewport,
          event.scale,
          pinchStartRef.current.anchorRatio,
          candles.length,
          minimumVisibleCandles,
        ));
      })
      .onFinalize(flushScheduledViewport);

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .maxDistance(PAN_DISTANCE)
      .runOnJS(true)
      .onEnd((_event, success) => {
        if (success) resetToLatest();
      });

    const singleTap = Gesture.Tap()
      .numberOfTaps(1)
      .maxDistance(PAN_DISTANCE)
      .runOnJS(true)
      .onEnd((event, success) => {
        if (success) handleSingleTap(event.x, event.y);
      });

    return Gesture.Race(
      pinch,
      inspect,
      pan,
      Gesture.Exclusive(doubleTap, singleTap),
    );
  }, [
    candles.length,
    clearAnnotationSelection,
    flushScheduledViewport,
    handleSingleTap,
    minimumVisibleCandles,
    resetToLatest,
    scheduleViewport,
    selectAtX,
  ]);

  const priceAxisGesture = useMemo(() => {
    const zoom = Gesture.Pan()
      .maxPointers(1)
      .activeOffsetY([-PAN_DISTANCE, PAN_DISTANCE])
      .runOnJS(true)
      .onBegin(() => {
        priceScaleStartRef.current = priceScaleRef.current;
      })
      .onUpdate((event) => {
        const nextScale = clamp(
          priceScaleStartRef.current * Math.exp(-event.translationY / AXIS_ZOOM_DISTANCE),
          0.25,
          8,
        );
        priceScaleRef.current = nextScale;
        setPriceScale(nextScale);
      });

    const reset = Gesture.Tap()
      .numberOfTaps(2)
      .maxDistance(PAN_DISTANCE)
      .runOnJS(true)
      .onEnd((_event, success) => {
        if (!success) return;
        priceScaleRef.current = 1;
        setPriceScale(1);
      });

    return Gesture.Exclusive(reset, zoom);
  }, []);

  const timeAxisGesture = useMemo(() => {
    const zoom = Gesture.Pan()
      .maxPointers(1)
      .activeOffsetX([-PAN_DISTANCE, PAN_DISTANCE])
      .runOnJS(true)
      .onBegin(() => {
        timeAxisStartViewportRef.current = viewportRef.current;
      })
      .onUpdate((event) => {
        scheduleViewport(zoomViewport(
          timeAxisStartViewportRef.current,
          Math.exp(event.translationX / AXIS_ZOOM_DISTANCE),
          0.5,
          candles.length,
          minimumVisibleCandles,
        ));
      })
      .onFinalize(flushScheduledViewport);

    const reset = Gesture.Tap()
      .numberOfTaps(2)
      .maxDistance(PAN_DISTANCE)
      .runOnJS(true)
      .onEnd((_event, success) => {
        if (success) resetToLatest();
      });

    return Gesture.Exclusive(reset, zoom);
  }, [
    candles.length,
    flushScheduledViewport,
    minimumVisibleCandles,
    resetToLatest,
    scheduleViewport,
  ]);

  const handleWheel = useCallback((event: WebWheelEvent) => {
    const deltaY = event.deltaY;
    if (!deltaY) return;
    event.preventDefault();
    const activeGeometry = geometryRef.current;
    const x = event.offsetX ?? activeGeometry.plotRight;
    const anchorRatio = clamp(
      (x - activeGeometry.plotLeft) / activeGeometry.plotWidth,
      0,
      1,
    );
    commitViewport(zoomViewport(
      viewportRef.current,
      deltaY > 0 ? 0.88 : 1.12,
      anchorRatio,
      candles.length,
      minimumVisibleCandles,
    ));
  }, [candles.length, commitViewport, minimumVisibleCandles]);

  useEffect(() => {
    if (process.env.EXPO_OS !== 'web' || status.kind !== 'ready' || candles.length === 0) {
      return undefined;
    }
    const target = chartHostRef.current as unknown as WebWheelTarget | null;
    if (!target?.addEventListener) return undefined;

    target.addEventListener('wheel', handleWheel, { passive: false });
    return () => target.removeEventListener('wheel', handleWheel);
  }, [candles.length, handleWheel, status.kind]);

  const activateSelection = useCallback(() => {
    if (visibleAnnotations.length > 0) {
      const currentIndex = visibleAnnotations.findIndex(
        (annotation) => annotation.id === selectedAnnotationId,
      );
      const nextIndex = currentIndex < 0 || currentIndex >= visibleAnnotations.length - 1
        ? 0
        : currentIndex + 1;
      clearSelection();
      onAnnotationSelectionChange?.(visibleAnnotations[nextIndex]);
      return;
    }
    if (selectedCandleIndex === null && candles.length > 0) {
      emitSelection(candles.length - 1);
    }
  }, [
    candles.length,
    clearSelection,
    emitSelection,
    onAnnotationSelectionChange,
    selectedAnnotationId,
    selectedCandleIndex,
    visibleAnnotations,
  ]);

  const handleKeyDown = useCallback((event: KeyLikeEvent) => {
    const key = event.nativeEvent?.key ?? event.key;
    if (
      key === 'ArrowLeft'
      || key === 'ArrowRight'
      || key === 'End'
      || key === 'Enter'
      || key === ' '
    ) {
      event.preventDefault?.();
    }
    if (key === 'ArrowLeft') selectRelativeCandle(-1);
    else if (key === 'ArrowRight') selectRelativeCandle(1);
    else if (key === 'Escape') {
      clearAnnotationSelection();
      clearSelection();
    }
    else if (key === 'End') resetToLatest();
    else if (key === 'Enter' || key === ' ') activateSelection();
  }, [
    activateSelection,
    clearAnnotationSelection,
    clearSelection,
    resetToLatest,
    selectRelativeCandle,
  ]);

  const handleAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
    const action = event.nativeEvent.actionName;
    if (action === 'decrement') selectRelativeCandle(-1);
    else if (action === 'increment') selectRelativeCandle(1);
    else if (action === 'escape') {
      clearAnnotationSelection();
      clearSelection();
    }
    else if (action === 'activate') activateSelection();
  }, [
    activateSelection,
    clearAnnotationSelection,
    clearSelection,
    selectRelativeCandle,
  ]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.max(1, Math.round(event.nativeEvent.layout.width));
    setWidth((current) => current === nextWidth ? current : nextWidth);
  }, []);

  const webInteractionProps = process.env.EXPO_OS === 'web'
    ? { onKeyDown: handleKeyDown, tabIndex: 0 as const }
    : {};

  const effectiveStatus: MarketChartStatus = status.kind === 'ready' && candles.length === 0
    ? { kind: 'empty', title: 'No candle history' }
    : status;

  if (effectiveStatus.kind !== 'ready') {
    return (
      <MarketChartState
        height={height}
        status={effectiveStatus}
        onRetry={onRetry}
        onLayout={handleLayout}
      />
    );
  }

  const candlestickPaths = mode === 'candles'
    ? buildCandlestickPaths(candles, geometry)
    : { positive: '', negative: '' };
  const linePath = mode === 'line' ? buildLinePath(candles, geometry) : '';
  const volumePaths = hasVisibleVolume
    ? buildVolumePaths(candles, geometry)
    : { positive: '', negative: '' };
  const priceTicks = createPriceTicks(geometry);
  const timeTickIndices = createTimeTickIndices(geometry, candles.length, 3);
  const latestCandle = candles.at(-1) ?? null;
  const latestIsPositive = latestCandle ? latestCandle.close >= latestCandle.open : true;
  const latestColor = latestIsPositive
    ? marketChartTheme.colors.bullish
    : marketChartTheme.colors.bearish;
  const latestCandleIndex = Math.max(0, candles.length - 1);
  const latestX = latestCandle
    ? xForCandleIndex(geometry, latestCandleIndex)
    : null;
  const selectedX = selectedCandleIndex === null
    ? null
    : xForCandleIndex(geometry, selectedCandleIndex);
  const selectedY = selectedCandle
    ? yForPrice(geometry, selectedCandle.close)
    : null;
  const accessibilityValue = buildMarketChartAccessibilityValue(
    selectedCandle ?? latestCandle,
    formatPrice,
    formatTime,
    formatVolume,
  );
  const chartAccessibilityValue = selectedAnnotation?.accessibilityLabel
    ?? accessibilityValue;
  const annotationCountLabel = visibleAnnotations.length > 0
    ? `, ${visibleAnnotations.length} annotations`
    : '';

  return (
    <GestureDetector gesture={gesture}>
      <View
        ref={chartHostRef}
        {...webInteractionProps}
        style={[styles.chart, { height }]}
        onLayout={handleLayout}
        accessible
        focusable
        accessibilityRole="adjustable"
        accessibilityLabel={`${accessibilityLabel}, ${mode} mode, ${candles.length} candles${annotationCountLabel}`}
        accessibilityHint={visibleAnnotations.length > 0
          ? 'Long press to inspect candles. Pinch to zoom, drag to browse history, or activate to move through annotations.'
          : 'Long press to inspect candles. Pinch to zoom and drag horizontally to browse history.'}
        accessibilityValue={chartAccessibilityValue ? { text: chartAccessibilityValue } : undefined}
        accessibilityActions={[
          { name: 'increment', label: 'Next candle' },
          { name: 'decrement', label: 'Previous candle' },
          {
            name: 'activate',
            label: visibleAnnotations.length > 0 ? 'Next annotation' : 'Activate selection',
          },
          { name: 'escape', label: 'Clear selection' },
        ]}
        onAccessibilityAction={handleAccessibilityAction}
      >
        {width > 0 ? (
          <Svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Defs>
              <ClipPath id={`${clipId}-plot`}>
                <Rect
                  x={geometry.plotLeft}
                  y={geometry.plotTop}
                  width={geometry.plotWidth}
                  height={geometry.volumeBottom - geometry.plotTop}
                />
              </ClipPath>
            </Defs>

            <Rect
              x={geometry.plotRight}
              y={geometry.plotTop}
              width={Math.max(0, width - geometry.plotRight)}
              height={geometry.volumeBottom - geometry.plotTop}
              fill={marketChartTheme.colors.toolbar}
              opacity={0.46}
            />

            <G clipPath={`url(#${clipId}-plot)`}>
              {priceTicks.map((tick) => (
                <Line
                  key={`price-grid-${tick.y}`}
                  x1={geometry.plotLeft}
                  x2={geometry.plotRight}
                  y1={tick.y}
                  y2={tick.y}
                  stroke={marketChartTheme.colors.grid}
                  strokeOpacity={0.13}
                  strokeWidth={1}
                />
              ))}
              {timeTickIndices.map((index) => {
                const x = xForCandleIndex(geometry, index);
                return (
                  <Line
                    key={`time-grid-${candles[index].timeMs}`}
                    x1={x}
                    x2={x}
                    y1={geometry.plotTop}
                    y2={geometry.volumeBottom}
                    stroke={marketChartTheme.colors.grid}
                    strokeOpacity={0.08}
                    strokeWidth={1}
                  />
                );
              })}

              {hasVisibleVolume ? (
                <>
                  <Path d={volumePaths.positive} fill={marketChartTheme.colors.bullish} opacity={0.38} />
                  <Path d={volumePaths.negative} fill={marketChartTheme.colors.bearish} opacity={0.38} />
                </>
              ) : null}

              {mode === 'candles' ? (
                <>
                  <Path
                    d={candlestickPaths.positive}
                    fill={marketChartTheme.colors.bullish}
                    stroke={marketChartTheme.colors.bullish}
                    strokeWidth={1}
                  />
                  <Path
                    d={candlestickPaths.negative}
                    fill={marketChartTheme.colors.bearish}
                    stroke={marketChartTheme.colors.bearish}
                    strokeWidth={1}
                  />
                </>
              ) : (
                <>
                  <Path
                    d={linePath}
                    fill="none"
                    stroke={latestColor}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {latestCandle && latestX !== null
                    && latestX >= geometry.plotLeft && latestX <= geometry.plotRight ? (
                    <Circle
                      cx={latestX}
                      cy={yForPrice(geometry, latestCandle.close)}
                      r={3}
                      fill={latestColor}
                      stroke={marketChartTheme.colors.canvas}
                      strokeWidth={1.5}
                    />
                  ) : null}
                </>
              )}

              {currentPriceRequested && latestCandle ? (
                <Line
                  x1={geometry.plotLeft}
                  x2={geometry.plotRight}
                  y1={yForPrice(geometry, latestCandle.close)}
                  y2={yForPrice(geometry, latestCandle.close)}
                  stroke={latestColor}
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
              ) : null}

              {selectedCandle && selectedX !== null && selectedY !== null ? (
                <>
                  <Line
                    x1={selectedX}
                    x2={selectedX}
                    y1={geometry.plotTop}
                    y2={geometry.volumeBottom}
                    stroke={marketChartTheme.colors.selection}
                    strokeOpacity={0.7}
                    strokeWidth={1}
                    strokeDasharray="4 4"
                  />
                  <Line
                    x1={geometry.plotLeft}
                    x2={geometry.plotRight}
                    y1={selectedY}
                    y2={selectedY}
                    stroke={marketChartTheme.colors.selection}
                    strokeOpacity={0.7}
                    strokeWidth={1}
                    strokeDasharray="4 4"
                  />
                  <Circle
                    cx={selectedX}
                    cy={selectedY}
                    r={3}
                    fill={marketChartTheme.colors.primaryText}
                    stroke={latestColor}
                    strokeWidth={2}
                  />
                </>
              ) : null}
            </G>

            <Line
              x1={geometry.plotRight + 0.5}
              x2={geometry.plotRight + 0.5}
              y1={geometry.plotTop}
              y2={geometry.volumeBottom}
              stroke={marketChartTheme.colors.divider}
              strokeWidth={1}
            />
            <Line
              x1={geometry.plotLeft}
              x2={geometry.plotRight}
              y1={geometry.volumeBottom + 0.5}
              y2={geometry.volumeBottom + 0.5}
              stroke={marketChartTheme.colors.divider}
              strokeWidth={1}
            />

            {priceTicks.map((tick) => (
              <SvgText
                key={`price-label-${tick.y}`}
                x={width - 4}
                y={tick.y + 3}
                fill={marketChartTheme.colors.axisText}
                fontSize={10}
                textAnchor="end"
              >
                {formatAxisPrice(tick.value)}
              </SvgText>
            ))}
            {timeTickIndices.map((index, tickIndex) => (
              <SvgText
                key={`time-label-${candles[index].timeMs}`}
                x={xForCandleIndex(geometry, index)}
                y={geometry.timeAxisY}
                fill={marketChartTheme.colors.axisText}
                fontSize={10}
                textAnchor={tickIndex === 0 ? 'start' : tickIndex === timeTickIndices.length - 1 ? 'end' : 'middle'}
              >
                {formatTime(candles[index].timeMs)}
              </SvgText>
            ))}

            {currentPriceRequested && latestCandle ? (
              <G>
                <Rect
                  x={geometry.plotRight + 4}
                  y={clamp(
                    yForPrice(geometry, latestCandle.close) - CURRENT_PRICE_LABEL_HEIGHT / 2,
                    geometry.plotTop,
                    geometry.priceBottom - CURRENT_PRICE_LABEL_HEIGHT,
                  )}
                  width={Math.max(1, width - geometry.plotRight - 4)}
                  height={CURRENT_PRICE_LABEL_HEIGHT}
                  rx={5}
                  fill={latestColor}
                />
                <SvgText
                  x={width - 4}
                  y={clamp(
                    yForPrice(geometry, latestCandle.close) + 3,
                    geometry.plotTop + 12,
                    geometry.priceBottom - 3,
                  )}
                  fill={marketChartTheme.colors.canvas}
                  fontSize={10}
                  fontWeight="700"
                  textAnchor="end"
                >
                  {formatAxisPrice(latestCandle.close)}
                </SvgText>
              </G>
            ) : null}
          </Svg>
        ) : null}

        <ChartAnnotationOverlay
          layouts={annotationLayouts}
          selectedAnnotationId={selectedAnnotationId}
        />

        {selectedCandle ? (
          <View
            pointerEvents="none"
            style={[
              styles.inspectionReadout,
              { right: MARKET_CHART_PRICE_AXIS_WIDTH + 8 },
            ]}
          >
            <Text style={styles.inspectionTime} numberOfLines={1}>
              {formatTime(selectedCandle.timeMs)}
            </Text>
            <Text
              style={styles.inspectionValues}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.78}
            >
              {`O ${formatAxisPrice(selectedCandle.open)}  H ${formatAxisPrice(selectedCandle.high)}  L ${formatAxisPrice(selectedCandle.low)}  C ${formatAxisPrice(selectedCandle.close)}`}
            </Text>
          </View>
        ) : null}

        <GestureDetector gesture={priceAxisGesture}>
          <View
            collapsable={false}
            style={styles.priceAxisGestureTarget}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Price scale"
            accessibilityHint="Drag vertically to zoom the price scale. Double tap to reset."
          />
        </GestureDetector>

        <GestureDetector gesture={timeAxisGesture}>
          <View
            collapsable={false}
            style={styles.timeAxisGestureTarget}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Time scale"
            accessibilityHint="Drag horizontally to change candle spacing. Double tap to reset."
          />
        </GestureDetector>
      </View>
    </GestureDetector>
  );
}

function ChartAnnotationOverlay({
  layouts,
  selectedAnnotationId,
}: {
  readonly layouts: readonly MarketChartAnnotationLayout[];
  readonly selectedAnnotationId: string | null;
}) {
  if (layouts.length === 0) return null;

  return (
    <View
      pointerEvents="none"
      style={styles.annotationLayer}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {layouts.map((layout) => {
        const selectedAnnotation = layout.annotations.find(
          (annotation) => annotation.id === selectedAnnotationId,
        );
        const annotation = selectedAnnotation ?? layout.annotations[0];
        const selected = selectedAnnotation !== undefined;
        const tone = annotationToneColor(annotation);
        const clustered = layout.annotations.length > 1;
        const markerSize = selected
          ? MARKET_CHART_ANNOTATION_SIZE
          : MARKET_CHART_ANNOTATION_DOT_SIZE;
        const clusterOffset = clustered && !selected ? 2.5 : 0;
        return (
          <View key={layout.id} style={StyleSheet.absoluteFill}>
            {clustered && !selected ? (
              <View
                style={[
                  styles.annotationClusterEcho,
                  {
                    left: layout.x - clusterOffset,
                    top: layout.y,
                    backgroundColor: tone,
                  },
                ]}
              />
            ) : null}
            <Animated.View
              entering={FadeIn.duration(160)}
              style={[
                styles.annotationMarker,
                {
                  left: layout.x + clusterOffset,
                  top: layout.y,
                  width: markerSize,
                  height: markerSize,
                  borderRadius: markerSize / 2,
                  borderWidth: selected ? 2 : 0,
                  borderColor: marketChartTheme.colors.primaryText,
                  backgroundColor: selected ? marketChartTheme.colors.canvas : tone,
                  opacity: selected ? 1 : 0.72,
                  boxShadow: selected ? '0 3px 8px rgba(0, 0, 0, 0.28)' : 'none',
                  transform: [
                    { translateX: -markerSize / 2 },
                    { translateY: -markerSize / 2 },
                  ],
                },
              ]}
            >
              {selected && annotation.imageUrl ? (
                <Image
                  source={annotation.imageUrl}
                  style={[styles.annotationImage, { borderRadius: markerSize / 2 }]}
                  contentFit="cover"
                  transition={120}
                />
              ) : selected ? (
                <View style={[styles.annotationFallback, { backgroundColor: tone }]}>
                  <Text style={styles.annotationFallbackText}>
                    {(annotation.fallbackText || '•').slice(0, 2)}
                  </Text>
                </View>
              ) : null}
            </Animated.View>
          </View>
        );
      })}
    </View>
  );
}

function annotationToneColor(annotation: MarketChartAnnotation): string {
  if (annotation.tone === 'positive') return marketChartTheme.colors.bullish;
  if (annotation.tone === 'negative') return marketChartTheme.colors.bearish;
  if (annotation.tone === 'neutral') return marketChartTheme.colors.selection;
  return tokens.colors.accent;
}

function MarketChartState({
  height,
  status,
  onRetry,
  onLayout,
}: {
  readonly height: number;
  readonly status: Exclude<MarketChartStatus, { kind: 'ready' }>;
  readonly onRetry?: () => void;
  readonly onLayout: (event: LayoutChangeEvent) => void;
}) {
  if (status.kind === 'loading') {
    return (
      <View
        style={[styles.state, { height }]}
        onLayout={onLayout}
        accessibilityRole="progressbar"
        accessibilityLabel={status.accessibilityLabel ?? 'Loading chart data'}
        accessibilityLiveRegion="polite"
      >
        <View style={styles.skeleton} accessibilityElementsHidden>
          {Array.from({ length: 5 }, (_, index) => (
            <View key={index} style={styles.skeletonLine} />
          ))}
        </View>
        <ActivityIndicator size="small" color={semantic.text.accent} />
      </View>
    );
  }

  return (
    <View
      style={[styles.state, { height }]}
      onLayout={onLayout}
      accessibilityRole={status.kind === 'error' ? 'alert' : 'summary'}
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.stateTitle} selectable>{status.title}</Text>
      {status.description ? (
        <Text style={styles.stateDescription} selectable>{status.description}</Text>
      ) : null}
      {status.kind === 'error' && onRetry ? (
        <Pressable
          style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
          accessibilityRole="button"
          onPress={onRetry}
        >
          <Text style={styles.retryText}>{status.retryLabel ?? 'Retry'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chart: {
    width: '100%',
    overflow: 'hidden',
    backgroundColor: marketChartTheme.colors.canvas,
  },
  annotationLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 2,
  },
  annotationMarker: {
    position: 'absolute',
  },
  annotationClusterEcho: {
    position: 'absolute',
    width: MARKET_CHART_ANNOTATION_DOT_SIZE,
    height: MARKET_CHART_ANNOTATION_DOT_SIZE,
    borderRadius: MARKET_CHART_ANNOTATION_DOT_SIZE / 2,
    opacity: 0.36,
    transform: [
      { translateX: -MARKET_CHART_ANNOTATION_DOT_SIZE / 2 },
      { translateY: -MARKET_CHART_ANNOTATION_DOT_SIZE / 2 },
    ],
  },
  annotationImage: {
    width: '100%',
    height: '100%',
    backgroundColor: marketChartTheme.colors.control,
  },
  annotationFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: MARKET_CHART_ANNOTATION_SIZE / 2,
  },
  annotationFallbackText: {
    color: marketChartTheme.colors.canvas,
    fontSize: 10,
    fontWeight: '900',
  },
  inspectionReadout: {
    position: 'absolute',
    top: 8,
    left: 12,
    minHeight: 36,
    justifyContent: 'center',
    gap: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: marketChartTheme.colors.border,
    borderRadius: 6,
    backgroundColor: 'rgba(5, 47, 59, 0.92)',
    borderCurve: 'continuous',
  },
  inspectionTime: {
    color: marketChartTheme.colors.secondaryText,
    fontSize: 9,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  inspectionValues: {
    color: marketChartTheme.colors.primaryText,
    fontSize: 10,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  priceAxisGestureTarget: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: MARKET_CHART_TIME_AXIS_HEIGHT,
    width: MARKET_CHART_PRICE_AXIS_WIDTH,
  },
  timeAxisGestureTarget: {
    position: 'absolute',
    left: 0,
    right: MARKET_CHART_PRICE_AXIS_WIDTH,
    bottom: 0,
    height: MARKET_CHART_TIME_AXIS_HEIGHT,
  },
  state: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.xl,
    overflow: 'hidden',
    backgroundColor: marketChartTheme.colors.canvas,
  },
  skeleton: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-evenly',
    paddingHorizontal: tokens.spacing.md,
    opacity: 0.42,
  },
  skeletonLine: {
    height: 1,
    backgroundColor: semantic.border.muted,
  },
  stateTitle: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    textAlign: 'center',
  },
  stateDescription: {
    maxWidth: 280,
    color: semantic.text.dim,
    fontSize: tokens.fontSize.sm,
    lineHeight: tokens.lineHeight.body,
    textAlign: 'center',
  },
  retryButton: {
    minWidth: 112,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: tokens.spacing.xs,
    borderWidth: 1,
    borderColor: semantic.text.accent,
    borderRadius: tokens.radius.md,
    backgroundColor: semantic.background.surface,
    borderCurve: 'continuous',
  },
  retryButtonPressed: {
    opacity: 0.76,
  },
  retryText: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
  },
});
