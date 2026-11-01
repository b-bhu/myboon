import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { treemapCaption, upDownCounts } from '../feed-market';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import type { HeatmapToken } from '../token-heatmap.types';
import { useTokenHeatmap } from '../use-token-heatmap';
import { FeedSectionState } from './feed-section-state';
import { FeedBox } from './ui/FeedBox';
import { TokenSheet } from './TokenSheet';
import { TokenTreemap } from './token-treemap';

interface MarketSlideProps {
  active: boolean;
  refreshVersion: number;
}

/** The slide always shows the 24h heatmap, like the mock's home card. */
const SLIDE_INTERVAL = '24h';

/**
 * Market slide (feed-mock.html #s-slides third card, DESIGN.md §7): the
 * 'Market · Solana · 24h' boxed card with a small 168-tall treemap and the
 * gold 'Heatmap →' link into the full Market screen. Tokens come live from
 * the 24h heatmap — size by volume, colour by change; nothing here is mocked.
 */
export function MarketSlide({ active, refreshVersion }: MarketSlideProps) {
  const router = useRouter();
  const section = useTokenHeatmap(SLIDE_INTERVAL, active);
  const previousRefresh = useRef(refreshVersion);
  useEffect(() => {
    if (previousRefresh.current === refreshVersion) return;
    previousRefresh.current = refreshVersion;
    if (active) void section.load();
  }, [active, refreshVersion, section.load]);
  useFocusedAppStateInterval(() => { void section.load(); }, 5 * 60_000, { enabled: active });
  const [sheetToken, setSheetToken] = useState<HeatmapToken | null>(null);

  const data = section.data;
  // Heatmap values beyond 30 minutes are treated as unusable, as on the Market screen.
  const expired = !!data?.fetchedAt && Date.now() - Date.parse(data.fetchedAt) > 30 * 60_000;
  const usable = !!data && data.status !== 'unavailable' && !expired;
  const retryable = data?.error?.retryable !== false;
  const tokens = usable ? data.tokens : [];
  const counts = upDownCounts(tokens);

  return (
    <View>
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
      {usable && tokens.length === 0 ? (
        <FeedSectionState
          title={data.partial ? 'Token values unavailable in this interval' : 'No trading volume in this interval'}
          text="Choose another interval or try again later."
        />
      ) : null}
      {usable && tokens.length > 0 ? (
        <FeedBox tone="ground" style={styles.card}>
          <View style={styles.headerRow}>
            <Text style={styles.monoCaps}>Market · Solana · 24H</Text>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Open Market screen"
              onPress={() => {
                setSheetToken(null);
                router.push('/market');
              }}
              style={styles.linkTouch}
            >
              <Text style={styles.link}>Heatmap →</Text>
            </Pressable>
          </View>
          {section.error ? <Text selectable style={styles.notice}>Refresh failed; showing the last fetched values.</Text> : null}
          {data.stale || data.partial ? (
            <Text selectable style={styles.notice}>
              {data.stale ? 'Showing saved data — live refresh is unavailable.' : 'Partial data — some token values are unavailable.'}
            </Text>
          ) : null}
          <TokenTreemap tokens={tokens} height={168} interval={SLIDE_INTERVAL} onPressToken={setSheetToken} />
          <View style={styles.footer}>
            <Text style={styles.caption}>{treemapCaption(tokens)}</Text>
            <Text style={styles.caption}>{counts.up} up · {counts.down} down</Text>
          </View>
        </FeedBox>
      ) : null}
      <TokenSheet token={sheetToken} interval={SLIDE_INTERVAL} onClose={() => setSheetToken(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  // Mock .card.sl is a 236-tall boxed card; keep at least that much room.
  card: {
    minHeight: 236,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
  },
  monoCaps: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
  linkTouch: {
    minHeight: 44,
    justifyContent: 'center',
  },
  link: {
    color: FEED_TOKENS.colors.accent,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  notice: {
    color: FEED_TOKENS.colors.accent,
    fontSize: FEED_TOKENS.type.caption,
    lineHeight: 17,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: FEED_TOKENS.space.sm,
    marginTop: FEED_TOKENS.space.sm,
  },
  caption: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
});