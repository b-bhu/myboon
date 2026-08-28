import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Image } from 'expo-image';
import {
  type AccessibilityActionEvent,
  ActivityIndicator,
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Line, Path, Stop } from 'react-native-svg';
import {
  fetchPhoenixCandles,
  formatPhoenixPrice,
  type PhoenixCandle,
  type PhoenixCandleInterval,
} from '@/features/perps/phoenix.api';
import {
  mapPhoenixChartEvents,
  type PhoenixChartEventMarker,
} from '@/features/perps/phoenix.chart-events';
import { BTC_DEMO_EVENTS, isBitcoinPerpSymbol } from '@/features/perps/btc-demo-events';
import { semantic, tokens } from '@/theme';

const TIMEFRAMES: { label: string; interval: PhoenixCandleInterval; count: number }[] = [
  { label: '1H', interval: '1m', count: 60 },
  { label: '1D', interval: '15m', count: 96 },
  { label: '1W', interval: '1h', count: 168 },
  { label: '1M', interval: '4h', count: 180 },
];

const ChartDefs = Defs as unknown as ComponentType<{ children?: ReactNode }>;

interface PhoenixPriceChartProps {
  symbol: string;
  showBitcoinDemo?: boolean;
  height?: number;
  onScrub?: (price: number | null, time: number | null) => void;
  onLatestPrice?: (price: number | null) => void;
}

