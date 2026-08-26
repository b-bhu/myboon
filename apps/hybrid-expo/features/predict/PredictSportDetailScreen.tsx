import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import {
  ActivityIndicator,
  Alert,
  Animated,
  PanResponder,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppTopBar, AppTopBarCashPill, AppTopBarIconButton, AppTopBarTitle } from '@/components/AppTopBar';
import { cancelOrder, fetchClobBalance, fetchLivePrices, fetchMarketPositions, fetchOpenOrders, fetchOrderbook, fetchPortfolio, fetchPriceHistory, fetchSportMarketDetail, placeBet } from '@/features/predict/predict.api';
import type { ActivityItem, ClosedPortfolioPosition, OpenOrder, PortfolioPosition } from '@/features/predict/predict.api';
import type { FeedTeam, PricePoint, SportMarketDetail, SportOutcomeDetail, Orderbook } from '@/features/predict/predict.types';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { usePolymarketWallet } from '@/hooks/usePolymarketWallet';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import { semantic, tokens } from '@/theme';
import { formatUsdCompact } from '@/lib/format';
import { useOddsFormat } from '@/hooks/useOddsFormat';
import { MultiLineChart } from '@/features/predict/components/MultiLineChart';
import { OrderbookView } from '@/features/predict/components/OrderbookView';
import { OrderComposerSheet } from '@/features/predict/components/OrderComposerSheet';
import type { ComposerMode } from '@/features/predict/components/OrderComposerSheet';
import { SportsMatchupHeader } from '@/features/predict/components/SportsMatchupHeader';
import { DetailPicksPanel } from '@/features/predict/components/DetailPicksPanel';
import { CashOutConfirmModal } from '@/features/predict/components/CashOutConfirmModal';
import { DetailPositionSheet } from '@/features/predict/components/DetailPositionSheet';
import { formatPredictTitle } from '@/features/predict/formatPredictTitle';
import { truncateUsd } from '@/features/predict/formatPredictMoney';
import { buildExecutableBuyQuote, getBestAsk } from '@/features/predict/orderbookQuote';
import { getMinimumOrderGuardrail } from '@/features/predict/minimumOrderSize';
import { usePositionSellQuotes } from '@/features/predict/positionSellQuotes';
import { makePendingOpenOrder, mergeOpenOrders, prunePendingOpenOrders } from '@/features/predict/pendingOpenOrders';
import {
  applyPredictUserEvent,
  isPredictTradeEvent,
  usePolymarketUserStream,
} from '@/features/predict/usePolymarketUserStream';
import { getPredictOrderGuardrail, type PredictDataFreshness } from '@/features/predict/predictActivityState';
import { getPredictMarketHref } from '@/features/predict/predict.navigation';

interface PredictSportDetailScreenProps {
  sport: string;
  slug: string;
}

type Interval = '5m' | '1h' | '1d';
type ActiveView = 'picks' | 'stats' | 'chart' | 'orderbook';
type SubmitStatus = 'idle' | 'wallet' | 'placing' | 'syncing';

const SOFT_COLLAPSED = 280; // handle + stats + ~3 selection rows
const SOFT_EXPANDED = 720;

function outcomeColor(outcome: SportOutcomeDetail, isLead: boolean): string {
  if (outcome.label.toLowerCase().includes('draw')) return semantic.text.accent;
  return isLead ? semantic.sentiment.positive : semantic.sentiment.negative;
}

function sportOutcomeLabel(outcome: SportOutcomeDetail): string {
  return outcome.label.toLowerCase().includes('draw') ? 'Draw' : outcome.label;
}

function sportOutcomeKey(outcome: SportOutcomeDetail, index: number, surface: 'book' | 'pick'): string {
  const outcomeIdentity = outcome.clobTokenIds[0]
    ?? `${outcome.conditionId ?? 'market'}:${outcome.label}:${index}`;
  return `${outcomeIdentity}:${surface}`;
}

function outcomeTone(outcome: SportOutcomeDetail, index: number): 'lead' | 'draw' | 'trail' {
  if (outcome.label.toLowerCase().includes('draw')) return 'draw';
  return index === 0 ? 'lead' : 'trail';
}

function sortSportOutcomes(outcomes: SportOutcomeDetail[]): SportOutcomeDetail[] {
  const list = [...outcomes];
  const draw = list.find((outcome) => outcome.label.toLowerCase().includes('draw'));

  if (list.length === 3 && draw) {
    const teams = list.filter((outcome) => outcome !== draw);
    if (teams.length === 2) return [teams[0], draw, teams[1]];
  }
  return list;
}

function labelBinaryTeamOutcomes(outcomes: SportOutcomeDetail[], teams: FeedTeam[]): SportOutcomeDetail[] {
  if (teams.length < 2 || outcomes.length !== 2) return outcomes;
  let teamIndex = 0;
  return outcomes.map((outcome) => {
    const normalized = outcome.label.trim().toLowerCase();
    if (normalized !== 'yes' && normalized !== 'no') return outcome;
    const team = teams[teamIndex++];
    return team?.name ? { ...outcome, label: team.name } : outcome;
  });
}

function formatPositionOutcome(outcome: string | null | undefined): string {
  if (!outcome) return '';
  return outcome.toLowerCase().includes('draw') ? 'Draw' : outcome;
}

function DisplayTab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.displayTab, active && styles.displayTabActive]}>
      <Text style={[styles.displayTabText, active && styles.displayTabTextActive]}>{label}</Text>
    </Pressable>
  );
}

