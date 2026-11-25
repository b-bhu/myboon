/**
 * Wallet app view — Meteora Positions tab body (issue #902, design
 * wallet.html frame "8. App view > Meteora · Positions", components
 * "LP position" (.pc[data-t=lp]), "Add liquidity" (.addl) and "Action
 * legend").
 *
 * One card per open position in the order `useMeteoraPositions` (#901)
 * returned them, with the legend and the Add liquidity row above the list.
 * The card value is the owning pool's `valueUsd` from the summary, matched
 * by `name` to `poolName` (Nov 25 decision: two positions in one pool show
 * the same value). The bin tag ("Bins {lowerBinId} to {upperBinId}")
 * replaces the mock's "Bin N"; the range bar renders with no marker (the
 * in-range state shows through the In range / Out of range tag).
 *
 * States: loading with no list yet → nothing (the skeleton is #859);
 * loaded and empty → the plain empty note, no button (the shared empty
 * block with the Deposit button is #860); failed → the note with a Retry
 * that calls the hook's retry (#865 adds the shared failure banner).
 * Orders and History are rendered by AppView through PortfolioTabBody;
 * Manage opens the Manage sheet for its card (#903).
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { NO_DATA, formatPrice } from '@/lib/format';
import { semantic, tokens } from '@/theme';
import { MeteoraManageSheet } from './MeteoraManageSheet';
import { signedUsd, usd } from './meteora-top';
import type { WalletMeteoraPool, WalletMeteoraPosition } from '@myboon/shared/wallet-summary';

/** Where an Add liquidity tap goes (#902; the market screen is pre-filled there). */
const METEORA_MARKET_HREF = '/markets/meteora';

export const MeteoraPositionsTab = memo(function MeteoraPositionsTab({
  positions,
  loading,
  error,
  retry,
  pools,
}: {
  /** Open positions from the last good load; null before it (#901). */
  positions: WalletMeteoraPosition[] | null;
  /** True while a load or retry runs. */
  loading: boolean;
  /** Error text of the failed request; null when the list is usable. */
  error: string | null;
  /** One new request for the same address. */
  retry: () => void;
  /** Pools behind the cards, from the summary call AppView makes. */
  pools: WalletMeteoraPool[];
}) {
  const router = useRouter();
  const [managed, setManaged] = useState<WalletMeteoraPosition | null>(null);

  // Loading (skeleton is #859), or nothing to fetch at all (no Solana
  // address — the hook made no call): no card and no Add liquidity row.
  if (positions === null && (loading || (error === null))) return null;

  // Failed before any good load: the note and the hook's retry. A refresh
  // failing after a good list keeps that list on screen (#901's trust rule),
  // so this branch only fires with positions still null.
  if (positions === null) {
    return (
      <View style={styles.errorWrap}>
        <Text style={styles.errorText}>{'Nothing to show until Meteora loads.'}</Text>
        <Pressable
          onPress={retry}
          accessibilityRole="button"
          accessibilityLabel="Retry Meteora positions"
          hitSlop={8}
          style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
        >
          <Text style={styles.retryLabel}>{'Retry →'}</Text>
        </Pressable>
      </View>
    );
  }

  // Loaded and empty: the plain note, no button (the shared empty block with
  // the Deposit button is #860).
  if (positions.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <MaterialIcons name="inbox" size={32} color={semantic.text.faint} />
        <Text style={styles.emptyTitle}>{'No open positions'}</Text>
        <Text style={styles.emptyLine}>{'Positions you open in a market screen show up here.'}</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {/* Mock ".legend": what happens in place vs what leaves. */}
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={styles.legendBox} />
          <Text style={styles.legendText}>Happens here</Text>
        </View>
        <View style={styles.legendItem}>
          <Text style={styles.legendArrow}>{'↗'}</Text>
          <Text style={styles.legendText}>Opens market screen</Text>
        </View>
      </View>

      {/* Mock ".addl" LeaveRow: the one row that always leaves the Wallet. */}
      <Pressable
        onPress={() => router.push(METEORA_MARKET_HREF)}
        accessibilityRole="button"
        accessibilityLabel="Add liquidity — opens market screen"
        style={({ pressed }) => [styles.addl, pressed && styles.pressed]}
      >
        <View style={styles.addlLead}>
          <Text style={styles.addlTitle}>{'Add liquidity ↗'}</Text>
          <Text style={styles.addlSub}>{'OPENS MARKET SCREEN'}</Text>
        </View>
        <Text style={styles.tag}>{'Not in Wallet'}</Text>
      </Pressable>

      {positions.map((position, index) => (
        <MeteoraPositionCard
          key={`${index}:${position.poolAddress}`}
          position={position}
          pools={pools}
          onManage={() => setManaged(position)}
        />
      ))}
      {managed === null ? null : (
        <MeteoraManageSheet position={managed} onClose={() => setManaged(null)} onChanged={retry} />
      )}
    </View>
  );
});

