import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ActivityItem, ClosedPortfolioPosition, OpenOrder, PortfolioPosition } from '@/features/predict/predict.api';
import { redeemPosition } from '@/features/predict/predict.api';
import type { Signer } from '@/features/chain/chain.contract';
import { PredictActivityDetailModal } from '@/features/predict/components/PredictActivityDetailModal';
import { PredictActivityRow } from '@/features/predict/components/PredictActivityRow';
import { formatRedeemError, logRedeemError } from '@/features/predict/redeemErrors';
import {
  buildPredictActivityItems,
  filterActivityByScope,
  formatPredictFreshness,
  type PredictActivityItem,
  type PredictActivityScope,
  type PredictDataFreshness,
} from '@/features/predict/predictActivityState';
import type { PositionSellQuoteMap } from '@/features/predict/positionSellQuotes';
import { semantic, tokens } from '@/theme';

interface DetailPicksPanelProps {
  scope: PredictActivityScope;
  marketSlug: string;
  loading: boolean;
  freshness: PredictDataFreshness;
  marketTokenIds?: string[];
  marketConditionIds?: string[];
  marketPositions: PortfolioPosition[];
  allPositions: PortfolioPosition[];
  redeemablePositions: PortfolioPosition[];
  closedPositions: ClosedPortfolioPosition[];
  openOrders: OpenOrder[];
  activityItems: ActivityItem[];
  sellQuotes?: PositionSellQuoteMap;
  cancellingOrderId?: string | null;
  polygonAddress?: string | null;
  signer?: Signer | null;
  onScopeChange: (scope: PredictActivityScope) => void;
  onBackMore: (position: PortfolioPosition) => void;
  onCashOut: (position: PortfolioPosition) => void;
  onCancelOrder?: (orderId: string) => void;
  onRedeemed?: () => void;
  onRetry?: () => void;
}

function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--';
  return `$${value.toFixed(2)}`;
}

function formatSignedUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--';
  if (Math.abs(value) < 0.005) return '$0.00';
  return `${value > 0 ? '+' : '-'}${formatUsd(Math.abs(value))}`;
}

