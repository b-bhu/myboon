import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { WalletActionPanel } from '@/features/wallet/WalletActionPanel';
import { WalletAccountRow } from '@/features/wallet/WalletAccountRow';
import { PerpsAccountRow } from '@/features/wallet/PerpsAccountRow';
import { ChainRow } from '@/features/wallet/components/ChainRow';
import { LegalLinks } from '@/features/wallet/components/LegalLinks';
import {
  type WalletProtocolId,
  type WalletSourcesState,
  type WalletTotals,
} from '@/features/wallet/wallet.types';

type AccountTab = 'spot' | 'perps' | 'meteora';
const accountTabs: { id: AccountTab; label: string }[] = [
  { id: 'spot', label: 'Spot' },
  { id: 'perps', label: 'Perps' },
  { id: 'meteora', label: 'Meteora' },
];

const MemoActionPanel = memo(WalletActionPanel);

function rememberHeight(current: number, next: number): number {
  return current === next ? current : next;
}

const AccountTabs = memo(function AccountTabs({
  accountTab,
  tradeBusy,
  onSelect,
}: {
  accountTab: AccountTab;
  tradeBusy: boolean;
  onSelect: (id: AccountTab) => void;
}) {
  return (
    <View style={styles.accountTabs}>
      {accountTabs.map(({ id, label }) => (
        <Pressable
          key={id}
          disabled={tradeBusy}
          accessibilityRole="tab"
          accessibilityLabel={`${label} accounts`}
          accessibilityState={{ selected: accountTab === id, disabled: tradeBusy }}
          onPress={() => onSelect(id)}
          style={[styles.accountTab, accountTab === id && styles.accountTabSelected]}
        >
          <Text style={[styles.accountLabel, accountTab === id && styles.accountLabelSelected]}>
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
});

const AccountBody = memo(function AccountBody({
  dormantNotices,
  showSolana,
  accountTab,
  walletSources,
  onRetrySource,
  onOpenSpot,
  onOpenPhoenix,
  onOpenPacifica,
  onOpenMeteora,
  onConnect,
  chains,
  chainAddress,
  chainBalance,
  onDisconnectChain,
}: {
  dormantNotices?: ReactNode;
  showSolana: boolean;
  accountTab: AccountTab;
  walletSources: WalletSourcesState;
  onRetrySource: (id: WalletProtocolId) => void;
  onOpenSpot: () => void;
  onOpenPhoenix: () => void;
  onOpenPacifica: () => void;
  onOpenMeteora: () => void;
  onConnect: () => void;
  chains: readonly Chain[];
  chainAddress: (chain: Chain) => string | null;
  chainBalance: (chain: Chain) => number | null;
  onDisconnectChain: (chain: Chain) => void;
}) {
  return (
    <>
      {dormantNotices}
      {showSolana ? (
        <>
          {accountTab === 'spot' ? (
            <WalletAccountRow
              protocol="spot"
              source={walletSources.spot}
              onRetry={onRetrySource}
              onPress={onOpenSpot}
            />
          ) : null}
          {accountTab === 'perps' ? (
            <>
              <PerpsAccountRow
                protocol="phoenix"
                source={walletSources.phoenix}
                onRetry={onRetrySource}
                onPress={onOpenPhoenix}
              />
              <PerpsAccountRow
                protocol="pacifica"
                source={walletSources.pacifica}
                onRetry={onRetrySource}
                onPress={onOpenPacifica}
              />
            </>
          ) : null}
          {accountTab === 'meteora' ? (
            <WalletAccountRow
              protocol="meteora"
              source={walletSources.meteora}
              onRetry={onRetrySource}
              onPress={onOpenMeteora}
            />
          ) : null}
        </>
      ) : (
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
  walletSources,
  onRetrySource,
  onOpenMeteora,
  onOpenPhoenix,
  onOpenPacifica,
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
  onOpenSpot: () => void;
  onConnect: () => void;
  dormantNotices?: React.ReactNode;
}) {
  const [accountTab, setAccountTab] = useState<AccountTab>('spot');
  const [surfaceKey, setSurfaceKey] = useState(0);
  const [tradeBusy, setTradeBusy] = useState(false);
  const [upperHeight, setUpperHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [composerContentHeight, setComposerContentHeight] = useState(0);
  const [panelCovered, setPanelCovered] = useState(false);
  const coveredRef = useRef(false);
  const scrollY = useSharedValue(0);
  const accountScrollRef = useRef<Animated.ScrollView>(null);
  const wasActive = useRef(active);
  const previousSurfaceVersion = useRef(surfaceVersion);
  const { width } = useWindowDimensions();
  const compactLayout = viewportHeight > 0 && composerContentHeight > viewportHeight - 120;

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

  const panelRest = Math.max(0, upperHeight - color.panelOverlap);
  const selectAccountTab = useCallback((id: AccountTab) => {
    setSurfaceKey((key) => key + 1);
    setAccountTab(id);
  }, []);
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
    onScroll: (event) => {
      scrollY.value = event.contentOffset.y;
    },
  });
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
        style={[styles.upper, compactLayout && { maxHeight: Math.max(34, viewportHeight - 96) }, panelCovered && { height: upperHeight }]}
        onLayout={(event) => {
          const height = event.nativeEvent.layout.height;
          setUpperHeight((current) => rememberHeight(current, height));
        }}
        pointerEvents={panelCovered ? 'none' : 'auto'}
        accessibilityElementsHidden={panelCovered}
        importantForAccessibility={panelCovered ? 'no-hide-descendants' : 'auto'}
      >
        <ScrollView
          accessibilityElementsHidden={panelCovered}
          importantForAccessibility={panelCovered ? 'no-hide-descendants' : 'auto'}
          style={[compactLayout && { maxHeight: Math.max(0, viewportHeight - 130) }, panelCovered && { display: 'none' }]}
          scrollEnabled={compactLayout}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={compactLayout}
          onContentSizeChange={(_, height) => {
            if (panelCovered) return;
            setComposerContentHeight((current) => rememberHeight(current, height));
          }}
        >
          <View onLayout={(event) => {
            if (panelCovered) return;
            const height = event.nativeEvent.layout.height;
            setComposerContentHeight((current) => rememberHeight(current, height));
          }}>
            <MemoActionPanel
              active={actionActive}
              controllerActive={active}
              surfaceKey={`${surfaceVersion}:${surfaceKey}:${accountTab}`}
              onBusyChange={setTradeBusy}
            />
          </View>
        </ScrollView>
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
          stickyHeaderIndices={[0]}
          refreshControl={
            <RefreshControl
              refreshing={walletRefreshing}
              onRefresh={onWalletRefresh}
              tintColor={color.gold}
            />
          }
          onScroll={onAccountScroll}
          contentContainerStyle={{ minHeight: viewportHeight + panelRest }}
        >
          <View style={styles.tabsHeader}>
            <AccountTabs accountTab={accountTab} tradeBusy={tradeBusy} onSelect={selectAccountTab} />
          </View>
          <Animated.View style={[styles.accounts, { paddingBottom: 24 + panelRest }, panelLiftStyle]}>
            <AccountBody
              dormantNotices={dormantNotices}
              showSolana={showSolana}
              accountTab={accountTab}
              walletSources={walletSources}
              onRetrySource={onRetrySource}
              onOpenSpot={onOpenSpot}
              onOpenPhoenix={onOpenPhoenix}
              onOpenPacifica={onOpenPacifica}
              onOpenMeteora={onOpenMeteora}
              onConnect={onConnect}
              chains={chains}
              chainAddress={chainAddress}
              chainBalance={chainBalance}
              onDisconnectChain={onDisconnectChain}
            />
          </Animated.View>
        </Animated.ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wallet: { flex: 1, overflow: 'hidden', backgroundColor: color.gold },
  upper: { paddingHorizontal: color.composerInset, paddingBottom: 34, backgroundColor: color.gold },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    overflow: 'hidden',
    backgroundColor: color.navy,
    boxShadow: '0 -6px 22px rgba(3,31,44,0.22), 0 -2px 6px rgba(3,31,44,0.15)',
  },
  panelScroll: { flex: 1 },
  tabsHeader: {
    paddingTop: 18,
    paddingBottom: 4,
    backgroundColor: color.navy,
    zIndex: 1,
  },
  accountTabs: {
    width: '80%',
    alignSelf: 'center',
    flexDirection: 'row',
    padding: 4,
    gap: 4,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.card,
  },
  accountTab: {
    flex: 1,
    minHeight: 44,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  accountTabSelected: { backgroundColor: color.gold },
  accountLabel: { color: color.dim, fontSize: 12, fontWeight: '600' },
  accountLabelSelected: { color: color.navy },
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
});
