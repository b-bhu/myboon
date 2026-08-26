import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppTopBar, AppTopBarIconButton, AppTopBarTitle } from '@/components/AppTopBar';
import { DepositModal } from '@/components/predict/DepositModal';
import { WithdrawModal } from '@/components/predict/WithdrawModal';
import { fetchPortfolio, fetchClobBalance, fetchOpenOrders, cancelOrder, placeBet } from '@/features/predict/predict.api';
import type { OpenOrder, PortfolioData, PortfolioPosition } from '@/features/predict/predict.api';
import { getPredictMarketHref } from '@/features/predict/predict.navigation';
import { truncateUsd } from '@/features/predict/formatPredictMoney';
import { getPositionSellQuote, usePositionSellQuotes } from '@/features/predict/positionSellQuotes';
import { useWallet } from '@/hooks/useWallet';
import { usePolymarketWallet } from '@/hooks/usePolymarketWallet';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import { useOddsFormat } from '@/hooks/useOddsFormat';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import { EmptyPortfolio } from '@/features/predict/profile/EmptyPortfolio';
import { YourPicksSection } from '@/features/predict/profile/YourPicksSection';
import { ProfilePortfolioTabs } from '@/features/predict/profile/ProfilePortfolioTabs';
import { CashOutConfirmModal } from '@/features/predict/components/CashOutConfirmModal';
import type { PredictDataFreshness } from '@/features/predict/predictActivityState';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import {
  applyPredictUserEvent,
  isPredictTradeEvent,
  usePolymarketUserStream,
} from '@/features/predict/usePolymarketUserStream';
import { semantic, tokens } from '@/theme';

function truncate(addr: string, start = 6, end = 4): string {
  return `${addr.slice(0, start)}···${addr.slice(-end)}`;
}

const PREDICT_PROFILE_FALLBACK_USD_TO_INR = 95.67;
const USD_INR_RATE_URL = 'https://open.er-api.com/v6/latest/USD';
const PREDICT_PROFILE_CURRENCY_KEY = 'predict-profile-currency-format';
type PredictProfileCurrency = 'USD' | 'INR';
type PredictSettingsView = 'menu' | 'currency' | 'wallet' | 'security' | 'odds';
const EMPTY_PORTFOLIO_POSITIONS: PortfolioPosition[] = [];

function formatProfileCurrency(
  value: number | null | undefined,
  currency: PredictProfileCurrency,
  usdToInr = PREDICT_PROFILE_FALLBACK_USD_TO_INR,
): string {
  if (currency === 'USD') return truncateUsd(value);
  if (value == null || !Number.isFinite(value)) return '--';
  const inr = Math.abs(value * usdToInr);
  const prefix = value < 0 ? '-' : '';
  if (inr >= 100000) return `${prefix}₹${(inr / 100000).toFixed(1)}L`;
  if (inr >= 1000) return `${prefix}₹${(inr / 1000).toFixed(1)}K`;
  return `${prefix}₹${inr.toFixed(0)}`;
}