function mergePositions(primary: PortfolioPosition[], fallback: PortfolioPosition[]): PortfolioPosition[] {
  const seen = new Set<string>();
  const merged: PortfolioPosition[] = [];
  for (const position of [...primary, ...fallback]) {
    const key = `${position.asset}-${position.conditionId}-${position.outcomeIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(position);
  }
  return merged;
}

export function DetailPicksPanel({
  scope,
  marketSlug,
  loading,
  freshness,
  marketTokenIds = [],
  marketConditionIds = [],
  marketPositions,
  allPositions,
  redeemablePositions,
  closedPositions,
  openOrders,
  activityItems,
  sellQuotes,
  cancellingOrderId,
  polygonAddress,
  signer,
  onScopeChange,
  onBackMore,
  onCashOut,
  onCancelOrder,
  onRedeemed,
  onRetry,
}: DetailPicksPanelProps) {
  const [selectedItem, setSelectedItem] = useState<PredictActivityItem | null>(null);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<{ id: string; message: string } | null>(null);
  const [collectingIds, setCollectingIds] = useState<Set<string>>(() => new Set());
  const allItems = useMemo(
    () => buildPredictActivityItems({
      positions: mergePositions(allPositions, marketPositions),
      redeemablePositions,
      openOrders,
      closedPositions,
      sellQuotes,
    }),
    [allPositions, marketPositions, redeemablePositions, openOrders, closedPositions, sellQuotes],
  );
  const rows = useMemo(
    () => filterActivityByScope(allItems, scope, {
      slug: marketSlug,
      tokenIds: marketTokenIds,
      conditionIds: marketConditionIds,
    }),
    [allItems, scope, marketSlug, marketTokenIds, marketConditionIds],
  );
  const visibleRows = useMemo(
    () => rows.map((row) => collectingIds.has(row.id) ? { ...row, status: 'collecting' as const } : row),
    [rows, collectingIds],
  );
  const hasMissingLiveQuote = visibleRows.some((row) => row.source === 'position' && row.currentValue === null);
  const worthNow = hasMissingLiveQuote ? null : visibleRows.reduce((sum, row) => sum + (row.currentValue ?? 0), 0);
  const putIn = visibleRows.reduce((sum, row) => sum + row.putIn, 0);
  const totalPnl = hasMissingLiveQuote ? null : visibleRows.reduce((sum, row) => sum + (row.pnl ?? 0), 0);
  const rowVolumeFallback = visibleRows.reduce((sum, row) => sum + (row.source === 'order' || row.source === 'pending' ? 0 : row.putIn), 0);
  const tradeVolume = activityItems.reduce((sum, activity) => {
    if (!activityMatchesRows(activity, scope, marketSlug, visibleRows, marketTokenIds, marketConditionIds)) return sum;
    return sum + activityVolume(activity);
  }, 0);
  const userVolume = Math.max(tradeVolume, rowVolumeFallback);
  const pnlStyle = (totalPnl ?? 0) > 0.005 ? styles.summaryPositive : (totalPnl ?? 0) < -0.005 ? styles.summaryNegative : styles.summaryFlat;
  const freshnessCopy = formatPredictFreshness(freshness);

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
      onRedeemed?.();
    } catch (error) {
      logRedeemError('detail-picks-panel', error, item);
      setRedeemError({ id: item.id, message: formatRedeemError(error) });
    } finally {
      setRedeemingId(null);
    }
  }

  function cashOutItem(item: PredictActivityItem) {
    if (!item.rawPosition) return;
    setSelectedItem(null);
    onCashOut(item.rawPosition);
  }

  function backMoreItem(item: PredictActivityItem) {
    if (!item.rawPosition) return;
    setSelectedItem(null);
    onBackMore(item.rawPosition);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.heading}>
        <View>
          <Text style={styles.title}>Your Picks</Text>
          <Text style={[styles.freshness, freshness.error && styles.freshnessError]}>{freshnessCopy}</Text>
        </View>
        <View style={styles.headingSide}>
          <Text style={styles.subtitle}>
            {scope === 'market' ? `${visibleRows.length} this market` : `${visibleRows.length} all picks`}
          </Text>
          <View style={styles.scopeTabs}>
            <Pressable
              accessibilityRole="tab"
              accessibilityLabel="Show picks for this market"
              style={[styles.scopeTab, scope === 'market' && styles.scopeTabActive]}
              onPress={() => onScopeChange('market')}
              accessibilityState={{ selected: scope === 'market' }}
            >
              <Text style={[styles.scopeTabText, scope === 'market' && styles.scopeTabTextActive]}>This market</Text>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityLabel="Show all picks"
              style={[styles.scopeTab, scope === 'all' && styles.scopeTabActive]}
              onPress={() => onScopeChange('all')}
              accessibilityState={{ selected: scope === 'all' }}
            >
              <Text style={[styles.scopeTabText, scope === 'all' && styles.scopeTabTextActive]}>All picks</Text>
            </Pressable>
          </View>
        </View>
      </View>

      <View style={styles.summary}>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryLabel}>{scope === 'market' ? 'Put in' : 'All picks'}</Text>
          <Text style={styles.summaryValue}>{scope === 'market' ? formatUsd(putIn) : visibleRows.length}</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryLabel}>Cashout quote</Text>
          <Text style={styles.summaryValue}>{worthNow === null ? '--' : formatUsd(worthNow)}</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryLabel}>Your volume</Text>
          <Text style={styles.summaryValue}>{formatUsd(userVolume)}</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryLabel}>Live PNL</Text>
          <Text style={[styles.summaryValue, pnlStyle]}>{totalPnl === null ? '--' : formatSignedUsd(totalPnl)}</Text>
        </View>
      </View>

      {loading && visibleRows.length === 0 ? (
        <View style={styles.empty}>
          <ActivityIndicator color={tokens.colors.primary} size="small" />
        </View>
      ) : visibleRows.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{freshness.error ? 'Could not refresh picks' : 'No picks here yet'}</Text>
          <Text style={styles.emptyText}>
            {freshness.error
              ? 'Your last activity could not be loaded. Try refreshing in a moment.'
              : 'Make a pick below. Active, waiting, redeemable, and settled picks show here.'}
          </Text>
          {freshness.error && onRetry && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading picks"
              style={styles.retryBtn}
              onPress={onRetry}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          )}
        </View>
      ) : visibleRows.map((item) => (
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
          onCancelOrder={item.orderId && onCancelOrder ? () => onCancelOrder(item.orderId!) : undefined}
          onRedeem={() => void handleRedeem(item)}
          formatMoney={formatUsd}
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
          onCancelOrder?.(orderId);
        }}
        onRedeem={(item) => void handleRedeem(item)}
        redeeming={selectedItem ? redeemingId === selectedItem.id : false}
        redeemError={selectedItem && redeemError?.id === selectedItem.id ? redeemError.message : undefined}
        formatMoney={formatUsd}
      />
    </View>
  );
}

function normalizeKey(value: string | null | undefined): string | null {
  return value ? value.toLowerCase() : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function activityVolume(activity: ActivityItem): number {
  if (activity.type?.toUpperCase() !== 'TRADE') return 0;
  const usdcSize = finiteNumber(activity.usdcSize);
  if (usdcSize !== null && usdcSize > 0) return Math.abs(usdcSize);
  const size = finiteNumber(activity.size);
  const price = finiteNumber(activity.price);
  if (size !== null && price !== null) {
    return Math.abs(size * price);
  }
  return 0;
}

function activityMatchesRows(
  activity: ActivityItem,
  scope: PredictActivityScope,
  marketSlug: string,
  rows: PredictActivityItem[],
  marketTokenIds: readonly string[],
  marketConditionIds: readonly string[],
): boolean {
  if (activity.type?.toUpperCase() !== 'TRADE') return false;
  if (scope === 'all') return true;

  const slugs = new Set<string>([marketSlug.toLowerCase()]);
  const tokenIds = new Set(marketTokenIds.map((id) => id.toLowerCase()));
  const conditionIds = new Set(marketConditionIds.map((id) => id.toLowerCase()));

  for (const row of rows) {
    const rowSlug = normalizeKey(row.marketSlug);
    const rowEventSlug = normalizeKey(row.eventSlug);
    const tokenId = normalizeKey(row.tokenId);
    const conditionId = normalizeKey(row.conditionId);
    if (rowSlug) slugs.add(rowSlug);
    if (rowEventSlug) slugs.add(rowEventSlug);
    if (tokenId) tokenIds.add(tokenId);
    if (conditionId) conditionIds.add(conditionId);
  }

  const activitySlug = normalizeKey(activity.slug);
  const activityEventSlug = normalizeKey(activity.eventSlug);
  const activityAsset = normalizeKey(activity.asset);
  const activityConditionId = normalizeKey(activity.conditionId);

  return (!!activitySlug && slugs.has(activitySlug))
    || (!!activityEventSlug && slugs.has(activityEventSlug))
    || (!!activityAsset && tokenIds.has(activityAsset))
    || (!!activityConditionId && conditionIds.has(activityConditionId));
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    paddingTop: 10,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: {
    fontFamily: 'monospace',
    fontSize: 10,
    letterSpacing: 1.6,
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
  headingSide: {
    alignItems: 'flex-end',
    gap: 4,
  },
  subtitle: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.faint,
    textTransform: 'uppercase',
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
  summary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
    borderRadius: 12,
    padding: 10,
  },
  summaryItem: {
    width: '47%',
    minWidth: 120,
  },
  summaryLabel: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1,
    color: semantic.text.faint,
    textTransform: 'uppercase',
  },
  summaryValue: {
    marginTop: 2,
    fontFamily: 'monospace',
    fontSize: 15,
    fontWeight: '800',
    color: semantic.text.primary,
  },
  summaryPositive: {
    color: tokens.colors.viridian,
  },
  summaryNegative: {
    color: tokens.colors.vermillion,
  },
  summaryFlat: {
    color: semantic.text.primary,
  },
  empty: {
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
    borderRadius: 12,
    padding: 14,
  },
  emptyTitle: {
    color: semantic.text.primary,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
  },
  emptyText: {
    color: semantic.text.dim,
    fontSize: 10,
    lineHeight: 15,
  },
  retryBtn: {
    marginTop: 10,
    alignSelf: 'flex-start',
    minHeight: 30,
    borderRadius: 8,
    backgroundColor: tokens.colors.primary,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  retryText: {
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '800',
    color: tokens.colors.backgroundDark,
    textTransform: 'uppercase',
  },
});
