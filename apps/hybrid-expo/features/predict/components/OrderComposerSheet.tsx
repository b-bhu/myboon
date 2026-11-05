import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  buildComposerReview,
  clampLimitPrice,
} from '@/features/predict/components/orderComposerMath';
import { getMinimumOrderGuardrail } from '@/features/predict/minimumOrderSize';
import type { PredictOrderGuardrail } from '@/features/predict/predictActivityState';
import { truncateUsd } from '@/features/predict/formatPredictMoney';
import { usePredictQuickAmounts } from '@/features/predict/usePredictQuickAmounts';
import { semantic, tokens } from '@/theme';

/**
 * Shared order composer (Predict redesign PRD §6) — one bottom sheet used by
 * every market type. Pilot: Yes/No detail behind the composerV2 flag.
 *
 * Market mode quotes from the live book via the screen; Limit mode rests a
 * GTC order (client-side GTD plumbing is a flagged follow-up in the PRD).
 * Copy is frozen per docs/mockups/polymarket-mockups.md.
 */

export type ComposerMode = 'market' | 'limit';

export interface OrderComposerSheetProps {
  visible: boolean;
  side: 'yes' | 'no';
  pickLabel?: string;
  question?: string | null;
  /** Current outcome price 0–1 (drives default limit price). */
  currentPrice: number | null;
  amount: string;
  onAmountChange: (amount: string) => void;
  /** Live executable average price for market mode (from orderbookQuote.ts), null when unknown. */
  executableAvgPrice: number | null;
  /** Live per-market minimum share quantity from Polymarket's order book. */
  minimumOrderSize?: number | null;
  availableCash: number | null;
  guardrail?: PredictOrderGuardrail | null;
  submitting?: boolean;
  submittingLabel?: string;
  disabled?: boolean;
  quickAmounts?: readonly number[];
  /** Plain-language lifecycle copy for resting limit orders. */
  limitOrderNote?: string;
  onClose: () => void;
  /** Called with the final order parameters once the user confirms. */
  onConfirm: (params: { mode: ComposerMode; limitPriceCents: number }) => void;
}

const DEFAULT_QUICK_AMOUNTS = [5, 10, 20] as const;

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '--';
  return `$${value.toFixed(2)}`;
}

function numpadKey(current: string, key: string): string {
  if (key === '.' && current.includes('.')) return current;
  if (current === '0' && key !== '.') return key;
  const dotIdx = current.indexOf('.');
  if (dotIdx !== -1 && current.length - dotIdx > 2) return current;
  if (current.length >= 7) return current;
  return current + key;
}

function numpadDel(current: string): string {
  if (current.length <= 1) return '0';
  return current.slice(0, -1);
}

function formatAmountInput(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const truncated = Math.trunc(value * 100) / 100;
  return truncated.toFixed(2).replace(/\.00$/u, '').replace(/(\.\d)0$/u, '$1');
}

