import { memo, useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import type { Chain } from '@/features/chain/chain.contract';
import { swapTheme as color } from '@/features/swap/swap.theme';
import { WalletModeSwitch } from '@/features/wallet/components/WalletModeSwitch';
import {
  WALLET_ACTION_BODY_HEIGHT,
  type WalletActionMode,
} from '@/features/wallet/wallet-mode';
import { WalletActionPanel, type SwapPrefill } from '@/features/wallet/WalletActionPanel';
import { AppView } from '@/features/wallet/app-view/AppView';
import {
  initialWalletAppView,
  walletAppViewReducer,
} from '@/features/wallet/app-view.state';
import { ReceivePanel } from '@/features/wallet/components/ReceivePanel';
import { SendPanel } from '@/features/wallet/components/SendPanel';
import { PortfolioSection } from '@/features/wallet/components/PortfolioSection';
import { ChainRow } from '@/features/wallet/components/ChainRow';
import { LegalLinks } from '@/features/wallet/components/LegalLinks';
import {
  type WalletProtocolId,
  type WalletSourcesState,
  type WalletTotals,
} from '@/features/wallet/wallet.types';

const MemoActionPanel = memo(WalletActionPanel);
const MemoModeSwitch = memo(WalletModeSwitch);

function rememberHeight(current: number, next: number): number {
  return current === next ? current : next;
}

const AccountBody = memo(function AccountBody({
  dormantNotices,
  showSolana,
  onConnect,
  chains,
  chainAddress,
  chainBalance,
  onDisconnectChain,
}: {
  dormantNotices?: ReactNode;
  showSolana: boolean;
  onConnect: () => void;
  chains: readonly Chain[];
  chainAddress: (chain: Chain) => string | null;
  chainBalance: (chain: Chain) => number | null;
  onDisconnectChain: (chain: Chain) => void;
}) {
  return (
    <>
      {dormantNotices}
      {showSolana ? null : (
        <View style={styles.disconnected}>
          <Text style={styles.accountTitle}>Connect a Solana wallet</Text>
          <Text style={styles.description}>
            Connect to see Spot, Perps and Meteora accounts.
          </Text>
          <Pressable
            onPress={onConnect}
            accessibilityRole="button"
            accessibilityLabel="Connect Solana wallet"
            style={styles.connect}
          >
            <Text style={styles.connectLabel}>Connect wallet</Text>
          </Pressable>
        </View>
      )}
      {/* EVM funds remain explicitly separate from the Solana portfolio. */}
      {chains.map((chain) => {
        const address = chainAddress(chain);
        return address ? (
          <ChainRow
            key={chain}
            chain={chain}
            address={address}
            balanceUsd={chainBalance(chain)}
            onDisconnect={onDisconnectChain}
          />
        ) : null;
      })}
      <LegalLinks />
    </>
  );
});

export function HomeWalletOverview({
  active,
  surfaceVersion,
  chains,
  chainAddress,
  chainBalance,
  solanaConnected,
  onDisconnectChain,
  walletRefreshing,
  onWalletRefresh,
  onOpenMeteora,
  onOpenPhoenix,
  onOpenPacifica,
  onOpenPolymarket,
  onOpenSpot,
  onConnect,
  dormantNotices,
}: {
  active: boolean;
  surfaceVersion: number;
  chains: readonly Chain[];
  chainAddress: (chain: Chain) => string | null;
  chainBalance: (chain: Chain) => number | null;
  solanaConnected: boolean;
  onDisconnectChain: (chain: Chain) => void;
  walletTotals: WalletTotals;
  walletSources: WalletSourcesState;
  walletRefreshing: boolean;
  onWalletRefresh: () => void;
  onRetrySource: (id: WalletProtocolId) => void;
  onOpenMeteora: () => void;
  onOpenPhoenix: () => void;
  onOpenPacifica: () => void;
  /** The Polymarket profile route the Portfolio row still opens (#769). */
  onOpenPolymarket: () => void;
  onOpenSpot: () => void;
  onConnect: () => void;
  dormantNotices?: React.ReactNode;
}) {
  const [mode, setModeState] = useState<WalletActionMode>('swap');
  // #906: a Spot token the Swap mode opens with as its pay card. Any mode
  // switch clears it, so a later Swap starts empty.
  const [swapPrefill, setSwapPrefill] = useState<SwapPrefill | null>(null);
  const setMode = useCallback((next: WalletActionMode) => {
    setSwapPrefill(null);
    setModeState(next);
  }, []);
  // Called by the Spot token row's Swap action (#844).
  const setSwapFromSpot = useCallback((mint: string) => {
    setSwapPrefill({ mint, source: 'spot' });
    setModeState('swap');
  }, []);
  // The app view state (#771): no app is open until something dispatches
  // `select`, so the shell below never shows on screen for now.
  const [appView, appViewDispatch] = useReducer(walletAppViewReducer, initialWalletAppView);
  const [tradeBusy, setTradeBusy] = useState(false);
  const [upperHeight, setUpperHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [panelCovered, setPanelCovered] = useState(false);
  const coveredRef = useRef(false);
  // #843: pull-to-refresh stays mounted only while the panel is expanded and
  // its list is at the top; the collapsed rest point never mounts the control,
  // so a pull there cannot start a refresh and the drag between the two end
  // states is never competing with the native control.
  const [refreshAllowed, setRefreshAllowed] = useState(false);
  const refreshAllowedRef = useRef(false);
  const scrollY = useSharedValue(0);
  const accountScrollRef = useRef<Animated.ScrollView>(null);
  const wasActive = useRef(active);
  const previousSurfaceVersion = useRef(surfaceVersion);
  const { width } = useWindowDimensions();
  // The action body is one fixed frame in every mode and state (430px at
  // 390x844, issue #715); every mode's body is built to fit it (issue #803),
  // so the frame never scrolls its content — the ScrollView here stays only
  // as the amount field's keyboard container.

  const handlePanelCoveredChange = useCallback((covered: boolean) => {
    // The UI-thread reaction calls back only when the composer boundary changes.
    if (covered !== coveredRef.current) {
      coveredRef.current = covered;
      setPanelCovered(covered);
    }
  }, []);

  useEffect(() => {
    if (!active || !wasActive.current || previousSurfaceVersion.current !== surfaceVersion) {
      scrollY.value = 0;
      accountScrollRef.current?.scrollTo({ y: 0, animated: false });
      coveredRef.current = false;
      setPanelCovered(false);
    }
    wasActive.current = active;
    previousSurfaceVersion.current = surfaceVersion;
  }, [active, surfaceVersion, scrollY]);

  // "Wallet change resets it" (#771): the app view belongs to the wallet it
  // was opened from, and the Wallet's two embedded wallets are the two
  // chain addresses this surface already shows. The reducer bails out while
  // the id is unchanged, so repeated syncs never loop or reset.
  const walletId = `${chainAddress('solana') ?? ''}|${chainAddress('evm') ?? ''}`;
  useEffect(() => {
    appViewDispatch({ type: 'wallet-change', walletId });
  }, [walletId]);

  const panelRest = Math.max(0, upperHeight - color.panelOverlap);
  // Drag used to animate `top`, which resized this scroller on every frame and
  // made the sheet jump. translateY stays on the UI thread and the height stays put.
  const panelStyle = useAnimatedStyle(() => {
    const rest = Math.max(panelRest, 0);
    const progress = Math.min(1, Math.max(0, scrollY.value / Math.max(rest, 1)));
    return {
      transform: [{ translateY: -rest * progress }],
      borderTopLeftRadius: width * 0.14 * (1 - progress),
      borderTopRightRadius: width * 0.14 * (1 - progress),
    };
  }, [panelRest, width]);

  // Account content travels with the rising panel before scrolling normally.
  const panelLiftStyle = useAnimatedStyle(() => {
    // Keep the old interpolation's one-pixel range when panelRest is zero.
    // This matters during the first layout pass and compact keyboard layouts.
    const progress = Math.min(1, Math.max(0, scrollY.value / Math.max(panelRest, 1)));
    return {
      transform: [{
        translateY: panelRest * progress,
      }],
    };
  }, [panelRest]);

  useAnimatedReaction(
    () => panelRest > 0 && scrollY.value >= panelRest - 2,
    (covered, previous) => {
      // Android can stop within a fractional pixel of the animated scroll boundary.
      if (covered !== previous) {
        runOnJS(handlePanelCoveredChange)(covered);
      }
    },
    [panelRest],
  );

  const onAccountScroll = useAnimatedScrollHandler({
    // The scroll listener runs on the UI thread: useAnimatedScrollHandler is a
    // worklet, so a panel drag registers no per-frame JS callback (#843).
    onScroll: (event) => {
      scrollY.value = event.contentOffset.y;
    },
  });

  const handleRefreshGateChange = useCallback((allowed: boolean) => {
    // The UI-thread reaction calls back only when the gate boundary changes.
    if (allowed !== refreshAllowedRef.current) {
      refreshAllowedRef.current = allowed;
      setRefreshAllowed(allowed);
    }
  }, []);

  useAnimatedReaction(
    () => {
      // The gate is the scope's condition pair (#843): the panel is expanded
      // (scrollY has reached the lift boundary, like the covered reaction
      // above) and the list is at the top (it has not scrolled past the lift
      // range). Anywhere else — collapsed rest, mid-drag, scrolled content —
      // the control is unmounted and a pull-down starts nothing.
      // Android can stop within a fractional pixel of the animated scroll boundary.
      const expanded = panelRest > 0 && scrollY.value >= panelRest - 2;
      const atTop = scrollY.value <= panelRest + 2;
      return expanded && atTop;
    },
    (allowed, previous) => {
      if (allowed !== previous) {
        runOnJS(handleRefreshGateChange)(allowed);
      }
    },
    [panelRest],
  );
  const actionActive = active && !panelCovered;
  const showSolana = solanaConnected && chains.includes('solana');

  return (
    <View
      style={styles.wallet}
      onLayout={(event) => {
        const height = event.nativeEvent.layout.height;
        setViewportHeight((current) => rememberHeight(current, height));
      }}
    >
      <View
        collapsable={false}
        style={[styles.upper, panelCovered && { height: upperHeight }]}
        onLayout={(event) => {
          const height = event.nativeEvent.layout.height;
          setUpperHeight((current) => rememberHeight(current, height));
        }}
        pointerEvents={panelCovered ? 'none' : 'auto'}
        accessibilityElementsHidden={panelCovered}
        importantForAccessibility={panelCovered ? 'no-hide-descendants' : 'auto'}
      >
        <MemoModeSwitch mode={mode} locked={tradeBusy} onSelect={setMode} />
        <View style={styles.actionBody}>
          <ScrollView
            accessibilityElementsHidden={panelCovered}
            importantForAccessibility={panelCovered ? 'no-hide-descendants' : 'auto'}
            style={[styles.actionBodyScroll, panelCovered && { display: 'none' }]}
            scrollEnabled={false}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            showsVerticalScrollIndicator={false}
          >
            {/* Receive (#719) renders its QR card in the same fixed frame;
                anything signed stays on the swap composer. */}
            {mode === 'send' ? (
              <SendPanel solanaAddress={chainAddress('solana')} />
            ) : mode === 'receive' ? (
              <ReceivePanel
                solanaAddress={chainAddress('solana')}
                evmAddress={chainAddress('evm')}
                chains={chains}
              />
            ) : (
              <MemoActionPanel
                active={actionActive}
                controllerActive={active}
                surfaceKey={`${surfaceVersion}`}
                onBusyChange={setTradeBusy}
                swapPrefill={swapPrefill}
              />
            )}
          </ScrollView>
        </View>
      </View>

      <Animated.View
        style={[
          styles.panel,
          { top: panelRest, bottom: -panelRest },
          panelStyle,
          {
            opacity: upperHeight > 0 ? 1 : 0,
          },
        ]}
      >
        <Animated.ScrollView
          ref={accountScrollRef}
          style={styles.panelScroll}
          scrollEnabled={active && !tradeBusy}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          refreshControl={
            refreshAllowed ? (
              <RefreshControl
                refreshing={walletRefreshing}
                onRefresh={onWalletRefresh}
                tintColor={color.gold}
              />
            ) : undefined
          }
          onScroll={onAccountScroll}
          contentContainerStyle={{ minHeight: viewportHeight + panelRest }}
        >
          <Animated.View style={[styles.accounts, { paddingBottom: 24 + panelRest }, panelLiftStyle]}>
            {/* Portfolio table (#769): the only account list the Wallet shows. */}
            <PortfolioSection
              solana={chainAddress('solana')}
              evm={chainAddress('evm')}
              onOpenPolymarket={onOpenPolymarket}
              onOpenPhoenix={onOpenPhoenix}
              onOpenPacifica={onOpenPacifica}
              onOpenMeteora={onOpenMeteora}
              onSelectApp={(app) => appViewDispatch({ type: 'select', app })}
              onOpenSpot={onOpenSpot}
            />
            <AccountBody
              dormantNotices={dormantNotices}
              showSolana={showSolana}
              onConnect={onConnect}
              chains={chains}
              chainAddress={chainAddress}
              chainBalance={chainBalance}
              onDisconnectChain={onDisconnectChain}
            />
          </Animated.View>
        </Animated.ScrollView>
        {/* App view shell (#771) covers the Portfolio until back is pressed.
            The Meteora row selects it (#856); the other rows and the Map
            tiles follow later (#855, #857, #774, #871). */}
        {appView.selectedApp ? (
          <AppView
            app={appView.selectedApp}
            solana={chainAddress('solana')}
            evm={chainAddress('evm')}
            onBack={() => appViewDispatch({ type: 'back' })}
            style={styles.appViewOverlay}
          />
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wallet: { flex: 1, overflow: 'hidden', backgroundColor: color.gold },
  upper: { paddingHorizontal: color.composerInset, paddingBottom: 34, backgroundColor: color.gold },
  // One fixed action-frame height in every mode and state (issue #715).
  actionBody: { height: WALLET_ACTION_BODY_HEIGHT, overflow: 'hidden' },
  actionBodyScroll: { flex: 1 },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    overflow: 'hidden',
    backgroundColor: color.navy,
    boxShadow: '0 -6px 22px rgba(3,31,44,0.22), 0 -2px 6px rgba(3,31,44,0.15)',
  },
  panelScroll: { flex: 1 },
  accounts: { padding: 14, paddingBottom: 24, gap: 12 },
  disconnected: { paddingVertical: 14, gap: 12 },
  accountTitle: { color: color.text, fontSize: 17, fontWeight: '700' },
  description: { color: color.dim, fontSize: 14, lineHeight: 20 },
  connect: {
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.gold,
  },
  connectLabel: { color: color.navy, fontSize: 14, fontWeight: '700' },
  // App view shell (#771): fills the Portfolio panel while an app is open.
  appViewOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
});
