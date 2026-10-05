import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type {
  MeteoraDataApiClient,
  MeteoraFreshness,
  MeteoraOhlcvSeries,
  MeteoraTimeframe,
} from '@myboon/shared/meteora';
import { IconChartCandle, IconChartLine } from '@tabler/icons-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MarketChart, type MarketChartMode, type MarketChartStatus } from '@/features/charts';
import { marketChartTheme } from '@/features/charts/market-chart.theme';
import { adaptMeteoraCandles } from '@/features/meteora/meteora.chart-adapter';
import { loadMeteoraChartData } from '@/features/meteora/meteora.chart-data';
import { meteoraClient } from '@/features/meteora/meteora.client';
import { METEORA_COLORS } from '@/features/meteora/meteora.theme';

const CHART_HEIGHT = 260;
const TIMEFRAMES: { interval: MeteoraTimeframe; label: string; intervalSeconds: number }[] = [
  { interval: '5m', label: '5m', intervalSeconds: 300 },
  { interval: '1h', label: '1h', intervalSeconds: 3600 },
  { interval: '4h', label: '4h', intervalSeconds: 14400 },
];

export interface MeteoraPriceChartProps {
  poolAddress: string;
  currentPrice: string | null;
  quoteLabel: string;
  inverted?: boolean;
  client?: Pick<MeteoraDataApiClient, 'getOhlcv'>;
  defaultMode?: MarketChartMode;
  height?: number;
}

