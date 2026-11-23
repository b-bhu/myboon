import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useRouter } from 'expo-router';
import { fetchStoryMarketCandles } from '../stories.api';
import { FEED_TOKENS, monoFontFamily } from '../feed-design';
import { storyAge, storyCountLabel, storyHref } from '../feed-stories';
import {
  formatTileMove,
  heldMarket,
  mosaicPages,
  pageSparkSymbols,
  PAGE_SLOTS,
  shownMarket,
  tileShowsArrow,
  type MosaicTileKind,
  type TileMove,
} from '../feed-mosaic';
import { useReducedMotion } from '../use-reduced-motion';
import type { StoryMarket } from '@myboon/shared/stories';
import type { StorySummary } from '../feed.types';

const PEEK = 28;
const GAP = 8;
/** One shared interval drives every tile's market rotation. */
const ROTATE_MS = 4000;
/** Crossfade of the market slot when the tile switches market. */
const SLOT_FADE_MS = 250;

/**
 * Reserved width for a slim tile's move (#711): six mono glyphs ('-10.6%',
 * '-9.42%') measure 39.75px at 11px, so 42 keeps every one-decimal move whole
 * inside the tile's padding room at a 360-wide phone.
 */
const SLIM_MOVE_MIN_WIDTH = 42;

interface TopicMosaicProps {
  stories: StorySummary[];
  now: Date;
}

