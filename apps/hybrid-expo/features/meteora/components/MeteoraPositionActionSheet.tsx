import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type { MeteoraPortfolioPool, MeteoraPosition } from '@myboon/shared/meteora';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { InlineNotice, METEORA_COLORS } from '@/features/meteora/components/MeteoraExecutionControls';
import { meteoraClient } from '@/features/meteora/meteora.client';
import type { MeteoraExecutionUpdate, MeteoraOperationState } from '@/features/meteora/meteora.form';
import { meteoraPositionActionsAdapter } from '@/features/meteora/meteora.position-actions';
import type {
  MeteoraClaimPreview,
  MeteoraPositionSummary,
  MeteoraRemovePreview,
} from '@/features/meteora/meteora.position-actions';
import { useWallet } from '@/hooks/useWallet';

type SheetStep =
  | { kind: 'loading' }
  | { kind: 'picker' }
  | { kind: 'menu' }
  | { kind: 'claim' }
  | { kind: 'remove'; closing: boolean }
  | { kind: 'close_confirm' }
  | { kind: 'error'; message: string };

const REMOVE_PRESETS: { label: string; bps: number }[] = [
  { label: '25%', bps: 2_500 },
  { label: '50%', bps: 5_000 },
  { label: '75%', bps: 7_500 },
  { label: '100%', bps: 10_000 },
];

