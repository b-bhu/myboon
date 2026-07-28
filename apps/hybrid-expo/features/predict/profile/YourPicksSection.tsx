import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ClosedPortfolioPosition, OpenOrder, PortfolioPosition } from '@/features/predict/predict.api';
import { redeemPosition } from '@/features/predict/predict.api';
import type { Signer } from '@/features/chain/chain.contract';
import { PredictActivityDetailModal } from '@/features/predict/components/PredictActivityDetailModal';
import { PredictActivityRow } from '@/features/predict/components/PredictActivityRow';
import { formatRedeemError, logRedeemError } from '@/features/predict/redeemErrors';
import {
  buildPredictActivityItems,
  formatPredictFreshness,
  type PredictActivityItem,
  type PredictDataFreshness,
} from '@/features/predict/predictActivityState';
import type { MoneyFormatter } from '@/features/predict/formatPredictMoney';
import type { PositionSellQuoteMap } from '@/features/predict/positionSellQuotes';
import { semantic, tokens } from '@/theme';

interface YourPicksSectionProps {
  positions: PortfolioPosition[];
  openOrders: OpenOrder[];
  redeemablePositions: PortfolioPosition[];
  closedPositions: ClosedPortfolioPosition[];
  polygonAddress: string | null;
  signer: Signer | null;
  cancellingOrderId: string | null;
  freshness: PredictDataFreshness;
  sellQuotes?: PositionSellQuoteMap;
  onCashOutPress: (position: PortfolioPosition) => void;
  onMarketPress: (slug: string) => void;
  onCancelOrder: (orderId: string) => void;
  onRedeemed: () => void;
  formatMoney?: MoneyFormatter;
}

