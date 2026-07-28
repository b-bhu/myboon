import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppTopBar, AppTopBarLogo } from '@/components/AppTopBar';
import { AppProfileButton } from '@/components/AppProfileButton';
import { formatUsdCompact } from '@/lib/format';
import {
  fetchPhoenixMarkets,
  formatPhoenixPercent,
  formatPhoenixPrice,
  type PhoenixMarket,
} from '@/features/perps/phoenix.api';
import { useWallet } from '@/hooks/useWallet';
import { semantic, tokens } from '@/theme';

const MarketRow = memo(function MarketRow({
  market,
  onPress,
}: {
  market: PhoenixMarket;
  onPress: (symbol: string) => void;
}) {
  const hasChange = typeof market.change24h === 'number' && Number.isFinite(market.change24h);
  const isUp = (market.change24h ?? 0) >= 0;

  return (
    <Pressable
      style={({ pressed }) => [styles.tableRow, pressed && styles.tableRowPressed]}
      onPress={() => onPress(market.symbol)}
      accessibilityRole="button"
      accessibilityLabel={`Open ${market.symbol}`}
    >
      <View style={styles.tokenFallback}>
        <Text style={styles.tokenFallbackText}>{market.baseSymbol[0] ?? 'P'}</Text>
      </View>
      <View style={styles.symCol}>
        <Text style={styles.rowSym} numberOfLines={1}>
          {marketLabel(market)}{' '}
          <Text style={styles.rowLev}>
            {market.maxLeverage ? `${market.maxLeverage}×` : '--'}
          </Text>
        </Text>
      </View>
      <Text style={[styles.rowCell, styles.rowPrice]}>
        {formatPhoenixPrice(market.markPrice)}
      </Text>
      <Text style={[
        styles.rowCell,
        styles.rowChange,
        hasChange ? (isUp ? styles.textPos : styles.textNeg) : styles.textMuted,
      ]}>
        {formatPhoenixPercent(market.change24h)}
      </Text>
      <Text style={[styles.rowCell, styles.rowOi]}>
        {formatUsdCompact(market.openInterest)}
      </Text>
    </Pressable>
  );
});