export function MeteoraPositionActionSheet({
  visible,
  pool,
  onClose,
  onAddLiquidity,
  onChanged,
}: {
  visible: boolean;
  pool: MeteoraPortfolioPool | null;
  onClose: () => void;
  onAddLiquidity: (positionAddress: string) => void;
  /** Called after a claim/remove/close completes so Profile can refresh. */
  onChanged: () => void;
}) {
  const wallet = useWallet();
  const [step, setStep] = useState<SheetStep>({ kind: 'loading' });
  const [positions, setPositions] = useState<MeteoraPosition[]>([]);
  const [selected, setSelected] = useState<MeteoraPosition | null>(null);
  const [removeBps, setRemoveBps] = useState(2_500);
  const [operationState, setOperationState] = useState<MeteoraOperationState>('editing');
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [claimPreview, setClaimPreview] = useState<MeteoraClaimPreview | null>(null);
  const [removePreview, setRemovePreview] = useState<MeteoraRemovePreview | null>(null);

  const resetAndClose = useCallback(() => {
    setStep({ kind: 'loading' });
    setPositions([]);
    setSelected(null);
    setRemoveBps(2_500);
    setOperationState('editing');
    setOperationMessage(null);
    setClaimPreview(null);
    setRemovePreview(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!visible || !pool) return;
    let cancelled = false;
    setStep({ kind: 'loading' });
    (async () => {
      try {
        if (!wallet.address) throw new Error('Connect a Solana wallet to manage this position.');
        const result = await meteoraClient.getPositions(pool.poolAddress, wallet.address, {
          status: 'open',
          page: 1,
          pageSize: 20,
        });
        if (cancelled) return;
        const open = result.data.items.filter((position) => !position.isClosed);
        setPositions(open);
        if (open.length === 0) {
          setStep({ kind: 'error', message: 'This position is no longer open. Pull to refresh Profile.' });
        } else if (open.length === 1) {
          setSelected(open[0]);
          setStep({ kind: 'menu' });
        } else {
          setStep({ kind: 'picker' });
        }
      } catch (error) {
        if (cancelled) return;
        setStep({
          kind: 'error',
          message: error instanceof Error ? error.message : 'This position could not be loaded.',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, pool, wallet.address]);

  const summary: MeteoraPositionSummary | null = useMemo(() => {
    if (!selected || !pool) return null;
    return {
      positionAddress: selected.address,
      poolAddress: pool.poolAddress,
      lowerBinId: selected.lowerBinId,
      upperBinId: selected.upperBinId,
      activeBinId: selected.activeBinId,
      isOutOfRange: selected.isOutOfRange,
    };
  }, [selected, pool]);

  const prepareContext = useCallback(() => {
    if (!pool) throw new Error('No pool selected.');
    return {
      pool: {
        address: pool.poolAddress,
        pair: pool.pair,
        // The portfolio endpoint doesn't provide decimals/verified (see
        // MeteoraTokenRef), but this fake MeteoraPoolDetail is only used to
        // reach the position-action adapters below, which never read those
        // two fields off pool.tokenX/tokenY — confirmed no consumer does.
        // Fall back to a safe default rather than widen MeteoraPoolDetail's
        // real (non-nullable) contract, which live execution paths rely on.
        tokenX: { ...pool.tokenX, decimals: pool.tokenX.decimals ?? 0, verified: pool.tokenX.verified ?? false },
        tokenY: { ...pool.tokenY, decimals: pool.tokenY.decimals ?? 0, verified: pool.tokenY.verified ?? false },
        currentPrice: pool.currentPrice,
        tvlUsd: null,
        volume24hUsd: null,
        fees24hUsd: null,
        feeTvl24hPct: null,
        baseFeePct: pool.baseFeePct,
        dynamicFeePct: null,
        apr24hPct: null,
        apy24hPct: null,
        binStep: pool.binStep,
        hasFarm: false,
        tags: [],
        approvedByMeteora: true,
        reserveX: '0',
        reserveY: '0',
        tokenXAmount: null,
        tokenYAmount: null,
        maxFeePct: null,
        protocolFeePct: null,
        collectFeeMode: 0,
        rewardMintX: null,
        rewardMintY: null,
        createdAt: null,
      },
      poolFreshness: { state: 'fresh' as const, source: 'meteora_data_api' as const, servedAt: new Date().toISOString(), ageMs: 0 },
      walletAddress: wallet.address,
      wallet: {
        connected: wallet.connected,
        address: wallet.address,
        source: wallet.source,
        isPreparing: 'isPreparing' in wallet ? wallet.isPreparing : false,
        signAndSendTransaction: typeof wallet.signAndSendTransaction === 'function'
          ? (transaction: unknown) => (
            wallet.signAndSendTransaction as (value: unknown) => Promise<unknown>
          )(transaction)
          : null,
      },
      connection: wallet.connection,
      getWalletSnapshot: () => ({
        connected: wallet.connected,
        address: wallet.address,
        source: wallet.source,
        isPreparing: 'isPreparing' in wallet ? wallet.isPreparing : false,
        signAndSendTransaction: typeof wallet.signAndSendTransaction === 'function'
          ? (transaction: unknown) => (
            wallet.signAndSendTransaction as (value: unknown) => Promise<unknown>
          )(transaction)
          : null,
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, wallet.address, wallet.connected, wallet.source, wallet.connection]);

  const openClaim = useCallback(async () => {
    if (!summary) return;
    setStep({ kind: 'claim' });
    setOperationState('preparing');
    setOperationMessage(null);
    try {
      const preview = await meteoraPositionActionsAdapter.prepareClaim(prepareContext(), summary);
      setClaimPreview(preview);
      setOperationState('ready');
    } catch (error) {
      setOperationState('error');
      setOperationMessage(error instanceof Error ? error.message : 'Unable to prepare claim.');
    }
  }, [summary, prepareContext]);

  const openRemove = useCallback((closing: boolean) => {
    if (!summary) return;
    setRemoveBps(closing ? 10_000 : 2_500);
    setRemovePreview(null);
    setOperationState('editing');
    setOperationMessage(null);
    setStep({ kind: 'remove', closing });
  }, [summary]);

  const prepareRemovePreview = useCallback(async (bps: number, closing: boolean) => {
    if (!summary) return;
    setOperationState('preparing');
    setOperationMessage(null);
    try {
      const preview = await meteoraPositionActionsAdapter.prepareRemove(
        prepareContext(),
        summary,
        bps,
        closing,
      );
      setRemovePreview(preview);
      setOperationState('ready');
    } catch (error) {
      setOperationState('error');
      setOperationMessage(error instanceof Error ? error.message : 'Unable to prepare removal.');
    }
  }, [summary, prepareContext]);

  const handleClaim = useCallback(async () => {
    if (!claimPreview) return;
    setOperationState('awaiting_wallet');
    setOperationMessage('Approve the claim in your wallet.');
    try {
      const result = await meteoraPositionActionsAdapter.executeClaim(
        prepareContext(),
        claimPreview,
        (update: MeteoraExecutionUpdate) => {
          setOperationState(update.state);
          setOperationMessage(update.message);
        },
      );
      setOperationState(result.state === 'confirmed' ? 'success' : result.state === 'cancelled' ? 'editing' : 'submitted');
      setOperationMessage(result.message);
      if (result.state === 'confirmed') onChanged();
    } catch (error) {
      setOperationState('error');
      setOperationMessage(error instanceof Error ? error.message : 'Claim could not be completed.');
    }
  }, [claimPreview, prepareContext, onChanged]);

  const handleRemove = useCallback(async () => {
    if (!removePreview) return;
    setOperationState('awaiting_wallet');
    setOperationMessage(
      removePreview.claimAndClose
        ? 'Approve the close in your wallet.'
        : 'Approve the removal in your wallet.',
    );
    try {
      const result = await meteoraPositionActionsAdapter.executeRemove(
        prepareContext(),
        removePreview,
        (update: MeteoraExecutionUpdate) => {
          setOperationState(update.state);
          setOperationMessage(update.message);
        },
      );
      setOperationState(result.state === 'confirmed' ? 'success' : result.state === 'cancelled' ? 'editing' : 'submitted');
      setOperationMessage(result.message);
      if (result.state === 'confirmed') onChanged();
    } catch (error) {
      setOperationState('error');
      setOperationMessage(error instanceof Error ? error.message : 'Removal could not be completed.');
    }
  }, [removePreview, prepareContext, onChanged]);

  if (!pool) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={resetAndClose}
    >
      <Pressable style={styles.backdrop} onPress={resetAndClose} accessibilityLabel="Close position actions">
        <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <View style={styles.handle} />
          <Text style={styles.title} accessibilityRole="header">{pool.pair}</Text>
          <Text style={styles.subtitle}>
            {formatUsd(pool.balanceUsd)} current balance
          </Text>

          {step.kind === 'loading' ? (
            <View style={styles.centerBlock}>
              <ActivityIndicator color={METEORA_COLORS.cyan} />
              <Text style={styles.centerText}>Loading position…</Text>
            </View>
          ) : step.kind === 'error' ? (
            <View style={styles.centerBlock}>
              <MaterialIcons name="error-outline" size={22} color={METEORA_COLORS.red} />
              <Text style={styles.centerText}>{step.message}</Text>
            </View>
          ) : step.kind === 'picker' ? (
            <PositionPicker
              positions={positions}
              onSelect={(position) => {
                setSelected(position);
                setStep({ kind: 'menu' });
              }}
            />
          ) : step.kind === 'menu' ? (
            <ActionMenu
              position={selected}
              onAdd={() => {
                if (selected) onAddLiquidity(selected.address);
              }}
              onClaim={() => { void openClaim(); }}
              onRemove={() => openRemove(false)}
              onClose={() => setStep({ kind: 'close_confirm' })}
            />
          ) : step.kind === 'claim' ? (
            <ClaimFlow
              operationState={operationState}
              operationMessage={operationMessage}
              onConfirm={() => { void handleClaim(); }}
              onBack={() => setStep({ kind: 'menu' })}
            />
          ) : step.kind === 'remove' ? (
            <RemoveFlow
              closing={step.closing}
              removeBps={removeBps}
              preview={removePreview}
              operationState={operationState}
              operationMessage={operationMessage}
              onChangeBps={(bps) => {
                setRemoveBps(bps);
                if (bps === 10_000 && !step.closing) {
                  // Selecting 100% on the Remove-liquidity sheet must not
                  // behave like a routine partial removal — route into the
                  // same destructive Close confirmation used by the
                  // dedicated "Close position" action (TC-POS-004). Confirming
                  // there calls openRemove(true), which prepares the
                  // claimAndClose preview fresh, so no preview fetch is
                  // needed here.
                  setStep({ kind: 'close_confirm' });
                  return;
                }
                void prepareRemovePreview(bps, step.closing);
              }}
              onPrepare={() => { void prepareRemovePreview(removeBps, step.closing); }}
              onConfirm={() => { void handleRemove(); }}
              onBack={() => setStep({ kind: 'menu' })}
            />
          ) : (
            <CloseConfirm
              onCancel={() => {
                // Back out of the destructive confirmation into a plain
                // (non-100%) remove step rather than dropping straight to
                // the menu, so a user who reaches Close via the 100% preset
                // can still pick a smaller percentage instead.
                setRemoveBps(2_500);
                setRemovePreview(null);
                setOperationState('editing');
                setOperationMessage(null);
                setStep({ kind: 'remove', closing: false });
              }}
              onConfirm={() => openRemove(true)}
            />
          )}

          {operationState === 'success' ? (
            <Pressable onPress={resetAndClose} style={styles.doneButton} accessibilityRole="button">
              <Text style={styles.doneButtonText}>Done</Text>
            </Pressable>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function PositionPicker({
  positions,
  onSelect,
}: {
  positions: MeteoraPosition[];
  onSelect: (position: MeteoraPosition) => void;
}) {
  return (
    <View style={styles.menuList}>
      <Text style={styles.sectionCaption}>This pool has {positions.length} open positions. Choose one.</Text>
      {positions.map((position) => (
        <Pressable
          key={position.address}
          onPress={() => onSelect(position)}
          accessibilityRole="button"
          accessibilityLabel={`Position ${position.minPrice} to ${position.maxPrice}. ${position.isOutOfRange ? 'Out of range' : 'In range'}.`}
          style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
        >
          <View style={styles.menuItemCopy}>
            <Text style={styles.menuItemTitle}>{formatRange(position.minPrice, position.maxPrice)}</Text>
            <Text style={styles.menuItemSubtitle}>
              {position.isOutOfRange === null ? 'Status unavailable' : position.isOutOfRange ? 'Out of range' : 'In range'}
            </Text>
          </View>
          <MaterialIcons name="chevron-right" size={20} color={METEORA_COLORS.textFaint} />
        </Pressable>
      ))}
    </View>
  );
}

function ActionMenu({
  position,
  onAdd,
  onClaim,
  onRemove,
  onClose,
}: {
  position: MeteoraPosition | null;
  onAdd: () => void;
  onClaim: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  return (
    <View style={styles.menuList}>
      {position ? (
        <View style={styles.rangeContext}>
          <MaterialIcons
            name={position.isOutOfRange ? 'error-outline' : 'check-circle'}
            size={15}
            color={position.isOutOfRange ? METEORA_COLORS.amber : METEORA_COLORS.green}
          />
          <Text style={styles.rangeContextText}>
            {formatRange(position.minPrice, position.maxPrice)} · {position.isOutOfRange === null ? 'Status unavailable' : position.isOutOfRange ? 'Out of range' : 'In range'}
          </Text>
        </View>
      ) : null}
      <ActionRow
        icon="add-circle-outline"
        label="Add liquidity"
        description="Deposit more into this position's existing range."
        onPress={onAdd}
      />
      <ActionRow
        icon="payments"
        label="Claim fees"
        description="Collect unclaimed fees and rewards."
        onPress={onClaim}
      />
      <ActionRow
        icon="remove-circle-outline"
        label="Remove liquidity"
        description="Withdraw part of this position."
        onPress={onRemove}
      />
      <ActionRow
        icon="close"
        label="Close position"
        description="Remove everything and close the account."
        destructive
        onPress={onClose}
      />
    </View>
  );
}

function ActionRow({
  icon,
  label,
  description,
  destructive,
  onPress,
}: {
  icon: keyof typeof MaterialIcons.glyphMap;
  label: string;
  description: string;
  destructive?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description}
      style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
    >
      <MaterialIcons name={icon} size={20} color={destructive ? METEORA_COLORS.red : METEORA_COLORS.cyan} />
      <View style={styles.menuItemCopy}>
        <Text style={[styles.menuItemTitle, destructive && styles.menuItemTitleDestructive]}>{label}</Text>
        <Text style={styles.menuItemSubtitle}>{description}</Text>
      </View>
      <MaterialIcons name="chevron-right" size={20} color={METEORA_COLORS.textFaint} />
    </Pressable>
  );
}

function ClaimFlow({
  operationState,
  operationMessage,
  onConfirm,
  onBack,
}: {
  operationState: MeteoraOperationState;
  operationMessage: string | null;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const busy = operationState === 'preparing'
    || operationState === 'building'
    || operationState === 'simulating'
    || operationState === 'awaiting_wallet'
    || operationState === 'submitted'
    || operationState === 'confirming'
    || operationState === 'syncing';
  return (
    <View style={styles.flowBody}>
      <InlineNotice
        tone="info"
        title="Claim fees and rewards"
        message="This claims all unclaimed fees and rewards on this position. It does not remove liquidity or close the position."
      />
      {operationMessage ? (
        <InlineNotice
          tone={operationState === 'success' ? 'success' : operationState === 'error' ? 'error' : 'pending'}
          title={operationState === 'success' ? 'Complete' : operationState === 'error' ? 'Needs attention' : 'Status'}
          message={operationMessage}
        />
      ) : null}
      {operationState !== 'success' ? (
        <View style={styles.flowActions}>
          <Pressable onPress={onBack} style={styles.secondaryButton} accessibilityRole="button" disabled={busy}>
            <Text style={styles.secondaryButtonText}>Back</Text>
          </Pressable>
          <Pressable
            onPress={onConfirm}
            style={[styles.primaryButton, busy && styles.primaryButtonDisabled]}
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: busy }}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color={METEORA_COLORS.text} />
            ) : (
              <Text style={styles.primaryButtonText}>Claim</Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function RemoveFlow({
  closing,
  removeBps,
  preview,
  operationState,
  operationMessage,
  onChangeBps,
  onPrepare,
  onConfirm,
  onBack,
}: {
  closing: boolean;
  removeBps: number;
  preview: MeteoraRemovePreview | null;
  operationState: MeteoraOperationState;
  operationMessage: string | null;
  onChangeBps: (bps: number) => void;
  onPrepare: () => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  useEffect(() => {
    onPrepare();
    // Prepare a preview once when the flow opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = operationState === 'preparing'
    || operationState === 'building'
    || operationState === 'simulating'
    || operationState === 'awaiting_wallet'
    || operationState === 'submitted'
    || operationState === 'confirming'
    || operationState === 'syncing';

  return (
    <View style={styles.flowBody}>
      {!closing ? (
        <View style={styles.presetRow}>
          {REMOVE_PRESETS.map((preset) => {
            const active = preset.bps === removeBps;
            return (
              <Pressable
                key={preset.bps}
                onPress={() => onChangeBps(preset.bps)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Remove ${preset.label}`}
                style={[styles.presetChip, active && styles.presetChipActive]}
              >
                <Text style={[styles.presetChipText, active && styles.presetChipTextActive]}>{preset.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <InlineNotice
          tone="warning"
          title="Closing removes 100%"
          message="This removes all liquidity, claims eligible fees and rewards, and closes the position account."
        />
      )}
      <InlineNotice
        tone="info"
        title="Before you sign"
        message="Liquidity from the active bin cannot be withdrawn as only one token — the exact output mix is confirmed by simulation before you sign."
      />
      {preview ? (
        <View style={styles.previewBox}>
          <Text style={styles.previewLabel}>Removing</Text>
          <Text style={styles.previewValue}>{(preview.removeBps / 100).toFixed(2)}% of this position</Text>
          <Text style={styles.previewLabel}>Transaction steps</Text>
          <Text style={styles.previewValue}>{preview.transactionCount}</Text>
        </View>
      ) : null}
      {operationMessage ? (
        <InlineNotice
          tone={operationState === 'success' ? 'success' : operationState === 'error' ? 'error' : 'pending'}
          title={operationState === 'success' ? 'Complete' : operationState === 'error' ? 'Needs attention' : 'Status'}
          message={operationMessage}
        />
      ) : null}
      {operationState !== 'success' ? (
        <View style={styles.flowActions}>
          <Pressable onPress={onBack} style={styles.secondaryButton} accessibilityRole="button" disabled={busy}>
            <Text style={styles.secondaryButtonText}>Back</Text>
          </Pressable>
          <Pressable
            onPress={onConfirm}
            style={[
              styles.primaryButton,
              (busy || !preview) && styles.primaryButtonDisabled,
              closing && styles.primaryButtonDestructive,
            ]}
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: busy || !preview }}
            disabled={busy || !preview}
          >
            {busy ? (
              <ActivityIndicator size="small" color={METEORA_COLORS.text} />
            ) : (
              <Text style={styles.primaryButtonText}>{closing ? 'Close position' : 'Remove liquidity'}</Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function CloseConfirm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <View style={styles.flowBody}>
      <InlineNotice
        tone="error"
        title="Close this position?"
        message="This is a destructive action. It removes 100% of your liquidity, claims eligible fees and rewards, and closes the position account. This cannot be undone."
      />
      <View style={styles.flowActions}>
        <Pressable onPress={onCancel} style={styles.secondaryButton} accessibilityRole="button">
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          style={[styles.primaryButton, styles.primaryButtonDestructive]}
          accessibilityRole="button"
          accessibilityLabel="Confirm close position"
          accessibilityHint="This is destructive and cannot be undone"
        >
          <Text style={styles.primaryButtonText}>Yes, close position</Text>
        </Pressable>
      </View>
    </View>
  );
}

function formatRange(minPrice: string, maxPrice: string): string {
  return `${formatPrice(minPrice)} – ${formatPrice(maxPrice)}`;
}

function formatPrice(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  if (amount === 0) return '0';
  return Math.abs(amount) >= 1
    ? amount.toLocaleString('en-US', { maximumFractionDigits: 4 })
    : amount.toPrecision(5);
}

function formatUsd(value: string | null | undefined): string {
  const amount = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(amount)) return 'Unavailable';
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: Math.abs(amount) >= 100_000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(amount) >= 1_000 ? 1 : 2,
  });
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(6,10,22,0.62)',
  },
  sheet: {
    maxHeight: '82%',
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 28,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: METEORA_COLORS.surface,
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
    gap: 4,
  },
  handle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    marginBottom: 8,
    backgroundColor: METEORA_COLORS.border,
  },
  title: {
    color: METEORA_COLORS.text,
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '800',
  },
  subtitle: {
    marginBottom: 6,
    color: METEORA_COLORS.textDim,
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 15,
  },
  centerBlock: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 20,
  },
  centerText: {
    color: METEORA_COLORS.textDim,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  menuList: {
    gap: 8,
    paddingTop: 8,
  },
  sectionCaption: {
    color: METEORA_COLORS.textDim,
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 4,
  },
  rangeContext: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 4,
  },
  rangeContextText: {
    flex: 1,
    color: METEORA_COLORS.textDim,
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 15,
  },
  menuItem: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 4,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: METEORA_COLORS.border,
  },
  menuItemPressed: {
    backgroundColor: 'rgba(122,108,255,0.08)',
  },
  menuItemCopy: {
    flex: 1,
    minWidth: 0,
  },
  menuItemTitle: {
    color: METEORA_COLORS.text,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700',
  },
  menuItemTitleDestructive: {
    color: METEORA_COLORS.red,
  },
  menuItemSubtitle: {
    marginTop: 2,
    color: METEORA_COLORS.textDim,
    fontSize: 11,
    lineHeight: 15,
  },
  flowBody: {
    gap: 12,
    paddingTop: 10,
  },
  presetRow: {
    flexDirection: 'row',
    gap: 8,
  },
  presetChip: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
    backgroundColor: METEORA_COLORS.surfaceLift,
  },
  presetChipActive: {
    borderColor: METEORA_COLORS.violet,
    backgroundColor: 'rgba(122,108,255,0.16)',
  },
  presetChipText: {
    color: METEORA_COLORS.textDim,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
  presetChipTextActive: {
    color: METEORA_COLORS.text,
  },
  previewBox: {
    gap: 4,
    padding: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(21,27,48,0.58)',
  },
  previewLabel: {
    color: METEORA_COLORS.textFaint,
    fontSize: 9,
    lineHeight: 12,
    textTransform: 'uppercase',
  },
  previewValue: {
    color: METEORA_COLORS.text,
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 4,
  },
  flowActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  secondaryButton: {
    minHeight: 48,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: METEORA_COLORS.surfaceLift,
  },
  secondaryButtonText: {
    color: METEORA_COLORS.textDim,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
  primaryButton: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: METEORA_COLORS.coral,
  },
  primaryButtonDisabled: {
    opacity: 0.6,
  },
  primaryButtonDestructive: {
    backgroundColor: '#793144',
  },
  primaryButtonText: {
    color: METEORA_COLORS.text,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '800',
  },
  doneButton: {
    minHeight: 48,
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#16765B',
  },
  doneButtonText: {
    color: METEORA_COLORS.text,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '800',
  },
});
