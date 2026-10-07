import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SvgXml } from 'react-native-svg';
import { AppTopBarLogo } from '@/components/AppTopBar';
import { AvatarTrigger } from '@/components/AvatarTrigger';
import {
  KAMINO_MARK_SVG,
  METEORA_MARK_SVG,
  ORCA_MARK_SVG,
  PACIFICA_MARK_SVG,
  PHOENIX_MARK_SVG,
  POLYMARKET_MARK_SVG,
  RAYDIUM_MARK_SVG,
} from '@/features/home/marketBrandAssets';
import { HomeWalletOverview } from '@/features/wallet/HomeWalletOverview';
import { WalletSecondarySheet } from '@/features/wallet/WalletSecondarySheet';
import { HomeFeedOverview } from '@/features/home/components/HomeFeedOverview';
import { HomeNavigation, type HomeDestination } from '@/features/home/components/HomeNavigation';
import { DormantChainNotice } from '@/features/wallet/components/DormantChainNotice';
import {
  findFundedDormantChains,
  observeChains,
  reportFundedDormantChains,
} from '@/features/wallet/dormantBalance';
import { useWalletSheet } from '@/features/wallet/WalletSheetProvider';
import { useEvmBalance } from '@/features/wallet/useEvmBalance';
import { useProtocolAccounts } from '@/features/wallet/useProtocolAccounts';
import { usePolymarketWallet } from '@/hooks/usePolymarketWallet';
import { activeChains, useChainActivation } from '@/features/chain/activation';
import type { Chain } from '@/features/chain/chain.contract';
import { usePrivyEvmWallet } from '@/features/chain/usePrivyEvmWallet';
import { useWallet } from '@/hooks/useWallet';
import { semantic, tokens } from '@/theme';

const HEADER_SCROLL_DISTANCE = 920;
const MOCKUP_FEED_SOFT = '#28A9C9';

type MarketAppIcon = {
  xml: string;
  width: number;
  height: number;
};

type MarketHomeApp = {
  id: 'polymarket' | 'pacifica' | 'phoenix' | 'meteora' | 'orca' | 'raydium' | 'kamino';
  name: string;
  icon: MarketAppIcon;
  route?: '/markets/polymarket' | '/markets/pacifica' | '/markets/phoenix' | '/markets/meteora';
};

const MARKET_APPS: MarketHomeApp[] = [
  {
    id: 'polymarket',
    name: 'Polymarket',
    icon: { xml: POLYMARKET_MARK_SVG, width: 46, height: 50 },
    route: '/markets/polymarket',
  },
  {
    id: 'pacifica',
    name: 'Pacifica',
    icon: { xml: PACIFICA_MARK_SVG, width: 52, height: 52 },
    route: '/markets/pacifica',
  },
  {
    id: 'phoenix',
    name: 'Phoenix',
    icon: { xml: PHOENIX_MARK_SVG, width: 46, height: 50 },
    route: '/markets/phoenix',
  },
  {
    id: 'meteora',
    name: 'Meteora',
    icon: { xml: METEORA_MARK_SVG, width: 52, height: 52 },
    route: '/markets/meteora',
  },
  {
    id: 'orca',
    name: 'Orca',
    icon: { xml: ORCA_MARK_SVG, width: 54, height: 54 },
  },
  {
    id: 'raydium',
    name: 'Raydium',
    icon: { xml: RAYDIUM_MARK_SVG, width: 46, height: 52 },
  },
  {
    id: 'kamino',
    name: 'Kamino',
    icon: { xml: KAMINO_MARK_SVG, width: 56, height: 24 },
  },
];

