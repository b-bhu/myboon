import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { AppTopBar, AppTopBarIconButton, AppTopBarTitle } from '@/components/AppTopBar';
import { fetchMarketPositions, fetchActivity, placeBet } from '@/features/predict/predict.api';
import type { ActivityItem, PortfolioPosition } from '@/features/predict/predict.api';
import { getPredictMarketHref } from '@/features/predict/predict.navigation';
import { formatPredictTitle } from '@/features/predict/formatPredictTitle';
import { buildPositionSellQuote, getPositionSellQuote, usePositionSellQuotes } from '@/features/predict/positionSellQuotes';
import { useOddsFormat } from '@/hooks/useOddsFormat';
import { usePolymarketWallet } from '@/hooks/usePolymarketWallet';
import { semantic, tokens } from '@/theme';
import { SellForm } from './SellForm';

interface PositionDetailScreenProps {
  conditionId: string;
  slug: string;
  outcomeIndex: number;
}

function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  const prefix = value < 0 ? '-' : value > 0 ? '+' : '';
  if (abs >= 1000) return `${prefix}$${(abs / 1000).toFixed(1)}K`;
  return `${prefix}$${abs.toFixed(2)}`;
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  const day = d.getDate();
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${month} ${day} \u00B7 ${time}`;
}

export function PositionDetailScreen({ conditionId, slug, outcomeIndex }: PositionDetailScreenProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const poly = usePolymarketWallet();
  const { formatOdds } = useOddsFormat();

  const [position, setPosition] = useState<PortfolioPosition | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sellStatus, setSellStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [sellMessage, setSellMessage] = useState('');

  const gammaAddr = poly.tradingAddress ?? poly.polygonAddress;

  const loadData = useCallback(async () => {
    if (!gammaAddr) return;
    try {
      const [positions, allActivity] = await Promise.all([
        fetchMarketPositions(gammaAddr, slug),
        fetchActivity(gammaAddr),
      ]);
      // Find the specific position by conditionId + outcomeIndex
      const match = positions.find(
        (p) => p.conditionId === conditionId && p.outcomeIndex === outcomeIndex
      ) ?? positions.find((p) => p.conditionId === conditionId) ?? null;
      setPosition(match);
      // Filter activity to this market's slug
      setActivity(allActivity.filter((a) => a.slug === slug));
    } catch {
      setPosition(null);
      setActivity([]);
    }
  }, [gammaAddr, slug, conditionId, outcomeIndex]);

  useEffect(() => {
    setLoading(true);
    loadData().finally(() => setLoading(false));
  }, [loadData]);

  const {
    quotes: sellQuotes,
    booksByAsset: sellQuoteBooks,
  } = usePositionSellQuotes(position ? [position] : []);
  const sellQuote = getPositionSellQuote(sellQuotes, position);
  const sellBook = position?.asset ? sellQuoteBooks[position.asset] : null;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  async function handleSell(shares: number, price: number, mode: 'limit' | 'market') {
    if (!position || !poly.polygonAddress || submitting) return;

    const tokenID = position.asset;
    if (!tokenID) {
      setSellStatus('error');
      setSellMessage('Missing token ID');
      return;
    }

    // Ensure wallet can sign
    if (!poly.canSignLocally) {
      try {
        await poly.enable();
      } catch (err: any) {
        setSellStatus('error');
        setSellMessage(err.message || 'Failed to enable wallet');
        return;
      }
    }

    setSellStatus('idle');
    setSellMessage('');
    setSubmitting(true);
    try {
      // Market sell uses the worst live bid reached by the requested size as slippage protection.
      // Limit sell uses the user's exact specified price.
      const marketQuote = mode === 'market'
        ? buildPositionSellQuote(position, sellBook?.book ?? null, shares, sellBook?.loading ?? false, sellBook?.error ?? null)
        : null;
      if (mode === 'market' && (!marketQuote?.executable || marketQuote.limitPrice === null)) {
        throw new Error(marketQuote?.error || 'Not enough live bid liquidity to sell this size');
      }
      const orderPrice = mode === 'market' ? marketQuote!.limitPrice! : price;

      if (!poly.signer) throw new Error('Wallet session not ready');
      const result = await placeBet(poly.signer, {
        polygonAddress: poly.polygonAddress,
        tradingAddress: poly.tradingAddress,
        tokenID,
        price: orderPrice,
        size: shares,
        side: 'SELL',
        negRisk: !!position.negativeRisk,
        orderType: mode === 'market' ? 'FOK' : 'GTC',
      });
      if (!result.success) throw new Error(result.error || 'Order failed');

      setSellStatus('success');
      const soldAll = shares >= (position.size - 0.01);
      setSellMessage(soldAll ? 'Sold — returning to portfolio…' : `Sold ${shares.toFixed(2)} shares`);

      if (soldAll) {
        // Full sell — go back to profile after brief confirmation
        setTimeout(() => router.back(), 1200);
      } else {
        // Partial sell — refresh position data
        void loadData();
      }
    } catch (err: any) {
      setSellStatus('error');
      setSellMessage(err.message || 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <Header onBack={() => router.back()} title="Position" />
        <View style={styles.center}>
          <ActivityIndicator size="small" color={tokens.colors.primary} />
        </View>
      </View>
    );
  }

  if (!position) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <Header onBack={() => router.back()} title="Position" />
        <View style={styles.center}>
          <Text style={styles.emptyText}>Position not found</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading position"
            style={styles.retryBtn}
            onPress={() => { setLoading(true); loadData().finally(() => setLoading(false)); }}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const pnl = sellQuote?.cashPnl ?? null;
  const pctPnl = sellQuote?.percentPnl ?? null;
  const isUp = (pnl ?? 0) >= 0;
  const sellPrice = sellQuote?.averagePrice ?? sellQuote?.bestBid ?? null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <Header onBack={() => router.back()} title={position.outcome?.toUpperCase() ?? 'POSITION'} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={tokens.colors.primary}
            colors={[tokens.colors.primary]}
          />
        }
      >
        {/* Market title */}
        <View style={styles.titleSection}>
          <View style={[styles.outcomeBadge, isUp ? styles.badgePos : styles.badgeNeg]}>
            <Text style={[styles.outcomeBadgeText, isUp ? styles.posText : styles.negText]}>
              {position.outcome?.toUpperCase() ?? 'YES'}
            </Text>
          </View>
          <Text style={styles.marketTitle}>
            {formatPredictTitle({ title: position.title, slug: position.slug || position.eventSlug })}
          </Text>
          {position.endDate && (
            <Text style={styles.endDate}>
              Ends {new Date(position.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </Text>
          )}
        </View>

        {/* Stats grid */}
        <View style={styles.statsGrid}>
          <StatCell label="Shares" value={position.size.toFixed(2)} />
          <StatCell label="Avg Price" value={formatOdds(position.avgPrice)} />
          <StatCell label="Sell Quote" value={sellPrice === null ? '--' : formatOdds(sellPrice)} />
          <StatCell
            label="Live P&L"
            value={formatUsd(pnl)}
            color={isUp ? tokens.colors.viridian : tokens.colors.vermillion}
          />
          <StatCell
            label="Live Return"
            value={pctPnl === null ? '--' : `${pctPnl >= 0 ? '+' : ''}${pctPnl.toFixed(1)}%`}
            color={isUp ? tokens.colors.viridian : tokens.colors.vermillion}
          />
          <StatCell
            label="Cashout Quote"
            value={sellQuote?.estimatedProceeds === null || sellQuote?.estimatedProceeds === undefined ? '--' : `$${sellQuote.estimatedProceeds.toFixed(2)}`}
          />
        </View>

        {/* Sell form */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>SELL</Text>
          <SellForm
            maxShares={position.size}
            currentPrice={sellPrice ?? 0}
            walletReady={poly.canSignLocally}
            onConfirm={handleSell}
            submitting={submitting}
            status={sellStatus}
            statusMessage={sellMessage}
          />
        </View>

        {/* Trade history for this market */}
        {activity.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>TRADE HISTORY</Text>
            {activity.slice(0, 20).map((t, i) => {
              const isBuy = t.side === 'BUY';
              return (
                <View key={`${t.timestamp}-${i}`} style={styles.activityRow}>
                  <View style={[styles.sideBadge, isBuy ? styles.badgePos : styles.badgeNeg]}>
                    <Text style={[styles.sideBadgeText, isBuy ? styles.posText : styles.negText]}>
                      {t.side}
                    </Text>
                  </View>
                  <View style={styles.activityInfo}>
                    <Text style={styles.activitySize}>
                      {t.size.toFixed(2)} @ {formatOdds(t.price)}
                    </Text>
                    <Text style={styles.activityTime}>{formatDate(t.timestamp)}</Text>
                  </View>
                  <Text style={[styles.activityAmount, isBuy ? styles.negText : styles.posText]}>
                    {isBuy ? '-' : '+'}${t.usdcSize.toFixed(2)}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Bottom dock */}
      <View style={[styles.bottomDock, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="View market"
          style={styles.viewMarketBtn}
          onPress={() => {
            router.push(getPredictMarketHref(slug));
          }}
        >
          <MaterialIcons name="show-chart" size={14} color={tokens.colors.primary} />
          <Text style={styles.viewMarketText}>View Market</Text>
        </Pressable>
      </View>
    </View>
  );
}

// --- Sub-components ---

function Header({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <AppTopBar
      left={<AppTopBarIconButton icon="arrow-back" onPress={onBack} accessibilityLabel="Go back" />}
      center={<AppTopBarTitle>{title}</AppTopBarTitle>}
      right={<View style={styles.headerSpacer} />}
    />
  );
}

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : undefined]}>{value}</Text>
    </View>
  );
}

// --- Styles ---

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.background.screen },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  scroll: { flex: 1 },

  headerSpacer: {
    width: 28,
    height: 28,
  },

  // Title section
  titleSection: {
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: 16,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: semantic.border.muted,
  },
  outcomeBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  outcomeBadgeText: {
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1,
  },
  marketTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: semantic.text.primary,
    lineHeight: 20,
  },
  endDate: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: semantic.text.faint,
    letterSpacing: 0.5,
  },

  // Stats grid
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: 14,
    gap: 2,
    borderBottomWidth: 1,
    borderBottomColor: semantic.border.muted,
  },
  statCell: {
    width: '31%',
    backgroundColor: semantic.background.surface,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  statLabel: {
    fontFamily: 'monospace',
    fontSize: 7,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  statValue: {
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '700',
    color: semantic.text.primary,
  },

  // Section
  section: {
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: 14,
    gap: 10,
  },
  sectionTitle: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },

  // Activity rows
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    padding: 10,
    minHeight: 44,
  },
  sideBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 3,
  },
  sideBadgeText: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    fontWeight: '700',
  },
  activityInfo: {
    flex: 1,
    gap: 2,
  },
  activitySize: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.primary,
  },
  activityTime: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.faint,
  },
  activityAmount: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
  },

  // Bottom dock
  bottomDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: 12,
    backgroundColor: semantic.background.screen,
    borderTopWidth: 1,
    borderTopColor: semantic.border.muted,
  },
  viewMarketBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: semantic.background.lift,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    paddingVertical: 12,
    minHeight: 44,
  },
  viewMarketText: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: tokens.colors.primary,
    textTransform: 'uppercase',
  },

  // Color helpers
  badgePos: { backgroundColor: 'rgba(52,199,123,0.12)' },
  badgeNeg: { backgroundColor: 'rgba(244,88,78,0.12)' },
  posText: { color: tokens.colors.viridian },
  negText: { color: tokens.colors.vermillion },

  // Empty state
  emptyText: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: semantic.text.faint,
  },
  retryBtn: {
    backgroundColor: semantic.background.lift,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: 'center',
  },
  retryBtnText: {
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },
});
