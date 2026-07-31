import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
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
import type { PricePoint, SportMarketDetail, SportOutcomeDetail, Orderbook } from '@/features/predict/predict.types';
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
import { DetailPicksPanel } from '@/features/predict/components/DetailPicksPanel';
import { CashOutConfirmModal } from '@/features/predict/components/CashOutConfirmModal';
import { formatPredictTitle } from '@/features/predict/formatPredictTitle';
import { truncateUsd } from '@/features/predict/formatPredictMoney';
import { buildExecutableBuyQuote, getBestAsk } from '@/features/predict/orderbookQuote';
import { usePositionSellQuotes } from '@/features/predict/positionSellQuotes';
import { makePendingOpenOrder, mergeOpenOrders, prunePendingOpenOrders } from '@/features/predict/pendingOpenOrders';
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

function outcomeTone(outcome: SportOutcomeDetail, index: number): 'lead' | 'draw' | 'trail' {
  if (outcome.label.toLowerCase().includes('draw')) return 'draw';
  return index === 0 ? 'lead' : 'trail';
}

function sortSportOutcomes(outcomes: SportOutcomeDetail[]): SportOutcomeDetail[] {
  const list = [...outcomes];
  const byPriceDesc = (a: SportOutcomeDetail, b: SportOutcomeDetail) => (b.price ?? -1) - (a.price ?? -1);
  const draw = list.find((outcome) => outcome.label.toLowerCase().includes('draw'));

  if (list.length === 3 && draw) {
    const teams = list.filter((outcome) => outcome !== draw).sort(byPriceDesc);
    if (teams.length === 2) return [teams[0], draw, teams[1]];
  }

  return list.sort((a, b) => {
    const aIsDraw = a.label.toLowerCase().includes('draw');
    const bIsDraw = b.label.toLowerCase().includes('draw');
    if (aIsDraw && !bIsDraw) return 1;
    if (!aIsDraw && bIsDraw) return -1;
    return byPriceDesc(a, b);
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
  const { format, setFormat, formatOdds } = useOddsFormat();
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
  const [activeView, setActiveView] = useState<ActiveView>('picks');
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null);
  const [orderbookLoading, setOrderbookLoading] = useState(false);
  const [buyBooks, setBuyBooks] = useState<Record<string, Orderbook | null>>({});
  const [obOutcomeIdx, setObOutcomeIdx] = useState(0);

  // Numpad state
  const [numpadOpen, setNumpadOpen] = useState(false);
  const [selectedOutcomeIdx, setSelectedOutcomeIdx] = useState<number | null>(null);
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

  // Live badge pulse
  const livePulse = useRef(new Animated.Value(1)).current;

  const baseSortedOutcomes = useMemo(() => (detail ? sortSportOutcomes(detail.outcomes) : []), [detail]);
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
        loadDetail(true),
        loadPicks(),
        loadCashBalance(),
        activeView === 'orderbook' ? loadOrderbook(obOutcomeIdx) : Promise.resolve(),
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
    setNumpadAmount('50');
    setNumpadOpen(true);
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
  }

  async function submitOrder() {
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

      if (!poly.polygonAddress) throw new Error('Wallet session not ready');
      const signer = poly.signer;
      if (!signer) throw new Error('Wallet session not ready');

      const freshBook = await fetchOrderbook(tokenID).catch(() => null);
      const quote = buildExecutableBuyQuote(freshBook, amount);
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
        outcome: sportOutcomeLabel(outcome),
      });
      setPendingOpenOrders((prev) => [pendingOrder, ...prev.filter((order) => order.id !== pendingOrder.id)]);
      setCashBalance((prev) => prev === null ? prev : Math.max(prev - amount, 0));
      collapseNumpad();
      setActiveView('picks');
      setPickScope('market');
      await Promise.allSettled([
        loadPicks(),
        fetchClobBalance(polygonAddress).then((balance) => setCashBalance(balance?.balance ?? null)),
        activeView === 'orderbook' ? loadOrderbook(obOutcomeIdx) : Promise.resolve(),
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

  const numpadPrice = (() => {
    if (selectedOutcomeIdx === null) return 0.5;
    const outcome = sortedOutcomes[selectedOutcomeIdx];
    const tokenId = outcome?.clobTokenIds[0];
    const amount = parseFloat(numpadAmount) || 0;
    const quote = buildExecutableBuyQuote(tokenId ? buyBooks[tokenId] ?? null : null, amount);
    return quote.averagePrice ?? outcome?.price ?? 0.5;
  })();
  const selectedOutcome = selectedOutcomeIdx !== null ? sortedOutcomes[selectedOutcomeIdx] : null;
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

  const chartWidth = screenWidth - 40;
  const chartHeight = 180;

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

            {/* Chart or Orderbook */}
            <View style={styles.viewContainer}>
              {activeView === 'picks' ? (
                <DetailPicksPanel
                  scope={pickScope}
                  marketSlug={slug}
                  marketTokenIds={marketTokenIds}
                  marketConditionIds={marketConditionIds}
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

            {/* Inline numpad */}
            <InlineNumpad
              visible={numpadOpen}
              side="yes"
              pickLabel={selectedOutcomeLabel}
              price={numpadPrice}
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