export function YourPicksSection({
  positions,
  openOrders,
  redeemablePositions,
  closedPositions,
  polygonAddress,
  signer,
  cancellingOrderId,
  freshness,
  sellQuotes,
  onCashOutPress,
  onMarketPress,
  onCancelOrder,
  onRedeemed,
  formatMoney,
}: YourPicksSectionProps) {
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const [selectedItem, setSelectedItem] = useState<PredictActivityItem | null>(null);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<{ id: string; message: string } | null>(null);
  const [collectingIds, setCollectingIds] = useState<Set<string>>(() => new Set());
  const allPicks = useMemo(
    () => buildPredictActivityItems({ positions, redeemablePositions, openOrders, closedPositions, sellQuotes }),
    [positions, redeemablePositions, openOrders, closedPositions, sellQuotes],
  );
  const visiblePicks = useMemo(
    () => allPicks.map((item) => collectingIds.has(item.id) ? { ...item, status: 'collecting' as const } : item),
    [allPicks, collectingIds],
  );
  const activePicks = visiblePicks.filter((item) =>
    item.status === 'syncing'
    || item.status === 'waiting_to_match'
    || item.status === 'cancel_requested'
    || item.status === 'active'
    || item.status === 'ready_to_collect'
    || item.status === 'collecting'
  );
  const picks = scope === 'all' ? visiblePicks : activePicks;
  const allCount = visiblePicks.length;
  if (allCount === 0) return null;

  const activeCount = visiblePicks.filter((item) =>
    item.status === 'syncing'
    || item.status === 'waiting_to_match'
    || item.status === 'cancel_requested'
    || item.status === 'active'
    || item.status === 'collecting'
  ).length;
  const readyCount = visiblePicks.filter((item) => item.status === 'ready_to_collect').length;
  const closedCount = visiblePicks.filter((item) => item.status === 'closed_won' || item.status === 'closed_lost').length;
  const countLabel = `${activeCount} active${readyCount > 0 ? ` · ${readyCount} ready` : ''}${closedCount > 0 ? ` · ${closedCount} history` : ''}`;

  async function handleRedeem(item: PredictActivityItem) {
    if (!polygonAddress || !signer || !item.rawPosition || redeemingId) return;
    setRedeemingId(item.id);
    setRedeemError(null);
    try {
      const result = await redeemPosition(signer, polygonAddress, {
        conditionId: item.rawPosition.conditionId,
        asset: item.rawPosition.asset,
        outcomeIndex: item.rawPosition.outcomeIndex,
        negativeRisk: item.rawPosition.negativeRisk,
      });
      if (!result.ok) throw new Error(result.error || 'Redeem failed');
      setRedeemError(null);
      setCollectingIds((current) => {
        const next = new Set(current);
        next.add(item.id);
        return next;
      });
      setSelectedItem(null);
      onRedeemed();
    } catch (error) {
      logRedeemError('your-picks-section', error, item);
      setRedeemError({ id: item.id, message: formatRedeemError(error) });
    } finally {
      setRedeemingId(null);
    }
  }

  function cashOutItem(item: PredictActivityItem) {
    if (!item.rawPosition) return;
    setSelectedItem(null);
    onCashOutPress(item.rawPosition);
  }

  function backMoreItem(item: PredictActivityItem) {
    if (!item.rawPosition?.slug) return;
    setSelectedItem(null);
    onMarketPress(item.rawPosition.slug);
  }

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Your Picks</Text>
          <Text style={[styles.freshness, freshness.error && styles.freshnessError]}>
            {formatPredictFreshness(freshness)}
          </Text>
        </View>
        <View style={styles.headerSide}>
          <Text style={styles.count}>{countLabel}</Text>
          <View style={styles.scopeTabs}>
            <Pressable
              accessibilityRole="tab"
              accessibilityLabel="Show active picks"
              style={[styles.scopeTab, scope === 'active' && styles.scopeTabActive]}
              onPress={() => setScope('active')}
              accessibilityState={{ selected: scope === 'active' }}
            >
              <Text style={[styles.scopeTabText, scope === 'active' && styles.scopeTabTextActive]}>Active</Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityLabel="Show all picks"
              style={[styles.scopeTab, scope === 'all' && styles.scopeTabActive]}
              onPress={() => setScope('all')}
              accessibilityState={{ selected: scope === 'all' }}
            >
              <Text style={[styles.scopeTabText, scope === 'all' && styles.scopeTabTextActive]}>All picks</Text>
            </Pressable>
          </View>
        </View>
      </View>

      {picks.length === 0 && (
        <View style={styles.emptyScope}>
          <Text style={styles.emptyScopeText}>No active picks right now</Text>
        </View>
      )}

      {picks.map((item) => (
        <PredictActivityRow
          key={item.id}
          item={item}
          showMarketTitle
          cancelling={cancellingOrderId === item.orderId}
          redeeming={redeemingId === item.id}
          redeemError={redeemError?.id === item.id ? redeemError.message : undefined}
          onPress={() => setSelectedItem(item)}
          onCashOut={() => cashOutItem(item)}
          onBackMore={() => backMoreItem(item)}
          onCancelOrder={item.orderId ? () => onCancelOrder(item.orderId!) : undefined}
          onRedeem={() => void handleRedeem(item)}
          formatMoney={formatMoney}
        />
      ))}

      <PredictActivityDetailModal
        visible={selectedItem !== null}
        item={selectedItem}
        freshness={freshness}
        onClose={() => setSelectedItem(null)}
        onCashOut={cashOutItem}
        onBackMore={backMoreItem}
        onCancelOrder={(orderId) => {
          setSelectedItem(null);
          onCancelOrder(orderId);
        }}
        onRedeem={(item) => void handleRedeem(item)}
        redeeming={selectedItem ? redeemingId === selectedItem.id : false}
        redeemError={selectedItem && redeemError?.id === selectedItem.id ? redeemError.message : undefined}
        formatMoney={formatMoney}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginHorizontal: tokens.spacing.lg,
    marginTop: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    gap: 10,
  },
  title: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: semantic.text.primary,
    fontWeight: '700',
  },
  freshness: {
    marginTop: 3,
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.faint,
    textTransform: 'uppercase',
  },
  freshnessError: {
    color: tokens.colors.vermillion,
  },
  headerSide: {
    alignItems: 'flex-end',
    gap: 5,
    flexShrink: 0,
  },
  count: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.faint,
  },
  scopeTabs: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 2,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(232,197,71,0.25)',
    backgroundColor: semantic.background.lift,
  },
  scopeTab: {
    minHeight: 24,
    borderRadius: 8,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scopeTabActive: {
    backgroundColor: tokens.colors.surface,
  },
  scopeTabText: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.faint,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  scopeTabTextActive: {
    color: semantic.text.primary,
  },
  emptyScope: {
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
  },
  emptyScopeText: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.faint,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
