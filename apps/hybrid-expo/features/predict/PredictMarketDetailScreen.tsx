import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { useLocalSearchParams } from 'expo-router';
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
import { OddsFormatToggle } from '@/features/predict/components/OddsFormatToggle';
import { MultiLineChart } from '@/features/predict/components/MultiLineChart';
import { OrderbookView } from '@/features/predict/components/OrderbookView';
import { InlineNumpad } from '@/features/predict/components/InlineNumpad';
import { OrderComposerSheet } from '@/features/predict/components/OrderComposerSheet';
import type { ComposerMode } from '@/features/predict/components/OrderComposerSheet';
import { DetailPicksPanel } from '@/features/predict/components/DetailPicksPanel';
import { CashOutConfirmModal } from '@/features/predict/components/CashOutConfirmModal';
import { truncateUsd } from '@/features/predict/formatPredictMoney';
import { buildExecutableBuyQuote, getBestAsk } from '@/features/predict/orderbookQuote';
import { usePositionSellQuotes } from '@/features/predict/positionSellQuotes';
import { makePendingOpenOrder, mergeOpenOrders, prunePendingOpenOrders } from '@/features/predict/pendingOpenOrders';
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

// Composer v2 pilot flag (Predict redesign PRD §6). Default OFF: the original
// InlineNumpad flow is untouched. Flip to true (or pass ?composer=v2 on web)
// to route the Yes/No amount flow through the shared OrderComposerSheet.
const COMPOSER_V2_DEFAULT = false;

