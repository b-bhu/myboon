/**
 * Wallet app view — Meteora Manage sheet (issues #903 and #904, design
 * wallet.html frame "8. App views > Meteora · Manage sheet").
 *
 * The sheet shell, the three options (Claim fees #903; Remove liquidity with
 * its 25 / 50 / 75 / Max chips and Claim and close #904) and one confirm
 * slider. The pool and the prepare context come from #917 (`useMeteoraPool`,
 * `buildMeteoraPrepareContext`); the actions are the existing
 * `meteoraPositionActionsAdapter`. Claim fees is selected on open; choosing
 * Remove liquidity starts at 50%.
 *
 * The sheet is mounted only while a position is being managed, so the pool
 * loads on open and closing without a swipe calls no adapter action.
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

type ManageOption = 'claim' | 'remove' | 'close';

/** Remove presets in percent; 100 is the "Max" chip. */
const REMOVE_PRESETS = [25, 50, 75, 100] as const;

export function MeteoraManageSheet({
  position,
  valueUsd,
  onClose,
  onChanged,
}: {
  /** The position being managed (the tapped card). */
  position: WalletMeteoraPosition;
  /** The card value: the owning pool's `valueUsd` (#902); null when unknown. */
  valueUsd: number | null;
  onClose: () => void;
  /** Called after a successful action so the positions reload. */
  onChanged: () => void;
}) {
  const wallet = useWallet();
  const { pool, freshness, error: poolError, retry: retryPool } = useMeteoraPool(position.poolAddress);
  const [option, setOption] = useState<ManageOption>('claim');
  const [preset, setPreset] = useState<number>(50);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const feesUsd = position.poolUnclaimedFeesUsd;
  const fees = feesUsd === null ? NO_DATA : usd(feesUsd);
  const removed = valueUsd === null ? NO_DATA : `≈ ${usd((valueUsd * preset) / 100)}`;
  // Unknown fees are never guessed: the fees part shows the no-data glyph.
  const closeValue =
    valueUsd === null
      ? NO_DATA
      : feesUsd === null
        ? `${usd(valueUsd)} + ${NO_DATA}`
        : usd(valueUsd + feesUsd);
  const bigLine =
    option === 'claim'
      ? `Claim fees · ${fees}`
      : option === 'remove'
        ? `Remove ${preset}% · ${removed}`
        : `Claim and close · ${closeValue}`;

  // "Retry →" only clears the error so the slider is armed again; every
  // action needs a fresh swipe on the option and preset chosen at that time.
  const run = useCallback(async () => {
    if (!pool || !freshness || running) return;
    setRunning(true);
    setActionError(null);
    setProgress(null);
    const onProgress = (update: { message: string }) => setProgress(update.message);
    try {
      const context = buildMeteoraPrepareContext(pool, freshness, wallet);
      const summary = toMeteoraPositionSummary(position);
      if (option === 'claim') {
        const preview = await meteoraPositionActionsAdapter.prepareClaim(context, summary);
        await meteoraPositionActionsAdapter.executeClaim(context, preview, onProgress);
      } else {
        const claimAndClose = option === 'close';
        const preview = await meteoraPositionActionsAdapter.prepareRemove(
          context,
          summary,
          claimAndClose ? 10_000 : preset * 100,
          claimAndClose,
        );
        await meteoraPositionActionsAdapter.executeRemove(context, preview, onProgress);
      }
      setRunning(false);
      onChanged();
      onClose();
    } catch (error) {
      setRunning(false);
      setProgress(null);
      setActionError(error instanceof Error ? error.message : 'The action failed.');
    }
  }, [pool, freshness, running, wallet, position, option, preset, onChanged, onClose]);

  const choose = (next: ManageOption) => {
    if (!running) setOption(next);
  };

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
      ) : pool === null || freshness === null ? (
        <ActivityIndicator color={tokens.colors.accent} />
      ) : (
        <>
          {/* Mock ".opt": one row per option; the selected one carries the accent edge. */}
          <Pressable
            onPress={() => choose('claim')}
            accessibilityRole="button"
            accessibilityState={{ selected: option === 'claim' }}
            accessibilityLabel={`Claim fees ${fees}`}
            style={[styles.option, option === 'claim' && styles.optionOn]}
          >
            <View style={styles.optionHead}>
              <Text style={styles.optionName}>{'Claim fees'}</Text>
              <Text style={styles.optionValue}>{fees}</Text>
            </View>
          </Pressable>

          <Pressable
            onPress={() => choose('remove')}
            accessibilityRole="button"
            accessibilityState={{ selected: option === 'remove' }}
            accessibilityLabel={`Remove liquidity ${removed}`}
            style={[styles.option, option === 'remove' && styles.optionOn]}
          >
            <View style={styles.optionHead}>
              <Text style={styles.optionName}>{'Remove liquidity'}</Text>
              <Text style={styles.optionValue}>{removed}</Text>
            </View>
            <View style={styles.chips}>
              {REMOVE_PRESETS.map((value) => {
                const on = option === 'remove' && preset === value;
                return (
                  <Pressable
                    key={value}
                    onPress={() => {
                      if (running) return;
                      setOption('remove');
                      setPreset(value);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    style={[styles.chip, on && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{value === 100 ? 'Max' : `${value}%`}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Pressable>

          <Pressable
            onPress={() => choose('close')}
            accessibilityRole="button"
            accessibilityState={{ selected: option === 'close' }}
            accessibilityLabel={`Claim and close ${closeValue}`}
            style={[styles.option, option === 'close' && styles.optionOn]}
          >
            <View style={styles.optionHead}>
              <Text style={styles.optionName}>{'Claim and close'}</Text>
              <Text style={styles.optionValue}>{closeValue}</Text>
            </View>
          </Pressable>

          {actionError === null ? null : (
            <View style={styles.note}>
              <Text style={styles.errorText}>{actionError}</Text>
              <Pressable onPress={() => setActionError(null)} accessibilityRole="button" accessibilityLabel="Retry action" hitSlop={8}>
                <Text style={styles.retryLabel}>{'Retry →'}</Text>
              </Pressable>
            </View>
          )}

          <Text style={styles.swipeCaption}>{'Swipe to confirm'}</Text>
          <SwipeToConfirm
            label={running && progress !== null ? progress : bigLine}
            accent="accent"
            disabled={running}
            onComplete={() => void run()}
          />
        </>
      )}
    </WalletSecondarySheet>
  );
}

const styles = StyleSheet.create({
  // Design ".sheet .sub": dim 14.
  subline: { color: semantic.text.dim, fontSize: 14 },
  // Design ".opt": hairline box, 8 radius, pad 12; ".opt.on" takes the accent edge.
  option: {
    gap: 8,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
  },
  optionOn: { borderColor: tokens.colors.accent },
  optionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  optionName: { color: semantic.text.primary, fontSize: 14, fontWeight: '600' },
  optionValue: {
    color: semantic.text.primary,
    fontFamily: 'monospace',
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  // Design ".chips.l": left-aligned pills, 32 tall; ".on" takes the accent.
  chips: { flexDirection: 'row', gap: 6 },
  chip: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipOn: { borderColor: tokens.colors.accent },
  chipText: { color: semantic.text.dim, fontSize: 12, fontWeight: '600' },
  chipTextOn: { color: tokens.colors.accent },
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
