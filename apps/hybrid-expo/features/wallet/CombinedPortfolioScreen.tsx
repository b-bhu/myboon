/**
 * Combined portfolio — one screen answering "what do I hold?" across every
 * venue (issue #653, D1).
 *
 * Reads `useProtocolAccounts`, which already fetches each venue independently
 * with its own loading, failure and retry state, so one slow or broken venue
 * never blocks the others. This screen adds no fetching of its own.
 *
 * Deliberately does NOT delete or reroute the four existing per-venue profile
 * screens — tapping a venue group opens that venue's current profile. The
 * scoped per-venue view with its three tabs is D2 (#657).
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppTopBar, AppTopBarIconButton } from '@/components/AppTopBar';
import { DiscoveryStateCard } from '@/features/discovery/DiscoveryStateCard';
import { useProtocolAccounts } from '@/features/wallet/useProtocolAccounts';
import { useWalletSheet } from '@/features/wallet/WalletSheetProvider';
import {
  WALLET_PROTOCOL_IDS,
  type PredictionRowDetail,
  type WalletProtocolId,
  type WalletSourceState,
} from '@/features/wallet/wallet.types';
import { useWallet } from '@/hooks/useWallet';
import { semantic, tokens } from '@/theme';

/** Display name and the venue profile a group opens. Spot has no venue profile. */
const VENUES: Record<WalletProtocolId, { label: string; href: string | null }> = {
  spot: { label: 'Spot', href: '/spot' },
  phoenix: { label: 'Phoenix', href: '/markets/phoenix/profile' },
  pacifica: { label: 'Pacifica', href: '/markets/pacifica/profile' },
  meteora: { label: 'Meteora', href: '/markets/meteora/profile' },
  polymarket: { label: 'Polymarket', href: '/markets/polymarket/profile' },
};

