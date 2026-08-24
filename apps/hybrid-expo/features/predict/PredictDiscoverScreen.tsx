import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppProfileButton } from '@/components/AppProfileButton';
import { AppTopBar, AppTopBarLogo } from '@/components/AppTopBar';
import { POLYMARKET_REQUIREMENT } from '@/features/chain/chain.contract';
import { useChainSigner } from '@/features/chain/useChainSigner';
import {
  fetchFeaturedMarkets,
  fetchLivePrices,
  fetchPredictSearch,
  fetchUpDownHistory,
  fetchUpDownRounds,
  type PredictSearchEvent,
  type PredictSearchResponse,
  type UpDownHistory,
  type UpDownRound,
} from '@/features/predict/predict.api';
import { getPredictMarketHref } from '@/features/predict/predict.navigation';
import type {
  FeedItem,
  FeedItemBinary,
  FeedItemMatch,
  FeedResponse,
  FeedTeam,
} from '@/features/predict/predict.types';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { formatUsdCompact } from '@/lib/format';
import { semantic, tokens } from '@/theme';

type LivePriceMap = Record<string, number | null>;

const CATEGORY_TABS = ['Discover', 'Sports', 'Crypto', 'Politics', 'World'] as const;
type CategoryTab = (typeof CATEGORY_TABS)[number];

const LEAGUE_LABELS: Record<string, string> = {
  epl: 'Premier League',
  ucl: 'Champions League',
  ipl: 'Indian Premier League',
  fifwc: 'FIFA World Cup',
  cricket: 'Cricket',
  nba: 'NBA',
  nfl: 'NFL',
  nhl: 'NHL',
  mlb: 'MLB',
  f1: 'Formula 1',
};

const LEAGUE_MARKS: Record<string, string> = {
  epl: 'PL',
  ucl: 'CL',
  ipl: 'IPL',
  fifwc: 'WC',
  cricket: 'CR',
  nba: 'NBA',
  nfl: 'NFL',
  nhl: 'NHL',
  mlb: 'MLB',
  f1: 'F1',
};

function normalizeDate(value: string): string {
  return value.replace(' ', 'T').replace(/\+(\d{2})$/, '+$1:00');
}

function formatGameTime(value: string | null): string {
  if (!value) return 'Time pending';
  const timestamp = Date.parse(normalizeDate(value));
  if (!Number.isFinite(timestamp)) return 'Time pending';
  const date = new Date(timestamp);
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

function formatCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatProbability(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return `${Math.round(value * 100)}%`;
}

function formatCountdown(endDate: string | null, now: number): string {
  if (!endDate) return 'Time pending';
  const remaining = Math.max(0, Date.parse(endDate) - now);
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function shortName(value: string): string {
  if (/^draw\b/i.test(value)) return 'Draw';
  return value.replace(/\s+(football club|fc)$/i, '').trim();
}

function collectTokenIds(items: FeedItem[]): string[] {
  const result = new Set<string>();
  for (const item of items) {
    if (item.type === 'binary') {
      for (const token of item.clobTokenIds ?? []) result.add(token);
    }
    for (const outcome of item.outcomes) {
      for (const token of outcome.clobTokenIds ?? []) result.add(token);
    }
  }
  return [...result];
}

function outcomePrices(item: FeedItem, livePrices: LivePriceMap) {
  const priced = item.outcomes.map((outcome) => ({
    ...outcome,
    price: livePrices[outcome.clobTokenIds?.[0] ?? ''] ?? outcome.price,
  }));
  if (item.type !== 'match' || priced.length < 2) return priced;
  const total = priced.reduce((sum, outcome) => sum + Math.max(0, outcome.price), 0);
  if (total <= 0) return priced;
  // Match outcomes are mutually exclusive. Normalize their separate YES
  // midpoints so the Discover percentages read as one coherent probability.
  return priced.map((outcome) => ({ ...outcome, price: Math.max(0, outcome.price) / total }));
}

function binaryPrice(item: FeedItemBinary, livePrices: LivePriceMap): number {
  const token = item.clobTokenIds?.[0] ?? item.outcomes[0]?.clobTokenIds?.[0];
  return (token ? livePrices[token] : null) ?? item.price;
}

function teamForOutcome(teams: FeedTeam[], label: string, index: number): FeedTeam | null {
  const exact = teams.find((team) => team.name.toLowerCase() === label.toLowerCase());
  return exact ?? teams[index] ?? null;
}

function categoryMatches(item: FeedItem, category: CategoryTab): boolean {
  if (category === 'Discover' || category === 'Sports') return category === 'Discover' || item.category.toLowerCase() === 'sports';
  const normalized = item.category.toLowerCase();
  if (category === 'World') return ['world', 'geopolitics', 'macro'].includes(normalized);
  return normalized === category.toLowerCase();
}

function SectionHeading({
  title,
  action,
  live = false,
  onAction,
}: {
  title: string;
  action?: string;
  live?: boolean;
  onAction?: () => void;
}) {
  return (
    <View style={styles.sectionHeading}>
      <View style={styles.sectionTitleRow}>
        {live ? <View style={styles.liveDot} /> : null}
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {action && onAction ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${action} ${title}`}
          onPress={onAction}
          hitSlop={8}
          style={({ pressed }) => [styles.sectionActionButton, pressed && styles.pressed]}
        >
          <Text style={styles.sectionAction}>{action}</Text>
        </Pressable>
      ) : action ? (
        <Text style={styles.sectionAction}>{action}</Text>
      ) : null}
    </View>
  );
}

function PriceChart({ history }: { history: UpDownHistory | null }) {
  const chart = useMemo(() => {
    if (!history || history.points.length < 2) return null;
    const width = 312;
    const height = 70;
    const values = history.points.map((point) => point.p);
    if (history.priceToBeat !== null) values.push(history.priceToBeat);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, 1);
    const pointY = (price: number) => height - 6 - ((price - min) / span) * (height - 12);
    const path = history.points
      .map((point, index) => {
        const x = (index / (history.points.length - 1)) * width;
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${pointY(point.p).toFixed(1)}`;
      })
      .join(' ');
    return {
      path,
      targetY: history.priceToBeat === null ? null : pointY(history.priceToBeat),
    };
  }, [history]);

  if (!chart) {
    return (
      <View style={styles.chartFallback}>
        <Text style={styles.chartFallbackText}>Price chart loading</Text>
      </View>
    );
  }

  return (
    <View style={styles.chartWrap} accessibilityElementsHidden>
      <Svg width="100%" height={70} viewBox="0 0 312 70" preserveAspectRatio="none">
        {chart.targetY !== null ? (
          <Line
            x1={0}
            x2={312}
            y1={chart.targetY}
            y2={chart.targetY}
            stroke={tokens.colors.accent}
            strokeOpacity={0.42}
            strokeDasharray="4 6"
          />
        ) : null}
        <Path d={chart.path} fill="none" stroke={tokens.colors.viridian} strokeWidth={2.5} />
      </Svg>
      {chart.targetY !== null ? <Text style={[styles.targetTag, { top: Math.max(0, chart.targetY - 8) }]}>TARGET</Text> : null}
    </View>
  );
}