export function TopicMosaic({ stories, now }: TopicMosaicProps) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const pages = mosaicPages(stories);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const [tick, setTick] = useState(0);
  const [sparks, setSparks] = useState<Record<string, number[]>>({});
  const x = useSharedValue(0);
  const resting = useSharedValue(0);
  const widthSv = useSharedValue(0);
  const countSv = useSharedValue(pages.length);
  const current = Math.min(page, Math.max(0, pages.length - 1));

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
  // Unchanged from main: when the page count or the width changes (a refresh
  // adding stories, a rotation or resize), the strip must re-snap to the
  // current page's offset instead of staying at a stale one.
  useEffect(() => {
    const next = pageOffset(pageRef.current, width, pages.length);
    resting.value = next;
    x.value = next;
  }, [pages.length, resting, width, x]);
  // Without reduce motion every priced market gets its 4 seconds; with it,
  // the tiles stay parked on each story's rank-1 market.
  useEffect(() => {
    if (reduced) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), ROTATE_MS);
    return () => clearInterval(timer);
  }, [reduced]);

  // Sparkline candles to prefetch (#798): every priced market on the current
  // mosaic page's lead tiles, so a rotation tick finds its next market's
  // sparkline already loaded instead of fading the slot in bare. The target
  // set follows the page and the stories, never the rotation tick.
  const sparkKey = pageSparkSymbols(pages, current).join('|');
  const sparksRef = useRef(sparks);
  sparksRef.current = sparks;
  const sparkReady = (symbol: string) => symbol in sparksRef.current;

  useEffect(() => {
    const symbols = sparkKey.split('|').filter(Boolean);
    const missing = symbols.filter((symbol) => !(symbol in sparksRef.current));
    if (!missing.length) return undefined;
    const controller = new AbortController();
    void (async () => {
      await Promise.all(missing.map(async (symbol) => {
        let closes: number[] = [];
        try {
          const candles = await fetchStoryMarketCandles(symbol, { signal: controller.signal });
          closes = candles.map((candle) => candle.close).filter((close) => Number.isFinite(close));
        } catch {
          closes = [];
        }
        if (controller.signal.aborted) return;
        const cached = closes.length >= 2 ? closes : [];
        sparksRef.current = { ...sparksRef.current, [symbol]: cached };
        setSparks(sparksRef.current);
      }));
    })();
    return () => controller.abort();
  }, [sparkKey]);

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
        <Text accessibilityRole="header" style={styles.heading}>Developing stories</Text>
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
                    // A lead slot only swaps in once its next market's candles
                    // exist (#798): heldMarket holds the previous sparkline
                    // during a rotation whose next market has not loaded yet.
                    // Wide and slim tiles paint no sparkline, so they keep the
                    // free rotation.
                    const lead = placement.kind === 'large' || placement.kind === 'tall';
                    const shown = lead
                      ? heldMarket(story, tick, reduced, sparkReady)
                      : shownMarket(story, tick, reduced);
                    return (
                      <TopicTile
                        key={story.storySlug}
                        pan={pan}
                        reduced={reduced}
                        story={story}
                        kind={placement.kind}
                        now={now}
                        shown={shown}
                        closes={shown ? sparks[shown.symbol] ?? [] : []}
                        showExcerpt={stories.length <= 4}
                        frame={placement}
                        onPress={() => router.push(storyHref(story.storySlug, shown?.symbol ?? null))}
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

/**
 * Loading state for the mosaic slot (#797): the heading row with a page-1 dot
 * plus the real page-1 tile frames, empty, so nothing jumps when the first
 * stories land.
 */
export function TopicMosaicSkeleton() {
  return (
    <View style={styles.section} accessibilityLabel="Loading developing stories">
      <View style={styles.head}>
        <Text accessibilityRole="header" style={styles.heading}>Developing stories</Text>
        <View style={styles.dots}>
          <View style={[styles.dot, styles.dotOn]} />
          <View style={styles.dot} />
          <View style={styles.dot} />
        </View>
      </View>
      <View style={styles.pager}>
        <View style={[styles.page, { width: '100%' }]}>
          {PAGE_SLOTS.map((slot, index) => (
            <View
              key={index}
              style={[
                styles.tileFrame,
                {
                  left: `${(slot.col / 6) * 100}%`,
                  top: `${(slot.row / 4) * 100}%`,
                  width: `${(slot.colSpan / 6) * 100}%`,
                  height: `${(slot.rowSpan / 4) * 100}%`,
                },
              ]}
            >
              <View style={[styles.tile, (slot.kind === 'large' || slot.kind === 'tall') && styles.tileLead]} />
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function TopicTile({
  pan,
  reduced,
  story,
  kind,
  now,
  shown,
  closes,
  showExcerpt,
  frame,
  onPress,
}: {
  pan: GestureType;
  reduced: boolean;
  story: StorySummary;
  kind: MosaicTileKind;
  now: Date;
  shown: StoryMarket | null;
  closes: number[];
  showExcerpt: boolean;
  frame: { col: number; row: number; colSpan: number; rowSpan: number };
  onPress: () => void;
}) {
  const lead = kind === 'large' || kind === 'tall';
  const count = storyCountLabel(story.eventCount);
  const age = storyAge(story.updatedAt, now).replace(' ago', '');
  const move = shown && shown.change24hPct !== null ? formatTileMove(shown.change24hPct) : null;
  const arrow = move && move.tone !== 'dim' ? move.tone : null;
  // Slim tiles show the direction through the move's sign and colour: their
  // corner space is claimed by the title (360×640 check, #711).
  const showArrow = tileShowsArrow(move, kind);

  // The market slot (label, sparkline, move, arrow) crossfades on rotation;
  // title, count and size never move.
  const slot = shown?.symbol ?? null;
  const fade = useSharedValue(1);
  const slotRef = useRef(slot);
  useEffect(() => {
    if (slotRef.current === slot) return;
    slotRef.current = slot;
    if (reduced || slot === null) return;
    fade.value = 0;
    fade.value = withTiming(1, { duration: SLOT_FADE_MS });
  }, [fade, reduced, slot]);
  const slotStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

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
  const quote = shown && move ? `${shown.displayName} ${move.text}` : null;
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
          accessibilityLabel={`${story.name}, ${count}${quote ? `, ${quote}` : ''}`}
          onAccessibilityTap={onPress}
          style={[styles.tile, lead && styles.tileLead, kind === 'slim' && styles.tileSlim, pressedStyle]}
        >
          <Text
            style={[styles.name, lead && styles.nameLead, kind === 'slim' && styles.nameSlim]}
            numberOfLines={kind === 'slim' ? 1 : lead ? 3 : 2}
            // Word-boundary wrapping only; a title that cannot fit ends in an ellipsis.
            textBreakStrategy="simple"
          >
            {story.name}
          </Text>
          {showExcerpt && lead ? <Text style={styles.excerpt} numberOfLines={4}>{story.latestDevelopment}</Text> : null}
          {lead && shown ? (
            <Animated.View style={[styles.market, slotStyle]}>
              {closes.length >= 2 ? <LeadSpark closes={closes} /> : null}
              <Text style={styles.marketLabel} numberOfLines={1}>
                {shown.displaySymbol} <Text style={[styles.moveText, tileMoveColour(move)]}>{move?.text}</Text>
              </Text>
            </Animated.View>
          ) : null}
          {!lead && shown ? (
            <Animated.View style={[styles.moveRow, slotStyle]}>
              {kind === 'wide' ? (
                <Text style={styles.moveLabel} numberOfLines={1}>
                  {shown.displaySymbol} <Text style={[styles.moveText, tileMoveColour(move)]}>{move?.text}</Text>
                </Text>
              ) : (
                // Slim: one un-nested text in the move's own colour inside a
                // reserved minimum width — shrink-to-fit never fired on web
                // and a 1px overflow ellipsized '-9.7%' to '-9. …' (#711).
                <Text
                  style={[styles.moveLabel, styles.moveLabelSlim, tileMoveColour(move)]}
                  numberOfLines={1}
                >
                  {move?.text}
                </Text>
              )}
            </Animated.View>
          ) : null}
          {lead || !shown ? <Text style={styles.meta} numberOfLines={1}>{kind === 'slim' ? age : count}</Text> : null}
          {showArrow ? (
            <Animated.Text style={[styles.direction, slotStyle, { color: tileMoveColour(move)?.color }]}>
              {arrow === 'up' ? '↑' : '↓'}
            </Animated.Text>
          ) : null}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/** Only the move text and the arrow take a meaning colour; tiles stay neutral. */
function tileMoveColour(move: TileMove | null): { color: string } | null {
  if (!move) return null;
  if (move.tone === 'up') return { color: FEED_TOKENS.colors.up };
  if (move.tone === 'down') return { color: FEED_TOKENS.colors.down };
  return { color: FEED_TOKENS.colors.textDim };
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
  // Slim tiles get 2px less padding on each side so the move always fits at 360.
  tileSlim: { padding: 6 },
  name: { color: FEED_TOKENS.colors.text, fontSize: FEED_TOKENS.type.secondary, lineHeight: 18, fontWeight: '600', paddingRight: 14 },
  nameLead: { fontSize: FEED_TOKENS.type.cardTitle, lineHeight: 22, fontWeight: '700' },
  nameSlim: { fontSize: FEED_TOKENS.type.caption, lineHeight: 16, paddingRight: 0 },
  excerpt: { color: FEED_TOKENS.colors.textDim, fontSize: FEED_TOKENS.type.secondary, lineHeight: 18, marginTop: 8 },
  market: { marginTop: 'auto', marginBottom: 8, gap: 4 },
  marketLabel: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    lineHeight: 14,
  },
  moveRow: { marginTop: 'auto' },
  moveLabel: {
    color: FEED_TOKENS.colors.textDim,
    fontFamily: monoFontFamily(),
    fontSize: FEED_TOKENS.type.label,
    lineHeight: 14,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  // No letter spacing on the slim move, a little room beyond the slim tile's
  // 6px padding, and a reserved minimum width so the widest one-decimal move
  // ('-10.6%') is never cut off at 360 (#711; SLIM_MOVE_MIN_WIDTH).
  moveLabelSlim: { letterSpacing: 0, marginHorizontal: -4, minWidth: SLIM_MOVE_MIN_WIDTH },
  moveText: { fontWeight: '600' },
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
  // #185A70 (border) reads at ~1:1 on the real home background; textDim is
  // dim but visible: 8.1:1 against the walletCore background token and 3.5:1
  // against the measured home overlay (#125E74).
  dot: { width: 8, height: 3, backgroundColor: FEED_TOKENS.colors.textDim },
  dotOn: { width: 16, backgroundColor: FEED_TOKENS.colors.accent },
});
