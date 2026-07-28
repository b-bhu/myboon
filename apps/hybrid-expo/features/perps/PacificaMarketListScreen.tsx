import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
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
import { SvgXml } from 'react-native-svg';
import { AppTopBar, AppTopBarLogo } from '@/components/AppTopBar';
import { AppProfileButton } from '@/components/AppProfileButton';
import {
  fetchPerpsMarkets,
  formatChange,
  formatPrice,
  formatUsdCompact,
} from '@/features/perps/perps.public-api';
import type { PerpsMarket } from '@/features/perps/perps.types';
import { useWallet } from '@/hooks/useWallet';
import { semantic, tokens } from '@/theme';

// In-memory SVG cache — persists for the app session
const svgCache = new Map<string, string | null>();

const TokenIcon = memo(function TokenIcon({ symbol, iconPath }: { symbol: string; iconPath: string }) {
  const base = symbol.split('-')[0];
  const cacheKey = iconPath || base;
  const uri = `${resolveApiBaseUrl()}${iconPath}`;
  const [xml, setXml] = useState<string | null>(svgCache.get(cacheKey) ?? null);
  const [failed, setFailed] = useState(svgCache.get(cacheKey) === null && svgCache.has(cacheKey));

  useEffect(() => {
    if (svgCache.has(cacheKey)) return;
    fetchWithTimeout(uri)
      .then((res) => (res.ok ? res.text() : Promise.reject()))
      .then((text) => { svgCache.set(cacheKey, text); setXml(text); })
      .catch(() => { svgCache.set(cacheKey, null); setFailed(true); });
  }, [cacheKey, uri]);

  if (failed || !xml) {
    return (
      <View style={[styles.tokenIcon, styles.tokenFallback]}>
        <Text style={styles.tokenFallbackText}>{base[0]}</Text>
      </View>
    );
  }
  return (
    <View style={styles.tokenIcon}>
      <SvgXml xml={xml} width={28} height={28} />
    </View>
  );
});

const MarketRow = memo(function MarketRow({
  market,
  onPress,
}: {
  market: PerpsMarket;
  onPress: (symbol: string) => void;
}) {
  const isUp = market.change24h >= 0;

  return (
    <Pressable
      style={({ pressed }) => [styles.tableRow, pressed && styles.tableRowPressed]}
      onPress={() => onPress(market.symbol)}>
      <TokenIcon symbol={market.symbol} iconPath={market.iconPath} />
      <View style={styles.symCol}>
        <Text style={styles.rowSym}>{market.symbol} <Text style={styles.rowLev}>{market.maxLeverage}×</Text></Text>
      </View>
      <Text style={[styles.rowCell, styles.rowPrice]}>
        {formatPrice(market.markPrice)}
      </Text>
      <Text
        style={[styles.rowCell, styles.rowChange, isUp ? styles.textPos : styles.textNeg]}>
        {formatChange(market.change24h)}
      </Text>
      <Text style={[styles.rowCell, styles.rowOi]}>
        {formatUsdCompact(market.openInterest)}
      </Text>
    </Pressable>
  );
});


export function PacificaMarketListScreen() {
  const router = useRouter();
  const [markets, setMarkets] = useState<PerpsMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');

  const filteredMarkets = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    if (!query) return markets;
    return markets.filter((m) => m.symbol.toLowerCase().includes(query));
  }, [markets, searchText]);
  async function loadMarkets() {
    setLoading(true);
    setErrorMessage(null);
    try {
      const data = await fetchPerpsMarkets();
      setMarkets(data);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load markets');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMarkets();
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await fetchPerpsMarkets();
      setMarkets(data);
    } catch { /* silent */ }
    setRefreshing(false);
  }, []);

  const goToMarket = useCallback((symbol: string) => {
    router.push(`/markets/pacifica/${encodeURIComponent(symbol)}`);
  }, [router]);

  const renderMarket = useCallback(
    ({ item }: { item: PerpsMarket }) => <MarketRow market={item} onPress={goToMarket} />,
    [goToMarket],
  );

  const keyExtractor = useCallback((market: PerpsMarket) => market.symbol, []);

  const insets = useSafeAreaInsets();
  const wallet = useWallet();

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar
            left={<AppTopBarLogo />}
            right={
              <AppProfileButton
                onPress={() => router.push('/markets/pacifica/profile')}
                connected={wallet.connected}
                label="Open Pacifica profile"
                hint="View your Pacifica trading account"
              />
            }
          />

          {/* Markets table */}
          {loading ? (
            <View style={styles.stateContainer}>
              <ActivityIndicator size="small" color={semantic.text.accent} />
              <Text style={styles.stateText}>Loading markets...</Text>
            </View>
          ) : errorMessage ? (
            <View style={styles.stateContainer}>
              <Text style={styles.errorTitle}>Markets unavailable</Text>
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
                keyExtractor={keyExtractor}
                renderItem={renderMarket}
                style={styles.tableList}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.tableBody}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={semantic.text.accent} />}
              />

              {/* Bottom search bar */}
              <View style={styles.searchBar}>
                <MaterialIcons name="search" size={16} color={semantic.text.dim} />
                <TextInput
                  style={styles.searchInput}
                  value={searchText}
                  onChangeText={setSearchText}
                  placeholder="Search markets..."
                  placeholderTextColor={semantic.text.faint}
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
                {searchText.length > 0 && (
                  <Pressable
                    onPress={() => setSearchText('')}
                    hitSlop={8}
                    style={styles.searchClear}>
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

const COL_PRICE = 80;
const COL_CHANGE = 58;
const COL_OI = 60;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: semantic.background.screen,
  },

  // State (loading / error)
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

  // Table
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
  tokenIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    overflow: 'hidden',
    marginRight: tokens.spacing.sm,
  },
  tokenFallback: {
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

  // Color helpers
  textPos: {
    color: tokens.colors.viridian,
  },
  textNeg: {
    color: tokens.colors.vermillion,
  },

  // Bottom search bar
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
});
