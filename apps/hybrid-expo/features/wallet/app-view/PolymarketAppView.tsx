/**
 * Wallet app view — Polymarket tabs, Positions · Orders · History (issue #773).
 *
 * The tabs plug in under the app view header and the top block: a history
 * row's View market opens the market screen, and redeem, cash out and cancel
 * run in place through the unchanged hook flows. Everything is imported from
 * the extracted pieces — the data (`usePolymarketPortfolioData`), account
 * setup and cash-out hooks, the three tab builders, `PolymarketSettingsSheet`
 * and the tab bar shared with `VenuePortfolioScreen` — nothing is copied from
 * the old screen. The old route `/markets/polymarket/profile` is untouched;
 * the settings stay reachable from the gear above the tabs.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { AppTopBarIconButton } from '@/components/AppTopBar';
import { DepositModal } from '@/components/polymarket/DepositModal';
import { CashOutConfirmModal } from '@/features/polymarket/components/CashOutConfirmModal';
import { WithdrawModal } from '@/components/polymarket/WithdrawModal';
import { getPolymarketMarketHref } from '@/features/polymarket/polymarket.navigation';
import {
  buildPolymarketActivityItems,
} from '@/features/polymarket/polymarketActivityState';
import { usePositionSellQuotes } from '@/features/polymarket/positionSellQuotes';
import { useWallet } from '@/hooks/useWallet';
import { usePolymarketWallet } from '@/hooks/usePolymarketWallet';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import { useOddsFormat } from '@/hooks/useOddsFormat';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import {
  formatProfileCurrency,
  maskEmail,
} from '@/features/portfolio/polymarket/polymarket.format';
import { usePolymarketPortfolioData } from '@/features/portfolio/polymarket/usePolymarketPortfolioData';
import { usePolymarketAccountSetup } from '@/features/portfolio/polymarket/usePolymarketAccountSetup';
import { usePolymarketCashOut } from '@/features/portfolio/polymarket/usePolymarketCashOut';
import { usePolymarketSettings } from '@/features/portfolio/polymarket/usePolymarketSettings';
import { PolymarketSettingsSheet } from '@/features/portfolio/polymarket/PolymarketSettingsSheet';
import { derivePolymarketTotals } from '@/features/portfolio/polymarket/polymarket.totals';
import {
  buildPolymarketHistoryRows,
  getPolymarketVisibleActivity,
} from '@/features/portfolio/polymarket/PolymarketHistoryTab';
import { buildPolymarketOrdersTab } from '@/features/portfolio/polymarket/PolymarketOrdersTab';
import { buildPolymarketPositionsTab } from '@/features/portfolio/polymarket/PolymarketPositionsTab';
import { styles as polyStyles } from '@/features/portfolio/polymarket/polymarket.portfolio.styles';
import { PortfolioTabBar, PortfolioTabBody } from '@/features/portfolio/VenuePortfolioScreen';
import type {
  PortfolioTabKey,
  VenuePortfolioScreenTab,
} from '@/features/portfolio/VenuePortfolioScreen';
import { semantic } from '@/theme';

export function PolymarketAppView() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // Same reads as the venue screen: Solana is only a withdrawal destination —
  // Polymarket settles on Polygon, so `poly` is the source of truth.
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
  // and sign-out; the sheet is one copy under `features/portfolio/polymarket/`.
  const settings = usePolymarketSettings({ privyDisconnect });

  // Data, setup and cash-out live in hooks (#738). The wallet-scope reset must
  // also clear cash-out state, so the screen bridges the two via a ref the
  // cash-out hook fills below.
  const clearCashOutPositionRef = useRef<() => void>(() => {});
  const {
    portfolio,
    cashBalance,
    openOrders,
    portfolioLoading,
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
    connectSheet,
    handleSheetConnected,
    handleSheetClose,
    handleWithdrawPress,
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

  const maskedIdentity = maskEmail(privy.identityEmail);
  const authLabel = privyAuthMethod === 'google'
    ? 'Google'
    : privyAuthMethod === 'email'
      ? 'Email'
      : privyAuthMethod === 'wallet'
        ? 'Wallet'
        : null;
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
    showingLabel,
    portfolioVisible,
    actionsDisabled,
  } = derivePolymarketTotals({
    portfolio,
    openOrders,
    cashBalance,
    accountState,
  });
  const { quotes: sellQuotes, booksByAsset: sellQuoteBooks } = usePositionSellQuotes(positions);

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

  const [activeTab, setActiveTab] = useState<PortfolioTabKey>('positions');

  const tabs = useMemo(() => {
    const ready = portfolioVisible && !portfolioLoading;
    const build = (rows: VenuePortfolioScreenTab['sections']): VenuePortfolioScreenTab => ({
      status: ready ? 'ready' : 'loading',
      sections: rows,
    });

    const freshnessNote = () =>
      activityFreshness.error || realtimeStatus === 'degraded' ? (
        <Text style={polyStyles.freshNote}>
          {activityFreshness.error
            ?? (realtimeStatus === 'degraded' ? 'Live updates delayed; using periodic refresh' : null)}
        </Text>
      ) : null;

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
        above: showingLabel ? <Text style={polyStyles.showingNote}>{showingLabel}</Text> : null,
        below: freshnessNote(),
      },
      orders: {
        ...build([{ key: 'orders', label: 'Open orders', rows: orderRows }]),
        empty: ready
          ? { title: 'No open orders', message: 'Limit orders waiting to match will appear here.' }
          : null,
        above: null,
        below: (
          <>
            {reservedNote}
            {freshnessNote()}
          </>
        ),
      },
      history: {
        ...build([{
          key: 'history',
          label: 'Recent market activity',
          rows: buildPolymarketHistoryRows({
            closedItems,
            visibleActivity,
            onOpenMarket: handleOpenMarket,
          }),
        }]),
        empty: ready
          ? { title: 'No market activity yet', message: 'Trades, settlements and payouts reported by Polymarket will appear here.' }
          : null,
        above: null,
        below: freshnessNote(),
      },
    };
  }, [
    portfolioVisible, portfolioLoading, redeemableRows, positionRows, orderRows,
    closedItems, visibleActivity, openOrders, activityFreshness,
    realtimeStatus, showingLabel, reservedNote, handleOpenMarket,
  ]);

  return (
    <View style={styles.screen} testID="polymarket-app-view">
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={semantic.text.accentDim} />
        }
      >
        {/* The Polymarket settings stay reachable from the app view (#773). */}
        <View style={styles.gearRow}>
          <AppTopBarIconButton
            icon="settings"
            onPress={settings.openSettings}
            accessibilityLabel="Open Polymarket settings"
          />
        </View>

        <PortfolioTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />
        <PortfolioTabBody tabKey={activeTab} tab={tabs[activeTab]} />
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
    </View>
  );
}

const styles = StyleSheet.create({
  // Sits under the app view header (and the top block); the shell supplies
  // the background, so this stays transparent.
  screen: { flex: 1 },
  content: { padding: 14, paddingBottom: 40, gap: 12 },
  gearRow: { flexDirection: 'row', justifyContent: 'flex-end' },
});
