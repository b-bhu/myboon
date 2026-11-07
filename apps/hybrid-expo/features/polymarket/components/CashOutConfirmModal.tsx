import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PortfolioPosition } from '@/features/polymarket/polymarket.api';
import type { Orderbook } from '@/features/polymarket/polymarket.types';
import { makeSignedMoneyFormatter, truncateUsd, type MoneyFormatter } from '@/features/polymarket/formatPolymarketMoney';
import { buildPositionSellQuote } from '@/features/polymarket/positionSellQuotes';
import { semantic, tokens } from '@/theme';

interface CashOutConfirmModalProps {
  position: PortfolioPosition | null;
  visible: boolean;
  submitting?: boolean;
  orderbook?: Orderbook | null;
  quoteLoading?: boolean;
  quoteError?: string | null;
  onClose: () => void;
  onConfirm: (size: number, limitPrice: number) => void;
  formatMoney?: MoneyFormatter;
}

export function CashOutConfirmModal({
  position,
  visible,
  submitting = false,
  orderbook = null,
  quoteLoading = false,
  quoteError = null,
  onClose,
  onConfirm,
  formatMoney = truncateUsd,
}: CashOutConfirmModalProps) {
  const [percent, setPercent] = useState(100);
  const [sliderWidth, setSliderWidth] = useState(1);

  useEffect(() => {
    if (visible) setPercent(100);
  }, [visible, position?.asset, position?.conditionId, position?.outcomeIndex]);

  const updatePercentFromX = useCallback((x: number) => {
    const next = Math.max(0, Math.min(100, Math.round((x / sliderWidth) * 100)));
    setPercent(next);
  }, [sliderWidth]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => updatePercentFromX(event.nativeEvent.locationX),
    onPanResponderMove: (event) => updatePercentFromX(event.nativeEvent.locationX),
  }), [updatePercentFromX]);

  const selectedRatio = percent / 100;
  const selectedSize = position ? position.size * selectedRatio : 0;
  const quote = position
    ? buildPositionSellQuote(position, orderbook, selectedSize, quoteLoading, quoteError)
    : null;
  const cashOutValue = quote?.estimatedProceeds ?? null;
  const pnl = quote?.cashPnl ?? null;
  const avgPrice = quote?.averagePrice ?? quote?.bestBid ?? null;
  const canConfirm = !!position && selectedSize > 0 && !!quote?.executable && quote.limitPrice !== null && !submitting;
  const formatSignedMoney = makeSignedMoneyFormatter(formatMoney);
  const quoteMessage = quoteLoading
    ? 'Refreshing live bid quote...'
    : quoteError
      ? 'Could not load a live cashout quote.'
      : quote && quote.unfilledShares > 0.01
        ? `Only ${quote.filledShares.toFixed(2)} of ${selectedSize.toFixed(2)} shares can sell at current bids.`
        : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close cash out confirmation"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        <View style={styles.card} accessibilityViewIsModal>
          <Text style={styles.eyebrow}>Cash out</Text>
          <Text style={styles.title}>Are you sure?</Text>
          <Text style={styles.copy}>
            You are cashing out {position?.outcome || 'this pick'}.
          </Text>
          <View style={styles.percentHeader}>
            <Text style={styles.amountLabel}>Cash out amount</Text>
            <Text style={styles.percentValue}>{percent}%</Text>
          </View>
          <View
            style={styles.slider}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Cash out amount"
            accessibilityValue={{ min: 0, max: 100, now: percent, text: `${percent}%` }}
            accessibilityActions={[
              { name: 'increment', label: 'Increase cash out amount' },
              { name: 'decrement', label: 'Decrease cash out amount' },
            ]}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === 'increment') {
                setPercent((current) => Math.min(100, current + 10));
              }
              if (event.nativeEvent.actionName === 'decrement') {
                setPercent((current) => Math.max(0, current - 10));
              }
            }}
            onLayout={(event) => setSliderWidth(Math.max(1, event.nativeEvent.layout.width))}
            {...panResponder.panHandlers}
          >
            <View style={styles.sliderTrack} />
            <View style={[styles.sliderFill, { width: `${percent}%` }]} />
            <View style={[styles.sliderThumb, { left: `${percent}%` }]} />
          </View>
          <View style={styles.sliderScale}>
            <Text style={styles.sliderScaleText}>0%</Text>
            <Text style={styles.sliderScaleText}>100%</Text>
          </View>
          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>You will get</Text>
            <Text style={styles.amountValue}>{cashOutValue === null ? '--' : formatMoney(cashOutValue)}</Text>
          </View>
          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>Avg sell price</Text>
            <Text style={styles.amountValue}>{avgPrice === null ? '--' : `${Math.round(avgPrice * 100)}%`}</Text>
          </View>
          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>Live P/L</Text>
            <Text style={[styles.amountValue, (pnl ?? 0) > 0 ? styles.pnlPositive : (pnl ?? 0) < 0 ? styles.pnlNegative : styles.pnlFlat]}>
              {pnl === null ? '--' : formatSignedMoney(pnl)}
            </Text>
          </View>
          {quoteMessage && <Text style={styles.quoteMessage}>{quoteMessage}</Text>}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Not now"
              accessibilityState={{ disabled: submitting }}
              style={styles.secondaryAction}
              onPress={onClose}
              disabled={submitting}>
              <Text style={styles.secondaryActionText}>Not now</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={submitting ? 'Cashing out' : 'Cash out'}
              accessibilityState={{ disabled: !canConfirm, busy: submitting }}
              style={[styles.primaryAction, !canConfirm && styles.primaryActionDisabled]}
              onPress={() => {
                if (quote?.limitPrice !== null && quote?.limitPrice !== undefined) onConfirm(selectedSize, quote.limitPrice);
              }}
              disabled={!canConfirm}>
              <Text style={styles.primaryActionText}>{submitting ? 'Cashing out...' : 'Cash out'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 22,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: tokens.colors.ground,
    padding: 18,
  },
  eyebrow: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  title: {
    marginTop: 6,
    fontSize: 20,
    fontWeight: '800',
    color: semantic.text.primary,
  },
  copy: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: 17,
    color: semantic.text.dim,
  },
  percentHeader: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  percentValue: {
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: '800',
    color: tokens.colors.viridian,
  },
  slider: {
    height: 30,
    justifyContent: 'center',
  },
  sliderTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 6,
    borderRadius: 999,
    backgroundColor: semantic.border.muted,
  },
  sliderFill: {
    position: 'absolute',
    left: 0,
    height: 6,
    borderRadius: 999,
    backgroundColor: tokens.colors.viridian,
  },
  sliderThumb: {
    position: 'absolute',
    width: 18,
    height: 18,
    marginLeft: -9,
    borderRadius: 9,
    backgroundColor: tokens.colors.viridian,
    borderWidth: 3,
    borderColor: tokens.colors.ground,
  },
  sliderScale: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sliderScaleText: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.faint,
  },
  amountRow: {
    marginTop: 12,
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  amountLabel: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.faint,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  amountValue: {
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: '800',
    color: semantic.text.primary,
  },
  quoteMessage: {
    marginTop: 10,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 14,
    color: semantic.text.faint,
  },
  pnlPositive: {
    color: tokens.colors.viridian,
  },
  pnlNegative: {
    color: tokens.colors.vermillion,
  },
  pnlFlat: {
    color: semantic.text.faint,
  },
  actions: {
    marginTop: 16,
    flexDirection: 'row',
    gap: 8,
  },
  secondaryAction: {
    flex: 1,
    minHeight: 42,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryActionText: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '800',
    color: semantic.text.dim,
    textTransform: 'uppercase',
  },
  primaryAction: {
    flex: 1,
    minHeight: 42,
    borderRadius: 11,
    backgroundColor: tokens.colors.viridian,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryActionDisabled: {
    opacity: 0.65,
  },
  primaryActionText: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '800',
    color: tokens.colors.backgroundDark,
    textTransform: 'uppercase',
  },
});
