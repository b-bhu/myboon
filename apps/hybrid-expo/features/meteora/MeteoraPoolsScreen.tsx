import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type {
  MeteoraFreshness,
  MeteoraPoolSummary,
  MeteoraProtocolMetrics,
} from '@myboon/shared/meteora';
import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppProfileButton } from '@/components/AppProfileButton';
import { METEORA_COLORS } from '@/features/meteora/components/MeteoraExecutionControls';
import { useWallet } from '@/hooks/useWallet';
import { meteoraClient } from '@/features/meteora/meteora.client';

const PAGE_SIZE = 30;
const SEARCH_DELAY_MS = 300;
const COL_FEES = 58;
const COL_TVL = 58;
const COL_VOLUME = 62;

const METEORA = {
  screen: '#103D4C',
  surface: '#151B30',
  surfaceLift: '#1D2540',
  border: '#2B3453',
  text: '#F6F3FF',
  textDim: '#9AA3BD',
  textFaint: '#68728E',
  violet: '#7A6CFF',
  cyan: '#29C6D1',
  coral: '#FF6B4A',
  green: '#34D399',
} as const;

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

const SORT_OPTIONS: { id: PoolSort; label: string; apiValue: string }[] = [
  { id: 'volume', label: '24h volume', apiValue: 'volume_24h:desc' },
  { id: 'fees', label: '24h fees', apiValue: 'fee_24h:desc' },
  { id: 'tvl', label: 'Liquidity', apiValue: 'tvl:desc' },
];

const FILTER_OPTIONS: { id: PoolFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'stable', label: 'Stable' },
  { id: 'sol', label: 'SOL pairs' },
  { id: 'low_fee', label: 'Low fee' },
];

const PoolRow = memo(function PoolRow({
  pool,
  onPress,
}: {
  pool: MeteoraPoolSummary;
  onPress: (poolAddress: string) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(pool.address)}
      accessibilityRole="button"
      accessibilityLabel={[
        `Open ${pool.tokenX.symbol} ${pool.tokenY.symbol} Meteora pool.`,
        `${formatFee(pool.baseFeePct)} base fee.`,
        `${formatUsdAccessible(pool.fees24hUsd)} fees in 24 hours.`,
        `${formatUsdAccessible(pool.tvlUsd)} total liquidity.`,
        `${formatUsdAccessible(pool.volume24hUsd)} volume in 24 hours.`,
      ].join(' ')}
      accessibilityHint="View pool details"
      style={({ pressed }) => [styles.tableRow, pressed && styles.tableRowPressed]}
    >
      <TokenPair pool={pool} />

      <View style={styles.poolColumn}>
        <Text style={styles.rowPair} numberOfLines={1}>
          {pool.tokenX.symbol} / {pool.tokenY.symbol}
        </Text>
        <Text style={styles.rowFee} numberOfLines={1}>
          {formatFee(pool.baseFeePct)} fee{pool.hasFarm ? ' · Farm' : ''}
        </Text>
      </View>

      <Text style={[styles.rowCell, styles.rowFees]}>
        {formatUsdCompact(pool.fees24hUsd)}
      </Text>
      <Text style={[styles.rowCell, styles.rowTvl]}>
        {formatUsdCompact(pool.tvlUsd)}
      </Text>
      <Text style={[styles.rowCell, styles.rowVolume]}>
        {formatUsdCompact(pool.volume24hUsd)}
      </Text>
    </Pressable>
  );
});

function TokenPair({ pool }: { pool: MeteoraPoolSummary }) {
  return (
    <View style={styles.tokenPair}>
      <TokenMark
        symbol={pool.tokenX.symbol}
        iconUrl={pool.tokenX.iconUrl}
        color={METEORA.cyan}
      />
      <View style={styles.secondToken}>
        <TokenMark
          symbol={pool.tokenY.symbol}
          iconUrl={pool.tokenY.iconUrl}
          color={METEORA.violet}
        />
      </View>
    </View>
  );
}

