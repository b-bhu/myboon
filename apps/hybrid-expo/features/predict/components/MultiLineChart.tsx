import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import Svg, { Path, Circle, Line } from 'react-native-svg';
import type { PricePoint } from '@/features/predict/predict.types';
import { semantic, tokens } from '@/theme';

interface ChartSeries {
  points: PricePoint[];
  color: string;
  label: string;
}

interface MultiLineChartProps {
  series: ChartSeries[];
  width: number;
  height: number;
}

interface TooltipData {
  x: number;
  y: number;
  prices: { label: string; price: number; color: string }[];
  time: string;
}

const Y_PAD = 24; // left padding for y-axis labels
const X_PAD = 20; // bottom padding for x-axis labels
const TOP_PAD = 4;
const RIGHT_PAD = 4;

function buildPath(points: PricePoint[], w: number, h: number, minT: number, maxT: number): string | null {
  if (points.length < 2) return null;
  const rangeT = maxT - minT || 1;
  const chartH = h - X_PAD - TOP_PAD;
  const chartW = w - Y_PAD - RIGHT_PAD;

  const coords = points.map((pt) => ({
    x: ((pt.t - minT) / rangeT) * chartW + Y_PAD,
    y: TOP_PAD + chartH - pt.p * chartH,
  }));

  return coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
}

function endpointCoord(points: PricePoint[], w: number, h: number, minT: number, maxT: number): { x: number; y: number } | null {
  if (points.length < 1) return null;
  const last = points[points.length - 1];
  const rangeT = maxT - minT || 1;
  const chartH = h - X_PAD - TOP_PAD;
  const chartW = w - Y_PAD - RIGHT_PAD;
  return {
    x: ((last.t - minT) / rangeT) * chartW + Y_PAD,
    y: TOP_PAD + chartH - last.p * chartH,
  };
}

function formatTimeLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function formatDateLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const month = d.toLocaleString('en-US', { month: 'short' });
  const day = d.getDate();
  return `${month} ${day}`;
}

