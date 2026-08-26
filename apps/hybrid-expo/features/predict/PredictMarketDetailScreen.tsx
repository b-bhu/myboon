import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
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
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { AppTopBar, AppTopBarCashPill, AppTopBarIconButton, AppTopBarTitle } from '@/components/AppTopBar';
import { cancelOrder, fetchClobBalance, fetchCuratedMarketDetail, fetchLivePrices, fetchMarketPositions, fetchOpenOrders, fetchOrderbook, fetchPortfolio, fetchPriceHistory, placeBet } from '@/features/predict/predict.api';
import type { ActivityItem, ClosedPortfolioPosition, OpenOrder, PortfolioPosition } from '@/features/predict/predict.api';
import type { GeopoliticsMarketDetail, Orderbook, PricePoint } from '@/features/predict/predict.types';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { usePolymarketWallet } from '@/hooks/usePolymarketWallet';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import { semantic, tokens } from '@/theme';
import { formatUsdCompact } from '@/lib/format';
import { useOddsFormat } from '@/hooks/useOddsFormat';
import { MultiLineChart } from '@/features/predict/components/MultiLineChart';
import { OrderbookView } from '@/features/predict/components/OrderbookView';
import { InlineNumpad } from '@/features/predict/components/InlineNumpad';
import { OrderComposerSheet } from '@/features/predict/components/OrderComposerSheet';
import type { ComposerMode } from '@/features/predict/components/OrderComposerSheet';
import { ResolutionRulesSheet, EventOutcomeLadder } from '@/features/predict/components/EventOutcomeLadder';
import type { EventOddsFormat } from '@/features/predict/components/EventOutcomeLadder';
import { DetailPicksPanel } from '@/features/predict/components/DetailPicksPanel';
import { CashOutConfirmModal } from '@/features/predict/components/CashOutConfirmModal';
import { DetailPositionSheet } from '@/features/predict/components/DetailPositionSheet';
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

interface PredictMarketDetailScreenProps {
  slug: string;
}

type Interval = '5m' | '1h' | '1d';
type ActiveView = 'picks' | 'stats' | 'chart' | 'orderbook';
type SubmitStatus = 'idle' | 'wallet' | 'placing' | 'syncing';

const SOFT_COLLAPSED = 230; // handle + stats + odds
const SOFT_EXPANDED = 680;  // + numpad

// Composer v2 is the normal Yes/No flow as of the Predict redesign (PRD §6).
// ?composer=legacy on web restores the old InlineNumpad flow for QA comparison.
const COMPOSER_V2_DEFAULT = true;

function formatDeadline(endDate: string | null, active: boolean | null): string {
  if (!endDate) return active === false ? 'Closed' : 'Open';
  const time = Date.parse(endDate);
  if (Number.isNaN(time)) return active === false ? 'Closed' : 'Open';
  const date = new Date(time);
  const month = date.toLocaleString('en-US', { month: 'short' });
  const day = date.getDate();
  return `${active === false ? 'Ended' : 'Ends'} ${month} ${day}`;
}

