import { memo, useCallback, useEffect, useRef, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Animated,
  Image,
  Pressable,
  RefreshControl,
  SectionList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppTopBar, AppTopBarLogo } from '@/components/AppTopBar';
import { AppProfileButton } from '@/components/AppProfileButton';
import { useChainSigner } from '@/features/chain/useChainSigner';
import { POLYMARKET_REQUIREMENT } from '@/features/chain/chain.contract';
import { fetchFeaturedMarkets, fetchLivePrices } from '@/features/predict/predict.api';
import { getInitialFeedRenderCount } from '@/features/predict/predict-feed';
import type { FeedItem, FeedItemBinary, FeedItemMatch, FeedResponse } from '@/features/predict/predict.types';
import { FeaturedCarousel, LeagueRail } from '@/features/predict/components/DiscoverFeatured';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { formatOdds as formatOddsForFormat, useOddsFormat } from '@/hooks/useOddsFormat';
import { semantic, tokens } from '@/theme';
import { formatUsdCompact } from '@/lib/format';

type LivePriceMap = Record<string, number | null>;

type PredictFeedSection = {
  title: string;
  count?: number;
  isLive?: boolean;
  onPress?: () => void;
  data: FeedItem[];
};

// ─── helpers ────────────────────────────────────────────────────────────────

