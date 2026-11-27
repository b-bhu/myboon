/**
 * Wallet app view — Meteora top block (issue #852, design wallet.html frame
 * "Meteora · Positions", "Top block" / AppStats).
 *
 * Three cells under the app view header: "Pool value", "Unclaimed fees" and
 * "Total P&L", from the Meteora slot of the wallet summary with
 * meteora-top.ts. The view makes its own useWalletSummary call — the server
 * caches the summary (#764), so the Portfolio's first call and this second
 * one are both accepted.
 *
 * States (issue #865): loading with no summary yet → a skeleton block, no
 * numbers. Failed with no summary, or the Meteora slot unavailable with no
 * value → "Couldn't load Meteora" with the funds-are-safe line and a gold
 * Retry that calls the hook's retry, cells showing NO_DATA. A retry from a
 * failed state keeps the banner and the dashes — the skeleton is only the
 * first load — and shows a small spinner on the button while it runs. A
 * refresh failing after a good summary keeps the last figures on screen,
 * dimmed (design ".held" 60%), under the shared "Updating Meteora" banner
 * with the held numbers' age (AppUpdatingBanner, #864) — never blanked.
 */

import { memo } from 'react';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useWalletSummary } from '@/features/wallet/useWalletSummary';
import { semantic, tokens } from '@/theme';
import { NO_DATA } from '@/lib/format';
import { meteoraTopFigures } from './meteora-top';
import { appIsStale, staleAgeText } from './app-stale';
import { AppUpdatingBanner } from './AppUpdatingBanner';

export const MeteoraAppTop = memo(function MeteoraAppTop({
  solana,
  evm,
}: {
  /** Solana address behind Meteora (chainAddress('solana'), #852). */
  solana: string | null;
  /** EVM address the summary route expects; unused by Meteora itself. */
  evm: string | null;
}) {
  const { summary, loading, error, retry } = useWalletSummary(solana, evm);

  // One retry at a time: tapping Retry while a retry runs does nothing.
  const retryOnce = () => {
    if (loading) return;
    retry();
  };

  // No addresses at all: the hook made no call, nothing to show.
  if (!summary && !loading && error === null) return null;

  // Loading with no summary yet and no error yet: the first load — skeleton
  // cells, no numbers. A retry from a failed state keeps the banner and the
  // dashes instead (#865).
  if (!summary && loading && error === null) return <Skeleton />;

  const meteora = summary?.apps.meteora ?? null;

  // Not connected: no account at the venue, render nothing.
  if (meteora?.status === 'not_connected') return null;

  // Failed with no summary (the hook returned an error and nothing else),
  // or the Meteora slot itself failing with no value to show: the same
  // banner over NO_DATA cells as the Phoenix block (#865). The failure
  // render needs no slot: when the summary call itself fails, the banner
  // and dashes stand in for the whole block.
  const failedNoFigures =
    (!summary && error !== null) ||
    (meteora?.status === 'unavailable' && meteora.valueUsd === null);

  if (!failedNoFigures && !meteora) return null;

  const figures = meteoraTopFigures(summary);
  // A refresh failing after a good summary holds the figures (the hook never
  // blanks them); they stay dimmed under the "Updating Meteora" banner with
  // the held numbers' age (#864). The failed state keeps the design's plain
  // dashes instead — no held dimming there.
  const stale = appIsStale(summary, error, 'meteora');
  const ageText = summary ? staleAgeText(summary.fetchedAt, Date.now()) : '';
  const pnl = summary?.apps.meteora.summary?.totalPnlUsd ?? null;
  const pnlTone = pnl === null ? null : pnl < 0 ? 'down' : 'up';

  const cells = [
    { label: 'Pool value', value: figures?.poolValue ?? NO_DATA, tone: null },
    { label: 'Unclaimed fees', value: figures?.unclaimedFees ?? NO_DATA, tone: null },
    { label: 'Total P&L', value: figures?.totalPnl ?? NO_DATA, tone: pnlTone },
  ];

  return (
    <View style={styles.root}>
      {failedNoFigures ? (
        <FailureBanner retrying={loading} onRetry={retryOnce} />
      ) : stale ? (
        <AppUpdatingBanner name="Meteora" ageText={ageText} loading={loading} onRetry={retryOnce} />
      ) : null}
      <View style={[styles.stats, stale && styles.held]}>
        {cells.map((cell) => (
          <View key={cell.label} style={styles.cell}>
            <Text style={styles.label}>{cell.label}</Text>
            <Text
              style={[
                styles.value,
                cell.tone === 'down' && styles.valueDown,
                cell.tone === 'up' && styles.valueUp,
              ]}
            >
              {cell.value}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
});

/** Design ".stats" skeleton: two bars per cell, no numbers. */
function Skeleton() {
  return (
    <View style={styles.stats}>
      {[0, 1, 2].map((cell) => (
        <View key={cell} style={styles.cell}>
          <View style={styles.skeletonLabel} />
          <View style={styles.skeletonValue} />
        </View>
      ))}
    </View>
  );
}

/** Mock ".bn" failure banner: "Couldn't load Meteora" + funds line + gold Retry. */
function FailureBanner({
  retrying,
  onRetry,
}: {
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <View style={styles.banner}>
      <MaterialIcons name="error-outline" size={20} color={semantic.sentiment.negative} />
      <View style={styles.bannerCopy}>
        <Text style={styles.bannerTitle}>{"Couldn't load Meteora"}</Text>
        <Text style={styles.bannerLine}>
          {'The numbers here may be out of date. Your funds are not affected.'}
        </Text>
      </View>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Retry Meteora"
        hitSlop={8}
        style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
      >
        {retrying ? (
          <ActivityIndicator size="small" color={tokens.colors.primaryDim} />
        ) : (
          <Text style={styles.retryLabel}>{'Retry →'}</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8, marginTop: 12 },
  // Design ".stats": card, hairline edge, radius 8, pad 12 — three cells.
  stats: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: tokens.colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    padding: 12,
  },
  // Design ".held": the held figures dim to 60% while a refresh retries.
  held: { opacity: 0.6 },
  cell: { flex: 1, minWidth: 0, gap: 4 },
  // Design ".stats .lab": mono caps label.
  label: {
    color: semantic.text.dim,
    fontFamily: 'monospace',
    fontSize: 10.5,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  // Design ".stats b": mono 600 15.
  value: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 15, fontWeight: '600' },
  // Design ".up"/".dn": the signed P&L alone carries the direction colour.
  valueUp: { color: semantic.sentiment.positive },
  valueDown: { color: semantic.sentiment.negative },
  skeletonLabel: {
    width: 64,
    height: 10,
    borderRadius: 4,
    backgroundColor: semantic.background.lift,
  },
  skeletonValue: {
    width: 56,
    height: 16,
    borderRadius: 4,
    backgroundColor: semantic.background.lift,
  },
  // Design ".bn": hairline box with the pink warn icon and gold Retry.
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: tokens.colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    padding: 12,
  },
  // Design ".bn p": title on its line, the funds note dim under it.
  bannerCopy: { flex: 1, gap: 2 },
  bannerTitle: { color: semantic.text.primary, fontSize: 14, fontWeight: '600' },
  bannerLine: { color: semantic.text.dim, fontSize: 12 },
  pressed: { opacity: 0.82 },
  retry: { paddingVertical: 2 },
  // Design ".fix": gold, 12.
  retryLabel: {
    color: tokens.colors.primaryDim,
    fontSize: 12,
    fontWeight: '600',
  },
});
