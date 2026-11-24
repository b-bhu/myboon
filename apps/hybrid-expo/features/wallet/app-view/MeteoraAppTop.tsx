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
 * States (issue): loading with no summary yet → a skeleton block, no
 * numbers. Failed with no summary → "Couldn't load Meteora" with a Retry
 * that calls the hook's retry. A refresh failing after a good summary keeps
 * the last figures on screen, dimmed (design ".held" 60%), with the same
 * Retry — they are never blanked.
 */

import { memo } from 'react';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useWalletSummary } from '@/features/wallet/useWalletSummary';
import { semantic, tokens } from '@/theme';
import { meteoraTopFigures } from './meteora-top';

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

  // No addresses at all: the hook made no call, nothing to show.
  if (!summary && !loading && error === null) return null;

  // Loading with no summary yet: skeleton cells, no numbers.
  if (!summary && loading) return <Skeleton />;

  // Failed with no summary: only the failure banner — no numbers were shown.
  if (!summary) return <FailureBanner onRetry={retry} />;

  const figures = meteoraTopFigures(summary);
  if (!figures) return null;
  // A refresh failing after a good summary holds the figures (the hook never
  // blanks them); they stay dimmed with the Retry, not blanked.
  const stale = error !== null;
  const pnl = summary.apps.meteora.summary?.totalPnlUsd ?? null;
  const pnlTone = pnl === null ? null : pnl < 0 ? 'down' : 'up';

  const cells = [
    { label: 'Pool value', value: figures.poolValue, tone: null },
    { label: 'Unclaimed fees', value: figures.unclaimedFees, tone: null },
    { label: 'Total P&L', value: figures.totalPnl, tone: pnlTone },
  ];

  return (
    <View style={styles.root}>
      {stale ? <FailureBanner onRetry={retry} /> : null}
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

/** Mock ".bn" failure banner: "Couldn't load Meteora" + gold Retry. */
function FailureBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.banner}>
      <MaterialIcons name="error-outline" size={20} color={semantic.sentiment.negative} />
      <Text style={styles.bannerTitle}>{"Couldn't load Meteora"}</Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Retry Meteora"
        hitSlop={8}
        style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
      >
        <Text style={styles.retryLabel}>{'Retry →'}</Text>
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
  bannerTitle: { flex: 1, color: semantic.text.primary, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.82 },
  retry: { paddingVertical: 2 },
  // Design ".fix": gold, 12.
  retryLabel: {
    color: tokens.colors.primaryDim,
    fontSize: 12,
    fontWeight: '600',
  },
});