function formatDeadline(endDate: string | null, active: boolean | null): string {
  if (!endDate) return active === false ? 'Closed' : 'Open';
  const time = Date.parse(endDate);
  if (Number.isNaN(time)) return active === false ? 'Closed' : 'Open';
  const date = new Date(time);
  const month = date.toLocaleString('en-US', { month: 'short' });
  const day = date.getDate();
  return `${active === false ? 'Ended' : 'Ends'} ${month} ${day}`;
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
  // Composer v2 can be force-enabled for QA via ?composer=v2 on web.
  const urlParams = useLocalSearchParams<{ composer?: string }>();
  const COMPOSER_V2 = COMPOSER_V2_DEFAULT || urlParams.composer === 'v2';
  const router = useRouter();
  const poly = usePolymarketWallet();
  const connectSheet = useConnectionSheet('evm');
  const { format, setFormat, formatOdds } = useOddsFormat();
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
  const [yesHistory, setYesHistory] = useState<PricePoint[]>([]);
  const [noHistory, setNoHistory] = useState<PricePoint[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>('chart');
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null);
  const [orderbookLoading, setOrderbookLoading] = useState(false);
  const [buyBooks, setBuyBooks] = useState<Record<string, Orderbook | null>>({});

  // Numpad state
  const [numpadOpen, setNumpadOpen] = useState(false);
  const [selectedSide, setSelectedSide] = useState<'yes' | 'no' | null>(null);
  const [selectedQuotePrice, setSelectedQuotePrice] = useState<number | null>(null);
  const [numpadAmount, setNumpadAmount] = useState('50');
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
  const [cashOutPosition, setCashOutPosition] = useState<PortfolioPosition | null>(null);
  // Composer v2 pilot state (Predict redesign PRD §6). Flag-gated; see COMPOSER_V2.
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerParams, setComposerParams] = useState<{ mode: ComposerMode; limitPriceCents: number } | null>(null);

  // Soft zone animation
  const softZoneAnim = useRef(new Animated.Value(SOFT_COLLAPSED)).current;
  const reconcileTimeouts = useRef<ReturnType<typeof setTimeout>[]>([]);
  const submitInFlightRef = useRef(false);
  const buyBookRefreshInFlight = useRef(false);
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
    if (!detail) return;
    const tokenId = detail.clobTokenIds[0];
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
    if (!poly.polygonAddress) {
      setCashBalance(null);
      return;
    }
    const balance = await fetchClobBalance(poly.polygonAddress).catch(() => null);
    if (walletScopedKeyRef.current !== requestKey) return;
    setCashBalance(balance?.balance ?? null);
  }

  async function loadPicks() {
    const requestKey = walletScopedKeyRef.current;
    const gammaAddr = poly.tradingAddress ?? poly.polygonAddress;
    if (!gammaAddr) {
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
        fetchMarketPositions(gammaAddr, slug),
        fetchPortfolio(gammaAddr),
        poly.polygonAddress ? fetchOpenOrders(poly.polygonAddress) : Promise.resolve([]),
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
        ])
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

  useEffect(() => {
    if (activeView !== 'picks' || pendingOpenOrders.length === 0) return;
    const timer = globalThis.setInterval(() => { void loadPicks(); }, 5_000);
    return () => globalThis.clearInterval(timer);
  }, [activeView, pendingOpenOrders.length, slug, poly.polygonAddress, poly.tradingAddress]);

  async function handleCancelOrder(orderId: string) {
    if (!poly.polygonAddress || cancellingOrderId) return;
    setCancellingOrderId(orderId);
    try {
      const result = await cancelOrder(poly.polygonAddress, orderId);
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

  function scheduleFollowUpReconcile(polygonAddress: string) {
    const requestKey = walletScopedKeyRef.current;
    const timeout = setTimeout(() => {
      reconcileTimeouts.current = reconcileTimeouts.current.filter((item) => item !== timeout);
      void Promise.allSettled([
        loadPicks(),
        fetchClobBalance(polygonAddress).then((balance) => {
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

  // Load orderbook when switching to orderbook view
  useEffect(() => {
    if (activeView === 'orderbook' && detail) void loadOrderbook();
  }, [activeView, detail]);

  useEffect(() => {
    if (activeView === 'picks') void loadPicks();
  }, [activeView, slug, poly.polygonAddress, poly.tradingAddress]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!poly.polygonAddress) {
        setCashBalance(null);
        return;
      }
      const requestKey = walletScopedKeyRef.current;
      const balance = await fetchClobBalance(poly.polygonAddress).catch(() => null);
      if (!cancelled && walletScopedKeyRef.current === requestKey) setCashBalance(balance?.balance ?? null);
    }
    void run();
    return () => { cancelled = true; };
  }, [poly.polygonAddress]);

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
    setNumpadAmount('50');
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
  }

  async function submitOrder() {
    if (!detail || !selectedSide || submitting || submitInFlightRef.current) return;
    const amount = parseFloat(numpadAmount);
    if (!amount || amount <= 0) return;

    // Resolve token ID: yes = clobTokenIds[0], no = clobTokenIds[1]
    const tokenID = selectedSide === 'yes' ? detail.clobTokenIds[0] : detail.clobTokenIds[1];
    if (!tokenID) {
      Alert.alert('Error', 'No token ID for this outcome');
      return;
    }

    // Price: what the user is buying at
    const price = selectedSide === 'yes'
      ? (yesPrice ?? detail.outcomePrices[0])
      : (noPrice ?? detail.outcomePrices[1]);
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

      if (!poly.polygonAddress) throw new Error('Wallet session not ready');
      const signer = poly.signer;
      if (!signer) throw new Error('Wallet session not ready');

      const freshBook = await fetchOrderbook(tokenID).catch(() => null);
      const quote = buildExecutableBuyQuote(freshBook, amount);
      // Composer v2 limit mode: rest at the user's chosen price instead of
      // executing at the book average. Size = spend / chosen price.
      const effectiveLimitCents =
        composerParams?.mode === 'limit' && composerParams.limitPriceCents > 0
          ? composerParams.limitPriceCents
          : null;
      if (effectiveLimitCents !== null && Math.round(price * 100) !== effectiveLimitCents) {
        // GTC resting order at the user's price (client-side GTD is a flagged follow-up).
        const limitPrice = effectiveLimitCents / 100;
        const limitShares = amount / limitPrice;
        const polygonAddressEarly = poly.polygonAddress;
        const resultLimit = await placeBet(signer, {
          polygonAddress: polygonAddressEarly,
          tradingAddress: poly.tradingAddress,
          tokenID,
          price: limitPrice,
          size: limitShares,
          side: 'BUY',
          negRisk: !!detail.negRisk,
          orderType: 'GTC',
        });
        if (!resultLimit.success) throw new Error(resultLimit.error || 'Order failed');
        const pendingLimit = makePendingOpenOrder({
          id: resultLimit.orderID ?? resultLimit.operationId,
          slug,
          tokenID,
          price: limitPrice,
          size: limitShares,
          outcome: selectedSide === 'no' ? 'No' : 'Yes',
        });
        setPendingOpenOrders((prev) => [pendingLimit, ...prev.filter((o) => o.id !== pendingLimit.id)]);
        setCashBalance((prev) => (prev === null ? prev : Math.max(prev - amount, 0)));
        collapseNumpad();
        setActiveView('picks');
        setPickScope('market');
        await Promise.allSettled([
          loadPicks(),
          fetchClobBalance(polygonAddressEarly).then((b) => setCashBalance(b?.balance ?? null)),
          activeView === 'orderbook' ? loadOrderbook() : Promise.resolve(),
        ]);
        scheduleFollowUpReconcile(polygonAddressEarly);
        return;
      }
      if (!quote.executable || quote.limitPrice === null || quote.shares <= 0) {
        Alert.alert('Not filled', 'Not enough liquidity at the current price. Try a smaller amount or refresh the market.');
        return;
      }
      const polygonAddress = poly.polygonAddress;

      const result = await placeBet(signer, {
        polygonAddress,
        tradingAddress: poly.tradingAddress,
        tokenID,
        price: quote.limitPrice,
        size: quote.shares,
        amount,
        side: 'BUY',
        negRisk: !!detail.negRisk,
        orderType: 'FOK',
      });
      if (!result.success) throw new Error(result.error || 'Order failed');

      setSubmitStatus('syncing');
      const pendingOrder = makePendingOpenOrder({
        id: result.orderID ?? result.operationId,
        slug,
        tokenID,
        price: quote.limitPrice,
        size: quote.shares,
        outcome: selectedSide === 'no' ? 'No' : 'Yes',
      });
      setPendingOpenOrders((prev) => [pendingOrder, ...prev.filter((order) => order.id !== pendingOrder.id)]);
      setCashBalance((prev) => prev === null ? prev : Math.max(prev - amount, 0));
      collapseNumpad();
      setActiveView('picks');
      setPickScope('market');
      await Promise.allSettled([
        loadPicks(),
        fetchClobBalance(polygonAddress).then((balance) => setCashBalance(balance?.balance ?? null)),
        activeView === 'orderbook' ? loadOrderbook() : Promise.resolve(),
      ]);
      scheduleFollowUpReconcile(polygonAddress);
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

      if (!poly.polygonAddress || !poly.signer) throw new Error('Wallet session not ready');
      const result = await placeBet(poly.signer, {
        polygonAddress: poly.polygonAddress,
        tradingAddress: poly.tradingAddress,
        tokenID: position.asset,
        price: limitPrice,
        size,
        side: 'SELL',
        negRisk: !!position.negativeRisk,
        orderType: 'FOK',
      });
      if (!result.success) throw new Error(result.error || 'Cash out failed');

      setSubmitStatus('syncing');
      setCashOutPosition(null);
      setActiveView('picks');
      await Promise.allSettled([
        loadPicks(),
        fetchClobBalance(poly.polygonAddress).then((balance) => setCashBalance(balance?.balance ?? null)),
      ]);
      scheduleFollowUpReconcile(poly.polygonAddress);
    } catch (err: any) {
      Alert.alert('Cash out failed', err.message || 'Unknown error');
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
      setSubmitStatus('idle');
    }
  }

  const chartWidth = screenWidth - 40;
  const chartHeight = 180;
  const amountNum = parseFloat(numpadAmount) || 0;
  const latestSelectedPrice = selectedSide === 'no' ? noPrice : yesPrice;
  const selectedBook = selectedSide === 'no' ? noBook : yesBook;
  const selectedExecutableQuote = buildExecutableBuyQuote(selectedBook, amountNum);
  const selectedNumpadPrice = selectedExecutableQuote.averagePrice ?? latestSelectedPrice ?? 0.5;
  const orderGuardrail = selectedSide
    ? getPredictOrderGuardrail({
        amount: amountNum,
        availableCash: cashBalance,
        selectedPrice: selectedQuotePrice,
        latestPrice: latestSelectedPrice,
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
                  freshness={{ ...picksFreshness, loading: picksLoading, syncing: pendingOpenOrders.length > 0 }}
                  marketPositions={marketPositions}
                  allPositions={allPositions}
                  redeemablePositions={redeemablePositions}
                  closedPositions={closedPositions}
                  openOrders={visibleOpenOrders}
                  activityItems={activityItems}
                  sellQuotes={sellQuotes}
                  cancellingOrderId={cancellingOrderId}
                  polygonAddress={poly.polygonAddress}
                  signer={poly.signer}
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
            </View>

            {/* Inline numpad */}
            <InlineNumpad
              visible={numpadOpen}
              side={selectedSide ?? 'yes'}
              pickLabel={selectedSide === 'no' ? 'NO' : 'YES'}
              price={selectedNumpadPrice}
              amount={numpadAmount}
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

      {/* Composer v2 pilot — shared sheet from the Predict redesign (PRD §6) */}
      <OrderComposerSheet
        visible={COMPOSER_V2 && composerOpen && selectedSide !== null}
        side={selectedSide ?? 'yes'}
        pickLabel={selectedSide === 'no' ? 'NO' : 'YES'}
        question={detail?.question ?? null}
        currentPrice={selectedQuotePrice}
        amount={numpadAmount}
        onAmountChange={setNumpadAmount}
        executableAvgPrice={
          marketClosed
            ? null
            : (() => {
                const q = selectedExecutableQuote;
                return q.executable && q.averagePrice !== null ? q.averagePrice : null;
              })()
        }
        availableCash={cashBalance}
        guardrail={orderGuardrail}
        submitting={submitting}
        submittingLabel={submitLabel}
        disabled={!poly.isReady}
        onClose={() => {
          setComposerParams(null);
          collapseNumpad();
        }}
        onConfirm={(params) => {
          setComposerParams(params);
          void submitOrder();
        }}
      />

      <ConnectionSheet
        visible={connectSheet.visible}
        chain={connectSheet.chain}
        onClose={() => {
          // Cancelling the sheet abandons the pending session setup, so the
          // resume effect must not fire if the user later connects elsewhere.
          setSetupAfterConnect(false);
          connectSheet.close();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.background.screen },

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
