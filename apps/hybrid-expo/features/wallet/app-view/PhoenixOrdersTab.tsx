/**
 * Wallet app view — Phoenix Orders tab body (issue #850, design wallet.html
 * frame "8. App views > Phoenix · Orders", component ".pc[data-t=ord]").
 *
 * One card per take-profit or stop-loss order in the order `usePhoenixOrders`
 * returned them, with the legend above. Card strings come from
 * ./phoenix-orders. "Cancel conditional order" happens here: it builds the
 * cancel transaction, signs and sends it with the wallet (the old profile
 * screen's handleCancelOrder flow, phoenix.portfolio.tsx), then refetches.
 * While one runs the buttons show busy and a second tap does nothing; a
 * failure leaves the row, shows the error under the list and the button
 * works again.
 *
 * States: loading with no list yet → nothing (skeleton is #859); loaded and
 * empty → the plain note, no button (shared empty block is #860); failed
 * with no list → the note with Retry.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { memo, useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { buildPhoenixCancelConditionalOrder } from '@/features/perps/phoenix.api';
import { sendPhoenixBuiltTransaction } from '@/features/perps/phoenix.execution';
import { semantic, tokens } from '@/theme';
import { phoenixOrderFigures } from './phoenix-orders';
import { usePhoenixSigner } from './usePhoenixSigner';
import type { WalletPhoenixOrder } from '@myboon/shared/wallet-summary';

export const PhoenixOrdersTab = memo(function PhoenixOrdersTab({
  orders,
  loading,
  error,
  retry,
}: {
  /** Orders from the last good load; null before it. */
  orders: WalletPhoenixOrder[] | null;
  loading: boolean;
  error: string | null;
  /** One new request for the same address. */
  retry: () => void;
}) {
  const wallet = usePhoenixSigner();
  const signAndSend = wallet.signAndSend;
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // A second tap in the same frame must not send twice, before state lands.
  const runningRef = useRef(false);

  const cancel = useCallback(
    async (order: WalletPhoenixOrder) => {
      if (runningRef.current) return;
      if (!order.canCancel || order.conditionalOrderIndex === null || !order.executionDirection || order.traderPdaIndex === null) {
        setCancelError('This Phoenix order cannot be canceled from this screen yet.');
        return;
      }
      if (!wallet.address || !wallet.connection) {
        setCancelError('Phoenix order cancel requires a connected Solana wallet.');
        return;
      }
      if (!signAndSend) {
        setCancelError('This wallet cannot send Phoenix Solana transactions from the app.');
        return;
      }

      runningRef.current = true;
      setCancellingId(order.id);
      setCancelError(null);
      try {
        const builtTransaction = await buildPhoenixCancelConditionalOrder({
          authority: wallet.address,
          symbol: order.symbol,
          executionDirection: order.executionDirection,
          conditionalOrderIndex: order.conditionalOrderIndex,
          traderPdaIndex: order.traderPdaIndex,
          ...(order.traderSubaccountIndex === null ? {} : { traderSubaccountIndex: order.traderSubaccountIndex }),
        });
        await sendPhoenixBuiltTransaction({
          builtTransaction,
          connection: wallet.connection,
          walletAddress: wallet.address,
          signAndSendTransaction: signAndSend,
        });
        retry();
      } catch (err) {
        setCancelError(err instanceof Error ? err.message : 'Phoenix cancel failed.');
      } finally {
        runningRef.current = false;
        setCancellingId(null);
      }
    },
    [retry, signAndSend, wallet.address, wallet.connection],
  );

  if (orders === null && (loading || error === null)) return null;

  if (orders === null) {
    return (
      <View style={styles.errorWrap}>
        <Text style={styles.errorText}>{'Nothing to show until Phoenix loads.'}</Text>
        <Pressable
          onPress={retry}
          accessibilityRole="button"
          accessibilityLabel="Retry Phoenix orders"
          hitSlop={8}
          style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
        >
          <Text style={styles.retryLabel}>{'Retry →'}</Text>
        </Pressable>
      </View>
    );
  }

  if (orders.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <MaterialIcons name="inbox" size={32} color={semantic.text.faint} />
        <Text style={styles.emptyTitle}>{'No open orders'}</Text>
        <Text style={styles.emptyLine}>{'TP and SL orders show up here.'}</Text>
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

      {orders.map((order) => (
        <PhoenixOrderCard
          key={order.id}
          order={order}
          busy={cancellingId === order.id}
          onCancel={cancel}
        />
      ))}

      {cancelError ? <Text style={styles.cancelError}>{cancelError}</Text> : null}
    </View>
  );
});

/** Mock ".pc[data-t=ord]": title and tag with the trigger line, the P&L if
 * hit, and the Cancel conditional order button. */
function PhoenixOrderCard({
  order,
  busy,
  onCancel,
}: {
  order: WalletPhoenixOrder;
  busy: boolean;
  onCancel: (order: WalletPhoenixOrder) => void;
}) {
  const card = phoenixOrderFigures(order);
  const disabled = !order.canCancel || busy;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLead}>
          <Text numberOfLines={1} style={styles.cardTitle}>{card.title}</Text>
          <View style={styles.cardTags}>
            <Text numberOfLines={1} style={styles.tag}>{'Conditional'}</Text>
            <Text numberOfLines={1} style={styles.triggerText}>{card.trigger}</Text>
          </View>
        </View>
        <View style={styles.cardValues}>
          <Text
            style={[
              styles.cardValue,
              card.pnlTone === 'down' && styles.textDown,
              card.pnlTone === 'up' && styles.textUp,
            ]}
          >
            {card.pnl}
          </Text>
          <Text style={styles.ifHit}>{'if hit'}</Text>
        </View>
      </View>

      {/* Mock ".pc-f": the secondary action. */}
      <View style={styles.footer}>
        <Pressable
          onPress={() => onCancel(order)}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel="Cancel conditional order"
          accessibilityState={{ disabled, busy }}
          style={({ pressed }) => [styles.action, disabled && styles.actionDisabled, pressed && styles.pressed]}
        >
          <Text style={styles.actionText}>{busy ? 'Cancelling…' : 'Cancel conditional order'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
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
  triggerText: {
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
  ifHit: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 12 },
  textUp: { color: semantic.sentiment.positive },
  textDown: { color: semantic.sentiment.negative },
  footer: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: tokens.colors.borderMuted,
  },
  // Design ".act.sec": 36 tall outline button, secondary tone.
  action: {
    alignSelf: 'flex-start',
    height: 36,
    paddingHorizontal: 16,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionDisabled: { opacity: 0.5 },
  actionText: { color: semantic.text.primary, fontSize: 14, fontWeight: '600' },
  cancelError: { color: semantic.sentiment.negative, fontSize: 12 },
  emptyWrap: { alignItems: 'center', paddingVertical: 32, paddingHorizontal: 16 },
  emptyTitle: { color: semantic.text.primary, fontSize: 18, fontWeight: '600', marginTop: 12 },
  emptyLine: { color: semantic.text.dim, fontSize: 14 },
  errorWrap: { alignItems: 'center', gap: 8, paddingVertical: 24 },
  errorText: { color: semantic.text.dim, fontSize: 12, textAlign: 'center' },
  retry: { paddingVertical: 2 },
  retryLabel: { color: tokens.colors.primaryDim, fontSize: 12, fontWeight: '600' },
  pressed: { opacity: 0.82 },
});
