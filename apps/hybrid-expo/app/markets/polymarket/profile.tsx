import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppTopBar, AppTopBarIconButton } from '@/components/AppTopBar';
import { DepositModal } from '@/components/predict/DepositModal';
import { WithdrawModal } from '@/components/predict/WithdrawModal';
import { fetchPortfolio, fetchClobBalance, fetchOpenOrders, cancelOrder, placeBet } from '@/features/predict/predict.api';
import type { OpenOrder, PortfolioPosition } from '@/features/predict/predict.api';
import { getPredictMarketHref } from '@/features/predict/predict.navigation';
import { truncateUsd } from '@/features/predict/formatPredictMoney';
import { getPositionSellQuote, usePositionSellQuotes } from '@/features/predict/positionSellQuotes';
import { useWallet } from '@/hooks/useWallet';
import { usePolymarketWallet } from '@/hooks/usePolymarketWallet';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import { useOddsFormat } from '@/hooks/useOddsFormat';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import { ProfilePortfolioTabs } from '@/features/predict/profile/ProfilePortfolioTabs';
import { CashOutConfirmModal } from '@/features/predict/components/CashOutConfirmModal';
import { useFocusedAppStateInterval } from '@/hooks/useFocusedAppStateInterval';
import {
  applyPredictUserEvent,
  isPredictTradeEvent,
  usePolymarketUserStream,
} from '@/features/predict/usePolymarketUserStream';
import { usePredictQuickAmounts } from '@/features/predict/usePredictQuickAmounts';
import {
  getPredictProfileAccountState,
  getPredictProfileSetupCopy,
} from '@/features/predict/profile/profile-state';
import { remainingOrderCost } from '@/features/predict/profile/profile-portfolio-state';
import { usePredictProfileStore } from '@/features/predict/profile/profile-store';
import { semantic, tokens } from '@/theme';

function truncate(addr: string, start = 6, end = 4): string {
  return `${addr.slice(0, start)}···${addr.slice(-end)}`;
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  return `${local.slice(0, Math.min(2, local.length))}•••@${domain}`;
}

const PREDICT_PROFILE_FALLBACK_USD_TO_INR = 95.67;
const USD_INR_RATE_URL = 'https://open.er-api.com/v6/latest/USD';
const PREDICT_PROFILE_CURRENCY_KEY = 'predict-profile-currency-format';
type PredictProfileCurrency = 'USD' | 'INR';
type PredictSettingsView = 'menu' | 'currency' | 'wallet' | 'security' | 'odds' | 'amounts' | 'signout';
type ConnectionIntent = 'predict' | 'withdrawal' | null;
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
  return remainingOrderCost(order) ?? 0;
}