function formatUsd(value: number | null): string {
  if (value === null) return '--';
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** One row per position/holding inside a venue group, worded by that venue. */
function GroupRows({ id, source }: { id: WalletProtocolId; source: WalletSourceState }) {
  const detail = source.detail;
  if (!detail) return null;

  if (id === 'polymarket') {
    const prediction = detail as PredictionRowDetail;
    if (prediction.pills.length === 0) return null;
    return (
      <View style={styles.rows}>
        {prediction.pills.map((pill) => (
          <View style={styles.row} key={pill.title}>
            <Text style={styles.rowTitle} numberOfLines={1}>{pill.title}</Text>
            <Text style={styles.rowValue}>{formatUsd(pill.valueUsd)}</Text>
          </View>
        ))}
        {prediction.readyToCollect !== undefined && prediction.readyToCollect > 0 ? (
          <View style={styles.row}>
            <Text style={[styles.rowTitle, styles.rowTitleAccent]}>Ready to collect</Text>
            <Text style={[styles.rowValue, styles.rowValueAccent]}>
              {formatUsd(prediction.readyToCollect)}
            </Text>
          </View>
        ) : null}
      </View>
    );
  }

  if ('pills' in detail && Array.isArray(detail.pills)) {
    // Phoenix / Pacifica perps pills carry a symbol, side and unrealized PnL.
    const pills = detail.pills as { symbol: string; side: string; unrealizedPnl: number }[];
    if (pills.length === 0) return null;
    return (
      <View style={styles.rows}>
        {pills.map((pill) => (
          <View style={styles.row} key={`${pill.symbol}-${pill.side}`}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {pill.symbol} <Text style={styles.rowSide}>{pill.side.toUpperCase()}</Text>
            </Text>
            <Text
              style={[
                styles.rowValue,
                pill.unrealizedPnl < 0 ? styles.negative : styles.positive,
              ]}
            >
              {formatUsd(pill.unrealizedPnl)}
            </Text>
          </View>
        ))}
      </View>
    );
  }

  return null;
}

function VenueGroup({
  id,
  source,
  onRetry,
}: {
  id: WalletProtocolId;
  source: WalletSourceState;
  onRetry: (id: WalletProtocolId) => void;
}) {
  const router = useRouter();
  const venue = VENUES[id];
  const hasValue = source.valueUsd !== null && source.resolvedAt !== null;

  const open = useCallback(() => {
    if (venue.href) router.push(venue.href as never);
  }, [router, venue.href]);

  // A venue the user has not connected sits idle with nothing to show. Render
  // nothing rather than an empty group or an error they cannot act on. This
  // sits after the hooks above so hook order stays stable across renders.
  if (source.status === 'idle') return null;

  return (
    <Pressable
      style={styles.group}
      onPress={open}
      disabled={!venue.href}
      accessibilityRole={venue.href ? 'button' : undefined}
      accessibilityLabel={venue.href ? `Open ${venue.label}` : venue.label}
    >
      <View style={styles.groupHead}>
        <View style={styles.groupName}>
          <View style={[styles.dot, { backgroundColor: tokens.walletBrand[id] }]} />
          <Text style={styles.groupLabel}>{venue.label}</Text>
          {source.status === 'stale' ? <Text style={styles.staleTag}>stale</Text> : null}
        </View>
        <View style={styles.groupRight}>
          {hasValue ? (
            <Text style={styles.groupValue}>{formatUsd(source.valueUsd)}</Text>
          ) : source.status === 'loading' ? (
            <ActivityIndicator size="small" color={semantic.text.accentDim} />
          ) : null}
          {venue.href ? (
            <MaterialIcons name="chevron-right" size={18} color={semantic.text.faint} />
          ) : null}
        </View>
      </View>

      {/* A venue that failed before ever resolving gets its own inline retry —
          the other groups keep rendering regardless. */}
      {source.status === 'failed' && !hasValue ? (
        <View style={styles.groupError}>
          <Text style={styles.groupErrorText} numberOfLines={2}>
            {source.error ?? 'Unable to load'}
          </Text>
          <Pressable
            onPress={() => onRetry(id)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Retry ${venue.label}`}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <GroupRows id={id} source={source} />
      )}
    </Pressable>
  );
}

export function CombinedPortfolioScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const wallet = useWallet();
  const walletSheet = useWalletSheet();
  const { sources, totals, totalIsPartial, notifyVisibility, refreshAll, retrySource } =
    useProtocolAccounts(wallet.address);

  // This screen is the whole viewport, so it is visible as soon as it mounts —
  // the hook gates fetching on visibility for Home's scroll, not here.
  useEffect(() => {
    notifyVisibility(true);
    return () => notifyVisibility(false);
  }, [notifyVisibility]);

  const anyLoading = useMemo(
    () => WALLET_PROTOCOL_IDS.some((id) => sources[id].status === 'loading'),
    [sources],
  );
  const anyShown = useMemo(
    () => WALLET_PROTOCOL_IDS.some((id) => sources[id].status !== 'idle'),
    [sources],
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
        left={
          <AppTopBarIconButton
            icon="arrow-back"
            onPress={() => router.back()}
            accessibilityLabel="Back"
          />
        }
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={anyLoading}
            onRefresh={refreshAll}
            tintColor={semantic.text.accentDim}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.label}>Portfolio</Text>

        {!wallet.address ? (
          <DiscoveryStateCard
            title="Connect a wallet to see your portfolio"
            icon={{ name: 'account-balance-wallet', size: 23, color: semantic.text.accentDim }}
            containerStyle={styles.stateCard}
            titleStyle={styles.stateTitle}
          />
        ) : (
          <>
            <View style={styles.totalCard}>
              <Text style={styles.meta}>
                {totalIsPartial ? 'Account value (partial)' : 'Account value'}
              </Text>
              <Text style={styles.total}>{formatUsd(totals.totalUsd)}</Text>
              {totalIsPartial ? (
                <Text style={styles.metaWarn}>
                  One or more venues are still loading or unavailable — this total is a lower bound.
                </Text>
              ) : null}
            </View>

            {/* Always visible, not behind a menu (#653). The flows themselves
                are unchanged — both open the app's existing wallet sheet,
                which is how every other screen reaches deposit and withdraw. */}
            <View style={styles.actions}>
              {(['Deposit', 'Withdraw'] as const).map((action) => (
                <Pressable
                  key={action}
                  style={styles.action}
                  accessibilityRole="button"
                  accessibilityLabel={action}
                  onPress={() => walletSheet.open('solana')}
                >
                  <Text style={styles.actionText}>{action}</Text>
                </Pressable>
              ))}
            </View>

            {anyShown ? (
              WALLET_PROTOCOL_IDS.map((id) => (
                <VenueGroup key={id} id={id} source={sources[id]} onRetry={retrySource} />
              ))
            ) : (
              <DiscoveryStateCard
                title="No positions yet"
                message="Positions across Spot, perps, pools and prediction markets will appear here."
                icon={{ name: 'inbox', size: 23, color: semantic.text.accentDim }}
                containerStyle={styles.stateCard}
                titleStyle={styles.stateTitle}
                messageStyle={styles.stateText}
              />
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.background.screen },
  content: { padding: 14, paddingBottom: 32, gap: 12 },
  label: {
    color: semantic.text.dim,
    fontSize: 11,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    fontWeight: '700',
  },
  totalCard: {
    backgroundColor: semantic.background.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: semantic.border.muted,
    borderRadius: 6,
    padding: 14,
    gap: 4,
  },
  total: {
    color: semantic.text.primary,
    fontSize: 30,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  meta: { color: semantic.text.faint, fontSize: 11 },
  metaWarn: { color: semantic.text.dim, fontSize: 11, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 8 },
  action: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.lift,
  },
  actionText: { color: semantic.text.primary, fontSize: 13, fontWeight: '600' },
  group: {
    backgroundColor: semantic.background.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: semantic.border.muted,
    borderRadius: 6,
    padding: 12,
    gap: 8,
  },
  groupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  groupName: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  groupLabel: { color: semantic.text.primary, fontSize: 13, fontWeight: '700' },
  staleTag: { color: semantic.text.faint, fontSize: 10, textTransform: 'uppercase' },
  groupRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  groupValue: {
    color: semantic.text.primary,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  rows: { gap: 5, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: semantic.border.muted, paddingTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  rowTitle: { color: semantic.text.dim, fontSize: 12, flexShrink: 1 },
  rowTitleAccent: { color: tokens.colors.accent },
  rowSide: { color: semantic.text.faint, fontSize: 10 },
  rowValue: { color: semantic.text.primary, fontSize: 12, fontVariant: ['tabular-nums'] },
  rowValueAccent: { color: tokens.colors.accent },
  positive: { color: semantic.sentiment.positive },
  negative: { color: semantic.sentiment.negative },
  groupError: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.border.muted,
    paddingTop: 8,
  },
  groupErrorText: { color: semantic.sentiment.negative, fontSize: 11, flexShrink: 1 },
  retryText: { color: tokens.colors.accent, fontSize: 12, fontWeight: '600' },
  stateCard: {
    alignItems: 'center',
    gap: 6,
    padding: 20,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
  },
  stateTitle: { color: semantic.text.primary, fontSize: 13, fontWeight: '600', textAlign: 'center' },
  stateText: { color: semantic.text.dim, fontSize: 12, textAlign: 'center' },
});
