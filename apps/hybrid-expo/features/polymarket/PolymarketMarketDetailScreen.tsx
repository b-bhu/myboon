/**
 * Polymarket market detail — composed onto the shared MarketScreen (#651).
 *
 * Pure refactor of the two legacy layouts (binary + event mode) into the
 * shared frame: the inline pick area (soft zone) is gone; the action bar's
 * Back YES / Back NO buttons open the existing Composer v2 sheet, and event
 * markets pick an outcome from the ladder inside the shared action sheet.
 * Order entry was already sheet-based (OrderComposerSheet) and is unchanged.
 * The picks/stats panel is Polymarket's venue position section (positionsBody).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { cancelOrder, fetchClobBalance, fetchCuratedMarketDetail, fetchLivePrices, fetchMarketPositions, fetchOpenOrders, fetchOrderbook, fetchPortfolio, fetchPriceHistory, placeBet } from '@/features/polymarket/polymarket.api';
import type { ActivityItem, ClosedPortfolioPosition, OpenOrder, PortfolioPosition } from '@/features/polymarket/polymarket.api';
import type { GeopoliticsMarketDetail, Orderbook, PricePoint } from '@/features/polymarket/polymarket.types';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import { usePolymarketWallet } from '@/hooks/usePolymarketWallet';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import { semantic, tokens } from '@/theme';
import { formatUsdCompact } from '@/lib/format';
import { MultiLineChart } from '@/features/polymarket/components/MultiLineChart';
import { OrderbookView } from '@/features/polymarket/components/OrderbookView';
import { InlineNumpad } from '@/features/polymarket/components/InlineNumpad';
import { OrderComposerSheet } from '@/features/polymarket/components/OrderComposerSheet';
import type { ComposerMode } from '@/features/polymarket/components/OrderComposerSheet';
import { ResolutionRulesSheet, EventOutcomeLadder } from '@/features/polymarket/components/EventOutcomeLadder';
import type { EventOddsFormat } from '@/features/polymarket/components/EventOutcomeLadder';
import { DetailPicksPanel } from '@/features/polymarket/components/DetailPicksPanel';
import { CashOutConfirmModal } from '@/features/polymarket/components/CashOutConfirmModal';
import { DetailPositionSheet } from '@/features/polymarket/components/DetailPositionSheet';
import { truncateUsd } from '@/features/polymarket/formatPolymarketMoney';
import { buildExecutableBuyQuote, getBestAsk } from '@/features/polymarket/orderbookQuote';
import { getMinimumOrderGuardrail } from '@/features/polymarket/minimumOrderSize';
import { usePositionSellQuotes } from '@/features/polymarket/positionSellQuotes';
import { makePendingOpenOrder, mergeOpenOrders, prunePendingOpenOrders } from '@/features/polymarket/pendingOpenOrders';
import {
  applyPolymarketUserEvent,
  isPolymarketTradeEvent,
  usePolymarketUserStream,
} from '@/features/polymarket/usePolymarketUserStream';
import { getPolymarketOrderGuardrail, type PolymarketDataFreshness } from '@/features/polymarket/polymarketActivityState';
import { getPolymarketMarketHref } from '@/features/polymarket/polymarket.navigation';
import { MarketScreen } from '@/features/markets/MarketScreen';
import type {
  MarketDetailActionBarVM,
  MarketDetailViewModel,
  NewsStoryCard,
  ValueTone,
} from '@/features/markets/detail-view-model';

interface PolymarketMarketDetailScreenProps {
  slug: string;
}

type Interval = '5m' | '1h' | '1d';
type ActiveView = 'picks' | 'stats' | 'chart' | 'orderbook';
type SubmitStatus = 'idle' | 'wallet' | 'placing' | 'syncing';

// Composer v2 is the normal Yes/No flow as of the Polymarket redesign (PRD §6).
// ?composer=legacy on web restores the old InlineNumpad flow for QA comparison.
const COMPOSER_V2_DEFAULT = true;

const POLYMARKET_MAKET_RANGES: readonly { label: string; interval: Interval }[] = [
  { label: '5M', interval: '5m' },
  { label: '1H', interval: '1h' },
  { label: '1D', interval: '1d' },
];

function formatDeadline(endDate: string | null, active: boolean | null): string {
  if (!endDate) return active === false ? 'Closed' : 'Open';
  const time = Date.parse(endDate);
  if (Number.isNaN(time)) return active === false ? 'Closed' : 'Open';
  const date = new Date(time);
  const month = date.toLocaleString('en-US', { month: 'short' });
  const day = date.getDate();
  return `${active === false ? 'Ended' : 'Ends'} ${month} ${day}`;
}

function formatResolveShort(endDate: string | null): string {
  if (!endDate) return '--';
  const time = Date.parse(endDate);
  if (!Number.isFinite(time)) return '--';
  return new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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

function ChartViewSwitch({
  activeView,
  onSelect,
}: {
  activeView: ActiveView;
  onSelect: (view: 'chart' | 'orderbook') => void;
}) {
  return (
    <View style={styles.chartViewSwitch} accessibilityRole="tablist">
      {(['chart', 'orderbook'] as const).map((view) => {
        const selected = activeView === view;
        return (
          <Pressable
            key={view}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={[styles.chartViewButton, selected && styles.chartViewButtonActive]}
            onPress={() => onSelect(view)}
          >
            <MaterialIcons
              name={view === 'chart' ? 'show-chart' : 'layers'}
              size={14}
              color={selected ? tokens.colors.backgroundDark : semantic.text.faint}
            />
            <Text style={[styles.chartViewText, selected && styles.chartViewTextActive]}>
              {view === 'chart' ? 'Chart' : 'Book'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function formatCents(price: number | null): string {
  return price === null ? '--' : `${Math.round(price * 100)}¢`;
}

export function PolymarketMarketDetailScreen({ slug }: PolymarketMarketDetailScreenProps) {
  // Composer v2 can be force-disabled for QA via ?composer=legacy on web.
  const urlParams = useLocalSearchParams<{ composer?: string }>();
  const COMPOSER_V2 = COMPOSER_V2_DEFAULT && urlParams.composer !== 'legacy';
  const router = useRouter();
  const poly = usePolymarketWallet();
  const connectSheet = useConnectionSheet('evm');
  const { width: screenWidth } = useWindowDimensions();

  // Market data
  const [detail, setDetail] = useState<GeopoliticsMarketDetail | null>(null);
  const [loading, setLoading] = useState(true);
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
  const [picksFreshness, setPicksFreshness] = useState<PolymarketDataFreshness>({
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
  // Composer v2 pilot state (Polymarket redesign PRD §6). Flag-gated; see COMPOSER_V2.
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerParams, setComposerParams] = useState<{ mode: ComposerMode; limitPriceCents: number } | null>(null);
  // Multi-outcome event state (PRD §5). Selected rung in the outcome ladder;
  // odds format for the ladder; which event outcome's book the Book view shows.
  const [eventOutcomeId, setEventOutcomeId] = useState<string | null>(null);
  const [eventOddsFormat, setEventOddsFormat] = useState<EventOddsFormat>('probability');
  const [eventBookIdx, setEventBookIdx] = useState(0);

  const reconcileTimeouts = useRef<ReturnType<typeof setTimeout>[]>([]);
  const submitInFlightRef = useRef(false);
  const buyBookRefreshInFlight = useRef(false);
  const connectionCompletedRef = useRef(false);
  // Polymarket settles on Polygon, so its cache scope is the EVM signer — never the
  // Solana wallet. Keying on Solana meant an email/EVM user read as disconnected
  // and a Solana disconnect wiped Polymarket state that did not depend on it.
  const walletScopedKey = poly.signer ? `${poly.signer.descriptor.address.toLowerCase()}:${poly.polygonAddress ?? ''}:${poly.tradingAddress ?? ''}` : 'disconnected';
  const walletScopedKeyRef = useRef(walletScopedKey);

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
      setOpenOrders((orders) => applyPolymarketUserEvent(orders, event));
      if (isPolymarketTradeEvent(event)) void loadPicks();
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

  async function runPolymarketSetup() {
    if (setupSubmitting) return;
    setSetupSubmitting(true);
    try {
      await poly.enable();
      await Promise.allSettled([loadCashBalance(), loadPicks()]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to sign in to Polymarket';
      Alert.alert('Sign in failed', msg);
    } finally {
      setSetupSubmitting(false);
    }
  }

  function handlePolymarketSetupPress() {
    if (setupSubmitting) return;
    if (!poly.signer) {
      // Polymarket settles on Polygon and signs EIP-712 orders, so the
      // requirement is EVM. The effect below resumes session setup once the
      // signer resolves.
      setSetupAfterConnect(true);
      connectSheet.open('evm');
      return;
    }
    void runPolymarketSetup();
  }

  useEffect(() => {
    if (!setupAfterConnect || !poly.signer || poly.isReady) return;
    setSetupAfterConnect(false);
    void runPolymarketSetup();
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
      handlePolymarketSetupPress();
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
    const guardrail = getPolymarketOrderGuardrail({
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
    ? getPolymarketOrderGuardrail({
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

  // Headline price: the outcome the user would buy. Binary = Yes price in
  // cents; event mode = the selected ladder rung (or the first outcome).
  const headlinePrice = isEventMode
    ? (selectedEventPrice ?? event?.outcomes[0]?.price ?? null)
    : yesPrice;

  const chartBody = (
    <View style={styles.chartRegion}>
      <ChartViewSwitch activeView={activeView} onSelect={setActiveView} />
      <View style={styles.chartSurface}>
        {activeView === 'orderbook' ? (
          isEventMode && event ? (
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
            <View style={styles.bookWrap}>
              <View style={styles.bookTabs}>
                {(['yes', 'no'] as const).map((side) => (
                  <Pressable
                    key={side}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: binaryBookSide === side }}
                    style={[styles.bookTab, binaryBookSide === side && styles.bookTabActive]}
                    onPress={() => setBinaryBookSide(side)}
                  >
                    <Text style={[styles.bookTabText, binaryBookSide === side && styles.bookTabTextActive]}>{side === 'yes' ? 'Yes' : 'No'}</Text>
                  </Pressable>
                ))}
              </View>
              <OrderbookView book={orderbook} loading={orderbookLoading} />
            </View>
          )
        ) : historyLoading ? (
          <View style={styles.chartSkeleton}>
            <ActivityIndicator size="small" color={semantic.text.faint} />
          </View>
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
  );

  const positionRows: MarketDetailViewModel['positionRows'] = [];

  const positionsBody = (
    <View style={styles.picksBody}>
      {activePosition ? (
        <Pressable
          style={styles.yourPickPill}
          accessibilityRole="button"
          onPress={() => setPositionOpen(true)}
        >
          <MaterialIcons name="account-circle" size={16} color={tokens.colors.viridian} />
          <Text style={styles.yourPickLabel}>Your pick</Text>
          <Text style={[styles.yourPickPnl, activePosition.cashPnl < 0 && styles.yourPickPnlNegative]}>
            {activePosition.cashPnl >= 0 ? '+' : '-'}${Math.abs(activePosition.cashPnl).toFixed(2)}
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.picksTabsRow}>
        <DisplayTab label="Your Picks" active={activeView === 'picks'} onPress={() => setActiveView('picks')} />
        <DisplayTab label="Stats" active={activeView === 'stats'} onPress={() => setActiveView('stats')} />
      </View>

      {activeView === 'picks' ? (
        <DetailPicksPanel
          scope={pickScope}
          marketSlug={slug}
          marketTokenIds={detail?.clobTokenIds ?? []}
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
              router.push(getPolymarketMarketHref(position.slug));
              return;
            }
            tapOdd(position.outcome === 'No' ? 'no' : 'yes');
          }}
          onCancelOrder={(orderId) => void handleCancelOrder(orderId)}
          onRedeemed={() => void loadPicks()}
          onRetry={() => void loadPicks()}
        />
      ) : (
        <View style={styles.statsView}>
          {detail ? (
            <View style={styles.statsGrid}>
              <View style={styles.statsCard}><Text style={styles.statsLabel}>Volume</Text><Text style={styles.statsValue}>{formatUsdCompact(detail.volume24h)}</Text></View>
              <View style={styles.statsCard}><Text style={styles.statsLabel}>Liquidity</Text><Text style={styles.statsValue}>{formatUsdCompact(detail.liquidity)}</Text></View>
              <View style={styles.statsCard}><Text style={styles.statsLabel}>No chance</Text><Text style={styles.statsValue}>{noPrice !== null ? `${Math.round(noPrice * 100)}%` : '--'}</Text></View>
              <View style={styles.statsCard}><Text style={styles.statsLabel}>Resolves</Text><Text style={styles.statsValue}>{formatDeadline(detail.endDate, detail.active)}</Text></View>
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="How this market resolves"
            style={styles.rulesLink}
            onPress={() => setRulesOpen(true)}>
            <Text style={styles.rulesLinkText}>How this resolves</Text>
          </Pressable>
        </View>
      )}
    </View>
  );

  // Price row change: prediction markets have no 24h change in the model.
  const priceChange: MarketDetailViewModel['priceRow']['change'] = null;

  const newsStories: readonly NewsStoryCard[] = [];

  // Headline row for the event ladder sheet (the old soft zone's odds area).
  const eventLadderSheet = isEventMode && event ? (
    <View style={styles.ladderSheet}>
      <Text style={styles.ladderSheetTitle}>Pick an outcome</Text>
      {marketClosed && (
        <Text style={styles.marketClosedText}>This market is closed and no longer accepting new picks.</Text>
      )}
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
  ) : null;

  const legacyNumpadSheet = !COMPOSER_V2 ? (
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
      onSetupPress={() => { void handlePolymarketSetupPress(); }}
      setupSubmitting={setupSubmitting || setupAfterConnect || poly.isLoading}
    />
  ) : null;

  const actionBar: MarketDetailActionBarVM = !poly.signer
    ? {
        connected: false,
        connectReason: 'Connect an EVM wallet to trade Polymarket',
        connectLabel: 'Sign in to Polymarket',
        onConnect: () => handlePolymarketSetupPress(),
        buttons: [
          { label: 'Back YES', variant: 'primary' as const },
          { label: 'Back NO', variant: 'secondary' as const },
        ],
      }
    : isEventMode
      ? {
          connected: true,
          buttons: [
            { label: 'Pick outcome', variant: 'primary' as const, disabled: marketClosed || submitting },
            { label: 'How this resolves', variant: 'secondary' as const, opensSheet: false, onPress: () => setRulesOpen(true) },
          ],
        }
      : {
          connected: true,
          buttons: [
            { label: 'Back YES', variant: 'primary' as const, disabled: marketClosed || submitting, onPress: () => tapOdd('yes') },
            { label: 'Back NO', variant: 'secondary' as const, disabled: marketClosed || submitting, onPress: () => tapOdd('no') },
          ],
        };

  const notice = !loading && errorMessage ? (
    <View style={styles.noticeCard}>
      <Text style={styles.noticeTitle}>Market unavailable</Text>
      <Text style={styles.noticeText}>{errorMessage}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Try again"
        accessibilityHint="Reload market details"
        onPress={() => void loadMarket()}
        style={styles.noticeRetryBtn}>
        <Text style={styles.noticeRetryText}>Try Again</Text>
      </Pressable>
    </View>
  ) : null;

  const vm: MarketDetailViewModel = {
    topBar: {
      marketName: detail?.question ?? 'Loading market...',
      venueBadge: 'Polymarket',
      onBack: () => router.back(),
      onInfoPress: () => setRulesOpen(true),
    },
    priceRow: {
      price: detail ? formatCents(headlinePrice) : '--',
      change: priceChange,
      live: false,
      secondaryStat: detail
        ? { label: detail.active === false ? 'Ended' : 'Resolves', value: formatResolveShort(detail.endDate) }
        : null,
    },
    notice,
    range: {
      ranges: POLYMARKET_MAKET_RANGES.map((r) => r.label),
      activeRange: POLYMARKET_MAKET_RANGES.find((r) => r.interval === interval)?.label ?? '1H',
      onSelectRange: (label) => {
        const found = POLYMARKET_MAKET_RANGES.find((r) => r.label === label);
        if (found) setInterval(found.interval);
      },
      newsVisible: false,
    },
    chartBody,
    newsStories,
    positionsTitle: 'Your Picks',
    positionRows,
    positionsBody,
    actionBar,
    actionSheet: eventLadderSheet ?? legacyNumpadSheet ?? undefined,
  };

  return (
    <View style={styles.screen}>
      <MarketScreen vm={vm} />

      {/* Your pick detail (from the Your pick pill) */}
      {detail ? (
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

      {/* Composer v2 — shared sheet from the Polymarket redesign (PRD §6).
          Event mode: the selected ladder rung drives side/label/price. */}
      {detail ? (
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
          limitOrderNote="Cancels automatically at the market deadline."
          onClose={() => {
            setComposerParams(null);
            collapseNumpad();
          }}
          onConfirm={confirmComposer}
        />
      ) : null}

      <ResolutionRulesSheet
        visible={rulesOpen}
        description={(event?.description ?? detail?.description) ?? null}
        onClose={() => setRulesOpen(false)}
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

  // Inline notice (market fetch failed)
  noticeCard: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 6,
    alignItems: 'center',
  },
  noticeTitle: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  noticeText: { color: semantic.text.dim, fontSize: tokens.fontSize.md },
  noticeRetryBtn: {
    marginTop: 4,
    backgroundColor: semantic.text.accent,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: tokens.radius.xs,
  },
  noticeRetryText: {
    color: semantic.background.screen,
    fontSize: tokens.fontSize.sm,
    fontFamily: 'monospace',
    textTransform: 'uppercase',
    fontWeight: '700',
  },

  // Chart region (Chart | Book switch + surface)
  chartRegion: {
    gap: 6,
  },
  chartViewSwitch: { alignSelf: 'flex-end', flexDirection: 'row', padding: 4, borderRadius: 13, backgroundColor: tokens.colors.lift },
  chartViewButton: { minWidth: 65, minHeight: 36, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 10 },
  chartViewButtonActive: { backgroundColor: tokens.colors.accent },
  chartViewText: { fontFamily: 'monospace', fontSize: 9, fontWeight: '800', color: semantic.text.faint },
  chartViewTextActive: { color: tokens.colors.backgroundDark },
  chartSurface: {
    minHeight: 216,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chartSkeleton: {
    paddingVertical: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bookWrap: { width: '100%', minHeight: 202, paddingHorizontal: 5 },
  bookTabs: { flexDirection: 'row', gap: 5, paddingBottom: 8 },
  bookTab: { flex: 1, minHeight: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.surface },
  bookTabActive: { backgroundColor: tokens.colors.accent },
  bookTabText: { fontFamily: 'monospace', fontSize: 9, fontWeight: '800', color: semantic.text.faint },
  bookTabTextActive: { color: tokens.colors.backgroundDark },

  // Event Book tabs (PRD §5)
  obWrap: {
    width: '100%',
    minHeight: 202,
    paddingHorizontal: 5,
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

  // Picks / stats section
  picksBody: {
    paddingBottom: 14,
    gap: 9,
  },
  yourPickPill: {
    minHeight: 34,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    borderRadius: 11,
    backgroundColor: tokens.colors.lift,
  },
  yourPickLabel: { fontFamily: 'monospace', fontSize: 8, fontWeight: '800', color: semantic.text.dim },
  yourPickPnl: { fontFamily: 'monospace', fontSize: 9, fontWeight: '900', color: tokens.colors.viridian },
  yourPickPnlNegative: { color: tokens.colors.vermillion },
  picksTabsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
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
  statsView: {
    gap: 8,
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
  rulesLink: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
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

  // Event ladder sheet (the old soft zone content)
  ladderSheet: {
    gap: 8,
    paddingBottom: 4,
  },
  ladderSheetTitle: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  marketClosedText: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: tokens.colors.vermillion,
  },
  ladderToggleRow: {
    flexDirection: 'row',
    gap: 4,
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
});
