import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type { MeteoraPoolDetail, MeteoraStrategy } from '@myboon/shared/meteora';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatMeteoraRangePrice } from '@/features/meteora/meteora.form';
import type { MeteoraPhaseTwoPreview } from '@/features/meteora/meteora.form';
import type { MeteoraPreviewCost } from '@/features/meteora/meteora.form';
import { METEORA_COLORS, METEORA_TINTS } from '@/features/meteora/meteora.theme';

export interface MeteoraPositionReviewSheetProps {
  visible: boolean;
  pool: MeteoraPoolDetail | null;
  /** The exact preview snapshot the parent intends to execute. */
  preview: MeteoraPhaseTwoPreview | null;
  strategy: MeteoraStrategy;
  amountX: string;
  amountY: string;
  inverted: boolean;
  addMode: boolean;
  confirmDisabled: boolean;
  blockerMessage?: string | null;
  costs?: MeteoraPreviewCost[];
  transactionCount?: number;
  onClose: () => void;
  onConfirm: () => void;
}

const STRATEGY_LABELS: Record<MeteoraStrategy, string> = {
  spot: 'Spot',
  curve: 'Curve',
  bid_ask: 'Bid Ask',
};

function displayedPrice(value: string | undefined, inverted: boolean): string {
  if (!value) return '—';
  return formatMeteoraRangePrice(value, inverted);
}

function displayedRange(
  minPrice: string | undefined,
  maxPrice: string | undefined,
  inverted: boolean,
): string {
  if (!minPrice || !maxPrice) return '—';
  // Reciprocal quotes reverse the order: 1 / high is the new low.
  const low = inverted ? maxPrice : minPrice;
  const high = inverted ? minPrice : maxPrice;
  return `${displayedPrice(low, inverted)} – ${displayedPrice(high, inverted)}`;
}

function pricesMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber === rightNumber;
  }
  return left === right;
}

function RangeRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} selectable>{value}</Text>
    </View>
  );
}

function AmountRow({ label, amount }: { label: string; amount: string }) {
  return (
    <View style={styles.amountRow}>
      <Text style={styles.amountLabel}>{label}</Text>
      <Text style={styles.amountValue} selectable>{amount || '—'}</Text>
    </View>
  );
}

