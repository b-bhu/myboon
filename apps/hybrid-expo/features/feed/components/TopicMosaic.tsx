import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useRouter } from 'expo-router';
import { fetchPhoenixCandles, fetchPhoenixMarkets } from '@/features/perps/phoenix.api';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import { storyAge, storyCountLabel, storyHref } from '../feed-stories';
import {
  formatSignedPercent,
  mosaicPages,
  percentChange,
  rankStories,
  topicMarket,
  type MosaicTileKind,
} from '../feed-mosaic';
import { useReducedMotion } from '../use-reduced-motion';
import type { StorySummary } from '../feed.types';

const PEEK = 28;
const GAP = 8;

interface TopicMosaicProps {
  stories: StorySummary[];
  now: Date;
}

interface TileQuote {
  change: number | null;
  closes: number[];
}

export function TopicMosaic({ stories, now }: TopicMosaicProps) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const pages = mosaicPages(rankStories(stories));
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const [quotes, setQuotes] = useState<Record<string, TileQuote>>({});
  const x = useSharedValue(0);
  const resting = useSharedValue(0);
  const widthSv = useSharedValue(0);
  const countSv = useSharedValue(pages.length);
  const reducedSv = useSharedValue(reduced ? 1 : 0);
  const current = Math.min(page, Math.max(0, pages.length - 1));
  const leadKey = pages.flatMap((group) => group.placements.flatMap((placement) => {
    if (placement.kind !== 'large' && placement.kind !== 'tall') return [];
    const story = group.items[placement.index];
    const link = story ? topicMarket(story.storySlug, story.name) : null;
    return link && story ? [`${story.storySlug}:${link.symbol}`] : [];
  })).join('|');

  const goTo = (next: number) => {
    const clamped = Math.max(0, Math.min(pages.length - 1, next));
    const destination = pageOffset(clamped, width, pages.length);
    resting.value = destination;
    x.value = withTiming(destination, { duration: reduced ? 0 : 280 });
    setPage(clamped);
  };

  const pageRef = useRef(current);
  pageRef.current = current;

  useEffect(() => { countSv.value = pages.length; }, [countSv, pages.length]);
  useEffect(() => { reducedSv.value = reduced ? 1 : 0; }, [reduced, reducedSv]);
  useEffect(() => {
    const next = pageOffset(pageRef.current, width, pages.length);
    resting.value = next;
    x.value = next;
  }, [pages.length, resting, width, x]);

  useEffect(() => {
    const leads = leadKey.split('|').flatMap((entry) => {
      const [slug, symbol] = entry.split(':');
      return slug && symbol ? [{ slug, symbol }] : [];
    });
    if (!leads.length) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const markets = await fetchPhoenixMarkets();
        if (controller.signal.aborted) return;
        const next: Record<string, TileQuote> = {};
        await Promise.all(leads.map(async (lead) => {
          const market = markets.find((item) => item.venueSymbol === lead.symbol || item.symbol === lead.symbol);
          let closes: number[] = [];
          try {
            const candles = await fetchPhoenixCandles(lead.symbol, '1h', 24, { signal: controller.signal });
            closes = candles.map((candle) => candle.close).filter((close) => Number.isFinite(close));
          } catch {
            closes = [];
          }
          const fromCloses = percentChange(closes);
          next[lead.slug] = {
            change: fromCloses ?? (typeof market?.change24h === 'number' && Number.isFinite(market.change24h) ? market.change24h : null),
            closes: closes.length >= 2 ? closes : [],
          };
        }));
        if (!controller.signal.aborted) setQuotes(next);
      } catch {
        if (!controller.signal.aborted) setQuotes({});
      }
    })();
    return () => controller.abort();
  }, [leadKey]);

  const pan = Gesture.Pan()
    .activeOffsetX([-16, 16])
    .failOffsetY([-18, 18])
    .onUpdate((event) => {
      x.value = resting.value + event.translationX;
    })
    .onEnd((event) => {
      const count = countSv.value;
      const pageWidth = Math.max(1, widthSv.value - PEEK);
      let next = currentPage(resting.value, widthSv.value, count);
      if (event.translationX <= -pageWidth * 0.18 || event.velocityX < -700) next = Math.min(count - 1, next + 1);
      if (event.translationX >= pageWidth * 0.18 || event.velocityX > 700) next = Math.max(0, next - 1);
      runOnJS(goTo)(next);
    });

  const trackStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const narrow = Math.max(0, width - PEEK);

  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text accessibilityRole="header" style={styles.heading}>Developing story</Text>
        <MosaicDots page={current} count={pages.length} />
      </View>
      <GestureDetector gesture={pan}>
        <View
          style={styles.pager}
          accessibilityRole="adjustable"
          accessibilityLabel="Developing topics"
          accessibilityValue={{ text: `Page ${current + 1} of ${pages.length}` }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'increment') goTo(current + 1);
            if (event.nativeEvent.actionName === 'decrement') goTo(current - 1);
          }}
          onLayout={(event) => {
            const next = event.nativeEvent.layout.width;
            if (next > 0) {
              setWidth(next);
              widthSv.value = next;
            }
          }}
        >
          {width > 0 ? (
            <Animated.View style={[styles.track, trackStyle]}>
              {pages.map((group, index) => (
                <View
                  key={group.items.map((item) => item.storySlug).join('|') || String(index)}
                  style={[styles.page, { width: index < pages.length - 1 ? narrow : width, marginRight: index < pages.length - 1 ? GAP : 0 }]}
                  accessibilityLabel={`Topic page ${index + 1} of ${pages.length}`}
                >
                  {group.placements.map((placement) => {
                    const story = group.items[placement.index];
                    if (!story) return null;
                    const link = topicMarket(story.storySlug);
                    const quote = link ? quotes[story.storySlug] : undefined;
                    return (
                      <TopicTile
                        key={story.storySlug}
                        pan={pan}
                        reduced={reduced}
                        story={story}
                        kind={placement.kind}
                        now={now}
                        change={quote?.change ?? null}
                        closes={quote?.closes ?? []}
                        marketLabel={link?.assetName ?? null}
                        showExcerpt={stories.length <= 4}
                        frame={placement}
                        onPress={() => router.push(storyHref(story.storySlug))}
                      />
                    );
                  })}
                </View>
              ))}
            </Animated.View>
          ) : null}
        </View>
      </GestureDetector>
    </View>
  );
}

