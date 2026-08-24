import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ActivityItem, OpenOrder } from '@/features/predict/predict.api';
import {
  buildPredictActivityItems,
  formatPredictFreshness,
  getPredictActivityStatusLabel,
  type PredictActivityItem,
  type PredictDataFreshness,
} from '@/features/predict/predictActivityState';
import { PredictActivityRow } from '@/features/predict/components/PredictActivityRow';
import { formatUsdCompact } from '@/lib/format';
import { semantic, tokens } from '@/theme';
import type { MoneyFormatter } from '@/features/predict/formatPredictMoney';

/**
 * Positions / Open Orders / Activity tabs (Predict redesign PRD §7).
 *
 * Picks tab: unified activity items (positions + orders) via the shared row.
 * Open Orders: resting orders with price/size and cancel affordance.
 * Activity: the wallet's trade history (what the API actually returns — no
 * derived P/L that the feed doesn't carry).
 */

type ProfileTab = 'picks' | 'orders' | 'activity';

export interface ProfilePortfolioTabsProps {
  positions: ReturnType<typeof buildPredictActivityItems> extends never ? never : Parameters<typeof buildPredictActivityItems>[0]['positions'];
  openOrders: OpenOrder[];
  activity: ActivityItem[];
  redeemablePositions: Parameters<typeof buildPredictActivityItems>[0]['redeemablePositions'];
  closedPositions: Parameters<typeof buildPredictActivityItems>[0]['closedPositions'];
  sellQuotes?: Parameters<typeof buildPredictActivityItems>[0]['sellQuotes'];
  polygonAddress: string | null;
  cancellingOrderId: string | null;
  freshness: PredictDataFreshness;
  onMarketPress: (slug: string) => void;
  onCancelOrder: (orderId: string) => void;
  formatMoney?: MoneyFormatter;
}

const TABS: { key: ProfileTab; label: string }[] = [
  { key: 'picks', label: 'Your Picks' },
  { key: 'orders', label: 'Open Orders' },
  { key: 'activity', label: 'Activity' },
];

function orderCost(order: OpenOrder): number | null {
  const size = Number.parseFloat(order.original_size);
  const price = Number.parseFloat(order.price);
  if (!Number.isFinite(size) || !Number.isFinite(price)) return null;
  return size * price;
}