function TokenMark({
  symbol,
  iconUrl,
  color,
}: {
  symbol: string;
  iconUrl: string | null;
  color: string;
}) {
  if (iconUrl) {
    return <Image source={{ uri: iconUrl }} style={styles.tokenImage} />;
  }

  return (
    <View style={[styles.tokenFallback, { backgroundColor: color }]}>
      <Text style={styles.tokenFallbackText}>{symbol.charAt(0) || '?'}</Text>
    </View>
  );
}

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

  const openPool = useCallback((poolAddress: string) => {
    router.push({
      pathname: '/markets/meteora/[poolAddress]',
      params: { poolAddress },
    });
  }, [router]);

  const wallet = useWallet();

  const openProfile = useCallback(() => {
    router.push('/markets/meteora/profile');
  }, [router]);

  const renderPool = useCallback(
    ({ item }: { item: MeteoraPoolSummary }) => <PoolRow pool={item} onPress={openPool} />,
    [openPool],
  );

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

      <FlatList
        data={loading ? [] : filteredPools}
        keyExtractor={(pool) => pool.address}
        renderItem={renderPool}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, 18) + 24 },
          !loading && filteredPools.length === 0 && styles.emptyContent,
        ]}
        ListHeaderComponent={(
          <PoolsHeader
            metrics={metrics}
            freshness={freshness}
            searchText={searchText}
            onSearchTextChange={setSearchText}
            filter={activeFilter}
            onFilterChange={setActiveFilter}
            sort={activeSort}
            sortLabel={currentSort.label}
            onOpenSort={() => setSortOpen(true)}
          />
        )}
        ListEmptyComponent={(
          loading
            ? <PoolsSkeleton />
            : errorMessage
              ? <PoolsFailure message={errorMessage} onRetry={() => void loadFirstPage()} />
              : (
                <PoolsEmpty
                  searching={searchQuery.length > 0}
                  filtered={activeFilter !== 'all'}
                  onReset={() => {
                    setSearchText('');
                    setActiveFilter('all');
                  }}
                />
              )
        )}
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.loadingMore}>
              <ActivityIndicator size="small" color={METEORA.violet} />
            </View>
          ) : null
        }
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.4}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={METEORA.violet}
            colors={[METEORA.violet]}
          />
        )}
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
  sort,
  sortLabel,
  onOpenSort,
}: {
  metrics: MeteoraProtocolMetrics | null;
  freshness: MeteoraFreshness | null;
  searchText: string;
  onSearchTextChange: (value: string) => void;
  filter: PoolFilter;
  onFilterChange: (value: PoolFilter) => void;
  sort: PoolSort;
  sortLabel: string;
  onOpenSort: () => void;
}) {
  return (
    <View>
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

      <View style={styles.tableHeader}>
        <Text style={[styles.tableHeading, styles.tableHeadingPool]}>Pool</Text>
        <Text style={[
          styles.tableHeading,
          styles.tableHeadingRight,
          styles.tableHeadingFees,
          sort === 'fees' && styles.tableHeadingActive,
        ]}>Fees</Text>
        <Text style={[
          styles.tableHeading,
          styles.tableHeadingRight,
          styles.tableHeadingTvl,
          sort === 'tvl' && styles.tableHeadingActive,
        ]}>TVL</Text>
        <Text style={[
          styles.tableHeading,
          styles.tableHeadingRight,
          styles.tableHeadingVolume,
          sort === 'volume' && styles.tableHeadingActive,
        ]}>Volume</Text>
      </View>
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

function PoolsSkeleton() {
  return (
    <View style={styles.skeletonStack}>
      {[0, 1, 2, 3, 4, 5].map((item) => (
        <View key={item} style={styles.skeletonRow}>
          <View style={styles.skeletonToken} />
          <View style={styles.skeletonCopy}>
            <View style={styles.skeletonTitle} />
            <View style={styles.skeletonMeta} />
          </View>
          <View style={styles.skeletonValue} />
          <View style={styles.skeletonValue} />
          <View style={styles.skeletonValueWide} />
        </View>
      ))}
    </View>
  );
}

function PoolsFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.stateCard}>
      <View style={styles.stateIcon}>
        <MaterialIcons name="cloud-off" size={23} color={METEORA.coral} />
      </View>
      <Text style={styles.stateTitle}>Pools unavailable</Text>
      <Text style={styles.stateText}>{message}</Text>
      <Pressable
        onPress={onRetry}
        style={styles.stateButton}
        accessibilityRole="button"
        accessibilityLabel="Try loading Meteora pools again"
      >
        <Text style={styles.stateButtonText}>Try again</Text>
      </Pressable>
    </View>
  );
}

