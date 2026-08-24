import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { semantic, tokens } from '@/theme';

/**
 * CycleChart — One Tap Up/Down price chart (Predict redesign PRD §2).
 *
 * Shows the previous round's closing tail, the round boundary, the target
 * (open) price line, and the current round progressing toward its deadline.
 * Pure render: data shaping happens in the round lifecycle hook.
 *
 * Honesty rule: this component only renders observed price data and the
 * configured target. Settlement status is owned by the parent screen.
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
  width?: number;
  height?: number;
  /** 'up' highlights the current price vs target in viridian, 'down' in vermillion, null neutral. */
  direction?: 'up' | 'down' | null;
  /** Formats the target marker. Defaults to cents for probability charts. */
  formatPrice?: (price: number) => string;
}

const PAD_L = 4;
const PAD_R = 4;
const PAD_T = 28;
const PAD_B = 8;

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
  width = 343,
  height = 170,
  direction = null,
  formatPrice = (price) => `${Math.round(price * 100)}¢`,
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
  const targetLabel = `Target ${formatPrice(targetPrice)}`;
  const targetLabelWidth = Math.min(154, Math.max(104, targetLabel.length * 6.1));
  const targetLabelX = width - PAD_R - targetLabelWidth;
  const targetLabelY = Math.min(height - PAD_B - 25, Math.max(PAD_T + 3, targetY - 12));

  return (
    <View style={styles.wrap} accessibilityLabel="Round price chart">
      <Svg width={width} height={height}>
        <Rect x={PAD_L} y={PAD_T} width={Math.max(boundaryX - PAD_L, 0)} height={plotH} fill="rgba(3,31,44,0.13)" />

        {[0.34, 0.68].map((ratio) => (
          <Line
            key={ratio}
            x1={PAD_L}
            y1={PAD_T + plotH * ratio}
            x2={width - PAD_R}
            y2={PAD_T + plotH * ratio}
            stroke={tokens.colors.borderMuted}
            strokeWidth={1}
            opacity={0.6}
          />
        ))}

        <SvgText x={PAD_L + 10} y={17} fill={semantic.text.faint} fontFamily="monospace" fontSize={9} fontWeight="700">
          PREVIOUS
        </SvgText>
        <SvgText x={boundaryX + 8} y={13} fill={semantic.text.faint} fontFamily="monospace" fontSize={8} fontWeight="700">
          CURRENT
        </SvgText>
        <SvgText x={boundaryX + 8} y={22} fill={semantic.text.faint} fontFamily="monospace" fontSize={8} fontWeight="700">
          ROUND
        </SvgText>
        <SvgText x={width - PAD_R - 48} y={17} fill={semantic.text.faint} fontFamily="monospace" fontSize={9} fontWeight="700">
          SETTLES
        </SvgText>

        <Line
          x1={PAD_L}
          y1={targetY}
          x2={width - PAD_R}
          y2={targetY}
          stroke={tokens.colors.accent}
          strokeWidth={1.25}
          strokeDasharray="6 5"
          opacity={0.9}
        />

        <Rect
          x={targetLabelX}
          y={targetLabelY}
          width={targetLabelWidth}
          height={24}
          rx={8}
          fill={tokens.colors.ground}
          stroke={tokens.colors.accent}
          strokeWidth={1}
        />
        <SvgText
          x={targetLabelX + 8}
          y={targetLabelY + 16}
          fill={tokens.colors.accent}
          fontFamily="monospace"
          fontSize={9}
          fontWeight="800"
        >
          {targetLabel}
        </SvgText>

        <Line
          x1={boundaryX}
          y1={PAD_T}
          x2={boundaryX}
          y2={PAD_T + plotH}
          stroke={semantic.text.faint}
          strokeWidth={1}
          opacity={0.72}
        />

        {prevPath ? <Path d={prevPath} stroke={tokens.colors.viridian} strokeWidth={2.5} fill="none" opacity={0.58} /> : null}
        {curPath ? <Path d={curPath} stroke={dirColor} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" fill="none" /> : null}
        {last ? <Circle cx={lastX} cy={lastY} r={10} fill={dirColor} opacity={0.18} /> : null}
        {last ? <Circle cx={lastX} cy={lastY} r={6} fill={tokens.colors.ground} stroke={dirColor} strokeWidth={2.5} /> : null}
        {last ? <Circle cx={lastX} cy={lastY} r={3} fill={dirColor} /> : null}

        <Line
          x1={width - PAD_R}
          y1={PAD_T}
          x2={width - PAD_R}
          y2={PAD_T + plotH}
          stroke={semantic.text.faint}
          strokeWidth={1}
          opacity={0.5}
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
  },
});
