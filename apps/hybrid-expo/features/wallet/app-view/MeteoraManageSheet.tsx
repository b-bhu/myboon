/**
 * Wallet app view — Meteora Manage sheet (issue #903, design wallet.html
 * frame "8. App views > Meteora · Manage sheet").
 *
 * This unit holds the sheet shell and the Claim fees option with its confirm
 * slider. Remove liquidity and Claim and close are #904. The pool and the
 * prepare context come from #917 (`useMeteoraPool`, `buildMeteoraPrepareContext`);
 * the claim itself is the existing `meteoraPositionActionsAdapter`.
 *
 * The sheet is mounted only while a position is being managed, so the pool
 * loads on open and closing without a swipe calls neither adapter action.
 */

import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { meteoraPositionActionsAdapter } from '@/features/meteora/meteora.position-actions';
import { SwipeToConfirm } from '@/features/markets/action/SwipeToConfirm';
import { WalletSecondarySheet } from '@/features/wallet/WalletSecondarySheet';
import { useWallet } from '@/hooks/useWallet';
import { NO_DATA } from '@/lib/format';
import { semantic, tokens } from '@/theme';
import type { WalletMeteoraPosition } from '@myboon/shared/wallet-summary';
import { buildMeteoraPrepareContext, toMeteoraPositionSummary } from './meteora-manage';
import { usd } from './meteora-top';
import { useMeteoraPool } from './useMeteoraPool';

/** Subline under the title: the card's bin tag, then the range state when known. */
export function manageSubline(position: WalletMeteoraPosition): string {
  const bins = `Bins ${position.lowerBinId} to ${position.upperBinId}`;
  if (position.outOfRange === null) return bins;
  return `${bins} · ${position.outOfRange ? 'out of range' : 'in range'}`;
}

export function MeteoraManageSheet({
  position,
  onClose,
  onChanged,
}: {
  /** The position being managed (the tapped card). */
  position: WalletMeteoraPosition;
  onClose: () => void;
  /** Called after a successful claim so the positions reload. */
  onChanged: () => void;
}) {
  const wallet = useWallet();
  const { pool, freshness, loading, error: poolError, retry: retryPool } = useMeteoraPool(position.poolAddress);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  const fees = position.poolUnclaimedFeesUsd === null ? NO_DATA : usd(position.poolUnclaimedFeesUsd);

  const claim = useCallback(async () => {
    if (!pool || !freshness || running) return;
    setRunning(true);
    setClaimError(null);
    setProgress(null);
    try {
      const context = buildMeteoraPrepareContext(pool, freshness, wallet);
      const preview = await meteoraPositionActionsAdapter.prepareClaim(context, toMeteoraPositionSummary(position));
      await meteoraPositionActionsAdapter.executeClaim(context, preview, (update) => setProgress(update.message));
      setRunning(false);
      onChanged();
      onClose();
    } catch (error) {
      setRunning(false);
      setProgress(null);
      setClaimError(error instanceof Error ? error.message : 'Claim failed.');
    }
  }, [pool, freshness, running, wallet, position, onChanged, onClose]);

  return (
    <WalletSecondarySheet visible title={`Manage · ${position.poolName}`} onClose={onClose} busy={running}>
      <Text style={styles.subline}>{manageSubline(position)}</Text>

      {pool === null && poolError !== null ? (
        <View style={styles.note}>
          <Text style={styles.noteText}>{'Nothing to show until Meteora loads.'}</Text>
          <Pressable onPress={retryPool} accessibilityRole="button" accessibilityLabel="Retry Meteora pool" hitSlop={8}>
            <Text style={styles.retryLabel}>{'Retry →'}</Text>
          </Pressable>
        </View>
      ) : pool === null || loading && freshness === null ? (
        <ActivityIndicator color={tokens.colors.accent} />
      ) : (
        <>
          {/* Mock ".opt.on": the one option here, selected on open. */}
          <View
            accessibilityRole="button"
            accessibilityState={{ selected: true }}
            accessibilityLabel={`Claim fees ${fees}`}
            style={styles.option}
          >
            <Text style={styles.optionName}>{'Claim fees'}</Text>
            <Text style={styles.optionValue}>{fees}</Text>
          </View>

          {claimError === null ? null : (
            <View style={styles.note}>
              <Text style={styles.errorText}>{claimError}</Text>
              <Pressable onPress={() => void claim()} accessibilityRole="button" accessibilityLabel="Retry claim" hitSlop={8}>
                <Text style={styles.retryLabel}>{'Retry →'}</Text>
              </Pressable>
            </View>
          )}

          <Text style={styles.swipeCaption}>{'Swipe to confirm'}</Text>
          <SwipeToConfirm
            label={running && progress !== null ? progress : `Claim fees · ${fees}`}
            accent="accent"
            disabled={running}
            onComplete={() => void claim()}
          />
        </>
      )}
    </WalletSecondarySheet>
  );
}

const styles = StyleSheet.create({
  // Design ".sheet .sub": dim 14.
  subline: { color: semantic.text.dim, fontSize: 14 },
  // Design ".opt.on": hairline box in the app accent, name left, mono value right.
  option: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.colors.accent,
  },
  optionName: { color: semantic.text.primary, fontSize: 14, fontWeight: '600' },
  optionValue: {
    color: semantic.text.primary,
    fontFamily: 'monospace',
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  // Design ".swipe .lbl small": mono 10.5 dim caps.
  swipeCaption: {
    color: semantic.text.dim,
    fontFamily: 'monospace',
    fontSize: 10.5,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  note: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  noteText: { color: semantic.text.dim, fontSize: 12, textAlign: 'center' },
  errorText: { color: semantic.sentiment.negative, fontSize: 12, textAlign: 'center' },
  retryLabel: { color: tokens.colors.primaryDim, fontSize: 12, fontWeight: '600' },
});