function mixHex(start: string, end: string, amount: number): string {
  const normalize = (hex: string) => hex.replace('#', '');
  const startHex = normalize(start);
  const endHex = normalize(end);

  const channels = [0, 2, 4].map((index) => {
    const from = Number.parseInt(startHex.slice(index, index + 2), 16);
    const to = Number.parseInt(endHex.slice(index, index + 2), 16);
    return Math.round(from + (to - from) * amount)
      .toString(16)
      .padStart(2, '0');
  });

  return `#${channels.join('')}`;
}

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const [destination, setDestination] = useState<HomeDestination>('feed');
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [surfaceVersion, setSurfaceVersion] = useState(0);
  const scrollY = useRef(new Animated.Value(0)).current;
  const wallet = useWallet();
  const evm = usePrivyEvmWallet();
  // Restores the single mobile-owned SecureClient for previously enabled
  // accounts, so app restarts do not depend on an API-held trading session.
  const polymarket = usePolymarketWallet();
  const { balanceUsd: evmBalanceUsd } = useEvmBalance(evm.address, polymarket.client);
  const { activation, activate } = useChainActivation();
  const connectSheet = useWalletSheet();
  const walletAddress = wallet.connected ? wallet.address : null;
  const {
    totals: walletTotals,
    sources: walletSources,
    notifyVisibility,
    refreshAll: refreshWallet,
    retrySource: retryWalletSource,
  } = useProtocolAccounts(walletAddress);
  const walletSectionVisible = focused && destination === 'wallet';
  const [walletRefreshing, setWalletRefreshing] = useState(false);

  const backgroundColor = scrollY.interpolate({
    inputRange: [0, HEADER_SCROLL_DISTANCE],
    outputRange: [
      mixHex(tokens.colors.backgroundDark, MOCKUP_FEED_SOFT, 0.32),
      tokens.colors.walletCore,
    ],
    extrapolate: 'clamp',
  });

  useEffect(() => {
    notifyVisibility(walletSectionVisible);
  }, [walletSectionVisible, notifyVisibility]);

  const handleWalletRefresh = useCallback(() => {
    setWalletRefreshing(true);
    refreshWallet();
    // Purely visual — sources resolve independently and asynchronously; this
    // just gives the tap a brief acknowledgement rather than tracking every
    // source's settle.
    setTimeout(() => setWalletRefreshing(false), 700);
  }, [refreshWallet]);

  const handleMarketAppPress = useCallback(
    (app: MarketHomeApp) => {
      if (!app.route) return;
      router.push(app.route);
    },
    [router],
  );

  /**
   * The Wallet surface forks on *activation*, not on `wallet.connected`.
   * A user who logged in through an EVM application has an active EVM chain and
   * a dormant Solana one, and must see EVM only — forking on the Solana
   * accessor would have shown them nothing (spec, "Dormancy").
   */
  const chains = activeChains(activation);

  const chainAddress = useCallback(
    (chain: Chain): string | null =>
      chain === 'solana' ? (wallet.connected ? wallet.address : null) : evm.address,
    [wallet.connected, wallet.address, evm.address],
  );

  // Solana is the combined protocol total; EVM is USDC collateral on Polygon.
  // Null means unknown — still loading, or the read failed — and renders the
  // unavailable marker rather than a zero we did not measure.
  const chainBalance = useCallback(
    (chain: Chain): number | null => (chain === 'solana' ? walletTotals.totalUsd : evmBalanceUsd),
    [walletTotals.totalUsd, evmBalanceUsd],
  );

  // Only chains with a real address render. An active chain whose wallet has not
  // hydrated yet is omitted rather than shown with a placeholder address.
  const displayChains = chains.filter((chain) => chainAddress(chain) !== null);

  /**
   * Safety net for a chain that was provisioned without the user asking and is
   * holding funds. Deferred provisioning means this cannot happen — a dormant
   * chain has no wallet and no address — so anything found here is a
   * provisioning bug, not an expected state (spec, "Dormancy").
   *
   * Provisioning is only *observed* here: `wallet.connected` and
   * `evm.isProvisioned` are already read above for rendering. Nothing on this
   * path calls `create()`, so checking cannot itself provision a chain.
   *
   * EVM's balance is null because no client-side EVM balance source exists yet
   * (#261), so an EVM entry can never qualify today — a fabricated zero would
   * assert the funded case away rather than detect it. Solana works.
   */
  const fundedDormantChains = useMemo(
    () =>
      findFundedDormantChains(
        observeChains({
          activation,
          provisioned: {
            solana: wallet.connected && !!wallet.address,
            evm: evm.isProvisioned && !!evm.address,
          },
          addresses: {
            solana: wallet.connected ? wallet.address : null,
            evm: evm.address,
          },
          balancesUsd: {
            solana: walletTotals.totalUsd,
            evm: evmBalanceUsd,
          },
        }),
      ),
    [
      activation,
      wallet.connected,
      wallet.address,
      evm.isProvisioned,
      evm.address,
      walletTotals.totalUsd,
      evmBalanceUsd,
    ],
  );

  // Log on transition into the funded-dormant state rather than every render, so
  // a regression is one visible line per chain instead of scroll-rate noise.
  const reportedDormantRef = useRef<string>('');
  useEffect(() => {
    const key = fundedDormantChains
      .map((entry) => entry.chain)
      .sort()
      .join(',');
    if (key === reportedDormantRef.current) return;
    reportedDormantRef.current = key;
    if (fundedDormantChains.length > 0) reportFundedDormantChains(fundedDormantChains);
  }, [fundedDormantChains]);

  const handleActivateDormantChain = useCallback(
    (chain: Chain) => {
      // Activating moves the chain into `activeChains`, so its balance renders in
      // the normal ChainRow and this notice stops matching.
      void activate(chain);
    },
    [activate],
  );

  /**
   * Disconnect goes through the wallet sheet, which owns the confirmation step.
   *
   * It deliberately does not use `Alert.alert`: that renders nothing on React
   * Native Web, so a confirm-then-act flow built on it silently never acts.
   */
  const handleDisconnectChain = useCallback(
    (chain: Chain) => {
      Keyboard.dismiss();
      setSurfaceVersion((key) => key + 1);
      connectSheet.open(chain);
    },
    [connectSheet],
  );

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {focused ? <StatusBar style={destination === 'wallet' ? 'dark' : 'light'} /> : null}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: destination === 'wallet' ? tokens.colors.primaryDim : backgroundColor,
          },
        ]}
      />
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 4 },
          destination === 'wallet' && { backgroundColor: tokens.colors.primaryDim },
        ]}
      >
        <AppTopBarLogo
          tintColor={destination === 'wallet' ? tokens.colors.walletCore : undefined}
        />
        <View style={styles.headerSpacer} />
        <Pressable
          style={styles.headerAction}
          accessibilityRole="button"
          accessibilityLabel="Notifications"
          onPress={() => {
            Keyboard.dismiss();
            setSurfaceVersion((key) => key + 1);
            setNotificationsOpen(true);
          }}
        >
          <MaterialIcons
            name="notifications-none"
            size={24}
            color={destination === 'wallet' ? tokens.colors.walletCore : semantic.text.primary}
          />
        </Pressable>
        <AvatarTrigger
          tone={destination === 'wallet' ? 'wallet' : undefined}
          onBeforeOpen={() => {
            Keyboard.dismiss();
            setSurfaceVersion((key) => key + 1);
          }}
        />
      </View>

      <View style={[styles.destination, destination !== 'feed' && styles.hiddenDestination]}>
        <HomeFeedOverview
          active={focused && destination === 'feed'}
          onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: false })}
          bottomPadding={Math.max(insets.bottom, 18) + 24}
        />
      </View>

      <View style={[styles.destination, destination !== 'apps' && styles.hiddenDestination]}>
        <Animated.ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.content, { paddingBottom: 24 }]}
        >
          <HomeSectionTitle title="Apps" />
          <MarketsHomeLauncher apps={MARKET_APPS} onAppPress={handleMarketAppPress} />
        </Animated.ScrollView>
      </View>

      <View style={[styles.destination, destination !== 'wallet' && styles.hiddenDestination]}>
          <HomeWalletOverview
            active={walletSectionVisible}
            surfaceVersion={surfaceVersion}
            chains={displayChains}
            chainAddress={chainAddress}
            chainBalance={chainBalance}
            solanaConnected={wallet.connected}
            onDisconnectChain={handleDisconnectChain}
            walletTotals={walletTotals}
            walletSources={walletSources}
            walletRefreshing={walletRefreshing}
            onWalletRefresh={handleWalletRefresh}
            onRetrySource={retryWalletSource}
            onOpenMeteora={() => router.push('/markets/meteora/profile')}
            onOpenPhoenix={() => router.push('/markets/phoenix/profile')}
            onOpenPacifica={() => router.push('/markets/pacifica/profile')}
            onOpenSpot={() => router.push('/spot' as never)}
            onConnect={() => {
              Keyboard.dismiss();
              setSurfaceVersion((key) => key + 1);
              connectSheet.open('solana');
            }}
            dormantNotices={fundedDormantChains.map((entry) => (
              <DormantChainNotice
                key={entry.chain}
                chain={entry.chain}
                balanceUsd={entry.balanceUsd}
                onActivate={handleActivateDormantChain}
              />
            ))}
          />
      </View>
      <HomeNavigation
        selected={destination}
        bottomInset={insets.bottom}
        onSelect={(next) => {
          Keyboard.dismiss();
          setSurfaceVersion((key) => key + 1);
          setDestination(next);
        }}
      />
      <WalletSecondarySheet
        visible={focused && notificationsOpen}
        title="Notifications"
        onClose={() => setNotificationsOpen(false)}
      >
        <Text style={styles.notificationText}>Notifications are not available yet.</Text>
      </WalletSecondarySheet>

    </KeyboardAvoidingView>
  );
}