export function MeteoraPriceChart({
  poolAddress,
  currentPrice,
  quoteLabel,
  inverted = false,
  client = meteoraClient,
  defaultMode = 'candles',
  height = CHART_HEIGHT,
}: MeteoraPriceChartProps) {
  const [expandedPoolAddress, setExpandedPoolAddress] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState(TIMEFRAMES[1]);
  const [mode, setMode] = useState<MarketChartMode>(defaultMode);
  const expanded = expandedPoolAddress === poolAddress;

  return (
    <View style={styles.container}>
      <Pressable
        onPress={() => setExpandedPoolAddress(expanded ? null : poolAddress)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel="Price chart"
        accessibilityHint={expanded ? 'Collapse price chart' : 'Expand price chart'}
        style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
      >
        <Text style={styles.triggerTitle}>Price Chart</Text>
        <MaterialIcons
          name={expanded ? 'expand-less' : 'expand-more'}
          size={21}
          color={METEORA_COLORS.textDim}
        />
      </Pressable>

      {expanded ? (
        <View style={styles.body}>
          <View style={styles.toolbar}>
            <View style={styles.controlGroup} accessibilityLabel="Candle interval">
              {TIMEFRAMES.map((option) => (
                <Pressable
                  key={option.interval}
                  onPress={() => setTimeframe(option)}
                  accessibilityRole="button"
                  accessibilityLabel={`${option.label} candle interval`}
                  accessibilityState={{ selected: option.interval === timeframe.interval }}
                  style={({ pressed }) => [
                    styles.timeframeButton,
                    option.interval === timeframe.interval && styles.selectedControl,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[
                    styles.controlText,
                    option.interval === timeframe.interval && styles.selectedControlText,
                  ]}>{option.label}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.controlGroup} accessibilityLabel="Chart type">
              {(['candles', 'line'] as const).map((option) => {
                const Icon = option === 'candles' ? IconChartCandle : IconChartLine;
                return (
                  <Pressable
                    key={option}
                    onPress={() => setMode(option)}
                    accessibilityRole="button"
                    accessibilityLabel={option === 'candles' ? 'Candlestick chart' : 'Line chart'}
                    accessibilityState={{ selected: option === mode }}
                    style={({ pressed }) => [
                      styles.modeButton,
                      option === mode && styles.selectedControl,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Icon size={18} strokeWidth={2} color={option === mode
                      ? marketChartTheme.colors.primaryText : marketChartTheme.colors.secondaryText} />
                  </Pressable>
                );
              })}
            </View>
          </View>
          <PoolMarketChart
            key={`${poolAddress}:${timeframe.interval}`}
            poolAddress={poolAddress}
            currentPrice={currentPrice}
            quoteLabel={quoteLabel}
            inverted={inverted}
            client={client}
            timeframe={timeframe}
            mode={mode}
            height={height}
          />
        </View>
      ) : null}
    </View>
  );
}

function PoolMarketChart({
  poolAddress,
  currentPrice,
  quoteLabel,
  inverted,
  client,
  timeframe,
  mode,
  height,
}: Required<Pick<MeteoraPriceChartProps,
  'poolAddress' | 'currentPrice' | 'quoteLabel' | 'inverted' | 'client' | 'height'
>> & {
  timeframe: typeof TIMEFRAMES[number];
  mode: MarketChartMode;
}) {
  const [series, setSeries] = useState<MeteoraOhlcvSeries | null>(null);
  const [freshness, setFreshness] = useState<MeteoraFreshness | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMessage(null);
    void loadMeteoraChartData(client, poolAddress, timeframe).then((result) => {
      if (cancelled) return;
      setSeries(result.data);
      setFreshness(result.freshness);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setSeries(null);
      setFreshness(null);
      setErrorMessage(error instanceof Error ? error.message : 'Price chart unavailable.');
      console.warn('[MeteoraPriceChart] OHLCV request failed', {
        poolAddress,
        timeframe: timeframe.interval,
        message: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [client, poolAddress, timeframe, retryNonce]);

  const candles = useMemo(
    () => adaptMeteoraCandles(series?.candles ?? [], inverted).candles,
    [inverted, series],
  );
  const status: MarketChartStatus = loading
    ? { kind: 'loading', accessibilityLabel: 'Loading Meteora price history' }
    : errorMessage
      ? { kind: 'error', title: 'Chart unavailable', description: errorMessage }
      : candles.length === 0
        ? { kind: 'empty', title: 'No price history available' }
        : { kind: 'ready' };
  const poolPrice = Number(currentPrice);
  const displayPoolPrice = inverted ? 1 / poolPrice : poolPrice;

  return (
    <>
      <View style={styles.readout}>
        <Text style={styles.priceText} selectable>
          Pool price {formatPrice(displayPoolPrice)} {quoteLabel}
        </Text>
        {freshness?.state === 'stale' ? <Text style={styles.staleText} selectable>Cached</Text> : null}
      </View>
      <MarketChart
        seriesKey={`meteora:${poolAddress}:${timeframe.interval}:${inverted ? 'inverted' : 'direct'}`}
        candles={candles}
        mode={mode}
        status={status}
        layers={{ volume: true, currentPrice: true, annotations: false }}
        height={height}
        initialVisibleCandles={48}
        formatPrice={formatPrice}
        formatAxisPrice={formatAxisPrice}
        formatTime={(timeMs) => new Date(timeMs).toLocaleString('en-US', {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        })}
        formatVolume={(value) => value.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })}
        accessibilityLabel={`${quoteLabel} Meteora price chart`}
        onRetry={() => setRetryNonce((value) => value + 1)}
      />
    </>
  );
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.001) return value.toFixed(6);
  return value.toExponential(3);
}

function formatAxisPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1000) return value.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  if (value >= 1) return value.toFixed(2);
  return value.toPrecision(3);
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: METEORA_COLORS.border,
  },
  trigger: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  triggerTitle: {
    color: METEORA_COLORS.text,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700',
  },
  body: {
    paddingBottom: 12,
    backgroundColor: marketChartTheme.colors.canvas,
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: marketChartTheme.colors.divider,
    backgroundColor: marketChartTheme.colors.toolbar,
  },
  controlGroup: {
    flexDirection: 'row',
    gap: 4,
  },
  timeframeButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: marketChartTheme.metrics.controlRadius,
  },
  modeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: marketChartTheme.metrics.controlRadius,
  },
  selectedControl: {
    backgroundColor: marketChartTheme.colors.controlSelected,
  },
  controlText: {
    color: marketChartTheme.colors.secondaryText,
    fontSize: 12,
    fontWeight: '600',
  },
  selectedControlText: {
    color: marketChartTheme.colors.primaryText,
  },
  readout: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 10,
  },
  priceText: {
    flex: 1,
    color: marketChartTheme.colors.primaryText,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  staleText: {
    color: METEORA_COLORS.warning,
    fontSize: 10,
  },
  pressed: {
    opacity: 0.78,
  },
});
