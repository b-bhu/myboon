/**
 * Wallet app view — Phoenix Edit TP/SL sheet (issue #851, design wallet.html
 * frame "8. App views > Phoenix · TP/SL sheet").
 *
 * A bottom sheet (WalletSecondarySheet) with the two trigger-price fields,
 * the P&L at each price, the reduce-only note and Update TP/SL | Cancel.
 * Update validates (./phoenix-tpsl), builds the position conditional order
 * transaction, signs and sends it with the wallet (the old profile screen's
 * handleSetTPSL flow), then closes the sheet and asks the caller to refetch.
 * A failure keeps the sheet open with the error under the note and the button
 * works again. One send at a time.
 */

import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { buildPhoenixPositionConditionalOrder } from '@/features/perps/phoenix.api';
import { sendPhoenixBuiltTransaction } from '@/features/perps/phoenix.execution';
import { WalletSecondarySheet } from '@/features/wallet/WalletSecondarySheet';
import { semantic, tokens } from '@/theme';
import { perpCardFigures, perpTag } from './phoenix-positions';
import { pnlAtPrice, prefill, validateTpsl } from './phoenix-tpsl';
import { usd } from './phoenix-top';
import { usePhoenixSigner } from './usePhoenixSigner';
import type { WalletPerpPositionDetail } from '@myboon/shared/wallet-summary';

/** "At TP +$33.23": sign then money, zero reads positive. */
function pnlLine(label: string, pnl: number | null): { text: string; tone: 'up' | 'down' } | null {
  if (pnl === null) return null;
  return { text: `${label} ${pnl < 0 ? '−' : '+'}${usd(pnl)}`, tone: pnl < 0 ? 'down' : 'up' };
}

export function PhoenixTpslSheet({
  position,
  onClose,
  onUpdated,
}: {
  /** The position being edited; null keeps the sheet closed. */
  position: WalletPerpPositionDetail | null;
  onClose: () => void;
  /** Called after a sent update, so the caller refetches the positions. */
  onUpdated: () => void;
}) {
  // Remount the body per position so the fields start from its prices.
  return (
    <WalletSecondarySheet visible={position !== null} title="Edit TP/SL" onClose={onClose}>
      {position ? <SheetBody key={`${position.symbol}:${position.side}`} position={position} onClose={onClose} onUpdated={onUpdated} /> : null}
    </WalletSecondarySheet>
  );
}

function SheetBody({
  position,
  onClose,
  onUpdated,
}: {
  position: WalletPerpPositionDetail;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const wallet = usePhoenixSigner();
  const [tp, setTp] = useState(prefill(position.takeProfitPriceUsd));
  const [sl, setSl] = useState(prefill(position.stopLossPriceUsd));
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runningRef = useRef(false);

  const card = perpCardFigures(position);
  const subtitle = `${position.symbol} · ${perpTag(position.side, position.leverage)} · ${card.size}`;
  const tpLine = pnlLine('At TP', pnlAtPrice(position, tp));
  const slLine = pnlLine('At SL', pnlAtPrice(position, sl));

  const update = useCallback(async () => {
    if (runningRef.current) return;
    const checked = validateTpsl(tp, sl);
    if (!checked.ok) {
      setMessage(checked.message);
      return;
    }
    if (!wallet.address || !wallet.connection) {
      setMessage('Phoenix TP/SL requires a connected Solana wallet.');
      return;
    }
    if (!wallet.signAndSend) {
      setMessage('This wallet cannot send Phoenix Solana transactions from the app.');
      return;
    }
    if (position.traderPdaIndex === null) {
      setMessage('This Phoenix position cannot be edited from this screen yet.');
      return;
    }

    runningRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const builtTransaction = await buildPhoenixPositionConditionalOrder({
        authority: wallet.address,
        symbol: position.symbol,
        positionSide: position.side,
        takeProfitPrice: checked.takeProfit ?? undefined,
        stopLossPrice: checked.stopLoss ?? undefined,
        pdaIndex: position.traderPdaIndex,
        ...(position.traderSubaccountIndex === null ? {} : { traderSubaccountIndex: position.traderSubaccountIndex }),
        baseUnits: String(position.size),
      });
      await sendPhoenixBuiltTransaction({
        builtTransaction,
        connection: wallet.connection,
        walletAddress: wallet.address,
        signAndSendTransaction: wallet.signAndSend,
      });
      onUpdated();
      onClose();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Phoenix TP/SL failed.');
    } finally {
      runningRef.current = false;
      setBusy(false);
    }
  }, [onClose, onUpdated, position, sl, tp, wallet.address, wallet.connection, wallet.signAndSend]);

  return (
    <View style={styles.root}>
      <Text style={styles.sub}>{subtitle}</Text>

      <View style={styles.field}>
        <Text style={styles.label}>{'Take profit · mark price'}</Text>
        <TextInput
          value={tp}
          onChangeText={setTp}
          editable={!busy}
          keyboardType="decimal-pad"
          accessibilityLabel="Take profit mark price"
          placeholderTextColor={semantic.text.faint}
          style={styles.input}
        />
        {tpLine ? <Text style={[styles.pnl, tpLine.tone === 'up' ? styles.up : styles.down]}>{tpLine.text}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>{'Stop loss · mark price'}</Text>
        <TextInput
          value={sl}
          onChangeText={setSl}
          editable={!busy}
          keyboardType="decimal-pad"
          accessibilityLabel="Stop loss mark price"
          placeholderTextColor={semantic.text.faint}
          style={styles.input}
        />
        {slLine ? <Text style={[styles.pnl, slLine.tone === 'up' ? styles.up : styles.down]}>{slLine.text}</Text> : null}
      </View>

      <Text style={styles.note}>{'Reduce-only. Closes the whole position when the price is reached.'}</Text>
      {message ? <Text style={styles.error}>{message}</Text> : null}

      <Pressable
        onPress={update}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Update TP/SL"
        accessibilityState={{ disabled: busy, busy }}
        style={({ pressed }) => [styles.primary, busy && styles.disabled, pressed && styles.pressed]}
      >
        <Text style={styles.primaryText}>{busy ? 'Updating…' : 'Update TP/SL'}</Text>
      </Pressable>
      <Pressable
        onPress={onClose}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        style={({ pressed }) => [styles.keep, pressed && styles.pressed]}
      >
        <Text style={styles.keepText}>{'Cancel'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12, paddingHorizontal: 18, paddingBottom: 8 },
  sub: { color: semantic.text.dim, fontFamily: 'monospace', fontSize: 12 },
  field: { gap: 6 },
  label: { color: semantic.text.faint, fontSize: 12 },
  input: {
    height: 44,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    backgroundColor: tokens.colors.surface,
    color: semantic.text.primary,
    fontFamily: 'monospace',
    fontSize: 16,
  },
  pnl: { fontFamily: 'monospace', fontSize: 12, fontVariant: ['tabular-nums'] },
  up: { color: semantic.sentiment.positive },
  down: { color: semantic.sentiment.negative },
  note: { color: semantic.text.dim, fontSize: 12 },
  error: { color: semantic.sentiment.negative, fontSize: 12 },
  primary: {
    height: 48,
    borderRadius: 8,
    backgroundColor: tokens.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: semantic.background.screen, fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.6 },
  keep: { height: 44, alignItems: 'center', justifyContent: 'center' },
  keepText: { color: semantic.text.dim, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.82 },
});
