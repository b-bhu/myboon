import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';
import { fetchPhoenixCandles, fetchPhoenixMarket } from '@/features/perps/phoenix.api';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import {
  CHART_RANGES,
  formatMarketPrice,
  formatSignedPercent,
  percentChange,
  sectionFailureTitle,
  type ChartRangeKey,
  type TopicMarketLink,
} from '../feed-mosaic';
import { FeedSectionState } from './feed-section-state';
import { FeedBox } from './ui/FeedBox';

interface TopicMarketSectionProps {
  link: TopicMarketLink;
  active: boolean;
}

interface MarketView {
  price: number | null;
  ranges: Partial<Record<ChartRangeKey, number[]>>;
  fetchedAt: number;
}

/** Price and the candle ranges Phoenix actually returned. Ranges with no series stay hidden. */
export function TopicMarketSection({ link, active }: TopicMarketSectionProps) {
  const [view, setView] = useState<MarketView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<ChartRangeKey>('1D');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const market = await fetchPhoenixMarket(link.symbol);
        const ranges: Partial<Record<ChartRangeKey, number[]>> = {};
        await Promise.all(CHART_RANGES.map(async (request) => {
          try {
            const candles = await fetchPhoenixCandles(link.symbol, request.interval, request.count, { signal: controller.signal });
            const closes = candles.map((candle) => candle.close).filter((close) => Number.isFinite(close));
            if (closes.length >= 2) ranges[request.key] = closes;
          } catch (cause) {
            if (controller.signal.aborted) throw cause;
          }
        }));
        if (controller.signal.aborted) return;
        const lastClose = ranges['1D']?.[ranges['1D'].length - 1] ?? ranges['1W']?.[ranges['1W'].length - 1] ?? null;
        const price = Number.isFinite(market.markPrice ?? NaN) ? market.markPrice : lastClose;
        setView({ price, ranges, fetchedAt: Date.now() });
        setError(null);
        setRange((current) => (ranges[current] ? current : (CHART_RANGES.find((item) => ranges[item.key])?.key ?? '1D')));
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load this market.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [active, attempt, link.symbol]);

  const closes = view?.ranges[range] ?? [];
  const change = percentChange(closes);
  const available = CHART_RANGES.filter((item) => view?.ranges[item.key]);
  const retry = () => setAttempt((value) => value + 1);

  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text accessibilityRole="header" style={styles.heading}>{link.assetName}</Text>
        {view ? <Text style={styles.live}>Updated {new Date(view.fetchedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</Text> : null}
      </View>
      <Text style={styles.note}>{link.note}</Text>
      {loading && !view ? <FeedSectionState title="Loading market…" loading /> : null}
      {error && !view ? (
        <FeedSectionState title={sectionFailureTitle(error, 'Market unavailable')} text="This market could not be loaded." onRetry={retry} />
      ) : null}
      {view && view.price === null && available.length === 0 ? (
        <FeedSectionState title="No price for this market" text="Phoenix did not return a price or a candle series." onRetry={retry} />
      ) : null}
      {view && (view.price !== null || available.length > 0) ? (
        <FeedBox tone="ground" style={styles.card}>
          <View style={styles.assetRow}>
            <View style={styles.assetCopy}>
              <Text style={styles.symbol}>{link.symbol.replace(/-PERP$/, '')}</Text>
              <Text style={styles.assetName}>{link.assetName}</Text>
            </View>
            <View style={styles.priceBlock}>
              {view.price !== null ? <Text style={styles.price}>{formatMarketPrice(view.price)}</Text> : null}
              {change !== null ? (
                <Text style={[styles.change, { color: change > 0 ? FEED_TOKENS.colors.up : change < 0 ? FEED_TOKENS.colors.down : FEED_TOKENS.colors.textDim }]}>
                  {formatSignedPercent(change)}
                </Text>
              ) : null}
            </View>
          </View>
          {available.length > 0 ? (
            <View style={styles.ranges} accessibilityRole="tablist">
              {available.map((item) => {
                const selected = item.key === range;
                return (
                  <Pressable
                    key={item.key}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => setRange(item.key)}
                    style={[styles.range, selected && styles.rangeOn]}
                  >
                    <Text style={[styles.rangeLabel, selected && styles.rangeLabelOn]}>{item.key}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <Text style={styles.notice}>Price history is not available for this market.</Text>
          )}
          {closes.length >= 2 ? <CloseChart closes={closes} /> : null}
          {error ? <Text selectable style={styles.notice}>Refresh failed. Showing the last loaded price.</Text> : null}
        </FeedBox>
      ) : null}
    </View>
  );
}

function CloseChart({ closes }: { closes: number[] }) {
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const width = 328;
  const height = 148;
  const left = 8;
  const right = 320;
  const top = 12;
  const bottom = 132;
  const points = closes.map((value, index) => {
    const x = left + (index / (closes.length - 1)) * (right - left);
    const y = top + (1 - (value - min) / span) * (bottom - top);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const last = closes[closes.length - 1] ?? min;
  const first = closes[0] ?? last;
  const up = last >= first;
  const color = up ? FEED_TOKENS.colors.up : FEED_TOKENS.colors.down;
  const end = points.split(' ').at(-1)?.split(',') ?? [];
  const endX = Number(end[0]);
  const endY = Number(end[1]);
  return (
    <View style={styles.chartRow}>
      <View style={[styles.axisCol, { height }]}>
        <Text style={styles.axis}>{formatMarketPrice(max)}</Text>
        <Text style={styles.axis}>{formatMarketPrice(min)}</Text>
      </View>
      <View style={styles.chartPlot}>
        <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
          <Polyline points={points} fill="none" stroke={color} strokeWidth={1.6} />
          {Number.isFinite(endX) && Number.isFinite(endY) ? <Circle cx={endX} cy={endY} r={3} fill={color} /> : null}
        </Svg>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  head: { minHeight: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  heading: { color: FEED_TOKENS.colors.text, fontSize: FEED_TOKENS.type.section, lineHeight: 24, fontWeight: '700', flexShrink: 1 },
  note: { color: FEED_TOKENS.colors.textDim, fontSize: 13, lineHeight: 18, marginTop: -4 },
  live: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  card: { gap: 12 },
  assetRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  assetCopy: { flex: 1, minWidth: 0 },
  symbol: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
  },
  assetName: { color: FEED_TOKENS.colors.text, fontSize: 15, lineHeight: 20, fontWeight: '600', marginTop: 4 },
  priceBlock: { alignItems: 'flex-end' },
  price: { color: FEED_TOKENS.colors.text, fontFamily: monoFontFamily(), fontSize: 34, lineHeight: 38, fontWeight: '700' },
  change: { fontFamily: monoFontFamily(), fontSize: 14, lineHeight: 20, fontWeight: '600', marginTop: 4 },
  ranges: { flexDirection: 'row', borderWidth: 1, borderColor: FEED_TOKENS.colors.border, borderRadius: 6, padding: 2, gap: 2 },
  range: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  rangeOn: { backgroundColor: FEED_TOKENS.colors.lift },
  rangeLabel: { color: FEED_TOKENS.colors.textDim, fontFamily: monoFontFamily(), fontSize: 11, fontWeight: '600', letterSpacing: 1 },
  rangeLabelOn: { color: FEED_TOKENS.colors.text },
  chartRow: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  chartPlot: { flex: 1, minWidth: 0 },
  axisCol: { width: 52, justifyContent: 'space-between' },
  axis: { color: FEED_TOKENS.colors.textFaint, fontFamily: monoFontFamily(), fontSize: 11 },
  notice: { color: FEED_TOKENS.colors.textDim, fontSize: 13, lineHeight: 18 },
});