function formatResolveDate(endDate: string | null): string {
  if (!endDate) return 'Resolution date unavailable';
  const time = Date.parse(endDate);
  if (!Number.isFinite(time)) return 'Resolution date unavailable';
  return `Resolves ${new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
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

export function PredictMarketDetailScreen({ slug }: PredictMarketDetailScreenProps) {
  // Composer v2 can be force-disabled for QA via ?composer=legacy on web.
  const urlParams = useLocalSearchParams<{ composer?: string }>();
  const COMPOSER_V2 = COMPOSER_V2_DEFAULT && urlParams.composer !== 'legacy';
  const router = useRouter();
  const poly = usePolymarketWallet();
  const connectSheet = useConnectionSheet('evm');
  const { formatOdds } = useOddsFormat();
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // Market data
  const [detail, setDetail] = useState<GeopoliticsMarketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [liveTokenPrices, setLiveTokenPrices] = useState<Record<string, number | null>>({});

  // Chart data
  const [interval, setInterval] = useState<Interval>('1h');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [yesHistory, setYesHistory] = useState<PricePoint[]>([]);
  const [noHistory, setNoHistory] = useState<PricePoint[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>('chart');
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null);
  const [orderbookLoading, setOrderbookLoading] = useState(false);
  const [buyBooks, setBuyBooks] = useState<Record<string, Orderbook | null>>({});
  const [binaryBookSide, setBinaryBookSide] = useState<'yes' | 'no'>('yes');

  // Numpad state
  const [numpadOpen, setNumpadOpen] = useState(false);
  const [selectedSide, setSelectedSide] = useState<'yes' | 'no' | null>('yes');
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
  // Composer v2 pilot state (Predict redesign PRD §6). Flag-gated; see COMPOSER_V2.
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerParams, setComposerParams] = useState<{ mode: ComposerMode; limitPriceCents: number } | null>(null);
  // Multi-outcome event state (PRD §5). Selected rung in the outcome ladder;
  // odds format for the ladder; which event outcome's book the Book view shows.
  const [eventOutcomeId, setEventOutcomeId] = useState<string | null>(null);
  const [eventOddsFormat, setEventOddsFormat] = useState<EventOddsFormat>('probability');
  const [eventBookIdx, setEventBookIdx] = useState(0);

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

  async function loadMarket(silent = false) {
    if (!silent) setLoading(true);
    setErrorMessage(null);
    try {
      setDetail(await fetchCuratedMarketDetail(slug));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load market');
      setDetail(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function loadHistory(iv: Interval) {
    if (!detail) return;
    const yesId = detail.clobTokenIds[0];
    const noId = detail.clobTokenIds[1];
    if (!yesId) return;
    setHistoryLoading(true);
    try {
      const results = await Promise.all([
        fetchPriceHistory(yesId, iv),
        noId ? fetchPriceHistory(noId, iv) : Promise.resolve({ history: [] }),
      ]);
      setYesHistory(results[0].history);
      setNoHistory(results[1].history);
    } catch {
      setYesHistory([]);
      setNoHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadOrderbook() {
    // Event mode follows its ladder tab; binary mode follows the Yes/No tab.
    const tokenId = isEventMode
      ? (event?.outcomes[eventBookIdx]?.clobTokenIds[0] ?? null)
      : (detail?.clobTokenIds[binaryBookSide === 'yes' ? 0 : 1] ?? null);
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
        loadMarket(true),
        loadPicks(),
        loadCashBalance(),
        activeView === 'orderbook' ? loadOrderbook() : Promise.resolve(),
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

  const liveTokenKey = detail?.clobTokenIds.filter(Boolean).join(',') ?? '';

  useEffect(() => { void loadMarket(); }, [slug]);

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

  useEffect(() => {
    if (detail) void loadHistory(interval);
  }, [detail, interval]);

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

  // Load orderbook when switching to orderbook view (or ladder tab in event mode)
  useEffect(() => {
    if (activeView === 'orderbook' && detail) void loadOrderbook();
  }, [activeView, detail, eventBookIdx, binaryBookSide]);

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

  // Animate soft zone
  useEffect(() => {
    Animated.timing(softZoneAnim, {
      toValue: numpadOpen ? SOFT_EXPANDED : SOFT_COLLAPSED,
      duration: 350,
      useNativeDriver: false,
    }).start();
  }, [numpadOpen, softZoneAnim]);

  const yesTokenId = detail?.clobTokenIds[0];
  const noTokenId = detail?.clobTokenIds[1];
  const yesBook = yesTokenId ? buyBooks[yesTokenId] ?? null : null;
  const noBook = noTokenId ? buyBooks[noTokenId] ?? null : null;
  const yesPrice = getBestAsk(yesBook) ?? (yesTokenId ? liveTokenPrices[yesTokenId] : null) ?? (detail?.outcomePrices[0] ?? null);
  const noPrice = getBestAsk(noBook) ?? (noTokenId ? liveTokenPrices[noTokenId] : null) ?? (detail?.outcomePrices[1] ?? null);
  const visibleOpenOrders = mergeOpenOrders(pendingOpenOrders, openOrders);

  // ── Multi-outcome event mode (PRD §5) — derived data ──
  // The detail endpoint attaches an `event` block when this market is one leg
  // of a parent event. Its ladder replaces the Yes/No buttons; every outcome's
  // tokens join the live-price/book polling so rung prices stay current.
  const event = detail?.event ?? null;
  const isEventMode = event !== null;
  const eventOutcomePrices = useMemo(() => {
    if (!event) return {} as Record<string, number | null>;
    const map: Record<string, number | null> = {};
    for (const outcome of event.outcomes) {
      const tokenId = outcome.clobTokenIds[0];
      map[outcome.id] = (tokenId ? getBestAsk(buyBooks[tokenId] ?? null) : null)
        ?? (tokenId ? liveTokenPrices[tokenId] ?? null : null)
        ?? outcome.price;
    }
    return map;
  }, [event, buyBooks, liveTokenPrices]);
  const selectedEventOutcome = useMemo(
    () => (event && eventOutcomeId ? event.outcomes.find((o) => o.id === eventOutcomeId) ?? null : null),
    [event, eventOutcomeId],
  );
  const selectedEventPrice = selectedEventOutcome
    ? eventOutcomePrices[selectedEventOutcome.id] ?? null
    : null;
  const selectedEventBook = selectedEventOutcome?.clobTokenIds[0]
    ? buyBooks[selectedEventOutcome.clobTokenIds[0]] ?? null
    : null;

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

  function tapOdd(side: 'yes' | 'no') {
    if (submitInFlightRef.current || submitting) return;
    if (numpadOpen && selectedSide === side) {
      // same tap — collapse
      setNumpadOpen(false);
      setSelectedSide(null);
      return;
    }
    setSelectedSide(side);
    setSelectedQuotePrice(side === 'yes' ? (yesPrice ?? detail?.outcomePrices[0] ?? null) : (noPrice ?? detail?.outcomePrices[1] ?? null));
    setNumpadAmount('10');
    setNumpadOpen(true);
    if (COMPOSER_V2) {
      setComposerOpen(true);
    }
  }

  /** Event mode: open the composer for one ladder rung (PRD §5). */
  function tapEventOutcome(outcomeId: string) {
    if (submitInFlightRef.current || submitting) return;
    if (!event) return;
    const outcome = event.outcomes.find((o) => o.id === outcomeId);
    if (!outcome || outcome.closed || marketClosed) return;
    if (composerOpen && eventOutcomeId === outcomeId && numpadOpen) {
      collapseNumpad();
      return;
    }
    setSelectedSide(null);
    setEventOutcomeId(outcomeId);
    setSelectedQuotePrice(eventOutcomePrices[outcomeId] ?? outcome.price ?? null);
    setNumpadAmount('10');
    setNumpadOpen(true);
    if (COMPOSER_V2) {
      setComposerOpen(true);
    }
  }

  function collapseNumpad() {
    setNumpadOpen(false);
    setSelectedSide(null);
    setSelectedQuotePrice(null);
    setComposerOpen(false);
    setEventOutcomeId(null);
  }

  async function submitOrder(paramsOverride?: { mode: ComposerMode; limitPriceCents: number } | null) {
    if (!detail || submitting || submitInFlightRef.current) return;
    if (!selectedSide && !selectedEventOutcome) return;
    const amount = parseFloat(numpadAmount);
    if (!amount || amount <= 0) return;

    // Event mode: the selected ladder rung owns the token and price. Binary
    // mode: yes = clobTokenIds[0], no = clobTokenIds[1].
    let tokenID: string | undefined;
    let price: number | null;
    let outcomeLabel: string;
    if (isEventMode && selectedEventOutcome) {
      tokenID = selectedEventOutcome.clobTokenIds[0];
      price = selectedEventPrice ?? selectedEventOutcome.price;
      outcomeLabel = selectedEventOutcome.label;
    } else {
      tokenID = selectedSide === 'yes' ? detail.clobTokenIds[0] : detail.clobTokenIds[1];
      price = selectedSide === 'yes'
        ? (yesPrice ?? detail.outcomePrices[0])
        : (noPrice ?? detail.outcomePrices[1]);
      outcomeLabel = selectedSide === 'no' ? 'No' : 'Yes';
    }
    if (!tokenID) {
      Alert.alert('Error', 'No token ID for this outcome');
      return;
    }
    if (!price || price <= 0 || price >= 1) {
      Alert.alert('Error', 'Invalid price');
      return;
    }
    const guardrail = getPredictOrderGuardrail({
      amount,
      availableCash: cashBalance,
      selectedPrice: selectedQuotePrice,
      latestPrice: price,
      marketActive: detail.active,
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
      // Composer v2 limit mode: rest at the user's chosen price instead of
      // executing at the book average. Size = spend / chosen price.
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
        const expirationMs = Date.parse(detail.endDate ?? '');
        if (!Number.isFinite(expirationMs) || expirationMs <= Date.now() + 60_000) {
          throw new Error('This market has no future deadline for a limit order. Use a market order instead.');
        }
        const resultLimit = await placeBet(poly.client, {
          tokenID,
          price: limitPrice,
          size: limitShares,
          side: 'BUY',
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
          outcome: outcomeLabel,
        });
        setPendingOpenOrders((prev) => [pendingLimit, ...prev.filter((o) => o.id !== pendingLimit.id)]);
        setCashBalance((prev) => (prev === null ? prev : Math.max(prev - amount, 0)));
        collapseNumpad();
        setActiveView('picks');
        setPickScope('market');
        await Promise.allSettled([
          loadPicks(),
          fetchClobBalance(poly.client).then((b) => setCashBalance(b?.balance ?? null)),
          activeView === 'orderbook' ? loadOrderbook() : Promise.resolve(),
        ]);
        scheduleFollowUpReconcile();
        return;
      }
      if (!quote.executable || quote.limitPrice === null || quote.shares <= 0) {
        Alert.alert('Not filled', 'Not enough liquidity at the current price. Try a smaller amount or refresh the market.');
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
        outcome: outcomeLabel,
      });
      setPendingOpenOrders((prev) => [pendingOrder, ...prev.filter((order) => order.id !== pendingOrder.id)]);
      setCashBalance((prev) => prev === null ? prev : Math.max(prev - amount, 0));
      collapseNumpad();
      setActiveView('picks');
      setPickScope('market');
      await Promise.allSettled([
        loadPicks(),
        fetchClobBalance(poly.client).then((balance) => setCashBalance(balance?.balance ?? null)),
        activeView === 'orderbook' ? loadOrderbook() : Promise.resolve(),
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

  const chartWidth = Math.max(260, screenWidth - 60);
  const chartHeight = 180;
  const amountNum = parseFloat(numpadAmount) || 0;
  const latestSelectedPrice = selectedSide === 'no' ? noPrice : yesPrice;
  const selectedBook = selectedSide === 'no' ? noBook : yesBook;
  const selectedExecutableQuote = buildExecutableBuyQuote(selectedBook, amountNum);
  // Event mode quotes off the selected rung's book instead of the Yes/No books.
  const selectedEventQuote = selectedEventBook
    ? buildExecutableBuyQuote(selectedEventBook, amountNum)
    : { executable: false, averagePrice: null, shares: 0, limitPrice: null, unfilledAmount: null };
  const activeSelectedBook = isEventMode ? selectedEventBook : selectedBook;
  const activeExecutableQuote = isEventMode ? selectedEventQuote : selectedExecutableQuote;
  const selectedNumpadPrice = activeExecutableQuote.averagePrice
    ?? (isEventMode ? selectedEventPrice ?? latestSelectedPrice : latestSelectedPrice)
    ?? 0.5;
  const orderGuardrail = (selectedSide || selectedEventOutcome)
    ? getPredictOrderGuardrail({
        amount: amountNum,
        availableCash: cashBalance,
        selectedPrice: selectedQuotePrice,
        latestPrice: isEventMode ? selectedEventPrice ?? latestSelectedPrice : latestSelectedPrice,
        marketActive: detail?.active ?? null,
        submitting,
      })
    : null;
  const marketClosed = detail?.active === false;
  const submitLabel =
    submitStatus === 'wallet'
      ? 'Confirming wallet...'
      : submitStatus === 'syncing'
        ? 'Syncing pick...'
        : 'Placing order...';
  const activePosition = [...marketPositions].sort((a, b) => b.currentValue - a.currentValue)[0] ?? null;

  if (detail && !loading && !errorMessage && !isEventMode) {
    const yesPct = yesPrice === null ? 50 : Math.max(0, Math.min(100, yesPrice * 100));
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <AppTopBar
          left={<AppTopBarIconButton icon="arrow-back" onPress={() => router.back()} accessibilityLabel="Go back" />}
          center={(
            <View style={styles.mockTitleLockup}>
              <Text style={styles.mockTopTitle} numberOfLines={1}>{detail.question}</Text>
              <Text style={styles.mockTopSubtitle}>{detail.category ? `${detail.category} · ` : ''}Binary</Text>
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
              <Text style={styles.mockKind}>Yes or no</Text>
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

            <View style={styles.mockBinaryHero}>
              <View style={styles.mockBinaryMeta}>
                <Text style={styles.mockCategory}>{detail.category ?? 'Binary'}</Text>
                <Text style={styles.mockResolveMeta}>
                  {formatResolveDate(detail.endDate)}{detail.volume !== null ? ` · ${formatUsdCompact(detail.volume)} traded` : ''}
                </Text>
              </View>
              <Text style={styles.mockQuestion}>{detail.question}</Text>
              <View style={styles.mockConsensus} accessibilityLabel={`Yes ${Math.round(yesPct)} percent, No ${Math.round(100 - yesPct)} percent`}>
                <View style={styles.mockConsensusSide}>
                  <Text style={styles.mockYesPrice}>{yesPrice === null ? '--' : `${Math.round(yesPrice * 100)}¢`}</Text>
                  <Text style={styles.mockConsensusLabel}>Yes</Text>
                </View>
                <View style={styles.mockConsensusTrack}>
                  <View style={[styles.mockConsensusFill, { width: `${yesPct}%` }]} />
                </View>
                <View style={[styles.mockConsensusSide, styles.mockConsensusSideRight]}>
                  <Text style={styles.mockNoPrice}>{noPrice === null ? '--' : `${Math.round(noPrice * 100)}¢`}</Text>
                  <Text style={styles.mockConsensusLabel}>No</Text>
                </View>
              </View>
            </View>

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
                      {(['yes', 'no'] as const).map((side) => (
                        <Pressable
                          key={side}
                          accessibilityRole="tab"
                          accessibilityState={{ selected: binaryBookSide === side }}
                          style={[styles.mockBookTab, binaryBookSide === side && styles.mockBookTabActive]}
                          onPress={() => setBinaryBookSide(side)}
                        >
                          <Text style={[styles.mockBookTabText, binaryBookSide === side && styles.mockBookTabTextActive]}>{side === 'yes' ? 'Yes' : 'No'}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <OrderbookView book={orderbook} loading={orderbookLoading} />
                  </View>
                ) : historyLoading ? (
                  <ActivityIndicator color={semantic.text.faint} />
                ) : (
                  <MultiLineChart
                    series={[
                      { points: yesHistory, color: tokens.colors.viridian, label: 'Yes' },
                      { points: noHistory, color: tokens.colors.vermillion, label: 'No' },
                    ]}
                    width={chartWidth}
                    height={chartHeight}
                  />
                )}
              </View>
            </View>

            <View style={styles.mockPicks}>
              <View style={styles.mockPicksHead}>
                <Text style={styles.mockPicksTitle}>What’s your pick?</Text>
                <Text style={styles.mockPicksMeta}>Current price</Text>
              </View>
              {marketClosed ? <Text style={styles.marketClosedText}>This market is closed.</Text> : null}
              <View style={styles.mockBinaryButtons}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: selectedSide === 'yes', disabled: marketClosed || submitting }}
                  disabled={marketClosed || submitting}
                  style={[styles.mockBinaryButton, selectedSide === 'yes' && styles.mockBinaryButtonSelected]}
                  onPress={() => tapOdd('yes')}
                >
                  <Text style={styles.mockBinaryLabel}>Yes, it will</Text>
                  <Text style={styles.mockYesButtonPrice}>{yesPrice === null ? '--' : `${Math.round(yesPrice * 100)}¢`}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: selectedSide === 'no', disabled: marketClosed || submitting }}
                  disabled={marketClosed || submitting}
                  style={[styles.mockBinaryButton, selectedSide === 'no' && styles.mockBinaryButtonSelected]}
                  onPress={() => tapOdd('no')}
                >
                  <Text style={styles.mockBinaryLabel}>No, it won’t</Text>
                  <Text style={styles.mockNoButtonPrice}>{noPrice === null ? '--' : `${Math.round(noPrice * 100)}¢`}</Text>
                </Pressable>
              </View>
              <View style={styles.mockHint}>
                <MaterialIcons name="touch-app" size={13} color={tokens.colors.accent} />
                <Text style={styles.mockHintText}>Tap a side to place an order</Text>
              </View>
            </View>
          </View>
        </ScrollView>

        <DetailPositionSheet
          visible={positionOpen}
          position={activePosition}
          title={detail.question}
          onClose={() => setPositionOpen(false)}
          onAdd={() => {
            setPositionOpen(false);
            if (activePosition) tapOdd(activePosition.outcome.toLowerCase() === 'no' ? 'no' : 'yes');
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
          visible={composerOpen && selectedSide !== null}
          side={selectedSide ?? 'yes'}
          pickLabel={selectedSide === 'no' ? 'No' : 'Yes'}
          question={detail.question}
          currentPrice={selectedQuotePrice}
          amount={numpadAmount}
          onAmountChange={setNumpadAmount}
          executableAvgPrice={marketClosed || !activeExecutableQuote.executable ? null : activeExecutableQuote.averagePrice}
          minimumOrderSize={activeSelectedBook?.minOrderSize ?? null}
          availableCash={cashBalance}
          guardrail={orderGuardrail}
          submitting={submitting}
          submittingLabel={submitLabel}
          disabled={marketClosed}
          limitOrderNote="Cancels automatically at the market deadline."
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
        center={(
          <AppTopBarTitle align="left" numberOfLines={2} tone="primary" uppercase={false}>
            {detail?.question ?? 'Loading...'}
          </AppTopBarTitle>
        )}
        right={<AppTopBarCashPill value={truncateUsd(cashBalance)} />}
      />

      {/* ── LOADING / ERROR ── */}
      {loading ? (
        <View style={styles.stateWrap}>
          <ActivityIndicator size="small" color={semantic.text.accent} />
          <Text style={styles.stateText}>Loading market...</Text>
        </View>
      ) : errorMessage ? (
        <View style={styles.stateWrap}>
          <Text style={styles.stateTitle}>Market unavailable</Text>
          <Text style={styles.stateText}>{errorMessage}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            accessibilityHint="Reload market details"
            onPress={() => void loadMarket()}
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
            {/* Question + resolution context first (PRD §4). The description
                doubles as the rules source — dedicated upstream fields are
                usually empty, so no named external source is promised. */}
            <View style={styles.questionHeader}>
              <Text style={styles.questionTitle} numberOfLines={3}>{detail.question}</Text>
              <View style={styles.questionMetaRow}>
                {detail.category ? <Text style={styles.questionCategory}>{detail.category.toUpperCase()}</Text> : null}
                <Text style={styles.questionDeadline}>{formatDeadline(detail.endDate, detail.active)}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="How this market resolves"
                style={styles.questionRulesBtn}
                onPress={() => setRulesOpen(true)}>
                <MaterialIcons name="info-outline" size={13} color={semantic.text.accent} />
                <Text style={styles.questionRulesText}>How this resolves</Text>
              </Pressable>
            </View>

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

            {/* Chart or Orderbook */}
            <View style={styles.viewContainer}>
              {activeView === 'picks' ? (
                <DetailPicksPanel
                  scope={pickScope}
                  marketSlug={slug}
                  marketTokenIds={detail.clobTokenIds}
                  marketConditionIds={marketPositions.map((position) => position.conditionId)}
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
                  onBackMore={(position) => {
                    if (position.slug && position.slug !== slug) {
                      router.push(getPredictMarketHref(position.slug));
                      return;
                    }
                    tapOdd(position.outcome === 'No' ? 'no' : 'yes');
                  }}
                  onCancelOrder={(orderId) => void handleCancelOrder(orderId)}
                  onRedeemed={() => void loadPicks()}
                  onRetry={() => void loadPicks()}
                />
              ) : activeView === 'stats' ? (
                <View style={styles.statsView}>
                  <View style={styles.picksHeading}>
                    <Text style={styles.picksTitle}>Stats</Text>
                    <Text style={styles.picksSubtitle}>Market health</Text>
                  </View>
                  <View style={styles.statsGrid}>
                    <View style={styles.statsCard}><Text style={styles.statsLabel}>Volume</Text><Text style={styles.statsValue}>{formatUsdCompact(detail.volume24h)}</Text></View>
                    <View style={styles.statsCard}><Text style={styles.statsLabel}>Liquidity</Text><Text style={styles.statsValue}>{formatUsdCompact(detail.liquidity)}</Text></View>
                    <View style={styles.statsCard}><Text style={styles.statsLabel}>No chance</Text><Text style={styles.statsValue}>{noPrice !== null ? `${Math.round(noPrice * 100)}%` : '--'}</Text></View>
                    <View style={styles.statsCard}><Text style={styles.statsLabel}>Resolves</Text><Text style={styles.statsValue}>{formatDeadline(detail.endDate, detail.active)}</Text></View>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="How this market resolves"
                    style={styles.rulesLink}
                    onPress={() => setRulesOpen(true)}>
                    <Text style={styles.rulesLinkText}>How this resolves</Text>
                  </Pressable>
                </View>
              ) : activeView === 'chart' ? (
                historyLoading ? (
                  <View style={styles.chartSkeleton}>
                    <ActivityIndicator size="small" color={semantic.text.faint} />
                  </View>
                ) : (
                  <MultiLineChart
                    series={[
                      { points: yesHistory, color: semantic.sentiment.negative, label: 'Yes' },
                      { points: noHistory, color: semantic.sentiment.positive, label: 'No' },
                    ]}
                    width={chartWidth}
                    height={chartHeight}
                  />
                )
              ) : isEventMode && event ? (
                <View style={styles.obWrap}>
                  {/* One book per outcome (PRD §5) */}
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.obTabs}>
                    {event.outcomes.map((o, i) => (
                      <Pressable
                        key={o.id}
                        accessibilityRole="tab"
                        accessibilityLabel={`Show ${o.label} order book`}
                        accessibilityState={{ selected: eventBookIdx === i }}
                        style={[styles.obTab, eventBookIdx === i && styles.obTabActive]}
                        onPress={() => setEventBookIdx(i)}>
                        <Text
                          numberOfLines={1}
                          style={[styles.obTabText, eventBookIdx === i && styles.obTabTextActive]}>
                          {o.label}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                  <OrderbookView book={orderbook} loading={orderbookLoading} />
                </View>
              ) : (
                <OrderbookView book={orderbook} loading={orderbookLoading} />
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

            {/* Odds format toggle + Binary odds buttons */}
            <View style={styles.oddsSection}>
              <View style={styles.oddsHeader}>
                <Text style={styles.oddsTitle}>{"What's your pick?"}</Text>
                {/*
                <OddsFormatToggle format={format} onFormatChange={setFormat} />
                */}
              </View>
              {marketClosed && (
                <Text style={styles.marketClosedText}>This market is closed and no longer accepting new picks.</Text>
              )}
              {isEventMode && event ? (
                /* Multi-outcome ladder (PRD §5) — one rung per sub-market,
                   odds toggle Probability/Decimal/American, prices in cents. */
                <View>
                  <View style={styles.ladderToggleRow}>
                    {(['probability', 'decimal', 'american'] as EventOddsFormat[]).map((f) => (
                      <Pressable
                        key={f}
                        accessibilityRole="tab"
                        accessibilityLabel={`${f} odds`}
                        accessibilityState={{ selected: eventOddsFormat === f }}
                        style={[styles.ladderToggle, eventOddsFormat === f && styles.ladderToggleActive]}
                        onPress={() => setEventOddsFormat(f)}>
                        <Text style={[
                          styles.ladderToggleText,
                          eventOddsFormat === f && styles.ladderToggleTextActive,
                        ]}>
                          {f === 'probability' ? '%' : f === 'decimal' ? 'DEC' : 'AM'}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <EventOutcomeLadder
                    outcomes={event.outcomes.map((o) => ({
                      id: o.id,
                      label: o.label,
                      price: eventOutcomePrices[o.id] ?? o.price ?? 0,
                    }))}
                    selectedId={eventOutcomeId}
                    onSelect={tapEventOutcome}
                    oddsFormat={eventOddsFormat}
                  />
                </View>
              ) : (
                <View style={styles.binaryBtns}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Back YES at ${yesPrice !== null ? formatOdds(yesPrice) : 'unavailable'}`}
                    accessibilityState={{ selected: selectedSide === 'yes', disabled: marketClosed || submitting }}
                    accessibilityHint="Open order entry for YES"
                    style={[styles.bnBtn, styles.bnBtnYes, selectedSide === 'yes' && styles.bnBtnYesSelected]}
                    disabled={marketClosed || submitting}
                    onPress={() => tapOdd('yes')}>
                    <Text style={styles.bnBtnYesPrice}>{yesPrice !== null ? formatOdds(yesPrice) : '--'}</Text>
                    <Text style={styles.bnBtnYesLabel}>Back YES</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Back NO at ${noPrice !== null ? formatOdds(noPrice) : 'unavailable'}`}
                    accessibilityState={{ selected: selectedSide === 'no', disabled: marketClosed || submitting }}
                    accessibilityHint="Open order entry for NO"
                    style={[styles.bnBtn, styles.bnBtnNo, selectedSide === 'no' && styles.bnBtnNoSelected]}
                    disabled={marketClosed || submitting}
                    onPress={() => tapOdd('no')}>
                    <Text style={styles.bnBtnNoPrice}>{noPrice !== null ? formatOdds(noPrice) : '--'}</Text>
                    <Text style={styles.bnBtnNoLabel}>Back NO</Text>
                  </Pressable>
                </View>
              )}
            </View>

            {/* Inline numpad */}
            <InlineNumpad
              visible={numpadOpen}
              side={selectedSide ?? 'yes'}
              pickLabel={selectedSide === 'no' ? 'NO' : 'YES'}
              price={selectedNumpadPrice}
              amount={numpadAmount}
              minimumOrderSize={activeSelectedBook?.minOrderSize ?? null}
              availableCash={cashBalance}
              onAmountChange={setNumpadAmount}
              onConfirm={() => { void submitOrder(); }}
              submitting={submitting}
              submittingLabel={submitLabel}
              disabled={!poly.isReady}
              guardrail={orderGuardrail}
              setupRequired={!poly.isReady}
              onSetupPress={() => { void handlePredictSetupPress(); }}
              setupSubmitting={setupSubmitting || setupAfterConnect || poly.isLoading}
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

      {/* Composer v2 — shared sheet from the Predict redesign (PRD §6).
          Event mode: the selected ladder rung drives side/label/price. */}
      <ResolutionRulesSheet
        visible={rulesOpen}
        description={(event?.description ?? detail?.description) ?? null}
        onClose={() => setRulesOpen(false)}
      />
      <OrderComposerSheet
        visible={COMPOSER_V2 && composerOpen && (selectedSide !== null || selectedEventOutcome !== null)}
        side={isEventMode ? 'yes' : selectedSide ?? 'yes'}
        pickLabel={
          isEventMode
            ? (selectedEventOutcome?.label ?? undefined)
            : (selectedSide === 'no' ? 'NO' : 'YES')
        }
        question={(event?.title ?? detail?.question) ?? null}
        currentPrice={selectedQuotePrice}
        amount={numpadAmount}
        onAmountChange={setNumpadAmount}
        executableAvgPrice={
          marketClosed
            ? null
            : (() => {
                const q = activeExecutableQuote;
                return q.executable && q.averagePrice !== null ? q.averagePrice : null;
              })()
        }
        minimumOrderSize={activeSelectedBook?.minOrderSize ?? null}
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
  mockTopSubtitle: { paddingTop: 2, fontFamily: 'monospace', fontSize: 8, textTransform: 'capitalize', color: semantic.text.faint },
  mockScroll: { flex: 1 },
  mockContent: { paddingHorizontal: 14, paddingTop: 10 },
  mockCard: { overflow: 'hidden', borderRadius: 24, borderCurve: 'continuous', borderWidth: 1, borderColor: semantic.border.muted, backgroundColor: tokens.colors.surface, boxShadow: '0 12px 26px rgba(3,31,44,0.32)' },
  mockCardTop: { minHeight: 48, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: semantic.border.muted },
  mockKind: { fontFamily: 'monospace', fontSize: 9, fontWeight: '900', textTransform: 'uppercase', color: semantic.text.dim },
  mockPositionButton: { minHeight: 32, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 11, borderCurve: 'continuous', backgroundColor: tokens.colors.lift },
  mockPositionLabel: { fontFamily: 'monospace', fontSize: 8, fontWeight: '800', color: semantic.text.dim },
  mockPositionPnl: { fontFamily: 'monospace', fontSize: 9, fontWeight: '900', color: tokens.colors.viridian },
  mockPositionPnlNegative: { color: tokens.colors.vermillion },
  mockBinaryHero: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 18 },
  mockBinaryMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  mockCategory: { fontFamily: 'monospace', fontSize: 8, fontWeight: '900', textTransform: 'uppercase', color: tokens.colors.accent },
  mockResolveMeta: { flex: 1, textAlign: 'right', fontFamily: 'monospace', fontSize: 8, color: semantic.text.faint },
  mockQuestion: { paddingTop: 12, fontSize: 25, lineHeight: 29, letterSpacing: -0.8, fontWeight: '900', color: semantic.text.primary },
  mockConsensus: { paddingTop: 20, flexDirection: 'row', alignItems: 'center', gap: 10 },
  mockConsensusSide: { minWidth: 42 },
  mockConsensusSideRight: { alignItems: 'flex-end' },
  mockYesPrice: { fontFamily: 'monospace', fontSize: 18, fontWeight: '900', color: tokens.colors.viridian },
  mockNoPrice: { fontFamily: 'monospace', fontSize: 18, fontWeight: '900', color: tokens.colors.vermillion },
  mockConsensusLabel: { paddingTop: 3, fontFamily: 'monospace', fontSize: 8, color: semantic.text.faint },
  mockConsensusTrack: { flex: 1, height: 10, overflow: 'hidden', borderRadius: 5, backgroundColor: tokens.colors.vermillion },
  mockConsensusFill: { height: '100%', backgroundColor: tokens.colors.viridian },
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
  mockBookWrap: { width: '100%', minHeight: 202, paddingHorizontal: 5 },
  mockBookTabs: { flexDirection: 'row', gap: 5, paddingBottom: 8 },
  mockBookTab: { flex: 1, minHeight: 36, borderRadius: 10, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.surface },
  mockBookTabActive: { backgroundColor: tokens.colors.accent },
  mockBookTabText: { fontFamily: 'monospace', fontSize: 9, fontWeight: '800', color: semantic.text.faint },
  mockBookTabTextActive: { color: tokens.colors.backgroundDark },
  mockPicks: { paddingHorizontal: 13, paddingTop: 13, paddingBottom: 15, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: semantic.border.muted, backgroundColor: tokens.colors.surface },
  mockPicksHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  mockPicksTitle: { fontSize: 13, fontWeight: '900', color: semantic.text.primary },
  mockPicksMeta: { fontFamily: 'monospace', fontSize: 8, color: semantic.text.faint },
  mockBinaryButtons: { paddingTop: 10, flexDirection: 'row', gap: 8 },
  mockBinaryButton: { flex: 1, minHeight: 74, paddingHorizontal: 12, paddingVertical: 11, justifyContent: 'space-between', borderRadius: 15, borderCurve: 'continuous', borderWidth: 1, borderColor: semantic.border.muted, backgroundColor: tokens.colors.ground },
  mockBinaryButtonSelected: { borderColor: tokens.colors.accent, backgroundColor: tokens.colors.lift, boxShadow: `inset 0 -4px 0 ${tokens.colors.accent}` },
  mockBinaryLabel: { fontSize: 11, fontWeight: '900', color: semantic.text.dim },
  mockYesButtonPrice: { fontFamily: 'monospace', fontSize: 20, fontWeight: '900', color: tokens.colors.viridian },
  mockNoButtonPrice: { fontFamily: 'monospace', fontSize: 20, fontWeight: '900', color: tokens.colors.vermillion },
  mockHint: { paddingTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  mockHintText: { fontFamily: 'monospace', fontSize: 8, fontWeight: '800', textTransform: 'uppercase', color: semantic.text.faint },

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

  // ── Question header (PRD §4) ──
  questionHeader: {
    paddingTop: 6,
    paddingBottom: 10,
  },
  questionTitle: {
    fontFamily: 'monospace',
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '800',
    color: semantic.text.primary,
  },
  questionMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 6,
  },
  questionCategory: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1.2,
    color: semantic.text.faint,
    textTransform: 'uppercase',
  },
  questionDeadline: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.dim,
    textTransform: 'uppercase',
  },
  questionRulesBtn: {
    marginTop: 8,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: tokens.colors.surface,
  },
  questionRulesText: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    color: semantic.text.accent,
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
  rangeChipActive: {
    backgroundColor: tokens.colors.surface,
  },
  rangeChipText: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1,
    color: semantic.text.faint,
  },
  rangeChipTextActive: {
    color: semantic.text.primary,
  },
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
  toggleBtnActive: {
    backgroundColor: tokens.colors.surface,
  },
  rulesLink: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: tokens.colors.surface,
  },
  rulesLinkText: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    color: semantic.text.accent,
  },
  viewContainer: {
    flex: 1,
    minHeight: 0,
  },
  chartSkeleton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  // ── Binary odds ──
  oddsSection: {
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  oddsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  oddsTitle: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  marketClosedText: {
    marginBottom: 8,
    fontFamily: 'monospace',
    fontSize: 8,
    color: tokens.colors.vermillion,
  },
  binaryBtns: {
    flexDirection: 'row',
    gap: 8,
  },
  // ── Event ladder odds toggle (PRD §5) ──
  ladderToggleRow: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: 8,
  },
  ladderToggle: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colors.lift,
  },
  ladderToggleActive: {
    backgroundColor: tokens.colors.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
  },
  ladderToggleText: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: semantic.text.faint,
  },
  ladderToggleTextActive: {
    color: semantic.text.primary,
  },
  // ── Event Book tabs (PRD §5) ──
  obWrap: {
    flex: 1,
  },
  obTabs: {
    flexDirection: 'row',
    gap: 4,
    paddingBottom: 8,
  },
  obTab: {
    minHeight: 36,
    maxWidth: 140,
    paddingHorizontal: 10,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colors.lift,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  obTabActive: {
    backgroundColor: tokens.colors.surface,
    borderColor: semantic.border.muted,
  },
  obTabText: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '700',
    color: semantic.text.faint,
  },
  obTabTextActive: {
    color: semantic.text.primary,
  },
  bnBtn: {
    flex: 1,
    height: 54,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  bnBtnYes: {
    backgroundColor: semantic.predict.outcomeYesBg,
  },
  bnBtnNo: {
    backgroundColor: semantic.predict.outcomeNoBg,
  },
  bnBtnYesSelected: {
    backgroundColor: 'rgba(74,140,111,0.25)',
    borderWidth: 1,
    borderColor: 'rgba(74,140,111,0.35)',
  },
  bnBtnNoSelected: {
    backgroundColor: 'rgba(217,83,79,0.20)',
    borderWidth: 1,
    borderColor: 'rgba(217,83,79,0.35)',
  },
  bnBtnYesPrice: {
    fontFamily: 'monospace',
    fontSize: 18,
    fontWeight: '700',
    color: semantic.sentiment.positive,
    lineHeight: 22,
  },
  bnBtnYesLabel: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: 'rgba(74,140,111,0.55)',
  },
  bnBtnNoPrice: {
    fontFamily: 'monospace',
    fontSize: 18,
    fontWeight: '700',
    color: semantic.sentiment.negative,
    lineHeight: 22,
  },
  bnBtnNoLabel: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: 'rgba(217,83,79,0.45)',
  },
});
