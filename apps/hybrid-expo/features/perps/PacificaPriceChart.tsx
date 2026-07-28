import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  ActivityIndicator,
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Path, Circle, Line } from 'react-native-svg';
import { fetchCandles, formatPrice } from '@/features/perps/perps.public-api';
import type { CandleInterval } from '@/features/perps/perps.public-api';
import type { Candle } from '@/features/perps/perps.types';
import { semantic, tokens } from '@/theme';

const TIMEFRAMES: { label: string; interval: CandleInterval; count: number }[] = [
  { label: '1H', interval: '1m', count: 60 },
  { label: '1D', interval: '15m', count: 96 },
  { label: '1W', interval: '1h', count: 168 },
  { label: '1M', interval: '4h', count: 180 },
  { label: 'ALL', interval: '1d', count: 365 },
];

const ChartDefs = Defs as unknown as ComponentType<{ children?: ReactNode }>;

interface PriceChartProps {
  symbol: string;
  height?: number;
  /** Called when user scrubs — parent can update header price */
  onScrub?: (price: number | null, time: number | null) => void;
}

export function PacificaPriceChart({ symbol, height = 160, onScrub }: PriceChartProps) {
  const [tfIndex, setTfIndex] = useState(1); // default 1D
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);

  const tf = TIMEFRAMES[tfIndex];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchCandles(symbol, tf.interval, tf.count)
      .then((data) => {
        if (!cancelled) setCandles(data);
      })
      .catch(() => {
        if (!cancelled) setCandles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [symbol, tf.interval, tf.count]);

  const isUp =
    candles.length >= 2 ? candles[candles.length - 1].close >= candles[0].open : true;
  const lineColor = isUp ? tokens.colors.viridian : tokens.colors.vermillion;

  // Scrub price for display
  const scrubCandle = scrubIndex !== null ? candles[scrubIndex] : null;

  const handleScrub = useCallback((index: number | null) => {
    setScrubIndex(index);
    if (onScrub) {
      if (index !== null && candles[index]) {
        onScrub(candles[index].close, candles[index].time);
      } else {
        onScrub(null, null);
      }
    }
  }, [candles, onScrub]);

  return (
    <View style={styles.container}>
      {/* Scrub price overlay */}
      {scrubCandle && (
        <View style={styles.scrubOverlay}>
          <Text style={[styles.scrubPrice, { color: lineColor }]}>
            {formatPrice(scrubCandle.close)}
          </Text>
          <Text style={styles.scrubTime}>
            {formatScrubTime(scrubCandle.time, tf.interval)}
          </Text>
        </View>
      )}

      {/* Chart area */}
      <View style={[styles.chartArea, { height }]}>
        {loading ? (
          <ActivityIndicator size="small" color={semantic.text.accent} />
        ) : candles.length < 2 ? (
          <Text style={styles.noData}>No data</Text>
        ) : (
          <InteractiveChart
            candles={candles}
            height={height}
            color={lineColor}
            scrubIndex={scrubIndex}
            onScrub={handleScrub}
          />
        )}
      </View>

      {/* Timeframe pills */}
      <View style={styles.tfRow}>
        {TIMEFRAMES.map((t, i) => (
          <Pressable
            key={t.label}
            style={[styles.tfPill, i === tfIndex && { backgroundColor: isUp ? 'rgba(74,140,111,0.12)' : 'rgba(217,83,79,0.12)' }]}
            onPress={() => { setTfIndex(i); setScrubIndex(null); }}>
            <Text style={[styles.tfText, i === tfIndex && { color: lineColor }]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ─── Format scrub timestamp ─────────────────────────────────────────────────

function formatScrubTime(ms: number, interval: CandleInterval): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (interval === '1m' || interval === '3m' || interval === '5m' || interval === '15m' || interval === '30m') {
    return time;
  }
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (interval === '1d') return date;
  return `${date}, ${time}`;
}

// ─── Interactive chart with touch scrubbing ─────────────────────────────────

interface InteractiveChartProps {
  candles: Candle[];
  height: number;
  color: string;
  scrubIndex: number | null;
  onScrub: (index: number | null) => void;
}

const CHART_PAD_TOP = 8;
const CHART_PAD_BOTTOM = 8;

function InteractiveChart({ candles, height, color, scrubIndex, onScrub }: InteractiveChartProps) {
  const layoutWidth = useRef(0);

  const closes = useMemo(() => candles.map((c) => c.close), [candles]);
  const min = useMemo(() => Math.min(...closes), [closes]);
  const max = useMemo(() => Math.max(...closes), [closes]);
  const range = max - min || 1;
  const drawH = height - CHART_PAD_TOP - CHART_PAD_BOTTOM;

  const points = useMemo(() =>
    closes.map((val, i) => ({
      x: (i / (closes.length - 1)) * 100, // percentage
      y: CHART_PAD_TOP + drawH - ((val - min) / range) * drawH,
    })),
    [closes, min, range, drawH],
  );

  const linePath = useMemo(() =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(1)}`).join(' '),
    [points],
  );

  const fillPath = `${linePath} L100,${height} L0,${height} Z`;
  const lastPt = points[points.length - 1];

  // Compute index from touch X
  const getIndexFromX = useCallback((pageX: number, layoutX: number) => {
    const x = pageX - layoutX;
    const pct = Math.max(0, Math.min(1, x / layoutWidth.current));
    return Math.round(pct * (candles.length - 1));
  }, [candles.length]);

  const layoutXRef = useRef(0);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (evt) => {
      const idx = getIndexFromX(evt.nativeEvent.pageX, layoutXRef.current);
      onScrub(idx);
    },
    onPanResponderMove: (evt) => {
      const idx = getIndexFromX(evt.nativeEvent.pageX, layoutXRef.current);
      onScrub(idx);
    },
    onPanResponderRelease: () => {
      onScrub(null);
    },
    onPanResponderTerminate: () => {
      onScrub(null);
    },
  }), [getIndexFromX, onScrub]);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    layoutWidth.current = e.nativeEvent.layout.width;
    layoutXRef.current = e.nativeEvent.layout.x;
    // Measure absolute position
    (e.target as any)?.measureInWindow?.((x: number) => {
      layoutXRef.current = x;
    });
  }, []);

  // Crosshair data
  const scrubPt = scrubIndex !== null ? points[scrubIndex] : null;

  return (
    <View
      style={{ width: '100%', height }}
      onLayout={handleLayout}
      {...panResponder.panHandlers}
    >
      <Svg width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none">
        <ChartDefs>
          <LinearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </ChartDefs>
        <Path d={fillPath} fill="url(#chartFill)" />
        <Path d={linePath} fill="none" stroke={color} strokeWidth={0.6} />

        {/* Crosshair line + dot when scrubbing */}
        {scrubPt && (
          <>
            <Line
              x1={scrubPt.x} y1={0}
              x2={scrubPt.x} y2={height}
              stroke="rgba(255,255,255,0.2)"
              strokeWidth={0.3}
              strokeDasharray="2,2"
            />
            <Circle cx={scrubPt.x} cy={scrubPt.y} r={1.2} fill="#fff" />
            <Circle cx={scrubPt.x} cy={scrubPt.y} r={2.5} fill={color} opacity={0.4} />
          </>
        )}

        {/* End dot (only when not scrubbing) */}
        {scrubIndex === null && (
          <>
            <Circle cx={lastPt.x} cy={lastPt.y} r={1} fill={color} />
            <Circle cx={lastPt.x} cy={lastPt.y} r={2} fill={color} opacity={0.3} />
          </>
        )}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 0,
  },
  scrubOverlay: {
    position: 'absolute',
    top: 4,
    left: 16,
    right: 16,
    zIndex: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  scrubPrice: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
  },
  scrubTime: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.dim,
    letterSpacing: 0.5,
  },
  chartArea: {
    paddingHorizontal: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  noData: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.faint,
    letterSpacing: 1,
  },
  tfRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  tfPill: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 14,
  },
  tfText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    fontWeight: '600',
    letterSpacing: 0.5,
    color: semantic.text.faint,
  },
});