export function OrderComposerSheet({
  visible,
  side,
  pickLabel,
  question,
  currentPrice,
  amount,
  onAmountChange,
  executableAvgPrice,
  minimumOrderSize = null,
  availableCash,
  guardrail = null,
  submitting = false,
  submittingLabel = 'Placing order...',
  disabled = false,
  quickAmounts: quickAmountsOverride,
  limitOrderNote = 'Rests until it matches. You can cancel it in Open orders.',
  onClose,
  onConfirm,
}: OrderComposerSheetProps) {
  const { quickAmounts: savedQuickAmounts } = usePredictQuickAmounts();
  const quickAmounts = quickAmountsOverride ?? savedQuickAmounts ?? DEFAULT_QUICK_AMOUNTS;
  const [mode, setMode] = useState<ComposerMode>('market');
  const defaultLimitCents = useMemo(
    () => clampLimitPrice((currentPrice ?? 0.5) * 100),
    [currentPrice],
  );
  const [limitCents, setLimitCents] = useState<number>(defaultLimitCents);

  useEffect(() => {
    if (visible) setLimitCents(defaultLimitCents);
  }, [defaultLimitCents, side, visible]);

  const amountNum = parseFloat(amount) || 0;
  const executionPrice = mode === 'market' ? executableAvgPrice : limitCents / 100;
  const review = buildComposerReview({ amount: amountNum, executionPrice });
  const minimumGuardrail = getMinimumOrderGuardrail({
    orderSize: review.shares,
    minimumOrderSize,
    executionPrice,
  });
  const effectiveGuardrail = guardrail?.blocking
    ? guardrail
    : minimumGuardrail ?? guardrail;
  const outcomeLabel = pickLabel ?? (side === 'yes' ? 'YES' : 'NO');
  const isYes = side === 'yes';

  const hasCashLimit = availableCash !== null && Number.isFinite(availableCash);
  const exceedsCash = hasCashLimit && amountNum > (availableCash ?? 0) + 0.000001;
  const inputDisabled = disabled || submitting;
  const confirmDisabled =
    inputDisabled ||
    amountNum <= 0 ||
    exceedsCash ||
    effectiveGuardrail?.blocking === true ||
    review.shares === null;

  const confirmText = submitting
    ? submittingLabel
    : effectiveGuardrail?.blocking
      ? effectiveGuardrail.title
      : exceedsCash
        ? 'Not enough cash'
        : `Buy ${outcomeLabel} · ${formatUsd(review.youPay ?? 0)}`;

  function adjustLimit(deltaCents: number) {
    setLimitCents((prev) => clampLimitPrice(prev + deltaCents));
  }

  function setLimitFromKey(key: string) {
    if (key === 'del') {
      setLimitCents((prev) => Math.max(1, Math.floor(prev / 10)));
      return;
    }
    if (key === '.') return;
    // Append digit to a rolling two-digit entry, clamped to the 1–99 band.
    setLimitCents((prev) => clampLimitPrice((prev % 100) * 10 + Number(key)));
  }

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTouch} accessibilityLabel="Close order sheet" onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} accessibilityElementsHidden />

          {/* Outcome header */}
          <View style={styles.header}>
            <View style={[styles.sideDot, isYes ? styles.dotYes : styles.dotNo]} />
            <View style={styles.headerCopy}>
              <Text style={styles.pickLine} numberOfLines={1}>
                Your pick · {outcomeLabel}
              </Text>
              {question ? (
                <Text style={styles.questionLine} numberOfLines={2}>{question}</Text>
              ) : null}
            </View>
            <Text style={styles.currentPrice}>
              {currentPrice !== null ? `${Math.round(currentPrice * 100)}¢` : '--'}
            </Text>
          </View>

          {/* Market / Limit tabs */}
          <View style={styles.modeTabs} accessibilityRole="tablist">
            {(['market', 'limit'] as const).map((m) => (
              <Pressable
                key={m}
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === m }}
                style={[styles.modeTab, mode === m && styles.modeTabActive]}
                disabled={inputDisabled}
                onPress={() => setMode(m)}>
                <Text style={[styles.modeTabText, mode === m && styles.modeTabTextActive]}>
                  {m === 'market' ? 'Market' : 'Limit'}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Limit price stepper */}
          {mode === 'limit' ? (
            <View style={styles.limitRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Lower limit price by one cent"
                disabled={inputDisabled}
                style={[styles.stepBtn, inputDisabled && styles.disabled]}
                onPress={() => adjustLimit(-1)}>
                <Text style={styles.stepBtnText}>−</Text>
              </Pressable>
              <Text
                style={styles.limitValue}
                accessible
                accessibilityRole="text"
                accessibilityLabel={`Limit price ${limitCents} cents`}>
                {limitCents}¢
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Raise limit price by one cent"
                disabled={inputDisabled}
                style={[styles.stepBtn, inputDisabled && styles.disabled]}
                onPress={() => adjustLimit(1)}>
                <Text style={styles.stepBtnText}>+</Text>
              </Pressable>
            </View>
          ) : null}

          {/* pUSD amount display */}
          <View style={styles.amountDisplay} accessible accessibilityRole="text" accessibilityLabel={`Amount ${amount} pUSD`}>
            <Text style={styles.currencyLabel}>pUSD</Text>
            <Text style={styles.amountValue}>{amount}</Text>
          </View>

          {/* Quick amounts */}
          <View style={styles.quickRow}>
            {quickAmounts.map((q) => (
              <Pressable
                key={q}
                accessibilityRole="button"
                accessibilityLabel={`Set amount to ${q} dollars`}
                disabled={inputDisabled}
                style={[styles.quickBtn, inputDisabled && styles.disabled]}
                onPress={() => onAmountChange(formatAmountInput(q))}>
                <Text style={styles.quickBtnText}>${q}</Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Set amount to maximum available cash"
              disabled={inputDisabled}
              style={[styles.quickBtn, inputDisabled && styles.disabled]}
              onPress={() => onAmountChange(formatAmountInput(availableCash ?? 0))}>
              <Text style={styles.quickBtnText}>Max</Text>
            </Pressable>
          </View>

          {/* Numpad */}
          <View style={styles.grid}>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'].map((key) => (
              <Pressable
                key={key}
                accessibilityRole="keyboardkey"
                accessibilityLabel={key === 'del' ? 'Delete digit' : key === '.' ? 'Decimal point' : `Digit ${key}`}
                disabled={inputDisabled}
                style={[styles.key, inputDisabled && styles.disabled]}
                onPress={() => {
                  if (key === 'del') onAmountChange(numpadDel(amount));
                  else onAmountChange(numpadKey(amount, key));
                }}>
                <Text style={[styles.keyText, key === 'del' && styles.keyTextDel]}>
                  {key === 'del' ? '\u232B' : key}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Review block — copy-frozen per conventions */}
          <View style={styles.reviewCard}>
            <View style={styles.reviewRow}>
              <Text style={styles.reviewLabel}>You pay</Text>
              <Text style={styles.reviewValue}>{review.youPay !== null ? formatUsd(review.youPay) : '--'}</Text>
            </View>
            <View style={styles.reviewRow}>
              <Text style={styles.reviewLabel}>Average price</Text>
              <Text style={styles.reviewValue}>
                {review.averagePriceCents !== null ? `${review.averagePriceCents}¢` : '--'}
              </Text>
            </View>
            <View style={styles.reviewRow}>
              <Text style={styles.reviewLabel}>If you're right</Text>
              <Text style={[styles.reviewValue, styles.positiveText]}>
                {review.payoutIfRight !== null ? formatUsd(review.payoutIfRight) : '--'}
              </Text>
            </View>
            <View style={styles.reviewRow}>
              <Text style={styles.reviewLabel}>Maximum loss</Text>
              <Text style={styles.reviewValue}>
                {review.maximumLoss !== null ? formatUsd(review.maximumLoss) : '--'}
              </Text>
            </View>
            <Text style={styles.explainer}>Each share pays $1.00 if you're right.</Text>
          </View>

          {/* Feedback line */}
          {(effectiveGuardrail || exceedsCash) && (
            <Text style={[styles.feedback, (exceedsCash || effectiveGuardrail?.blocking) && styles.errorText]}>
              {effectiveGuardrail?.message ?? `Not enough cash. ${truncateUsd(availableCash)} available.`}
            </Text>
          )}

          {/* Actions */}
          <View style={styles.actionsRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel order"
              style={[styles.cancelBtn, inputDisabled && styles.disabled]}
              disabled={inputDisabled}
              onPress={onClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={confirmText}
              accessibilityState={{ disabled: confirmDisabled, busy: submitting }}
              style={[
                styles.confirmBtn,
                isYes ? styles.confirmYes : styles.confirmNo,
                confirmDisabled && styles.disabled,
              ]}
              disabled={confirmDisabled}
              onPress={() => onConfirm({ mode, limitPriceCents: limitCents })}>
              <Text style={styles.confirmText}>{confirmText}</Text>
            </Pressable>
          </View>

          {mode === 'limit' ? (
            <Text style={styles.limitNote}>{limitOrderNote}</Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(3,31,44,.72)',
    justifyContent: 'flex-end',
  },
  backdropTouch: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    backgroundColor: tokens.colors.ground,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 14,
    gap: 8,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 999,
    backgroundColor: semantic.text.faint,
    opacity: 0.6,
    marginBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sideDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  dotYes: { backgroundColor: semantic.sentiment.positive },
  dotNo: { backgroundColor: semantic.sentiment.negative },
  headerCopy: {
    flex: 1,
    gap: 1,
  },
  pickLine: {
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '800',
    color: semantic.text.primary,
  },
  questionLine: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.dim,
  },
  currentPrice: {
    fontFamily: 'monospace',
    fontSize: 16,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  modeTabs: {
    flexDirection: 'row',
    backgroundColor: tokens.colors.lift,
    borderRadius: 12,
    padding: 3,
    height: 38,
  },
  modeTab: {
    flex: 1,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeTabActive: {
    backgroundColor: tokens.colors.surface,
  },
  modeTabText: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    color: semantic.text.dim,
  },
  modeTabTextActive: {
    color: semantic.text.primary,
  },
  limitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    paddingVertical: 2,
  },
  stepBtn: {
    width: 44,
    height: 36,
    borderRadius: 10,
    backgroundColor: tokens.colors.lift,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnText: {
    fontFamily: 'monospace',
    fontSize: 20,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  limitValue: {
    fontFamily: 'monospace',
    fontSize: 22,
    fontWeight: '700',
    color: semantic.text.primary,
    minWidth: 64,
    textAlign: 'center',
  },
  amountDisplay: {
    alignItems: 'center',
    paddingVertical: 2,
  },
  currencyLabel: {
    fontFamily: 'monospace',
    fontSize: 9,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  amountValue: {
    fontFamily: 'monospace',
    fontSize: 34,
    fontWeight: '700',
    color: semantic.text.primary,
    letterSpacing: -1,
  },
  quickRow: {
    flexDirection: 'row',
    gap: 6,
  },
  quickBtn: {
    flex: 1,
    height: 38,
    borderRadius: 9,
    backgroundColor: tokens.colors.lift,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickBtnText: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '600',
    color: semantic.text.dim,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  key: {
    width: '31.5%',
    height: 44,
    borderRadius: 12,
    backgroundColor: tokens.colors.lift,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyText: {
    fontFamily: 'monospace',
    fontSize: 19,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  keyTextDel: {
    fontSize: 15,
    color: semantic.text.dim,
  },
  reviewCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 4,
    backgroundColor: tokens.colors.surface,
  },
  reviewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  reviewLabel: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.dim,
  },
  reviewValue: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  positiveText: {
    color: semantic.sentiment.positive,
  },
  explainer: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
    marginTop: 2,
  },
  feedback: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.dim,
  },
  errorText: {
    color: tokens.colors.vermillion,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  cancelBtn: {
    width: 96,
    height: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '700',
    color: semantic.text.dim,
  },
  confirmBtn: {
    flex: 1,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmYes: { backgroundColor: semantic.sentiment.positive },
  confirmNo: { backgroundColor: semantic.sentiment.negative },
  confirmText: {
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '800',
    color: '#fff',
  },
  disabled: {
    opacity: 0.45,
  },
  limitNote: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
    textAlign: 'center',
  },
});
