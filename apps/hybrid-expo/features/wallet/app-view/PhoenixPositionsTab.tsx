/**
 * Wallet app view — Phoenix Positions tab body (issue #849, design
 * wallet.html frame "8. App view > Phoenix · Positions", components
 * "Perp position" (.pc[data-t=perp]), "Leave row" and "Action legend").
 *
 * One card per open position in the order `usePerpPositions` returned them,
 * with the legend above. Card strings come from ./phoenix-positions. "Close
 * position" is a leave row: it opens the market screen for the symbol and
 * closes nothing in the Wallet. "Edit TP/SL" opens PhoenixTpslSheet (#851).
 *
 * States: loading with no list yet → nothing (the skeleton is #859);
 * loaded and empty → the plain empty note, no button (the shared empty
 * block with the Deposit button is #860); failed with no list → the note
 * with a Retry that calls the hook's retry. A failed refresh after a good
 * load keeps the cards (the hook holds the list). Orders and History are
 * rendered by AppView through PortfolioTabBody.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { semantic, tokens } from '@/theme';
import { perpCardFigures } from './phoenix-positions';
import { PhoenixTpslSheet } from './PhoenixTpslSheet';
import type { PerpVenue } from './perp-positions';
import type { WalletPerpPositionDetail } from '@myboon/shared/wallet-summary';

export const PhoenixPositionsTab = memo(function PhoenixPositionsTab({
  positions,
  loading,
  error,
  retry,
  venue = 'phoenix',
}: {
  /** Open positions from the last good load; null before it. */
  positions: WalletPerpPositionDetail[] | null;
  /** True while a load or retry runs. */
  loading: boolean;
  /** Error text of the failed request; null when the list is usable. */
  error: string | null;
  /** One new request for the same address. */
  retry: () => void;
  /** Pacifica reuses this tab (#857): no TP/SL line, no Edit TP/SL, its own copy and market route. */
  venue?: PerpVenue;
}) {
  const name = venue === 'pacifica' ? 'Pacifica' : 'Phoenix';
  // The position whose Edit TP/SL sheet is open (#851).
  const [editing, setEditing] = useState<WalletPerpPositionDetail | null>(null);

  // Loading (skeleton is #859), or nothing to fetch at all (no Solana
  // address — the hook made no call): no card.
  if (positions === null && (loading || error === null)) return null;

  if (positions === null) {
    return (
      <View style={styles.errorWrap}>
        <Text style={styles.errorText}>{`Nothing to show until ${name} loads.`}</Text>
        <Pressable
          onPress={retry}
          accessibilityRole="button"
          accessibilityLabel={`Retry ${name} positions`}
          hitSlop={8}
          style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
        >
          <Text style={styles.retryLabel}>{'Retry →'}</Text>
        </Pressable>
      </View>
    );
  }

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

      {positions.map((position, index) => (
        <PerpPositionCard
          key={`${index}:${position.symbol}:${position.side}`}
          position={position}
          venue={venue}
          onEdit={() => setEditing(position)}
        />
      ))}

      {venue === 'phoenix' ? (
        <PhoenixTpslSheet position={editing} onClose={() => setEditing(null)} onUpdated={retry} />
      ) : null}
    </View>
  );
});

/** Mock ".pc[data-t=perp]": title and tag, value and P&L, Entry | Mark | Liq.,
 * the TP/SL line, the Edit TP/SL button and the Close position leave row. */
function PerpPositionCard({
  position,
  venue,
  onEdit,
}: {
  position: WalletPerpPositionDetail;
  venue: PerpVenue;
  onEdit: () => void;
}) {
  const router = useRouter();
  const card = perpCardFigures(position, venue);

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLead}>
          <Text numberOfLines={1} style={styles.cardTitle}>{card.title}</Text>
          <View style={styles.cardTags}>
            <Text numberOfLines={1} style={styles.tag}>{card.tag}</Text>
            <Text numberOfLines={1} style={styles.sizeText}>{card.size}</Text>
          </View>
        </View>
        <View style={styles.cardValues}>
          <Text style={styles.cardValue}>{card.value}</Text>
          <Text
            numberOfLines={1}
            style={[
              styles.cardPnl,
              card.pnlTone === 'down' && styles.textDown,
              card.pnlTone === 'up' && styles.textUp,
            ]}
          >
            {card.pnl}
          </Text>
        </View>
      </View>

      {/* Mock ".kv": three cells. */}
      <View style={styles.kv}>
        <KvCell label="Entry" value={card.entry} />
        <KvCell label="Mark" value={card.mark} />
        <KvCell label="Liq." value={card.liq} />
      </View>

      {card.tpsl === null ? null : (
        <View style={styles.tpslLine}>
          <Text style={styles.tpslText}>{card.tpsl}</Text>
        </View>
      )}

      {/* Mock ".pc-f": Edit TP/SL (opens the sheet, #851) and the leave row. */}
      <View style={styles.footer}>
        {venue === 'phoenix' ? (
          <Pressable
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel="Edit TP/SL"
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Text style={styles.actionText}>{'Edit TP/SL'}</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => router.push(card.marketHref as never)}
          accessibilityRole="button"
          accessibilityLabel="Close position — opens market screen"
          style={({ pressed }) => [styles.leave, pressed && styles.pressed]}
        >
          <Text style={styles.leaveTitle}>{'Close position ↗'}</Text>
          <Text style={styles.leaveSub}>{'OPENS MARKET SCREEN'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function KvCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kvCell}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={styles.kvValue}>{value}</Text>
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
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  cardLead: { flex: 1, minWidth: 0, gap: 8 },
  cardTitle: { color: semantic.text.primary, fontSize: 15, fontWeight: '600' },
  cardTags: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  sizeText: {
    color: semantic.text.dim,
    fontFamily: 'monospace',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  cardValues: { alignItems: 'flex-end', gap: 4, flexShrink: 0 },
  cardValue: {
    color: semantic.text.primary,
    fontFamily: 'monospace',
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  cardPnl: {
    color: semantic.text.dim,
    fontFamily: 'monospace',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  textUp: { color: semantic.sentiment.positive },
  textDown: { color: semantic.sentiment.negative },
  // Design ".kv": three equal cells, label above a mono 14 value.
  kv: { flexDirection: 'row', gap: 8, marginTop: 12 },
  kvCell: { flex: 1, gap: 4 },
  kvLabel: { color: semantic.text.faint, fontSize: 12 },
  kvValue: {
    color: semantic.text.primary,
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  // Design ".tpsl": mono 12 dim line.
  tpslLine: { marginTop: 12 },
  tpslText: {
    color: semantic.text.dim,
    fontFamily: 'monospace',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  // Design ".pc-f": hairline top edge, the outline button and the leave row.
  footer: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: tokens.colors.borderMuted,
    gap: 10,
  },
  action: {
    alignSelf: 'flex-start',
    height: 36,
    paddingHorizontal: 16,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: tokens.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: { color: tokens.colors.accent, fontSize: 14, fontWeight: '600' },
  leave: { gap: 3, paddingVertical: 4 },
  leaveTitle: { color: tokens.colors.accent, fontSize: 14, fontWeight: '600' },
  leaveSub: {
    color: semantic.text.faint,
    fontFamily: 'monospace',
    fontSize: 10,
    letterSpacing: 0.8,
  },
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