export function MeteoraPositionReviewSheet({
  visible,
  pool,
  preview,
  strategy,
  amountX,
  amountY,
  inverted,
  addMode,
  confirmDisabled,
  blockerMessage,
  costs,
  transactionCount,
  onClose,
  onConfirm,
}: MeteoraPositionReviewSheetProps) {
  const insets = useSafeAreaInsets();
  const tokenX = pool?.tokenX.symbol ?? 'Token X';
  const tokenY = pool?.tokenY.symbol ?? 'Token Y';
  const quoteLabel = inverted ? `${tokenX} / ${tokenY}` : `${tokenY} / ${tokenX}`;
  const requestedRange = displayedRange(
    preview?.requestedMinPrice,
    preview?.requestedMaxPrice,
    inverted,
  );
  const executableRange = displayedRange(
    preview?.executableMinPrice,
    preview?.executableMaxPrice,
    inverted,
  );
  const hasRequestedRange = Boolean(preview?.requestedMinPrice && preview?.requestedMaxPrice);
  const hasExecutableRange = Boolean(preview?.executableMinPrice && preview?.executableMaxPrice);
  const rangeSnapped = hasRequestedRange && hasExecutableRange && (
    !pricesMatch(preview?.requestedMinPrice, preview?.executableMinPrice)
    || !pricesMatch(preview?.requestedMaxPrice, preview?.executableMaxPrice)
  );
  const displayOnlyExecutableRange = hasExecutableRange && !rangeSnapped;
  const amountRows = inverted
    ? [{ label: tokenY, amount: amountY }, { label: tokenX, amount: amountX }]
    : [{ label: tokenX, amount: amountX }, { label: tokenY, amount: amountY }];
  const strategyLabel = addMode ? 'Spot' : STRATEGY_LABELS[strategy];
  const actionLabel = addMode ? 'Add liquidity' : 'Create position';
  const isConfirmDisabled = confirmDisabled || !preview;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close review">
        <Pressable
          style={styles.sheet}
          onPress={(event) => event.stopPropagation()}
          accessibilityViewIsModal
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.eyebrow}>Meteora</Text>
              <Text style={styles.title} accessibilityRole="header">
                {addMode ? 'Review liquidity' : 'Review position'}
              </Text>
              <Text style={styles.subtitle}>{pool?.pair ?? 'Pool unavailable'}</Text>
            </View>
            <Pressable
              onPress={onClose}
              style={styles.closeButton}
              accessibilityRole="button"
              accessibilityLabel="Close review"
              hitSlop={8}
            >
              <MaterialIcons name="close" size={24} color={METEORA_COLORS.textDim} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
            contentInsetAdjustmentBehavior="automatic"
          >
            {blockerMessage ? (
              <View style={styles.blockerNotice} accessibilityRole="alert">
                <MaterialIcons name="error-outline" size={20} color={METEORA_COLORS.negative} />
                <Text style={styles.blockerText} selectable>{blockerMessage}</Text>
              </View>
            ) : null}

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Position details</Text>
              <View style={styles.card}>
                {amountRows.map((row) => <AmountRow key={row.label} {...row} />)}
                <View style={styles.cardDivider} />
                <RangeRow label="Strategy" value={strategyLabel} />
                <RangeRow label="Quote" value={quoteLabel} />
                {rangeSnapped ? (
                  <>
                    <RangeRow label="Requested range" value={`${requestedRange} ${quoteLabel}`} />
                    <RangeRow label="Executable range" value={`${executableRange} ${quoteLabel}`} />
                  </>
                ) : displayOnlyExecutableRange ? (
                  <RangeRow label="Range" value={`${executableRange} ${quoteLabel}`} />
                ) : hasRequestedRange ? (
                  <RangeRow label="Range" value={`${requestedRange} ${quoteLabel}`} />
                ) : null}
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Transaction estimate</Text>
              {preview ? (
                <View style={styles.card}>
                  <RangeRow label="Bins" value={preview.binCount === undefined ? '—' : String(preview.binCount)} />
                  <RangeRow label="Transactions" value={String(transactionCount ?? preview.transactionCount)} />
                  <View style={styles.cardDivider} />
                  <Text style={styles.subsectionTitle}>Costs</Text>
                  {(costs ?? preview.costs).length === 0 ? (
                    <Text style={styles.emptyText}>Cost estimate unavailable</Text>
                  ) : (costs ?? preview.costs).map((cost) => (
                    <View style={styles.costRow} key={`${cost.label}-${cost.value}`}>
                      <View style={styles.costCopy}>
                        <Text style={styles.detailLabel}>{cost.label}</Text>
                        {cost.refundable ? <Text style={styles.refundable}>Refundable</Text> : null}
                      </View>
                      <Text style={styles.detailValue} selectable>{cost.value}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyText}>Preview unavailable. Edit the position to refresh the quote.</Text>
                </View>
              )}
            </View>

            {preview?.warnings.length ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Warnings</Text>
                <View style={styles.warningList}>
                  {preview.warnings.map((warning) => (
                    <View
                      key={`${warning.code}-${warning.message}`}
                      style={[styles.warningRow, warning.blocking ? styles.blockingWarning : styles.nonBlockingWarning]}
                    >
                      <MaterialIcons
                        name={warning.blocking ? 'error-outline' : 'info-outline'}
                        size={18}
                        color={warning.blocking ? METEORA_COLORS.negative : METEORA_COLORS.warning}
                      />
                      <Text style={styles.warningText} selectable>{warning.message}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </ScrollView>

          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <Text style={styles.walletSentence}>
              Your wallet will ask you to approve this {addMode ? 'liquidity addition' : 'position'}.
            </Text>
            <View style={styles.footerActions}>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressedButton]}
                accessibilityRole="button"
                accessibilityLabel="Cancel and edit"
              >
                <Text style={styles.secondaryButtonText}>{addMode ? 'Edit' : 'Cancel'}</Text>
              </Pressable>
              <Pressable
                onPress={onConfirm}
                disabled={isConfirmDisabled}
                style={({ pressed }) => [
                  styles.primaryButton,
                  isConfirmDisabled && styles.disabledButton,
                  pressed && !isConfirmDisabled && styles.primaryPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
                accessibilityState={{ disabled: isConfirmDisabled }}
              >
                <Text style={[styles.primaryButtonText, isConfirmDisabled && styles.disabledButtonText]}>
                  {actionLabel}
                </Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: METEORA_TINTS.backdrop,
  },
  sheet: {
    maxHeight: '90%',
    minHeight: 260,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: METEORA_COLORS.surface,
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
    overflow: 'hidden',
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    marginTop: 10,
    marginBottom: 4,
    borderRadius: 2,
    backgroundColor: METEORA_COLORS.border,
  },
  header: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: METEORA_COLORS.border,
  },
  headerCopy: { flex: 1, gap: 2 },
  eyebrow: {
    color: METEORA_COLORS.accent,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: {
    color: METEORA_COLORS.text,
    fontSize: 21,
    lineHeight: 26,
    fontWeight: '800',
  },
  subtitle: {
    color: METEORA_COLORS.textDim,
    fontSize: 13,
    lineHeight: 18,
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  scroll: { flexShrink: 1 },
  content: { gap: 18, padding: 20, paddingBottom: 24 },
  section: { gap: 8 },
  sectionTitle: {
    color: METEORA_COLORS.textDim,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  card: {
    gap: 12,
    padding: 16,
    borderRadius: 16,
    backgroundColor: METEORA_COLORS.surfaceRaised,
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
  },
  amountRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  amountLabel: { color: METEORA_COLORS.textDim, fontSize: 14, fontWeight: '700' },
  amountValue: {
    color: METEORA_COLORS.text,
    fontFamily: 'monospace',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'right',
    flexShrink: 1,
  },
  cardDivider: { height: StyleSheet.hairlineWidth, backgroundColor: METEORA_COLORS.border },
  detailRow: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  detailLabel: { color: METEORA_COLORS.textDim, fontSize: 13, lineHeight: 18 },
  detailValue: {
    color: METEORA_COLORS.text,
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'right',
    flexShrink: 1,
  },
  subsectionTitle: { color: METEORA_COLORS.text, fontSize: 14, fontWeight: '800' },
  costRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  costCopy: { flex: 1, gap: 1 },
  refundable: { color: METEORA_COLORS.positive, fontSize: 11, lineHeight: 15 },
  emptyCard: {
    padding: 16,
    borderRadius: 16,
    backgroundColor: METEORA_COLORS.surfaceRaised,
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
  },
  emptyText: { color: METEORA_COLORS.textDim, fontSize: 13, lineHeight: 19 },
  blockerNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 14,
    borderRadius: 14,
    backgroundColor: METEORA_TINTS.negative,
    borderWidth: 1,
    borderColor: METEORA_TINTS.negativeBorder,
  },
  blockerText: { flex: 1, color: METEORA_COLORS.negative, fontSize: 13, lineHeight: 19 },
  warningList: { gap: 8 },
  warningRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 13,
    borderRadius: 14,
    borderWidth: 1,
  },
  blockingWarning: {
    backgroundColor: METEORA_TINTS.negative,
    borderColor: METEORA_TINTS.negativeBorder,
  },
  nonBlockingWarning: {
    backgroundColor: METEORA_TINTS.warning,
    borderColor: METEORA_TINTS.warningBorder,
  },
  warningText: { flex: 1, color: METEORA_COLORS.text, fontSize: 13, lineHeight: 19 },
  footer: {
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: METEORA_COLORS.border,
    backgroundColor: METEORA_COLORS.surface,
  },
  walletSentence: { color: METEORA_COLORS.textDim, fontSize: 12, lineHeight: 17 },
  footerActions: { flexDirection: 'row', gap: 10 },
  secondaryButton: {
    minHeight: 48,
    minWidth: 96,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
  },
  secondaryButtonText: { color: METEORA_COLORS.text, fontSize: 14, fontWeight: '800' },
  primaryButton: {
    minHeight: 48,
    flex: 1.35,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: METEORA_COLORS.primary,
  },
  primaryButtonText: { color: METEORA_COLORS.onAccent, fontSize: 14, fontWeight: '800' },
  disabledButton: { backgroundColor: METEORA_COLORS.border },
  disabledButtonText: { color: METEORA_COLORS.textFaint },
  pressedButton: { backgroundColor: METEORA_TINTS.pressed },
  primaryPressed: { opacity: 0.82 },
});