export function PhoenixPriceChart({
  symbol,
  showBitcoinDemo,
  height = 150,
  onScrub,
  onLatestPrice,
}: PhoenixPriceChartProps) {
  const [tfIndex, setTfIndex] = useState(1);
  const [candles, setCandles] = useState<PhoenixCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);

  const tf = TIMEFRAMES[tfIndex];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMessage(null);

    fetchPhoenixCandles(symbol, tf.interval, tf.count)
      .then((data) => {
        if (cancelled) return;
        setCandles(data);
        onLatestPrice?.(data.at(-1)?.close ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setCandles([]);
        onLatestPrice?.(null);
        setErrorMessage(err instanceof Error ? err.message : 'Phoenix candles unavailable');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [symbol, tf.interval, tf.count, onLatestPrice]);

  const isUp = candles.length >= 2 ? candles[candles.length - 1].close >= candles[0].open : true;
  const lineColor = isUp ? tokens.colors.viridian : tokens.colors.vermillion;
  const scrubCandle = scrubIndex !== null ? candles[scrubIndex] : null;
  const shouldShowBitcoinDemo = showBitcoinDemo ?? isBitcoinPerpSymbol(symbol);
  const eventMarkers = useMemo(() => mapPhoenixChartEvents(
    candles,
    shouldShowBitcoinDemo ? BTC_DEMO_EVENTS : [],
  ), [candles, shouldShowBitcoinDemo]);

  const handleScrub = useCallback((index: number | null) => {
    setScrubIndex(index);
    if (index !== null && candles[index]) {
      onScrub?.(candles[index].close, candles[index].time);
      return;
    }
    onScrub?.(null, null);
  }, [candles, onScrub]);

  return (
    <View style={styles.container}>
      {scrubCandle && (
        <View style={styles.scrubOverlay}>
          <Text style={[styles.scrubPrice, { color: lineColor }]}>
            {formatPhoenixPrice(scrubCandle.close)}
          </Text>
          <Text style={styles.scrubTime}>{formatScrubTime(scrubCandle.time, tf.interval)}</Text>
        </View>
      )}

      <View style={[styles.chartArea, { height }]}>
        {loading ? (
          <ActivityIndicator size="small" color={semantic.text.accent} />
        ) : errorMessage ? (
          <View style={styles.noDataWrap}>
            <Text style={styles.noData}>Candles unavailable</Text>
            <Text style={styles.noDataDetail} numberOfLines={2}>{errorMessage}</Text>
          </View>
        ) : candles.length < 2 ? (
          <Text style={styles.noData}>No candle data</Text>
        ) : (
          <InteractiveChart
            candles={candles}
            height={height}
            color={lineColor}
            eventMarkers={eventMarkers}
            scrubIndex={scrubIndex}
            onScrub={handleScrub}
          />
        )}
      </View>

      <View style={styles.tfRow}>
        {TIMEFRAMES.map((timeframe, index) => (
          <Pressable
            key={timeframe.label}
            style={[
              styles.tfPill,
              index === tfIndex && {
                backgroundColor: isUp ? 'rgba(6,214,160,0.12)' : 'rgba(239,71,111,0.12)',
              },
            ]}
            onPress={() => {
              setTfIndex(index);
              setScrubIndex(null);
              onScrub?.(null, null);
            }}>
            <Text style={[styles.tfText, index === tfIndex && { color: lineColor }]}>
              {timeframe.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function formatScrubTime(ms: number, interval: PhoenixCandleInterval): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (interval === '1s' || interval === '5s' || interval === '1m' || interval === '5m' || interval === '15m' || interval === '30m') {
    return time;
  }
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return interval === '1d' ? day : `${day}, ${time}`;
}

interface InteractiveChartProps {
  candles: PhoenixCandle[];
  height: number;
  color: string;
  eventMarkers: PhoenixChartEventMarker[];
  scrubIndex: number | null;
  onScrub: (index: number | null) => void;
}

const CHART_PAD_TOP = 8;
const CHART_PAD_BOTTOM = 8;
const EVENT_MARKER_OFFSET = 24;
const EVENT_MARKER_SIZE = 26;
const EVENT_HIT_RADIUS = 32;
const EVENT_BUBBLE_SIDE_GUTTER = 8;
const EVENT_BUBBLE_MAX_WIDTH = 248;
const EVENT_BUBBLE_HEIGHT = 68;
const EVENT_DRAG_THRESHOLD = 6;

interface RenderedEventMarker extends PhoenixChartEventMarker {
  xPercent: number;
  pointY: number;
  markerY: number;
}

function InteractiveChart({
  candles,
  height,
  color,
  eventMarkers,
  scrubIndex,
  onScrub,
}: InteractiveChartProps) {
  const layoutWidth = useRef(0);
  const layoutXRef = useRef(0);
  const layoutYRef = useRef(0);
  const gestureMarkerRef = useRef<string | null>(null);
  const gestureMovedRef = useRef(false);
  const [chartWidth, setChartWidth] = useState(0);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [selectedEventIndex, setSelectedEventIndex] = useState(0);

  const closes = useMemo(() => candles.map((candle) => candle.close), [candles]);
  const min = useMemo(() => Math.min(...closes), [closes]);
  const max = useMemo(() => Math.max(...closes), [closes]);
  const range = max - min || 1;
  const drawHeight = height - CHART_PAD_TOP - CHART_PAD_BOTTOM;

  const points = useMemo(() =>
    closes.map((value, index) => ({
      x: (index / (closes.length - 1)) * 100,
      y: CHART_PAD_TOP + drawHeight - ((value - min) / range) * drawHeight,
    })),
    [closes, min, range, drawHeight],
  );

  const linePath = useMemo(() =>
    points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(1)}`).join(' '),
    [points],
  );

  const fillPath = `${linePath} L100,${height} L0,${height} Z`;
  const lastPoint = points[points.length - 1];
  const scrubPoint = scrubIndex !== null ? points[scrubIndex] : null;
  const renderedEventMarkers = useMemo<RenderedEventMarker[]>(() => eventMarkers.flatMap((marker) => {
    const point = points[marker.candleIndex];
    if (!point) return [];
    const markerY = Math.max(EVENT_MARKER_SIZE / 2, point.y - EVENT_MARKER_OFFSET);
    return [{
      ...marker,
      xPercent: marker.chartPosition === null ? point.x : marker.chartPosition * 100,
      pointY: point.y,
      markerY,
    }];
  }), [eventMarkers, points]);
  const selectedMarker = renderedEventMarkers.find((marker) => marker.id === selectedMarkerId) ?? null;
  const selectedEvent = selectedMarker?.events[selectedEventIndex] ?? selectedMarker?.events[0] ?? null;
  const accessibleEvents = useMemo(() => renderedEventMarkers.flatMap((marker) => (
    marker.events.map((_event, eventIndex) => ({ marker, eventIndex }))
  )), [renderedEventMarkers]);

  useEffect(() => {
    if (selectedMarkerId && !renderedEventMarkers.some((marker) => marker.id === selectedMarkerId)) {
      setSelectedMarkerId(null);
      setSelectedEventIndex(0);
    }
  }, [renderedEventMarkers, selectedMarkerId]);

  const getIndexFromX = useCallback((pageX: number, layoutX: number) => {
    const x = pageX - layoutX;
    const pct = Math.max(0, Math.min(1, x / Math.max(1, layoutWidth.current)));
    return Math.round(pct * (candles.length - 1));
  }, [candles.length]);

  const getEventMarkerFromPoint = useCallback((pageX: number, pageY: number): RenderedEventMarker | null => {
    if (layoutWidth.current <= 0) return null;
    const localX = pageX - layoutXRef.current;
    const localY = pageY - layoutYRef.current;
    let nearest: RenderedEventMarker | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    renderedEventMarkers.forEach((marker) => {
      const markerX = (marker.xPercent / 100) * layoutWidth.current;
      const distance = Math.hypot(markerX - localX, marker.markerY - localY);
      if (distance <= EVENT_HIT_RADIUS && distance < nearestDistance) {
        nearest = marker;
        nearestDistance = distance;
      }
    });
    return nearest;
  }, [renderedEventMarkers]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => {
      const marker = getEventMarkerFromPoint(event.nativeEvent.pageX, event.nativeEvent.pageY);
      gestureMarkerRef.current = marker?.id ?? null;
      gestureMovedRef.current = false;
      if (marker) {
        if (selectedMarkerId === marker.id) {
          setSelectedEventIndex((index) => (index + 1) % marker.events.length);
        } else {
          setSelectedEventIndex(0);
          setSelectedMarkerId(marker.id);
        }
        onScrub(null);
        return;
      }
      setSelectedMarkerId(null);
      setSelectedEventIndex(0);
      onScrub(getIndexFromX(event.nativeEvent.pageX, layoutXRef.current));
    },
    onPanResponderMove: (event, gestureState) => {
      const moved = Math.abs(gestureState.dx) > EVENT_DRAG_THRESHOLD
        || Math.abs(gestureState.dy) > EVENT_DRAG_THRESHOLD;
      gestureMovedRef.current ||= moved;
      if (gestureMarkerRef.current && !gestureMovedRef.current) return;
      if (gestureMarkerRef.current) {
        gestureMarkerRef.current = null;
        setSelectedMarkerId(null);
        setSelectedEventIndex(0);
      }
      onScrub(getIndexFromX(event.nativeEvent.pageX, layoutXRef.current));
    },
    onPanResponderRelease: () => {
      gestureMarkerRef.current = null;
      gestureMovedRef.current = false;
      onScrub(null);
    },
    onPanResponderTerminate: () => {
      gestureMarkerRef.current = null;
      gestureMovedRef.current = false;
      onScrub(null);
    },
  }), [getEventMarkerFromPoint, getIndexFromX, onScrub, selectedMarkerId]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    layoutWidth.current = event.nativeEvent.layout.width;
    setChartWidth(event.nativeEvent.layout.width);
    layoutXRef.current = event.nativeEvent.layout.x;
    (event.target as unknown as { measureInWindow?: (callback: (x: number, y: number) => void) => void })
      ?.measureInWindow?.((x, y) => {
        layoutXRef.current = x;
        layoutYRef.current = y;
      });
  }, []);

  const handleAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
    const action = event.nativeEvent.actionName;
    if (action === 'escape') {
      setSelectedMarkerId(null);
      setSelectedEventIndex(0);
      return;
    }
    if (accessibleEvents.length === 0) return;

    const currentIndex = accessibleEvents.findIndex(({ marker, eventIndex }) => (
      marker.id === selectedMarkerId && eventIndex === selectedEventIndex
    ));
    let nextIndex = currentIndex;
    if (action === 'decrement') {
      nextIndex = currentIndex <= 0 ? accessibleEvents.length - 1 : currentIndex - 1;
    } else if (action === 'increment' || action === 'activate') {
      nextIndex = currentIndex < 0 || currentIndex >= accessibleEvents.length - 1 ? 0 : currentIndex + 1;
    } else {
      return;
    }

    const next = accessibleEvents[nextIndex];
    setSelectedMarkerId(next.marker.id);
    setSelectedEventIndex(next.eventIndex);
    onScrub(null);
  }, [accessibleEvents, onScrub, selectedEventIndex, selectedMarkerId]);

  const bubbleWidth = Math.min(EVENT_BUBBLE_MAX_WIDTH, Math.max(0, chartWidth - EVENT_BUBBLE_SIDE_GUTTER * 2));
  const selectedMarkerX = selectedMarker ? (selectedMarker.xPercent / 100) * chartWidth : 0;
  const bubbleLeft = Math.max(
    EVENT_BUBBLE_SIDE_GUTTER,
    Math.min(
      selectedMarkerX - bubbleWidth / 2,
      Math.max(EVENT_BUBBLE_SIDE_GUTTER, chartWidth - bubbleWidth - EVENT_BUBBLE_SIDE_GUTTER),
    ),
  );
  const bubbleTop = selectedMarker && selectedMarker.pointY > height / 2
    ? EVENT_BUBBLE_SIDE_GUTTER
    : Math.max(EVENT_BUBBLE_SIDE_GUTTER, height - EVENT_BUBBLE_HEIGHT - EVENT_BUBBLE_SIDE_GUTTER);

  return (
    <View
      style={{ width: '100%', height }}
      onLayout={handleLayout}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={`Phoenix price chart with ${accessibleEvents.length} story events`}
      accessibilityHint="Swipe up or down to move between story events. Double tap to select the next event."
      accessibilityValue={selectedEvent ? { text: `${formatEventTime(selectedEvent.eventAt)}. ${selectedEvent.text}` } : undefined}
      accessibilityActions={[
        { name: 'activate', label: 'Select next story event' },
        { name: 'increment', label: 'Next story event' },
        { name: 'decrement', label: 'Previous story event' },
        { name: 'escape', label: 'Dismiss story event' },
      ]}
      onAccessibilityAction={handleAccessibilityAction}
      {...panResponder.panHandlers}
    >
      <Svg width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none">
        <ChartDefs>
          <LinearGradient id="phoenixChartFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </ChartDefs>
        <Path d={fillPath} fill="url(#phoenixChartFill)" />
        <Path d={linePath} fill="none" stroke={color} strokeWidth={0.6} />

        {scrubPoint && (
          <>
            <Line
              x1={scrubPoint.x}
              y1={0}
              x2={scrubPoint.x}
              y2={height}
              stroke="rgba(255,255,255,0.2)"
              strokeWidth={0.3}
              strokeDasharray="2,2"
            />
            <Circle cx={scrubPoint.x} cy={scrubPoint.y} r={1.2} fill="#fff" />
            <Circle cx={scrubPoint.x} cy={scrubPoint.y} r={2.5} fill={color} opacity={0.4} />
          </>
        )}

        {scrubIndex === null && lastPoint && (
          <>
            <Circle cx={lastPoint.x} cy={lastPoint.y} r={1} fill={color} />
            <Circle cx={lastPoint.x} cy={lastPoint.y} r={2} fill={color} opacity={0.3} />
          </>
        )}
      </Svg>

      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {renderedEventMarkers.map((marker) => {
          const selected = marker.id === selectedMarkerId;
          const markerEvent = marker.events[selected ? selectedEventIndex : 0] ?? marker.events[0];
          const stemTop = Math.min(marker.markerY, marker.pointY);
          return (
            <View key={marker.id} style={StyleSheet.absoluteFill}>
              <View
                style={[
                  styles.eventStem,
                  {
                    left: `${marker.xPercent}%`,
                    top: stemTop,
                    height: Math.max(1, Math.abs(marker.pointY - marker.markerY)),
                    backgroundColor: selected ? color : tokens.colors.accent,
                  },
                ]}
              />
              <View
                style={[
                  styles.eventMarker,
                  {
                    left: `${marker.xPercent}%`,
                    top: marker.markerY,
                    borderColor: selected ? semantic.text.primary : semantic.background.screen,
                  },
                  selected && styles.eventMarkerSelected,
                ]}
              >
                {markerEvent?.imageUrl ? (
                  <Image
                    source={markerEvent.imageUrl}
                    style={styles.eventMarkerImage}
                    contentFit="cover"
                    transition={100}
                  />
                ) : (
                  <View style={styles.eventMarkerFallback}>
                    <Text style={styles.eventMarkerFallbackText}>₿</Text>
                  </View>
                )}
              </View>
            </View>
          );
        })}

        {selectedMarker && selectedEvent && chartWidth > 0 ? (
          <View
            style={[
              styles.eventBubble,
              { left: bubbleLeft, top: bubbleTop, width: bubbleWidth },
            ]}
          >
            {selectedEvent.imageUrl ? (
              <Image
                source={selectedEvent.imageUrl}
                style={styles.eventBubbleImage}
                contentFit="cover"
                transition={140}
                accessibilityLabel="Bitcoin memory image"
              />
            ) : (
              <View style={styles.eventBubbleImageFallback}>
                <Text style={styles.eventBubbleImageFallbackText}>₿</Text>
              </View>
            )}
            <View style={styles.eventBubbleCopy}>
              <Text style={styles.eventBubbleText} numberOfLines={2}>
                {selectedEvent.text}
              </Text>
              <View style={styles.eventBubbleMetaRow}>
                <Text style={styles.eventBubbleTime} numberOfLines={1}>
                  {formatEventTime(selectedEvent.eventAt)}
                </Text>
                {selectedMarker.events.length > 1 ? (
                  <Text style={styles.eventBubbleCount}>
                    {selectedEventIndex + 1}/{selectedMarker.events.length} · tap marker
                  </Text>
                ) : null}
              </View>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function formatEventTime(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${day} · ${time}`;
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: semantic.background.screen,
    paddingTop: tokens.spacing.sm,
  },
  chartArea: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  noDataWrap: {
    alignItems: 'center',
    gap: tokens.spacing.xs,
    paddingHorizontal: tokens.spacing.lg,
  },
  noData: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    color: semantic.text.dim,
  },
  noDataDetail: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    lineHeight: 13,
    color: semantic.text.faint,
    textAlign: 'center',
  },
  scrubOverlay: {
    position: 'absolute',
    top: tokens.spacing.sm,
    left: tokens.spacing.lg,
    zIndex: 2,
  },
  scrubPrice: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
  },
  scrubTime: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.faint,
    marginTop: 2,
  },
  eventStem: {
    position: 'absolute',
    width: 1,
    transform: [{ translateX: -0.5 }],
    opacity: 0.9,
  },
  eventMarker: {
    position: 'absolute',
    width: EVENT_MARKER_SIZE,
    height: EVENT_MARKER_SIZE,
    borderRadius: EVENT_MARKER_SIZE / 2,
    borderWidth: 2,
    overflow: 'hidden',
    backgroundColor: semantic.background.screen,
    transform: [
      { translateX: -EVENT_MARKER_SIZE / 2 },
      { translateY: -EVENT_MARKER_SIZE / 2 },
    ],
  },
  eventMarkerSelected: {
    borderWidth: 3,
    transform: [
      { translateX: -EVENT_MARKER_SIZE / 2 },
      { translateY: -EVENT_MARKER_SIZE / 2 },
      { scale: 1.15 },
    ],
  },
  eventMarkerImage: {
    width: '100%',
    height: '100%',
    borderRadius: tokens.radius.full,
  },
  eventMarkerFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colors.accent,
  },
  eventMarkerFallbackText: {
    color: semantic.background.screen,
    fontSize: tokens.fontSize.xs,
    fontWeight: '900',
  },
  eventBubble: {
    position: 'absolute',
    minHeight: EVENT_BUBBLE_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: 7,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
    borderCurve: 'continuous',
  },
  eventBubbleImage: {
    width: 34,
    height: 34,
    borderRadius: tokens.radius.full,
    backgroundColor: semantic.background.screen,
  },
  eventBubbleImageFallback: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.radius.full,
    backgroundColor: semantic.background.screen,
  },
  eventBubbleImageFallbackText: {
    color: tokens.colors.accent,
    fontSize: tokens.fontSize.md,
    fontWeight: '900',
  },
  eventBubbleCopy: {
    flex: 1,
    minWidth: 0,
    gap: tokens.spacing.xs,
  },
  eventBubbleText: {
    color: semantic.text.primary,
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
    lineHeight: 13,
  },
  eventBubbleMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacing.sm,
  },
  eventBubbleTime: {
    flex: 1,
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
  },
  eventBubbleCount: {
    color: semantic.text.accentDim,
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
  },
  tfRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: tokens.spacing.sm,
    paddingVertical: tokens.spacing.sm,
  },
  tfPill: {
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: 6,
    borderRadius: tokens.radius.xs,
  },
  tfText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '700',
    color: semantic.text.faint,
  },
});
