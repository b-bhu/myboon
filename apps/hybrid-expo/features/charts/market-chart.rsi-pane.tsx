/**
 * RSI pane for the shared market screen's reserved slot (#656).
 *
 * Collapsed by default with the current value on the closed header (mock:
 * docs/mockups/design-language/market-experience/index.html@4f6cc2ad). The
 * open/closed choice persists across markets and app sessions through
 * AsyncStorage — the app's existing remembered-choice mechanism (same pattern
 * as useOddsFormat). When a venue has no candle chart the composition leaves
 * `data` undefined and this pane renders nothing at all.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { IconChevronDown } from '@tabler/icons-react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';

import { semantic, tokens } from '@/theme';
import { RSI_MIN_CANDLES, RSI_PERIOD, type RsiPaneData, type RsiPoint } from './market-chart.rsi';

const RSI_PANE_OPEN_KEY = 'market_screen_rsi_pane_open';

/**
 * Open state for the pane, remembered across markets and app restarts.
 * Defaults collapsed; a failed storage read keeps the pane collapsed.
 */
export function useRsiPaneOpen() {
  const [open, setOpenState] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(RSI_PANE_OPEN_KEY)
      .then((stored) => {
        if (stored === '1') setOpenState(true);
      })
      .catch(() => {});
  }, []);

  const setOpen = useCallback((value: boolean) => {
    setOpenState(value);
    AsyncStorage.setItem(RSI_PANE_OPEN_KEY, value ? '1' : '0').catch(() => {});
  }, []);

  return { open, setOpen };
}

interface RsiPaneProps {
  /** Pane inputs; null/undefined renders nothing (venue has no candle chart). */
  data: RsiPaneData | null | undefined;
  open: boolean;
  onToggleOpen: () => void;
}

const PLOT_WIDTH = 340;
const PLOT_HEIGHT = 70;
const SCALE_LOW = 10;
const SCALE_HIGH = 94;
const PLOT_PAD = 5;

function plotY(value: number): number {
  const span = SCALE_HIGH - SCALE_LOW;
  const spanned = PLOT_HEIGHT - PLOT_PAD * 2;
  return PLOT_PAD + ((SCALE_HIGH - value) / span) * spanned;
}

function PlotGeometry({ points }: { points: readonly RsiPoint[] }) {
  const lastIndex = points.length - 1;
  const coords = points.map((point, index) => ({
    x: lastIndex === 0 ? PLOT_WIDTH / 2 : (index / lastIndex) * PLOT_WIDTH,
    y: plotY(point.value),
  }));
  const guideStyle = {
    stroke: semantic.border.muted,
    strokeOpacity: 0.7,
    strokeWidth: 1,
    strokeDasharray: '3 3',
  } as const;
  const polyline = coords.map((coord) => `${coord.x.toFixed(1)},${coord.y.toFixed(1)}`).join(' ');

  return (
    <Svg
      width="100%"
      height={PLOT_HEIGHT}
      viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Line x1={0} y1={plotY(70)} x2={PLOT_WIDTH} y2={plotY(70)} {...guideStyle} />
      <Line x1={0} y1={plotY(30)} x2={PLOT_WIDTH} y2={plotY(30)} {...guideStyle} />
      {points.length === 1 ? (
        <Circle cx={coords[0]!.x} cy={coords[0]!.y} r={3} fill={semantic.text.accent} />
      ) : (
        <Polyline points={polyline} fill="none" stroke={semantic.text.accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </Svg>
  );
}

export function RsiPane({ data, open, onToggleOpen }: RsiPaneProps) {
  // No candle chart for this venue, or the candle request failed: absent
  // entirely rather than an empty stub. The chart above keeps its own retry.
  if (data == null || data.kind === 'error') return null;

  const valueLabel =
    data.kind === 'ready'
      ? String(Math.round(data.value))
      : data.kind === 'insufficient-history'
        ? '—'
        : null;
  const accessibilityLabel =
    data.kind === 'ready'
      ? `RSI ${RSI_PERIOD}, current value ${valueLabel}`
      : data.kind === 'insufficient-history'
        ? `RSI ${RSI_PERIOD}, not enough history`
        : `RSI ${RSI_PERIOD} loading`;

  return (
    <View style={styles.pane}>
      <Pressable
        onPress={onToggleOpen}
        style={({ pressed }) => [styles.header, pressed && styles.headerPressed]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={open ? 'Collapses the RSI pane' : 'Opens the RSI pane below the price chart'}
        accessibilityState={{ expanded: open }}
      >
        <View style={styles.headerLeft}>
          <Text style={styles.label}>{`RSI ${RSI_PERIOD}`}</Text>
          {data.kind === 'loading' ? (
            <ActivityIndicator size="small" color={semantic.text.dim} />
          ) : (
            <Text style={styles.value}>{valueLabel}</Text>
          )}
        </View>
        <IconChevronDown
          size={14}
          strokeWidth={2}
          color={semantic.text.faint}
          style={open ? styles.chevronOpen : undefined}
        />
      </Pressable>

      {open ? (
        <View style={styles.body}>
          {data.kind === 'ready' ? (
            <View style={styles.plotWrap}>
              <PlotGeometry points={data.points} />
            </View>
          ) : null}
          {data.kind === 'loading' ? (
            <View style={styles.statusRow}>
              <ActivityIndicator size="small" color={semantic.text.dim} />
              <Text style={styles.statusText}>Loading RSI…</Text>
            </View>
          ) : null}
          {data.kind === 'insufficient-history' ? (
            <View style={styles.statusRow}>
              <Text style={styles.statusText}>Not enough history</Text>
              <Text style={styles.statusDetail}>
                {`RSI ${RSI_PERIOD} needs ${data.need} candles; this range has ${data.have}.`}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pane: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.border.muted,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  headerPressed: {
    backgroundColor: semantic.background.lift,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.sm,
  },
  label: {
    color: semantic.text.faint,
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
    letterSpacing: tokens.letterSpacing.mono,
    textTransform: 'uppercase',
    fontVariant: ['tabular-nums'],
  },
  value: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.xs,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  chevronOpen: {
    transform: [{ rotate: '180deg' }],
  },
  body: {
    paddingBottom: tokens.spacing.sm,
  },
  plotWrap: {
    paddingHorizontal: tokens.spacing.sm,
  },
  statusRow: {
    paddingHorizontal: tokens.spacing.md,
    gap: tokens.spacing.xxs,
  },
  statusText: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.sm,
    fontWeight: '600',
  },
  statusDetail: {
    color: semantic.text.faint,
    fontSize: tokens.fontSize.sm,
  },
});
