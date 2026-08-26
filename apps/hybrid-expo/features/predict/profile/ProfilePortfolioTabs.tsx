import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type { SecureClient } from '@polymarket/client';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type {
  ActivityItem,
  ClosedPortfolioPosition,
  OpenOrder,
  PortfolioPosition,
} from '@/features/predict/predict.api';
import { redeemPosition } from '@/features/predict/predict.api';
import {
  buildPredictActivityItems,
  formatPredictFreshness,
  getPredictActivityStatusLabel,
  type PredictDataFreshness,
} from '@/features/predict/predictActivityState';
import { truncateUsd, type MoneyFormatter } from '@/features/predict/formatPredictMoney';
import {
  formatRedeemError,
  logRedeemError,
} from '@/features/predict/redeemErrors';
import {
  getPositionSellQuote,
  type PositionSellQuoteMap,
} from '@/features/predict/positionSellQuotes';
import { formatPredictTitle } from '@/features/predict/formatPredictTitle';
import { remainingOrderCost } from '@/features/predict/profile/profile-portfolio-state';
import { semantic, tokens } from '@/theme';

type ProfileTab = 'positions' | 'orders' | 'activity';

export interface ProfilePortfolioTabsProps {
  positions: PortfolioPosition[];
  openOrders: OpenOrder[];
  activity: ActivityItem[];
  redeemablePositions: PortfolioPosition[];
  closedPositions: ClosedPortfolioPosition[];
  sellQuotes?: PositionSellQuoteMap;
  client: SecureClient | null;
  cancellingOrderId: string | null;
  actionsDisabled?: boolean;
  freshness: PredictDataFreshness;
  onMarketPress: (slug: string) => void;
  onCancelOrder: (orderId: string) => void;
  onCashOutPress: (position: PortfolioPosition) => void;
  onRedeemed: () => void | Promise<void>;
  onBrowseMarkets: () => void;
  formatMoney?: MoneyFormatter;
}

const TABS: {
  key: ProfileTab;
  label: string;
  icon: keyof typeof MaterialIcons.glyphMap;
}[] = [
  { key: 'positions', label: 'Positions', icon: 'pie-chart' },
  { key: 'orders', label: 'Orders', icon: 'schedule' },
  { key: 'activity', label: 'Activity', icon: 'receipt-long' },
];

function orderCost(order: OpenOrder): number | null {
  return remainingOrderCost(order);
}

