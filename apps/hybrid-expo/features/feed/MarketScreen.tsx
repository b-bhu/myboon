import { useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import {
  MARKET_CATEGORIES,
  MARKET_INTERVALS,
  changeText,
  filterByCategory,
  formatTokenPrice,
  intervalLabel,
  marketCategoryOptions,
  marketSample,
  movers,
  tableRows,
  treemapCaption,
  upDownCounts,
} from './feed-market';
import type { MarketCategory, MarketInterval, MoverMode } from './feed-market';
import { FEED_TOKENS, monoFontFamily } from './feed-design';
import { formatFeedUsd } from './feed-format';
import { heatmapColor, heatmapTone } from './token-heatmap-layout';
import type { HeatmapToken } from './token-heatmap.types';
import { useTokenHeatmap } from './use-token-heatmap';
import { FeedSectionState } from './components/feed-section-state';
import { SampleDataLabel } from './components/ui/SampleDataLabel';
import { SegmentedTabs } from './components/ui/SegmentedTabs';
import { TokenSheet } from './components/TokenSheet';
import { TokenSparkline } from './components/token-sparkline';
import { TokenTreemap } from './components/token-treemap';

const MOVER_MODES: { key: MoverMode; label: string }[] = [
  { key: 'gainers', label: 'Gainers' },
  { key: 'losers', label: 'Losers' },
  { key: 'volume', label: 'Volume' },
];

/** Rows shown before the 'All N →' expander, as in the mock. */
const TABLE_PREVIEW = 6;

const changeTint = (change: number | null): string => {
  const tone = heatmapTone(change);
  return tone === 'up' ? FEED_TOKENS.colors.up : tone === 'down' ? FEED_TOKENS.colors.down : FEED_TOKENS.colors.textDim;
};

/**
 * Full Market screen (feed-mock.html #s-market, DESIGN.md §7/§9/§10): back
 * bar, 24H/1H interval, the four sample category tabs while mocks are on,
 * gainers/losers/volume mover chips, a short treemap with its caption and the
 * boxed token table. Movers, treemap and table always come from the live
 * heatmap data; only categories, sparklines and the token sheet's news card
 * are sample-gated.
 */
export default function MarketScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [interval, setInterval] = useState<MarketInterval>('24h');
  const [category, setCategory] = useState<MarketCategory>('trending');
  const [moverMode, setMoverMode] = useState<MoverMode>('gainers');
  const [showAll, setShowAll] = useState(false);
  const [sheetToken, setSheetToken] = useState<HeatmapToken | null>(null);
  const section = useTokenHeatmap(interval);
  useFocusedAppStateInterval(() => { void section.load(); }, 5 * 60_000, { resetKey: interval });
  // A new interval starts collapsed again.
  useEffect(() => { setShowAll(false); }, [interval]);

  const mocks = marketSample();
  const data = section.data;
  const expired = !!data?.fetchedAt && Date.now() - Date.parse(data.fetchedAt) > 30 * 60_000;
  const usable = !!data && data.status !== 'unavailable' && !expired;
  const retryable = data?.error?.retryable !== false;
  const allTokens = usable ? data.tokens : [];
  // Without mocks the category filter never runs; the table shows every token.
  const tokens = mocks !== null ? filterByCategory(allTokens, category) : allTokens;
  const chipTokens = movers(tokens, moverMode);
  const counts = upDownCounts(tokens);
  const rows = tableRows(tokens);
  const visibleRows = showAll ? rows : rows.slice(0, TABLE_PREVIEW);
  const categoryEmpty = mocks !== null && category !== 'trending' && allTokens.length > 0 && tokens.length === 0;

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.barLabel}>Market</Text>
        <View style={styles.barSpacer} />
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={section.loading}
            onRefresh={() => { void section.load(); }}
            tintColor={FEED_TOKENS.colors.accent}
            colors={[FEED_TOKENS.colors.accent]}
          />
        }
      >
        {section.loading && !data ? <FeedSectionState title="Loading token market…" loading /> : null}
        {section.error && !data ? (
          <FeedSectionState title="Market refresh failed" text="Token market data could not be loaded." onRetry={() => { void section.load(); }} />
        ) : null}
        {data && !usable && !section.error ? (
          <FeedSectionState
            title="Token market unavailable"
            text={expired ? 'Saved token values have expired.' : 'Token market data is not available right now.'}
            onRetry={retryable ? () => { void section.load(); } : undefined}
          />
        ) : null}
        {section.error && usable ? <Text selectable style={styles.notice}>Refresh failed; showing the last fetched values.</Text> : null}
        {usable && (data.stale || data.partial) ? (
          <Text selectable style={styles.notice}>
            {data.stale ? 'Showing saved data — live refresh is unavailable.' : 'Partial data — some token values are unavailable.'}
          </Text>
        ) : null}
        {usable && allTokens.length > 0 ? (
          <>
            <SegmentedTabs
              options={MARKET_INTERVALS.map((value) => ({ key: value, label: intervalLabel(value) }))}
              value={interval}
              onChange={(key) => setInterval(key as MarketInterval)}
            />
            {mocks !== null ? (
              <View style={styles.categories}>
                <SampleDataLabel />
                <SegmentedTabs options={marketCategoryOptions()} value={category} onChange={(key) => setCategory(key as MarketCategory)} />
              </View>
            ) : null}
            <SegmentedTabs options={MOVER_MODES} value={moverMode} onChange={(key) => setMoverMode(key as MoverMode)} />
            {chipTokens.length > 0 ? (
              <View style={styles.chips}>
                {chipTokens.map((token) => (
                  <Pressable
                    key={token.address}
                    accessibilityRole="button"
                    accessibilityLabel={`${token.symbol} ${interval} change ${changeText(token.priceChangePct)}, price ${formatTokenPrice(token.priceUsd)}`}
                    onPress={() => setSheetToken(token)}
                    style={({ pressed }) => [styles.chip, { backgroundColor: chipTint(token.priceChangePct) }, pressed && styles.pressed]}
                  >
                    <Text style={styles.chipSymbol} numberOfLines={1}>{token.symbol}</Text>
                    <Text style={styles.chipChange}>{changeText(token.priceChangePct)}</Text>
                    <Text style={styles.chipPrice}>{formatTokenPrice(token.priceUsd)}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View style={styles.captionRow}>
              <Text selectable style={styles.caption}>{treemapCaption(tokens)}</Text>
              <Text selectable style={styles.caption}>{counts.up} up · {counts.down} down</Text>
            </View>
            <TokenTreemap tokens={tokens} height={220} interval={interval} onPressToken={setSheetToken} />
            {rows.length > 0 ? (
              <View style={styles.table}>
                <View style={styles.headerRow}>
                  <Text style={styles.headLeft}>Token · price</Text>
                  <Text style={styles.headRight}>{interval} · vol</Text>
                </View>
                {visibleRows.map((token) => (
                  <Pressable
                    key={token.address}
                    accessibilityRole="button"
                    accessibilityLabel={`${token.name} ${token.symbol}, price ${formatTokenPrice(token.priceUsd)}, ${interval} change ${changeText(token.priceChangePct)}, volume ${formatFeedUsd(token.volumeUsd, true)}`}
                    onPress={() => setSheetToken(token)}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  >
                    <View style={styles.letterTile} accessibilityElementsHidden>
                      <Text style={styles.letter}>{token.symbol.charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={styles.identity}>
                      <Text style={styles.name} numberOfLines={1}>
                        {token.name} <Text style={styles.symbol}>${token.symbol}</Text>
                      </Text>
                      <Text style={styles.price}>{formatTokenPrice(token.priceUsd)}</Text>
                    </View>
                    {mocks !== null ? <TokenSparkline address={token.address} change={token.priceChangePct} /> : null}
                    <View style={styles.rowRight}>
                      <Text style={[styles.rowChange, { color: changeTint(token.priceChangePct) }]}>{changeText(token.priceChangePct)}</Text>
                      <Text style={styles.rowVolume}>{formatFeedUsd(token.volumeUsd, true)}</Text>
                    </View>
                  </Pressable>
                ))}
                {!showAll && rows.length > TABLE_PREVIEW ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Show all ${rows.length} tokens`}
                    onPress={() => setShowAll(true)}
                    style={({ pressed }) => [styles.allRow, pressed && styles.pressed]}
                  >
                    <Text style={styles.allLabel}>All {rows.length} →</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </>
        ) : null}
        {usable && allTokens.length === 0 ? (
          <FeedSectionState
            title={data.partial ? 'Token values unavailable in this interval' : 'No trading volume in this interval'}
            text="Choose another interval or try again later."
          />
        ) : null}
        {usable && categoryEmpty ? (
          <FeedSectionState title="No tokens in this category" text="Try another category or interval." />
        ) : null}
      </ScrollView>
      <TokenSheet token={sheetToken} interval={interval} onClose={() => setSheetToken(null)} />
    </View>
  );
}

/* Chip fill follows the heatmap colour scale, so chips agree with the tiles. */
const chipTint = (change: number | null): string => heatmapColor(change);

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: FEED_TOKENS.colors.screen,
  },
  bar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: FEED_TOKENS.space.lg,
  },
  backButton: {
    minHeight: 44,
    width: 32,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  backGlyph: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.title,
  },
  barLabel: {
    color: FEED_TOKENS.colors.text,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  barSpacer: {
    width: 32,
  },
  pressed: {
    opacity: 0.76,
  },
  content: {
    paddingTop: FEED_TOKENS.space.xs,
    paddingBottom: FEED_TOKENS.space.xl,
    paddingHorizontal: FEED_TOKENS.space.lg,
    gap: FEED_TOKENS.space.md,
  },
  notice: {
    color: FEED_TOKENS.colors.accent,
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 17,
  },
  categories: {
    gap: FEED_TOKENS.space.sm,
  },
  chips: {
    flexDirection: 'row',
    gap: FEED_TOKENS.space.sm,
  },
  chip: {
    flex: 1,
    minHeight: 64,
    borderRadius: FEED_TOKENS.radius.card,
    padding: FEED_TOKENS.space.md,
    gap: 2,
    justifyContent: 'center',
  },
  chipSymbol: {
    color: '#FFFFFF',
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  chipChange: {
    color: '#FFFFFF',
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.body,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  chipPrice: {
    color: '#FFFFFF',
    opacity: 0.85,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
    fontVariant: ['tabular-nums'],
  },
  captionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
  },
  caption: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  // One bordered box for the whole table; hairline rows like #s-wallets.
  table: {
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: FEED_TOKENS.radius.card,
    backgroundColor: FEED_TOKENS.colors.card,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
    paddingHorizontal: FEED_TOKENS.space.md,
    paddingVertical: FEED_TOKENS.space.sm,
  },
  headLeft: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  headRight: {
    color: FEED_TOKENS.colors.textFaint,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
    textAlign: 'right',
  },
  row: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: FEED_TOKENS.space.md,
    borderTopWidth: 0.5,
    borderTopColor: FEED_TOKENS.colors.border,
    paddingHorizontal: FEED_TOKENS.space.md,
    paddingVertical: FEED_TOKENS.space.sm,
  },
  letterTile: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: 14,
  },
  letter: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
    fontWeight: '700',
  },
  identity: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  name: {
    color: FEED_TOKENS.colors.text,
    fontSize: FEED_TOKENS.type.secondary,
    fontWeight: '600',
  },
  symbol: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
  },
  price: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 17,
    fontVariant: ['tabular-nums'],
  },
  rowRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  rowChange: {
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  rowVolume: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.caption,
    fontVariant: ['tabular-nums'],
  },
  allRow: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: 0.5,
    borderTopColor: FEED_TOKENS.colors.border,
  },
  allLabel: {
    color: FEED_TOKENS.colors.accent,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.secondary,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});