/**
 * Wallet app view shell (issue #771, design wallet.html "App view").
 *
 * The shell mounts over the Portfolio panel when an app is selected: a back
 * control that returns to the Portfolio list and the app's title. The app
 * view header (back control + title) sits over the app's content:
 * the top block, then for Meteora (#902) the shared Positions | Orders |
 * History tab row with its bodies. Nothing dispatches `select` yet (#856),
 * so the shell never shows on screen for now; the Meteora (#852) and
 * Phoenix (#848) app views carry their top blocks already.
 *
 * Generic by app id: today's ids are the Wallet protocol ids
 * (`WalletProtocolId`), and an unknown id falls back to the raw id for the
 * title so a future app cannot crash the shell.
 */

import { memo, useMemo, useState } from 'react';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { swapTheme as color } from '@/features/swap/swap.theme';
import {
  PortfolioTabBar,
  PortfolioTabBody,
  type PortfolioTabKey,
  type VenuePortfolioScreenTab,
} from '@/features/portfolio/VenuePortfolioScreen';
import { useWalletSummary } from '@/features/wallet/useWalletSummary';
import { MeteoraAppTop } from './MeteoraAppTop';
import { MeteoraPositionsTab } from './MeteoraPositionsTab';
import { PhoenixAppTop } from './PhoenixAppTop';
import { PhoenixOrdersTab } from './PhoenixOrdersTab';
import { PhoenixPositionsTab } from './PhoenixPositionsTab';
import { SpotTokenList } from './SpotTokenList';
import { usePhoenixOrders } from './usePhoenixOrders';
import { useMeteoraPositions } from './useMeteoraPositions';
import { usePerpPositions } from './usePerpPositions';
import type { WalletMeteoraPosition, WalletPerpPositionDetail } from '@myboon/shared/wallet-summary';

/** Display titles for the known Wallet apps; unknown ids fall back to the id. */
const APP_TITLES: Readonly<Record<string, string>> = {
  polymarket: 'Polymarket',
  phoenix: 'Phoenix',
  pacifica: 'Pacifica',
  meteora: 'Meteora',
  spot: 'Spot',
};

export function appViewTitle(app: string): string {
  return APP_TITLES[app] ?? app;
}

/**
 * The Meteora tab record (#902). Orders and History render through the
 * shared body with the issue's copy. The Positions rows are stubs for the
 * tab badge count (the number of loaded positions) only — the Positions tab
 * body is MeteoraPositionsTab, so they never reach PortfolioRowView.
 */
function meteoraTabs(positions: WalletMeteoraPosition[] | null): Record<PortfolioTabKey, VenuePortfolioScreenTab> {
  const stubRows = (positions ?? []).map((position, index) => ({
    key: `meteora-position-${index}`,
    title: position.poolName,
    value: '',
  }));
  return {
    positions: {
      status: positions === null ? 'loading' : 'ready',
      sections: [{ key: 'meteora-positions', rows: stubRows }],
    },
    orders: {
      status: 'ready',
      sections: [],
      empty: { title: 'No orders here', message: 'Liquidity positions do not use orders.' },
    },
    history: {
      status: 'ready',
      sections: [],
      empty: { title: 'No history', message: 'Not shown for this app yet.' },
    },
  };
}

/**
 * The Phoenix tab record (#849). Same shape as meteoraTabs: the Positions
 * rows are stubs for the badge count only; the Orders body is
 * PhoenixOrdersTab (#850) and History (#869) shows its note.
 */
function phoenixTabs(positions: WalletPerpPositionDetail[] | null): Record<PortfolioTabKey, VenuePortfolioScreenTab> {
  const stubRows = (positions ?? []).map((position, index) => ({
    key: `phoenix-position-${index}`,
    title: position.symbol,
    value: '',
  }));
  return {
    positions: {
      status: positions === null ? 'loading' : 'ready',
      sections: [{ key: 'phoenix-positions', rows: stubRows }],
    },
    orders: {
      status: 'ready',
      sections: [],
      empty: { title: 'No orders here', message: 'Not shown for this app yet.' },
    },
    history: {
      status: 'ready',
      sections: [],
      empty: { title: 'No history', message: 'Not shown for this app yet.' },
    },
  };
}