export function MosaicDots({ page, count }: { page: number; count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.dots} accessibilityLabel={`Page ${page + 1} of ${count}`}>
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={[styles.dot, index === page && styles.dotOn]} />
      ))}
    </View>
  );
}

function TopicTile({
  pan,
  reduced,
  story,
  kind,
  now,
  change,
  closes,
  marketLabel,
  showExcerpt,
  frame,
  onPress,
}: {
  pan: GestureType;
  reduced: boolean;
  story: StorySummary;
  kind: MosaicTileKind;
  now: Date;
  change: number | null;
  closes: number[];
  marketLabel: string | null;
  showExcerpt: boolean;
  frame: { col: number; row: number; colSpan: number; rowSpan: number };
  onPress: () => void;
}) {
  const lead = kind === 'large' || kind === 'tall';
  const age = storyAge(story.updatedAt, now).replace(' ago', '');
  const meta = kind === 'slim' ? age : storyCountLabel(story.eventCount);
  const direction = change === null || change === 0 ? null : change > 0 ? 'up' : 'down';
  const quote = marketLabel && change !== null ? `${marketLabel} ${formatSignedPercent(change)}` : '';
  const pressed = useSharedValue(0);
  const reduceMotion = useSharedValue(reduced ? 1 : 0);
  useEffect(() => { reduceMotion.value = reduced ? 1 : 0; }, [reduceMotion, reduced]);
  const pressedStyle = useAnimatedStyle(() => ({
    opacity: pressed.value ? 0.72 : 1,
    transform: [{ scale: reduceMotion.value ? 1 : 1 - pressed.value * 0.02 }],
  }));
  const tap = Gesture.Tap()
    .maxDistance(18)
    .requireExternalGestureToFail(pan)
    .onBegin(() => {
      pressed.value = 1;
    })
    .onFinalize(() => {
      pressed.value = 0;
    })
    .onEnd(() => {
      runOnJS(onPress)();
    });
  return (
    <View
      style={[
        styles.tileFrame,
        {
          left: `${(frame.col / 6) * 100}%`,
          top: `${(frame.row / 4) * 100}%`,
          width: `${(frame.colSpan / 6) * 100}%`,
          height: `${(frame.rowSpan / 4) * 100}%`,
        },
      ]}
    >
      <GestureDetector gesture={tap}>
        <Animated.View
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${story.name}, ${storyCountLabel(story.eventCount)}${quote ? `, ${quote}` : ''}`}
          onAccessibilityTap={onPress}
          style={[styles.tile, lead && styles.tileLead, pressedStyle]}
        >
          <Text style={[styles.name, lead && styles.nameLead, kind === 'slim' && styles.nameSlim]} numberOfLines={lead ? 3 : 2}>
            {story.name}
          </Text>
          {showExcerpt && lead ? <Text style={styles.excerpt} numberOfLines={4}>{story.latestDevelopment}</Text> : null}
          {lead && marketLabel && change !== null ? (
            <View style={styles.market}>
              {closes.length >= 2 ? <LeadSpark closes={closes} /> : null}
              <Text style={styles.marketLabel} numberOfLines={1}>
                {marketLabel} <Text style={{ color: change > 0 ? FEED_TOKENS.colors.up : FEED_TOKENS.colors.down }}>{formatSignedPercent(change)}</Text>
              </Text>
            </View>
          ) : null}
          {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
          {direction ? (
            <Text style={[styles.direction, { color: direction === 'up' ? FEED_TOKENS.colors.up : FEED_TOKENS.colors.down }]}>
              {direction === 'up' ? '↑' : '↓'}
            </Text>
          ) : null}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

function LeadSpark({ closes }: { closes: number[] }) {
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const last = closes[closes.length - 1] ?? min;
  const first = closes[0] ?? last;
  const up = last >= first;
  const path = closes.map((value, index) => {
    const x = (index / (closes.length - 1)) * 120;
    const y = 2 + (1 - (value - min) / span) * 24;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  return (
    <Svg width="100%" height={28} viewBox="0 0 120 28">
      <Path d={path} stroke={up ? FEED_TOKENS.colors.up : FEED_TOKENS.colors.down} strokeWidth={1.6} fill="none" />
    </Svg>
  );
}

function pageOffset(index: number, width: number, count: number): number {
  'worklet';
  if (width <= 0 || count <= 1) return 0;
  const stride = Math.max(0, width - PEEK) + GAP;
  return -Math.max(0, Math.min(count - 1, index)) * stride;
}

function currentPage(offset: number, width: number, count: number): number {
  'worklet';
  if (width <= 0 || count <= 1) return 0;
  const stride = Math.max(1, width - PEEK + GAP);
  return Math.max(0, Math.min(count - 1, Math.round(-offset / stride)));
}

const styles = StyleSheet.create({
  section: { flex: 1, height: '100%', minHeight: 0 },
  head: { minHeight: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  heading: { color: FEED_TOKENS.colors.text, fontSize: FEED_TOKENS.type.section, lineHeight: 24, fontWeight: '700' },
  pager: { flex: 1, minHeight: 0, overflow: 'hidden' },
  track: { flexDirection: 'row', height: '100%' },
  page: { height: '100%', position: 'relative' },
  tileFrame: { position: 'absolute', padding: 2 },
  tile: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderColor: FEED_TOKENS.colors.border,
    borderRadius: 6,
    backgroundColor: FEED_TOKENS.colors.card,
    padding: 8,
    overflow: 'hidden',
    justifyContent: 'space-between',
  },
  tileLead: { backgroundColor: FEED_TOKENS.colors.ground },
  name: { color: FEED_TOKENS.colors.text, fontSize: FEED_TOKENS.type.secondary, lineHeight: 18, fontWeight: '600', paddingRight: 14 },
  nameLead: { fontSize: FEED_TOKENS.type.cardTitle, lineHeight: 22, fontWeight: '700' },
  nameSlim: { fontSize: FEED_TOKENS.type.caption, lineHeight: 16, paddingRight: 12 },
  excerpt: { color: FEED_TOKENS.colors.textDim, fontSize: FEED_TOKENS.type.secondary, lineHeight: 18, marginTop: 8 },
  market: { marginTop: 'auto', marginBottom: 8, gap: 4 },
  marketLabel: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    lineHeight: 14,
  },
  meta: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    lineHeight: 14,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  direction: { position: 'absolute', top: 6, right: 8, fontSize: FEED_TOKENS.type.secondary, fontWeight: '700' },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 8, height: 4, backgroundColor: FEED_TOKENS.colors.textFaint },
  dotOn: { width: 16, backgroundColor: FEED_TOKENS.colors.accent },
});