function formatOrderAge(createdMs: number): string {
  const age = Date.now() - createdMs;
  if (!Number.isFinite(age) || age < 0) return '';
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ProfilePortfolioTabs({
  positions,
  openOrders,
  activity,
  redeemablePositions,
  closedPositions,
  sellQuotes,
  cancellingOrderId,
  freshness,
  onMarketPress,
  onCancelOrder,
  formatMoney,
}: ProfilePortfolioTabsProps) {
  const [tab, setTab] = useState<ProfileTab>('picks');
  const money = formatMoney ?? ((value: number | null | undefined) => formatUsdCompact(value));

  const picks = useMemo(
    () => buildPredictActivityItems({ positions, redeemablePositions, openOrders, closedPositions, sellQuotes }),
    [positions, redeemablePositions, openOrders, closedPositions, sellQuotes],
  );

  // The API returns open orders newest-last in practice; show newest first.
  const sortedOrders = useMemo(
    () => [...openOrders].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)),
    [openOrders],
  );

  const sortedActivity = useMemo(
    () => [...activity].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, 50),
    [activity],
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.tabRow} accessibilityRole="tablist">
        {TABS.map(({ key, label }) => (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityLabel={`Show ${label}`}
            accessibilityState={{ selected: tab === key }}
            style={[styles.tab, tab === key && styles.tabActive]}
            onPress={() => setTab(key)}>
            <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'picks' ? (
        <>
          <Text style={[styles.freshness, freshness.error && styles.freshnessError]}>
            {formatPredictFreshness(freshness)}
          </Text>
          {picks.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No picks yet. Your picks will show here.</Text>
            </View>
          ) : (
            picks.map((item: PredictActivityItem) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={`${item.marketTitle}, ${item.outcome}`}
                onPress={() => item.marketSlug && onMarketPress(item.marketSlug)}>
                <PredictActivityRow
                  item={item}
                  showMarketTitle
                  cancelling={item.orderId !== undefined && cancellingOrderId === item.orderId}
                  onPress={() => item.marketSlug && onMarketPress(item.marketSlug)}
                  onCashOut={() => item.marketSlug && onMarketPress(item.marketSlug)}
                  onBackMore={() => item.marketSlug && onMarketPress(item.marketSlug)}
                />
              </Pressable>
            ))
          )}
        </>
      ) : null}

      {tab === 'orders' ? (
        sortedOrders.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No open orders right now.</Text>
          </View>
        ) : (
          sortedOrders.map((order) => {
            const cost = orderCost(order);
            return (
              <View key={order.id} style={styles.orderCard}>
                <View style={styles.orderTop}>
                  <Text style={styles.orderOutcome} numberOfLines={1}>{order.outcome || 'Order'}</Text>
                  <Text style={styles.orderStatus}>{getPredictActivityStatusLabel('waiting_to_match')}</Text>
                </View>
                <Text style={styles.orderTitle} numberOfLines={2}>
                  {order.market?.slice(0, 64) ?? ''}
                </Text>
                <View style={styles.orderStats}>
                  <View style={styles.orderStat}>
                    <Text style={styles.orderStatLabel}>Price</Text>
                    <Text style={styles.orderStatValue}>
                      {Number.isFinite(Number.parseFloat(order.price)) ? `${Math.round(Number.parseFloat(order.price) * 100)}¢` : '--'}
                    </Text>
                  </View>
                  <View style={styles.orderStat}>
                    <Text style={styles.orderStatLabel}>Size</Text>
                    <Text style={styles.orderStatValue}>
                      {Number.isFinite(Number.parseFloat(order.original_size)) ? Number.parseFloat(order.original_size).toFixed(2) : '--'}
                    </Text>
                  </View>
                  <View style={styles.orderStat}>
                    <Text style={styles.orderStatLabel}>You pay</Text>
                    <Text style={styles.orderStatValue}>{cost !== null ? money(cost) : '--'}</Text>
                  </View>
                  <View style={styles.orderStat}>
                    <Text style={styles.orderStatLabel}>Placed</Text>
                    <Text style={styles.orderStatValue}>{formatOrderAge(order.created_at)}</Text>
                  </View>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Cancel order for ${order.outcome}`}
                  style={[styles.cancelBtn, cancellingOrderId === order.id && styles.cancelBtnBusy]}
                  disabled={cancellingOrderId === order.id}
                  onPress={() => onCancelOrder(order.id)}>
                  <Text style={styles.cancelBtnText}>
                    {cancellingOrderId === order.id ? 'Cancelling…' : 'Cancel'}
                  </Text>
                </Pressable>
              </View>
            );
          })
        )
      ) : null}

      {tab === 'activity' ? (
        sortedActivity.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No activity yet.</Text>
          </View>
        ) : (
          sortedActivity.map((entry, idx) => (
            <Pressable
              key={`${entry.slug ?? ''}-${entry.timestamp}-${idx}`}
              style={styles.activityRow}
              accessibilityRole="button"
              accessibilityLabel={`${entry.type} ${entry.side} ${entry.title}`}
              onPress={() => entry.slug && onMarketPress(entry.slug)}>
              <View style={styles.activityMain}>
                <Text style={styles.activityTitle} numberOfLines={2}>{entry.title}</Text>
                <Text style={styles.activityMeta}>
                  {entry.side.toUpperCase()} · {entry.outcome}
                  {formatOrderAge(entry.timestamp * 1000) ? ` · ${formatOrderAge(entry.timestamp * 1000)}` : ''}
                </Text>
              </View>
              <View style={styles.activityRight}>
                <Text style={styles.activityValue}>{money(entry.usdcSize)}</Text>
                <Text style={styles.activityPrice}>
                  {Number.isFinite(entry.price) ? `${Math.round(entry.price * 100)}¢` : ''}
                </Text>
              </View>
            </Pressable>
          ))
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 16,
    marginTop: 14,
    gap: 8,
  },
  tabRow: {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: 'rgba(8,8,6,0.36)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    padding: 3,
  },
  tab: {
    flex: 1,
    minHeight: 38,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabActive: {
    backgroundColor: tokens.colors.surface,
  },
  tabText: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: semantic.text.faint,
  },
  tabTextActive: {
    color: semantic.text.primary,
  },
  freshness: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
  },
  freshnessError: {
    color: tokens.colors.vermillion,
  },
  empty: {
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 12,
    backgroundColor: semantic.background.surface,
    paddingVertical: 22,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  emptyText: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.faint,
    textAlign: 'center',
    lineHeight: 15,
  },
  orderCard: {
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 12,
    backgroundColor: semantic.background.surface,
    padding: 12,
    gap: 8,
  },
  orderTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  orderOutcome: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  orderStatus: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: tokens.colors.accent,
  },
  orderTitle: {
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 13,
    color: semantic.text.dim,
  },
  orderStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 6,
  },
  orderStat: {
    gap: 2,
  },
  orderStatLabel: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  orderStatValue: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  cancelBtn: {
    minHeight: 40,
    borderWidth: 1,
    borderColor: 'rgba(255,69,58,0.25)',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnBusy: {
    opacity: 0.5,
  },
  cancelBtnText: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: semantic.sentiment.negative,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 12,
    backgroundColor: semantic.background.surface,
    padding: 12,
  },
  activityMain: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  activityTitle: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  activityMeta: {
    fontFamily: 'monospace',
    fontSize: 8.5,
    color: semantic.text.faint,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  activityRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  activityValue: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  activityPrice: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
  },
});
