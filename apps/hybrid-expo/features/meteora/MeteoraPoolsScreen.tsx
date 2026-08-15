import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type {
  MeteoraFreshness,
  MeteoraPoolSummary,
  MeteoraProtocolMetrics,
} from '@myboon/shared/meteora';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppProfileButton } from '@/components/AppProfileButton';
import { WalletTrigger } from '@/components/WalletTrigger';
import { METEORA_COLORS } from '@/features/meteora/components/MeteoraExecutionControls';
import { MarketList } from '@/features/markets/MarketList';
import { METEORA_COLUMNS, METEORA_THEME, meteoraToRow } from '@/features/meteora/meteora.rows';
import { meteoraClient } from '@/features/meteora/meteora.client';
import { useTokenIdentities } from '@/lib/token-identity';
import { mintRef } from '@/lib/token-identity.core';
import { formatCount, formatUsdCompact } from '@/lib/format';
import { useWallet } from '@/hooks/useWallet';

import type { ColumnSpec, MarketListRow } from '@/features/markets/venue.contract';

const PAGE_SIZE = 30;
const SEARCH_DELAY_MS = 300;

const METEORA = METEORA_COLORS;

const STABLECOIN_SYMBOLS = new Set([
  'DAI',
  'FDUSD',
  'PYUSD',
  'USDG',
  'USDS',
  'USDT',
  'USDC',
]);

type PoolFilter = 'all' | 'stable' | 'sol' | 'low_fee';
type PoolSort = 'volume' | 'fees' | 'tvl';

const SORT_OPTIONS: { id: PoolSort; label: string; apiValue: string; columnKey: string }[] = [
  { id: 'volume', label: '24h volume', apiValue: 'volume_24h:desc', columnKey: 'volume' },
  { id: 'fees', label: '24h fees', apiValue: 'fee_24h:desc', columnKey: 'fees' },
  { id: 'tvl', label: 'Liquidity', apiValue: 'tvl:desc', columnKey: 'tvl' },
];

const FILTER_OPTIONS: { id: PoolFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'stable', label: 'Stable' },
  { id: 'sol', label: 'SOL pairs' },
  { id: 'low_fee', label: 'Low fee' },
];