function PoolsEmpty({
  searching,
  filtered,
  onReset,
}: {
  searching: boolean;
  filtered: boolean;
  onReset: () => void;
}) {
  return (
    <View style={styles.stateCard}>
      <View style={styles.stateIcon}>
        <MaterialIcons name="water-drop" size={23} color={METEORA.cyan} />
      </View>
      <Text style={styles.stateTitle}>
        {searching || filtered ? 'No matching pools' : 'No approved pools'}
      </Text>
      <Text style={styles.stateText}>
        {searching || filtered
          ? 'Try another token name or reset the active filter.'
          : 'Meteora has not returned any approved pools.'}
      </Text>
      {searching || filtered ? (
        <Pressable
          onPress={onReset}
          style={styles.stateButton}
          accessibilityRole="button"
          accessibilityLabel="Reset pool search and filters"
        >
          <Text style={styles.stateButtonText}>Reset discovery</Text>
        </Pressable>
      ) : null}
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

function formatUsdCompact(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';

  const absolute = Math.abs(amount);
  if (absolute >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`;
  if (absolute >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toFixed(amount >= 100 ? 0 : 2)}`;
}

function formatFee(value: string | null): string {
  const fee = Number(value);
  if (!Number.isFinite(fee)) return '—';
  return `${fee.toFixed(fee < 0.1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

function formatUsdAccessible(value: string | null): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Unavailable';
  return `${amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  })} US dollars`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
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
  content: {
    paddingHorizontal: 0,
  },
  headerContent: {
    paddingHorizontal: 16,
  },
  emptyContent: {
    flexGrow: 1,
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
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 5,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: METEORA.border,
  },
  tableHeading: {
    color: METEORA.textFaint,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '700',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  tableHeadingPool: {
    flex: 1,
  },
  tableHeadingRight: {
    textAlign: 'right',
  },
  tableHeadingFees: {
    width: COL_FEES,
  },
  tableHeadingTvl: {
    width: COL_TVL,
  },
  tableHeadingVolume: {
    width: COL_VOLUME,
  },
  tableHeadingActive: {
    color: METEORA.violet,
  },
  tableRow: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(43,52,83,0.72)',
  },
  tableRowPressed: {
    backgroundColor: 'rgba(122,108,255,0.06)',
  },
  pressed: {
    opacity: 0.72,
  },
  tokenPair: {
    width: 38,
    height: 30,
    position: 'relative',
    marginRight: 8,
  },
  secondToken: {
    position: 'absolute',
    right: 0,
    bottom: 0,
  },
  tokenImage: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: METEORA.surface,
    backgroundColor: METEORA.surfaceLift,
  },
  tokenFallback: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    borderWidth: 2,
    borderColor: METEORA.surface,
  },
  tokenFallbackText: {
    color: '#07111B',
    fontSize: 11,
    fontWeight: '900',
  },
  poolColumn: {
    flex: 1,
    minWidth: 0,
  },
  rowPair: {
    color: METEORA.text,
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  rowFee: {
    color: METEORA.textFaint,
    fontFamily: 'monospace',
    fontSize: 8,
    lineHeight: 11,
    marginTop: 2,
  },
  rowCell: {
    color: METEORA.text,
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '600',
    textAlign: 'right',
  },
  rowFees: {
    width: COL_FEES,
  },
  rowTvl: {
    width: COL_TVL,
  },
  rowVolume: {
    width: COL_VOLUME,
    color: METEORA.textDim,
  },
  skeletonStack: {
    gap: 1,
  },
  skeletonRow: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(43,52,83,0.72)',
  },
  skeletonToken: {
    width: 38,
    height: 28,
    borderRadius: 14,
    backgroundColor: METEORA.surfaceLift,
    marginRight: 8,
  },
  skeletonCopy: {
    flex: 1,
    gap: 7,
  },
  skeletonTitle: {
    width: '62%',
    height: 11,
    borderRadius: 4,
    backgroundColor: METEORA.surfaceLift,
  },
  skeletonMeta: {
    width: '38%',
    height: 8,
    borderRadius: 4,
    backgroundColor: METEORA.surfaceLift,
  },
  skeletonValue: {
    width: 58,
    height: 12,
    borderRadius: 4,
    backgroundColor: METEORA.surfaceLift,
  },
  skeletonValueWide: {
    width: 62,
    height: 12,
    borderRadius: 5,
    backgroundColor: METEORA.surfaceLift,
  },
  stateCard: {
    flex: 1,
    minHeight: 260,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  stateIcon: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    backgroundColor: METEORA.surface,
    marginBottom: 14,
  },
  stateTitle: {
    color: METEORA.text,
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '800',
    textAlign: 'center',
  },
  stateText: {
    maxWidth: 280,
    color: METEORA.textDim,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 7,
  },
  stateButton: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: METEORA.violet,
    paddingHorizontal: 18,
    marginTop: 16,
  },
  stateButtonText: {
    color: METEORA.text,
    fontSize: 12,
    fontWeight: '800',
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