export function PhoenixMarketListScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const wallet = useWallet();
  const [markets, setMarkets] = useState<PhoenixMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');

  const filteredMarkets = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    const filtered = query
      ? markets.filter((market) => (
        market.symbol.toLowerCase().includes(query)
        || market.baseSymbol.toLowerCase().includes(query)
      ))
      : markets;

    return [...filtered].sort(sortByOpenInterestDesc);
  }, [markets, searchText]);

  const loadMarkets = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setErrorMessage(null);

    try {
      setMarkets(await fetchPhoenixMarkets());
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Phoenix markets unavailable');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMarkets();
  }, [loadMarkets]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadMarkets(false);
    setRefreshing(false);
  }, [loadMarkets]);

  const goToMarket = useCallback((symbol: string) => {
    router.push(`/markets/phoenix/${encodeURIComponent(symbol)}`);
  }, [router]);

  const renderMarket = useCallback(
    ({ item }: { item: PhoenixMarket }) => <MarketRow market={item} onPress={goToMarket} />,
    [goToMarket],
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
        left={<AppTopBarLogo />}
        right={
          <AppProfileButton
            onPress={() => router.push('/markets/phoenix/profile')}
            connected={wallet.connected}
            label="Open Phoenix profile"
            hint="View your Phoenix trading account"
          />
        }
      />

      {loading ? (
        <View style={styles.stateContainer}>
          <ActivityIndicator size="small" color={semantic.text.accent} />
          <Text style={styles.stateText}>Loading Phoenix markets...</Text>
        </View>
      ) : errorMessage ? (
        <View style={styles.stateContainer}>
          <Text style={styles.errorTitle}>Phoenix unavailable</Text>
          <Text style={styles.stateText}>{errorMessage}</Text>
          <Pressable style={styles.retryButton} onPress={() => void loadMarkets()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.tableContainer}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.thLeft]}>Market</Text>
            <Text style={[styles.th, styles.thRight, styles.thPrice]}>Price</Text>
            <Text style={[styles.th, styles.thRight, styles.thActive]}>24h</Text>
            <Text style={[styles.th, styles.thRight, styles.thOi]}>OI</Text>
          </View>

          <FlatList
            data={filteredMarkets}
            keyExtractor={(market) => market.symbol}
            renderItem={renderMarket}
            style={styles.tableList}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.tableBody}
            ListEmptyComponent={<EmptyMarketSearch searchText={searchText} />}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={semantic.text.accent} />}
          />

          <View style={styles.searchBar}>
            <MaterialIcons name="search" size={16} color={semantic.text.dim} />
            <TextInput
              style={styles.searchInput}
              value={searchText}
              onChangeText={setSearchText}
              placeholder="Search Phoenix..."
              placeholderTextColor={semantic.text.faint}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            {searchText.length > 0 && (
              <Pressable
                onPress={() => setSearchText('')}
                hitSlop={8}
                style={styles.searchClear}
                accessibilityRole="button"
                accessibilityLabel="Clear Phoenix search"
              >
                <MaterialIcons name="close" size={14} color={semantic.text.dim} />
              </Pressable>
            )}
            {searchText.length > 0 && (
              <Text style={styles.marketCount}>
                {filteredMarkets.length}/{markets.length}
              </Text>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function EmptyMarketSearch({ searchText }: { searchText: string }) {
  return (
    <View style={styles.emptySearch}>
      <Text style={styles.stateText}>
        {searchText.trim() ? 'No Phoenix markets match that search.' : 'No Phoenix markets returned.'}
      </Text>
    </View>
  );
}

function marketLabel(market: PhoenixMarket): string {
  return market.baseSymbol || market.venueSymbol || market.symbol.replace(/-PERP$/i, '');
}

function sortByOpenInterestDesc(a: PhoenixMarket, b: PhoenixMarket): number {
  const aOi = marketOpenInterest(a);
  const bOi = marketOpenInterest(b);
  if (aOi !== bOi) return bOi - aOi;
  return marketLabel(a).localeCompare(marketLabel(b));
}

function marketOpenInterest(market: PhoenixMarket): number {
  return typeof market.openInterest === 'number' && Number.isFinite(market.openInterest)
    ? market.openInterest
    : -1;
}

const COL_PRICE = 80;
const COL_CHANGE = 58;
const COL_OI = 60;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: semantic.background.screen,
  },
  stateContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacing.sm,
    padding: tokens.spacing.xl,
  },
  stateText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    lineHeight: 17,
    color: semantic.text.dim,
    textAlign: 'center',
  },
  errorTitle: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  retryButton: {
    marginTop: tokens.spacing.xs,
    backgroundColor: semantic.text.accent,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.radius.xs,
  },
  retryText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: semantic.background.screen,
  },
  tableContainer: {
    flex: 1,
  },
  tableList: {
    flex: 1,
  },
  tableHeader: {
    flexDirection: 'row',
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: semantic.border.muted,
    backgroundColor: semantic.background.screen,
  },
  th: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  thLeft: {
    flex: 1,
  },
  thRight: {
    textAlign: 'right',
  },
  thPrice: {
    width: COL_PRICE,
  },
  thActive: {
    color: tokens.colors.primaryDim,
    width: COL_CHANGE,
  },
  thOi: {
    width: COL_OI,
  },
  tableBody: {
    paddingTop: 0,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md + 2,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(48,47,32,0.5)',
  },
  tableRowPressed: {
    backgroundColor: 'rgba(199,183,112,0.04)',
  },
  tokenFallback: {
    width: 28,
    height: 28,
    borderRadius: 14,
    overflow: 'hidden',
    marginRight: tokens.spacing.sm,
    backgroundColor: semantic.background.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tokenFallbackText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
    color: semantic.text.dim,
  },
  symCol: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
  },
  rowSym: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    color: semantic.text.primary,
    letterSpacing: 0.2,
  },
  rowLev: {
    fontSize: tokens.fontSize.xs,
    fontWeight: '400',
    color: semantic.text.faint,
  },
  rowCell: {
    fontFamily: 'monospace',
    textAlign: 'right',
  },
  rowPrice: {
    fontSize: tokens.fontSize.sm,
    fontWeight: '600',
    color: semantic.text.primary,
    width: COL_PRICE,
  },
  rowChange: {
    fontSize: tokens.fontSize.sm,
    fontWeight: '600',
    width: COL_CHANGE,
  },
  rowOi: {
    fontSize: tokens.fontSize.xs,
    color: semantic.text.dim,
    width: COL_OI,
  },
  textPos: {
    color: tokens.colors.viridian,
  },
  textNeg: {
    color: tokens.colors.vermillion,
  },
  textMuted: {
    color: semantic.text.dim,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
  },
  searchInput: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.sm,
    color: semantic.text.primary,
    padding: 0,
  },
  searchClear: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: semantic.background.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  marketCount: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xxs,
    color: semantic.text.dim,
    letterSpacing: 0.5,
  },
  emptySearch: {
    padding: tokens.spacing.xl,
  },
});