function formatGameTime(isoDate: string | null): string {
  if (!isoDate) return 'TBD';
  // Hermes rejects "2026-04-29 14:00:00+00" — normalize to ISO 8601
  const normalized = isoDate.replace(' ', 'T').replace(/\+(\d{2})$/, '+$1:00');
  const time = Date.parse(normalized);
  if (Number.isNaN(time)) return 'TBD';
  const date = new Date(time);
  const month = date.toLocaleString('en-US', { month: 'short' });
  const day = date.getDate();
  const clock = date.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${month} ${day} · ${clock}`;
}

function formatChipLabel(label: string): string {
  if (label === 'All') return label;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// League rail labels (PRD §1) — wordmarks in v1, crest pipeline doesn't exist.
const SPORT_LEAGUE_LABELS: Record<string, string> = {
  epl: 'Premier League',
  ucl: 'Champions League',
  ipl: 'Indian Premier League',
  fifwc: 'FIFA World Cup',
  cricket: 'Cricket',
};

// ─── category badge colors ───────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  crypto: { bg: 'rgba(123, 97, 255, 0.15)', text: '#7b61ff' },
  politics: { bg: 'rgba(232, 197, 71, 0.15)', text: tokens.colors.accent },
  macro: { bg: 'rgba(78, 168, 222, 0.15)', text: '#4ea8de' },
  sports: { bg: 'rgba(52, 199, 123, 0.15)', text: tokens.colors.positive },
};

function getCategoryColor(category: string): { bg: string; text: string } {
  const key = category.toLowerCase();
  return CATEGORY_COLORS[key] ?? { bg: semantic.predict.badgeGeoBg as string, text: semantic.text.accentDim as string };
}

function collectFeedTokenIds(items: FeedItem[]): string[] {
  const tokenIds = new Set<string>();
  for (const item of items) {
    if (item.type === 'match') {
      for (const outcome of item.outcomes) {
        const tokenId = outcome.clobTokenIds?.[0];
        if (tokenId) tokenIds.add(tokenId);
      }
    } else {
      for (const tokenId of item.clobTokenIds ?? []) tokenIds.add(tokenId);
      for (const outcome of item.outcomes) {
        for (const tokenId of outcome.clobTokenIds ?? []) tokenIds.add(tokenId);
      }
    }
  }
  return [...tokenIds];
}

function livePriceForToken(livePrices: LivePriceMap, tokenId: string | null | undefined): number | null {
  if (!tokenId) return null;
  return livePrices[tokenId] ?? null;
}

function getBinaryDisplayPrice(item: FeedItemBinary, livePrices: LivePriceMap): number {
  const yesToken = item.clobTokenIds?.[0] ?? item.outcomes[0]?.clobTokenIds?.[0];
  const noToken = item.clobTokenIds?.[1] ?? item.outcomes[1]?.clobTokenIds?.[0];
  const yesPrice = livePriceForToken(livePrices, yesToken);
  const noPrice = livePriceForToken(livePrices, noToken);
  return yesPrice ?? (noPrice !== null ? 1 - noPrice : item.price);
}

function getMatchLiveOutcomePrices(item: FeedItemMatch, livePrices: LivePriceMap): (number | null)[] {
  return item.outcomes.map((outcome) => livePriceForToken(livePrices, outcome.clobTokenIds?.[0]));
}

function livePriceKey(prices: readonly (number | null)[]): string {
  return prices.map((price) => price ?? '').join('|');
}

function mergeLivePrices(current: LivePriceMap, incoming: LivePriceMap): LivePriceMap {
  let changed = false;
  const next = { ...current };
  for (const [tokenId, price] of Object.entries(incoming)) {
    if (next[tokenId] !== price) {
      next[tokenId] = price;
      changed = true;
    }
  }
  return changed ? next : current;
}

// ─── sub-components ──────────────────────────────────────────────────────────

function PulsingDot() {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.2, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return <Animated.View style={[styles.pulseDot, { opacity }]} />;
}

const LiveBadge = memo(function LiveBadge() {
  return (
    <View style={styles.liveBadge}>
      <PulsingDot />
      <Text style={styles.liveBadgeText}>LIVE</Text>
    </View>
  );
});


const CategoryBadge = memo(function CategoryBadge({ category }: { category: string }) {
  const colors = getCategoryColor(category);
  return (
    <View style={[styles.categoryBadge, { backgroundColor: colors.bg }]}>
      <Text style={[styles.categoryBadgeText, { color: colors.text }]}>
        {category.toUpperCase()}
      </Text>
    </View>
  );
});

// ─── binary market card ──────────────────────────────────────────────────────

const BinaryCard = memo(function BinaryCard({
  item,
  price,
  onOpen,
  formatOdds,
}: {
  item: FeedItemBinary;
  price: number;
  onOpen: (slug: string) => void;
  formatOdds: (p: number | null) => string;
}) {
  const yesPct = Math.round(price * 100);
  const noPct = Math.round((1 - price) * 100);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title}. Yes ${yesPct} percent, No ${noPct} percent. ${formatUsdCompact(item.volume)} volume.`}
      accessibilityHint="Open market details"
      onPress={() => onOpen(item.slug)}
      style={({ pressed }) => [styles.binaryCard, pressed && styles.cardPressed]}>
      {/* top row: image + category badge + question */}
      <View style={styles.binaryTop}>
        {item.image ? (
          <Image source={{ uri: item.image }} style={styles.binaryImg} resizeMode="cover" />
        ) : null}
        <View style={{ flex: 1 }}>
          <View style={styles.metaRow}>
            <CategoryBadge category={item.category} />
          </View>
          <Text style={styles.questionText} numberOfLines={2}>{item.title}</Text>
        </View>
      </View>

      {/* probability bar */}
      <View style={styles.binaryBarRow}>
        <Text style={styles.binaryBarLabel}>YES</Text>
        <View style={styles.binaryBarTrack}>
          <View style={[styles.binaryBarFillYes, { width: `${yesPct}%` }]} />
        </View>
        <Text style={styles.binaryBarLabel}>NO</Text>
      </View>

      {/* percentages + volume */}
      <View style={styles.binaryPctRow}>
        <Text style={styles.pctYes}>{formatOdds(price)}</Text>
        <Text style={styles.volBadge}>{formatUsdCompact(item.volume)} vol</Text>
        <Text style={styles.pctNo}>{formatOdds(1 - price)}</Text>
      </View>
    </Pressable>
  );
});

// ─── match card (epl / ipl) ──────────────────────────────────────────────────

function shortTeamName(label: string): string {
  // Strip "Draw (X vs Y)" to just "Draw", and shorten long team names
  if (label.toLowerCase().startsWith('draw')) return 'Draw';
  return label.replace(/\s*(FC|United|Wanderers|Hotspur|City)\b\.?/gi, '').trim();
}