export function MeteoraPoolsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const requestId = useRef(0);

  const [pools, setPools] = useState<MeteoraPoolSummary[]>([]);
  const [metrics, setMetrics] = useState<MeteoraProtocolMetrics | null>(null);
  const [freshness, setFreshness] = useState<MeteoraFreshness | null>(null);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<PoolFilter>('all');
  const [activeSort, setActiveSort] = useState<PoolSort>('volume');
  const [sortOpen, setSortOpen] = useState(false);

  const currentSort = SORT_OPTIONS.find((option) => option.id === activeSort) ?? SORT_OPTIONS[0];

  useEffect(() => {
    const timeout = setTimeout(() => setSearchQuery(searchText.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [searchText]);

  const loadFirstPage = useCallback(async ({
    showLoading = true,
    clearCache = false,
  }: {
    showLoading?: boolean;
    clearCache?: boolean;
  } = {}) => {
    const nextRequestId = requestId.current + 1;
    requestId.current = nextRequestId;
    if (showLoading) setLoading(true);
    setErrorMessage(null);
    if (clearCache) meteoraClient.clearCache();

    try {
      const [poolResult, metricsResult] = await Promise.all([
        meteoraClient.listPools({
          page: 1,
          pageSize: PAGE_SIZE,
          query: searchQuery || undefined,
          sortBy: currentSort.apiValue,
        }),
        meteoraClient.getProtocolMetrics(),
      ]);

      if (requestId.current !== nextRequestId) return;
      setPools(poolResult.data.items);
      setPage(1);
      setHasNext(poolResult.data.hasNext);
      setMetrics(metricsResult.data);
      setFreshness(
        poolResult.freshness.state === 'stale'
          ? poolResult.freshness
          : metricsResult.freshness,
      );
    } catch (error) {
      if (requestId.current !== nextRequestId) return;
      setErrorMessage(error instanceof Error ? error.message : 'Meteora pools are unavailable');
    } finally {
      if (requestId.current === nextRequestId && showLoading) setLoading(false);
    }
  }, [currentSort.apiValue, searchQuery]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const filteredPools = useMemo(
    () => pools.filter((pool) => matchesFilter(pool, activeFilter)),
    [activeFilter, pools],
  );

  const identityRefs = useMemo(() => {
    const refs = new Set<string>();
    for (const pool of filteredPools) {
      refs.add(mintRef(pool.tokenX.address));
      refs.add(mintRef(pool.tokenY.address));
    }
    return Array.from(refs);
  }, [filteredPools]);
  const identities = useTokenIdentities(identityRefs);

  const rows: MarketListRow[] = useMemo(
    () => filteredPools.map((pool) => meteoraToRow(pool, identities)),
    [filteredPools, identities],
  );

  const columns = useMemo<[ColumnSpec, ColumnSpec, ColumnSpec]>(
    () => METEORA_COLUMNS.map((column) => ({
      ...column,
      active: column.key === currentSort.columnKey,
    })) as [ColumnSpec, ColumnSpec, ColumnSpec],
    [currentSort.columnKey],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadFirstPage({ showLoading: false, clearCache: true });
    setRefreshing(false);
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!hasNext || loading || loadingMore || errorMessage) return;
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const result = await meteoraClient.listPools({
        page: nextPage,
        pageSize: PAGE_SIZE,
        query: searchQuery || undefined,
        sortBy: currentSort.apiValue,
      });
      setPools((current) => mergePools(current, result.data.items));
      setPage(nextPage);
      setHasNext(result.data.hasNext);
      setFreshness(result.freshness);
    } catch {
      setHasNext(false);
    } finally {
      setLoadingMore(false);
    }
  }, [
    currentSort.apiValue,
    errorMessage,
    hasNext,
    loading,
    loadingMore,
    page,
    searchQuery,
  ]);

  const onPressRow = useCallback((row: MarketListRow) => {
    router.push({
      pathname: '/markets/meteora/[poolAddress]',
      params: { poolAddress: row.key },
    });
  }, [router]);

  const wallet = useWallet();

  const openProfile = useCallback(() => {
    router.push('/markets/meteora/profile');
  }, [router]);

  const resetDiscovery = useCallback(() => {
    setSearchText('');
    setActiveFilter('all');
  }, []);

  const hasQuery = searchQuery.length > 0;
  const hasFilter = activeFilter !== 'all';

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={8}
            style={styles.headerBack}
          >
            <MaterialIcons name="arrow-back" size={19} color={METEORA.text} />
          </Pressable>
          <Text style={styles.headerTitle}>Pools</Text>
        </View>
        <View style={styles.headerActions}>
          <WalletTrigger />
          <AppProfileButton
            onPress={openProfile}
            connected={wallet.connected}
            label="Open Meteora profile"
            hint="View your Meteora positions, orders, and history"
            borderColor={METEORA_COLORS.border}
            iconColor={METEORA_COLORS.text}
            backgroundColor="rgba(21,27,48,0.72)"
          />
        </View>
      </View>

      <MarketList
        rows={rows}
        columns={columns}
        theme={METEORA_THEME}
        loading={loading}
        refreshing={refreshing}
        onRefresh={onRefresh}
        error={errorMessage ? { message: errorMessage, onRetry: () => void loadFirstPage() } : undefined}
        empty={!errorMessage ? { searching: hasQuery || hasFilter, onReset: resetDiscovery } : undefined}
        searchBar={null}
        header={(
          <PoolsHeader
            metrics={metrics}
            freshness={freshness}
            searchText={searchText}
            onSearchTextChange={setSearchText}
            filter={activeFilter}
            onFilterChange={setActiveFilter}
            sortLabel={currentSort.label}
            onOpenSort={() => setSortOpen(true)}
          />
        )}
        footer={loadingMore ? (
          <View style={styles.loadingMore}>
            <ActivityIndicator size="small" color={METEORA.violet} />
          </View>
        ) : undefined}
        onEndReached={() => void loadMore()}
        onPressRow={onPressRow}
        displayName="Meteora"
      />

      <SortSheet
        visible={sortOpen}
        value={activeSort}
        onClose={() => setSortOpen(false)}
        onChange={(sort) => {
          setActiveSort(sort);
          setSortOpen(false);
        }}
      />
    </View>
  );
}