function OneTapCard({
  round,
  history,
  now,
  width,
  onPress,
}: {
  round: UpDownRound;
  history: UpDownHistory | null;
  now: number;
  width: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Bitcoin one tap market. Current price ${formatCurrency(round.currentPrice)}. Price to beat ${formatCurrency(round.priceToBeat)}. ${formatCountdown(round.endDate, now)} left.`}
      accessibilityHint="Open fast markets"
      onPress={onPress}
      style={({ pressed }) => [styles.oneTapCard, { width }, pressed && styles.cardPressed]}
    >
      <View style={styles.oneTapTop}>
        <View style={styles.assetLockup}>
          <View style={styles.coinMark}><Text style={styles.coinText}>₿</Text></View>
          <View style={styles.assetCopy}>
            <Text style={styles.assetName}>Bitcoin</Text>
            <Text style={styles.assetQuestion}><Text style={styles.oneTapMark}>ONE TAP  </Text>Higher or lower when the clock ends?</Text>
          </View>
        </View>
        <View style={styles.durationChip}>
          <MaterialIcons name="timer" size={13} color={tokens.colors.accent} />
          <Text style={styles.durationText}>1 hour</Text>
        </View>
      </View>

      <View style={styles.priceRow}>
        <View>
          <Text style={styles.dataLabel}>Right now</Text>
          <Text style={styles.currentPrice}>{formatCurrency(round.currentPrice)}</Text>
        </View>
        <View style={styles.targetCopy}>
          <Text style={styles.dataLabel}>Price to beat</Text>
          <Text style={styles.targetPrice}>{formatCurrency(round.priceToBeat)}</Text>
        </View>
      </View>

      <PriceChart history={history} />

      <View style={styles.oneTapBottom}>
        <View style={styles.countdownRow}>
          <View style={styles.countdownDot} />
          <Text style={styles.countdownValue}>{formatCountdown(round.endDate, now)}</Text>
          <Text style={styles.countdownLabel}>left</Text>
        </View>
        <View style={styles.sidePills}>
          <View style={styles.higherPill}><Text style={styles.higherText}>Higher <Text style={styles.sideStrong}>{formatProbability(round.upPrice)}</Text></Text></View>
          <View style={styles.lowerPill}><Text style={styles.lowerText}>Lower <Text style={styles.sideStrong}>{formatProbability(round.downPrice)}</Text></Text></View>
        </View>
      </View>
      <Text style={styles.cardHint}>OPEN FAST MARKETS</Text>
    </Pressable>
  );
}

function teamSides(item: FeedItemMatch, livePrices: LivePriceMap) {
  const priced = outcomePrices(item, livePrices);
  const nonDraw = priced.filter((outcome) => !/^draw\b/i.test(outcome.label));
  const draw = priced.find((outcome) => /^draw\b/i.test(outcome.label)) ?? null;
  return {
    home: nonDraw[0] ?? null,
    away: nonDraw[1] ?? null,
    draw,
    homeTeam: nonDraw[0] ? teamForOutcome(item.teams, nonDraw[0].label, 0) : null,
    awayTeam: nonDraw[1] ? teamForOutcome(item.teams, nonDraw[1].label, 1) : null,
  };
}

function Crest({ team, fallback }: { team: FeedTeam | null; fallback: string }) {
  if (team?.logo) {
    return <Image source={team.logo} style={styles.crestImage} contentFit="contain" transition={100} />;
  }
  const mark = team?.abbreviation?.toUpperCase() ?? fallback.slice(0, 3).toUpperCase();
  return <View style={styles.crestFallback}><Text style={styles.crestFallbackText}>{mark}</Text></View>;
}

function MatchCard({
  item,
  livePrices,
  width,
  onPress,
}: {
  item: FeedItemMatch;
  livePrices: LivePriceMap;
  width: number;
  onPress: () => void;
}) {
  const sides = teamSides(item, livePrices);
  const isLive = item.status === 'live';
  const league = LEAGUE_LABELS[item.sport] ?? item.sport.toUpperCase();
  const time = formatGameTime(item.gameStartTime ?? item.startDate);
  const odds = [sides.home, sides.draw, sides.away].filter(Boolean);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${sides.home?.label ?? item.title} versus ${sides.away?.label ?? ''}. ${isLive ? 'Market open' : time}`}
      accessibilityHint="Open match market"
      onPress={onPress}
      style={({ pressed }) => [styles.matchCard, { width, height: width > 300 ? 218 : 166 }, pressed && styles.cardPressed]}
    >
      <View style={styles.matchMeta}>
        <Text style={styles.leagueKicker}>{league}</Text>
        <Text style={isLive ? styles.liveStatus : styles.matchTime}>{isLive ? 'MARKET OPEN' : time.toUpperCase()}</Text>
      </View>
      <View style={styles.matchup}>
        <View style={styles.teamBlock}>
          <Crest team={sides.homeTeam} fallback={sides.home?.label ?? 'HOME'} />
          <Text style={styles.teamName} numberOfLines={1}>{shortName(sides.home?.label ?? 'Home')}</Text>
        </View>
        <View style={styles.versusBlock}>
          <Text style={styles.versus}>VS</Text>
          <Text style={isLive ? styles.moneylineLive : styles.moneyline}>MONEYLINE</Text>
        </View>
        <View style={[styles.teamBlock, styles.teamBlockRight]}>
          <Crest team={sides.awayTeam} fallback={sides.away?.label ?? 'AWAY'} />
          <Text style={[styles.teamName, styles.teamNameRight]} numberOfLines={1}>{shortName(sides.away?.label ?? 'Away')}</Text>
        </View>
      </View>
      <View style={[styles.oddsGrid, odds.length === 2 && styles.oddsGridTwo]}>
        {odds.map((outcome) => outcome ? (
          <View key={outcome.label} style={styles.oddChip}>
            <Text style={styles.oddLabel} numberOfLines={1}>{shortName(outcome.label)}</Text>
            <Text style={styles.oddValue}>{formatProbability(outcome.price)}</Text>
          </View>
        ) : null)}
      </View>
    </Pressable>
  );
}