async function fetchUsdToInrRate(): Promise<number | null> {
  try {
    const response = await fetch(USD_INR_RATE_URL);
    if (!response.ok) return null;
    const data = await response.json();
    const rate = Number(data?.rates?.INR);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

function getOrderCost(order: OpenOrder): number {
  const size = Number.parseFloat(order.original_size) || 0;
  const price = Number.parseFloat(order.price) || 0;
  return size * price;
}

export default function PredictProfileScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // Solana is read only as a withdrawal destination — never as this screen's
  // connection state. Predict settles on Polygon, so `poly` is the source of truth.
  const { address: solanaAddress } = useWallet();
  const privyAuthMethod = usePrivyWallet().authMethod;
  const privyDisconnect = usePrivyWallet().disconnect;
  const poly = usePolymarketWallet();
  const { format: oddsFormat, setFormat: setOddsFormat } = useOddsFormat();
  // Predict settles on Polygon, so its requirement is EVM.
  const connectSheet = useConnectionSheet('evm');
  const [busy, setBusy] = useState(false);
  // Set when the connection sheet is opened to reach Polymarket setup, so the
  // effect below can finish the job once a signer resolves. Without it a user
  // who signs in here lands back on a screen with a wallet and no next step —
  // the detail screens already do this; profile was the one that did not.
  const [setupAfterConnect, setSetupAfterConnect] = useState(false);
  // Set by the sheet's `onConnected` so the close handler can tell a successful
  // connection from a cancellation — the sheet closes itself in both cases.
  const connectedViaSheetRef = useRef(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  // Portfolio data
  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null);
  const [cashBalance, setCashBalance] = useState<number | null>(null);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [predictUnavailable, setPredictUnavailable] = useState(false);
  const [activityFreshness, setActivityFreshness] = useState<PredictDataFreshness>({
    lastUpdatedAt: null,
    loading: false,
    stale: false,
    error: null,
  });
  const [usdToInrRate, setUsdToInrRate] = useState(PREDICT_PROFILE_FALLBACK_USD_TO_INR);
  const [currencyFormat, setCurrencyFormat] = useState<PredictProfileCurrency>('INR');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<PredictSettingsView>('menu');
  const [cashOutPosition, setCashOutPosition] = useState<PortfolioPosition | null>(null);
  const [cashOutSubmitting, setCashOutSubmitting] = useState(false);

  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const portfolioRefreshInFlight = useRef(false);
  const ordersRefreshInFlight = useRef(false);

  const isEnabled = poly.isReady && poly.polygonAddress;
  // Two different questions, and the screen must not confuse them:
  //   walletAddress      — the EVM wallet exists and can sign. Local, from Privy,
  //                        available at app load. This is "connected".
  //   poly.polygonAddress — the mobile SecureClient is authenticated and its
  //                        SDK-resolved account is ready.
  // Gating connection UI on polygonAddress showed "Connect wallet" to a user who
  // already had a working wallet, with no control that advanced them.
  const walletAddress = poly.signer?.descriptor.address ?? null;
  const walletScopedKey = poly.signer ? `${poly.signer.descriptor.address.toLowerCase()}:${poly.polygonAddress ?? ''}:${poly.tradingAddress ?? ''}` : 'disconnected';
  const walletScopedKeyRef = useRef(walletScopedKey);
  const formatProfileMoney = useCallback(
    (value: number | null | undefined) => formatProfileCurrency(value, currencyFormat, usdToInrRate),
    [currencyFormat, usdToInrRate],
  );

  useEffect(() => {
    AsyncStorage.getItem(PREDICT_PROFILE_CURRENCY_KEY)
      .then((stored) => {
        if (stored === 'USD' || stored === 'INR') setCurrencyFormat(stored);
      })
      .catch(() => {});
  }, []);

  const selectCurrencyFormat = useCallback((next: PredictProfileCurrency) => {
    setCurrencyFormat(next);
    setSettingsOpen(false);
    setSettingsView('menu');
    AsyncStorage.setItem(PREDICT_PROFILE_CURRENCY_KEY, next).catch(() => {});
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsView('menu');
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refreshRate() {
      const rate = await fetchUsdToInrRate();
      if (!cancelled && rate !== null) setUsdToInrRate(rate);
    }
    void refreshRate();
    const interval = setInterval(() => void refreshRate(), 6 * 60 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const resetWalletScopedState = useCallback(() => {
    setPortfolio(null);
    setCashBalance(null);
    setOpenOrders([]);
    setPredictUnavailable(false);
    setActivityFreshness({ lastUpdatedAt: null, loading: false, stale: false, error: null });
    setCashOutPosition(null);
    portfolioRefreshInFlight.current = false;
    ordersRefreshInFlight.current = false;
  }, []);

  const handleDisconnectPredict = useCallback(() => {
    Alert.alert(
      'Disconnect Predict?',
      'This revokes the Polymarket API key on the server and removes its encrypted device copy. Your wallet and funds are unchanged.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            poly.disable()
              .then(() => {
                closeSettings();
                resetWalletScopedState();
              })
              .catch((error: unknown) => {
                Alert.alert(
                  'Predict was not disconnected',
                  error instanceof Error
                    ? error.message
                    : 'The API key could not be revoked. Your local Predict credentials were preserved.',
                );
              })
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  }, [closeSettings, poly, resetWalletScopedState]);

  useEffect(() => {
    if (walletScopedKeyRef.current === walletScopedKey) return;
    walletScopedKeyRef.current = walletScopedKey;
    resetWalletScopedState();
  }, [walletScopedKey, resetWalletScopedState]);

  const handleCancel = useCallback(async (orderId: string) => {
    if (!poly.client) return;
    setCancellingId(orderId);
    try {
      const result = await cancelOrder(poly.client, orderId);
      if (result.ok) {
        setOpenOrders((prev) => prev.map((order) =>
          order.id === orderId ? { ...order, status: 'cancel_requested' } : order
        ));
        void fetchOpenOrders(poly.client).then(setOpenOrders).catch(() => {});
      } else {
        Alert.alert('Cancel failed', result.error ?? 'Unknown error');
      }
    } catch {
      Alert.alert('Cancel failed', 'Network error');
    } finally {
      setCancellingId(null);
    }
  }, [poly.client]);

  const loadPortfolio = useCallback(async () => {
    if (!poly.polygonAddress || !poly.client) return;
    const requestKey = walletScopedKeyRef.current;
    setActivityFreshness((prev) => ({ ...prev, loading: true, error: null }));
    const [portfolioResult, balanceResult, ordersResult] = await Promise.allSettled([
      fetchPortfolio(poly.client),
      fetchClobBalance(poly.client),
      fetchOpenOrders(poly.client),
    ]);
    const portfolioData = portfolioResult.status === 'fulfilled' ? portfolioResult.value : null;
    const balanceData = balanceResult.status === 'fulfilled' ? balanceResult.value : null;
    const ordersData = ordersResult.status === 'fulfilled' ? ordersResult.value : null;
    if (walletScopedKeyRef.current !== requestKey) return;
    if (portfolioData) setPortfolio(portfolioData);
    if (ordersData) setOpenOrders(ordersData);
    if (balanceData) {
      setCashBalance(balanceData.balance);
      setPredictUnavailable(false);
    } else {
      setCashBalance(null);
      setPredictUnavailable(true);
    }
    const failed = portfolioResult.status === 'rejected' || balanceResult.status === 'rejected' || ordersResult.status === 'rejected';
    setActivityFreshness({
      lastUpdatedAt: Date.now(),
      loading: false,
      stale: failed,
      error: failed ? 'Could not refresh' : null,
    });
  }, [poly.client, poly.polygonAddress]);

  const refreshPortfolioQuietly = useCallback(async () => {
    if (!poly.polygonAddress || !poly.client) return;
    const requestKey = walletScopedKeyRef.current;
    if (portfolioRefreshInFlight.current) return;
    portfolioRefreshInFlight.current = true;
    try {
      const [portfolioResult, balanceResult] = await Promise.allSettled([
        fetchPortfolio(poly.client),
        fetchClobBalance(poly.client),
      ]);
      const portfolioData = portfolioResult.status === 'fulfilled' ? portfolioResult.value : null;
      const balanceData = balanceResult.status === 'fulfilled' ? balanceResult.value : null;
      if (walletScopedKeyRef.current !== requestKey) return;

      if (portfolioData) setPortfolio(portfolioData);
      if (balanceData) {
        setCashBalance(balanceData.balance);
        setPredictUnavailable(false);
      }

      const failed = portfolioResult.status === 'rejected' || balanceResult.status === 'rejected';
      setActivityFreshness((prev) => ({
        lastUpdatedAt: failed ? prev.lastUpdatedAt : Date.now(),
        loading: false,
        stale: failed,
        error: failed ? 'Could not refresh' : null,
      }));
    } finally {
      portfolioRefreshInFlight.current = false;
    }
  }, [poly.client, poly.polygonAddress]);

  const refreshOpenOrdersQuietly = useCallback(async () => {
    if (!poly.client) return;
    const requestKey = walletScopedKeyRef.current;
    if (ordersRefreshInFlight.current) return;
    ordersRefreshInFlight.current = true;
    try {
      const orders = await fetchOpenOrders(poly.client);
      if (walletScopedKeyRef.current !== requestKey) return;
      setOpenOrders(orders);
    } catch {
      setActivityFreshness((prev) => ({ ...prev, stale: true, error: 'Could not refresh' }));
    } finally {
      ordersRefreshInFlight.current = false;
    }
  }, [poly.client]);

  const realtimeStatus = usePolymarketUserStream(
    isEnabled ? poly.client : null,
    (event) => {
      setOpenOrders((orders) => applyPredictUserEvent(orders, event));
      if (isPredictTradeEvent(event)) void refreshPortfolioQuietly();
    },
    loadPortfolio,
  );

  const handleConfirmCashOut = useCallback(async (size: number, limitPrice: number) => {
    const position = cashOutPosition;
    if (!position || cashOutSubmitting) return;

    if (!position.asset) {
      Alert.alert('Cash out failed', 'Missing token ID for this position.');
      return;
    }

    if (!poly.canSignLocally) {
      try {
        await poly.enable();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to enable Polymarket account';
        Alert.alert('Wallet', msg);
        return;
      }
    }

    if (!poly.client) {
      Alert.alert('Cash out failed', 'Predict account not ready.');
      return;
    }

    setCashOutSubmitting(true);
    try {
      const result = await placeBet(poly.client, {
        tokenID: position.asset,
        price: limitPrice,
        size,
        side: 'SELL',
        orderType: 'FOK',
      });
      if (!result.success) throw new Error(result.error || 'Cash out failed');

      setCashOutPosition(null);
      await loadPortfolio();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Cash out failed', msg);
    } finally {
      setCashOutSubmitting(false);
    }
  }, [cashOutPosition, cashOutSubmitting, loadPortfolio, poly]);

  // Fetch portfolio when enabled
  useEffect(() => {
    const requestKey = walletScopedKeyRef.current;
    if (!isEnabled || !poly.polygonAddress) {
      resetWalletScopedState();
      setPortfolioLoading(false);
      return;
    }
    setPortfolioLoading(true);
    loadPortfolio().finally(() => {
      if (walletScopedKeyRef.current === requestKey) setPortfolioLoading(false);
    });
  }, [isEnabled, poly.polygonAddress, loadPortfolio, resetWalletScopedState]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadPortfolio();
    setRefreshing(false);
  }, [loadPortfolio]);

  // Refresh when screen regains focus (e.g. returning from position detail after sell)
  const hasMounted = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (hasMounted.current && isEnabled && poly.polygonAddress) {
        void loadPortfolio();
      }
      hasMounted.current = true;
    }, [isEnabled, loadPortfolio, poly.polygonAddress]),
  );

  useFocusedAppStateInterval(() => void refreshPortfolioQuietly(), 15_000, {
    enabled: Boolean(isEnabled && poly.polygonAddress),
    resetKey: `${poly.polygonAddress ?? ''}:${poly.tradingAddress ?? ''}`,
  });

  useFocusedAppStateInterval(() => void refreshOpenOrdersQuietly(), 7_000, {
    enabled: Boolean(isEnabled && poly.polygonAddress),
    resetKey: poly.polygonAddress,
  });

  const connectPredictAccount = useCallback(async () => {
    setBusy(true);
    try {
      await poly.enable();
      setPredictUnavailable(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to connect Polymarket account';
      Alert.alert('Error', msg);
    } finally {
      setBusy(false);
    }
  }, [poly]);

  const handleConnectPredictAccount = useCallback(() => {
    // Predict signs on Polygon, so the requirement is EVM. When the resolver
    // has no signer yet, the shared connection sheet is the entry point and the
    // effect below resumes setup once the signer lands — signing in and setting
    // up Polymarket is one user action, not two.
    if (!poly.signer) {
      setSetupAfterConnect(true);
      connectSheet.open('evm');
      return;
    }

    void connectPredictAccount();
  }, [connectPredictAccount, connectSheet, poly.signer]);

  // Resume setup after the connection sheet resolves a signer. Mirrors
  // PredictMarketDetailScreen / PredictSportDetailScreen.
  //
  // `connectPredictAccount` is deliberately not a dependency: it closes over
  // `poly`, which is a new object every render, so including it would re-run
  // this effect continuously. The ref guard is what makes the resume fire once
  // per connection rather than on every render while setup is in flight.
  const setupResumeRef = useRef(false);
  useEffect(() => {
    if (!setupAfterConnect || !poly.signer || poly.isReady) return;
    if (setupResumeRef.current) return;
    setupResumeRef.current = true;
    setSetupAfterConnect(false);
    void connectPredictAccount().finally(() => {
      setupResumeRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupAfterConnect, poly.signer, poly.isReady]);

  const handleReconnect = useCallback(async () => {
    setBusy(true);
    try {
      await loadPortfolio();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Refresh failed';
      Alert.alert('Error', msg);
    } finally {
      setBusy(false);
    }
  }, [loadPortfolio]);

  const handleOpenMarket = useCallback((slug: string) => {
    router.push(getPredictMarketHref(slug));
  }, [router]);

  const handleCashOut = useCallback((position: PortfolioPosition) => {
    setCashOutPosition(position);
  }, []);

  const positions = portfolio?.positions ?? EMPTY_PORTFOLIO_POSITIONS;
  const redeemablePositions = portfolio?.redeemablePositions ?? [];
  const closedPositions = portfolio?.closedPositions ?? [];
  const {
    quotes: sellQuotes,
    booksByAsset: sellQuoteBooks,
  } = usePositionSellQuotes(positions);
  const cashOutNow = useMemo(() => {
    if (positions.length === 0) return 0;
    let total = 0;
    for (const position of positions) {
      const quote = getPositionSellQuote(sellQuotes, position);
      if (!quote || quote.estimatedProceeds === null) return null;
      total += quote.estimatedProceeds;
    }
    return total;
  }, [positions, sellQuotes]);
  const readyToCollect = portfolio?.summary.readyToCollect ?? redeemablePositions.reduce((sum, p) => sum + (p.currentValue ?? 0), 0);
  const waitingPickValue = openOrders.reduce((sum, order) => sum + getOrderCost(order), 0);
  const activePickCount = positions.length + openOrders.length;
  const hasAnyPicks = activePickCount + redeemablePositions.length + closedPositions.length > 0;
  const hasActiveOrReadyPicks = activePickCount + redeemablePositions.length > 0;
  const activePicksValue = cashOutNow === null ? null : cashOutNow + waitingPickValue;
  const predictValue = cashBalance === null || activePicksValue === null
    ? null
    : cashBalance + activePicksValue + readyToCollect;
  const collectedValue = portfolio?.summary.totalRealizedPnl ?? closedPositions.reduce((sum, position) => {
    const realized = Number.isFinite(position.realizedPnl) ? position.realizedPnl : 0;
    return sum + realized;
  }, 0);
  const collectedDisplay = hasAnyPicks || (cashBalance ?? 0) > 0 ? formatProfileMoney(collectedValue) : '--';

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
        left={<AppTopBarIconButton icon="arrow-back" onPress={() => router.back()} accessibilityLabel="Go back" />}
        center={<AppTopBarTitle align="left">Profile</AppTopBarTitle>}
        right={(
          <View style={styles.headerActions}>
            {isEnabled && (
              <>
                <Pressable onPress={() => setDepositOpen(true)} style={styles.headerActionBtn}>
                  <MaterialIcons name="arrow-downward" size={12} color={tokens.colors.viridian} />
                  <Text style={styles.headerActionText}>Deposit</Text>
                </Pressable>
                <Pressable onPress={() => setWithdrawOpen(true)} style={styles.headerActionBtn}>
                  <MaterialIcons name="arrow-upward" size={12} color={tokens.colors.primary} />
                  <Text style={[styles.headerActionText, { color: tokens.colors.primary }]}>Withdraw</Text>
                </Pressable>
              </>
            )}
            <AppTopBarIconButton
              icon="settings"
              onPress={() => setSettingsOpen(true)}
              accessibilityLabel="Open Polymarket profile currency settings"
              color={semantic.text.dim}
            />
          </View>
        )}
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: tokens.spacing.md }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          isEnabled ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={tokens.colors.primary}
              colors={[tokens.colors.primary]}
            />
          ) : undefined
        }
      >
        {/* ── Identity ── */}
        <View style={styles.identity}>
          <View style={styles.avatarRing}>
            <View style={styles.avatarInner}>
              <Text style={styles.avatarText}>
                {(portfolio?.profile?.name ?? 'U').charAt(0).toUpperCase()}
              </Text>
            </View>
          </View>
          <View style={styles.identityInfo}>
            {/*
              Polymarket settles on Polygon, so this header reports the EVM
              wallet — the signer's address, which exists as soon as the user is
              signed in. Reading `polygonAddress` here showed "—" to a user with
              a perfectly good wallet, because that field only lands after CLOB
              auth has run.
            */}
            <Text style={styles.handle}>
              {portfolio?.profile?.name ?? (walletAddress ? truncate(walletAddress) : '—')}
            </Text>
            <View style={styles.identityMetaRow}>
              <Text style={styles.identityMeta}>
                {privyAuthMethod !== null
                  ? `Signed in with ${privyAuthMethod === 'google' ? 'Google' : privyAuthMethod === 'email' ? 'email' : 'wallet'}`
                  : walletAddress
                    ? truncate(walletAddress, 4, 4)
                    : 'Not signed in'}
              </Text>
              {walletAddress && (
                <View style={styles.connectedChip}>
                  <View style={styles.connectedDot} />
                  <Text style={styles.connectedText}>Protected</Text>
                </View>
              )}
            </View>
          </View>

          {!isEnabled && !poly.isLoading && !walletAddress && (
            <Pressable
              onPress={handleConnectPredictAccount}
              style={styles.passkeyCta}
            >
              <MaterialIcons name="login" size={14} color={tokens.colors.backgroundDark} />
              <Text style={styles.passkeyCtaText}>Connect wallet</Text>
            </Pressable>
          )}
          {isEnabled && (
            <View style={styles.accountActiveBadge}>
              <View style={styles.connectedDot} />
              <Text style={styles.accountActiveText}>Active</Text>
            </View>
          )}
        </View>

        {(poly.isLoading || portfolioLoading) && (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={tokens.colors.primary} size="small" />
          </View>
        )}

        {predictUnavailable && isEnabled && !portfolioLoading && (
          <Pressable onPress={handleReconnect} disabled={busy} style={styles.reconnectBanner}>
            <MaterialIcons name="refresh" size={14} color={tokens.colors.primary} />
            <Text style={styles.reconnectText}>
              {busy ? 'Retrying…' : 'Could not refresh Predict — tap to retry'}
            </Text>
          </Pressable>
        )}

        {!isEnabled && !poly.isLoading && (
          <View style={styles.positionsSection}>
            <EmptyPortfolio
              mode="no-account"
              // Gated on the EVM wallet, not the SecureClient: a user with a
              // resolved signer and no client needs "Set up Polymarket", not a
              // connection sheet that shows an already-connected wallet and
              // offers nothing. Both paths run the same handler, which opens the
              // sheet only when there is genuinely no signer.
              onPrimaryAction={handleConnectPredictAccount}
              primaryLabel={!walletAddress ? 'Connect wallet' : 'Set up Polymarket'}
            />
          </View>
        )}

        {/* ── Enabled: real portfolio ── */}
        {isEnabled && !portfolioLoading && (
          <>
            {/* Performance strip */}
            {/* <PerfStrip positions={positions} /> */}

            {/* Money map — PRD §7: total Predict value split into Available /
                In picks / Ready to collect, with Deposit + Withdraw inside the
                card. Dark walletCore is this card's reserved token. */}
            <View style={styles.moneyCard}>
              <Text style={styles.moneyEyebrow}>Predict value</Text>
              <Text style={styles.moneyTotal}>
                {predictValue !== null ? formatProfileMoney(predictValue) : '--'}
              </Text>
              <View style={styles.moneyBar}>
                {cashBalance !== null && cashBalance > 0 && (
                  <View style={[styles.moneyBarSeg, styles.moneyBarAvailable, { flex: Math.max(cashBalance, 0.01) }]} />
                )}
                {activePicksValue !== null && activePicksValue > 0 && (
                  <View style={[styles.moneyBarSeg, styles.moneyBarInPicks, { flex: Math.max(activePicksValue, 0.01) }]} />
                )}
                {readyToCollect > 0 && (
                  <View style={[styles.moneyBarSeg, styles.moneyBarReady, { flex: Math.max(readyToCollect, 0.01) }]} />
                )}
                {((cashBalance ?? 0) <= 0 && (activePicksValue ?? 0) <= 0 && readyToCollect <= 0) && (
                  <View style={[styles.moneyBarSeg, styles.moneyBarEmpty]} />
                )}
              </View>
              <View style={styles.moneyLegend}>
                <View style={styles.moneyLegendItem}>
                  <View style={[styles.moneyLegendDot, styles.moneyBarAvailable]} />
                  <Text style={styles.moneyLegendLabel}>Available</Text>
                  <Text style={styles.moneyLegendValue}>
                    {cashBalance !== null ? formatProfileMoney(cashBalance) : '--'}
                  </Text>
                </View>
                <View style={styles.moneyLegendItem}>
                  <View style={[styles.moneyLegendDot, styles.moneyBarInPicks]} />
                  <Text style={styles.moneyLegendLabel}>In picks</Text>
                  <Text style={styles.moneyLegendValue}>
                    {activePicksValue !== null ? formatProfileMoney(activePicksValue) : '--'}
                  </Text>
                </View>
                <View style={styles.moneyLegendItem}>
                  <View style={[styles.moneyLegendDot, styles.moneyBarReady]} />
                  <Text style={styles.moneyLegendLabel}>Ready to collect</Text>
                  <Text style={[styles.moneyLegendValue, readyToCollect > 0 && styles.moneyPositive]}>
                    {formatProfileMoney(readyToCollect)}
                  </Text>
                </View>
              </View>
              <View style={styles.moneyActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Deposit into Predict"
                  style={styles.moneyActionBtn}
                  onPress={() => setDepositOpen(true)}>
                  <MaterialIcons name="arrow-downward" size={13} color={semantic.text.primary} />
                  <Text style={styles.moneyActionText}>Deposit</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Withdraw from Predict"
                  style={styles.moneyActionBtn}
                  onPress={() => setWithdrawOpen(true)}>
                  <MaterialIcons name="arrow-upward" size={13} color={semantic.text.primary} />
                  <Text style={styles.moneyActionText}>Withdraw</Text>
                </Pressable>
              </View>
              {hasActiveOrReadyPicks && (
                <View style={styles.moneyStatsRow}>
                  <Text style={styles.moneyStat}>Cash out now {cashOutNow !== null ? formatProfileMoney(cashOutNow) : '--'}</Text>
                  <Text style={styles.moneyStat}>{activePickCount} active {activePickCount === 1 ? 'pick' : 'picks'}</Text>
                  <Text style={styles.moneyStat}>Profit {collectedDisplay}</Text>
                </View>
              )}
            </View>

            <ProfilePortfolioTabs
              positions={positions}
              openOrders={openOrders}
              activity={portfolio?.activity ?? []}
              redeemablePositions={redeemablePositions}
              closedPositions={closedPositions}
              client={poly.client}
              cancellingOrderId={cancellingId}
              freshness={{
                ...activityFreshness,
                loading: portfolioLoading || refreshing,
                stale: activityFreshness.stale || realtimeStatus === 'degraded',
                error: activityFreshness.error
                  ?? (realtimeStatus === 'degraded' ? 'Live updates delayed; using periodic refresh' : null),
              }}
              sellQuotes={sellQuotes}
              onCashOutPress={handleCashOut}
              onMarketPress={handleOpenMarket}
              onCancelOrder={(orderId) => void handleCancel(orderId)}
              onRedeemed={() => void loadPortfolio()}
              onBrowseMarkets={() => router.push('/markets/polymarket')}
              formatMoney={formatProfileMoney}
            />

            {positions.length === 0 && openOrders.length === 0 && redeemablePositions.length === 0 && closedPositions.length === 0 && (
              <View style={styles.positionsSection}>
                <EmptyPortfolio
                  mode={(cashBalance ?? 0) > 0 ? 'no-picks' : 'no-balance'}
                  onPrimaryAction={(cashBalance ?? 0) > 0 ? () => router.push('/markets/polymarket') : () => setDepositOpen(true)}
                  primaryLabel={(cashBalance ?? 0) > 0 ? 'Browse Markets' : 'Deposit'}
                />
              </View>
            )}

          </>
        )}
      </ScrollView>

      {poly.polygonAddress && poly.client && (
        <DepositModal
          isOpen={depositOpen}
          onClose={() => setDepositOpen(false)}
          polygonAddress={poly.polygonAddress}
          client={poly.client}
          depositWalletAddress={poly.tradingAddress ?? poly.polygonAddress}
          onFundsAvailable={loadPortfolio}
        />
      )}

      {poly.polygonAddress && poly.client && solanaAddress && (
        <WithdrawModal
          isOpen={withdrawOpen}
          onClose={() => setWithdrawOpen(false)}
          client={poly.client}
          solanaAddress={solanaAddress}
          cashBalance={cashBalance}
          onSuccess={loadPortfolio}
        />
      )}

      <CashOutConfirmModal
        visible={cashOutPosition !== null}
        position={cashOutPosition}
        submitting={cashOutSubmitting}
        orderbook={cashOutPosition?.asset ? sellQuoteBooks[cashOutPosition.asset]?.book ?? null : null}
        quoteLoading={cashOutPosition?.asset ? sellQuoteBooks[cashOutPosition.asset]?.loading ?? false : false}
        quoteError={cashOutPosition?.asset ? sellQuoteBooks[cashOutPosition.asset]?.error ?? null : null}
        onClose={() => setCashOutPosition(null)}
        onConfirm={handleConfirmCashOut}
        formatMoney={formatProfileMoney}
      />

      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={closeSettings}>
        <View style={styles.settingsBackdrop}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close Polymarket profile settings"
            style={StyleSheet.absoluteFill}
            onPress={closeSettings}
          />
          <View style={styles.settingsCard} accessibilityViewIsModal>
            <Text style={styles.settingsEyebrow}>Polymarket settings</Text>
            {settingsView !== 'menu' && (
              <Pressable style={styles.settingsBackRow} onPress={() => setSettingsView('menu')} accessibilityRole="button" accessibilityLabel="Back to Polymarket settings">
                <MaterialIcons name="chevron-left" size={16} color={semantic.text.dim} />
                <Text style={styles.settingsBackText}>Back</Text>
              </Pressable>
            )}

            {settingsView === 'menu' && (
              <>
                <Text style={styles.settingsTitle}>Settings</Text>
                <Text style={styles.settingsCopy}>Manage display and wallet controls for Predict.</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open currency display settings"
                  style={styles.settingsOption}
                  onPress={() => setSettingsView('currency')}
                >
                  <View style={styles.settingsOptionIcon}>
                    <MaterialIcons name="payments" size={15} color={tokens.colors.primary} />
                  </View>
                  <View style={styles.settingsOptionCopy}>
                    <Text style={styles.settingsOptionTitle}>Currency display</Text>
                    <Text style={styles.settingsOptionSub}>{currencyFormat} selected</Text>
                  </View>
                  <MaterialIcons name="chevron-right" size={18} color={semantic.text.faint} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open odds format settings"
                  style={styles.settingsOption}
                  onPress={() => setSettingsView('odds')}
                >
                  <View style={styles.settingsOptionIcon}>
                    <MaterialIcons name="percent" size={15} color={tokens.colors.accent} />
                  </View>
                  <View style={styles.settingsOptionCopy}>
                    <Text style={styles.settingsOptionTitle}>Odds format</Text>
                    <Text style={styles.settingsOptionSub}>
                      {oddsFormat === 'probability' ? 'Probability' : oddsFormat === 'decimal' ? 'Decimal' : 'Points'} selected
                    </Text>
                  </View>
                  <MaterialIcons name="chevron-right" size={18} color={semantic.text.faint} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open Polymarket wallet settings"
                  style={styles.settingsOption}
                  onPress={() => setSettingsView('wallet')}
                >
                  <View style={styles.settingsOptionIcon}>
                    <MaterialIcons name="vpn-key" size={15} color={tokens.colors.viridian} />
                  </View>
                  <View style={styles.settingsOptionCopy}>
                    <Text style={styles.settingsOptionTitle}>Account &amp; Security</Text>
                    <Text style={styles.settingsOptionSub}>{privyAuthMethod ? `Signed in with ${privyAuthMethod === 'google' ? 'Google' : privyAuthMethod === 'email' ? 'email' : 'wallet'}` : 'Not signed in'}</Text>
                  </View>
                  <MaterialIcons name="chevron-right" size={18} color={semantic.text.faint} />
                </Pressable>
              </>
            )}

            {settingsView === 'security' && (
              <>
                <Text style={styles.settingsTitle}>Account &amp; Security</Text>
                <Text style={styles.settingsCopy}>Login, wallet, and session controls for Predict.</Text>
                <View style={styles.walletInfoBox}>
                  <View style={styles.walletInfoRow}>
                    <Text style={styles.walletInfoLabel}>Sign-in</Text>
                    <Text style={styles.walletInfoValue}>{privyAuthMethod === 'google' ? 'Google' : privyAuthMethod === 'email' ? 'Email' : privyAuthMethod === 'wallet' ? 'Wallet' : '—'}</Text>
                  </View>
                  <View style={styles.walletInfoRow}>
                    <Text style={styles.walletInfoLabel}>Solana</Text>
                    <Text style={styles.walletInfoValue}>{solanaAddress ? truncate(solanaAddress) : '--'}</Text>
                  </View>
                  <View style={styles.walletInfoRow}>
                    <Text style={styles.walletInfoLabel}>Owner EOA</Text>
                    <Text style={styles.walletInfoValue}>{poly.polygonAddress ? truncate(poly.polygonAddress) : '--'}</Text>
                  </View>
                  <View style={styles.walletInfoRow}>
                    <Text style={styles.walletInfoLabel}>Deposit wallet</Text>
                    <Text style={styles.walletInfoValue}>{poly.tradingAddress ? truncate(poly.tradingAddress) : '--'}</Text>
                  </View>
                </View>
                <Text style={styles.settingsFinePrint}>
                  Your Polymarket wallet is an embedded wallet managed by Privy. There
                  is no key to export from this screen.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Sign out of MyBoon"
                  style={styles.signOutBtn}
                  onPress={() => {
                    setSettingsOpen(false);
                    Alert.alert(
                      'Sign out of MyBoon?',
                      'Your Predict positions and pUSD stay in your account. You will need to sign in again to trade, withdraw, or change security settings.',
                      [
                        { text: 'Stay signed in', style: 'cancel' },
                        { text: 'Sign out', style: 'destructive', onPress: () => { void privyDisconnect(); } },
                      ],
                    );
                  }}>
                  <MaterialIcons name="logout" size={15} color={tokens.colors.vermillion} />
                  <Text style={styles.signOutText}>Sign out</Text>
                </Pressable>
              </>
            )}

            {settingsView === 'odds' && (
              <>
                <Text style={styles.settingsTitle}>Odds format</Text>
                <Text style={styles.settingsCopy}>How prices show across Predict. Books and limit prices always stay in cents.</Text>
                {([
                  { key: 'probability', title: 'Probability', sub: '57% — the chance' },
                  { key: 'decimal', title: 'Decimal', sub: '1.75 — total return per $1' },
                  { key: 'points', title: 'Points', sub: '+75 — profit per $1' },
                ] as const).map((option) => {
                  const selected = oddsFormat === option.key;
                  return (
                    <Pressable
                      key={option.key}
                      accessibilityRole="button"
                      accessibilityLabel={`Show odds in ${option.title} format`}
                      accessibilityState={{ selected }}
                      style={[styles.currencyOption, selected && styles.currencyOptionSelected]}
                      onPress={() => {
                        setOddsFormat(option.key);
                        setSettingsOpen(false);
                        setSettingsView('menu');
                      }}
                    >
                      <View>
                        <Text style={styles.currencyOptionTitle}>{option.title}</Text>
                        <Text style={styles.currencyOptionSub}>{option.sub}</Text>
                      </View>
                      {selected && <MaterialIcons name="check-circle" size={20} color={tokens.colors.primary} />}
                    </Pressable>
                  );
                })}
              </>
            )}

            {settingsView === 'currency' && (
              <>
                <Text style={styles.settingsTitle}>Currency display</Text>
                <Text style={styles.settingsCopy}>Choose how money shows on your Polymarket profile.</Text>
                {(['USD', 'INR'] as const).map((currency) => {
                  const selected = currencyFormat === currency;
                  return (
                    <Pressable
                      key={currency}
                      accessibilityRole="button"
                      accessibilityLabel={`Show Polymarket profile values in ${currency}`}
                      accessibilityState={{ selected }}
                      style={[styles.currencyOption, selected && styles.currencyOptionSelected]}
                      onPress={() => selectCurrencyFormat(currency)}
                    >
                      <View>
                        <Text style={styles.currencyOptionTitle}>{currency}</Text>
                        <Text style={styles.currencyOptionSub}>
                          {currency === 'USD' ? '$ US dollars' : `₹ Indian rupees · live rate ${usdToInrRate.toFixed(2)}`}
                        </Text>
                      </View>
                      {selected && <MaterialIcons name="check-circle" size={20} color={tokens.colors.primary} />}
                    </Pressable>
                  );
                })}
              </>
            )}

            {settingsView === 'wallet' && (
              <>
                <Text style={styles.settingsTitle}>Polymarket wallet</Text>
                <Text style={styles.settingsCopy}>
                  The active mobile SDK account owns authentication, approvals, orders, transfers, and redemption for this deposit wallet.
                </Text>
                <View style={styles.walletInfoBox}>
                  <View style={styles.walletInfoRow}>
                    <Text style={styles.walletInfoLabel}>Solana</Text>
                    <Text style={styles.walletInfoValue}>{solanaAddress ? truncate(solanaAddress) : '--'}</Text>
                  </View>
                  <View style={styles.walletInfoRow}>
                    <Text style={styles.walletInfoLabel}>Owner EOA</Text>
                    <Text style={styles.walletInfoValue}>{poly.polygonAddress ? truncate(poly.polygonAddress) : '--'}</Text>
                  </View>
                  <View style={styles.walletInfoRow}>
                    <Text style={styles.walletInfoLabel}>Deposit wallet</Text>
                    <Text style={styles.walletInfoValue}>{poly.tradingAddress ? truncate(poly.tradingAddress) : '--'}</Text>
                  </View>
                </View>
                <Text style={styles.settingsFinePrint}>
                  Your Polymarket wallet is an embedded wallet managed by Privy. There
                  is no key to export from this screen.
                </Text>
                {poly.isReady && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Disconnect Predict"
                    disabled={busy}
                    onPress={handleDisconnectPredict}
                    style={[styles.settingsDisconnectBtn, busy && { opacity: 0.5 }]}
                  >
                    <Text style={styles.settingsDisconnectText}>
                      {busy ? 'Disconnecting…' : 'Disconnect Predict'}
                    </Text>
                  </Pressable>
                )}
              </>
            )}
          </View>
        </View>
      </Modal>

      <ConnectionSheet
        visible={connectSheet.visible}
        chain={connectSheet.chain}
        // A successful connect also closes the sheet, and `onConnected` fires
        // first — so this flag distinguishes "connected, keep the pending setup"
        // from "user cancelled, drop it". Without it, closing on success would
        // clear `setupAfterConnect` and the resume would never run.
        onConnected={() => { connectedViaSheetRef.current = true; }}
        onClose={() => {
          if (!connectedViaSheetRef.current) setSetupAfterConnect(false);
          connectedViaSheetRef.current = false;
          connectSheet.close();
        }}
      />
    </View>
  );
}

