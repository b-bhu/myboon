import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { semantic, tokens } from '@/theme';

/**
 * CycleChart — One Tap Up/Down price chart (Predict redesign PRD §2).
 *
 * Shows the previous round's closing tail, the round boundary, the target
 * (open) price line, and the current round progressing toward its deadline.
 * Pure render: data shaping happens in the round lifecycle hook.
 *
 * Honesty rule: the chart never renders a result. Settlement display lives
 * outside this component ("Round closed" state while resolving).
 */

export interface CyclePoint {
  /** Epoch ms. */
  t: number;
  /** Price. */
  p: number;
}

export interface CycleChartProps {
  /** Previous round's price tail (already trimmed, oldest → newest). */
  previous: CyclePoint[];
  /** Current round price points (oldest → newest). */
  current: CyclePoint[];
  /** Round open price — the Up/Down boundary. */
  targetPrice: number;
  /** Round start epoch ms. */
  roundStart: number;
  /** Round deadline epoch ms. */
  roundEnd: number;
  /** Now, epoch ms (passed in so the chart stays pure). */
  now: number;
  width?: number;
  height?: number;
  /** 'up' highlights the current price vs target in viridian, 'down' in vermillion, null neutral. */
  direction?: 'up' | 'down' | null;
}

const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 18;

function nicePriceRange(min: number, max: number): { lo: number; hi: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1 };
  if (min === max) return { lo: min - 0.5, hi: max + 0.5 };
  const pad = (max - min) * 0.15;
  return { lo: min - pad, hi: max + pad };
}

export function CycleChart({
  previous,
  current,
  targetPrice,
  roundStart,
  roundEnd,
  now,
  width = 343,
  height = 170,
  direction = null,
}: CycleChartProps) {
  const all = useMemo(() => [...previous, ...current], [previous, current]);
  const range = useMemo(() => {
    const prices = all.map((pt) => pt.p).concat(targetPrice);
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of prices) {
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    return nicePriceRange(lo, hi);
  }, [all, targetPrice]);

  // X axis spans [roundStart - previousWindow, roundEnd]. Previous tail occupies
  // the left margin before the boundary; the current round fills the rest.
  const prevSpanMs = 30 * 60 * 1000; // show up to 30 min of the previous round
  const x0 = roundStart - prevSpanMs;
  const x1 = roundEnd;
  const spanX = Math.max(x1 - x0, 1);
  const spanY = Math.max(range.hi - range.lo, 0.0001);

  const plotW = width - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;
  const boundaryX = PAD_L + ((roundStart - x0) / spanX) * plotW;
  const targetY = PAD_T + (1 - (targetPrice - range.lo) / spanY) * plotH;

  const toXY = (pt: CyclePoint): [number, number] => [
    PAD_L + ((pt.t - x0) / spanX) * plotW,
    PAD_T + (1 - (pt.p - range.lo) / spanY) * plotH,
  ];

  const pathFor = (pts: CyclePoint[]): string => {
    if (pts.length === 0) return '';
    let d = '';
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = toXY(pts[i]);
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return d;
  };

  const prevPath = pathFor(previous);
  const curPath = pathFor(current);
  const last = current.length > 0 ? current[current.length - 1] : null;
  const [lastX, lastY] = last ? toXY(last) : [PAD_L, targetY];
  const dirColor =
    direction === 'up' ? tokens.colors.viridian : direction === 'down' ? tokens.colors.vermillion : tokens.colors.primary;
  const progress = Math.min(1, Math.max(0, (now - roundStart) / Math.max(roundEnd - roundStart, 1)));

  return (
    <View style={styles.wrap} accessibilityLabel="Round price chart">
      <Svg width={width} height={height}>
        {/* previous round region (dimmed zone) */}
        <Rect x={PAD_L} y={PAD_T} width={Math.max(boundaryX - PAD_L, 0)} height={plotH} fill="rgba(245,250,252,0.03)" />
        {/* current round region */}
        <Rect x={boundaryX} y={PAD_T} width={Math.max(width - PAD_R - boundaryX, 0)} height={plotH} fill="rgba(17,138,178,0.05)" />

        {/* target (open) price line */}
        <Line
          x1={PAD_L}
          y1={targetY}
          x2={width - PAD_R}
          y2={targetY}
          stroke={tokens.colors.accent}
          strokeWidth={1}
          strokeDasharray="4 4"
          opacity={0.8}
        />

        {/* round boundary */}
        <Line
          x1={boundaryX}
          y1={PAD_T}
          x2={boundaryX}
          y2={PAD_T + plotH}
          stroke={semantic.text.faint}
          strokeWidth={1}
          opacity={0.6}
        />

        {/* previous tail */}
        {prevPath ? <Path d={prevPath} stroke={semantic.text.faint} strokeWidth={1.5} fill="none" opacity={0.55} /> : null}
        {/* current line */}
        {curPath ? <Path d={curPath} stroke={dirColor} strokeWidth={2} fill="none" /> : null}
        {/* live price dot */}
        {last ? <Circle cx={lastX} cy={lastY} r={4} fill={dirColor} /> : null}

        {/* deadline tick */}
        <Line
          x1={width - PAD_R}
          y1={PAD_T}
          x2={width - PAD_R}
          y2={PAD_T + plotH}
          stroke={semantic.text.faint}
          strokeWidth={1}
          opacity={0.35}
        />
      </Svg>

      {/* Labels overlay */}
      <View style={styles.labelRow} pointerEvents="none">
        <Text style={styles.labelFaint}>previous</Text>
        <Text style={styles.labelTarget}>target {Math.round(targetPrice * 100)}¢</Text>
        <Text style={styles.labelFaint}>closes</Text>
      </View>
      {/* Progress bar toward deadline */}
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { flex: Math.max(progress, 0.001) }]} />
        <View style={[styles.progressRest, { flex: Math.max(1 - progress, 0.001) }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    paddingHorizontal: PAD_L + 4,
    marginTop: -14,
    marginBottom: 2,
  },
  labelFaint: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
  },
  labelTarget: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: tokens.colors.accent,
  },
  progressTrack: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    height: 3,
    borderRadius: 999,
    overflow: 'hidden',
    marginHorizontal: PAD_L + 4,
    backgroundColor: 'rgba(245,250,252,0.08)',
  },
  progressFill: {
    backgroundColor: tokens.colors.primary,
  },
  progressRest: {
    backgroundColor: 'transparent',
  },
});