export default function PredictProfileScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // Solana is read only as a withdrawal destination — never as this screen's
  // connection state. Predict settles on Polygon, so `poly` is the source of truth.
  const { address: solanaAddress } = useWallet();
  const privy = usePrivyWallet();
  const privyAuthMethod = privy.authMethod;
  const privyDisconnect = privy.disconnect;
  const poly = usePolymarketWallet();
  const walletAddress = poly.signer?.descriptor.address ?? null;
  const walletScopedKey = poly.signer
    ? `${poly.signer.descriptor.address.toLowerCase()}:${poly.polygonAddress ?? ''}:${poly.tradingAddress ?? ''}`
    : 'disconnected';
  const { format: oddsFormat, setFormat: setOddsFormat } = useOddsFormat();
  // Predict settles on Polygon, so its requirement is EVM.
  const connectSheet = useConnectionSheet('evm');
  const [connectionIntent, setConnectionIntent] = useState<ConnectionIntent>(null);
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

  // Account data belongs to the Predict profile domain, not this route
  // instance. The shared wallet-scoped store survives navigation while still
  // resetting whenever the active signer/deposit wallet changes.
  const {
    portfolio,
    cashBalance,
    openOrders,
    portfolioLoading,
    predictUnavailable,
    activityFreshness,
    hasLoaded: profileHasLoaded,
    setPortfolio,
    setCashBalance,
    setOpenOrders,
    setPortfolioLoading,
    setPredictUnavailable,
    setActivityFreshness,
    markLoaded: markProfileLoaded,
    reset: resetProfileStore,
  } = usePredictProfileStore(walletScopedKey);
  const [refreshing, setRefreshing] = useState(false);
  const [usdToInrRate, setUsdToInrRate] = useState(PREDICT_PROFILE_FALLBACK_USD_TO_INR);
  const [currencyFormat, setCurrencyFormat] = useState<PredictProfileCurrency>('INR');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<PredictSettingsView>('menu');
  const { quickAmounts, setQuickAmounts } = usePredictQuickAmounts();
  const [quickAmountDraft, setQuickAmountDraft] = useState(() => quickAmounts.map(String));
  const [quickAmountError, setQuickAmountError] = useState<string | null>(null);
  const [quickAmountSaving, setQuickAmountSaving] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [cashOutPosition, setCashOutPosition] = useState<PortfolioPosition | null>(null);
  const [cashOutSubmitting, setCashOutSubmitting] = useState(false);

  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const portfolioRefreshInFlight = useRef(false);
  const ordersRefreshInFlight = useRef(false);

  const isEnabled = Boolean(poly.isReady && poly.polygonAddress);
  // Two different questions, and the screen must not confuse them:
  //   walletAddress      — the EVM wallet exists and can sign. Local, from Privy,
  //                        available at app load. This is "connected".
  //   poly.polygonAddress — the mobile SecureClient is authenticated and its
  //                        SDK-resolved account is ready.
  // Gating connection UI on polygonAddress showed "Connect wallet" to a user who
  // already had a working wallet, with no control that advanced them.
  const accountState = getPredictProfileAccountState({
    signerStatus: poly.signerStatus,
    isPrivyUser: privy.isPrivyUser,
    hasSigner: walletAddress !== null,
    predictReady: isEnabled,
    predictLoading: poly.isLoading || busy,
    sessionExpired: poly.sessionExpired,
  });
  const setupCopy = getPredictProfileSetupCopy(accountState);
  const displayName = privy.identityName ?? portfolio?.profile?.name ?? (walletAddress ? truncate(walletAddress) : 'MyBoon account');
  const maskedIdentity = maskEmail(privy.identityEmail);
  const authLabel = privyAuthMethod === 'google'
    ? 'Google'
    : privyAuthMethod === 'email'
      ? 'Email'
      : privyAuthMethod === 'wallet'
        ? 'Wallet'
        : null;
  const identitySubtitle = maskedIdentity
    ? `${maskedIdentity}${authLabel ? ` · ${authLabel}` : ''}`
    : authLabel
      ? `Signed in with ${authLabel}`
      : walletAddress
        ? truncate(walletAddress, 4, 4)
        : 'Not connected';
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
    setQuickAmountError(null);
    setSignOutError(null);
  }, []);

  const handleSignOut = useCallback(async () => {
    if (signOutBusy) return;
    setSignOutBusy(true);
    setSignOutError(null);
    try {
      await privyDisconnect();
      closeSettings();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : 'Could not sign out. Try again.');
    } finally {
      setSignOutBusy(false);
    }
  }, [closeSettings, privyDisconnect, signOutBusy]);

  useEffect(() => {
    if (settingsOpen && settingsView === 'amounts') {
      setQuickAmountDraft(quickAmounts.map(String));
      setQuickAmountError(null);
    }
  }, [quickAmounts, settingsOpen, settingsView]);

  const saveQuickAmounts = useCallback(async () => {
    setQuickAmountSaving(true);
    setQuickAmountError(null);
    try {
      await setQuickAmounts(quickAmountDraft.map((value) => Number.parseFloat(value)));
      setSettingsView('menu');
    } catch (error) {
      setQuickAmountError(error instanceof Error ? error.message : 'Could not save quick amounts.');
    } finally {
      setQuickAmountSaving(false);
    }
  }, [quickAmountDraft, setQuickAmounts]);

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
    resetProfileStore();
    setCashOutPosition(null);
    portfolioRefreshInFlight.current = false;
    ordersRefreshInFlight.current = false;
  }, [resetProfileStore]);

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
        void fetchOpenOrders(poly.client)
          .then(setOpenOrders)
          .catch(() => {
            setActivityFreshness((previous) => ({
              ...previous,
              stale: true,
              error: 'Could not refresh',
            }));
          });
      } else {
        Alert.alert('Cancel failed', result.error ?? 'Unknown error');
      }
    } catch {
      Alert.alert('Cancel failed', 'Network error');
    } finally {
      setCancellingId(null);
    }
  }, [poly.client, setActivityFreshness, setOpenOrders]);

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
    // A missing balance is the only failure signal exposed by this CLOB read.
    // Preserve the last known orders with it: a 401 or transient CLOB failure
    // must not make positions appear to have vanished while reconnecting.
    if (ordersData && balanceData) setOpenOrders(ordersData);
    if (balanceData) {
      setCashBalance(balanceData.balance);
      setPredictUnavailable(false);
    } else {
      setCashBalance(null);
      setPredictUnavailable(true);
    }
    const failed = portfolioResult.status === 'rejected'
      || balanceResult.status === 'rejected'
      || balanceData === null
      || ordersResult.status === 'rejected';
    setActivityFreshness((previous) => ({
      lastUpdatedAt: failed ? previous.lastUpdatedAt : Date.now(),
      loading: false,
      stale: failed,
      error: failed ? 'Could not refresh' : null,
    }));
    markProfileLoaded();
  }, [
    markProfileLoaded,
    poly.client,
    poly.polygonAddress,
    setActivityFreshness,
    setCashBalance,
    setOpenOrders,
    setPortfolio,
    setPredictUnavailable,
  ]);

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

      const failed = portfolioResult.status === 'rejected'
        || balanceResult.status === 'rejected'
        || balanceData === null;
      setActivityFreshness((prev) => ({
        lastUpdatedAt: failed ? prev.lastUpdatedAt : Date.now(),
        loading: false,
        stale: failed,
        error: failed ? 'Could not refresh' : null,
      }));
    } finally {
      portfolioRefreshInFlight.current = false;
    }
  }, [
    poly.client,
    poly.polygonAddress,
    setActivityFreshness,
    setCashBalance,
    setPortfolio,
    setPredictUnavailable,
  ]);

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
  }, [poly.client, setActivityFreshness, setOpenOrders]);

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
    // Keep a previously loaded wallet snapshot visible while its fresh data is
    // requested. Full-page loading is reserved for the first load only.
    if (!profileHasLoaded) setPortfolioLoading(true);
    loadPortfolio().finally(() => {
      if (walletScopedKeyRef.current === requestKey) setPortfolioLoading(false);
    });
    // `profileHasLoaded` is intentionally a point-in-time decision for this
    // wallet activation. Adding it below would trigger a duplicate request when
    // the first load marks the shared snapshot ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isEnabled,
    loadPortfolio,
    poly.polygonAddress,
    resetWalletScopedState,
    setPortfolioLoading,
  ]);

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
  }, [poly, setPredictUnavailable]);

  const handleConnectPredictAccount = useCallback(() => {
    // Predict signs on Polygon, so the requirement is EVM. When the resolver
    // has no signer yet, the shared connection sheet is the entry point and the
    // effect below resumes setup once the signer lands — signing in and setting
    // up Polymarket is one user action, not two.
    if (!poly.signer) {
      setConnectionIntent('predict');
      setSetupAfterConnect(true);
      connectSheet.open('evm');
      return;
    }

    void connectPredictAccount();
  }, [connectPredictAccount, connectSheet, poly.signer]);

  const handleWithdrawPress = useCallback(() => {
    if (accountState !== 'ready') return;
    setSettingsOpen(false);
    if (!solanaAddress) {
      setConnectionIntent('withdrawal');
      connectSheet.open('solana');
      return;
    }
    setWithdrawOpen(true);
  }, [accountState, connectSheet, solanaAddress]);

  useEffect(() => {
    if (connectionIntent !== 'withdrawal' || !solanaAddress) return;
    setConnectionIntent(null);
    setWithdrawOpen(true);
  }, [connectionIntent, solanaAddress]);

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
      await poly.enable();
      // Re-fetch after re-auth
      await loadPortfolio();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Refresh failed';
      Alert.alert('Error', msg);
    } finally {
      setBusy(false);
    }
  }, [loadPortfolio, poly]);

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
  const activePicksValue = cashOutNow === null ? null : cashOutNow + waitingPickValue;
  const predictValue = cashBalance === null || activePicksValue === null
    ? null
    : cashBalance + activePicksValue + readyToCollect;
  const portfolioVisible = accountState === 'ready' || accountState === 'session_expired';
  const accountStateLabel = accountState === 'ready'
    ? 'Account protected'
    : accountState === 'session_expired'
      ? 'Reconnect needed'
      : accountState === 'preparing'
        ? 'Checking account'
        : accountState === 'signed_out'
          ? 'Not connected'
          : accountState === 'unsupported'
            ? 'Wallet unsupported'
            : 'Setup needed';
  const accountStatePositive = accountState === 'ready';

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
        left={<AppTopBarIconButton icon="arrow-back" onPress={() => router.back()} accessibilityLabel="Go back" />}
        center={(
          <View style={styles.titleLockup}>
            <Text style={styles.topTitle}>Profile</Text>
            <Text style={styles.topSubtitle}>Account · Predict</Text>
          </View>
        )}
        right={<AppTopBarIconButton icon="settings" onPress={() => { setSettingsView('menu'); setSettingsOpen(true); }} accessibilityLabel="Open Predict settings" />}
      />

      <ScrollView
        style={styles.scroll}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.profileContent, { paddingBottom: Math.max(insets.bottom, 18) + 20 }]}
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open account and security"
          style={styles.identity}
          onPress={() => {
            if (accountState === 'signed_out') {
              handleConnectPredictAccount();
              return;
            }
            setSettingsView('security');
            setSettingsOpen(true);
          }}>
          <View style={styles.avatarInner}>
            <Text style={styles.avatarText}>{displayName.charAt(0).toUpperCase()}</Text>
            <View style={[styles.avatarStatus, !accountStatePositive && styles.avatarStatusMuted]} />
          </View>
          <View style={styles.identityInfo}>
            <Text style={styles.handle} numberOfLines={1}>{displayName}</Text>
            <Text style={styles.identityMeta} numberOfLines={1}>{identitySubtitle}</Text>
            <View style={styles.identityStateRow}>
              <MaterialIcons
                name={accountStatePositive ? 'verified-user' : accountState === 'session_expired' ? 'sync-problem' : 'shield'}
                size={11}
                color={accountStatePositive ? tokens.colors.viridian : tokens.colors.accent}
              />
              <Text style={[styles.identityStateText, !accountStatePositive && styles.identityStateAttention]}>{accountStateLabel}</Text>
            </View>
          </View>
          <MaterialIcons name="chevron-right" size={20} color={semantic.text.faint} />
        </Pressable>

        {accountState === 'preparing' ? (
          <View style={styles.loadingCard}>
            <ActivityIndicator color={tokens.colors.primary} size="small" />
            <View style={styles.loadingCopy}>
              <Text style={styles.loadingTitle}>Preparing Predict</Text>
              <Text style={styles.loadingText}>Checking your account and wallet setup.</Text>
            </View>
          </View>
        ) : !portfolioVisible ? (
          <View style={styles.setupCard}>
            <View style={styles.setupIcon}>
              <MaterialIcons name={accountState === 'unsupported' ? 'error-outline' : 'account-balance-wallet'} size={23} color={accountState === 'unsupported' ? tokens.colors.vermillion : tokens.colors.viridian} />
            </View>
            <Text style={styles.setupTitle}>{setupCopy.title}</Text>
            <Text style={styles.setupDescription}>{setupCopy.description}</Text>
            {setupCopy.action ? (
              <Pressable style={styles.setupAction} onPress={handleConnectPredictAccount} disabled={busy}>
                <Text style={styles.setupActionText}>{busy ? 'Working…' : setupCopy.action}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {accountState === 'session_expired' ? (
          <Pressable onPress={handleReconnect} disabled={busy} style={styles.reconnectBanner}>
            <MaterialIcons name="refresh" size={15} color={tokens.colors.accent} />
            <View style={styles.reconnectCopy}>
              <Text style={styles.reconnectTitle}>{setupCopy.title}</Text>
              <Text style={styles.reconnectText}>{busy ? 'Reconnecting…' : setupCopy.description}</Text>
            </View>
          </Pressable>
        ) : predictUnavailable && isEnabled && !portfolioLoading ? (
          <Pressable onPress={handleReconnect} disabled={busy} style={styles.reconnectBanner}>
            <MaterialIcons name="refresh" size={14} color={tokens.colors.primary} />
            <Text style={styles.reconnectText}>
              {busy ? 'Retrying…' : 'Could not refresh Predict — tap to retry'}
            </Text>
          </Pressable>
        ) : null}

        {portfolioVisible && portfolioLoading ? (
          <View style={styles.loadingCard}>
            <ActivityIndicator color={tokens.colors.primary} size="small" />
            <View style={styles.loadingCopy}>
              <Text style={styles.loadingTitle}>Loading your Predict account</Text>
              <Text style={styles.loadingText}>Balances, positions and orders are updating.</Text>
            </View>
          </View>
        ) : null}

        {/* ── Enabled: real portfolio ── */}
        {portfolioVisible && !portfolioLoading && (
          <>
            <View style={styles.moneyCard}>
              <View pointerEvents="none" style={styles.moneyOrb} />
              <View style={styles.moneyTop}>
                <Text style={styles.moneyEyebrow}>Your Predict value</Text>
                <Pressable style={styles.currencyChip} onPress={() => { setSettingsView('currency'); setSettingsOpen(true); }}>
                  <Text style={styles.currencyChipText}>{currencyFormat} display</Text>
                  <MaterialIcons name="keyboard-arrow-down" size={13} color={semantic.text.faint} />
                </Pressable>
              </View>
              <View style={styles.moneyValueRow}>
                <Text style={styles.moneyTotal}>{truncateUsd(predictValue)}</Text>
                <Text style={styles.moneyUnit}>pUSD value</Text>
              </View>
              <Text style={styles.moneyCaption}>
                {predictValue === null
                  ? 'Waiting for current balance and position quotes'
                  : currencyFormat === 'INR'
                    ? `Approximately ${formatProfileCurrency(predictValue, 'INR', usdToInrRate)} across your Predict account`
                    : 'Available cash, positions and ready payouts'}
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
                <View style={[styles.moneyLegendItem, styles.moneyLegendAvailable]}>
                  <View style={styles.moneyLegendHeading}>
                    <View style={[styles.moneyLegendDot, styles.moneyBarAvailable]} />
                    <Text style={styles.moneyLegendLabel}>Available</Text>
                  </View>
                  <Text style={styles.moneyLegendValue}>{truncateUsd(cashBalance)}</Text>
                </View>
                <View style={styles.moneyLegendItem}>
                  <View style={styles.moneyLegendHeading}>
                    <View style={[styles.moneyLegendDot, styles.moneyBarInPicks]} />
                    <Text style={styles.moneyLegendLabel}>In picks</Text>
                  </View>
                  <Text style={styles.moneyLegendValue}>{truncateUsd(activePicksValue)}</Text>
                </View>
                <View style={styles.moneyLegendItem}>
                  <View style={styles.moneyLegendHeading}>
                    <View style={[styles.moneyLegendDot, styles.moneyBarReady]} />
                    <Text style={styles.moneyLegendLabel}>Ready</Text>
                  </View>
                  <Text style={[styles.moneyLegendValue, readyToCollect > 0 && styles.moneyReadyValue]}>
                    {truncateUsd(readyToCollect)}
                  </Text>
                </View>
              </View>
              <View style={styles.moneyActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Deposit into Predict"
                  style={[styles.moneyActionBtn, styles.moneyActionPrimary, accountState !== 'ready' && styles.btnDisabled]}
                  disabled={accountState !== 'ready'}
                  onPress={() => setDepositOpen(true)}>
                  <MaterialIcons name="add" size={15} color={tokens.colors.backgroundDark} />
                  <Text style={[styles.moneyActionText, styles.moneyActionPrimaryText]}>Deposit</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Withdraw from Predict"
                  style={[styles.moneyActionBtn, accountState !== 'ready' && styles.btnDisabled]}
                  disabled={accountState !== 'ready'}
                  onPress={handleWithdrawPress}>
                  <MaterialIcons name="north-east" size={14} color={semantic.text.primary} />
                  <Text style={styles.moneyActionText}>Withdraw</Text>
                </Pressable>
              </View>
            </View>

            <ProfilePortfolioTabs
              positions={positions}
              openOrders={openOrders}
              activity={portfolio?.activity ?? []}
              redeemablePositions={redeemablePositions}
              closedPositions={closedPositions}
              client={poly.client}
              cancellingOrderId={cancellingId}
              actionsDisabled={accountState !== 'ready'}
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
              onRedeemed={loadPortfolio}
              onBrowseMarkets={() => router.replace('/markets/polymarket')}
              formatMoney={truncateUsd}
            />
            <View style={styles.privacyNote}>
              <MaterialIcons name="lock" size={14} color={tokens.colors.viridian} />
              <Text style={styles.privacyText}>Login and wallet details stay separate from your picks and history. Sensitive changes require confirmation.</Text>
            </View>
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

      <Modal visible={settingsOpen} transparent animationType="slide" onRequestClose={closeSettings}>
        <KeyboardAvoidingView
          style={styles.settingsBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close Polymarket profile settings"
            style={StyleSheet.absoluteFill}
            onPress={closeSettings}
          />
          <ScrollView
            style={styles.settingsCard}
            contentContainerStyle={[styles.settingsCardContent, { paddingBottom: Math.max(insets.bottom, 20) + 8 }]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            accessibilityViewIsModal
            accessibilityLabel="Predict settings dialog">
            <View style={styles.sheetGrabber} />
            <View style={styles.sheetTop}>
              <Text style={styles.settingsEyebrow}>{settingsView === 'security' ? 'Account & security' : 'Predict settings'}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Close settings" style={styles.sheetClose} onPress={closeSettings}>
                <MaterialIcons name="close" size={18} color={semantic.text.dim} />
              </Pressable>
            </View>
            {settingsView !== 'menu' && (
              <Pressable style={styles.settingsBackRow} onPress={() => setSettingsView('menu')} accessibilityRole="button" accessibilityLabel="Back to Polymarket settings">
                <MaterialIcons name="chevron-left" size={16} color={semantic.text.dim} />
                <Text style={styles.settingsBackText}>Back</Text>
              </Pressable>
            )}

            {settingsView === 'menu' && (
              <>
                <Text style={styles.settingsTitle}>Predict settings</Text>
                <Text style={styles.settingsCopy}>Preferences follow you across every market.</Text>
                <Text style={styles.sheetSectionLabel}>Trading display</Text>
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
                  accessibilityLabel="Edit quick amounts"
                  style={styles.settingsOption}
                  onPress={() => setSettingsView('amounts')}
                >
                  <View style={styles.settingsOptionIcon}>
                    <MaterialIcons name="calculate" size={15} color={tokens.colors.primary} />
                  </View>
                  <View style={styles.settingsOptionCopy}>
                    <Text style={styles.settingsOptionTitle}>Quick amounts</Text>
                    <Text style={styles.settingsOptionSub}>{quickAmounts.map((amount) => `$${amount}`).join(' · ')}</Text>
                  </View>
                  <MaterialIcons name="chevron-right" size={18} color={semantic.text.faint} />
                </Pressable>
                <Text style={styles.sheetSectionLabel}>Account</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open account and security"
                  style={styles.settingsOption}
                  onPress={() => setSettingsView('security')}
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
                <Text style={styles.sheetSectionLabel}>Safety</Text>
                <View style={styles.settingsOption}>
                  <View style={styles.settingsOptionIcon}>
                    <MaterialIcons name="verified-user" size={15} color={tokens.colors.viridian} />
                  </View>
                  <View style={styles.settingsOptionCopy}>
                    <Text style={styles.settingsOptionTitle}>Order review</Text>
                    <Text style={styles.settingsOptionSub}>Payout and maximum loss are always shown</Text>
                  </View>
                  <Text style={styles.alwaysOnText}>Always on</Text>
                </View>
              </>
            )}

            {settingsView === 'security' && (
              <>
                <Text style={styles.settingsTitle}>Account &amp; Security</Text>
                <Text style={styles.settingsCopy}>Manage how you sign in and where funds can move.</Text>
                <Text style={styles.sheetSectionLabel}>Login</Text>
                <View style={styles.settingsOption}>
                  <View style={styles.settingsOptionIcon}>
                    <MaterialIcons name={privyAuthMethod === 'google' ? 'account-circle' : 'email'} size={15} color={tokens.colors.primary} />
                  </View>
                  <View style={styles.settingsOptionCopy}>
                    <Text style={styles.settingsOptionTitle}>{authLabel ?? 'MyBoon login'}</Text>
                    <Text style={styles.settingsOptionSub}>{maskedIdentity ?? (walletAddress ? truncate(walletAddress) : 'Not connected')}</Text>
                  </View>
                  <Text style={styles.settingsValue}>{authLabel ?? '—'}</Text>
                </View>
                <Text style={styles.sheetSectionLabel}>Connected wallets</Text>
                <Pressable style={styles.settingsOption} onPress={() => setSettingsView('wallet')} accessibilityRole="button" accessibilityLabel="View Predict wallet">
                  <View style={styles.settingsOptionIcon}>
                    <MaterialIcons name="account-balance-wallet" size={15} color={tokens.colors.viridian} />
                  </View>
                  <View style={styles.settingsOptionCopy}>
                    <Text style={styles.settingsOptionTitle}>Predict wallet</Text>
                    <Text style={styles.settingsOptionSub}>{walletAddress ? `${truncate(walletAddress)} · ${isEnabled ? 'Connected' : 'Setup needed'}` : 'Not created'}</Text>
                  </View>
                  <MaterialIcons name="chevron-right" size={18} color={semantic.text.faint} />
                </Pressable>
                <Pressable style={styles.settingsOption} onPress={handleWithdrawPress} accessibilityRole="button" accessibilityLabel="Manage Solana withdrawal destination">
                  <View style={styles.settingsOptionIcon}>
                    <MaterialIcons name="north-east" size={15} color={tokens.colors.primary} />
                  </View>
                  <View style={styles.settingsOptionCopy}>
                    <Text style={styles.settingsOptionTitle}>Withdrawal destination</Text>
                    <Text style={styles.settingsOptionSub}>{solanaAddress ? `${truncate(solanaAddress)} · Solana` : 'Connect a Solana wallet'}</Text>
                  </View>
                  <MaterialIcons name="chevron-right" size={18} color={semantic.text.faint} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Sign out of MyBoon"
                  style={styles.signOutBtn}
                  onPress={() => setSettingsView('signout')}>
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
                <Text style={styles.settingsTitle}>Predict wallet</Text>
                <Text style={styles.settingsCopy}>
                  The active mobile SDK account owns authentication, approvals, orders, transfers, and redemption for this deposit wallet.
                </Text>
                <View style={styles.walletInfoBox}>
                  <View style={styles.walletInfoRow}>
                    <Text style={styles.walletInfoLabel}>Predict signer</Text>
                    <Text selectable style={styles.walletInfoValue}>{walletAddress ? truncate(walletAddress) : '--'}</Text>
                  </View>
                  <View style={styles.walletInfoRow}>
                    <Text style={styles.walletInfoLabel}>Deposit wallet</Text>
                    <Text selectable style={styles.walletInfoValue}>{poly.tradingAddress ? truncate(poly.tradingAddress) : '--'}</Text>
                  </View>
                  <View style={styles.walletInfoRow}>
                    <Text style={styles.walletInfoLabel}>Network</Text>
                    <Text style={styles.walletInfoValue}>Polygon</Text>
                  </View>
                </View>
                <Text style={styles.settingsFinePrint}>
                  Your Predict wallet is managed through your MyBoon login. Private keys are never displayed here.
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

            {settingsView === 'amounts' && (
              <>
                <Text style={styles.settingsTitle}>Quick amounts</Text>
                <Text style={styles.settingsCopy}>Choose the three shortcuts shown in the order composer.</Text>
                <View style={styles.quickAmountRow}>
                  {quickAmountDraft.map((value, index) => (
                    <View key={`quick-${index}`} style={styles.quickAmountInputWrap}>
                      <Text style={styles.quickAmountCurrency}>$</Text>
                      <TextInput
                        value={value}
                        onChangeText={(next) => setQuickAmountDraft((current) => current.map((entry, entryIndex) => entryIndex === index ? next : entry))}
                        keyboardType="decimal-pad"
                        placeholder="0"
                        placeholderTextColor={semantic.text.faint}
                        style={styles.quickAmountInput}
                        accessibilityLabel={`Quick amount ${index + 1}`}
                      />
                    </View>
                  ))}
                </View>
                {quickAmountError ? <Text selectable style={styles.quickAmountError}>{quickAmountError}</Text> : null}
                <Pressable style={[styles.saveSettingsBtn, quickAmountSaving && styles.btnDisabled]} disabled={quickAmountSaving} onPress={() => void saveQuickAmounts()}>
                  <Text style={styles.saveSettingsText}>{quickAmountSaving ? 'Saving…' : 'Save amounts'}</Text>
                </Pressable>
              </>
            )}

            {settingsView === 'signout' && (
              <View style={styles.signOutConfirm}>
                <View style={styles.signOutConfirmIcon}>
                  <MaterialIcons name="logout" size={22} color={tokens.colors.vermillion} />
                </View>
                <Text style={styles.settingsTitle}>Sign out of MyBoon?</Text>
                <Text style={styles.settingsCopy}>Your Predict positions and pUSD stay with your account. Sign in again to trade, withdraw, or collect.</Text>
                {signOutError ? <Text selectable style={styles.quickAmountError}>{signOutError}</Text> : null}
                <View style={styles.signOutActions}>
                  <Pressable style={[styles.staySignedInBtn, signOutBusy && styles.btnDisabled]} disabled={signOutBusy} onPress={() => setSettingsView('security')}>
                    <Text style={styles.staySignedInText}>Stay signed in</Text>
                  </Pressable>
                  <Pressable style={[styles.confirmSignOutBtn, signOutBusy && styles.btnDisabled]} disabled={signOutBusy} onPress={() => void handleSignOut()}>
                    <Text style={styles.confirmSignOutText}>{signOutBusy ? 'Signing out…' : 'Sign out'}</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
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
          const completed = connectedViaSheetRef.current;
          connectedViaSheetRef.current = false;
          if (!completed) {
            setSetupAfterConnect(false);
            setConnectionIntent(null);
          } else if (connectionIntent === 'predict') {
            setConnectionIntent(null);
          }
          connectSheet.close();
        }}
      />
    </View>
  );
}

// ── Styles ──

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.background.screen },
  titleLockup: { flex: 1, paddingHorizontal: 7 },
  topTitle: { fontSize: 13, lineHeight: 16, fontWeight: '900', color: semantic.text.primary },
  topSubtitle: { paddingTop: 2, fontFamily: 'monospace', fontSize: 8, color: semantic.text.faint },
  profileContent: { paddingHorizontal: 14, paddingTop: 9, gap: 9 },

  settingsBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  settingsCard: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '88%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: semantic.border.muted,
    backgroundColor: tokens.colors.ground,
  },
  settingsCardContent: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 28,
    gap: 10,
  },
  sheetGrabber: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: semantic.border.muted, marginBottom: 3 },
  sheetTop: { minHeight: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetClose: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: semantic.background.lift },
  sheetSectionLabel: { paddingTop: 6, fontFamily: 'monospace', fontSize: 9, fontWeight: '900', letterSpacing: 0.8, textTransform: 'uppercase', color: tokens.colors.accent },
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
  settingsValue: { fontFamily: 'monospace', fontSize: 9, fontWeight: '800', color: semantic.text.dim },
  alwaysOnText: { fontFamily: 'monospace', fontSize: 8, fontWeight: '900', color: tokens.colors.viridian },
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
    backgroundColor: 'rgba(17,138,178,0.08)',
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
  quickAmountRow: { flexDirection: 'row', gap: 8 },
  quickAmountInputWrap: { flex: 1, minHeight: 48, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderCurve: 'continuous', borderWidth: 1, borderColor: semantic.border.muted, backgroundColor: semantic.background.surface },
  quickAmountCurrency: { fontFamily: 'monospace', fontSize: 13, fontWeight: '900', color: semantic.text.dim },
  quickAmountInput: { flex: 1, minWidth: 0, paddingHorizontal: 4, fontFamily: 'monospace', fontSize: 15, fontWeight: '900', color: semantic.text.primary, textAlign: 'center' },
  quickAmountError: { fontSize: 10, lineHeight: 14, color: tokens.colors.vermillion },
  saveSettingsBtn: { minHeight: 44, borderRadius: 12, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.viridian },
  saveSettingsText: { fontSize: 11, fontWeight: '900', color: tokens.colors.backgroundDark },
  signOutConfirm: { gap: 10, paddingTop: 4 },
  signOutConfirmIcon: { width: 42, height: 42, borderRadius: 13, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(239,71,111,0.10)' },
  signOutActions: { flexDirection: 'row', gap: 8, paddingTop: 5 },
  staySignedInBtn: { flex: 1, minHeight: 44, borderRadius: 12, borderCurve: 'continuous', borderWidth: 1, borderColor: semantic.border.muted, alignItems: 'center', justifyContent: 'center', backgroundColor: semantic.background.surface },
  staySignedInText: { fontSize: 10, fontWeight: '900', color: semantic.text.primary },
  confirmSignOutBtn: { flex: 1, minHeight: 44, borderRadius: 12, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.vermillion },
  confirmSignOutText: { fontSize: 10, fontWeight: '900', color: semantic.text.primary },

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
    minHeight: 76,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 20,
    borderCurve: 'continuous',
    backgroundColor: tokens.colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    boxShadow: 'inset 0 1px 0 rgba(245,250,252,0.06)',
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
    width: 48,
    height: 48,
    borderRadius: 16,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: 'rgba(255,209,102,0.45)',
    backgroundColor: tokens.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 20,
    fontWeight: '900',
    color: tokens.colors.backgroundDark,
  },
  avatarStatus: { position: 'absolute', right: -2, bottom: -2, width: 14, height: 14, borderRadius: 7, borderWidth: 3, borderColor: tokens.colors.surface, backgroundColor: tokens.colors.viridian },
  avatarStatusMuted: { backgroundColor: tokens.colors.accent },
  identityInfo: { flex: 1 },
  handle: {
    fontSize: 15,
    fontWeight: '900',
    color: semantic.text.primary,
    marginBottom: 4,
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
    color: semantic.text.dim,
  },
  identityStateRow: { paddingTop: 6, flexDirection: 'row', alignItems: 'center', gap: 5 },
  identityStateText: { fontFamily: 'monospace', fontSize: 9, fontWeight: '800', color: tokens.colors.viridian },
  identityStateAttention: { color: tokens.colors.accent },
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

  loadingCard: { minHeight: 76, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 18, borderCurve: 'continuous', backgroundColor: tokens.colors.surface },
  loadingCopy: { flex: 1, gap: 4 },
  loadingTitle: { fontSize: 12, fontWeight: '900', color: semantic.text.primary },
  loadingText: { fontFamily: 'monospace', fontSize: 9, lineHeight: 14, color: semantic.text.faint },
  setupCard: { paddingHorizontal: 20, paddingVertical: 24, alignItems: 'center', gap: 9, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 22, borderCurve: 'continuous', backgroundColor: tokens.colors.surface },
  setupIcon: { width: 48, height: 48, borderRadius: 16, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(6,214,160,0.10)' },
  setupTitle: { fontSize: 17, lineHeight: 22, fontWeight: '900', color: semantic.text.primary, textAlign: 'center' },
  setupDescription: { maxWidth: 300, fontFamily: 'monospace', fontSize: 9, lineHeight: 15, color: semantic.text.dim, textAlign: 'center' },
  setupAction: { minWidth: 174, minHeight: 44, marginTop: 4, paddingHorizontal: 18, borderRadius: 12, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.viridian },
  setupActionText: { fontSize: 11, fontWeight: '900', color: tokens.colors.backgroundDark },
  reconnectBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    backgroundColor: 'rgba(255,209,102,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,209,102,0.35)',
    borderRadius: 14,
    borderCurve: 'continuous',
  },
  reconnectCopy: { flex: 1, gap: 3 },
  reconnectTitle: { fontSize: 11, fontWeight: '900', color: semantic.text.primary },
  reconnectText: {
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 13,
    color: semantic.text.dim,
  },

  // Money map card (PRD §7) — walletCore is this card's reserved dark token
  moneyCard: {
    backgroundColor: tokens.colors.walletCore,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 25,
    borderCurve: 'continuous',
    padding: 15,
    overflow: 'hidden',
    boxShadow: '0 17px 36px rgba(3,31,44,0.30), inset 0 1px 0 rgba(245,250,252,0.06)',
  },
  moneyOrb: { position: 'absolute', top: -73, right: -52, width: 154, height: 154, borderWidth: 30, borderColor: 'rgba(17,138,178,0.12)', borderRadius: 77 },
  moneyTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  moneyEyebrow: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: tokens.colors.accent,
  },
  currencyChip: { minHeight: 30, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 9, backgroundColor: tokens.colors.ground },
  currencyChipText: { fontFamily: 'monospace', fontSize: 9, fontWeight: '800', color: semantic.text.dim },
  moneyValueRow: { paddingTop: 13, flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  moneyTotal: {
    fontFamily: 'monospace',
    fontSize: 34,
    fontWeight: '900',
    color: semantic.text.primary,
    letterSpacing: -1.5,
  },
  moneyUnit: { fontFamily: 'monospace', fontSize: 9, color: semantic.text.faint },
  moneyCaption: { paddingTop: 6, fontFamily: 'monospace', fontSize: 9, lineHeight: 13, color: semantic.text.dim },
  moneyBar: {
    flexDirection: 'row',
    height: 12,
    padding: 2,
    gap: 2,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: tokens.colors.ground,
    marginTop: 15,
  },
  moneyBarSeg: {},
  moneyBarAvailable: { backgroundColor: tokens.colors.viridian },
  moneyBarInPicks: { backgroundColor: tokens.colors.primary },
  moneyBarReady: { backgroundColor: tokens.colors.accent },
  moneyBarEmpty: { flex: 1, backgroundColor: 'rgba(245,250,252,0.08)' },
  moneyLegend: {
    flexDirection: 'row',
    gap: 7,
    marginTop: 9,
  },
  moneyLegendItem: {
    flex: 1,
    minWidth: 0,
    gap: 5,
  },
  moneyLegendAvailable: { flex: 1.2 },
  moneyLegendHeading: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  moneyLegendDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
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
  moneyReadyValue: { color: tokens.colors.accent },
  moneyActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
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
    fontSize: 10,
    fontWeight: '900',
    color: semantic.text.primary,
  },
  moneyActionPrimary: { flex: 1.2, borderColor: tokens.colors.viridian, backgroundColor: tokens.colors.viridian },
  moneyActionPrimaryText: { color: tokens.colors.backgroundDark },
  privacyNote: { padding: 11, flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 13, borderCurve: 'continuous', backgroundColor: 'rgba(3,31,44,0.50)' },
  privacyText: { flex: 1, fontFamily: 'monospace', fontSize: 9, lineHeight: 14, color: semantic.text.faint },
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