function HomeSectionTitle({ title }: { title: string }) {
  return (
    <View style={styles.sectionHead}>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function MarketsHomeLauncher({
  apps,
  onAppPress,
}: {
  apps: MarketHomeApp[];
  onAppPress: (app: MarketHomeApp) => void;
}) {
  return (
    <View style={styles.marketsLauncher}>
      <View style={styles.marketAppGrid}>
        {apps.map((app) => (
          <MarketAppTile key={app.id} app={app} onPress={() => onAppPress(app)} />
        ))}
      </View>
    </View>
  );
}

function MarketAppTile({ app, onPress }: { app: MarketHomeApp; onPress: () => void }) {
  const disabled = !app.route;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={disabled ? `${app.name} unavailable` : `Open ${app.name}`}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.marketAppTile,
        disabled && styles.marketAppTileDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <View style={styles.marketAppIcon}>
        <MarketAppBrandIcon icon={app.icon} />
      </View>
      <Text style={styles.marketAppName} numberOfLines={1}>
        {app.name}
      </Text>
    </Pressable>
  );
}

function MarketAppBrandIcon({ icon }: { icon: MarketAppIcon }) {
  return <SvgXml xml={icon.xml} width={icon.width} height={icon.height} />;
}

const styles = StyleSheet.create({
  destination: { flex: 1 },
  hiddenDestination: { display: 'none' },
  walletContent: { flexGrow: 1, backgroundColor: tokens.colors.walletCore },
  headerAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  notificationText: { color: semantic.text.dim, fontSize: 14, lineHeight: 20 },
  screen: {
    flex: 1,
    backgroundColor: '#010B12',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: 6,
  },
  headerSpacer: {
    flex: 1,
  },
  content: {
    paddingHorizontal: tokens.spacing.lg,
  },
  sectionHead: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionTitle: {
    color: semantic.text.primary,
    fontSize: 54,
    lineHeight: 56,
    fontWeight: '800',
    letterSpacing: 0,
  },
  marketsLauncher: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(24,90,112,0.78)',
    backgroundColor: 'rgba(6,51,67,0.62)',
    padding: 10,
  },
  marketAppGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
  },
  marketAppTile: {
    flexBasis: '31%',
    flexGrow: 1,
    minWidth: 0,
    minHeight: 128,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(24,90,112,0.74)',
    backgroundColor: 'rgba(3,31,44,0.46)',
    paddingHorizontal: 8,
    paddingVertical: 14,
    gap: 11,
  },
  marketAppTileDisabled: {
    opacity: 0.58,
  },
  marketAppIcon: {
    width: 70,
    height: 70,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(245,250,252,0.10)',
    backgroundColor: 'rgba(1,11,18,0.34)',
  },
  marketAppName: {
    color: semantic.text.primary,
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '800',
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.82,
  },
});