function formatTooltipTime(ts: number): string {
  const d = new Date(ts * 1000);
  const month = d.toLocaleString('en-US', { month: 'short' });
  const day = d.getDate();
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${month} ${day}, ${h}:${m}`;
}

function getXLabels(allPoints: PricePoint[], w: number): { label: string; x: number }[] {
  if (allPoints.length < 2) return [];
  const minT = allPoints[0].t;
  const maxT = allPoints[allPoints.length - 1].t;
  const rangeT = maxT - minT || 1;
  const chartW = w - Y_PAD - RIGHT_PAD;

  // Determine if range is > 24h for date vs time labels
  const isMultiDay = rangeT > 24 * 60 * 60;
  const count = 4; // number of x-axis labels
  const labels: { label: string; x: number }[] = [];

  for (let i = 0; i <= count; i++) {
    const t = minT + (rangeT * i) / count;
    const x = (i / count) * chartW + Y_PAD;
    labels.push({
      label: isMultiDay ? formatDateLabel(t) : formatTimeLabel(t),
      x,
    });
  }
  return labels;
}

export function MultiLineChart({ series, width, height }: MultiLineChartProps) {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);

  // Every series shares the same time axis. Mapping each line against its own
  // first/last timestamp visually compares different moments at the same x.
  const allPoints = series.flatMap((item) => item.points).sort((a, b) => a.t - b.t);
  const minTime = allPoints[0]?.t ?? 0;
  const maxTime = allPoints[allPoints.length - 1]?.t ?? minTime + 1;
  const xLabels = getXLabels(allPoints, width);

  const chartH = height - X_PAD - TOP_PAD;
  const chartW = width - Y_PAD - RIGHT_PAD;

  // Y-axis grid lines at 0%, 50%, 100%
  const gridYs = [0, 0.5, 1].map((pct) => TOP_PAD + chartH - pct * chartH);

  const handlePress = useCallback((evt: { nativeEvent: { locationX: number } }) => {
    if (allPoints.length < 2) return;

    const touchX = evt.nativeEvent.locationX;
    const minT = allPoints[0].t;
    const maxT = allPoints[allPoints.length - 1].t;
    const rangeT = maxT - minT || 1;

    // Convert touch X to timestamp
    const tRatio = (touchX - Y_PAD) / chartW;
    const targetT = minT + tRatio * rangeT;

    // Find nearest point from each series
    const prices: TooltipData['prices'] = [];
    let closestY = TOP_PAD + chartH / 2;

    for (const s of series) {
      if (s.points.length === 0) continue;
      let nearest = s.points[0];
      let minDist = Math.abs(nearest.t - targetT);
      for (const pt of s.points) {
        const dist = Math.abs(pt.t - targetT);
        if (dist < minDist) {
          minDist = dist;
          nearest = pt;
        }
      }
      prices.push({ label: s.label, price: nearest.p, color: s.color });
      if (prices.length === 1) {
        closestY = TOP_PAD + chartH - nearest.p * chartH;
      }
    }

    // Clamp x position for tooltip
    const clampedX = Math.max(Y_PAD + 30, Math.min(touchX, width - 60));

    setTooltip({
      x: clampedX,
      y: closestY,
      prices,
      time: formatTooltipTime(targetT),
    });
  }, [allPoints, series, chartW, chartH, width]);

  const dismissTooltip = useCallback(() => setTooltip(null), []);

  return (
    <View style={[styles.container, { width, height }]}>
      {/* Y-axis labels */}
      <View style={[styles.yAxis, { top: TOP_PAD, bottom: X_PAD }]}>
        <Text style={styles.yLabel}>100%</Text>
        <Text style={styles.yLabel}>50%</Text>
        <Text style={styles.yLabel}>0%</Text>
      </View>

      {/* Chart SVG */}
      <Svg width={width} height={height}>
        {/* Grid lines */}
        {gridYs.map((y, i) => (
          <Line
            key={`grid-${i}`}
            x1={Y_PAD}
            y1={y}
            x2={width - RIGHT_PAD}
            y2={y}
            stroke={semantic.predict.rowBorderSoft}
            strokeWidth={0.5}
          />
        ))}

        {/* Data lines */}
        {series.map((s, i) => {
          const path = buildPath(s.points, width, height, minTime, maxTime);
          if (!path) return null;
          return (
            <Path
              key={`line-${s.label}-${i}`}
              d={path}
              stroke={s.color}
              strokeWidth={1.8}
              fill="none"
              strokeLinejoin="round"
              opacity={0.85}
            />
          );
        })}

        {/* Endpoint dots */}
        {series.map((s, i) => {
          const endpoint = endpointCoord(s.points, width, height, minTime, maxTime);
          if (!endpoint) return null;
          return (
            <Circle
              key={`dot-${s.label}-${i}`}
              cx={endpoint.x}
              cy={endpoint.y}
              r={3}
              fill={s.color}
            />
          );
        })}

        {/* Tooltip crosshair */}
        {tooltip && (
          <Line
            x1={tooltip.x}
            y1={TOP_PAD}
            x2={tooltip.x}
            y2={height - X_PAD}
            stroke={semantic.text.faint}
            strokeWidth={0.5}
            strokeDasharray="3,3"
          />
        )}
      </Svg>

      {/* Touch overlay */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={handlePress}
        onLongPress={handlePress}
      />

      {/* X-axis labels */}
      <View style={styles.xAxis}>
        {xLabels.map((lbl, i) => (
          <Text
            key={`x-${i}`}
            style={[
              styles.xLabel,
              { left: lbl.x, transform: [{ translateX: -16 }] },
            ]}>
            {lbl.label}
          </Text>
        ))}
      </View>

      {/* Tooltip bubble */}
      {tooltip && (
        <Pressable onPress={dismissTooltip} style={[styles.tooltipWrap, { left: tooltip.x - 50, top: Math.max(TOP_PAD, tooltip.y - 60) }]}>
          <View style={styles.tooltip}>
            <Text style={styles.tooltipTime}>{tooltip.time}</Text>
            {tooltip.prices.map((p) => (
              <View key={p.label} style={styles.tooltipRow}>
                <View style={[styles.tooltipDot, { backgroundColor: p.color }]} />
                <Text style={styles.tooltipLabel}>{p.label}</Text>
                <Text style={[styles.tooltipPrice, { color: p.color }]}>{Math.round(p.price * 100)}¢</Text>
              </View>
            ))}
          </View>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
  },
  yAxis: {
    position: 'absolute',
    left: 0,
    width: Y_PAD,
    justifyContent: 'space-between',
    zIndex: 1,
  },
  yLabel: {
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '600',
    color: semantic.text.dim,
    lineHeight: 10,
  },
  xAxis: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: X_PAD,
    flexDirection: 'row',
  },
  xLabel: {
    position: 'absolute',
    bottom: 2,
    fontFamily: 'monospace',
    fontSize: 7,
    color: semantic.text.faint,
  },
  tooltipWrap: {
    position: 'absolute',
    zIndex: 10,
  },
  tooltip: {
    backgroundColor: tokens.colors.lift,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: semantic.predict.rowBorderSoft,
    minWidth: 100,
  },
  tooltipTime: {
    fontFamily: 'monospace',
    fontSize: 7,
    color: semantic.text.faint,
    marginBottom: 3,
  },
  tooltipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 1,
  },
  tooltipDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  tooltipLabel: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.dim,
    flex: 1,
  },
  tooltipPrice: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '700',
  },
});