/** The owning pool's card value: `valueUsd` matched by `name` (null when the
 * pool is unknown or its value is unknown — the no-data glyph shows). */
function poolValueUsd(pools: WalletMeteoraPool[], poolName: string): number | null {
  return pools.find((pool) => pool.name === poolName)?.valueUsd ?? null;
}

/** Design `pc` (the P&L percent): sign, 1 decimal, "%", zero reads positive. */
function signedPct(value: number): string {
  return (value < 0 ? '−' : '+') + Math.abs(value).toFixed(1) + '%';
}

/** Mock ".pc[data-t=lp]": title and tags, value and P&L, the range bar with
 * its min/max labels, the unclaimed fees line and the Manage button. */
function MeteoraPositionCard({
  position,
  pools,
  onManage,
}: {
  position: WalletMeteoraPosition;
  pools: WalletMeteoraPool[];
  onManage: () => void;
}) {
  const value = poolValueUsd(pools, position.poolName);
  const usdPart = position.pnlUsd === null ? NO_DATA : signedUsd(position.pnlUsd);
  const pctPart = position.pnlPct === null ? NO_DATA : signedPct(position.pnlPct);
  const pnlTone = position.pnlUsd === null ? null : position.pnlUsd < 0 ? 'down' : 'up';

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLead}>
          <Text numberOfLines={1} style={styles.cardTitle}>{position.poolName}</Text>
          <View style={styles.cardTags}>
            <Text numberOfLines={1} style={styles.tag}>{`Bins ${position.lowerBinId} to ${position.upperBinId}`}</Text>
            {position.outOfRange === null ? null : (
              <Text numberOfLines={1} style={styles.tag}>{position.outOfRange ? 'Out of range' : 'In range'}</Text>
            )}
          </View>
        </View>
        <View style={styles.cardValues}>
          <Text style={styles.cardValue}>{value === null ? NO_DATA : usd(value)}</Text>
          <Text
            numberOfLines={1}
            style={[
              styles.cardPnl,
              pnlTone === 'down' && styles.textDown,
              pnlTone === 'up' && styles.textUp,
            ]}
          >
            {`${usdPart} · ${pctPart}`}
          </Text>
        </View>
      </View>

      {/* Mock ".rng" + ".rng-l": the track with no marker (owner decision —
          the in-range state shows through the range tag), min | max under it. */}
      <View style={styles.rangeTrack}>
        <View style={styles.rangeInset} />
      </View>
      <View style={styles.rangeLabels}>
        <Text style={styles.rangeLabel}>{formatPrice(position.minPrice)}</Text>
        <Text style={styles.rangeLabel}>{formatPrice(position.maxPrice)}</Text>
      </View>

      <View style={styles.feesLine}>
        <Text style={styles.feesText}>
          {`Unclaimed fees ${position.poolUnclaimedFeesUsd === null ? NO_DATA : usd(position.poolUnclaimedFeesUsd)}`}
        </Text>
      </View>

      {/* Mock ".pc-f": Manage opens the Manage sheet (#903). */}
      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Manage position"
          onPress={onManage}
          style={({ pressed }) => [styles.manage, pressed && styles.pressed]}
        >
          <Text style={styles.manageText}>{'Manage'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  // Design ".legend": mono 11 faint uppercase; outlined box + ↗.
  legend: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendBox: {
    width: 16,
    height: 10,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: tokens.colors.accent,
  },
  legendArrow: { color: tokens.colors.accent, fontSize: 12 },
  legendText: {
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  // Design ".addl": hairline row, brand text, Not in Wallet tag.
  addl: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    backgroundColor: tokens.colors.surface,
  },
  addlLead: { gap: 3 },
  addlTitle: { color: tokens.colors.accent, fontSize: 14, fontWeight: '600' },
  addlSub: {
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 10,
    letterSpacing: 0.8,
  },
  // Design ".tag": mono caps 11, hairline box.
  tag: {
    color: semantic.text.dim,
    fontFamily: 'monospace',
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    borderRadius: 4,
    paddingVertical: 1,
    paddingHorizontal: 6,
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
  // Design ".pc": card, hairline edge, radius 8, pad 12.
  card: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    backgroundColor: tokens.colors.surface,
  },
  // Design ".pc-h": lead (title + tags) left, value + P&L right.
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  cardLead: { flex: 1, minWidth: 0, gap: 8 },
  cardTitle: { color: semantic.text.primary, fontSize: 15, fontWeight: '600' },
  cardTags: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  cardValues: { alignItems: 'flex-end', gap: 4, flexShrink: 0 },
  cardValue: {
    color: semantic.text.primary,
    fontFamily: 'monospace',
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  // Design ".pc-v small": mono 12; the signed P&L carries the direction colour.
  cardPnl: {
    color: semantic.text.dim,
    fontFamily: 'monospace',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  textUp: { color: semantic.sentiment.positive },
  textDown: { color: semantic.sentiment.negative },
  // Design ".rng": 6-tall inset track; and ".rng-l": min | max mono 11 faint.
  rangeTrack: {
    height: 6,
    marginTop: 12,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    backgroundColor: semantic.background.screen,
    overflow: 'hidden',
  },
  rangeInset: {
    flex: 1,
    marginHorizontal: '10%',
    borderRadius: 2,
    backgroundColor: semantic.background.lift,
  },
  rangeLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
    marginHorizontal: '8%',
  },
  rangeLabel: {
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  // Design ".tpsl": mono 12 dim line.
  feesLine: { marginTop: 12 },
  feesText: {
    color: semantic.text.dim,
    fontFamily: 'monospace',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  // Design ".pc-f": hairline top edge, the outline Manage button.
  footer: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: tokens.colors.borderMuted,
  },
  // Design ".act": 36 tall, brand outline, 600 14.
  manage: {
    alignSelf: 'flex-start',
    height: 36,
    paddingHorizontal: 16,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: tokens.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  manageText: { color: tokens.colors.accent, fontSize: 14, fontWeight: '600' },
  // Plain empty note (".emp" look, no button) and the failed note.
  emptyWrap: { alignItems: 'center', paddingVertical: 32, paddingHorizontal: 16 },
  emptyTitle: { color: semantic.text.primary, fontSize: 18, fontWeight: '600', marginTop: 12 },
  emptyLine: { color: semantic.text.dim, fontSize: 14 },
  errorWrap: { alignItems: 'center', gap: 8, paddingVertical: 24 },
  errorText: { color: semantic.text.dim, fontSize: 12, textAlign: 'center' },
  retry: { paddingVertical: 2 },
  retryLabel: { color: tokens.colors.primaryDim, fontSize: 12, fontWeight: '600' },
  pressed: { opacity: 0.82 },
});