const MatchCard = memo(function MatchCard({
  item,
  liveOutcomePrices,
  priceKey,
  onOpen,
  formatOdds,
}: {
  item: FeedItemMatch;
  liveOutcomePrices: readonly (number | null)[];
  priceKey: string;
  onOpen: (sport: string, slug: string) => void;
  formatOdds: (p: number | null) => string;
}) {
  const isLive = item.status === 'live';
  const hasDraw = item.outcomes.length >= 3;
  const outcomes = item.outcomes.map((outcome, index) => {
    const livePrice = liveOutcomePrices[index];
    return livePrice !== null && livePrice !== undefined ? { ...outcome, price: livePrice } : outcome;
  });
  // For display: first non-draw = team A, last non-draw = team B
  const nonDraw = outcomes.filter((o) => !o.label.toLowerCase().startsWith('draw'));
  const teamA = nonDraw[0]?.label ?? '';
  const teamB = nonDraw[1]?.label ?? '';
  const kickoff = item.gameStartTime ?? item.startDate;

  // Odds bar segments
  const teamAPrice = nonDraw[0]?.price ?? 0.5;
  const teamBPrice = nonDraw[1]?.price ?? 0.5;
  const drawOutcome = outcomes.find((o) => o.label.toLowerCase().startsWith('draw'));
  const drawPrice = drawOutcome?.price ?? 0;
  const teamAPct = Math.round(teamAPrice * 100);
  const teamBPct = Math.round(teamBPrice * 100);
  const drawPct = Math.round(drawPrice * 100);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${teamA} versus ${teamB}. ${isLive ? 'Live market' : formatGameTime(kickoff)}. ${formatUsdCompact(item.volume)} volume.`}
      accessibilityHint="Open match details"
      onPress={() => onOpen(item.sport, item.slug)}
      style={({ pressed }) => [
        styles.sportCard,
        isLive && styles.sportCardLive,
        pressed && styles.cardPressed,
      ]}>
      {/* meta row: status badge + league */}
      <View style={styles.sportMeta}>
        {isLive ? <LiveBadge /> : (
          <View style={styles.upcomingBadgeInline}>
            <Text style={styles.upcomingKickoff}>{formatGameTime(kickoff)}</Text>
          </View>
        )}
        <View style={styles.sportMetaRight}>
          <Text style={styles.sportLeague}>{item.sport.toUpperCase()}</Text>
          <Text style={styles.metaVolChip}>{formatUsdCompact(item.volume)} vol</Text>
        </View>
      </View>

      {/* teams row */}
      <View style={styles.teamsRow}>
        <Text style={styles.teamName} numberOfLines={1}>{shortTeamName(teamA)}</Text>
        <Text style={styles.vsBadge}>vs</Text>
        <Text style={[styles.teamName, styles.teamNameRight]} numberOfLines={1}>{shortTeamName(teamB)}</Text>
      </View>

      {/* odds bar */}
      <View style={styles.oddsBar}>
        <View style={[styles.oddsBarSeg, styles.oddsBarPos, { flex: teamAPct || 1 }]} />
        {hasDraw ? <View style={[styles.oddsBarSeg, styles.oddsBarDraw, { flex: drawPct || 1 }]} /> : null}
        <View style={[styles.oddsBarSeg, styles.oddsBarNeg, { flex: teamBPct || 1 }]} />
      </View>

      {/* odds row */}
      <View style={styles.oddsRow}>
        <Text style={[styles.oddsPct, styles.oddsPctPos]}>{formatOdds(teamAPrice)}</Text>
        {hasDraw ? (
          <Text style={styles.oddsDraw}>{drawPct}% draw</Text>
        ) : (
          <Text style={styles.sportVol}>2-way</Text>
        )}
        <Text style={[styles.oddsPct, styles.oddsPctNeg]}>{formatOdds(teamBPrice)}</Text>
      </View>
    </Pressable>
  );
}, (prev, next) =>
  prev.item === next.item &&
  prev.priceKey === next.priceKey &&
  prev.onOpen === next.onOpen &&
  prev.formatOdds === next.formatOdds
);

// ─── section header ───────────────────────────────────────────────────────────

function ChevronRight() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Path d="M9 18l6-6-6-6" stroke={semantic.text.faint} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const SectionHeader = memo(function SectionHeader({ label, count, onPress, isLive }: { label: string; count?: number; onPress?: () => void; isLive?: boolean }) {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? `${label}${count ? `, ${count} markets` : ''}` : undefined}
      accessibilityHint={onPress ? `Show ${label} markets` : undefined}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.sectionLabelRow, pressed && styles.sectionPressed]}>
      <View style={styles.sectionLeft}>
        <Text style={[styles.sectionLabel, isLive && { color: tokens.colors.live }]}>{label}</Text>
        {count ? <View style={styles.sectionCountBadge}><Text style={styles.sectionCount}>{count}</Text></View> : null}
      </View>
      {onPress ? <ChevronRight /> : null}
    </Pressable>
  );
});

// ─── main screen ─────────────────────────────────────────────────────────────

export default function PredictScreen() {
  const router = useRouter();
  // Predict settles on Polygon: the profile dot reflects the EVM signer, not Solana.
  const { signer: evmSigner } = useChainSigner(POLYMARKET_REQUIREMENT);
  const { format } = useOddsFormat();
  const formatOdds = useCallback((price: number | null) => formatOddsForFormat(price, format), [format]);
  const insets = useSafeAreaInsets();
  const [feedData, setFeedData] = useState<FeedResponse | null>(null);
  const [livePrices, setLivePrices] = useState<LivePriceMap>({});
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeCategory, setActiveCategory] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const livePricesRef = useRef(livePrices);
  livePricesRef.current = livePrices;

  const loadFeed = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const data = await fetchFeaturedMarkets();
      setFeedData(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load predict feed';
      setErrorMessage(message);
      setFeedData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadFeed();
    setRefreshing(false);
  }, [loadFeed]);

  // Build chip list: "All" + only categories that have items
  const chips = useMemo(() => {
    if (!feedData) return ['All'];
    const itemCats = new Set(feedData.items.map((i) => i.category.toLowerCase()));
    const withItems = feedData.categories.filter((c) => itemCats.has(c.toLowerCase()));
    return ['All', ...withItems];
  }, [feedData]);

  // Filtered items based on selected category
  const filteredItems = useMemo<FeedItem[]>(() => {
    if (!feedData) return [];
    const q = searchQuery.trim().toLowerCase();
    let base = feedData.items;
    if (q) {
      base = base.filter((item) =>
        item.title.toLowerCase().includes(q)
        || item.category.toLowerCase().includes(q)
        || item.tags.some((tag) => tag.toLowerCase().includes(q)),
      );
    }
    if (activeCategory === 'All') return base;
    return base.filter((item) => item.category.toLowerCase() === activeCategory.toLowerCase());
  }, [feedData, activeCategory, searchQuery]);

  // Derived sections (only used when "All" is selected)
  const liveItems = useMemo(
    () => feedData?.items.filter((item) => item.status === 'live') ?? [],
    [feedData],
  );

  const upcomingMatches = useMemo(
    () =>
      feedData?.items.filter(
        (item): item is FeedItemMatch =>
          item.type === 'match' &&
          item.status === 'upcoming',
      ) ?? [],
    [feedData],
  );

  const upcomingMatchGroups = useMemo(
    () => {
      const groups = new Map<string, FeedItemMatch[]>();
      for (const item of upcomingMatches) {
        const current = groups.get(item.sport) ?? [];
        current.push(item);
        groups.set(item.sport, current);
      }
      return [...groups.entries()];
    },
    [upcomingMatches],
  );

  const binaryItems = useMemo(
    () =>
      feedData?.items.filter(
        (item): item is FeedItemBinary => item.type === 'binary' && item.status !== 'live',
      ) ?? [],
    [feedData],
  );

  const isAllSelected = activeCategory === 'All';

  const renderedItems = useMemo<FeedItem[]>(() => {
    if (!feedData) return [];
    if (!isAllSelected) return filteredItems;
    return [...liveItems, ...upcomingMatches, ...binaryItems];
  }, [binaryItems, feedData, filteredItems, isAllSelected, liveItems, upcomingMatches]);

  const visibleTokenIds = useMemo(() => collectFeedTokenIds(renderedItems), [renderedItems]);
  const visibleTokenKey = visibleTokenIds.join(',');
  const hasFeedData = feedData !== null;
  const livePriceRefreshInFlight = useRef(false);

  useFocusedAppStateInterval(async (isCurrent) => {
    const tokenIds = visibleTokenKey.split(',').filter(Boolean);
    if (!hasFeedData || tokenIds.length === 0 || livePriceRefreshInFlight.current) return;
    livePriceRefreshInFlight.current = true;
    try {
      const prices = await fetchLivePrices(tokenIds);
      if (isCurrent()) {
        setLivePrices((current) => mergeLivePrices(current, prices));
      }
    } catch {
      // Keep the existing feed visible when live polling misses.
    } finally {
      livePriceRefreshInFlight.current = false;
    }
  }, 30_000, {
    enabled: hasFeedData && visibleTokenIds.length > 0,
    runImmediately: true,
    resetKey: visibleTokenKey,
  });

  const navigateBinary = useCallback((slug: string) => {
    router.push({ pathname: '/markets/polymarket/market/[slug]', params: { slug } });
  }, [router]);

  const navigateMatch = useCallback((sport: string, slug: string) => {
    router.push({ pathname: '/markets/polymarket/sport/[sport]/[slug]', params: { sport, slug } });
  }, [router]);

  const navigateUpdown = useCallback(() => {
    router.push('/markets/polymarket/updown');
  }, [router]);

  const showSports = useCallback(() => {
    setActiveCategory('sports');
  }, []);

  // ─── Discover surfaces (Predict redesign PRD §1) ───
  // Featured carousel: the One Tap entry (single card per PRD) + highest-volume
  // upcoming matches. Movers: biggest 24h volume — a real API field, replacing
  // the cut fabricated pick counts.
  const carouselItems = useMemo(() => {
    if (!feedData) return [];
    const items: { slug: string; eyebrow: string; title: string; metaLine: string | null; kind: 'updown' | 'market' }[] = [];
    items.push({
      slug: 'updown',
      eyebrow: 'One Tap',
      title: 'Bitcoin Up or Down',
      metaLine: 'Hourly & daily rounds · pick Higher or Lower',
      kind: 'updown',
    });
    for (const match of upcomingMatches.slice(0, 4)) {
      const kickoff = match.gameStartTime ?? match.startDate;
      items.push({
        slug: `${match.sport}:${match.slug}`,
        eyebrow: match.sport.toUpperCase(),
        title: match.title,
        metaLine: kickoff ? formatGameTime(kickoff) : null,
        kind: 'market',
      });
    }
    return items;
  }, [feedData, upcomingMatches]);

  const onPressCarouselItem = useCallback((key: string) => {
    if (key === 'updown') {
      navigateUpdown();
      return;
    }
    const sep = key.indexOf(':');
    if (sep > 0) navigateMatch(key.slice(0, sep), key.slice(sep + 1));
  }, [navigateMatch, navigateUpdown]);

  const movers = useMemo(() => {
    if (!feedData) return [];
    return [...feedData.items]
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 5);
  }, [feedData]);

  const leagues = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of feedData?.items ?? []) {
      if (item.type !== 'match') continue;
      const label = SPORT_LEAGUE_LABELS[item.sport] ?? item.sport.toUpperCase();
      if (!seen.has(item.sport)) seen.set(item.sport, label);
    }
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [feedData]);

  const feedSections = useMemo<PredictFeedSection[]>(() => {
    if (loading || errorMessage) return [];
    if (!isAllSelected) {
      return filteredItems.length > 0
        ? [{ title: activeCategory, data: filteredItems }]
        : [];
    }

    const sections: PredictFeedSection[] = [];
    if (liveItems.length > 0) {
      sections.push({ title: 'Live Now', isLive: true, data: liveItems });
    }
    for (const [sport, matches] of upcomingMatchGroups) {
      sections.push({
        title: `${sport.toUpperCase()} · Upcoming`,
        count: matches.length,
        onPress: showSports,
        data: matches,
      });
    }
    if (binaryItems.length > 0) {
      sections.push({ title: 'Markets', count: binaryItems.length, data: binaryItems });
    }
    return sections;
  }, [
    activeCategory,
    binaryItems,
    errorMessage,
    filteredItems,
    isAllSelected,
    liveItems,
    loading,
    showSports,
    upcomingMatchGroups,
  ]);

  const initialFeedRenderCount = useMemo(
    () => getInitialFeedRenderCount(feedSections, process.env.EXPO_OS === 'web'),
    [feedSections],
  );

  const renderFeedItem = useCallback(({ item }: { item: FeedItem }) => {
    const currentLivePrices = livePricesRef.current;
    if (item.type === 'binary') {
      const price = getBinaryDisplayPrice(item, currentLivePrices);
      return (
        <BinaryCard
          item={item}
          price={price}
          onOpen={navigateBinary}
          formatOdds={formatOdds}
        />
      );
    }

    const liveOutcomePrices = getMatchLiveOutcomePrices(item, currentLivePrices);
    return (
      <MatchCard
        item={item}
        liveOutcomePrices={liveOutcomePrices}
        priceKey={livePriceKey(liveOutcomePrices)}
        onOpen={navigateMatch}
        formatOdds={formatOdds}
      />
    );
  }, [formatOdds, navigateBinary, navigateMatch]);

  const renderSectionHeader = useCallback(({ section }: { section: PredictFeedSection }) => (
    <View style={styles.sectionListHeader}>
      <SectionHeader
        label={section.title}
        count={section.count}
        onPress={section.onPress}
        isLive={section.isLive}
      />
    </View>
  ), []);

  const keyExtractor = useCallback((item: FeedItem) => item.slug, []);

  const renderListHeader = useCallback(() => (
    <>
      {/* loading */}
      {loading ? (
        <View style={styles.stateCard}>
          <ActivityIndicator size="small" color={semantic.text.accent} />
          <Text style={styles.stateText}>Loading markets...</Text>
        </View>
      ) : null}

      {/* error */}
      {!loading && errorMessage ? (
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>Predict unavailable</Text>
          <Text style={styles.stateText}>{errorMessage}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            accessibilityHint="Reload predict markets"
            style={styles.retryButton}
            onPress={() => void loadFeed()}>
            <Text style={styles.retryButtonText}>Try Again</Text>
          </Pressable>
        </View>
      ) : null}

      {!loading && !errorMessage ? (
        <>
          <FeaturedCarousel items={carouselItems.map(({ slug, eyebrow, title, metaLine }) => ({ slug, eyebrow, title, metaLine }))} onPressItem={onPressCarouselItem} />

          {/* Movers — ranked by traded volume (real API field) */}
          {movers.length > 0 ? (
            <View style={styles.moversSection}>
              <Text style={styles.railTitle}>Movers</Text>
              {movers.map((item) => {
                const price = item.type === 'binary' ? getBinaryDisplayPrice(item, livePricesRef.current) : item.outcomes[0]?.price ?? null;
                return (
                  <Pressable
                    key={item.slug}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.title}, ${formatUsdCompact(item.volume)} volume`}
                    style={styles.moverRow}
                    onPress={() => {
                      if (item.type === 'match') navigateMatch(item.sport, item.slug);
                      else navigateBinary(item.slug);
                    }}>
                    <Text style={styles.moverTitle} numberOfLines={1}>{item.title}</Text>
                    <View style={styles.moverRight}>
                      <Text style={styles.moverPrice}>{price !== null ? formatOdds(price) : '--'}</Text>
                      <Text style={styles.moverVol}>{formatUsdCompact(item.volume)} vol</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <LeagueRail leagues={leagues} onPressLeague={showSports} />

          {/* Unit explainer (PRD fix-pass): prices are chances */}
          <Text style={styles.unitExplainer}>Prices run 1¢–99¢. A price is also the chance — 65¢ means the market says 65% likely.</Text>

          <View style={styles.searchShell}>
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search markets"
              placeholderTextColor={semantic.text.faint}
              accessibilityLabel="Search Predict markets"
              autoCorrect={false}
              style={styles.searchInput}
            />
            {searchQuery.length > 0 && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                onPress={() => setSearchQuery('')}
                style={styles.searchClear}>
                <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
                  <Path d="M18 6L6 18M6 6l12 12" stroke={semantic.text.faint} strokeWidth={2.5} strokeLinecap="round" />
                </Svg>
              </Pressable>
            )}
          </View>

          <View style={styles.filterStripShell}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterStrip}>
            {chips.map((chip) => {
              const active = chip === activeCategory;
              return (
                <Pressable
                  key={chip}
                  accessibilityRole="tab"
                  accessibilityLabel={`Show ${formatChipLabel(chip)} markets`}
                  accessibilityState={{ selected: active }}
                  onPress={() => setActiveCategory(chip)}
                  style={[styles.filterChip, active ? styles.filterChipOn : styles.filterChipOff]}>
                  {active ? <View style={styles.filterActiveDot} /> : null}
                  <Text style={active ? styles.filterTextOn : styles.filterTextOff}>
                    {formatChipLabel(chip)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
        </>
      ) : null}
    </>
  ), [activeCategory, chips, errorMessage, loadFeed, loading, carouselItems, movers, leagues, onPressCarouselItem, navigateMatch, navigateBinary, formatOdds, searchQuery]);

  const renderListFooter = useCallback(() => {
    if (loading || errorMessage) return null;
    if (isAllSelected && feedSections.length === 0) {
      return (
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>No markets</Text>
          <Text style={styles.stateText}>Pull down to refresh.</Text>
        </View>
      );
    }
    if (!isAllSelected && filteredItems.length === 0) {
      return (
        <View style={styles.sectionWrap}>
          <SectionHeader label={activeCategory} />
          <View style={styles.stateCard}>
            <Text style={styles.stateText}>No {activeCategory} markets available.</Text>
          </View>
        </View>
      );
    }
    return null;
  }, [activeCategory, errorMessage, feedSections.length, filteredItems.length, isAllSelected, loading]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
        left={<AppTopBarLogo />}
        right={
          <AppProfileButton
            onPress={() => router.push('/markets/polymarket/profile')}
            connected={!!evmSigner}
            label="Open Predict profile"
            hint="View your Predict account, picks, and winnings"
          />
        }
      />

      {/* feed list */}
      <SectionList
        sections={feedSections}
        initialNumToRender={initialFeedRenderCount}
        keyExtractor={keyExtractor}
        renderItem={renderFeedItem}
        renderSectionHeader={renderSectionHeader}
        ListHeaderComponent={renderListHeader}
        ListFooterComponent={renderListFooter}
        stickySectionHeadersEnabled={false}
        style={styles.feedList}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.feedContent}
        extraData={livePrices}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={semantic.text.accent} />
        }
      />
    </View>
  );
}

