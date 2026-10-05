import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { Chain } from '@/features/chain/chain.contract';
import { swapTheme as color } from '@/features/swap/swap.theme';
import { WalletActionPanel } from '@/features/wallet/WalletActionPanel';
import { WalletSecondarySheet } from '@/features/wallet/WalletSecondarySheet';
import { WalletHero } from '@/features/wallet/WalletHero';
import { WalletAccountRow } from '@/features/wallet/WalletAccountRow';
import { PerpsAccountRow } from '@/features/wallet/PerpsAccountRow';
import { ChainRow } from '@/features/wallet/components/ChainRow';
import {
  WALLET_PROTOCOL_IDS,
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

export function HomeWalletOverview({
  active,
  surfaceVersion,
  chains,
  chainAddress,
  chainBalance,
  solanaConnected,
  onDisconnectChain,
  walletTotals,
  walletSources,
  walletRefreshing,
  onWalletRefresh,
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
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [surfaceKey, setSurfaceKey] = useState(0);
  const [tradeBusy, setTradeBusy] = useState(false);
  const { width } = useWindowDimensions();
  useEffect(() => {
    if (!active) setPortfolioOpen(false);
  }, [active]);
  const showSolana = solanaConnected && chains.includes('solana');
  const hasAnyResolved = WALLET_PROTOCOL_IDS.some(
    (id) => walletSources[id].valueUsd !== null && walletSources[id].resolvedAt !== null,
  );
  const total =
    showSolana && hasAnyResolved && walletTotals.totalUsd !== null
      ? walletTotals.totalUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
      : null;

  const chainRows = chains.map((chain) => {
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
  });

  return (
    <View style={styles.wallet}>
      <View style={styles.upper}>
        <WalletActionPanel
          active={active}
          surfaceKey={`${surfaceVersion}:${surfaceKey}:${accountTab}:${portfolioOpen}`}
          onBusyChange={setTradeBusy}
        />
        <Pressable
          style={styles.portfolio}
          disabled={tradeBusy}
          accessibilityRole="button"
          accessibilityLabel="Open portfolio and account details"
          accessibilityState={{ disabled: tradeBusy }}
          onPress={() => {
            setSurfaceKey((key) => key + 1);
            setPortfolioOpen(true);
          }}
        >
          <Text style={styles.portfolioLabel}>Portfolio · Solana</Text>
          <View style={styles.portfolioValue}>
            <Text selectable style={styles.total}>
              {total ?? (showSolana ? 'Unavailable' : 'Connect Solana')}
            </Text>
            <MaterialIcons name="north-east" size={18} color={color.navy} />
          </View>
        </Pressable>
      </View>

      {/* 14% of the actual panel width gives the reference curvature without CSS percentage radii. */}
      <View
        style={[
          styles.panel,
          { borderTopLeftRadius: width * 0.14, borderTopRightRadius: width * 0.14 },
        ]}
      >
        <View style={styles.accountTabs}>
          {accountTabs.map(({ id, label }) => (
            <Pressable
              key={id}
              accessibilityRole="tab"
              accessibilityLabel={`${label} accounts`}
              accessibilityState={{ selected: accountTab === id }}
              onPress={() => {
                setSurfaceKey((key) => key + 1);
                setAccountTab(id);
              }}
              style={[styles.accountTab, accountTab === id && styles.accountTabSelected]}
            >
              <Text style={[styles.accountLabel, accountTab === id && styles.accountLabelSelected]}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.accounts}>
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
          {chainRows}
        </View>
      </View>

      <WalletSecondarySheet
        visible={active && portfolioOpen}
        title="Portfolio and accounts"
        onClose={() => setPortfolioOpen(false)}
      >
        {showSolana ? (
          <WalletHero
            totals={walletTotals}
            hasAnyResolved={hasAnyResolved}
            isRefreshing={walletRefreshing}
            onRefresh={onWalletRefresh}
          />
        ) : null}
        {chainRows}
        {!showSolana ? (
          <Pressable
            style={styles.connect}
            onPress={() => {
              setPortfolioOpen(false);
              onConnect();
            }}
            accessibilityRole="button"
            accessibilityLabel="Connect Solana wallet"
          >
            <Text style={styles.connectLabel}>Connect Solana</Text>
          </Pressable>
        ) : null}
      </WalletSecondarySheet>
    </View>
  );
}

const styles = StyleSheet.create({
  wallet: { backgroundColor: color.gold },
  upper: { paddingHorizontal: color.composerInset, paddingBottom: 34, backgroundColor: color.gold },
  portfolio: {
    minHeight: 52,
    borderTopWidth: 1,
    borderTopColor: 'rgba(3,31,44,0.2)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
    paddingVertical: 5,
  },
  portfolioLabel: { fontSize: 12, color: color.navy },
  portfolioValue: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  total: { color: color.navy, fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  panel: {
    minHeight: 340,
    marginTop: -color.panelOverlap,
    paddingTop: 18,
    paddingBottom: 24,
    backgroundColor: color.navy,
    boxShadow: '0 -6px 22px rgba(3,31,44,0.22), 0 -2px 6px rgba(3,31,44,0.15)',
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
  accounts: { padding: 14, gap: 12 },
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
