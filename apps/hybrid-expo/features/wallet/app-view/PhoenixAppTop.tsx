/**
 * Wallet app view — Phoenix top block (issue #848, design wallet.html frame
 * "Phoenix · Positions", "Top block" / AppStats).
 *
 * Two cells under the app view header: "Balance" and "Cash available", from
 * the Phoenix slot of the wallet summary with phoenix-top.ts. The view makes
 * its own useWalletSummary call — the server caches the summary (#764), so
 * the Portfolio's first call and this second one are both accepted. The
 * Deposit | Withdraw strip is cut from launch (owner decision, #848): the
 * block shows the numbers only.
 *
 * States (issue): loading with no summary yet → a skeleton block, no
 * numbers. Failed with no summary, or the Phoenix slot unavailable with no
 * figures → "Couldn't load Phoenix" with the funds-are-safe line and a gold
 * Retry that calls the hook's retry, cells showing NO_DATA. A retry from a
 * failed state keeps the banner and the dashes — the skeleton is only the
 * first load — and shows a small spinner on the button while it runs (#865).
 * A refresh failing after a good summary keeps the last figures on screen,
 * dimmed (design ".held" 60%), under the shared "Updating {app}" banner
 * with the held numbers' age (AppUpdatingBanner, #864) — never blanked.
 * Phoenix `not_connected`, or no addresses at all → nothing renders.
 */

import { memo } from 'react';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useWalletSummary } from '@/features/wallet/useWalletSummary';
import { semantic, tokens } from '@/theme';
import { NO_DATA } from '@/lib/format';
import { phoenixTopFigures } from './phoenix-top';
import { appIsStale, staleAgeText } from './app-stale';
import { AppUpdatingBanner } from './AppUpdatingBanner';
import type { PerpVenue } from './perp-positions';

export const PhoenixAppTop = memo(function PhoenixAppTop({
  solana,
  evm,
  venue = 'phoenix',
}: {
  /** Solana address the summary route expects (#744). */
  solana: string | null;
  /** EVM address the summary route expects; unused by Phoenix itself. */
  evm: string | null;
  /** Which perps app the block shows; Pacifica reuses this view (#857). */
  venue?: PerpVenue;
}) {
  const name = venue === 'pacifica' ? 'Pacifica' : 'Phoenix';
  const { summary, loading, error, retry } = useWalletSummary(solana, evm);

  // One retry at a time: tapping Retry while a retry runs does nothing.
  const retryOnce = () => {
    if (loading) return;
    retry();
  };

  // No addresses at all: the hook made no call, nothing to show.
  if (!summary && !loading && error === null) return null;

  // Loading with no summary yet and no error yet: the first load — skeleton
  // cells, no numbers (design "load"). A retry from a failed state keeps the
  // banner and the dashes instead (#865).
  if (!summary && loading && error === null) return <Skeleton />;

  const phoenix = (venue === 'pacifica' ? summary?.apps.pacifica : summary?.apps.phoenix) ?? null;

  // Not connected: no account at the venue, render nothing.
  if (phoenix?.status === 'not_connected') return null;

  const figures = phoenixTopFigures(summary, venue);

  // Failed with no summary (the hook returned an error and nothing else),
  // or the Phoenix slot itself failing with no figures to show: the banner
  // over NO_DATA cells — the design keeps the stats card and dashes the
  // values, the block never opens empty. The failure render needs no slot:
  // when the summary call itself fails, the banner and dashes stand in for
  // the whole block (#865).
  const failedNoFigures =
    (!summary && error !== null) ||
    (phoenix?.status === 'unavailable' && phoenix.valueUsd === null);

  if (!failedNoFigures && !phoenix) return null;

  // A refresh failing after a good summary holds the figures (the hook never
  // blanks them); they stay dimmed under the "Updating {app}" banner with the
  // held numbers' age (#864). The failed state keeps the design's plain
  // dashes instead — no held dimming there.
  const stale = appIsStale(summary, error, venue);
  const ageText = summary ? staleAgeText(summary.fetchedAt, Date.now()) : '';

  const cells = [
    { label: 'Balance', value: figures?.balance ?? NO_DATA },
    { label: 'Cash available', value: figures?.cashAvailable ?? NO_DATA },
  ];

  return (
    <View style={styles.root}>
      {failedNoFigures ? (
        <FailureBanner name={name} retrying={loading} onRetry={retryOnce} />
      ) : stale ? (
        <AppUpdatingBanner name={name} ageText={ageText} loading={loading} onRetry={retryOnce} />
      ) : null}
      <View style={[styles.stats, stale && styles.held]}>
        {cells.map((cell) => (
          <View key={cell.label} style={styles.cell}>
            <Text style={styles.label}>{cell.label}</Text>
            <Text style={styles.value}>{cell.value}</Text>
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
      {[0, 1].map((cell) => (
        <View key={cell} style={styles.cell}>
          <View style={styles.skeletonLabel} />
          <View style={styles.skeletonValue} />
        </View>
      ))}
    </View>
  );
}

/** Mock ".bn" failure banner: "Couldn't load Phoenix" + funds line + gold Retry. */
function FailureBanner({
  name,
  retrying,
  onRetry,
}: {
  name: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <View style={styles.banner}>
      <MaterialIcons name="error-outline" size={20} color={semantic.sentiment.negative} />
      <View style={styles.bannerCopy}>
        <Text style={styles.bannerTitle}>{`Couldn't load ${name}`}</Text>
        <Text style={styles.bannerLine}>
          {'The numbers here may be out of date. Your funds are not affected.'}
        </Text>
      </View>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={`Retry ${name}`}
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
  // Design ".stats": card, hairline edge, radius 8, pad 12 — two cells.
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