function formatAge(value: number): string {
  const createdMs = value < 10_000_000_000 ? value * 1000 : value;
  const age = Date.now() - createdMs;
  if (!Number.isFinite(age) || age < 0) return '';
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function positionKey(position: PortfolioPosition): string {
  return `${position.conditionId}:${position.outcomeIndex}:${position.asset}`;
}

function activityLabel(entry: ActivityItem): string {
  const type = entry.type.trim().toLowerCase();
  if (type.includes('redeem')) return 'Payout collected';
  if (type.includes('trade')) return entry.side.toLowerCase() === 'sell' ? 'Position sold' : 'Position bought';
  if (type.includes('split')) return 'Position prepared';
  if (type.includes('merge')) return 'Position settled';
  return entry.type.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activityCashValue(entry: ActivityItem): number {
  const value = Math.abs(entry.usdcSize);
  const type = entry.type.trim().toLowerCase();
  if (type.includes('redeem') || type.includes('merge')) return value;
  if (type.includes('split')) return -value;
  if (type.includes('trade')) return entry.side.trim().toLowerCase() === 'sell' ? value : -value;
  return entry.usdcSize;
}

export function ProfilePortfolioTabs({
  positions,
  openOrders,
  activity,
  redeemablePositions,
  closedPositions,
  sellQuotes,
  client,
  cancellingOrderId,
  actionsDisabled = false,
  freshness,
  onMarketPress,
  onCancelOrder,
  onCashOutPress,
  onRedeemed,
  onBrowseMarkets,
  formatMoney,
}: ProfilePortfolioTabsProps) {
  const [tab, setTab] = useState<ProfileTab>('positions');
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<{ id: string; message: string } | null>(null);
  const money = formatMoney ?? truncateUsd;

  const sortedOrders = useMemo(
    () => [...openOrders].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0)),
    [openOrders],
  );
  const sortedActivity = useMemo(
    () => [...activity].sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0)).slice(0, 50),
    [activity],
  );
  const closedItems = useMemo(
    () => buildPredictActivityItems({
      positions: [],
      redeemablePositions: [],
      openOrders: [],
      closedPositions,
    }),
    [closedPositions],
  );
  const visibleActivity = useMemo(() => {
    const closedConditionIds = new Set(
      closedItems.map((item) => item.conditionId?.toLowerCase()).filter((id): id is string => !!id),
    );
    return sortedActivity.filter((entry) => {
      const type = entry.type.trim().toLowerCase();
      return !(type.includes('redeem') && entry.conditionId && closedConditionIds.has(entry.conditionId.toLowerCase()));
    });
  }, [closedItems, sortedActivity]);
  const activityRows = useMemo(() => [
    ...closedItems.map((item) => ({ kind: 'closed' as const, item, timestamp: item.createdAt ?? 0 })),
    ...visibleActivity.map((entry, index) => ({
      kind: 'raw' as const,
      entry,
      index,
      timestamp: entry.timestamp < 10_000_000_000 ? entry.timestamp * 1000 : entry.timestamp,
    })),
  ].sort((left, right) => right.timestamp - left.timestamp), [closedItems, visibleActivity]);
  const reserved = sortedOrders.reduce((sum, order) => sum + (orderCost(order) ?? 0), 0);

  async function collect(position: PortfolioPosition) {
    const id = positionKey(position);
    if (actionsDisabled || !client || redeemingId) return;
    setRedeemingId(id);
    setRedeemError(null);
    try {
      const result = await redeemPosition(client, {
        conditionId: position.conditionId,
      });
      if (!result.ok) throw new Error(result.error || 'Collect failed');
      await onRedeemed();
    } catch (error) {
      logRedeemError('profile-positions-tab', error, position);
      setRedeemError({ id, message: formatRedeemError(error) });
    } finally {
      setRedeemingId(null);
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.tabRow} accessibilityRole="tablist">
        {TABS.map(({ key, label, icon }) => {
          const selected = tab === key;
          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityLabel={`Show ${label}`}
              accessibilityState={{ selected }}
              style={[styles.tab, selected && styles.tabActive]}
              onPress={() => setTab(key)}>
              <MaterialIcons name={icon} size={13} color={selected ? tokens.colors.accent : semantic.text.faint} />
              <Text style={[styles.tabText, selected && styles.tabTextActive]}>{label}</Text>
              {key === 'orders' && openOrders.length > 0 ? (
                <View style={styles.tabCount}><Text style={styles.tabCountText}>{openOrders.length}</Text></View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {tab === 'positions' ? (
        <View style={styles.view}>
          <View style={styles.sectionHead}>
            <View style={styles.sectionHeadCopy}>
              <Text style={styles.sectionTitle}>Your positions</Text>
              <Text style={[styles.sectionSubtitle, freshness.error && styles.freshnessError]}>
                {freshness.error ? formatPredictFreshness(freshness) : 'What is open and ready now'}
              </Text>
            </View>
            <Text style={styles.sectionCount}>{positions.length} active</Text>
          </View>

          {redeemablePositions.map((position) => {
            const id = positionKey(position);
            const redeeming = redeemingId === id;
            return (
              <View key={`ready:${id}`} style={styles.readyCard}>
                <View style={styles.readyCopy}>
                  <Text style={styles.readyKicker}>Ready to collect</Text>
                  <Text style={styles.readyTitle} numberOfLines={1}>{formatPredictTitle({ title: position.title, slug: position.slug || position.eventSlug })}</Text>
                  <Text style={styles.readyOutcome} numberOfLines={1}>Your winning position · {position.outcome}</Text>
                  {redeemError?.id === id ? <Text selectable style={styles.rowError}>{redeemError.message}</Text> : null}
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Collect ${money(position.currentValue)}`}
                  accessibilityState={{ busy: redeeming, disabled: actionsDisabled || !client }}
                  disabled={actionsDisabled || redeeming || !client}
                  style={[styles.collectBtn, (actionsDisabled || redeeming || !client) && styles.disabled]}
                  onPress={() => void collect(position)}>
                  {redeeming ? <ActivityIndicator size="small" color={tokens.colors.backgroundDark} /> : <Text style={styles.collectText}>Collect {money(position.currentValue)}</Text>}
                </Pressable>
              </View>
            );
          })}

          <View style={styles.cardList}>
            {positions.map((position) => {
              const quote = getPositionSellQuote(sellQuotes, position);
              const pnl = quote?.cashPnl ?? null;
              const currentValue = quote?.estimatedProceeds ?? null;
              return (
                <View key={positionKey(position)} style={styles.positionCard}>
                  <View style={styles.cardTop}>
                    <Text style={styles.cardKind}>Open position</Text>
                    <Text style={[styles.positionPnl, pnl !== null && pnl < 0 && styles.negative]}>{pnl === null ? '--' : `${pnl >= 0 ? '+' : ''}${money(pnl)}`}</Text>
                  </View>
                  <Pressable accessibilityRole="button" onPress={() => position.slug && onMarketPress(position.slug)}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{formatPredictTitle({ title: position.title, slug: position.slug || position.eventSlug })}</Text>
                    <Text style={styles.positionOutcome}>Your pick · {position.outcome}</Text>
                  </Pressable>
                  <View style={styles.positionStats}>
                    <View style={styles.positionStat}><Text style={styles.statLabel}>You paid</Text><Text style={styles.statValue}>{money(position.size * position.avgPrice)}</Text></View>
                    <View style={styles.positionStat}><Text style={styles.statLabel}>Current value</Text><Text style={styles.statValue}>{money(currentValue)}</Text></View>
                    <View style={[styles.positionStat, styles.positionStatRight]}><Text style={styles.statLabel}>Chance now</Text><Text style={styles.statValue}>{Number.isFinite(position.curPrice) ? `${Math.round(position.curPrice * 100)}%` : '--'}</Text></View>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Cash out ${position.outcome}`}
                    style={[styles.cashOutBtn, (actionsDisabled || quote?.loading) && styles.disabled]}
                    disabled={actionsDisabled || quote?.loading === true}
                    onPress={() => onCashOutPress(position)}>
                    <Text style={styles.cashOutText}>{quote?.loading ? 'Checking cash-out…' : quote?.error ? 'Review cash-out' : 'Cash out'}</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>

          {positions.length === 0 && redeemablePositions.length === 0 ? (
            <View style={styles.empty}>
              <MaterialIcons name="pie-chart" size={22} color={semantic.text.faint} />
              <Text style={styles.emptyTitle}>No positions yet</Text>
              <Text style={styles.emptyText}>{openOrders.length > 0 ? 'Your open orders are still waiting to match.' : 'Choose a market and your position will appear here.'}</Text>
              <Pressable accessibilityRole="button" style={styles.emptyAction} onPress={onBrowseMarkets}>
                <Text style={styles.emptyActionText}>Browse markets</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}

      {tab === 'orders' ? (
        <View style={styles.view}>
          <View style={styles.sectionHead}>
            <View style={styles.sectionHeadCopy}><Text style={styles.sectionTitle}>Open orders</Text><Text style={[styles.sectionSubtitle, freshness.error && styles.freshnessError]}>{freshness.error ? formatPredictFreshness(freshness) : 'Waiting to match at your price'}</Text></View>
            <Text style={styles.sectionCount}>{openOrders.length} open</Text>
          </View>
          {sortedOrders.length > 0 ? (
            <View style={styles.ordersSummary}><Text style={styles.ordersSummaryLabel}>Reserved for these orders</Text><Text style={styles.ordersSummaryValue}>{money(reserved)} pUSD</Text></View>
          ) : null}
          <View style={styles.cardList}>
            {sortedOrders.map((order) => {
              const cost = orderCost(order);
              const waitingLabel = order.status === 'cancel_requested' ? getPredictActivityStatusLabel('cancel_requested') : order.status === 'local-pending' ? getPredictActivityStatusLabel('syncing') : getPredictActivityStatusLabel('waiting_to_match');
              return (
                <View key={order.id} style={styles.orderCard}>
                  <View style={styles.cardTop}><Text style={styles.cardKind}>Limit order</Text><Text style={styles.orderStatus}>{waitingLabel}</Text></View>
                  <Text style={styles.cardTitle} numberOfLines={1}>{order.market || 'Prediction market'}</Text>
                  <Text style={styles.positionOutcome}>{order.outcome || 'Outcome'} · {Math.round((Number.parseFloat(order.price) || 0) * 100)}¢</Text>
                  <View style={styles.orderMeta}>
                    <Text style={styles.orderMetaText}>{cost === null ? '--' : `${money(cost)} reserved`}{formatAge(order.created_at) ? ` · ${formatAge(order.created_at)}` : ''}</Text>
                    <Pressable accessibilityRole="button" accessibilityLabel={`Cancel ${order.outcome} order`} style={[styles.cancelBtn, (actionsDisabled || cancellingOrderId === order.id) && styles.disabled]} disabled={actionsDisabled || cancellingOrderId === order.id || order.status === 'cancel_requested'} onPress={() => onCancelOrder(order.id)}>
                      <Text style={styles.cancelText}>{cancellingOrderId === order.id ? 'Cancelling…' : order.status === 'cancel_requested' ? 'Requested' : 'Cancel'}</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
          {sortedOrders.length === 0 ? <View style={styles.empty}><MaterialIcons name="schedule" size={22} color={semantic.text.faint} /><Text style={styles.emptyTitle}>No open orders</Text><Text style={styles.emptyText}>Limit orders waiting to match will appear here.</Text></View> : null}
        </View>
      ) : null}

      {tab === 'activity' ? (
        <View style={styles.view}>
          <View style={styles.sectionHead}>
            <View style={styles.sectionHeadCopy}><Text style={styles.sectionTitle}>Recent market activity</Text><Text style={[styles.sectionSubtitle, freshness.error && styles.freshnessError]}>{formatPredictFreshness(freshness)}</Text></View>
            <Text style={styles.sectionCount}>All</Text>
          </View>
          <View style={styles.activityList}>
            {activityRows.map((row) => {
              if (row.kind === 'closed') {
                const { item } = row;
                return (
                  <Pressable key={item.id} style={styles.activityRow} onPress={() => item.marketSlug && onMarketPress(item.marketSlug)} accessibilityRole="button">
                    <View style={[styles.activityIcon, item.status === 'closed_won' && styles.activityIconPositive]}><MaterialIcons name={item.status === 'closed_won' ? 'emoji-events' : 'close'} size={16} color={item.status === 'closed_won' ? tokens.colors.viridian : semantic.text.faint} /></View>
                    <View style={styles.activityCopy}><Text style={styles.activityTitle}>{item.status === 'closed_won' ? 'Position won' : 'Position settled'}</Text><Text style={styles.activitySubtitle} numberOfLines={1}>{item.marketTitle} · {item.outcome}</Text></View>
                    <View style={styles.activityValueWrap}><Text style={[styles.activityValue, item.status === 'closed_won' ? styles.positive : styles.negative]}>{item.status === 'closed_won' ? `+${money(item.currentValue)}` : money(item.pnl)}</Text><Text style={styles.activityTime}>{item.createdAt ? formatAge(item.createdAt) : ''}</Text></View>
                  </Pressable>
                );
              }
              const { entry } = row;
              const cashValue = activityCashValue(entry);
              return (
                <Pressable key={`${entry.slug}:${entry.timestamp}:${row.index}`} style={styles.activityRow} onPress={() => entry.slug && onMarketPress(entry.slug)} accessibilityRole="button">
                  <View style={styles.activityIcon}><MaterialIcons name={entry.side.toLowerCase() === 'sell' ? 'arrow-upward' : 'check'} size={16} color={tokens.colors.primary} /></View>
                  <View style={styles.activityCopy}><Text style={styles.activityTitle}>{activityLabel(entry)}</Text><Text style={styles.activitySubtitle} numberOfLines={1}>{entry.title} · {entry.outcome}</Text></View>
                  <View style={styles.activityValueWrap}><Text style={[styles.activityValue, cashValue > 0 ? styles.positive : cashValue < 0 ? styles.negative : null]}>{cashValue > 0 ? `+${money(cashValue)}` : money(cashValue)}</Text><Text style={styles.activityTime}>{formatAge(entry.timestamp)}</Text></View>
                </Pressable>
              );
            })}
          </View>
          {closedItems.length === 0 && visibleActivity.length === 0 ? <View style={styles.empty}><MaterialIcons name="receipt-long" size={22} color={semantic.text.faint} /><Text style={styles.emptyTitle}>No market activity yet</Text><Text style={styles.emptyText}>Trades, settlements and payouts reported by Polymarket will appear here.</Text></View> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  tabRow: { minHeight: 50, padding: 5, flexDirection: 'row', gap: 4, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 14, borderCurve: 'continuous', backgroundColor: 'rgba(3,31,44,0.96)' },
  tab: { flex: 1, minWidth: 0, minHeight: 38, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 10, borderCurve: 'continuous' },
  tabActive: { backgroundColor: tokens.colors.lift },
  tabText: { fontFamily: 'monospace', fontSize: 9, fontWeight: '800', color: semantic.text.faint },
  tabTextActive: { color: semantic.text.primary },
  tabCount: { minWidth: 17, height: 17, paddingHorizontal: 4, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.accent },
  tabCountText: { fontFamily: 'monospace', fontSize: 9, fontWeight: '900', color: tokens.colors.backgroundDark },
  view: { gap: 8 },
  sectionHead: { minHeight: 36, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  sectionHeadCopy: { flex: 1, minWidth: 0 },
  sectionTitle: { fontSize: 12, fontWeight: '900', color: semantic.text.primary },
  sectionSubtitle: { paddingTop: 4, fontFamily: 'monospace', fontSize: 9, color: semantic.text.faint },
  sectionCount: { paddingTop: 2, fontFamily: 'monospace', fontSize: 9, textTransform: 'uppercase', color: semantic.text.dim },
  freshnessError: { color: tokens.colors.vermillion },
  readyCard: { minHeight: 76, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: 'rgba(255,209,102,0.42)', borderRadius: 16, borderCurve: 'continuous', backgroundColor: 'rgba(255,209,102,0.08)' },
  readyCopy: { flex: 1, minWidth: 0 },
  readyKicker: { fontFamily: 'monospace', fontSize: 9, fontWeight: '900', textTransform: 'uppercase', color: tokens.colors.accent },
  readyTitle: { paddingTop: 6, fontSize: 11, fontWeight: '900', color: semantic.text.primary },
  readyOutcome: { paddingTop: 4, fontFamily: 'monospace', fontSize: 8, color: semantic.text.dim },
  collectBtn: { minWidth: 94, minHeight: 40, paddingHorizontal: 10, borderRadius: 11, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.accent },
  collectText: { fontSize: 9, fontWeight: '900', color: tokens.colors.backgroundDark },
  rowError: { paddingTop: 5, fontSize: 9, lineHeight: 13, color: tokens.colors.vermillion },
  cardList: { gap: 7 },
  positionCard: { padding: 12, gap: 8, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 17, borderCurve: 'continuous', backgroundColor: tokens.colors.surface },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  cardKind: { fontFamily: 'monospace', fontSize: 9, fontWeight: '800', textTransform: 'uppercase', color: semantic.text.faint },
  positionPnl: { fontFamily: 'monospace', fontSize: 11, fontWeight: '900', color: tokens.colors.viridian },
  cardTitle: { fontSize: 12, fontWeight: '900', color: semantic.text.primary },
  positionOutcome: { fontFamily: 'monospace', fontSize: 9, fontWeight: '800', color: tokens.colors.viridian },
  positionStats: { paddingTop: 10, flexDirection: 'row', gap: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: semantic.border.muted },
  positionStat: { flex: 1, gap: 5 },
  positionStatRight: { alignItems: 'flex-end' },
  statLabel: { fontFamily: 'monospace', fontSize: 8, color: semantic.text.faint },
  statValue: { fontFamily: 'monospace', fontSize: 9, fontWeight: '900', color: semantic.text.primary },
  cashOutBtn: { minHeight: 38, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 10, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.ground },
  cashOutText: { fontFamily: 'monospace', fontSize: 9, fontWeight: '900', color: semantic.text.primary },
  ordersSummary: { minHeight: 48, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 14, borderCurve: 'continuous', backgroundColor: tokens.colors.walletCore },
  ordersSummaryLabel: { fontSize: 9, fontWeight: '800', color: semantic.text.dim },
  ordersSummaryValue: { fontFamily: 'monospace', fontSize: 11, fontWeight: '900', color: tokens.colors.accent },
  orderCard: { padding: 12, gap: 8, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 17, borderCurve: 'continuous', backgroundColor: tokens.colors.surface },
  orderStatus: { paddingHorizontal: 7, paddingVertical: 5, borderRadius: 7, overflow: 'hidden', fontFamily: 'monospace', fontSize: 8, fontWeight: '900', color: tokens.colors.accent, backgroundColor: 'rgba(255,209,102,0.09)' },
  orderMeta: { paddingTop: 3, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 9 },
  orderMetaText: { flex: 1, fontFamily: 'monospace', fontSize: 9, lineHeight: 13, color: semantic.text.dim },
  cancelBtn: { minWidth: 72, minHeight: 34, paddingHorizontal: 10, borderWidth: 1, borderColor: 'rgba(239,71,111,0.35)', borderRadius: 9, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.ground },
  cancelText: { fontFamily: 'monospace', fontSize: 9, fontWeight: '900', color: tokens.colors.vermillion },
  activityList: { gap: 2 },
  activityRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10 },
  activityIcon: { width: 35, height: 35, borderRadius: 11, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.surface },
  activityIconPositive: { backgroundColor: 'rgba(6,214,160,0.10)' },
  activityCopy: { flex: 1, minWidth: 0 },
  activityTitle: { fontSize: 10, fontWeight: '900', color: semantic.text.primary },
  activitySubtitle: { paddingTop: 5, fontFamily: 'monospace', fontSize: 8, color: semantic.text.faint },
  activityValueWrap: { alignItems: 'flex-end', gap: 4 },
  activityValue: { fontFamily: 'monospace', fontSize: 9, fontWeight: '900', color: semantic.text.primary },
  activityTime: { fontFamily: 'monospace', fontSize: 8, color: semantic.text.faint },
  empty: { minHeight: 132, padding: 18, alignItems: 'center', justifyContent: 'center', gap: 7, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 16, borderCurve: 'continuous', backgroundColor: tokens.colors.surface },
  emptyTitle: { fontSize: 12, fontWeight: '900', color: semantic.text.primary },
  emptyText: { maxWidth: 280, fontFamily: 'monospace', fontSize: 9, lineHeight: 14, textAlign: 'center', color: semantic.text.faint },
  emptyAction: { minWidth: 142, minHeight: 38, marginTop: 5, paddingHorizontal: 16, borderRadius: 10, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.viridian },
  emptyActionText: { fontSize: 10, fontWeight: '900', color: tokens.colors.backgroundDark },
  disabled: { opacity: 0.48 },
  positive: { color: tokens.colors.viridian },
  negative: { color: tokens.colors.vermillion },
});