// ─── styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: semantic.background.screen,
  },
  // ─── filter strip ───
  filterStripShell: {
    marginBottom: tokens.spacing.sm,
  },
  // ─── Discover surfaces (PRD §1) ───
  moversSection: {
    gap: 6,
    marginTop: 4,
  },
  railTitle: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: semantic.text.faint,
    marginBottom: 4,
  },
  moverRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: tokens.colors.surface,
    paddingHorizontal: 12,
  },
  moverTitle: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  moverRight: {
    alignItems: 'flex-end',
    gap: 1,
  },
  moverPrice: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  moverVol: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
  },
  unitExplainer: {
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 13,
    color: semantic.text.faint,
    marginHorizontal: 2,
  },
  searchShell: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: 'rgba(8, 8, 6, 0.36)',
    paddingHorizontal: 12,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 12,
    color: semantic.text.primary,
    paddingVertical: 10,
  },
  searchClear: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterStrip: {
    gap: 6,
    paddingHorizontal: 2,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 12,
    backgroundColor: 'rgba(8, 8, 6, 0.36)',
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  filterChipOn: {
    backgroundColor: 'rgba(232, 197, 71, 0.12)',
    borderColor: 'rgba(232, 197, 71, 0.3)',
  },
  filterChipOff: {
    backgroundColor: semantic.background.surface,
    borderColor: semantic.border.muted,
  },
  filterTextOn: {
    color: semantic.text.primary,
    fontSize: 12,
    fontWeight: '700',
  },
  filterTextOff: {
    color: semantic.text.faint,
    fontSize: 12,
    fontWeight: '600',
  },
  filterActiveDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: tokens.colors.accent,
  },
  // ─── feed ───
  feedList: {
    flex: 1,
  },
  feedContent: {
    paddingHorizontal: 14,
    paddingTop: tokens.spacing.sm,
    paddingBottom: tokens.spacing.md,
    gap: 6,
  },
  sectionWrap: {
    gap: 6,
  },
  sectionListHeader: {
    marginBottom: 6,
  },
  // ─── featured carousel ───
  featuredHeader: {
    marginTop: tokens.spacing.xs,
    marginBottom: tokens.spacing.sm,
    paddingHorizontal: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  featuredHeaderTitle: {
    color: semantic.text.primary,
    fontSize: 15,
    fontWeight: '800',
  },
  featuredDots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  featuredDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: tokens.colors.textFaint,
  },
  featuredDotActive: {
    width: 15,
    backgroundColor: tokens.colors.accent,
  },
  featuredRail: {
    gap: 10,
    paddingBottom: tokens.spacing.md,
  },
  featuredCard: {
    overflow: 'hidden',
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: 'rgba(232, 197, 71, 0.2)',
    borderRadius: 18,
    padding: 14,
    minHeight: 186,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 8,
  },
  featuredTop: {
    marginBottom: tokens.spacing.md,
  },
  featuredStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacing.sm,
  },
  featuredKicker: {
    color: semantic.text.primary,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'right',
  },
  featuredLeague: {
    marginTop: 2,
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1,
    textTransform: 'uppercase',
    textAlign: 'right',
  },
  featuredTime: {
    color: tokens.colors.accent,
    backgroundColor: 'rgba(232, 197, 71, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(232, 197, 71, 0.18)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontFamily: 'monospace',
    fontSize: 9,
    overflow: 'hidden',
  },
  featuredMatchup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.sm,
    marginBottom: tokens.spacing.md,
  },
  featuredTeam: {
    flex: 1,
    minWidth: 0,
  },
  featuredTeamRight: {
    alignItems: 'flex-end',
  },
  featuredTeamName: {
    color: semantic.text.primary,
    fontSize: 15,
    lineHeight: 18,
    fontWeight: '800',
  },
  featuredTextRight: {
    textAlign: 'right',
  },
  featuredVs: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: semantic.background.screen,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featuredVsText: {
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 9,
  },
  featuredOdd: {
    marginTop: tokens.spacing.xs,
    fontFamily: 'monospace',
    fontSize: 22,
    lineHeight: 24,
    fontWeight: '800',
  },
  featuredOddPos: {
    color: tokens.colors.positive,
  },
  featuredOddNeg: {
    color: tokens.colors.vermillion,
  },
  featuredContextText: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: semantic.text.dim,
  },
  featuredBinaryMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.sm,
    marginBottom: tokens.spacing.md,
  },
  featuredImage: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: tokens.colors.lift,
  },
  featuredBinaryCopy: {
    flex: 1,
    minWidth: 0,
  },
  featuredQuestion: {
    color: semantic.text.primary,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '800',
  },
  featuredEnd: {
    marginTop: 4,
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 9,
  },
  featuredBinaryOdds: {
    alignItems: 'flex-end',
    minWidth: 54,
  },
  featuredOddsLabel: {
    marginTop: 2,
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1,
  },
  // ─── section header ───
  sectionLabelRow: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: 8,
  },
  sectionPressed: {
    backgroundColor: tokens.colors.lift,
  },
  sectionLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionLabel: {
    color: semantic.text.primary,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  sectionCountBadge: {
    backgroundColor: tokens.colors.lift,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  sectionCount: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.faint,
  },
  // ─── shared ───
  cardPressed: {
    opacity: 0.9,
  },
  metaRow: {
    marginBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  questionText: {
    color: semantic.text.primary,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600',
  },
  // ─── badges ───
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: 'rgba(244, 88, 78, 0.25)',
    backgroundColor: 'rgba(244, 88, 78, 0.10)',
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  pulseDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: tokens.colors.live,
  },
  liveBadgeText: {
    color: tokens.colors.live,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  categoryBadge: {
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  categoryBadgeText: {
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    fontFamily: 'monospace',
    fontWeight: '500',
  },
  // ─── binary card (mockup: geo-card) ───
  binaryCard: {
    marginBottom: 8,
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 12,
    padding: 12,
  },
  binaryTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 10,
  },
  binaryImg: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: tokens.colors.lift,
  },
  binaryBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 7,
  },
  binaryBarLabel: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.faint,
    width: 24,
  },
  binaryBarTrack: {
    flex: 1,
    height: 4,
    backgroundColor: tokens.colors.lift,
    borderRadius: 2,
    overflow: 'hidden',
  },
  binaryBarFillYes: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: tokens.colors.positive,
    borderRadius: 2,
  },
  binaryPctRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pctYes: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: tokens.colors.positive,
  },
  pctNo: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: tokens.colors.vermillion,
  },
  volBadge: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: semantic.text.faint,
    backgroundColor: tokens.colors.surface,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
  },
  // ─── sport card (mockup: sport-card) ───
  sportCard: {
    marginHorizontal: 0,
    marginBottom: 8,
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 12,
    padding: 12,
  },
  sportCardLive: {
    borderColor: 'rgba(244, 88, 78, 0.2)',
  },
  sportMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 8,
  },
  sportMetaRight: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    flexShrink: 1,
  },
  sportLeague: {
    fontFamily: 'monospace',
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  metaVolChip: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.faint,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  upcomingBadgeInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  upcomingKickoff: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.faint,
  },
  teamsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  teamName: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  teamNameRight: {
    textAlign: 'right',
  },
  vsBadge: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: semantic.text.faint,
    paddingHorizontal: 8,
  },
  // ─── odds bar (unified for sport + binary) ───
  oddsBar: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    gap: 2,
    marginBottom: 6,
  },
  oddsBarSeg: {
    borderRadius: 3,
    minWidth: 3,
  },
  oddsBarPos: {
    backgroundColor: tokens.colors.positive,
  },
  oddsBarNeg: {
    backgroundColor: tokens.colors.vermillion,
  },
  oddsBarDraw: {
    backgroundColor: tokens.colors.accent,
  },
  oddsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  oddsPct: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
  },
  oddsPctPos: {
    color: tokens.colors.positive,
  },
  oddsPctNeg: {
    color: tokens.colors.vermillion,
  },
  oddsDraw: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: tokens.colors.accent,
  },
  sportVol: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: semantic.text.faint,
  },
  // ─── state cards ───
  stateCard: {
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: tokens.radius.md,
    padding: tokens.spacing.lg,
    gap: tokens.spacing.sm,
  },
  stateTitle: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
  },
  stateText: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.md,
  },
  retryButton: {
    marginTop: tokens.spacing.xs,
    backgroundColor: semantic.text.accent,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.radius.xs,
    alignSelf: 'flex-start',
  },
  retryButtonText: {
    color: semantic.background.screen,
    fontSize: tokens.fontSize.sm,
    fontFamily: 'monospace',
    fontWeight: '700',
    textTransform: 'uppercase',
  },
});
