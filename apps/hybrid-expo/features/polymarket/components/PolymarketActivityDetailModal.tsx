import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PolymarketActivityItem, PolymarketDataFreshness } from '@/features/polymarket/polymarketActivityState';
import { formatPolymarketFreshness, getPolymarketActivityStatusLabel } from '@/features/polymarket/polymarketActivityState';
import { makeSignedMoneyFormatter, truncateUsd, type MoneyFormatter } from '@/features/polymarket/formatPolymarketMoney';
import { semantic, tokens } from '@/theme';

interface PolymarketActivityDetailModalProps {
  visible: boolean;
  item: PolymarketActivityItem | null;
  freshness?: PolymarketDataFreshness;
  onClose: () => void;
  onCashOut: (item: PolymarketActivityItem) => void;
  onBackMore: (item: PolymarketActivityItem) => void;
  onCancelOrder: (orderId: string) => void;
  onRedeem: (item: PolymarketActivityItem) => void;
  redeeming?: boolean;
  redeemError?: string;
  formatMoney?: MoneyFormatter;
}

function formatChance(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return `${Math.round(value * 100)}%`;
}

function formatShares(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatDate(value: number | null): string {
  if (value === null) return '--';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function actionCopy(item: PolymarketActivityItem): string {
  switch (item.status) {
    case 'syncing':
      return 'Your pick was submitted. It can take a moment for Polymarket to show the matching order or position.';
    case 'waiting_to_match':
      return 'Cash for this order is reserved until it matches or you cancel it.';
    case 'cancel_requested':
      return 'Cancel has been requested. Cash remains reserved until Polymarket confirms the cancellation.';
    case 'active':
      return 'This pick is live. You can cash out or add more to the same side.';
    case 'ready_to_collect':
      return 'This market settled in your favor and is ready to redeem.';
    case 'collecting':
      return 'Collect has been submitted. Your cash will update after confirmation.';
    case 'closed_won':
      return 'This settled as a win.';
    case 'closed_lost':
      return 'This settled with no payout.';
    case 'failed':
      return 'This action needs attention. Try again after refreshing.';
  }
}

export function PolymarketActivityDetailModal({
  visible,
  item,
  freshness,
  onClose,
  onCashOut,
  onBackMore,
  onCancelOrder,
  onRedeem,
  redeeming = false,
  redeemError,
  formatMoney = truncateUsd,
}: PolymarketActivityDetailModalProps) {
  const pnlPositive = (item?.pnl ?? 0) > 0.005;
  const pnlNegative = (item?.pnl ?? 0) < -0.005;
  const formatSignedMoney = makeSignedMoneyFormatter(formatMoney);
  const statusLabel = item ? getPolymarketActivityStatusLabel(item.status) : '';
  const freshnessCopy = item?.status === 'syncing'
    ? 'Syncing with market'
    : freshness
      ? formatPolymarketFreshness(freshness)
      : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close activity details"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        {item && (
          <View style={styles.sheet} accessibilityViewIsModal>
            <View style={styles.header}>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>{statusLabel}</Text>
                <Text style={styles.title} numberOfLines={2}>{item.outcome}</Text>
                <Text style={styles.market} numberOfLines={2}>{item.marketTitle}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                style={styles.closeBtn}
                onPress={onClose}
                accessibilityLabel="Close activity details">
                <MaterialIcons name="close" size={16} color={semantic.text.dim} />
              </Pressable>
            </View>

            <Text style={styles.copy}>{actionCopy(item)}</Text>
            {redeemError && <Text style={styles.errorCopy}>{redeemError}</Text>}
            {freshnessCopy && <Text style={styles.freshness}>{freshnessCopy}</Text>}

            <View style={styles.grid}>
              <Metric label="Put in" value={formatMoney(item.putIn)} />
              <Metric
                label={item.status === 'active' ? 'Cashout quote' : 'Value now'}
                value={item.currentValue === null ? '--' : formatMoney(item.currentValue)}
              />
              <Metric
                label={item.status === 'active' ? 'Live P/L' : 'P/L'}
                value={item.pnl === null ? '--' : formatSignedMoney(item.pnl)}
                tone={pnlPositive ? 'positive' : pnlNegative ? 'negative' : 'flat'}
              />
              <Metric label="Shares" value={formatShares(item.shares)} />
              <Metric label="Entry" value={formatChance(item.avgPrice)} />
              <Metric label={item.status === 'active' ? 'Sell quote' : 'Current'} value={formatChance(item.currentPrice)} />
              <Metric label="Placed" value={formatDate(item.createdAt)} wide />
            </View>

            <View style={styles.actions}>
              {item.status === 'waiting_to_match' && item.orderId && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel order"
                  accessibilityHint="Cancel this waiting pick"
                  style={styles.dangerAction}
                  onPress={() => onCancelOrder(item.orderId!)}>
                  <Text style={styles.dangerActionText}>Cancel order</Text>
                </Pressable>
              )}
              {item.status === 'cancel_requested' && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Done"
                  style={styles.secondaryAction}
                  onPress={onClose}>
                  <Text style={styles.secondaryActionText}>Done</Text>
                </Pressable>
              )}
              {item.status === 'active' && (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Back more"
                    accessibilityHint="Add more to this pick"
                    style={styles.secondaryAction}
                    onPress={() => onBackMore(item)}>
                    <Text style={styles.secondaryActionText}>Back more</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Cash out"
                    accessibilityHint="Open cash out confirmation"
                    style={styles.primaryAction}
                    onPress={() => onCashOut(item)}>
                    <Text style={styles.primaryActionText}>Cash out</Text>
                  </Pressable>
                </>
              )}
              {item.status === 'ready_to_collect' && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Redeem payout"
                  style={[styles.primaryAction, redeemError && styles.primaryActionError]}
                  disabled={redeeming}
                  accessibilityState={{ disabled: redeeming, busy: redeeming }}
                  onPress={() => onRedeem(item)}>
                  {redeeming ? (
                    <View style={styles.actionLoading}>
                      <ActivityIndicator size="small" color={tokens.colors.backgroundDark} />
                      <Text style={styles.primaryActionText}>Redeeming</Text>
                    </View>
                  ) : (
                    <Text style={[styles.primaryActionText, redeemError && styles.primaryActionTextError]}>
                      {redeemError ? 'Try again' : 'Redeem'}
                    </Text>
                  )}
                </Pressable>
              )}
              {(item.status === 'syncing' || item.status === 'collecting' || item.status === 'closed_won' || item.status === 'closed_lost' || item.status === 'failed') && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Done"
                  style={styles.secondaryAction}
                  onPress={onClose}>
                  <Text style={styles.secondaryActionText}>Done</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

function Metric({
  label,
  value,
  tone = 'default',
  wide = false,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'positive' | 'negative' | 'flat';
  wide?: boolean;
}) {
  return (
    <View style={[styles.metric, wide && styles.metricWide]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text
        style={[
          styles.metricValue,
          tone === 'positive' && styles.positive,
          tone === 'negative' && styles.negative,
          tone === 'flat' && styles.flat,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: tokens.colors.ground,
    padding: 18,
    paddingBottom: 22,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: tokens.colors.primary,
    fontWeight: '800',
  },
  title: {
    marginTop: 5,
    fontSize: 22,
    fontWeight: '800',
    color: semantic.text.primary,
  },
  market: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17,
    color: semantic.text.dim,
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: semantic.background.lift,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: {
    marginTop: 12,
    fontSize: 12,
    lineHeight: 17,
    color: semantic.text.dim,
  },
  errorCopy: {
    marginTop: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'rgba(217,83,79,0.24)',
    backgroundColor: 'rgba(217,83,79,0.08)',
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 11,
    lineHeight: 15,
    color: tokens.colors.vermillion,
  },
  freshness: {
    marginTop: 8,
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  grid: {
    marginTop: 14,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  metric: {
    width: '31.7%',
    minHeight: 56,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
    padding: 9,
    justifyContent: 'center',
  },
  metricWide: {
    width: '100%',
  },
  metricLabel: {
    fontFamily: 'monospace',
    fontSize: 7,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  metricValue: {
    marginTop: 5,
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '800',
    color: semantic.text.primary,
  },
  positive: {
    color: tokens.colors.viridian,
  },
  negative: {
    color: tokens.colors.vermillion,
  },
  flat: {
    color: semantic.text.faint,
  },
  actions: {
    marginTop: 16,
    flexDirection: 'row',
    gap: 8,
  },
  primaryAction: {
    flex: 1,
    minHeight: 42,
    borderRadius: 11,
    backgroundColor: tokens.colors.viridian,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryActionError: {
    backgroundColor: 'rgba(217,83,79,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(217,83,79,0.28)',
  },
  primaryActionText: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '800',
    color: tokens.colors.backgroundDark,
    textTransform: 'uppercase',
  },
  primaryActionTextError: {
    color: tokens.colors.vermillion,
  },
  actionLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
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
  dangerAction: {
    flex: 1,
    minHeight: 42,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(244,88,78,0.35)',
    backgroundColor: 'rgba(244,88,78,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerActionText: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '800',
    color: semantic.sentiment.negative,
    textTransform: 'uppercase',
  },
});