export const AppView = memo(function AppView({
  app,
  solana,
  evm,
  onBack,
  onSwapFromSpot,
  style,
}: {
  /** The selected app id; titles resolve from it so callers stay generic. */
  app: string;
  /** Wallet addresses for the app's summary call (#852). */
  solana: string | null;
  evm: string | null;
  /** Back to the Portfolio list (#771). */
  onBack: () => void;
  /** Spot token row's Swap (#844): fills the Swap pay card and selects Swap (#906). */
  onSwapFromSpot?: (mint: string) => void;
  /** Positioning from the mount point — the shell overlays the Portfolio. */
  style?: StyleProp<ViewStyle>;
}) {
  const [activeTab, setActiveTab] = useState<PortfolioTabKey>('positions');

  // The Meteora tabs' data (#902): one summary call for the pools, and the
  // positions hook (#901). Addresses are gated to the meteora view — the
  // shell is generic by app, so any other app leaves both hooks idle (no
  // calls). MeteoraAppTop keeps its own summary call (#852); the second
  // request is accepted for v1.
  const isMeteora = app === 'meteora';
  const { summary } = useWalletSummary(isMeteora ? solana : null, isMeteora ? evm : null);
  const { positions, loading, error, retry } = useMeteoraPositions(isMeteora ? solana : null);
  const pools = useMemo(() => summary?.apps.meteora.summary?.pools ?? [], [summary]);
  const tabs = useMemo(() => meteoraTabs(positions), [positions]);

  // The Phoenix tabs' data (#849): gated to the phoenix view like Meteora's.
  // Pacifica reuses the Phoenix view (#857): same components with a venue
  // prop; it has no orders route, so only Phoenix loads orders.
  const isPhoenix = app === 'phoenix';
  const isPerps = isPhoenix || app === 'pacifica';
  const perpVenue = app === 'pacifica' ? 'pacifica' : 'phoenix';
  const perp = usePerpPositions(perpVenue, isPerps ? solana : null);
  const phoenixOrders = usePhoenixOrders(isPhoenix ? solana : null);
  const phoenixTabRecord = useMemo(() => phoenixTabs(perp.positions), [perp.positions]);

  return (
    <View style={[styles.shell, style]}>
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to Portfolio"
          hitSlop={8}
          style={styles.back}
        >
          <MaterialIcons name="arrow-back" size={24} color={color.text} />
        </Pressable>
        <Text numberOfLines={1} accessibilityRole="header" style={styles.title}>
          {appViewTitle(app)}
        </Text>
      </View>
      {/* Meteora (#902): top block, then the shared tab row with its bodies —
          Positions through MeteoraPositionsTab, Orders and History through
          the shared body. Phoenix (#848) keeps its top block; the others
          follow. */}
      {app === 'meteora' ? (
        <ScrollView
          style={styles.meteoraScroll}
          contentContainerStyle={styles.meteoraContent}
          showsVerticalScrollIndicator={false}
        >
          <MeteoraAppTop solana={solana} evm={evm} />
          <PortfolioTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />
          {activeTab === 'positions' ? (
            <MeteoraPositionsTab positions={positions} loading={loading} error={error} retry={retry} pools={pools} />
          ) : (
            <PortfolioTabBody tabKey={activeTab} tab={tabs[activeTab]} />
          )}
        </ScrollView>
      ) : isPerps ? (
        <ScrollView
          style={styles.meteoraScroll}
          contentContainerStyle={styles.meteoraContent}
          showsVerticalScrollIndicator={false}
        >
          <PhoenixAppTop solana={solana} evm={evm} venue={perpVenue} />
          <PortfolioTabBar tabs={phoenixTabRecord} activeTab={activeTab} onChange={setActiveTab} />
          {activeTab === 'positions' ? (
            <PhoenixPositionsTab
              positions={perp.positions}
              loading={perp.loading}
              error={perp.error}
              retry={perp.retry}
              venue={perpVenue}
            />
          ) : activeTab === 'orders' && isPhoenix ? (
            <PhoenixOrdersTab
              orders={phoenixOrders.orders}
              loading={phoenixOrders.loading}
              error={phoenixOrders.error}
              retry={phoenixOrders.retry}
            />
          ) : (
            <PortfolioTabBody tabKey={activeTab} tab={phoenixTabRecord[activeTab]} />
          )}
        </ScrollView>
      ) : app === 'spot' && onSwapFromSpot ? (
        <SpotTokenList solana={solana} evm={evm} onSwap={onSwapFromSpot} />

      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  // Fills the surface the mount point gives it; the Wallet shell passes an
  // absolute fill over the Portfolio panel.
  shell: {
    flex: 1,
    backgroundColor: color.navy,
    paddingHorizontal: 14,
    paddingTop: 10,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  back: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: color.text, fontSize: 20, fontWeight: '600' },
  // The Meteora tabs scroll under the fixed header; the shell's horizontal
  // padding applies, and the content stacks with the Polymarket view's gap.
  meteoraScroll: { flex: 1 },
  meteoraContent: { gap: 12, paddingBottom: 40 },
});