function PoolsHeader({
  metrics,
  freshness,
  searchText,
  onSearchTextChange,
  filter,
  onFilterChange,
  sortLabel,
  onOpenSort,
}: {
  metrics: MeteoraProtocolMetrics | null;
  freshness: MeteoraFreshness | null;
  searchText: string;
  onSearchTextChange: (value: string) => void;
  filter: PoolFilter;
  onFilterChange: (value: PoolFilter) => void;
  sortLabel: string;
  onOpenSort: () => void;
}) {
  return (
    <View style={styles.headerContent}>
      <View style={styles.protocolCard}>
        <View style={styles.protocolTop}>
          <View>
            <Text style={styles.protocolEyebrow}>Meteora DLMM</Text>
            <Text style={styles.protocolTitle}>Liquidity, in motion.</Text>
          </View>
          <View style={[styles.liveBadge, freshness?.state === 'stale' && styles.staleBadge]}>
            <View style={[styles.liveDot, freshness?.state === 'stale' && styles.staleDot]} />
            <Text style={styles.liveText}>
              {freshness?.state === 'stale' ? 'STALE' : 'LIVE'}
            </Text>
          </View>
        </View>

        <View style={styles.protocolMetrics}>
          <ProtocolMetric label="24H FEES" value={formatUsdCompact(metrics?.fees24hUsd)} />
          <View style={styles.metricDivider} />
          <ProtocolMetric label="LIQUIDITY" value={formatUsdCompact(metrics?.totalTvlUsd)} />
          <View style={styles.metricDivider} />
          <ProtocolMetric label="POOLS" value={metrics ? formatCount(metrics.totalPools) : '—'} />
        </View>
      </View>

      <View style={styles.discoveryRow}>
        <View style={styles.searchBar}>
          <MaterialIcons name="search" size={18} color={METEORA.textDim} />
          <TextInput
            value={searchText}
            onChangeText={onSearchTextChange}
            placeholder="Search pools or tokens"
            placeholderTextColor={METEORA.textFaint}
            autoCapitalize="characters"
            autoCorrect={false}
            style={styles.searchInput}
            accessibilityLabel="Search Meteora pools"
          />
          {searchText.length > 0 ? (
            <Pressable
              onPress={() => onSearchTextChange('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Clear pool search"
            >
              <MaterialIcons name="close" size={17} color={METEORA.textDim} />
            </Pressable>
          ) : null}
        </View>

        <Pressable
          onPress={onOpenSort}
          style={({ pressed }) => [styles.sortButton, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`Sort pools by ${sortLabel}`}
        >
          <MaterialIcons name="sort" size={19} color={METEORA.text} />
        </Pressable>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
      >
        {FILTER_OPTIONS.map((option) => {
          const selected = filter === option.id;
          return (
            <Pressable
              key={option.id}
              onPress={() => onFilterChange(option.id)}
              accessibilityRole="button"
              accessibilityLabel={`Filter pools: ${option.label}`}
              accessibilityState={{ selected }}
              style={[styles.filterChip, selected && styles.filterChipActive]}
            >
              <Text style={[styles.filterText, selected && styles.filterTextActive]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function ProtocolMetric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.protocolMetric}>
      <Text style={styles.protocolMetricLabel}>{label}</Text>
      <Text style={styles.protocolMetricValue}>{value}</Text>
    </View>
  );
}

function SortSheet({
  visible,
  value,
  onClose,
  onChange,
}: {
  visible: boolean;
  value: PoolSort;
  onClose: () => void;
  onChange: (value: PoolSort) => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.sortSheet} onPress={(event) => event.stopPropagation()}>
          <View style={styles.sortHandle} />
          <Text style={styles.sortTitle}>Sort pools</Text>
          {SORT_OPTIONS.map((option) => {
            const selected = value === option.id;
            return (
              <Pressable
                key={option.id}
                onPress={() => onChange(option.id)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[styles.sortOption, selected && styles.sortOptionActive]}
              >
                <Text style={[styles.sortOptionText, selected && styles.sortOptionTextActive]}>
                  {option.label}
                </Text>
                {selected ? (
                  <MaterialIcons name="check" size={19} color={METEORA.violet} />
                ) : null}
              </Pressable>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function matchesFilter(pool: MeteoraPoolSummary, filter: PoolFilter): boolean {
  const tokenX = pool.tokenX.symbol.toUpperCase();
  const tokenY = pool.tokenY.symbol.toUpperCase();

  if (filter === 'stable') {
    return STABLECOIN_SYMBOLS.has(tokenX) && STABLECOIN_SYMBOLS.has(tokenY);
  }
  if (filter === 'sol') {
    return tokenX === 'SOL' || tokenY === 'SOL';
  }
  if (filter === 'low_fee') {
    const fee = Number(pool.baseFeePct);
    return Number.isFinite(fee) && fee <= 0.05;
  }
  return true;
}

function mergePools(
  current: MeteoraPoolSummary[],
  incoming: MeteoraPoolSummary[],
): MeteoraPoolSummary[] {
  const addresses = new Set(current.map((pool) => pool.address));
  return [...current, ...incoming.filter((pool) => !addresses.has(pool.address))];
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: METEORA.screen,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  header: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  headerBack: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    backgroundColor: 'rgba(21,27,48,0.72)',
  },
  headerTitle: {
    color: METEORA.text,
    fontSize: 19,
    lineHeight: 23,
    fontWeight: '800',
  },
  headerContent: {
    paddingHorizontal: 16,
  },
  protocolCard: {
    marginTop: 10,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: METEORA.border,
    backgroundColor: METEORA.surface,
  },
  protocolTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  protocolEyebrow: {
    color: METEORA.cyan,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: 5,
  },
  protocolTitle: {
    color: METEORA.text,
    fontSize: 21,
    lineHeight: 25,
    fontWeight: '800',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(52,211,153,0.34)',
    backgroundColor: 'rgba(52,211,153,0.10)',
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  staleBadge: {
    borderColor: 'rgba(255,107,74,0.38)',
    backgroundColor: 'rgba(255,107,74,0.10)',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: METEORA.green,
  },
  staleDot: {
    backgroundColor: METEORA.coral,
  },
  liveText: {
    color: METEORA.text,
    fontFamily: 'monospace',
    fontSize: 8,
    lineHeight: 10,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  protocolMetrics: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: 18,
  },
  protocolMetric: {
    flex: 1,
    gap: 5,
  },
  protocolMetricLabel: {
    color: METEORA.textFaint,
    fontFamily: 'monospace',
    fontSize: 8,
    lineHeight: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  protocolMetricValue: {
    color: METEORA.text,
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '800',
  },
  metricDivider: {
    width: 1,
    marginHorizontal: 12,
    backgroundColor: METEORA.border,
  },
  discoveryRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
  },
  searchBar: {
    flex: 1,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: METEORA.border,
    backgroundColor: METEORA.surface,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: METEORA.text,
    fontSize: 14,
    paddingVertical: 0,
  },
  sortButton: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: METEORA.border,
    backgroundColor: METEORA.surface,
  },
  filterRow: {
    gap: 8,
    paddingVertical: 12,
  },
  filterChip: {
    minHeight: 34,
    justifyContent: 'center',
    borderRadius: 17,
    borderWidth: 1,
    borderColor: METEORA.border,
    backgroundColor: METEORA.surface,
    paddingHorizontal: 14,
  },
  filterChipActive: {
    borderColor: METEORA.violet,
    backgroundColor: 'rgba(122,108,255,0.18)',
  },
  filterText: {
    color: METEORA.textDim,
    fontSize: 12,
    fontWeight: '700',
  },
  filterTextActive: {
    color: METEORA.text,
  },
  pressed: {
    opacity: 0.72,
  },
  loadingMore: {
    paddingVertical: 22,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.58)',
  },
  sortSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: METEORA.border,
    backgroundColor: METEORA.surface,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 32,
  },
  sortHandle: {
    width: 38,
    height: 4,
    alignSelf: 'center',
    borderRadius: 2,
    backgroundColor: METEORA.border,
    marginBottom: 16,
  },
  sortTitle: {
    color: METEORA.text,
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '800',
    marginBottom: 10,
  },
  sortOption: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: METEORA.border,
    paddingHorizontal: 4,
  },
  sortOptionActive: {
    backgroundColor: 'rgba(122,108,255,0.07)',
  },
  sortOptionText: {
    color: METEORA.textDim,
    fontSize: 14,
    fontWeight: '700',
  },
  sortOptionTextActive: {
    color: METEORA.text,
  },
});
