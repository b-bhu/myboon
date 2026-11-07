import { StyleSheet, Text, View } from 'react-native';
import type { PortfolioPosition } from '@/features/polymarket/polymarket.api';
import { semantic, tokens } from '@/theme';

interface PerfStripProps {
  positions: PortfolioPosition[];
}

export function PerfStrip({ positions }: PerfStripProps) {
  if (positions.length === 0) return null;

  const winners = positions.filter((p) => (p.cashPnl ?? 0) > 0);
  const winRate = positions.length > 0 ? Math.round((winners.length / positions.length) * 100) : 0;

  const avgReturn = positions.length > 0
    ? positions.reduce((sum, p) => sum + (p.percentPnl ?? 0), 0) / positions.length
    : 0;

  const bestCall = positions.reduce<PortfolioPosition | null>(
    (best, p) => (!best || (p.cashPnl ?? 0) > (best.cashPnl ?? 0) ? p : best),
    null
  );

  return (
    <View style={styles.strip}>
      <View style={styles.cell}>
        <Text style={styles.cellValue}>{winRate}%</Text>
        <Text style={styles.cellLabel}>Win Rate</Text>
      </View>
      <View style={styles.divider} />
      <View style={styles.cell}>
        <Text style={[styles.cellValue, avgReturn >= 0 ? styles.pos : styles.neg]}>
          {avgReturn >= 0 ? '+' : ''}{avgReturn.toFixed(1)}%
        </Text>
        <Text style={styles.cellLabel}>Avg Return</Text>
      </View>
      <View style={styles.divider} />
      <View style={[styles.cell, { flex: 2 }]}>
        <Text style={styles.cellValue} numberOfLines={1}>
          {bestCall ? `+$${(bestCall.cashPnl ?? 0).toFixed(0)}` : '--'}
        </Text>
        <Text style={styles.cellLabel} numberOfLines={1}>
          {bestCall ? bestCall.title?.slice(0, 20) ?? 'Best Call' : 'Best Call'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: tokens.spacing.lg,
    marginTop: 10,
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  cell: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
  },
  cellValue: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  cellLabel: {
    fontFamily: 'monospace',
    fontSize: 7,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  divider: {
    width: 1,
    height: 24,
    backgroundColor: semantic.border.muted,
    marginHorizontal: 8,
  },
  pos: { color: tokens.colors.viridian },
  neg: { color: tokens.colors.vermillion },
});
