import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MarketChart } from '@/features/charts';
import type { MarketCandle, StoryMarket } from '@myboon/shared/stories';
import type { StorySummary } from '../feed.types';
import { formatMarketPrice, formatSignedPercent, pickDetailMarket } from '../feed-mosaic';
import { fetchStoryMarketCandles } from '../stories.api';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import { FeedBox } from './ui/FeedBox';

interface CandleLoad {
  candles: MarketCandle[] | null;
  failed: boolean;
  loading: boolean;
}

/**
 * The story details price section (issue #684): tabs for the story's linked
 * markets, the selected market's price and 24h move, then a 24-hour line
 * chart fed by `GET /market/hyperliquid/candles`. There is no range selector
 * and no trade action of its own — the trade button pinned to the bottom of
 * the story screen keeps its separate slug-matched route.
 */
export function StoryMarketsSection({
  story,
  marketParam,
}: {
  story: StorySummary;
  marketParam: string | string[] | undefined;
}) {
  const markets = story.markets;
  const param = Array.isArray(marketParam) ? marketParam[0] : marketParam;
  const [market, setMarket] = useState<StoryMarket>(
    () => pickDetailMarket(markets, param) ?? markets[0],
  );
  const [load, setLoad] = useState<CandleLoad>({ candles: null, failed: false, loading: true });
  const hasPrice = market.price !== null;

  // One request per selected market; switching tabs aborts the previous load.
  // A market with no live price never requests candles — its price and move
  // are hidden and "Price unavailable" stands in for the chart.
  useEffect(() => {
    if (!hasPrice) {
      setLoad({ candles: null, failed: false, loading: false });
      return undefined;
    }
    const controller = new AbortController();
    setLoad({ candles: null, failed: false, loading: true });
    void (async () => {
      try {
        const candles = await fetchStoryMarketCandles(market.symbol, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setLoad({ candles, failed: false, loading: false });
      } catch {
        if (!controller.signal.aborted) setLoad({ candles: null, failed: true, loading: false });
      }
    })();
    return () => controller.abort();
  }, [hasPrice, market.symbol]);

  const change = market.change24hPct;
  const series = load.candles ?? [];
  // The chart and the "Price unavailable" text never coexist: the chart only
  // renders for a market with a live price and at least two candles.
  const chartable = hasPrice && load.candles !== null && series.length >= 2;
  const unavailable = !hasPrice || load.failed || (!load.loading && !chartable);
  const chart = {
    mode: 'line' as const,
    layers: { volume: false, currentPrice: false },
    initialVisibleCandles: 24,
    minimumVisibleCandles: 24,
    formatPrice: formatMarketPrice,
    formatTime: formatLocalClockTime,
    accessibilityLabel: `${market.displayName}, last 24 hours`,
  };

  return (
    <View style={styles.section}>
      {markets.length > 1 ? (
        <View style={styles.tabs} accessibilityRole="tablist">
          {markets.map((item) => {
            const selected = item.symbol === market.symbol;
            return (
              <Pressable
                key={item.symbol}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => setMarket(item)}
                style={[styles.tab, selected && styles.tabOn]}
              >
                <Text style={[styles.tabLabel, selected && styles.tabLabelOn]} numberOfLines={1}>{item.displaySymbol}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <FeedBox tone="ground" style={styles.card}>
        <Text accessibilityRole="header" style={styles.name} numberOfLines={1}>{market.displayName}</Text>
        {market.price !== null ? (
          <View accessible style={styles.priceRow}>
            <Text style={styles.price}>{formatMarketPrice(market.price)}</Text>
            {change !== null ? (
              <Text style={[styles.change, { color: moveColour(change) }]}>{formatSignedPercent(change)}</Text>
            ) : null}
          </View>
        ) : null}
        {hasPrice && load.loading ? (
          <MarketChart seriesKey={`${market.symbol}:1h`} candles={[]} status={{ kind: 'loading' }} {...chart} />
        ) : null}
        {chartable ? (
          <MarketChart seriesKey={`${market.symbol}:1h`} candles={series} {...chart} />
        ) : null}
        {unavailable ? <Text selectable style={styles.unavailable}>Price unavailable</Text> : null}
      </FeedBox>
    </View>
  );
}

/** The details move shares the tile's meaning colours; a quiet move is dim. */
function moveColour(change: number): string {
  if (change > 0) return FEED_TOKENS.colors.up;
  if (change < 0) return FEED_TOKENS.colors.down;
  return FEED_TOKENS.colors.textDim;
}

/** Local 24-hour clock, e.g. 14:52. */
function formatLocalClockTime(timeMs: number): string {
  return new Date(timeMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  tabs: { flexDirection: 'row', borderWidth: 1, borderColor: FEED_TOKENS.colors.border, borderRadius: 6, padding: 2, gap: 2 },
  tab: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 4, paddingHorizontal: 8 },
  tabOn: { backgroundColor: FEED_TOKENS.colors.lift },
  tabLabel: { color: FEED_TOKENS.colors.textDim, fontFamily: monoFontFamily(), fontSize: 11, fontWeight: '600', letterSpacing: 1 },
  tabLabelOn: { color: FEED_TOKENS.colors.text },
  card: { gap: 10 },
  name: { color: FEED_TOKENS.colors.text, fontSize: FEED_TOKENS.type.secondary, lineHeight: 20, fontWeight: '700' },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  price: { color: FEED_TOKENS.colors.text, fontFamily: monoFontFamily(), fontSize: 34, lineHeight: 38, fontWeight: '700' },
  change: { fontFamily: monoFontFamily(), fontSize: 14, lineHeight: 20, fontWeight: '600' },
  unavailable: { color: FEED_TOKENS.colors.textDim, fontSize: 13, lineHeight: 18 },
});
