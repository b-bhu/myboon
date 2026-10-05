import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type { MeteoraPoolSummary } from '@myboon/shared/meteora';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppProfileButton } from '@/components/AppProfileButton';
import { METEORA_COLORS, METEORA_TINTS } from '@/features/meteora/meteora.theme';
import { MarketList } from '@/features/markets/MarketList';
import { METEORA_COLUMNS, METEORA_THEME, meteoraToRow } from '@/features/meteora/meteora.rows';
import { meteoraClient } from '@/features/meteora/meteora.client';
import { resolveTokenIdentities, useTokenIdentities } from '@/lib/token-identity';
import { mintRef } from '@/lib/token-identity.core';
import { useWallet } from '@/hooks/useWallet';
import { tokens } from '@/theme/tokens';

import type { ColumnSpec, MarketListRow } from '@/features/markets/venue.contract';

const PAGE_SIZE = 30;
const SEARCH_DELAY_MS = 300;

const METEORA = METEORA_COLORS;

type PoolSort = 'volume' | 'fees' | 'tvl';

const SORT_OPTIONS: { id: PoolSort; label: string; apiValue: string; columnKey: string }[] = [
  { id: 'volume', label: '24h volume', apiValue: 'volume_24h:desc', columnKey: 'volume' },
  { id: 'fees', label: '24h fees', apiValue: 'fee_24h:desc', columnKey: 'fees' },
  { id: 'tvl', label: 'Liquidity', apiValue: 'tvl:desc', columnKey: 'tvl' },
];

export function MeteoraPoolsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const requestId = useRef(0);
  const firstPagePendingRef = useRef(false);
  const loadMoreRequestRef = useRef<number | null>(null);

  const [pools, setPools] = useState<MeteoraPoolSummary[]>([]);
  const [iconReloadKey, setIconReloadKey] = useState(0);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
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
    firstPagePendingRef.current = true;
    loadMoreRequestRef.current = null;
    setLoadingMore(false);
    if (showLoading) setLoading(true);
    setErrorMessage(null);
    if (clearCache) meteoraClient.clearCache();

    try {
      const poolResult = await meteoraClient.listPools({
        page: 1,
        pageSize: PAGE_SIZE,
        query: searchQuery || undefined,
        sortBy: currentSort.apiValue,
      });

      if (requestId.current !== nextRequestId) return;
      void resolveTokenIdentities(poolTokenRefs(poolResult.data.items), { force: clearCache });
      setPools(poolResult.data.items);
      setIconReloadKey((key) => key + 1);
      setPage(1);
      setHasNext(poolResult.data.hasNext);
    } catch (error) {
      if (requestId.current !== nextRequestId) return;
      setErrorMessage(error instanceof Error ? error.message : 'Meteora pools are unavailable');
    } finally {
      if (requestId.current === nextRequestId) {
        firstPagePendingRef.current = false;
        setLoading(false);
      }
    }
  }, [currentSort.apiValue, searchQuery]);

  useFocusEffect(useCallback(() => {
    void loadFirstPage({ showLoading: false });
    return () => {
      requestId.current += 1;
      firstPagePendingRef.current = false;
      loadMoreRequestRef.current = null;
    };
  }, [loadFirstPage]));

  const identityRefs = useMemo(() => {
    return poolTokenRefs(pools);
  }, [pools]);
  const identities = useTokenIdentities(identityRefs);

  const rows: MarketListRow[] = useMemo(
    () => pools.map((pool) => meteoraToRow(pool, identities)),
    [pools, identities],
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
    if (!hasNext || loading || loadingMore || errorMessage
      || firstPagePendingRef.current || loadMoreRequestRef.current !== null) return;
    const id = requestId.current;
    loadMoreRequestRef.current = id;
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const result = await meteoraClient.listPools({
        page: nextPage,
        pageSize: PAGE_SIZE,
        query: searchQuery || undefined,
        sortBy: currentSort.apiValue,
      });
      if (requestId.current !== id) return;
      void resolveTokenIdentities(poolTokenRefs(result.data.items));
      setPools((current) => mergePools(current, result.data.items));
      setPage(nextPage);
      setHasNext(result.data.hasNext);
    } catch {
      if (requestId.current === id) setHasNext(false);
    } finally {
      if (loadMoreRequestRef.current === id) {
        loadMoreRequestRef.current = null;
        setLoadingMore(false);
      }
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
  }, []);

  const hasQuery = searchQuery.length > 0;

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
        />
      </View>

      <PoolsToolbar
        searchText={searchText}
        onSearchTextChange={setSearchText}
        sortLabel={currentSort.label}
        onOpenSort={() => setSortOpen(true)}
      />

      <MarketList
        rows={rows}
        iconReloadKey={iconReloadKey}
        columns={columns}
        leadColumnLabel="Pool"
        theme={METEORA_THEME}
        loading={loading}
        refreshing={refreshing}
        onRefresh={onRefresh}
        error={errorMessage ? { message: errorMessage, onRetry: () => void loadFirstPage() } : undefined}
        empty={!errorMessage ? { searching: hasQuery, onReset: resetDiscovery } : undefined}
        searchBar={null}
        footer={loadingMore ? (
          <View style={styles.loadingMore}>
            <ActivityIndicator size="small" color={METEORA.primary} />
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

function poolTokenRefs(pools: readonly MeteoraPoolSummary[]): string[] {
  return Array.from(new Set(pools.flatMap((pool) => [mintRef(pool.tokenX.address), mintRef(pool.tokenY.address)])));
}

function PoolsToolbar({
  searchText,
  onSearchTextChange,
  sortLabel,
  onOpenSort,
}: {
  searchText: string;
  onSearchTextChange: (value: string) => void;
  sortLabel: string;
  onOpenSort: () => void;
}) {
  return (
    <View style={styles.toolbar}>
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
                  <MaterialIcons name="check" size={19} color={METEORA.accent} />
                ) : null}
              </Pressable>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
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
  headerBack: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    backgroundColor: METEORA.surfaceRaised,
  },
  headerTitle: {
    color: METEORA.text,
    fontSize: 19,
    lineHeight: 23,
    fontWeight: '800',
  },
  toolbar: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
  },
  discoveryRow: {
    flexDirection: 'row',
    gap: 8,
  },
  searchBar: {
    flex: 1,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderRadius: tokens.radius.md,
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
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: METEORA.border,
    backgroundColor: METEORA.surface,
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
    backgroundColor: METEORA_TINTS.backdrop,
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
    backgroundColor: METEORA_TINTS.selected,
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
