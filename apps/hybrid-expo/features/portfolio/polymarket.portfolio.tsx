/**
 * Polymarket per-venue portfolio drill-down (#657, D2).
 *
 * Moves the retired `app/markets/polymarket/profile.tsx` onto the shared
 * VenuePortfolioScreen shell with the fixed Positions · Orders · History tabs
 * (the old Activity tab becomes History). The identity header, money
 * breakdown, account-state machine, settings sheet, deposit/withdraw, cash-out,
 * redeem and disconnect flows are moved verbatim. Polymarket's tested pure
 * logic lives in `features/polymarket/portfolio/`; PositionDetailScreen and
 * SellForm moved to `features/polymarket/position/`. Redemptions run through
 * the same `redeemPosition` + `redeemErrors` path; cash-out through the
 * unchanged `CashOutConfirmModal` → `placeBet` SELL flow. A position tap opens
 * the market detail as before, with Cash out as the row's venue action.
 * No new execution path. Data, account-setup and cash-out state machines live
 * in the hooks under `features/portfolio/polymarket/` (#738).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { AppTopBar, AppTopBarIconButton } from '@/components/AppTopBar';
import { DepositModal } from '@/components/polymarket/DepositModal';
import { CashOutConfirmModal } from '@/features/polymarket/components/CashOutConfirmModal';
import { WithdrawModal } from '@/components/polymarket/WithdrawModal';
import { getPolymarketMarketHref } from '@/features/polymarket/polymarket.navigation';
import { truncateUsd } from '@/features/polymarket/formatPolymarketMoney';
import {
  buildPolymarketActivityItems,
} from '@/features/polymarket/polymarketActivityState';
import { usePositionSellQuotes } from '@/features/polymarket/positionSellQuotes';
import { useWallet } from '@/hooks/useWallet';
import { usePolymarketWallet } from '@/hooks/usePolymarketWallet';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import { useOddsFormat } from '@/hooks/useOddsFormat';
import { usePolymarketQuickAmounts } from '@/features/polymarket/usePolymarketQuickAmounts';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { APPROX_TOTAL_NOTE, formatApproxTotal } from '@/features/polymarket/portfolio/portfolio-totals';
import {
  fetchUsdToInrRate,
  formatProfileCurrency,
  maskEmail,
  POLYMARKET_PROFILE_CURRENCY_KEY,
  POLYMARKET_PROFILE_FALLBACK_USD_TO_INR,
  truncate,
  type PolymarketProfileCurrency,
  type PolymarketSettingsView,
} from '@/features/portfolio/polymarket/polymarket.format';
import { usePolymarketPortfolioData } from '@/features/portfolio/polymarket/usePolymarketPortfolioData';
import { usePolymarketAccountSetup } from '@/features/portfolio/polymarket/usePolymarketAccountSetup';
import { usePolymarketCashOut } from '@/features/portfolio/polymarket/usePolymarketCashOut';
import { styles } from '@/features/portfolio/polymarket/polymarket.portfolio.styles';
import { derivePolymarketTotals } from '@/features/portfolio/polymarket/polymarket.totals';
import { PolymarketIdentityHeader } from '@/features/portfolio/polymarket/PolymarketIdentityHeader';
import { buildPolymarketHistoryRows, getPolymarketVisibleActivity } from '@/features/portfolio/polymarket/PolymarketHistoryTab';
import { PolymarketMoneyCard } from '@/features/portfolio/polymarket/PolymarketMoneyCard';
import { buildPolymarketOrdersTab } from '@/features/portfolio/polymarket/PolymarketOrdersTab';
import { buildPolymarketPositionsTab } from '@/features/portfolio/polymarket/PolymarketPositionsTab';
import { VenuePortfolioScreen } from '@/features/portfolio/VenuePortfolioScreen';
import type { VenuePortfolioScreenTab } from '@/features/portfolio/VenuePortfolioScreen';
import { semantic, tokens } from '@/theme';

export function PolymarketPortfolioScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // Solana is read only as a withdrawal destination — never as this screen's
  // connection state. Polymarket settles on Polygon, so `poly` is the source of truth.
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
  const [busy, setBusy] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const openWithdrawModal = useCallback(() => setWithdrawOpen(true), []);

  const [refreshing, setRefreshing] = useState(false);
  const [usdToInrRate, setUsdToInrRate] = useState(POLYMARKET_PROFILE_FALLBACK_USD_TO_INR);
  const [currencyFormat, setCurrencyFormat] = useState<PolymarketProfileCurrency>('INR');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<PolymarketSettingsView>('menu');
  const { quickAmounts, setQuickAmounts } = usePolymarketQuickAmounts();
  const [quickAmountDraft, setQuickAmountDraft] = useState(() => quickAmounts.map(String));
  const [quickAmountError, setQuickAmountError] = useState<string | null>(null);
  const [quickAmountSaving, setQuickAmountSaving] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const isEnabled = Boolean(poly.isReady && poly.polygonAddress);
  const dismissSettings = useCallback(() => setSettingsOpen(false), []);

  useEffect(() => {
    AsyncStorage.getItem(POLYMARKET_PROFILE_CURRENCY_KEY)
      .then((stored) => {
        if (stored === 'USD' || stored === 'INR') setCurrencyFormat(stored);
      })
      .catch(() => {});
  }, []);

  const selectCurrencyFormat = useCallback((next: PolymarketProfileCurrency) => {
    setCurrencyFormat(next);
    setSettingsOpen(false);
    setSettingsView('menu');
    AsyncStorage.setItem(POLYMARKET_PROFILE_CURRENCY_KEY, next).catch(() => {});
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

  // Data, setup and cash-out live in hooks under features/portfolio/polymarket/
  // (#738). The wallet-scope reset must also clear cash-out state owned by
  // usePolymarketCashOut, so the screen bridges the two via a ref the cash-out
  // hook fills below.
  const clearCashOutPositionRef = useRef<() => void>(() => {});
  const {
    portfolio,
    cashBalance,
    openOrders,
    portfolioLoading,
    polymarketUnavailable,
    activityFreshness,
    realtimeStatus,
    loadPortfolio,
    resetWalletScopedState,
    setOpenOrders,
    setActivityFreshness,
    setPolymarketUnavailable,
  } = usePolymarketPortfolioData({
    poly,
    walletScopedKey,
    isEnabled,
    onWalletReset: () => clearCashOutPositionRef.current(),
  });
  const {
    accountState,
    setupCopy,
    connectSheet,
    handleConnectPolymarketAccount,
    handleReconnect,
    handleWithdrawPress,
    handleSheetConnected,
    handleSheetClose,
  } = usePolymarketAccountSetup({
    poly,
    walletAddress,
    isEnabled,
    busy,
    isPrivyUser: privy.isPrivyUser,
    setBusy,
    loadPortfolio,
    setPolymarketUnavailable,
    solanaAddress,
    dismissSettings,
    openWithdrawModal,
  });

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
  const formatProfileMoney = useCallback(
    (value: number | null | undefined) => formatProfileCurrency(value, currencyFormat, usdToInrRate),
    [currencyFormat, usdToInrRate],
  );

  const handleDisconnectPolymarket = useCallback(() => {
    Alert.alert(
      'Disconnect Polymarket?',
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
                  'Polymarket was not disconnected',
                  error instanceof Error
                    ? error.message
                    : 'The API key could not be revoked. Your local Polymarket credentials were preserved.',
                );
              })
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  }, [closeSettings, poly, resetWalletScopedState]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadPortfolio();
    setRefreshing(false);
  }, [loadPortfolio]);

  const handleOpenMarket = useCallback((slug: string) => {
    router.push(getPolymarketMarketHref(slug));
  }, [router]);

  const {
    positions,
    redeemablePositions,
    closedPositions,
    portfolioSummary,
    showingLabel,
    readyToCollect,
    activePicksValue,
    polymarketValue,
    portfolioVisible,
    accountStateLabel,
    accountStatePositive,
    actionsDisabled,
  } = derivePolymarketTotals({
    portfolio,
    openOrders,
    cashBalance,
    accountState,
  });
  const {
    quotes: sellQuotes,
    booksByAsset: sellQuoteBooks,
  } = usePositionSellQuotes(positions);

  const cashOut = usePolymarketCashOut({
    poly,
    loadPortfolio,
    actionsDisabled,
    setOpenOrders,
    setActivityFreshness,
  });
  // Filled after usePolymarketCashOut so the data hook's wallet-scope reset can
  // clear the cash-out position (see the onWalletReset bridge above).
  clearCashOutPositionRef.current = cashOut.clearCashOutPosition;

  const sortedOrders = useMemo(
    () => [...openOrders].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0)),
    [openOrders],
  );
  const closedItems = useMemo(
    () => buildPolymarketActivityItems({
      positions: [],
      redeemablePositions: [],
      openOrders: [],
      closedPositions,
    }),
    [closedPositions],
  );
  const visibleActivity = useMemo(
    () => getPolymarketVisibleActivity(portfolio?.activity ?? [], closedItems),
    [closedItems, portfolio],
  );

  const { redeemableRows, positionRows } = buildPolymarketPositionsTab({
    redeemablePositions,
    positions,
    sellQuotes,
    redeemingId: cashOut.redeemingId,
    redeemError: cashOut.redeemError,
    actionsDisabled,
    polyClient: poly.client,
    onCollect: cashOut.collect,
    onCashOut: cashOut.handleCashOut,
    onOpenMarket: handleOpenMarket,
  });

  const { orderRows, reservedNote } = buildPolymarketOrdersTab({
    sortedOrders,
    cancellingId: cashOut.cancellingId,
    actionsDisabled,
    onCancel: cashOut.handleCancel,
  });

  const moneyCard = (
    <PolymarketMoneyCard
      cashBalance={cashBalance}
      activePicksValue={activePicksValue}
      readyToCollect={readyToCollect}
    />
  );

  const pageAbove = (
    <PolymarketIdentityHeader
      accountState={accountState}
      accountStateLabel={accountStateLabel}
      accountStatePositive={accountStatePositive}
      displayName={displayName}
      identitySubtitle={identitySubtitle}
      setupCopy={setupCopy}
      busy={busy}
      polymarketUnavailable={polymarketUnavailable}
      isEnabled={isEnabled}
      portfolioLoading={portfolioLoading}
      onConnectAccount={handleConnectPolymarketAccount}
      onReconnect={handleReconnect}
      setSettingsView={setSettingsView}
      setSettingsOpen={setSettingsOpen}
    />
  );

  const tabs = useMemo(() => {
    const ready = portfolioVisible && !portfolioLoading;
    const build = (rows: VenuePortfolioScreenTab['sections']): VenuePortfolioScreenTab => ({
      status: ready ? 'ready' : 'loading',
      sections: rows,
    });

    const freshnessNote = () =>
      activityFreshness.error || realtimeStatus === 'degraded' ? (
        <Text style={styles.freshNote}>
          {activityFreshness.error
            ?? (realtimeStatus === 'degraded' ? 'Live updates delayed; using periodic refresh' : null)}
        </Text>
      ) : null;

    const historyModel = buildPolymarketHistoryRows({
      closedItems,
      visibleActivity,
      onOpenMarket: handleOpenMarket,
    });

    return {
      positions: {
        ...build([
          { key: 'ready', label: 'Ready to collect', rows: redeemableRows },
          { key: 'positions', label: 'Open positions', rows: positionRows },
        ]),
        empty: ready
          ? {
              title: 'No positions yet',
              message: openOrders.length > 0 ? 'Your open orders are still waiting to match.' : 'Choose a market and your position will appear here.',
            }
          : null,
        above: (
          <>
            {pageAbove}
            {moneyCard}
            {showingLabel ? <Text style={styles.showingNote}>{showingLabel}</Text> : null}
          </>
        ),
        below: freshnessNote(),
      },
      orders: {
        ...build([{ key: 'orders', label: 'Open orders', rows: orderRows }]),
        empty: ready
          ? { title: 'No open orders', message: 'Limit orders waiting to match will appear here.' }
          : null,
        above: pageAbove,
        below: (
          <>
            {reservedNote}
            {freshnessNote()}
          </>
        ),
      },
      history: {
        ...build([{ key: 'history', label: 'Recent market activity', rows: historyModel }]),
        empty: ready
          ? { title: 'No market activity yet', message: 'Trades, settlements and payouts reported by Polymarket will appear here.' }
          : null,
        above: pageAbove,
        below: freshnessNote(),
      },
    };
  }, [
    portfolioVisible, portfolioLoading, refreshing, redeemableRows, positionRows, orderRows,
    closedItems, visibleActivity, openOrders, moneyCard, pageAbove, activityFreshness,
    realtimeStatus, showingLabel, reservedNote, handleOpenMarket,
  ]);

  if (!portfolioVisible) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <AppTopBar
          left={<AppTopBarIconButton icon="arrow-back" onPress={() => router.back()} accessibilityLabel="Go back" />}
          right={(          <AppTopBarIconButton icon="settings" onPress={() => { setSettingsView('menu'); setSettingsOpen(true); }} accessibilityLabel="Open Polymarket settings" />)}
        />
        <ScrollView contentContainerStyle={styles.profileContent} showsVerticalScrollIndicator={false}>
          {pageAbove}
                  {accountState === 'preparing' ? (
                    <View style={styles.loadingCard}>
                      <ActivityIndicator color={tokens.colors.primary} size="small" />
                      <View style={styles.loadingCopy}>
                        <Text style={styles.loadingTitle}>Preparing Polymarket</Text>
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
                        <Pressable style={styles.setupAction} onPress={handleConnectPolymarketAccount} disabled={busy}>
                          <Text style={styles.setupActionText}>{busy ? 'Working…' : setupCopy.action}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : null}
        </ScrollView>
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
                    accessibilityLabel="Polymarket settings dialog">
                    <View style={styles.sheetGrabber} />
                    <View style={styles.sheetTop}>
                      <Text style={styles.settingsEyebrow}>{settingsView === 'security' ? 'Account & security' : 'Polymarket settings'}</Text>
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
                        <Text style={styles.settingsTitle}>Polymarket settings</Text>
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
                        <Pressable style={styles.settingsOption} onPress={() => setSettingsView('wallet')} accessibilityRole="button" accessibilityLabel="View Polymarket wallet">
                          <View style={styles.settingsOptionIcon}>
                            <MaterialIcons name="account-balance-wallet" size={15} color={tokens.colors.viridian} />
                          </View>
                          <View style={styles.settingsOptionCopy}>
                            <Text style={styles.settingsOptionTitle}>Polymarket wallet</Text>
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
                        <Text style={styles.settingsCopy}>How prices show across Polymarket. Books and limit prices always stay in cents.</Text>
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
                            <Text style={styles.walletInfoLabel}>Polymarket signer</Text>
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
                          Your Polymarket wallet is managed through your MyBoon login. Private keys are never displayed here.
                        </Text>
                        {poly.isReady && (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Disconnect Polymarket"
                            disabled={busy}
                            onPress={handleDisconnectPolymarket}
                            style={[styles.settingsDisconnectBtn, busy && { opacity: 0.5 }]}
                          >
                            <Text style={styles.settingsDisconnectText}>
                              {busy ? 'Disconnecting…' : 'Disconnect Polymarket'}
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
                        <Text style={styles.settingsCopy}>Your Polymarket positions and pUSD stay with your account. Sign in again to trade, withdraw, or collect.</Text>
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
                onConnected={handleSheetConnected}
                onClose={handleSheetClose}
              />
      </View>
    );
  }

  return (
    <>
      <VenuePortfolioScreen
        venueId="polymarket"
        hero={{
          label: 'Your Polymarket value',
          value: formatApproxTotal(truncateUsd(polymarketValue), portfolioSummary),
          note:
            polymarketValue === null
              ? 'Waiting for current balance and position quotes'
              : currencyFormat === 'INR'
                ? `Approximately ${formatProfileCurrency(polymarketValue, 'INR', usdToInrRate)} across your Polymarket account`
                : 'Available cash, positions and ready payouts',
        }}
        right={(
          <AppTopBarIconButton icon="settings" onPress={() => { setSettingsView('menu'); setSettingsOpen(true); }} accessibilityLabel="Open Polymarket settings" />
        )}
        onDeposit={accountState === 'ready' ? () => setDepositOpen(true) : undefined}
        onWithdraw={accountState === 'ready' ? handleWithdrawPress : undefined}
        tabs={tabs}
        refreshing={refreshing}
        onRefresh={() => void onRefresh()}
        testID="polymarket-portfolio"
      />

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
                visible={cashOut.cashOutPosition !== null}
                position={cashOut.cashOutPosition}
                submitting={cashOut.cashOutSubmitting}
                orderbook={cashOut.cashOutPosition?.asset ? sellQuoteBooks[cashOut.cashOutPosition.asset]?.book ?? null : null}
                quoteLoading={cashOut.cashOutPosition?.asset ? sellQuoteBooks[cashOut.cashOutPosition.asset]?.loading ?? false : false}
                quoteError={cashOut.cashOutPosition?.asset ? sellQuoteBooks[cashOut.cashOutPosition.asset]?.error ?? null : null}
                onClose={cashOut.clearCashOutPosition}
                onConfirm={cashOut.handleConfirmCashOut}
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
                    accessibilityLabel="Polymarket settings dialog">
                    <View style={styles.sheetGrabber} />
                    <View style={styles.sheetTop}>
                      <Text style={styles.settingsEyebrow}>{settingsView === 'security' ? 'Account & security' : 'Polymarket settings'}</Text>
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
                        <Text style={styles.settingsTitle}>Polymarket settings</Text>
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
                        <Pressable style={styles.settingsOption} onPress={() => setSettingsView('wallet')} accessibilityRole="button" accessibilityLabel="View Polymarket wallet">
                          <View style={styles.settingsOptionIcon}>
                            <MaterialIcons name="account-balance-wallet" size={15} color={tokens.colors.viridian} />
                          </View>
                          <View style={styles.settingsOptionCopy}>
                            <Text style={styles.settingsOptionTitle}>Polymarket wallet</Text>
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
                        <Text style={styles.settingsCopy}>How prices show across Polymarket. Books and limit prices always stay in cents.</Text>
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
                            <Text style={styles.walletInfoLabel}>Polymarket signer</Text>
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
                          Your Polymarket wallet is managed through your MyBoon login. Private keys are never displayed here.
                        </Text>
                        {poly.isReady && (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Disconnect Polymarket"
                            disabled={busy}
                            onPress={handleDisconnectPolymarket}
                            style={[styles.settingsDisconnectBtn, busy && { opacity: 0.5 }]}
                          >
                            <Text style={styles.settingsDisconnectText}>
                              {busy ? 'Disconnecting…' : 'Disconnect Polymarket'}
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
                        <Text style={styles.settingsCopy}>Your Polymarket positions and pUSD stay with your account. Sign in again to trade, withdraw, or collect.</Text>
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
                onConnected={handleSheetConnected}
                onClose={handleSheetClose}
              />
    </>
  );
}