function FeaturedMarketCard({
  item,
  livePrices,
  width,
  onPress,
}: {
  item: FeedItem;
  livePrices: LivePriceMap;
  width: number;
  onPress: () => void;
}) {
  if (item.type === 'match') {
    return <MatchCard item={item} livePrices={livePrices} width={width} onPress={onPress} />;
  }
  const price = binaryPrice(item, livePrices);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title}. ${formatProbability(price)} probability.`}
      accessibilityHint="Open market"
      onPress={onPress}
      style={({ pressed }) => [styles.featureBinary, { width }, pressed && styles.cardPressed]}
    >
      <View style={styles.featureBinaryTop}>
        <Text style={styles.featureKicker}>{item.category.toUpperCase()}</Text>
        <Text style={styles.featureEnd}>{item.endDate ? formatGameTime(item.endDate).toUpperCase() : 'MARKET OPEN'}</Text>
      </View>
      <View style={styles.featureBinaryMain}>
        {item.image ? <Image source={item.image} style={styles.featureImage} contentFit="cover" transition={100} /> : null}
        <Text style={styles.featureQuestion} numberOfLines={3}>{item.title}</Text>
      </View>
      <View style={styles.probabilityRow}>
        <View>
          <Text style={styles.probabilityValue}>{formatProbability(price)}</Text>
          <Text style={styles.probabilityLabel}>market estimate</Text>
        </View>
        <Text style={styles.featureVolume}>{formatUsdCompact(item.volume)} traded</Text>
      </View>
      <View style={styles.probabilityTrack}><View style={[styles.probabilityFill, { width: `${Math.max(0, Math.min(100, price * 100))}%` }]} /></View>
    </Pressable>
  );
}

function LeagueCard({ sport, label, count, onPress }: { sport: string; label: string; count: number; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count} markets`}
      onPress={onPress}
      style={({ pressed }) => [styles.leagueCard, pressed && styles.cardPressed]}
    >
      <View style={styles.leagueMark}><Text style={styles.leagueMarkText}>{LEAGUE_MARKS[sport] ?? sport.slice(0, 3).toUpperCase()}</Text></View>
      <View>
        <Text style={styles.leagueName}>{label}</Text>
        <Text style={styles.leagueCount}>{count} {count === 1 ? 'market' : 'markets'}</Text>
      </View>
    </Pressable>
  );
}

