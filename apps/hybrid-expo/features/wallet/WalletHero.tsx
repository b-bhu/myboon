import { useEffect, useMemo, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { semantic, tokens } from '@/theme';
import { WALLET_PROTOCOL_IDS, type WalletTotals } from '@/features/wallet/wallet.types';

const MIX_COLORS = {
  spot: tokens.walletBrand.spot,
  meteora: tokens.walletBrand.meteora,
  phoenix: tokens.walletBrand.phoenix,
  pacifica: tokens.walletBrand.pacifica,
  polymarket: tokens.walletBrand.polymarket,
} as const;

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatFreshness(resolvedAtMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - resolvedAtMs);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'as of just now';
  if (minutes === 1) return 'as of 1 min ago';
  return `as of ${minutes} min ago`;
}

export function WalletHero({
  totals,
  hasAnyResolved,
  isRefreshing,
  onRefresh,
}: {
  totals: WalletTotals;
  hasAnyResolved: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Freshness label ticks forward on its own — it must reflect the most
    // recent successful refresh, not a stale fixed timestamp (TC-TOTAL-005).
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const freshnessLabel = totals.lastResolvedAt !== null
    ? formatFreshness(totals.lastResolvedAt, now)
    : null;

  const segments = useMemo(
    () => WALLET_PROTOCOL_IDS
      .map((id) => ({ id, share: totals.mix[id] }))
      .filter((segment): segment is { id: typeof segment.id; share: number } => segment.share !== undefined),
    [totals.mix],
  );

  return (
    <View style={styles.hero}>
      <View style={styles.topRow}>
        {freshnessLabel ? <Text style={styles.asOf}>{freshnessLabel}</Text> : <View />}
        <RefreshButton spinning={isRefreshing} onPress={onRefresh} />
      </View>

      {hasAnyResolved && totals.totalUsd !== null ? (
        <Text style={styles.totalValue}>{formatUsd(totals.totalUsd)}</Text>
      ) : (
        <TotalSkeleton />
      )}

      <View style={styles.mixBar}>
        {segments.length > 0
          ? segments.map(({ id, share }) => (
            <View
              key={id}
              style={[
                styles.mixSegment,
                { flexGrow: Math.max(share, 0.0001), backgroundColor: MIX_COLORS[id] },
              ]}
            />
          ))
          : <View style={[styles.mixSegment, styles.mixSegmentPending, { flexGrow: 1 }]} />}
      </View>
    </View>
  );
}

function TotalSkeleton() {
  const shimmer = useMemo(() => new Animated.Value(0), []);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 800, easing: Easing.ease, useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0, duration: 800, easing: Easing.ease, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [shimmer]);

  const opacity = shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.9] });

  return (
    <Animated.View
      style={[styles.totalSkeleton, { opacity }]}
      accessibilityLabel="Wallet total loading"
    />
  );
}

function RefreshButton({ spinning, onPress }: { spinning: boolean; onPress: () => void }) {
  const rotation = useMemo(() => new Animated.Value(0), []);

  useEffect(() => {
    if (!spinning) {
      rotation.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(rotation, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [spinning, rotation]);

  const spin = rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Pressable
      onPress={onPress}
      disabled={spinning}
      accessibilityRole="button"
      accessibilityLabel="Refresh wallet balances"
      hitSlop={8}
      style={({ pressed }) => [styles.refreshButton, pressed && !spinning && styles.refreshButtonPressed]}
    >
      <Animated.Text style={[styles.refreshGlyph, { transform: [{ rotate: spin }] }]}>{'↻'}</Animated.Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(24,90,112,0.86)',
    backgroundColor: 'rgba(8,61,80,0.90)',
    padding: tokens.spacing.lg,
    paddingTop: 14,
    marginBottom: tokens.spacing.md,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  asOf: {
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 0.4,
  },
  refreshButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  refreshButtonPressed: {
    opacity: 0.6,
  },
  refreshGlyph: {
    color: semantic.text.faint,
    fontSize: 15,
    fontWeight: '700',
  },
  totalValue: {
    color: semantic.text.primary,
    fontSize: 39,
    lineHeight: 42,
    fontWeight: '800',
    marginBottom: 14,
  },
  totalSkeleton: {
    width: 170,
    height: 39,
    borderRadius: 6,
    backgroundColor: semantic.background.lift,
    marginBottom: 14,
  },
  mixBar: {
    flexDirection: 'row',
    width: '100%',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  mixSegment: {
    height: '100%',
  },
  mixSegmentPending: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
});