export function PredictSportDetailScreen({ sport, slug }: PredictSportDetailScreenProps) {
  const router = useRouter();
  const poly = usePolymarketWallet();
  const connectSheet = useConnectionSheet('evm');
  const { formatOdds } = useOddsFormat();
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // Market data
  const [detail, setDetail] = useState<SportMarketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [liveTokenPrices, setLiveTokenPrices] = useState<Record<string, number | null>>({});

  // Chart data
  const [interval, setInterval] = useState<Interval>('1h');
  const [seriesData, setSeriesData] = useState<PricePoint[][]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>('chart');
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null);
  const [orderbookLoading, setOrderbookLoading] = useState(false);
  const [buyBooks, setBuyBooks] = useState<Record<string, Orderbook | null>>({});
  const [obOutcomeIdx, setObOutcomeIdx] = useState(0);

  // Numpad state
  const [numpadOpen, setNumpadOpen] = useState(false);
  const [selectedOutcomeIdx, setSelectedOutcomeIdx] = useState<number | null>(null);
  const [selectedQuotePrice, setSelectedQuotePrice] = useState<number | null>(null);
  const [numpadAmount, setNumpadAmount] = useState('10');
  const [submitting, setSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle');
  const [pickScope, setPickScope] = useState<'market' | 'all'>('market');
  const [marketPositions, setMarketPositions] = useState<PortfolioPosition[]>([]);
  const [allPositions, setAllPositions] = useState<PortfolioPosition[]>([]);
  const [redeemablePositions, setRedeemablePositions] = useState<PortfolioPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<ClosedPortfolioPosition[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const [pendingOpenOrders, setPendingOpenOrders] = useState<OpenOrder[]>([]);
  const [picksLoading, setPicksLoading] = useState(false);
  const [picksFreshness, setPicksFreshness] = useState<PredictDataFreshness>({
    lastUpdatedAt: null,
    loading: false,
    stale: false,
    error: null,
  });
  const quotePositions = useMemo(() => {
    const seen = new Set<string>();
    const merged: PortfolioPosition[] = [];
    for (const position of [...marketPositions, ...allPositions]) {
      const key = `${position.conditionId}:${position.outcomeIndex}:${position.asset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(position);
    }
    return merged;
  }, [marketPositions, allPositions]);
  const { quotes: sellQuotes, booksByAsset: sellQuoteBooks } = usePositionSellQuotes(quotePositions);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [cashBalance, setCashBalance] = useState<number | null>(null);
  const [setupSubmitting, setSetupSubmitting] = useState(false);
  const [setupAfterConnect, setSetupAfterConnect] = useState(false);
  const [submitAfterSetup, setSubmitAfterSetup] = useState(false);
  const [cashOutPosition, setCashOutPosition] = useState<PortfolioPosition | null>(null);
  const [positionOpen, setPositionOpen] = useState(false);
  // Shared composer state (PRD §6) — the sports flow routes through the same
  // OrderComposerSheet as Yes/No; the InlineNumpad path is retired here.
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerParams, setComposerParams] = useState<{ mode: ComposerMode; limitPriceCents: number } | null>(null);

  // Soft zone animation
  const softZoneAnim = useRef(new Animated.Value(SOFT_COLLAPSED)).current;
  const reconcileTimeouts = useRef<ReturnType<typeof setTimeout>[]>([]);
  const submitInFlightRef = useRef(false);
  const buyBookRefreshInFlight = useRef(false);
  const connectionCompletedRef = useRef(false);
  // Predict settles on Polygon, so its cache scope is the EVM signer — never the
  // Solana wallet. Keying on Solana meant an email/EVM user read as disconnected
  // and a Solana disconnect wiped Predict state that did not depend on it.
  const walletScopedKey = poly.signer ? `${poly.signer.descriptor.address.toLowerCase()}:${poly.polygonAddress ?? ''}:${poly.tradingAddress ?? ''}` : 'disconnected';
  const walletScopedKeyRef = useRef(walletScopedKey);

  // Drag gesture — swipe down to collapse numpad
  const dragResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 10,
      onPanResponderRelease: (_, g) => {
        if (g.dy > 40) collapseNumpad();
      },
    })
  ).current;

  // Live badge pulse
  const livePulse = useRef(new Animated.Value(1)).current;

  const baseSortedOutcomes = useMemo(
    () => (detail ? labelBinaryTeamOutcomes(sortSportOutcomes(detail.outcomes), detail.teams) : []),
    [detail],
  );
  const sortedOutcomes = useMemo(
    () =>
      baseSortedOutcomes.map((outcome) => {
        const tokenId = outcome.clobTokenIds[0];
        const bestAsk = tokenId ? getBestAsk(buyBooks[tokenId] ?? null) : null;
        const livePrice = tokenId ? liveTokenPrices[tokenId] : null;
        const price = bestAsk ?? livePrice;
        return price !== null && price !== undefined ? { ...outcome, price } : outcome;
      }),
    [baseSortedOutcomes, buyBooks, liveTokenPrices],
  );
  const leadPrice = sortedOutcomes[0]?.price ?? null;
  const liveTokenKey = detail?.outcomes
    .map((outcome) => outcome.clobTokenIds[0])
    .filter(Boolean)
    .join(',') ?? '';

  async function loadDetail(silent = false) {
    if (!silent) setLoading(true);
    setErrorMessage(null);
    try {
      setDetail(await fetchSportMarketDetail(sport, slug));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load fixture');
      setDetail(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function loadHistory(outcomes: SportOutcomeDetail[], iv: Interval) {
    setHistoryLoading(true);
    try {
      const results = await Promise.all(
        outcomes.map((o) => {
          const tokenId = o.clobTokenIds[0];
          if (!tokenId) return Promise.resolve({ history: [] });
          return fetchPriceHistory(tokenId, iv);
        })
      );
      setSeriesData(results.map((r) => r.history));
    } catch {
      setSeriesData([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadOrderbook(outcomeIdx: number) {
    const tokenId = sortedOutcomes[outcomeIdx]?.clobTokenIds[0];
    if (!tokenId) return;
    setOrderbookLoading(true);
    try {
      setOrderbook(await fetchOrderbook(tokenId));
    } catch {
      setOrderbook(null);
    } finally {
      setOrderbookLoading(false);
    }
  }

  async function loadCashBalance() {
    const requestKey = walletScopedKeyRef.current;
    if (!poly.client) {
      setCashBalance(null);
      return;
    }
    const balance = await fetchClobBalance(poly.client).catch(() => null);
    if (walletScopedKeyRef.current !== requestKey) return;
    setCashBalance(balance?.balance ?? null);
  }

  async function loadPicks() {
    const requestKey = walletScopedKeyRef.current;
    if (!poly.client) {
      setMarketPositions([]);
      setAllPositions([]);
      setRedeemablePositions([]);
      setClosedPositions([]);
      setOpenOrders([]);
      setActivityItems([]);
      setPendingOpenOrders([]);
      setPicksFreshness({ lastUpdatedAt: null, loading: false, stale: false, error: null });
      return;
    }
    setPicksLoading(true);
    setPicksFreshness((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const [marketResult, portfolioResult, ordersResult] = await Promise.allSettled([
        fetchMarketPositions(poly.client, slug),
        fetchPortfolio(poly.client),
        fetchOpenOrders(poly.client),
      ]);
      if (walletScopedKeyRef.current !== requestKey) return;
      const now = Date.now();
      const market = marketResult.status === 'fulfilled' ? marketResult.value : null;
      const portfolio = portfolioResult.status === 'fulfilled' ? portfolioResult.value : null;
      const orders = ordersResult.status === 'fulfilled' ? ordersResult.value : null;

      if (market) setMarketPositions(market);
      if (portfolio) {
        setAllPositions(portfolio.positions ?? []);
        setRedeemablePositions(portfolio.redeemablePositions ?? []);
        setClosedPositions(portfolio.closedPositions ?? []);
        setActivityItems(portfolio.activity ?? []);
      }
      if (orders) setOpenOrders(orders);
      setPendingOpenOrders((pending) =>
        prunePendingOpenOrders(pending, orders ?? [], [
          ...(market ?? marketPositions),
          ...(portfolio?.positions ?? allPositions),
          ...(portfolio?.redeemablePositions ?? redeemablePositions),
        ], portfolio?.recentTrades ?? [])
      );
      const failed = marketResult.status === 'rejected' || portfolioResult.status === 'rejected' || ordersResult.status === 'rejected';
      setPicksFreshness({
        lastUpdatedAt: now,
        loading: false,
        stale: failed,
        error: failed ? 'Could not refresh' : null,
      });
    } catch {
      setPicksFreshness((prev) => ({ ...prev, loading: false, stale: true, error: 'Could not refresh' }));
    } finally {
      setPicksLoading(false);
    }
  }

  const realtimeStatus = usePolymarketUserStream(
    poly.client,
    (event) => {
      setOpenOrders((orders) => applyPredictUserEvent(orders, event));
      if (isPredictTradeEvent(event)) void loadPicks();
    },
    loadPicks,
  );

  useEffect(() => {
    if (activeView !== 'picks' || pendingOpenOrders.length === 0) return;
    const timer = globalThis.setInterval(() => { void loadPicks(); }, 5_000);
    return () => globalThis.clearInterval(timer);
  }, [activeView, pendingOpenOrders.length, slug, poly.polygonAddress, poly.tradingAddress]);

  async function handleCancelOrder(orderId: string) {
    if (!poly.client || cancellingOrderId) return;
    setCancellingOrderId(orderId);
    try {
      const result = await cancelOrder(poly.client, orderId);
      if (result.ok) {
        setOpenOrders((prev) => prev.map((order) =>
          order.id === orderId ? { ...order, status: 'cancel_requested' } : order
        ));
        void loadPicks();
      } else {
        Alert.alert('Cancel failed', result.error ?? 'Try again in a moment.');
      }
    } catch {
      Alert.alert('Cancel failed', 'Network error');
    } finally {
      setCancellingOrderId(null);
    }
  }

  async function refreshDetailScreen() {
    setRefreshing(true);
    try {
      await Promise.allSettled([
        loadDetail(true),
        loadPicks(),
        loadCashBalance(),
        activeView === 'orderbook' ? loadOrderbook(obOutcomeIdx) : Promise.resolve(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  function scheduleFollowUpReconcile() {
    const secureClient = poly.client;
    if (!secureClient) return;
    const requestKey = walletScopedKeyRef.current;
    const timeout = setTimeout(() => {
      reconcileTimeouts.current = reconcileTimeouts.current.filter((item) => item !== timeout);
      void Promise.allSettled([
        loadPicks(),
        fetchClobBalance(secureClient).then((balance) => {
          if (walletScopedKeyRef.current === requestKey) setCashBalance(balance?.balance ?? null);
        }),
      ]);
    }, 1_800);
    reconcileTimeouts.current.push(timeout);
  }

  useEffect(() => { void loadDetail(); }, [slug, sport]);

  useEffect(() => {
    return () => {
      reconcileTimeouts.current.forEach(clearTimeout);
      reconcileTimeouts.current = [];
    };
  }, []);

  useEffect(() => {
    if (walletScopedKeyRef.current === walletScopedKey) return;
    walletScopedKeyRef.current = walletScopedKey;
    reconcileTimeouts.current.forEach(clearTimeout);
    reconcileTimeouts.current = [];
    setMarketPositions([]);
    setAllPositions([]);
    setRedeemablePositions([]);
    setClosedPositions([]);
    setOpenOrders([]);
    setActivityItems([]);
    setPendingOpenOrders([]);
    setCashBalance(null);
    setCashOutPosition(null);
    setSetupAfterConnect(false);
    setPicksFreshness({ lastUpdatedAt: null, loading: false, stale: false, error: null });
  }, [walletScopedKey]);

  useFocusedAppStateInterval(async (isCurrent) => {
    const tokenIds = liveTokenKey.split(',').filter(Boolean);
    if (tokenIds.length === 0) return;
    try {
      const prices = await fetchLivePrices(tokenIds);
      if (isCurrent()) setLiveTokenPrices((prev) => ({ ...prev, ...prices }));
    } catch { /* silent */ }
  }, 30_000, {
    enabled: liveTokenKey.length > 0,
    runImmediately: true,
    resetKey: liveTokenKey,
  });

  useFocusedAppStateInterval(async (isCurrent) => {
    const tokenIds = liveTokenKey.split(',').filter(Boolean);
    if (tokenIds.length === 0 || buyBookRefreshInFlight.current) return;
    buyBookRefreshInFlight.current = true;
    try {
      const entries = await Promise.all(
        tokenIds.map(async (tokenId) => [tokenId, await fetchOrderbook(tokenId).catch(() => null)] as const),
      );
      if (isCurrent()) {
        setBuyBooks((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      }
    } finally {
      buyBookRefreshInFlight.current = false;
    }
  }, 10_000, {
    enabled: liveTokenKey.length > 0,
    runImmediately: true,
    resetKey: liveTokenKey,
  });

  useEffect(() => {
    if (sortedOutcomes.length > 0) void loadHistory(sortedOutcomes, interval);
  }, [detail, interval]);

  useEffect(() => {
    if (activeView === 'orderbook' && sortedOutcomes.length > 0) void loadOrderbook(obOutcomeIdx);
  }, [activeView, detail, obOutcomeIdx]);

  useEffect(() => {
    void loadPicks();
  }, [slug, poly.polygonAddress, poly.tradingAddress]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!poly.client) {
        setCashBalance(null);
        return;
      }
      const requestKey = walletScopedKeyRef.current;
      const balance = await fetchClobBalance(poly.client).catch(() => null);
      if (!cancelled && walletScopedKeyRef.current === requestKey) setCashBalance(balance?.balance ?? null);
    }
    void run();
    return () => { cancelled = true; };
  }, [poly.client]);

  // LIVE pulse
  useEffect(() => {
    if (detail?.status !== 'live') return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(livePulse, { toValue: 0.2, duration: 700, useNativeDriver: true }),
        Animated.timing(livePulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [detail?.status, livePulse]);

  // Animate soft zone
  useEffect(() => {
    Animated.timing(softZoneAnim, {
      toValue: numpadOpen ? SOFT_EXPANDED : SOFT_COLLAPSED,
      duration: 350,
      useNativeDriver: false,
    }).start();
  }, [numpadOpen, softZoneAnim]);

  // Build chart series
  const chartSeries = sortedOutcomes.map((outcome, i) => {
    const isLead = leadPrice !== null && outcome.price === leadPrice;
    return {
      points: seriesData[i] ?? [],
      color: outcomeColor(outcome, isLead),
      label: sportOutcomeLabel(outcome),
    };
  });

  function tapOdd(outcomeIdx: number) {
    if (submitInFlightRef.current || submitting) return;
    if (numpadOpen && selectedOutcomeIdx === outcomeIdx) {
      setNumpadOpen(false);
      setSelectedOutcomeIdx(null);
      return;
    }
    setSelectedOutcomeIdx(outcomeIdx);
    setSelectedQuotePrice(sortedOutcomes[outcomeIdx]?.price ?? null);
    setNumpadAmount('10');
    setNumpadOpen(true);
    setComposerOpen(true);
  }

  function backMorePosition(position: PortfolioPosition) {
    if (position.slug && position.slug !== slug) {
      router.push(getPredictMarketHref(position.slug));
      return;
    }
    const byOutcome = sortedOutcomes.findIndex((outcome) =>
      sportOutcomeLabel(outcome).toLowerCase() === formatPositionOutcome(position.outcome).toLowerCase()
    );
    if (byOutcome >= 0) {
      tapOdd(byOutcome);
      return;
    }
    const byIndex = sortedOutcomes.findIndex((outcome) => outcome.conditionId === position.conditionId);
    tapOdd(byIndex >= 0 ? byIndex : 0);
  }

  function collapseNumpad() {
    setNumpadOpen(false);
    setSelectedOutcomeIdx(null);
    setSelectedQuotePrice(null);
    setComposerOpen(false);
    setComposerParams(null);
  }

  async function submitOrder(paramsOverride?: { mode: ComposerMode; limitPriceCents: number } | null) {
    if (!detail || selectedOutcomeIdx === null || submitting || submitInFlightRef.current) return;
    const amount = parseFloat(numpadAmount);
    if (!amount || amount <= 0) return;

    const outcome = sortedOutcomes[selectedOutcomeIdx];
    if (!outcome) return;

    const tokenID = outcome.clobTokenIds[0];
    if (!tokenID) {
      Alert.alert('Error', 'No token ID for this outcome');
      return;
    }

    const price = outcome.price;
    if (!price || price <= 0 || price >= 1) {
      Alert.alert('Error', 'Invalid price');
      return;
    }
    const marketActive = detail.active !== false && detail.status !== 'closed';
    const guardrail = getPredictOrderGuardrail({
      amount,
      availableCash: cashBalance,
      selectedPrice: selectedQuotePrice,
      latestPrice: price,
      marketActive,
      submitting,
    });
    if (guardrail?.blocking) {
      Alert.alert(guardrail.title, guardrail.message);
      return;
    }

    submitInFlightRef.current = true;
    setSubmitting(true);
    setSubmitStatus(poly.canSignLocally ? 'placing' : 'wallet');
    try {
      // Ensure the Polymarket session is set up against the resolved EVM signer
      if (!poly.canSignLocally) {
        await poly.enable();
        setSubmitStatus('placing');
      }

      if (!poly.client) throw new Error('Wallet session not ready');

      const freshBook = await fetchOrderbook(tokenID).catch(() => null);
      const quote = buildExecutableBuyQuote(freshBook, amount);
      // Limit mode: rest a GTC order at the user's chosen price instead of
      // executing at the book average. Size = spend / chosen price. Client-side
      // GTD (auto-cancel at kickoff) is a flagged follow-up in the PRD.
      const resolvedComposerParams = paramsOverride ?? composerParams;
      const effectiveLimitCents =
        resolvedComposerParams?.mode === 'limit' && resolvedComposerParams.limitPriceCents > 0
          ? resolvedComposerParams.limitPriceCents
          : null;
      if (effectiveLimitCents === null && (!quote.executable || quote.limitPrice === null || quote.shares <= 0)) {
        Alert.alert('Not filled', 'Not enough liquidity at the current price. Try a smaller amount or refresh the market.');
        return;
      }
      const effectivePrice = effectiveLimitCents !== null
        ? effectiveLimitCents / 100
        : quote.averagePrice;
      const effectiveShares = effectiveLimitCents !== null
        ? amount / (effectiveLimitCents / 100)
        : quote.shares;
      const minimumGuardrail = getMinimumOrderGuardrail({
        orderSize: effectiveShares,
        minimumOrderSize: freshBook?.minOrderSize,
        executionPrice: effectivePrice,
      });
      if (minimumGuardrail) {
        Alert.alert(minimumGuardrail.title, minimumGuardrail.message);
        return;
      }
      if (effectiveLimitCents !== null) {
        const limitPrice = effectiveLimitCents / 100;
        const limitShares = amount / limitPrice;
        const expirationMs = Date.parse(detail.gameStartTime ?? detail.endDate ?? '');
        if (!Number.isFinite(expirationMs) || expirationMs <= Date.now() + 60_000) {
          throw new Error('Limit orders are unavailable after kickoff. Use a market order instead.');
        }
        const resultLimit = await placeBet(signer, {
          polygonAddress: poly.polygonAddress,
          tradingAddress: poly.tradingAddress,
          tokenID,
          price: limitPrice,
          size: limitShares,
          side: 'BUY',
          negRisk: !!detail.negRisk,
          orderType: 'GTD',
          expiration: Math.floor(expirationMs / 1_000),
        });
        if (!resultLimit.success) throw new Error(resultLimit.error || 'Order failed');
        const pendingLimit = makePendingOpenOrder({
          id: resultLimit.orderID ?? resultLimit.operationId,
          slug,
          tokenID,
          price: limitPrice,
          size: limitShares,
          outcome: sportOutcomeLabel(outcome),
        });
        setPendingOpenOrders((prev) => [pendingLimit, ...prev.filter((o) => o.id !== pendingLimit.id)]);
        setCashBalance((prev) => (prev === null ? prev : Math.max(prev - amount, 0)));
        collapseNumpad();
        setActiveView('picks');
        setPickScope('market');
        await Promise.allSettled([
          loadPicks(),
          fetchClobBalance(poly.polygonAddress).then((b) => setCashBalance(b?.balance ?? null)),
          activeView === 'orderbook' ? loadOrderbook(obOutcomeIdx) : Promise.resolve(),
        ]);
        scheduleFollowUpReconcile(poly.polygonAddress);
        return;
      }
      const result = await placeBet(poly.client, {
        tokenID,
        price: quote.limitPrice,
        size: quote.shares,
        amount,
        side: 'BUY',
        orderType: 'FOK',
      });
      if (!result.success) throw new Error(result.error || 'Order failed');

      setSubmitStatus('syncing');
      const pendingOrder = makePendingOpenOrder({
        id: result.orderID ?? result.operationId,
        slug,
        tokenID,
        price: result.executionPrice ?? result.estimatedPrice ?? quote.limitPrice,
        size: result.shares ?? quote.shares,
        outcome: sportOutcomeLabel(outcome),
      });
      setPendingOpenOrders((prev) => [pendingOrder, ...prev.filter((order) => order.id !== pendingOrder.id)]);
      setCashBalance((prev) => prev === null ? prev : Math.max(prev - amount, 0));
      collapseNumpad();
      setActiveView('picks');
      setPickScope('market');
      await Promise.allSettled([
        loadPicks(),
        fetchClobBalance(poly.client).then((balance) => setCashBalance(balance?.balance ?? null)),
        activeView === 'orderbook' ? loadOrderbook(obOutcomeIdx) : Promise.resolve(),
      ]);
      scheduleFollowUpReconcile();
    } catch (err: any) {
      Alert.alert('Order failed', err.message || 'Unknown error');
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
      setSubmitStatus('idle');
    }
  }

  function handleCashOut(position: PortfolioPosition) {
    setCashOutPosition(position);
  }

  async function confirmCashOut(size: number, limitPrice: number) {
    const position = cashOutPosition;
    if (!position || submitting || submitInFlightRef.current) return;
    if (!position.asset) {
      Alert.alert('Cash out failed', 'Missing token ID for this position');
      return;
    }

    submitInFlightRef.current = true;
    setSubmitting(true);
    setSubmitStatus(poly.canSignLocally ? 'placing' : 'wallet');
    try {
      if (!poly.canSignLocally) {
        await poly.enable();
        setSubmitStatus('placing');
      }

      if (!poly.client) throw new Error('Wallet session not ready');
      const result = await placeBet(poly.client, {
        tokenID: position.asset,
        price: limitPrice,
        size,
        side: 'SELL',
        orderType: 'FOK',
      });
      if (!result.success) throw new Error(result.error || 'Cash out failed');

      setSubmitStatus('syncing');
      setCashOutPosition(null);
      setActiveView('picks');
      await Promise.allSettled([
        loadPicks(),
        fetchClobBalance(poly.client).then((balance) => setCashBalance(balance?.balance ?? null)),
      ]);
      scheduleFollowUpReconcile();
    } catch (err: any) {
      Alert.alert('Cash out failed', err.message || 'Unknown error');
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
      setSubmitStatus('idle');
    }
  }

  const selectedOutcome = selectedOutcomeIdx !== null ? sortedOutcomes[selectedOutcomeIdx] : null;
  const selectedOutcomeTokenId = selectedOutcome?.clobTokenIds[0] ?? null;
  const selectedOutcomeBook = selectedOutcomeTokenId ? buyBooks[selectedOutcomeTokenId] ?? null : null;
  const selectedExecutableQuote = buildExecutableBuyQuote(
    selectedOutcomeBook,
    parseFloat(numpadAmount) || 0,
  );
  const selectedOutcomeLabel = selectedOutcome ? sportOutcomeLabel(selectedOutcome) : undefined;
  const marketTokenIds = sortedOutcomes.flatMap((outcome) => outcome.clobTokenIds);
  const marketConditionIds = sortedOutcomes.map((outcome) => outcome.conditionId).filter((id): id is string => !!id);
  const visibleOpenOrders = mergeOpenOrders(pendingOpenOrders, openOrders);
  const amountNum = parseFloat(numpadAmount) || 0;
  const marketClosed = detail ? detail.active === false || detail.status === 'closed' : false;

  async function runPredictSetup() {
    if (setupSubmitting) return;
    setSetupSubmitting(true);
    try {
      await poly.enable();
      await Promise.allSettled([loadCashBalance(), loadPicks()]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to sign in to Predict';
      Alert.alert('Sign in failed', msg);
    } finally {
      setSetupSubmitting(false);
    }
  }

  function handlePredictSetupPress() {
    if (setupSubmitting) return;
    if (!poly.signer) {
      // Polymarket settles on Polygon and signs EIP-712 orders, so the
      // requirement is EVM. The effect below resumes session setup once the
      // signer resolves.
      setSetupAfterConnect(true);
      connectSheet.open('evm');
      return;
    }
    void runPredictSetup();
  }

  useEffect(() => {
    if (!setupAfterConnect || !poly.signer || poly.isReady) return;
    setSetupAfterConnect(false);
    void runPredictSetup();
  }, [setupAfterConnect, poly.signer, poly.isReady]);

  useEffect(() => {
    if (!submitAfterSetup || !poly.isReady || !composerParams) return;
    setSubmitAfterSetup(false);
    void submitOrder(composerParams);
  }, [submitAfterSetup, poly.isReady, composerParams]);

  function confirmComposer(params: { mode: ComposerMode; limitPriceCents: number }) {
    setComposerParams(params);
    if (!poly.signer) {
      setSubmitAfterSetup(true);
      handlePredictSetupPress();
      return;
    }
    void submitOrder(params);
  }
  const orderGuardrail = selectedOutcome
    ? getPredictOrderGuardrail({
        amount: amountNum,
        availableCash: cashBalance,
        selectedPrice: selectedQuotePrice,
        latestPrice: selectedOutcome.price,
        marketActive: !marketClosed,
        submitting,
      })
    : null;
  const displayTitle = detail
    ? formatPredictTitle({
        title: detail.title,
        slug: detail.slug,
        outcomes: detail.outcomes.map((outcome) => outcome.label),
      })
    : 'Loading...';
  const submitLabel =
    submitStatus === 'wallet'
      ? 'Confirming wallet...'
      : submitStatus === 'syncing'
        ? 'Syncing pick...'
        : 'Placing order...';

  const chartWidth = Math.max(260, screenWidth - 60);
  const chartHeight = 180;
  const activePosition = [...marketPositions].sort((a, b) => b.currentValue - a.currentValue)[0] ?? null;
  const teamOutcomes = sortedOutcomes.filter((outcome) => !outcome.label.toLowerCase().includes('draw'));
  const homeOutcome = teamOutcomes[0] ?? null;
  const awayOutcome = teamOutcomes[1] ?? null;
  const teamFor = (label: string | undefined, fallbackIndex: number) =>
    detail?.teams.find((team) => team.name.toLowerCase() === label?.toLowerCase())
    ?? detail?.teams[fallbackIndex]
    ?? null;
  const homeTeam = teamFor(homeOutcome?.label, 0);
  const awayTeam = teamFor(awayOutcome?.label, 1);

  if (detail && !loading && !errorMessage) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <AppTopBar
          left={<AppTopBarIconButton icon="arrow-back" onPress={() => router.back()} accessibilityLabel="Go back" />}
          center={(
            <View style={styles.mockTitleLockup}>
              <Text style={styles.mockTopTitle} numberOfLines={1}>{displayTitle}</Text>
              <Text style={styles.mockTopSubtitle}>Sports · Moneyline</Text>
            </View>
          )}
          right={<AppTopBarCashPill value={truncateUsd(cashBalance)} />}
        />

        <ScrollView
          style={styles.mockScroll}
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator
          refreshControl={(
            <RefreshControl refreshing={refreshing} onRefresh={() => void refreshDetailScreen()} tintColor={tokens.colors.accent} />
          )}
          contentContainerStyle={[styles.mockContent, { paddingBottom: Math.max(insets.bottom, 18) + 20 }]}
        >
          <View style={styles.mockCard}>
            <View style={styles.mockCardTop}>
              <Text style={styles.mockKind}>Match result · Moneyline</Text>
              {activePosition ? (
                <Pressable style={styles.mockPositionButton} accessibilityRole="button" onPress={() => setPositionOpen(true)}>
                  <MaterialIcons name="account-circle" size={16} color={tokens.colors.viridian} />
                  <Text style={styles.mockPositionLabel}>Your pick</Text>
                  <Text style={[styles.mockPositionPnl, activePosition.cashPnl < 0 && styles.mockPositionPnlNegative]}>
                    {activePosition.cashPnl >= 0 ? '+' : '-'}${Math.abs(activePosition.cashPnl).toFixed(2)}
                  </Text>
                </Pressable>
              ) : null}
            </View>

            <SportsMatchupHeader
              homeTeam={homeOutcome ? sportOutcomeLabel(homeOutcome) : (homeTeam?.name ?? displayTitle)}
              awayTeam={awayOutcome ? sportOutcomeLabel(awayOutcome) : (awayTeam?.name ?? '')}
              homeLogo={homeTeam?.logo}
              awayLogo={awayTeam?.logo}
              league={null}
              startsAt={null}
              active={detail.active}
            />

            <View style={styles.mockPanel}>
              <View style={styles.mockPanelHead}>
                <View>
                  <Text style={styles.mockPanelTitle}>Market movement</Text>
                  <Text style={styles.mockPanelSubtitle}>{activeView === 'orderbook' ? 'Live orders' : 'Price history'}</Text>
                </View>
                <View style={styles.mockViewSwitch} accessibilityRole="tablist">
                  {(['chart', 'orderbook'] as const).map((view) => {
                    const selected = activeView === view;
                    return (
                      <Pressable
                        key={view}
                        accessibilityRole="tab"
                        accessibilityState={{ selected }}
                        style={[styles.mockViewButton, selected && styles.mockViewButtonActive]}
                        onPress={() => setActiveView(view)}
                      >
                        <MaterialIcons name={view === 'chart' ? 'show-chart' : 'layers'} size={14} color={selected ? tokens.colors.backgroundDark : semantic.text.faint} />
                        <Text style={[styles.mockViewText, selected && styles.mockViewTextActive]}>{view === 'chart' ? 'Chart' : 'Book'}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <View style={styles.mockMarketSurface}>
                {activeView === 'orderbook' ? (
                  <View style={styles.mockBookWrap}>
                    <View style={styles.mockBookTabs}>
                      {sortedOutcomes.map((outcome, index) => (
                        <Pressable
                          key={sportOutcomeKey(outcome, index, 'book')}
                          accessibilityRole="tab"
                          accessibilityState={{ selected: obOutcomeIdx === index }}
                          style={[styles.mockBookTab, obOutcomeIdx === index && styles.mockBookTabActive]}
                          onPress={() => setObOutcomeIdx(index)}
                        >
                          <Text style={[styles.mockBookTabText, obOutcomeIdx === index && styles.mockBookTabTextActive]} numberOfLines={1}>
                            {sportOutcomeLabel(outcome)}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                    <OrderbookView book={orderbook} loading={orderbookLoading} />
                  </View>
                ) : historyLoading ? (
                  <ActivityIndicator color={semantic.text.faint} />
                ) : (
                  <View style={styles.mockChartWrap}>
                    <View style={styles.mockLegend}>
                      {chartSeries.map((series) => (
                        <View key={series.label} style={styles.mockLegendItem}>
                          <View style={[styles.mockLegendDot, { backgroundColor: series.color }]} />
                          <Text style={styles.mockLegendText} numberOfLines={1}>{series.label}</Text>
                        </View>
                      ))}
                    </View>
                    <MultiLineChart series={chartSeries} width={chartWidth} height={chartHeight} />
                  </View>
                )}
              </View>
            </View>

            <View style={styles.mockMoneyline}>
              <View style={styles.mockMoneylineHead}>
                <Text style={styles.mockMoneylineTitle}>Who wins?</Text>
                <Text style={styles.mockMoneylineMeta}>Live price</Text>
              </View>
              {marketClosed ? <Text style={styles.marketClosedText}>This market is closed.</Text> : null}
              <View style={styles.mockOutcomes}>
                {sortedOutcomes.map((outcome, index) => {
                  const tone = outcomeTone(outcome, index);
                  const selected = selectedOutcomeIdx === index;
                  return (
                    <Pressable
                      key={sportOutcomeKey(outcome, index, 'pick')}
                      accessibilityRole="button"
                      accessibilityState={{ selected, disabled: marketClosed || submitting }}
                      disabled={marketClosed || submitting}
                      style={[styles.mockOutcome, selected && styles.mockOutcomeSelected]}
                      onPress={() => tapOdd(index)}
                    >
                      <Text style={styles.mockOutcomeLabel} numberOfLines={1}>{sportOutcomeLabel(outcome)}</Text>
                      <Text style={[
                        styles.mockOutcomePrice,
                        tone === 'lead' ? styles.mockOutcomeLead : tone === 'draw' ? styles.mockOutcomeDraw : styles.mockOutcomeTrail,
                      ]}>
                        {outcome.price === null ? '--' : `${Math.round(outcome.price * 100)}¢`}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.mockHint}>
                <MaterialIcons name="touch-app" size={13} color={tokens.colors.accent} />
                <Text style={styles.mockHintText}>Tap a result to place an order</Text>
              </View>
            </View>
          </View>
        </ScrollView>

        <DetailPositionSheet
          visible={positionOpen}
          position={activePosition}
          title="Match result"
          onClose={() => setPositionOpen(false)}
          onAdd={() => {
            setPositionOpen(false);
            if (activePosition) backMorePosition(activePosition);
          }}
          onCashOut={() => {
            setPositionOpen(false);
            if (activePosition) handleCashOut(activePosition);
          }}
        />
        <CashOutConfirmModal
          visible={cashOutPosition !== null}
          position={cashOutPosition}
          submitting={submitting}
          orderbook={cashOutPosition?.asset ? sellQuoteBooks[cashOutPosition.asset]?.book ?? null : null}
          quoteLoading={cashOutPosition?.asset ? sellQuoteBooks[cashOutPosition.asset]?.loading ?? false : false}
          quoteError={cashOutPosition?.asset ? sellQuoteBooks[cashOutPosition.asset]?.error ?? null : null}
          onClose={() => setCashOutPosition(null)}
          onConfirm={confirmCashOut}
        />
        <OrderComposerSheet
          visible={composerOpen && selectedOutcomeIdx !== null}
          side={selectedOutcomeIdx === 0 ? 'yes' : 'no'}
          pickLabel={selectedOutcomeLabel}
          question={detail.title}
          currentPrice={selectedQuotePrice}
          amount={numpadAmount}
          onAmountChange={setNumpadAmount}
          executableAvgPrice={marketClosed || !selectedExecutableQuote.executable ? null : selectedExecutableQuote.averagePrice}
          minimumOrderSize={selectedOutcomeBook?.minOrderSize ?? null}
          availableCash={cashBalance}
          guardrail={orderGuardrail}
          submitting={submitting}
          submittingLabel={submitLabel}
          disabled={marketClosed}
          limitOrderNote="Cancels automatically at kickoff."
          onClose={collapseNumpad}
          onConfirm={confirmComposer}
        />
        <ConnectionSheet
          visible={connectSheet.visible}
          chain={connectSheet.chain}
          onConnected={() => {
            connectionCompletedRef.current = true;
          }}
          onClose={() => {
            const completed = connectionCompletedRef.current;
            connectionCompletedRef.current = false;
            if (!completed) {
              setSetupAfterConnect(false);
              setSubmitAfterSetup(false);
            }
            connectSheet.close();
          }}
        />
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
        left={<AppTopBarIconButton icon="arrow-back" onPress={() => router.back()} accessibilityLabel="Go back" />}
        center={<AppTopBarTitle align="left" tone="primary" uppercase={false}>{displayTitle}</AppTopBarTitle>}
        right={(
          <View style={styles.headerRight}>
          {detail?.status === 'live' && (
            <View style={styles.liveBadge}>
              <Animated.View style={[styles.liveDot, { opacity: livePulse }]} />
              <Text style={styles.liveText}>LIVE</Text>
            </View>
          )}
            <AppTopBarCashPill value={truncateUsd(cashBalance)} />
          </View>
        )}
      />

      {/* ── LOADING / ERROR ── */}
      {loading ? (
        <View style={styles.stateWrap}>
          <ActivityIndicator size="small" color={semantic.text.accent} />
          <Text style={styles.stateText}>Loading fixture...</Text>
        </View>
      ) : errorMessage ? (
        <View style={styles.stateWrap}>
          <Text style={styles.stateTitle}>Fixture unavailable</Text>
          <Text style={styles.stateText}>{errorMessage}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            accessibilityHint="Reload fixture details"
            onPress={() => void loadDetail()}
            style={styles.retryBtn}>
            <Text style={styles.retryText}>Try Again</Text>
          </Pressable>
        </View>
      ) : detail ? (
        <View style={styles.body}>
          {/* ══ DARK ZONE ══ */}
          <ScrollView
            style={styles.darkZone}
            contentContainerStyle={[styles.darkZoneContent, { paddingBottom: SOFT_COLLAPSED }]}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => { void refreshDetailScreen(); }}
                tintColor={semantic.text.accent}
              />
            }>
            <View style={styles.displayRow}>
              <View style={styles.displayTabGroup}>
                <DisplayTab label="Your Picks" active={activeView === 'picks'} onPress={() => setActiveView('picks')} />
                <DisplayTab label="Stats" active={activeView === 'stats'} onPress={() => setActiveView('stats')} />
              </View>
              <View style={styles.displayTabGroup}>
              {activeView === 'chart' && (['5m', '1h', '1d'] as Interval[]).map((iv) => (
                <Pressable
                  key={iv}
                  accessibilityRole="tab"
                  accessibilityLabel={`Show ${iv === '5m' ? '5 minute' : iv === '1h' ? '1 hour' : '1 day'} chart`}
                  accessibilityState={{ selected: interval === iv }}
                  style={[styles.rangeChip, interval === iv && styles.rangeChipActive]}
                  onPress={() => setInterval(iv)}>
                  <Text style={[styles.rangeChipText, interval === iv && styles.rangeChipTextActive]}>
                    {iv === '5m' ? '5M' : iv === '1h' ? '1H' : '1D'}
                  </Text>
                </Pressable>
              ))}
                <DisplayTab label="Chart" active={activeView === 'chart'} onPress={() => setActiveView('chart')} />
                <DisplayTab label="Book" active={activeView === 'orderbook'} onPress={() => setActiveView('orderbook')} />
              </View>
            </View>

            {/* Matchup identity — PRD §3: crests/wordmarks carry the screen.
                No scores or live clocks (API provides none). */}
            {detail ? (
              <SportsMatchupHeader
                homeTeam={sortedOutcomes[0] ? sportOutcomeLabel(sortedOutcomes[0]) : detail.title}
                awayTeam={sortedOutcomes.length > 2 ? sportOutcomeLabel(sortedOutcomes[sortedOutcomes.length - 1]) : ''}
                league={detail.sport ? detail.sport.toUpperCase() : null}
                startsAt={detail.endDate ?? detail.startDate ?? null}
                active={detail.active}
              />
            ) : null}

            {/* Chart or Orderbook */}
            <View style={styles.viewContainer}>
              {activeView === 'picks' ? (
                <DetailPicksPanel
                  scope={pickScope}
                  marketSlug={slug}
                  marketTokenIds={marketTokenIds}
                  marketConditionIds={marketConditionIds}
                  loading={picksLoading}
                  freshness={{
                    ...picksFreshness,
                    loading: picksLoading,
                    syncing: pendingOpenOrders.length > 0,
                    stale: picksFreshness.stale || realtimeStatus === 'degraded',
                    error: picksFreshness.error
                      ?? (realtimeStatus === 'degraded' ? 'Live updates delayed; using periodic refresh' : null),
                  }}
                  marketPositions={marketPositions}
                  allPositions={allPositions}
                  redeemablePositions={redeemablePositions}
                  closedPositions={closedPositions}
                  openOrders={visibleOpenOrders}
                  activityItems={activityItems}
                  sellQuotes={sellQuotes}
                  cancellingOrderId={cancellingOrderId}
                  client={poly.client}
                  onScopeChange={setPickScope}
                  onCashOut={handleCashOut}
                  onBackMore={backMorePosition}
                  onCancelOrder={(orderId) => void handleCancelOrder(orderId)}
                  onRedeemed={() => void loadPicks()}
                  onRetry={() => void loadPicks()}
                />
              ) : activeView === 'stats' ? (
                <View style={styles.statsView}>
                  <View style={styles.picksHeading}>
                    <Text style={styles.picksTitle}>Stats</Text>
                    <Text style={styles.picksSubtitle}>Live market</Text>
                  </View>
                  <View style={styles.statsGrid}>
                    <View style={styles.statsCard}><Text style={styles.statsLabel}>Volume</Text><Text style={styles.statsValue}>{formatUsdCompact(detail.volume24h)}</Text></View>
                    <View style={styles.statsCard}><Text style={styles.statsLabel}>Liquidity</Text><Text style={styles.statsValue}>{formatUsdCompact(detail.liquidity)}</Text></View>
                    <View style={styles.statsCard}><Text style={styles.statsLabel}>Leader</Text><Text style={styles.statsValue}>{sortedOutcomes[0] ? sportOutcomeLabel(sortedOutcomes[0]) : '--'}</Text></View>
                    <View style={styles.statsCard}><Text style={styles.statsLabel}>Chance</Text><Text style={styles.statsValue}>{leadPrice !== null ? `${Math.round(leadPrice * 100)}%` : '--'}</Text></View>
                  </View>
                </View>
              ) : activeView === 'chart' ? (
                historyLoading ? (
                  <View style={styles.chartSkeleton}>
                    <ActivityIndicator size="small" color={semantic.text.faint} />
                  </View>
                ) : (
                  <MultiLineChart
                    series={chartSeries}
                    width={chartWidth}
                    height={chartHeight}
                  />
                )
              ) : (
                <View style={styles.obWrap}>
                  {/* Outcome tabs for orderbook */}
                  <View style={styles.obOutcomeTabs}>
                    {sortedOutcomes.map((o, i) => {
                      const label = sportOutcomeLabel(o);
                      return (
                        <Pressable
                          key={`${o.conditionId ?? o.label}-${i}`}
                          accessibilityRole="tab"
                          accessibilityLabel={`Show ${label} order book`}
                          accessibilityState={{ selected: obOutcomeIdx === i }}
                          style={[styles.obOutcomeTab, obOutcomeIdx === i && styles.obOutcomeTabActive]}
                          onPress={() => setObOutcomeIdx(i)}>
                          <Text style={[styles.obOutcomeTabText, obOutcomeIdx === i && styles.obOutcomeTabTextActive]} numberOfLines={1}>
                            {label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <OrderbookView book={orderbook} loading={orderbookLoading} />
                </View>
              )}
            </View>
          </ScrollView>

          {/* ══ SOFT ZONE ══ */}
          <Animated.View style={[styles.softZone, { maxHeight: softZoneAnim }]}>
            {/* Drag handle */}
            <View style={styles.dragHandle} {...dragResponder.panHandlers}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Collapse order entry"
                accessibilityHint="Hide the amount keypad"
                onPress={collapseNumpad}>
                <View style={styles.dragHandlePill} />
              </Pressable>
            </View>

            {/* Selection rows */}
            <View style={styles.oddsSection}>
              <View style={styles.selHeader}>
                <Text style={styles.selHeaderLabel}>{"What's your pick?"}</Text>
                {/*
                <OddsFormatToggle format={format} onFormatChange={setFormat} />
                */}
              </View>
              {marketClosed && (
                <Text style={styles.marketClosedText}>This market is closed and no longer accepting new picks.</Text>
              )}
              {sortedOutcomes.map((outcome, i) => {
                const label = sportOutcomeLabel(outcome);
                const isSelected = selectedOutcomeIdx === i;
                const tone = outcomeTone(outcome, i);
                return (
                  <View key={`${outcome.conditionId ?? outcome.label}-${i}`} style={[styles.selRow, i > 0 && styles.selRowBorder]}>
                    <View style={styles.selInfo}>
                      <Text style={styles.selName} numberOfLines={1}>{label}</Text>
                      <Text style={styles.selVol}>{formatUsdCompact(outcome.volume24h)} vol</Text>
                    </View>
                    <View style={styles.selBtns}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Back ${label} at ${outcome.price !== null ? formatOdds(outcome.price) : 'unavailable'}`}
                        accessibilityState={{ selected: isSelected, disabled: marketClosed || submitting }}
                        accessibilityHint={`Open order entry for ${label}`}
                        style={[
                          styles.selBtn,
                          tone === 'lead' ? styles.selBtnLead : tone === 'draw' ? styles.selBtnDraw : styles.selBtnTrail,
                          isSelected && (tone === 'lead' ? styles.selBtnLeadSelected : tone === 'draw' ? styles.selBtnDrawSelected : styles.selBtnTrailSelected),
                        ]}
                        disabled={marketClosed || submitting}
                        onPress={() => tapOdd(i)}>
                        <Text style={[
                          styles.selBtnPct,
                          tone === 'lead' ? styles.selBtnPctLead : tone === 'draw' ? styles.selBtnPctDraw : styles.selBtnPctTrail,
                        ]}>
                          {outcome.price !== null ? formatOdds(outcome.price) : '--'}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>

            {/* Shared order composer (PRD §6) — replaces the inline numpad */}
            <OrderComposerSheet
              visible={composerOpen && selectedOutcomeIdx !== null}
              side={selectedOutcomeIdx === 0 ? 'yes' : 'no'}
              pickLabel={selectedOutcomeLabel}
              question={detail?.title ?? null}
              currentPrice={selectedQuotePrice}
              amount={numpadAmount}
              onAmountChange={setNumpadAmount}
              executableAvgPrice={
                marketClosed
                  ? null
                  : (() => {
                      if (selectedOutcomeIdx === null) return null;
                      const outcome = sortedOutcomes[selectedOutcomeIdx];
                      const tokenId = outcome?.clobTokenIds[0];
                      const q = buildExecutableBuyQuote(tokenId ? buyBooks[tokenId] ?? null : null, amountNum);
                      return q.executable && q.averagePrice !== null ? q.averagePrice : null;
                    })()
              }
              minimumOrderSize={selectedOutcomeBook?.minOrderSize ?? null}
              availableCash={cashBalance}
              guardrail={orderGuardrail}
              submitting={submitting}
              submittingLabel={submitLabel}
              disabled={marketClosed}
              onClose={() => {
                setComposerParams(null);
                collapseNumpad();
              }}
              onConfirm={confirmComposer}
            />
          </Animated.View>
        </View>
      ) : null}
      <CashOutConfirmModal
        visible={cashOutPosition !== null}
        position={cashOutPosition}
        submitting={submitting}
        orderbook={cashOutPosition?.asset ? sellQuoteBooks[cashOutPosition.asset]?.book ?? null : null}
        quoteLoading={cashOutPosition?.asset ? sellQuoteBooks[cashOutPosition.asset]?.loading ?? false : false}
        quoteError={cashOutPosition?.asset ? sellQuoteBooks[cashOutPosition.asset]?.error ?? null : null}
        onClose={() => setCashOutPosition(null)}
        onConfirm={confirmCashOut}
      />

      <ConnectionSheet
        visible={connectSheet.visible}
        chain={connectSheet.chain}
        onConnected={() => {
          connectionCompletedRef.current = true;
        }}
        onClose={() => {
          // Cancelling the sheet abandons the pending session setup, so the
          // resume effect must not fire if the user later connects elsewhere.
          const completed = connectionCompletedRef.current;
          connectionCompletedRef.current = false;
          if (!completed) {
            setSetupAfterConnect(false);
            setSubmitAfterSetup(false);
          }
          connectSheet.close();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.background.screen },
  mockTitleLockup: { flex: 1, paddingHorizontal: 7 },
  mockTopTitle: { fontSize: 12, lineHeight: 15, fontWeight: '900', color: semantic.text.primary },
  mockTopSubtitle: { paddingTop: 2, fontFamily: 'monospace', fontSize: 8, color: semantic.text.faint },
  mockScroll: { flex: 1 },
  mockContent: { paddingHorizontal: 14, paddingTop: 10 },
  mockCard: { overflow: 'hidden', borderRadius: 24, borderCurve: 'continuous', borderWidth: 1, borderColor: semantic.border.muted, backgroundColor: tokens.colors.surface, boxShadow: '0 12px 26px rgba(3,31,44,0.32)' },
  mockCardTop: { minHeight: 48, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: semantic.border.muted },
  mockKind: { fontFamily: 'monospace', fontSize: 9, fontWeight: '900', textTransform: 'uppercase', color: semantic.text.dim },
  mockPositionButton: { minHeight: 32, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 11, borderCurve: 'continuous', backgroundColor: tokens.colors.lift },
  mockPositionLabel: { fontFamily: 'monospace', fontSize: 8, fontWeight: '800', color: semantic.text.dim },
  mockPositionPnl: { fontFamily: 'monospace', fontSize: 9, fontWeight: '900', color: tokens.colors.viridian },
  mockPositionPnlNegative: { color: tokens.colors.vermillion },
  mockPanel: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: semantic.border.muted, backgroundColor: tokens.colors.ground },
  mockPanelHead: { minHeight: 66, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  mockPanelTitle: { fontSize: 13, fontWeight: '900', color: semantic.text.primary },
  mockPanelSubtitle: { paddingTop: 3, fontFamily: 'monospace', fontSize: 8, color: semantic.text.faint },
  mockViewSwitch: { flexDirection: 'row', padding: 4, borderRadius: 13, borderCurve: 'continuous', backgroundColor: tokens.colors.lift },
  mockViewButton: { minWidth: 65, minHeight: 36, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 10, borderCurve: 'continuous' },
  mockViewButtonActive: { backgroundColor: tokens.colors.accent },
  mockViewText: { fontFamily: 'monospace', fontSize: 9, fontWeight: '800', color: semantic.text.faint },
  mockViewTextActive: { color: tokens.colors.backgroundDark },
  mockMarketSurface: { minHeight: 216, paddingHorizontal: 8, paddingBottom: 10, alignItems: 'center', justifyContent: 'center' },
  mockChartWrap: { width: '100%', alignItems: 'center' },
  mockLegend: { width: '100%', minHeight: 26, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  mockLegendItem: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  mockLegendDot: { width: 6, height: 6, borderRadius: 3 },
  mockLegendText: { maxWidth: 92, fontFamily: 'monospace', fontSize: 8, fontWeight: '700', color: semantic.text.faint },
  mockBookWrap: { width: '100%', minHeight: 202, paddingHorizontal: 5 },
  mockBookTabs: { flexDirection: 'row', gap: 5, paddingBottom: 8 },
  mockBookTab: { flex: 1, minHeight: 36, paddingHorizontal: 5, borderRadius: 10, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.surface },
  mockBookTabActive: { backgroundColor: tokens.colors.accent },
  mockBookTabText: { fontFamily: 'monospace', fontSize: 8, fontWeight: '800', color: semantic.text.faint },
  mockBookTabTextActive: { color: tokens.colors.backgroundDark },
  mockMoneyline: { paddingHorizontal: 13, paddingTop: 13, paddingBottom: 15, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: semantic.border.muted, backgroundColor: tokens.colors.surface },
  mockMoneylineHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  mockMoneylineTitle: { fontSize: 13, fontWeight: '900', color: semantic.text.primary },
  mockMoneylineMeta: { fontFamily: 'monospace', fontSize: 8, color: semantic.text.faint },
  mockOutcomes: { paddingTop: 10, flexDirection: 'row', gap: 7 },
  mockOutcome: { flex: 1, minWidth: 0, minHeight: 68, paddingHorizontal: 9, paddingVertical: 11, justifyContent: 'space-between', borderRadius: 13, borderCurve: 'continuous', borderWidth: 1, borderColor: semantic.border.muted, backgroundColor: tokens.colors.ground },
  mockOutcomeSelected: { borderColor: tokens.colors.accent, backgroundColor: tokens.colors.lift, boxShadow: `inset 0 -3px 0 ${tokens.colors.accent}` },
  mockOutcomeLabel: { fontSize: 9, fontWeight: '900', color: semantic.text.dim },
  mockOutcomePrice: { fontFamily: 'monospace', fontSize: 17, fontWeight: '900' },
  mockOutcomeLead: { color: tokens.colors.viridian },
  mockOutcomeDraw: { color: tokens.colors.accent },
  mockOutcomeTrail: { color: tokens.colors.vermillion },
  mockHint: { paddingTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  mockHintText: { fontFamily: 'monospace', fontSize: 8, fontWeight: '800', textTransform: 'uppercase', color: semantic.text.faint },

  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flexShrink: 0,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  liveDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: semantic.sentiment.negative,
  },
  liveText: {
    fontFamily: 'monospace',
    fontSize: 7,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: semantic.sentiment.negative,
  },
  // ── States ──
  stateWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacing.sm,
    padding: tokens.spacing.lg,
  },
  stateTitle: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  stateText: { color: semantic.text.dim, fontSize: tokens.fontSize.md },
  retryBtn: {
    marginTop: tokens.spacing.xs,
    backgroundColor: semantic.text.accent,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.radius.xs,
  },
  retryText: {
    color: semantic.background.screen,
    fontSize: tokens.fontSize.sm,
    fontFamily: 'monospace',
    textTransform: 'uppercase',
    fontWeight: '700',
  },

  // ── Body ──
  body: { flex: 1, position: 'relative' },

  // ── Dark zone ──
  darkZone: {
    flex: 1,
    paddingHorizontal: 20,
  },
  darkZoneContent: {
    flexGrow: 1,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 10,
  },
  displayRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 8,
  },
  displayTabGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 1,
  },
  displayTab: {
    height: 28,
    borderRadius: 8,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  displayTabActive: {
    backgroundColor: tokens.colors.surface,
  },
  displayTabText: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  displayTabTextActive: {
    color: semantic.text.primary,
  },
  rangeChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rangeChipActive: { backgroundColor: tokens.colors.surface },
  rangeChipText: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1,
    color: semantic.text.faint,
  },
  rangeChipTextActive: { color: semantic.text.primary },
  toggleIcons: {
    flexDirection: 'row',
    gap: 4,
    marginLeft: 'auto',
  },
  toggleBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleBtnActive: { backgroundColor: tokens.colors.surface },
  viewContainer: { flex: 1, minHeight: 0 },
  chartSkeleton: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  picksView: {
    flex: 1,
    paddingTop: 10,
  },
  picksHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  picksTitle: {
    fontFamily: 'monospace',
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: semantic.text.primary,
    fontWeight: '700',
  },
  picksSubtitle: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.faint,
    textTransform: 'uppercase',
  },
  picksEmptyCard: {
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
    borderRadius: 12,
    padding: 14,
  },
  picksEmptyTitle: {
    color: semantic.text.primary,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
  },
  picksEmptyText: {
    color: semantic.text.dim,
    fontSize: 10,
    lineHeight: 15,
  },
  statsView: {
    flex: 1,
    paddingTop: 10,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statsCard: {
    width: '48%',
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
    borderRadius: 12,
    padding: 10,
  },
  statsLabel: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1,
    color: semantic.text.faint,
    textTransform: 'uppercase',
  },
  statsValue: {
    marginTop: 4,
    fontFamily: 'monospace',
    fontSize: 15,
    fontWeight: '800',
    color: semantic.text.primary,
  },

  // ── Orderbook wrapper ──
  obWrap: { flex: 1 },
  obOutcomeTabs: {
    flexDirection: 'row',
    gap: 16,
    paddingBottom: 6,
  },
  obOutcomeTab: {
    paddingVertical: 4,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  obOutcomeTabActive: {
    borderBottomColor: semantic.text.accent,
  },
  obOutcomeTabText: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 0.5,
    color: semantic.text.faint,
  },
  obOutcomeTabTextActive: { color: semantic.text.dim },

  // ── Soft zone ──
  softZone: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: tokens.colors.ground,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
  },
  dragHandle: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 2,
  },
  dragHandlePill: {
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: semantic.text.faint,
  },
  separator: {
    height: 1,
    backgroundColor: semantic.predict.rowBorderSoft,
    marginHorizontal: 20,
  },
  // ── Selection rows ──
  oddsSection: {
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  selHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 2,
  },
  selHeaderLabel: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  marketClosedText: {
    marginTop: 4,
    fontFamily: 'monospace',
    fontSize: 8,
    color: tokens.colors.vermillion,
  },
  selRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 9,
  },
  selRowBorder: {
    borderTopWidth: 1,
    borderTopColor: semantic.predict.rowBorderSoft,
  },
  selInfo: { flex: 1, minWidth: 0 },
  selName: {
    fontSize: 12,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  selVol: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.dim,
    marginTop: 1,
  },
  selBtns: { flexDirection: 'row', gap: 8, flexShrink: 0 },
  selBtn: {
    width: 92,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selBtnLead: {
    backgroundColor: semantic.predict.outcomeYesBg,
  },
  selBtnDraw: {
    backgroundColor: semantic.predict.outcomeDrawBg,
  },
  selBtnTrail: {
    backgroundColor: semantic.predict.outcomeNoBg,
  },
  selBtnLeadSelected: {
    backgroundColor: 'rgba(74,140,111,0.25)',
    borderWidth: 1,
    borderColor: 'rgba(74,140,111,0.35)',
  },
  selBtnDrawSelected: {
    backgroundColor: 'rgba(199,183,112,0.22)',
    borderWidth: 1,
    borderColor: 'rgba(199,183,112,0.35)',
  },
  selBtnTrailSelected: {
    backgroundColor: 'rgba(217,83,79,0.20)',
    borderWidth: 1,
    borderColor: 'rgba(217,83,79,0.35)',
  },
  selBtnPct: {
    fontFamily: 'monospace',
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 18,
  },
  selBtnPctLead: {
    color: semantic.sentiment.positive,
  },
  selBtnPctDraw: {
    color: semantic.text.accent,
  },
  selBtnPctTrail: {
    color: semantic.sentiment.negative,
  },
});