function MoverCard({ item, livePrices, onPress }: { item: FeedItem; livePrices: LivePriceMap; onPress: () => void }) {
  const priced = item.type === 'binary' ? null : outcomePrices(item, livePrices).sort((a, b) => b.price - a.price)[0] ?? null;
  const probability = item.type === 'binary' ? binaryPrice(item, livePrices) : priced?.price ?? null;
  const label = item.type === 'binary' ? 'market estimate' : priced?.label ?? 'leading outcome';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title}. ${formatProbability(probability)} ${label}. ${formatUsdCompact(item.volume)} traded.`}
      onPress={onPress}
      style={({ pressed }) => [styles.moverCard, pressed && styles.cardPressed]}
    >
      <View style={styles.moverCopy}>
        <Text style={styles.moverKicker}>{item.category.toUpperCase()} · {item.type === 'match' ? (LEAGUE_LABELS[item.sport] ?? item.sport) : 'PREDICTION'}</Text>
        <Text style={styles.moverQuestion} numberOfLines={2}>{item.title}</Text>
        <Text style={styles.moverMeta}>{formatUsdCompact(item.volume)} traded</Text>
      </View>
      <View style={styles.moverProbability}>
        <Text style={styles.moverProbabilityValue}>{formatProbability(probability)}</Text>
        <Text style={styles.moverProbabilityLabel} numberOfLines={1}>{shortName(label)}</Text>
        <View style={styles.moverTrack}><View style={[styles.moverFill, { width: `${probability === null ? 0 : Math.max(0, Math.min(100, probability * 100))}%` }]} /></View>
      </View>
    </Pressable>
  );
}

function StateCard({ title, body, retry }: { title: string; body: string; retry?: () => void }) {
  return (
    <View style={styles.stateCard}>
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateBody}>{body}</Text>
      {retry ? (
        <Pressable accessibilityRole="button" onPress={retry} style={styles.retryButton}>
          <Text style={styles.retryText}>TRY AGAIN</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function BottomSheetShell({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={styles.modalRoot} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close sheet" style={styles.modalBackdrop} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: Math.max(20, insets.bottom + 12) }]}>
          <View style={styles.grabber} />
          <View style={styles.sheetTitleRow}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.sheetClose}>
              <MaterialIcons name="close" size={20} color={semantic.text.dim} />
            </Pressable>
          </View>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SearchRow({
  image,
  mark,
  title,
  subtitle,
  onPress,
}: {
  image?: string | null;
  mark: string;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      onPress={onPress}
      style={({ pressed }) => [styles.searchResultRow, pressed && styles.pressed]}
    >
      {image ? <Image source={image} style={styles.searchResultImage} contentFit="contain" transition={100} /> : (
        <View style={styles.searchResultMark}><Text style={styles.searchResultMarkText}>{mark}</Text></View>
      )}
      <View style={styles.searchResultCopy}>
        <Text style={styles.searchResultTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.searchResultSubtitle} numberOfLines={1}>{subtitle}</Text>
      </View>
      <MaterialIcons name="chevron-right" size={20} color={semantic.text.faint} />
    </Pressable>
  );
}

function SearchSheet({
  visible,
  onClose,
  onOpenEvent,
}: {
  visible: boolean;
  onClose: () => void;
  onOpenEvent: (event: PredictSearchEvent) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PredictSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setResults(null);
      setError(null);
    }
  }, [visible]);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      void fetchPredictSearch(normalized, controller.signal)
        .then((response) => setResults(response))
        .catch((caught: unknown) => {
          if (caught instanceof Error && caught.name === 'AbortError') return;
          setError('Search is unavailable right now.');
          setResults(null);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 280);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const hasResults = Boolean(results && (results.events.length || results.teams.length || results.tags.length));

  return (
    <BottomSheetShell visible={visible} title="Search Predict" onClose={onClose}>
      <View style={styles.searchField}>
        <MaterialIcons name="search" size={20} color={semantic.text.faint} />
        <TextInput
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder="Team, coin, person, or question"
          placeholderTextColor={semantic.text.faint}
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search markets, teams, and leagues"
          style={styles.searchInput}
        />
        {query ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} style={styles.clearSearch}>
            <MaterialIcons name="cancel" size={18} color={semantic.text.faint} />
          </Pressable>
        ) : null}
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={styles.sheetResults}>
        {query.trim().length < 2 ? (
          <>
            <Text style={styles.sheetLabel}>TRY SEARCHING</Text>
            <SearchRow mark="₿" title="Bitcoin" subtitle="Fast markets and predictions" onPress={() => setQuery('Bitcoin')} />
            <SearchRow mark="PL" title="Premier League" subtitle="Live matches and season predictions" onPress={() => setQuery('Premier League')} />
            <SearchRow mark="IN" title="India" subtitle="Cricket, politics, and economy" onPress={() => setQuery('India')} />
          </>
        ) : null}
        {loading ? <View style={styles.searchLoading}><ActivityIndicator color={tokens.colors.accent} /></View> : null}
        {error ? <Text style={styles.searchError}>{error}</Text> : null}
        {!loading && !error && query.trim().length >= 2 && !hasResults ? (
          <Text style={styles.searchEmpty}>No active results found.</Text>
        ) : null}
        {results?.events.length ? <Text style={styles.sheetLabel}>MARKETS</Text> : null}
        {results?.events.map((event) => (
          <SearchRow
            key={`event-${event.id}`}
            image={event.image}
            mark={event.kind === 'sports' ? 'VS' : '?'}
            title={event.title}
            subtitle={`${event.kind === 'sports' ? 'Sports market' : 'Prediction'}${event.volume24h !== null ? ` · ${formatUsdCompact(event.volume24h)} traded` : ''}`}
            onPress={() => onOpenEvent(event)}
          />
        ))}
        {results?.teams.length ? <Text style={styles.sheetLabel}>TEAMS</Text> : null}
        {results?.teams.map((team) => (
          <SearchRow
            key={`team-${team.id}`}
            image={team.logo}
            mark={team.abbreviation?.slice(0, 3).toUpperCase() ?? team.name.slice(0, 2).toUpperCase()}
            title={team.name}
            subtitle={team.league ?? 'Team'}
            onPress={() => setQuery(team.name)}
          />
        ))}
        {results?.tags.length ? <Text style={styles.sheetLabel}>TOPICS</Text> : null}
        {results?.tags.map((tag) => (
          <SearchRow
            key={`tag-${tag.id}`}
            mark="#"
            title={tag.label}
            subtitle="Browse related active markets"
            onPress={() => setQuery(tag.label)}
          />
        ))}
      </ScrollView>
    </BottomSheetShell>
  );
}

export default function PredictDiscoverScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { signer } = useChainSigner(POLYMARKET_REQUIREMENT);
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [round, setRound] = useState<UpDownRound | null>(null);
  const [history, setHistory] = useState<UpDownHistory | null>(null);
  const [livePrices, setLivePrices] = useState<LivePriceMap>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [upDownError, setUpDownError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<CategoryTab>('Discover');
  const [selectedLeague, setSelectedLeague] = useState<string | null>(null);
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [leagueOpen, setLeagueOpen] = useState(false);
  const [leagueQuery, setLeagueQuery] = useState('');
  const [showAllLive, setShowAllLive] = useState(false);
  const [showAllUpcoming, setShowAllUpcoming] = useState(false);
  const [showAllMovers, setShowAllMovers] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pollInFlight = useRef(false);

  const featuredWidth = Math.min(342, Math.max(272, width - 48));
  const railWidth = Math.min(264, Math.max(236, width - 72));

  const loadDiscover = useCallback(async (showLoading: boolean) => {
    if (showLoading) setLoading(true);
    const feedTask = fetchFeaturedMarkets()
      .then((response) => {
        setFeed(response);
        setFeedError(null);
      })
      .catch(() => setFeedError('Markets could not be loaded.'));
    const roundTask = fetchUpDownRounds()
      .then((response) => {
        setRound(response.btc.hourly);
        setUpDownError(response.btc.hourly ? null : 'The next Bitcoin round is not available yet.');
      })
      .catch(() => setUpDownError('The Bitcoin fast market could not be loaded.'));
    void fetchUpDownHistory('btc', 'hourly')
      .then(setHistory)
      .catch(() => {
        // The card remains usable with prices and a clearly labelled chart state.
      });
    await Promise.allSettled([feedTask, roundTask]);
    if (showLoading) setLoading(false);
  }, []);

  useEffect(() => {
    void loadDiscover(true);
  }, [loadDiscover]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useFocusedAppStateInterval(async (isCurrent) => {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const [roundResult, historyResult] = await Promise.allSettled([
        fetchUpDownRounds(),
        fetchUpDownHistory('btc', 'hourly'),
      ]);
      if (!isCurrent()) return;
      if (roundResult.status === 'fulfilled') setRound(roundResult.value.btc.hourly);
      if (historyResult.status === 'fulfilled') setHistory(historyResult.value);
    } finally {
      pollInFlight.current = false;
    }
  }, 10_000, { enabled: true, runImmediately: false });

  const allItems = feed?.items ?? [];
  const visibleItems = useMemo(() => allItems.filter((item) => (
    categoryMatches(item, activeCategory) && (!selectedLeague || (item.type === 'match' && item.sport === selectedLeague))
  )), [activeCategory, allItems, selectedLeague]);
  const liveMatches = useMemo(() => visibleItems.filter((item): item is FeedItemMatch => item.type === 'match' && item.status === 'live'), [visibleItems]);
  const upcomingMatches = useMemo(() => visibleItems.filter((item): item is FeedItemMatch => item.type === 'match' && item.status === 'upcoming'), [visibleItems]);
  const rankedMovers = useMemo(() => [...visibleItems].filter((item) => item.volume > 0).sort((a, b) => b.volume - a.volume), [visibleItems]);
  const movers = showAllMovers ? rankedMovers : rankedMovers.slice(0, 3);
  const featuredItems = useMemo(() => [...allItems].sort((a, b) => {
    if (a.status === 'live' && b.status !== 'live') return -1;
    if (a.status !== 'live' && b.status === 'live') return 1;
    return b.volume - a.volume;
  }).slice(0, 3), [allItems]);
  const tokenIds = useMemo(() => collectTokenIds(visibleItems), [visibleItems]);
  const tokenKey = tokenIds.join(',');

  useFocusedAppStateInterval(async (isCurrent) => {
    if (!tokenKey) return;
    try {
      const prices = await fetchLivePrices(tokenKey.split(','));
      if (isCurrent()) setLivePrices((current) => ({ ...current, ...prices }));
    } catch {
      // Cached collection probabilities remain visible when a live-price poll misses.
    }
  }, 30_000, { enabled: Boolean(tokenKey), runImmediately: true, resetKey: tokenKey });

  const leagues = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const item of allItems) {
      if (item.type !== 'match') continue;
      grouped.set(item.sport, (grouped.get(item.sport) ?? 0) + 1);
    }
    return [...grouped.entries()]
      .map(([sport, count]) => ({ sport, count, label: LEAGUE_LABELS[sport] ?? sport.toUpperCase() }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [allItems]);
  const shownLeagues = leagues.filter((league) => league.label.toLowerCase().includes(leagueQuery.trim().toLowerCase()));

  const openItem = useCallback((item: FeedItem) => {
    router.push(getPredictMarketHref(item.slug));
  }, [router]);

  const selectLeague = useCallback((sport: string) => {
    setSelectedLeague(sport);
    setActiveCategory('Sports');
    setLeagueOpen(false);
    setLeagueQuery('');
  }, []);

  const selectCategory = useCallback((category: CategoryTab) => {
    setActiveCategory(category);
    setSelectedLeague(null);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await loadDiscover(false);
    setRefreshing(false);
  }, [loadDiscover]);

  const openSearchEvent = useCallback((event: PredictSearchEvent) => {
    setSearchOpen(false);
    const slug = event.kind === 'sports' ? event.slug : event.detailSlug;
    router.push(getPredictMarketHref(slug));
  }, [router]);

  const featuredCount = (round ? 1 : 0) + featuredItems.length;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
        left={(
          <View style={styles.headerBrand}>
            <AppTopBarLogo />
            <View style={styles.headerDivider} />
            <Text style={styles.headerSection}>PREDICT</Text>
          </View>
        )}
        right={(
          <AppProfileButton
            onPress={() => router.push('/markets/polymarket/profile')}
            connected={Boolean(signer)}
            label="Open Predict profile"
            hint="View your Predict account, picks, and winnings"
            backgroundColor={tokens.colors.accent}
            borderColor={tokens.colors.accent}
            iconColor={tokens.colors.backgroundDark}
          />
        )}
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: 100 + insets.bottom }]}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={tokens.colors.accent} />}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.categoryNav}
          contentContainerStyle={styles.categoryRail}
          accessibilityRole="tablist"
        >
          {CATEGORY_TABS.map((category) => {
            const active = category === activeCategory;
            return (
              <Pressable
                key={category}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => selectCategory(category)}
                style={[styles.categoryTab, active && styles.categoryTabActive]}
              >
                <Text style={[styles.categoryText, active && styles.categoryTextActive]}>{category}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.featuredSection}>
          <SectionHeading title="✦  Featured" action="Swipe" />
          {loading ? (
            <View style={[styles.loadingCard, { width: featuredWidth }]}><ActivityIndicator color={tokens.colors.accent} /></View>
          ) : featuredCount > 0 ? (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                decelerationRate="fast"
                snapToInterval={featuredWidth + 10}
                snapToAlignment="start"
                contentContainerStyle={styles.featuredRail}
                onMomentumScrollEnd={(event) => setFeaturedIndex(Math.round(event.nativeEvent.contentOffset.x / (featuredWidth + 10)))}
              >
                {round ? (
                  <OneTapCard round={round} history={history} now={now} width={featuredWidth} onPress={() => router.push('/markets/polymarket/updown')} />
                ) : null}
                {featuredItems.map((item) => (
                  <FeaturedMarketCard key={item.slug} item={item} livePrices={livePrices} width={featuredWidth} onPress={() => openItem(item)} />
                ))}
              </ScrollView>
              <View style={styles.featuredDots}>
                {Array.from({ length: featuredCount }, (_, index) => (
                  <View key={index} style={[styles.featuredDot, featuredIndex === index && styles.featuredDotActive]} />
                ))}
              </View>
            </>
          ) : (
            <StateCard title="Featured markets unavailable" body={upDownError ?? feedError ?? 'Pull down to refresh.'} retry={() => void loadDiscover(true)} />
          )}
          {upDownError && featuredItems.length > 0 ? <Text style={styles.inlineNotice}>{upDownError}</Text> : null}
        </View>

        <View style={styles.content}>
          {feedError && !feed ? <StateCard title="Markets unavailable" body={feedError} retry={() => void loadDiscover(true)} /> : null}
          {!loading && feed && visibleItems.length === 0 ? (
            <StateCard
              title={selectedLeague ? `${LEAGUE_LABELS[selectedLeague] ?? selectedLeague} is quiet` : `No ${activeCategory.toLowerCase()} markets`}
              body="There are no active markets in the published collection right now."
            />
          ) : null}

          {liveMatches.length > 0 ? (
            <View style={styles.shelf}>
              <SectionHeading title="Live now" action={showAllLive ? 'Show less' : 'See all'} live onAction={() => setShowAllLive((value) => !value)} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalRail}>
                {(showAllLive ? liveMatches : liveMatches.slice(0, 6)).map((item) => (
                  <MatchCard key={item.slug} item={item} livePrices={livePrices} width={railWidth} onPress={() => openItem(item)} />
                ))}
              </ScrollView>
            </View>
          ) : null}

          {upcomingMatches.length > 0 ? (
            <View style={styles.shelf}>
              <SectionHeading title="Coming up" action={showAllUpcoming ? 'Show less' : 'See all'} onAction={() => setShowAllUpcoming((value) => !value)} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalRail}>
                {(showAllUpcoming ? upcomingMatches : upcomingMatches.slice(0, 8)).map((item) => (
                  <MatchCard key={item.slug} item={item} livePrices={livePrices} width={railWidth} onPress={() => openItem(item)} />
                ))}
              </ScrollView>
            </View>
          ) : null}

          {leagues.length > 0 ? (
            <View style={styles.shelf}>
              <SectionHeading title="Browse by league" action="All leagues" onAction={() => setLeagueOpen(true)} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalRail}>
                {leagues.slice(0, 6).map((league) => (
                  <LeagueCard key={league.sport} {...league} onPress={() => selectLeague(league.sport)} />
                ))}
              </ScrollView>
            </View>
          ) : null}

          {movers.length > 0 ? (
            <View style={styles.shelf}>
              <SectionHeading title="What's moving" action={showAllMovers ? 'Show less' : 'See all'} onAction={() => setShowAllMovers((value) => !value)} />
              <View style={styles.moversList}>
                {movers.map((item) => <MoverCard key={item.slug} item={item} livePrices={livePrices} onPress={() => openItem(item)} />)}
              </View>
            </View>
          ) : null}

          {feed ? (
            <Text style={styles.educationCopy}>
              Prices are the crowd's live estimate, not a guarantee. Choose only when the question is clear to you.{`\n\n`}Prices run from 1¢ to 99¢. A price is also the chance of that outcome, and each share pays $1.00 if you're right.
            </Text>
          ) : null}
        </View>
      </ScrollView>

      <View style={[styles.bottomSearch, { paddingBottom: Math.max(8, insets.bottom) }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Search markets, teams, and leagues"
          onPress={() => setSearchOpen(true)}
          style={({ pressed }) => [styles.bottomSearchButton, pressed && styles.cardPressed]}
        >
          <View style={styles.bottomSearchIcon}><MaterialIcons name="search" size={20} color={tokens.colors.accent} /></View>
          <View style={styles.bottomSearchCopy}>
            <Text style={styles.bottomSearchTitle}>Search Predict</Text>
            <Text style={styles.bottomSearchSubtitle}>Markets, teams, leagues</Text>
          </View>
          <MaterialIcons name="keyboard-arrow-up" size={20} color={semantic.text.faint} />
        </Pressable>
      </View>

      <SearchSheet visible={searchOpen} onClose={() => setSearchOpen(false)} onOpenEvent={openSearchEvent} />

      <BottomSheetShell visible={leagueOpen} title="Find a league" onClose={() => setLeagueOpen(false)}>
        <View style={styles.searchField}>
          <MaterialIcons name="search" size={20} color={semantic.text.faint} />
          <TextInput
            value={leagueQuery}
            onChangeText={setLeagueQuery}
            placeholder="Search football, cricket, F1"
            placeholderTextColor={semantic.text.faint}
            accessibilityLabel="Search leagues"
            autoCorrect={false}
            style={styles.searchInput}
          />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={styles.sheetResults}>
          <Text style={styles.sheetLabel}>PUBLISHED LEAGUES</Text>
          {shownLeagues.map((league) => (
            <SearchRow
              key={league.sport}
              mark={LEAGUE_MARKS[league.sport] ?? league.sport.slice(0, 3).toUpperCase()}
              title={league.label}
              subtitle={`${league.count} live and upcoming ${league.count === 1 ? 'market' : 'markets'}`}
              onPress={() => selectLeague(league.sport)}
            />
          ))}
          {shownLeagues.length === 0 ? <Text style={styles.searchEmpty}>No published leagues found.</Text> : null}
        </ScrollView>
      </BottomSheetShell>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.colors.backgroundDark },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 104 },
  headerBrand: { flexDirection: 'row', alignItems: 'center' },
  headerDivider: { width: 1, height: 30, marginLeft: 4, marginRight: 14, backgroundColor: tokens.colors.borderMuted },
  headerSection: { color: semantic.text.dim, fontFamily: 'monospace', fontSize: 9, letterSpacing: 2.1 },
  categoryNav: { flexGrow: 0, borderTopWidth: 1, borderBottomWidth: 1, borderColor: 'rgba(24,90,112,0.7)' },
  categoryRail: { minWidth: '100%', paddingHorizontal: 12, paddingVertical: 9, gap: 5 },
  categoryTab: { minHeight: 34, minWidth: 62, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  categoryTabActive: { backgroundColor: tokens.colors.primary },
  categoryText: { color: semantic.text.faint, fontSize: 11, fontWeight: '700' },
  categoryTextActive: { color: semantic.text.primary },
  featuredSection: { paddingTop: 20 },
  sectionHeading: { minHeight: 32, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  sectionTitle: { color: semantic.text.dim, fontFamily: 'monospace', fontSize: 9, fontWeight: '800', letterSpacing: 1.8, textTransform: 'uppercase' },
  sectionActionButton: { minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
  sectionAction: { color: tokens.colors.accent, fontFamily: 'monospace', fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },
  liveDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: tokens.colors.live, borderWidth: 2, borderColor: tokens.colors.backgroundDark },
  featuredRail: { paddingHorizontal: 16, gap: 10 },
  featuredDots: { paddingTop: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  featuredDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: tokens.colors.borderMuted },
  featuredDotActive: { width: 17, backgroundColor: tokens.colors.accent },
  loadingCard: { height: 218, marginLeft: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 24, borderWidth: 1, borderColor: tokens.colors.borderMuted, backgroundColor: tokens.colors.ground },
  oneTapCard: { height: 218, padding: 13, overflow: 'hidden', borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,209,102,0.42)', backgroundColor: tokens.colors.ground },
  oneTapTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  assetLockup: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 9 },
  coinMark: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.accent },
  coinText: { color: tokens.colors.backgroundDark, fontSize: 17, fontWeight: '900' },
  assetCopy: { flex: 1, minWidth: 0 },
  assetName: { color: semantic.text.primary, fontSize: 14, fontWeight: '800' },
  assetQuestion: { marginTop: 2, color: semantic.text.dim, fontSize: 8, lineHeight: 11 },
  oneTapMark: { color: tokens.colors.accent, fontFamily: 'monospace', fontSize: 7, fontWeight: '900', letterSpacing: 0.7 },
  durationChip: { minWidth: 68, minHeight: 31, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderWidth: 1, borderColor: tokens.colors.borderMuted, borderRadius: 16, backgroundColor: 'rgba(3,31,44,0.28)' },
  durationText: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 8, fontWeight: '800' },
  priceRow: { marginTop: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  dataLabel: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 7, fontWeight: '800', letterSpacing: 1.4, textTransform: 'uppercase' },
  currentPrice: { marginTop: 3, color: semantic.text.primary, fontFamily: 'monospace', fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'] },
  targetCopy: { alignItems: 'flex-end' },
  targetPrice: { marginTop: 3, color: tokens.colors.accent, fontFamily: 'monospace', fontSize: 13, fontWeight: '900', fontVariant: ['tabular-nums'] },
  chartWrap: { height: 70, marginTop: 2, position: 'relative', overflow: 'hidden' },
  chartFallback: { height: 70, marginTop: 2, justifyContent: 'center', borderBottomWidth: 1, borderBottomColor: tokens.colors.borderMuted },
  chartFallbackText: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8 },
  targetTag: { position: 'absolute', right: 0, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5, overflow: 'hidden', backgroundColor: tokens.colors.accent, color: tokens.colors.backgroundDark, fontFamily: 'monospace', fontSize: 6, fontWeight: '900' },
  oneTapBottom: { height: 32, paddingTop: 5, borderTopWidth: 1, borderTopColor: 'rgba(24,90,112,0.65)', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  countdownRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  countdownDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: tokens.colors.live },
  countdownValue: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 13, fontWeight: '900', fontVariant: ['tabular-nums'] },
  countdownLabel: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 7, textTransform: 'uppercase' },
  sidePills: { flexDirection: 'row', gap: 4 },
  higherPill: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 9, backgroundColor: 'rgba(6,214,160,0.08)' },
  lowerPill: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 9, backgroundColor: 'rgba(239,71,111,0.08)' },
  higherText: { color: tokens.colors.viridian, fontFamily: 'monospace', fontSize: 8 },
  lowerText: { color: tokens.colors.vermillion, fontFamily: 'monospace', fontSize: 8 },
  sideStrong: { fontWeight: '900' },
  cardHint: { position: 'absolute', right: 15, bottom: 0, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 5, overflow: 'hidden', backgroundColor: tokens.colors.accent, color: tokens.colors.backgroundDark, fontFamily: 'monospace', fontSize: 6, fontWeight: '900', letterSpacing: 0.6 },
  matchCard: { height: 166, padding: 13, borderRadius: 20, borderWidth: 1, borderColor: tokens.colors.borderMuted, backgroundColor: tokens.colors.ground },
  matchMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  leagueKicker: { flex: 1, color: semantic.text.faint, fontFamily: 'monospace', fontSize: 7, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase' },
  liveStatus: { color: tokens.colors.live, fontFamily: 'monospace', fontSize: 7, fontWeight: '900', letterSpacing: 0.7 },
  matchTime: { color: tokens.colors.accent, fontFamily: 'monospace', fontSize: 7, fontWeight: '900' },
  matchup: { flex: 1, paddingVertical: 9, flexDirection: 'row', alignItems: 'center' },
  teamBlock: { flex: 1, minWidth: 0, alignItems: 'flex-start', gap: 5 },
  teamBlockRight: { alignItems: 'flex-end' },
  crestImage: { width: 38, height: 38 },
  crestFallback: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 19, borderWidth: 1, borderColor: tokens.colors.borderMuted, backgroundColor: tokens.colors.surface },
  crestFallbackText: { color: tokens.colors.accent, fontFamily: 'monospace', fontSize: 8, fontWeight: '900' },
  teamName: { maxWidth: '100%', color: semantic.text.primary, fontSize: 11, fontWeight: '800' },
  teamNameRight: { textAlign: 'right' },
  versusBlock: { width: 58, alignItems: 'center', gap: 2 },
  versus: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 13, fontWeight: '900' },
  moneyline: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 6, letterSpacing: 0.5 },
  moneylineLive: { color: tokens.colors.live, fontFamily: 'monospace', fontSize: 6, letterSpacing: 0.5 },
  oddsGrid: { flexDirection: 'row', gap: 5 },
  oddsGridTwo: { justifyContent: 'space-between' },
  oddChip: { minWidth: 0, flex: 1, height: 31, paddingHorizontal: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4, borderRadius: 8, backgroundColor: tokens.colors.surface },
  oddLabel: { flex: 1, color: semantic.text.dim, fontSize: 8 },
  oddValue: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 8, fontWeight: '900', fontVariant: ['tabular-nums'] },
  featureBinary: { height: 166, padding: 15, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(17,138,178,0.55)', backgroundColor: tokens.colors.ground },
  featureBinaryTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  featureKicker: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8, letterSpacing: 1.2 },
  featureEnd: { color: semantic.text.dim, fontFamily: 'monospace', fontSize: 7 },
  featureBinaryMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  featureImage: { width: 46, height: 46, borderRadius: 13, backgroundColor: tokens.colors.surface },
  featureQuestion: { flex: 1, color: semantic.text.primary, fontSize: 16, lineHeight: 20, fontWeight: '900' },
  probabilityRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  probabilityValue: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 20, fontWeight: '900' },
  probabilityLabel: { color: semantic.text.faint, fontSize: 8 },
  featureVolume: { color: semantic.text.dim, fontFamily: 'monospace', fontSize: 8 },
  probabilityTrack: { height: 4, marginTop: 7, overflow: 'hidden', borderRadius: 2, backgroundColor: tokens.colors.surface },
  probabilityFill: { height: 4, borderRadius: 2, backgroundColor: tokens.colors.primary },
  inlineNotice: { marginHorizontal: 16, marginTop: 8, color: semantic.text.faint, fontSize: 9 },
  content: { paddingTop: 28, gap: 30 },
  shelf: { gap: 6 },
  horizontalRail: { paddingHorizontal: 16, gap: 10 },
  leagueCard: { minWidth: 168, height: 58, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, borderWidth: 1, borderColor: tokens.colors.borderMuted, backgroundColor: tokens.colors.ground },
  leagueMark: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: tokens.colors.surface },
  leagueMarkText: { color: tokens.colors.accent, fontFamily: 'monospace', fontSize: 9, fontWeight: '900' },
  leagueName: { maxWidth: 116, color: semantic.text.primary, fontSize: 10, fontWeight: '800' },
  leagueCount: { marginTop: 2, color: semantic.text.faint, fontFamily: 'monospace', fontSize: 7 },
  moversList: { paddingHorizontal: 16, gap: 7 },
  moverCard: { minHeight: 86, padding: 12, flexDirection: 'row', gap: 12, borderRadius: 16, borderWidth: 1, borderColor: tokens.colors.borderMuted, backgroundColor: tokens.colors.ground },
  moverCopy: { flex: 1, minWidth: 0 },
  moverKicker: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 7, letterSpacing: 0.8 },
  moverQuestion: { marginTop: 5, color: semantic.text.primary, fontSize: 12, lineHeight: 16, fontWeight: '800' },
  moverMeta: { marginTop: 4, color: semantic.text.faint, fontFamily: 'monospace', fontSize: 7 },
  moverProbability: { width: 82, alignItems: 'flex-end', justifyContent: 'center' },
  moverProbabilityValue: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 19, fontWeight: '900', fontVariant: ['tabular-nums'] },
  moverProbabilityLabel: { maxWidth: 82, color: semantic.text.faint, fontSize: 7 },
  moverTrack: { width: 70, height: 3, marginTop: 7, overflow: 'hidden', borderRadius: 2, backgroundColor: tokens.colors.surface },
  moverFill: { height: 3, backgroundColor: tokens.colors.primary },
  educationCopy: { marginHorizontal: 16, color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8, lineHeight: 13, textAlign: 'center' },
  stateCard: { marginHorizontal: 16, padding: 18, gap: 7, borderRadius: 16, borderWidth: 1, borderColor: tokens.colors.borderMuted, backgroundColor: tokens.colors.ground },
  stateTitle: { color: semantic.text.primary, fontSize: 14, fontWeight: '800' },
  stateBody: { color: semantic.text.dim, fontSize: 11, lineHeight: 16 },
  retryButton: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 12, borderRadius: 9, backgroundColor: tokens.colors.accent },
  retryText: { color: tokens.colors.backgroundDark, fontFamily: 'monospace', fontSize: 8, fontWeight: '900' },
  bottomSearch: { position: 'absolute', right: 0, bottom: 0, left: 0, paddingHorizontal: 12, paddingTop: 8, backgroundColor: 'rgba(7,59,76,0.96)' },
  bottomSearchButton: { minHeight: 47, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, borderWidth: 1, borderColor: tokens.colors.borderMuted, backgroundColor: tokens.colors.surface },
  bottomSearchIcon: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: tokens.colors.ground },
  bottomSearchCopy: { flex: 1 },
  bottomSearchTitle: { color: semantic.text.primary, fontSize: 11, fontWeight: '800' },
  bottomSearchSubtitle: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 7 },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(3,31,44,0.74)' },
  sheet: { maxHeight: '78%', paddingHorizontal: 16, paddingTop: 10, borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: 1, borderBottomWidth: 0, borderColor: tokens.colors.borderMuted, backgroundColor: tokens.colors.ground },
  grabber: { width: 36, height: 4, alignSelf: 'center', marginBottom: 16, borderRadius: 2, backgroundColor: tokens.colors.borderMuted },
  sheetTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: semantic.text.primary, fontSize: 24, fontWeight: '900', letterSpacing: -1 },
  sheetClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: tokens.colors.surface },
  searchField: { height: 46, marginTop: 12, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 13, borderWidth: 1, borderColor: tokens.colors.borderMuted, backgroundColor: tokens.colors.surface },
  searchInput: { flex: 1, height: 44, color: semantic.text.primary, fontSize: 12 },
  clearSearch: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  sheetResults: { marginTop: 4 },
  sheetLabel: { marginTop: 16, marginBottom: 3, color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  searchResultRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 11, borderTopWidth: 1, borderTopColor: 'rgba(24,90,112,0.55)' },
  searchResultImage: { width: 34, height: 34, borderRadius: 10, backgroundColor: tokens.colors.surface },
  searchResultMark: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: tokens.colors.surface },
  searchResultMarkText: { color: tokens.colors.accent, fontFamily: 'monospace', fontSize: 9, fontWeight: '900' },
  searchResultCopy: { flex: 1, minWidth: 0 },
  searchResultTitle: { color: semantic.text.primary, fontSize: 11, fontWeight: '800' },
  searchResultSubtitle: { marginTop: 2, color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8 },
  searchLoading: { minHeight: 100, alignItems: 'center', justifyContent: 'center' },
  searchError: { paddingVertical: 22, color: tokens.colors.vermillion, fontSize: 11 },
  searchEmpty: { paddingVertical: 22, color: semantic.text.dim, fontSize: 11 },
  pressed: { opacity: 0.7 },
  cardPressed: { opacity: 0.84, transform: [{ scale: 0.99 }] },
});
