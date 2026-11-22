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
 * in the hooks under `features/portfolio/polymarket/` (#738), and the settings
 * sheet is one copy in `PolymarketSettingsSheet` with its state machine in
 * `usePolymarketSettings`; the connection sheet mounts once (#740).
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
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
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { APPROX_TOTAL_NOTE, formatApproxTotal } from '@/features/polymarket/portfolio/portfolio-totals';
import {
  formatProfileCurrency,
  maskEmail,
  truncate,
} from '@/features/portfolio/polymarket/polymarket.format';
import { usePolymarketPortfolioData } from '@/features/portfolio/polymarket/usePolymarketPortfolioData';
import { usePolymarketAccountSetup } from '@/features/portfolio/polymarket/usePolymarketAccountSetup';
import { usePolymarketCashOut } from '@/features/portfolio/polymarket/usePolymarketCashOut';
import { usePolymarketSettings } from '@/features/portfolio/polymarket/usePolymarketSettings';
import { PolymarketSettingsSheet } from '@/features/portfolio/polymarket/PolymarketSettingsSheet';
import { styles } from '@/features/portfolio/polymarket/polymarket.portfolio.styles';
import { derivePolymarketTotals } from '@/features/portfolio/polymarket/polymarket.totals';
import { PolymarketIdentityHeader } from '@/features/portfolio/polymarket/PolymarketIdentityHeader';
import { buildPolymarketHistoryRows, getPolymarketVisibleActivity } from '@/features/portfolio/polymarket/PolymarketHistoryTab';
import { PolymarketMoneyCard } from '@/features/portfolio/polymarket/PolymarketMoneyCard';
import { buildPolymarketOrdersTab } from '@/features/portfolio/polymarket/PolymarketOrdersTab';
import { buildPolymarketPositionsTab } from '@/features/portfolio/polymarket/PolymarketPositionsTab';
import { VenuePortfolioScreen } from '@/features/portfolio/VenuePortfolioScreen';
import type { VenuePortfolioScreenTab } from '@/features/portfolio/VenuePortfolioScreen';
import { tokens } from '@/theme';

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
  const isEnabled = Boolean(poly.isReady && poly.polygonAddress);

  // Settings-sheet state machine (#740): open/view, currency, quick amounts
  // and sign-out, extracted from this screen so the sheet JSX is one copy.
  const settings = usePolymarketSettings({ privyDisconnect });

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
    dismissSettings: settings.dismissSettings,
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
    (value: number | null | undefined) => formatProfileCurrency(value, settings.currencyFormat, settings.usdToInrRate),
    [settings.currencyFormat, settings.usdToInrRate],
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
                settings.closeSettings();
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
  }, [poly, resetWalletScopedState, settings.closeSettings]);

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
      setSettingsView={settings.setSettingsView}
      setSettingsOpen={settings.setSettingsOpen}
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

  // The one copy of the sheet overlays (#740): the settings sheet JSX lives
  // only in PolymarketSettingsSheet and the connection sheet hangs off the
  // account-setup hook. Both returns mount this same pair where each of the
  // two pasted copies used to render. On the connection sheet a successful
  // connect closes it and `onConnected` fires first — so that flag
  // distinguishes "connected, keep the pending setup" from "user cancelled,
  // drop it"; without it closing on success would clear `setupAfterConnect`
  // and the resume would never run.
  const sheetOverlay = (
    <>
      <PolymarketSettingsSheet
        visible={settings.open}
        settingsView={settings.view}
        setSettingsView={settings.setSettingsView}
        setSettingsOpen={settings.setSettingsOpen}
        closeSettings={settings.closeSettings}
        solanaAddress={solanaAddress}
        currencyFormat={settings.currencyFormat}
        usdToInrRate={settings.usdToInrRate}
        selectCurrencyFormat={settings.selectCurrencyFormat}
        oddsFormat={oddsFormat}
        setOddsFormat={setOddsFormat}
        quickAmounts={settings.quickAmounts}
        quickAmountDraft={settings.quickAmountDraft}
        setQuickAmountDraft={settings.setQuickAmountDraft}
        quickAmountError={settings.quickAmountError}
        quickAmountSaving={settings.quickAmountSaving}
        saveQuickAmounts={settings.saveQuickAmounts}
        signOutBusy={settings.signOutBusy}
        signOutError={settings.signOutError}
        handleSignOut={settings.handleSignOut}
        handleWithdrawPress={handleWithdrawPress}
        handleDisconnectPolymarket={handleDisconnectPolymarket}
        authLabel={authLabel}
        maskedIdentity={maskedIdentity}
        privyAuthMethod={privyAuthMethod}
        walletAddress={walletAddress}
        tradingAddress={poly.tradingAddress ?? null}
        polyReady={poly.isReady}
        isEnabled={isEnabled}
        busy={busy}
        insetsBottom={insets.bottom}
      />
      <ConnectionSheet
        visible={connectSheet.visible}
        chain={connectSheet.chain}
        onConnected={handleSheetConnected}
        onClose={handleSheetClose}
      />
    </>
  );

  if (!portfolioVisible) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <AppTopBar
          left={<AppTopBarIconButton icon="arrow-back" onPress={() => router.back()} accessibilityLabel="Go back" />}
          right={<AppTopBarIconButton icon="settings" onPress={settings.openSettings} accessibilityLabel="Open Polymarket settings" />}
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
        {sheetOverlay}
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
              : settings.currencyFormat === 'INR'
                ? `Approximately ${formatProfileCurrency(polymarketValue, 'INR', settings.usdToInrRate)} across your Polymarket account`
                : 'Available cash, positions and ready payouts',
        }}
        right={(
          <AppTopBarIconButton icon="settings" onPress={settings.openSettings} accessibilityLabel="Open Polymarket settings" />
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

              {sheetOverlay}
    </>
  );
}