// ── Styles ──

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.background.screen },

  settingsBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 22,
  },
  settingsCard: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: tokens.colors.ground,
    padding: 18,
    gap: 10,
  },
  settingsEyebrow: {
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '800',
    color: semantic.text.faint,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  settingsTitle: {
    fontFamily: 'monospace',
    fontSize: 18,
    fontWeight: '800',
    color: semantic.text.primary,
  },
  settingsCopy: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.dim,
    lineHeight: 15,
    marginBottom: 4,
  },
  settingsDisconnectBtn: {
    marginTop: 8,
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.colors.vermillion,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsDisconnectText: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '800',
    color: tokens.colors.vermillion,
  },
  settingsBackRow: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginBottom: -2,
    paddingVertical: 3,
  },
  settingsBackText: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '800',
    color: semantic.text.dim,
  },
  settingsOption: {
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: semantic.background.surface,
  },
  settingsOptionIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  settingsOptionCopy: {
    flex: 1,
    minWidth: 0,
  },
  settingsOptionTitle: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '800',
    color: semantic.text.primary,
  },
  settingsOptionSub: {
    marginTop: 3,
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
  },
  walletInfoBox: {
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 12,
    padding: 12,
    gap: 9,
    backgroundColor: semantic.background.surface,
  },
  walletInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  walletInfoLabel: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
    textTransform: 'uppercase',
  },
  walletInfoValue: {
    flexShrink: 1,
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.primary,
    textAlign: 'right',
  },
  exportOwnerButton: {
    minHeight: 42,
    borderRadius: 12,
    backgroundColor: tokens.colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  exportOwnerButtonDisabled: {
    opacity: 0.45,
  },
  exportOwnerButtonText: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '800',
    color: tokens.colors.backgroundDark,
  },
  settingsFinePrint: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
    lineHeight: 14,
  },
  currencyOption: {
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: semantic.background.surface,
  },
  currencyOptionSelected: {
    borderColor: tokens.colors.primary,
    backgroundColor: 'rgba(255, 214, 10, 0.08)',
  },
  currencyOptionTitle: {
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '800',
    color: semantic.text.primary,
  },
  currencyOptionSub: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
    marginTop: 3,
  },

  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: semantic.background.lift,
    borderRadius: 12,
    paddingHorizontal: 8,
    minHeight: 26,
  },
  headerActionText: {
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: tokens.colors.viridian,
  },

  scroll: { flex: 1 },

  // Identity
  identity: {
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: semantic.border.muted,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatarRing: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarInner: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: semantic.background.lift,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: '700',
    color: tokens.colors.primary,
  },
  identityInfo: { flex: 1 },
  handle: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: semantic.text.primary,
    marginBottom: 3,
  },
  identityMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  identityMeta: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
  },
  connectedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(52,199,123,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(52,199,123,0.22)',
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginTop: 5,
    alignSelf: 'flex-start',
  },
  connectedDot: {
    width: 4,
    height: 4,
    backgroundColor: tokens.colors.viridian,
    borderRadius: 2,
  },
  connectedText: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    letterSpacing: 1,
    color: tokens.colors.viridian,
  },

  // Auth CTA
  passkeyCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: tokens.colors.primary,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  passkeyCtaText: {
    color: tokens.colors.backgroundDark,
    fontSize: 8,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  accountActiveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(52,199,123,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(52,199,123,0.22)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  accountActiveText: {
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: tokens.colors.viridian,
    textTransform: 'uppercase',
  },
  btnDisabled: { opacity: 0.5 },

  loadingWrap: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  reconnectBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginHorizontal: tokens.spacing.lg,
    marginTop: 10,
    paddingVertical: 10,
    backgroundColor: 'rgba(0,194,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(0,194,255,0.20)',
    borderRadius: 8,
  },
  reconnectText: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: tokens.colors.primary,
    letterSpacing: 0.3,
  },

  // Money map card (PRD §7) — walletCore is this card's reserved dark token
  moneyCard: {
    marginHorizontal: tokens.spacing.lg,
    marginTop: 12,
    backgroundColor: tokens.colors.walletCore,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 22,
    padding: 16,
    gap: 10,
  },
  moneyEyebrow: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  moneyTotal: {
    fontFamily: 'monospace',
    fontSize: 28,
    fontWeight: '800',
    color: semantic.text.primary,
    letterSpacing: -0.5,
  },
  moneyBar: {
    flexDirection: 'row',
    height: 10,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(245,250,252,0.08)',
  },
  moneyBarSeg: {},
  moneyBarAvailable: { backgroundColor: tokens.colors.viridian },
  moneyBarInPicks: { backgroundColor: tokens.colors.primary },
  moneyBarReady: { backgroundColor: tokens.colors.accent },
  moneyBarEmpty: { flex: 1, backgroundColor: 'rgba(245,250,252,0.08)' },
  moneyLegend: {
    flexDirection: 'row',
    gap: 12,
  },
  moneyLegendItem: {
    flex: 1,
    gap: 2,
  },
  moneyLegendDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginBottom: 1,
  },
  moneyLegendLabel: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
  },
  moneyLegendValue: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  moneyPositive: {
    color: tokens.colors.viridian,
  },
  moneyActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  moneyActionBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: 'rgba(245,250,252,0.06)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  moneyActionText: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  moneyStatsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  moneyStat: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.dim,
  },
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(239,71,111,0.35)',
    backgroundColor: 'rgba(239,71,111,0.08)',
    marginTop: 4,
  },
  signOutText: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: tokens.colors.vermillion,
  },

  // Equity card (legacy, unused)
  equityCard: {
    marginHorizontal: tokens.spacing.lg,
    marginTop: 12,
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 10,
    padding: 14,
  },
  equityRow: {
    flexDirection: 'row',
  },
  equityRowSecond: {
    marginTop: 14,
  },
  eqItem: { flex: 1, gap: 3 },
  eqItemCenter: { alignItems: 'center' },
  eqItemRight: { alignItems: 'flex-end' },
  eqLabel: {
    fontFamily: 'monospace',
    fontSize: 6.5,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  eqVal: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: semantic.text.primary,
  },

  // Positions
  positionsSection: {
    marginHorizontal: tokens.spacing.lg,
    marginTop: 12,
  },
  posHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  posTitle: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },
  posCount: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.faint,
  },
  posRow: {
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    padding: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 5,
  },
  sideBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 3,
  },
  sideBadgeYes: { backgroundColor: 'rgba(52,199,123,0.12)' },
  sideBadgeNo: { backgroundColor: 'rgba(244,88,78,0.12)' },
  sideBadgeText: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    fontWeight: '700',
  },
  posQuestion: {
    flex: 1,
    fontSize: 9.5,
    color: semantic.text.primary,
    lineHeight: 13,
  },
  posPnlWrap: {
    alignItems: 'flex-end',
    gap: 1,
  },
  posPnl: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '700',
  },
  posEntry: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.faint,
  },
  tradeTime: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.faint,
    marginTop: 1,
  },
  tradeInfoWrap: {
    flex: 1,
    marginLeft: 8,
  },

  // Order cards
  orderCard: {
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    padding: 10,
    marginBottom: 5,
    gap: 8,
  },
  orderCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  orderOutcome: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.primary,
  },
  orderStatus: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.faint,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  orderCardStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  orderStatLabel: {
    fontFamily: 'monospace',
    fontSize: 7,
    color: semantic.text.faint,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 1,
  },
  orderStatVal: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.primary,
    fontWeight: '600',
  },

  cancelBtn: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,69,58,0.25)',
    borderRadius: 6,
    paddingVertical: 6,
    alignItems: 'center',
  },
  cancelBtnText: {
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '700',
    color: semantic.sentiment.negative,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  emptyCard: {
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  emptyText: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
    letterSpacing: 0.5,
  },

  // Color helpers
  posText: { color: tokens.colors.viridian },
  negText: { color: tokens.colors.vermillion },
});
