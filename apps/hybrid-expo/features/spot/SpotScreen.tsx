import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SpotDataApiClient, type SpotTokenBalance, type SpotWalletBalances } from '@myboon/shared/spot';
import { AppTopBar, AppTopBarIconButton } from '@/components/AppTopBar';
import { TokenIcon } from '@/components/TokenIcon';
import { useWalletSheet } from '@/features/wallet/WalletSheetProvider';
import { subscribeWalletDataChanged } from '@/features/wallet/wallet.refresh';
import { useWallet } from '@/hooks/useWallet';
import { resolveApiBaseUrl } from '@/lib/api';
import { semantic, tokens } from '@/theme';
import { fetchSpotPrices, fetchSpotTokens, searchSpotTokens, type SpotTokenSummary } from './spot.api';

type Tab = 'terminal' | 'profile';
const spotClient = new SpotDataApiClient({ apiBaseUrl: resolveApiBaseUrl() });
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_ICON_IDENTITY = { iconUrl: '/tokens/icon/sol', fallbackLetter: 'S' } as const;

function formatUsd(value: number | null): string { return value === null || !Number.isFinite(value) ? '—' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`; }
function formatTokenPriceUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute === 0) return '$0';
  if (absolute < 0.00000001) return '<$0.00000001';
  const maximumFractionDigits = absolute >= 1 ? 2 : absolute >= 0.01 ? 4 : absolute >= 0.0001 ? 6 : 8;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits })}`;
}
function formatCompactUsd(value: number | null): string { return value === null || !Number.isFinite(value) ? '—' : `$${Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`; }
function formatPct(value: number | null): string { return value === null || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`; }
function formatAtomicDisplay(value: string, decimals: number, maxFractionDigits = 8): string {
  if (!/^\d+$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return '—';
  const atomic = BigInt(value);
  if (decimals === 0) return atomic.toLocaleString('en-US');
  const base = 10n ** BigInt(decimals);
  const whole = atomic / base;
  const fraction = (atomic % base)
    .toString()
    .padStart(decimals, '0')
    .slice(0, Math.min(decimals, maxFractionDigits))
    .replace(/0+$/, '');
  return fraction ? `${whole.toLocaleString('en-US')}.${fraction}` : whole.toLocaleString('en-US');
}
function shortMint(value: string): string { return `${value.slice(0, 5)}…${value.slice(-4)}`; }
function TokenMark({ token }: { token: SpotTokenSummary }) {
  return <TokenIcon identity={token.identity} letter={token.identity.symbol} size={34} />;
}

function hasPositivePosition(position: SpotTokenBalance | null): position is SpotTokenBalance {
  return !!position && /^\d+$/.test(position.amount) && BigInt(position.amount) > 0n;
}

function StateCard({ title, message, retry }: { title: string; message?: string; retry?: () => void }) {
  return <View style={styles.stateCard}><MaterialIcons name="cloud-off" size={23} color={semantic.text.accentDim} /><Text style={styles.stateTitle}>{title}</Text>{message ? <Text style={styles.stateText}>{message}</Text> : null}{retry ? <Pressable onPress={retry} style={styles.stateButton}><Text style={styles.stateButtonText}>Try again</Text></Pressable> : null}</View>;
}

function Momentum({ token }: { token: SpotTokenSummary }) {
  return <View style={styles.momentum}>{([['5m', token.momentumPct.m5], ['1h', token.momentumPct.h1], ['6h', token.momentumPct.h6], ['24h', token.momentumPct.h24]] as const).map(([label, value]) => <View key={label} style={styles.momentumCell}><Text style={styles.meta}>{label}</Text><Text style={[styles.momentumValue, value !== null && value < 0 ? styles.negative : styles.positive]}>{formatPct(value)}</Text></View>)}</View>;
}

function ExpandedToken({ token, position, onTrade }: { token: SpotTokenSummary; position: SpotTokenBalance | null; onTrade: (mode: 'buy' | 'sell', token: SpotTokenSummary) => void }) {
  const warning = token.warnings.suspicious ? 'Suspicious signal' : null;
  const heldPosition = hasPositivePosition(position) ? position : null;
  const positionValue = heldPosition && token.usdPrice !== null ? heldPosition.uiAmount * token.usdPrice : null;
  return <View style={styles.expanded}>
    <Momentum token={token} />
    <View style={styles.stats}>{[['Market cap', formatUsd(token.market.marketCapUsd)], ['24h volume', formatUsd(token.market.volume24hUsd)], ['Liquidity', formatUsd(token.market.liquidityUsd)]].map(([label, value]) => <View style={styles.stat} key={label}><Text style={styles.meta}>{label}</Text><Text style={styles.statValue}>{value}</Text></View>)}</View>
    <View style={styles.positionRow}><Text style={styles.warningText}>Position: {heldPosition ? `${formatAtomicDisplay(heldPosition.amount, heldPosition.decimals)} ${heldPosition.symbol ?? token.identity.symbol} · ${formatUsd(positionValue)}` : 'not held'}</Text></View><View style={styles.warningRow}><Text style={styles.warningText}>{token.warnings.verification}</Text><Text style={styles.warningText}>Organic: {token.warnings.organicActivity}</Text>{warning ? <Text style={styles.warning}>{warning}</Text> : null}<Text style={styles.warningText}>{token.updatedAt ? `as of ${new Date(token.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'freshness unavailable'}</Text></View>
    <View style={styles.actions}><Pressable onPress={() => onTrade('buy', token)} style={[styles.tradeButton, styles.buyButton]} accessibilityRole="button" accessibilityLabel={`Buy ${token.identity.symbol}`}><Text style={styles.tradeButtonText}>Buy {token.identity.symbol}</Text></Pressable><Pressable disabled={!heldPosition} onPress={() => onTrade('sell', token)} style={[styles.tradeButton, styles.sellButton, !heldPosition && styles.tradeButtonDisabled]} accessibilityRole="button" accessibilityState={{ disabled: !heldPosition }} accessibilityLabel={`Sell ${token.identity.symbol}`}><Text style={[styles.tradeButtonText, styles.sellText, !heldPosition && styles.tradeButtonTextDisabled]}>Sell {token.identity.symbol}</Text></Pressable></View>
  </View>;
}

function TokenRow({ token, position, expanded, onPress, onTrade }: { token: SpotTokenSummary; position: SpotTokenBalance | null; expanded: boolean; onPress: () => void; onTrade: (mode: 'buy' | 'sell', token: SpotTokenSummary) => void }) {
  const warning = token.warnings.suspicious ? ' · suspicious' : token.warnings.verification === 'verified' ? ' · verified' : ` · ${token.warnings.verification}`;
  const holding = position ? ` · ${formatAtomicDisplay(position.amount, position.decimals, 4)} held` : '';
  return <View style={styles.tokenItem}><Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`Open ${token.identity.symbol} ${token.identity.name}`} style={({ pressed }) => [styles.tokenRow, expanded && styles.tokenRowExpanded, pressed && styles.pressed]}><TokenMark token={token} /><View style={styles.tokenName}><Text style={styles.symbol}>{token.identity.symbol}</Text><Text style={styles.name} numberOfLines={1}>{token.identity.name}</Text><Text style={[styles.mint, token.warnings.suspicious && styles.warning]} numberOfLines={1}>Liq {formatCompactUsd(token.market.liquidityUsd)}{holding}{warning}</Text></View><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.72} style={styles.price}>{formatTokenPriceUsd(token.usdPrice)}</Text><Text style={[styles.change, token.momentumPct.h24 !== null && token.momentumPct.h24 < 0 ? styles.negative : styles.positive]}>{formatPct(token.momentumPct.h24)}</Text></Pressable>{expanded ? <ExpandedToken token={token} position={position} onTrade={onTrade} /> : null}</View>;
}

function Profile({ walletAddress }: { walletAddress: string | null }) {
  const [data, setData] = useState<SpotWalletBalances | null>(null);
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const [balanceFreshness, setBalanceFreshness] = useState<string | null>(null);
  const [priceAsOf, setPriceAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (refresh = false) => {
    if (!walletAddress) { setData(null); return; }
    setLoading(!refresh); setRefreshing(refresh); setError(null);
    try {
      if (refresh) spotClient.clearCache();
      const balances = await spotClient.getWalletBalances(walletAddress);
      setData(balances.data); setBalanceFreshness(balances.freshness.state);
      try {
        const priced = await fetchSpotPrices(balances.data.tokens.map((token) => token.mint));
        setPrices(Object.fromEntries(priced.prices.map((entry) => [entry.mint, entry.usdPrice])));
        setPriceAsOf(priced.asOf);
      } catch {
        setPrices({});
        setPriceAsOf(null);
        setError('Current valuation is temporarily unavailable.');
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Profile unavailable'); }
    finally { setLoading(false); setRefreshing(false); }
  }, [walletAddress]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeWalletDataChanged(() => { void load(true); }), [load]);
  if (!walletAddress) return <StateCard title="Connect a wallet to view Spot Profile" />;
  if (loading) return <View style={styles.center}><ActivityIndicator color={semantic.text.accentDim} /><Text style={styles.stateText}>Loading balances…</Text></View>;
  if (error && !data) return <StateCard title="Spot profile unavailable" message={error} retry={() => void load(true)} />;
  const tokensHeld = data?.tokens ?? [];
  const rows = tokensHeld.map((token) => ({ token, usd: prices[token.mint] === null || prices[token.mint] === undefined ? null : prices[token.mint]! * token.uiAmount })).map((row) => ({ ...row, usd: row.usd !== null && Number.isFinite(row.usd) ? row.usd : null }));
  const total = rows.reduce<number | null>((sum, row) => row.usd === null ? sum : (sum ?? 0) + row.usd, null);
  const pricedCount = rows.filter((row) => row.usd !== null).length;
  const valuationFreshness = priceAsOf
    ? `Price V3 as of ${new Date(priceAsOf).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'Price V3 freshness unavailable';
  return <ScrollView contentInsetAdjustmentBehavior="automatic" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={semantic.text.accentDim} />} contentContainerStyle={styles.profileContent}><Text style={styles.profileLabel}>Spot profile</Text>{error ? <Text style={styles.errorBanner}>{error}</Text> : null}<View style={styles.portfolioCard}><Text style={styles.meta}>{pricedCount === tokensHeld.length ? 'Current token value' : 'Priced token value'}</Text><Text style={styles.portfolioValue}>{formatUsd(total)}</Text><Text style={styles.meta}>{pricedCount} priced tokens · {tokensHeld.length - pricedCount} unpriced · {valuationFreshness} · balances {balanceFreshness ?? 'unknown'}</Text></View><Text style={styles.sectionTitle}>Your tokens</Text>{tokensHeld.length === 0 ? <StateCard title="No Spot balances" message="Held SPL tokens will appear here." /> : tokensHeld.map((token) => { const row = rows.find((item) => item.token.mint === token.mint)!; return <View style={styles.holdingRow} key={token.mint}><TokenIcon identity={token.mint === SOL_MINT ? SOL_ICON_IDENTITY : null} venueIconUrl={token.iconUrl} letter={token.symbol ?? shortMint(token.mint)} size={34} /><View style={styles.tokenName}><Text style={styles.symbol}>{token.symbol ?? shortMint(token.mint)}</Text><Text style={styles.name}>{formatAtomicDisplay(token.amount, token.decimals)} {token.symbol ?? ''}</Text></View><View style={styles.holdingValue}><Text style={styles.statValue}>{formatUsd(row.usd)}</Text><Text style={styles.meta}>Current value</Text></View></View>; })}<Text style={styles.sectionTitle}>Valuation coverage</Text><View style={styles.stats}>{[['Tokens', String(tokensHeld.length)], ['Priced', String(pricedCount)], ['Unpriced', String(tokensHeld.length - pricedCount)]].map(([label, value]) => <View style={styles.stat} key={label}><Text style={styles.meta}>{label}</Text><Text style={styles.statValue}>{value}</Text></View>)}</View></ScrollView>;
}

export function SpotScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const walletSheet = useWalletSheet();
  const params = useLocalSearchParams<{ token?: string }>();
  const wallet = useWallet();
  const [tab, setTab] = useState<Tab>('terminal');
  const [items, setItems] = useState<SpotTokenSummary[]>([]);
  const [expanded, setExpanded] = useState<string | null>(typeof params.token === 'string' ? params.token : null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [partial, setPartial] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [spotBalances, setSpotBalances] = useState<Record<string, SpotTokenBalance>>({});
  const requestRef = useRef(0);
  const listRef = useRef<FlatList<SpotTokenSummary>>(null);
  const itemsRef = useRef<SpotTokenSummary[]>([]);
  const deepLinkRef = useRef<string | null>(null);
  const load = useCallback(async (refresh = false) => {
    const id = ++requestRef.current; setLoading(!refresh); setRefreshing(refresh); setError(null);
    try { const result = await fetchSpotTokens(); if (id !== requestRef.current) return; itemsRef.current = result.items; setItems(result.items); setPartial(result.partial); setStale(false); }
    catch (cause) { if (id !== requestRef.current) return; setStale(itemsRef.current.length > 0); setError(cause instanceof Error ? cause.message : 'Spot terminal unavailable'); }
    finally { if (id === requestRef.current) { setLoading(false); setRefreshing(false); } }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useFocusEffect(useCallback(() => {
    if (!wallet.address) { setSpotBalances({}); return; }
    spotClient.clearCache();
    spotClient.getWalletBalances(wallet.address).then((result) => setSpotBalances(Object.fromEntries(result.data.tokens.map((token) => [token.mint, token])))).catch(() => {});
  }, [wallet.address]));
  useEffect(() => { if (typeof params.token === 'string' && params.token !== expanded) setExpanded(params.token); }, [params.token, expanded]);
  useEffect(() => {
    if (!expanded) return;
    const index = items.findIndex((item) => item.identity.mint === expanded);
    if (index < 0) return;
    const frame = requestAnimationFrame(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.15 }));
    return () => cancelAnimationFrame(frame);
  }, [expanded, items]);
  useEffect(() => {
    const mint = typeof params.token === 'string' && MINT_RE.test(params.token) ? params.token : null;
    if (!mint || items.some((item) => item.identity.mint === mint) || deepLinkRef.current === mint) return;
    deepLinkRef.current = mint;
    searchSpotTokens(mint).then((result) => {
      const exact = result.items.find((item) => item.identity.mint === mint);
      if (exact) setItems((previous) => [exact, ...previous.filter((item) => item.identity.mint !== mint)]);
    }).catch(() => setSearchError('Linked token could not be resolved.'));
  }, [items, params.token]);
  useEffect(() => { const trimmed = query.trim(); if (!trimmed) { setSearchError(null); void load(); return; } const timer = setTimeout(async () => { try { const result = await searchSpotTokens(trimmed); itemsRef.current = result.items; setItems(result.items); setPartial(result.partial); setSearchError(null); } catch (cause) { setSearchError(cause instanceof Error ? cause.message : 'Search unavailable'); } }, 350); return () => clearTimeout(timer); }, [query, load]);
  const onRow = useCallback((token: SpotTokenSummary) => { const next = expanded === token.identity.mint ? null : token.identity.mint; setExpanded(next); if (next) router.setParams({ token: next }); else router.setParams({ token: undefined }); }, [expanded, router]);
  const onBack = useCallback(() => { if (expanded) { setExpanded(null); router.setParams({ token: undefined }); return; } router.back(); }, [expanded, router]);
  const onTrade = useCallback((mode: 'buy' | 'sell', token: SpotTokenSummary) => { if (!token.identity.mint) return; router.push({ pathname: '/swap', params: { mode, token: token.identity.mint, caller: 'spot' } }); }, [router]);
  const listEmpty = loading ? null : error && items.length === 0 ? <StateCard title="Spot terminal unavailable" message={error} retry={() => void load(true)} /> : <StateCard title={query ? 'No matching tokens' : 'No Spot tokens'} message={query ? 'Try a symbol, name, or canonical mint.' : 'No eligible tokens are available right now.'} />;
  return <View style={[styles.screen, { paddingTop: insets.top }]}><AppTopBar left={<AppTopBarIconButton icon="arrow-back" onPress={onBack} accessibilityLabel={expanded ? 'Collapse token' : 'Back to Wallet'} />} right={<Pressable style={styles.walletPill} onPress={() => walletSheet.open('solana')}><View style={styles.liveDot} /><Text style={styles.walletText}>{wallet.shortAddress ?? 'Connect wallet'}</Text></Pressable>} /><View style={styles.body}>{tab === 'terminal' ? <><View style={styles.tableHead}><Text style={styles.headToken}>Token</Text><Text style={styles.headCell}>Price</Text><Text style={styles.headCell}>24h</Text></View>{stale ? <Text style={styles.staleBanner}>Showing stale data · refresh to retry</Text> : null}{partial ? <Text style={styles.partialBanner}>Some token data is unavailable</Text> : null}{searchError ? <Text style={styles.errorBanner}>{searchError}</Text> : null}<FlatList ref={listRef} data={items} keyExtractor={(item) => item.identity.mint ?? item.identity.key} renderItem={({ item }) => <TokenRow token={item} position={item.identity.mint ? spotBalances[item.identity.mint] ?? null : null} expanded={expanded === item.identity.mint} onPress={() => onRow(item)} onTrade={onTrade} />} onScrollToIndexFailed={({ index, averageItemLength }) => listRef.current?.scrollToOffset({ offset: Math.max(0, index * averageItemLength), animated: true })} ListEmptyComponent={listEmpty} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={semantic.text.accentDim} />} contentContainerStyle={[styles.listContent, items.length === 0 && styles.listEmpty]} showsVerticalScrollIndicator={false} /></> : <Profile walletAddress={wallet.address} />}</View>{tab === 'terminal' ? <View style={styles.search}><MaterialIcons name="search" size={16} color={semantic.text.faint} /><TextInput value={query} onChangeText={(value) => { setQuery(value); setExpanded(null); router.setParams({ token: undefined }); }} placeholder="Search token or paste mint" placeholderTextColor={semantic.text.faint} autoCapitalize="none" autoCorrect={false} style={styles.searchInput} /><Pressable onPress={() => setQuery('')} hitSlop={8}><MaterialIcons name="close" size={15} color={query ? semantic.text.dim : 'transparent'} /></Pressable></View> : null}<View style={styles.tabs} accessibilityRole="tablist">{(['terminal', 'profile'] as Tab[]).map((value) => <Pressable key={value} onPress={() => setTab(value)} accessibilityRole="tab" accessibilityState={{ selected: tab === value }} style={[styles.tab, tab === value && styles.tabActive]}><MaterialIcons name={value === 'terminal' ? 'show-chart' : 'person'} size={16} color={tab === value ? semantic.text.primary : semantic.text.faint} /><Text style={[styles.tabText, tab === value && styles.tabTextActive]}>{value}</Text></Pressable>)}</View></View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.background.screen },
  body: { flex: 1, minHeight: 0 },
  walletPill: { minHeight: 34, paddingHorizontal: 10, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 999, backgroundColor: 'rgba(6,51,67,.7)', flexDirection: 'row', alignItems: 'center', gap: 5 },
  liveDot: { width: 6, height: 6, borderRadius: 999, backgroundColor: semantic.sentiment.positive },
  walletText: { color: semantic.text.dim, fontFamily: 'monospace', fontSize: 8, fontWeight: '800' },
  tableHead: { minHeight: 34, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: 'rgba(24,90,112,.58)' },
  headToken: { flex: 1, color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8, letterSpacing: .7, textTransform: 'uppercase' },
  headCell: { width: 66, color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8, letterSpacing: .7, textAlign: 'right', textTransform: 'uppercase' },
  tokenItem: { borderBottomWidth: 1, borderBottomColor: 'rgba(24,90,112,.58)' },
  tokenRow: { minHeight: 70, paddingHorizontal: 16, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 9 },
  tokenRowExpanded: { backgroundColor: 'rgba(10,74,96,.4)' }, pressed: { opacity: .78 },
  tokenName: { flex: 1, minWidth: 0 },
  symbol: { color: semantic.text.primary, fontSize: 13, fontWeight: '800' }, name: { color: semantic.text.faint, fontSize: 9, marginTop: 2 }, mint: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 7, marginTop: 2 },
  price: { width: 66, color: semantic.text.primary, fontFamily: 'monospace', fontSize: 10, textAlign: 'right' }, change: { width: 66, fontFamily: 'monospace', fontSize: 10, fontWeight: '800', textAlign: 'right' }, positive: { color: semantic.sentiment.positive }, negative: { color: semantic.sentiment.negative },
  expanded: { paddingHorizontal: 16, paddingVertical: 8, gap: 5, borderTopWidth: 1, borderTopColor: 'rgba(153,69,255,.65)', backgroundColor: 'rgba(8,61,80,.4)' },
  momentum: { minHeight: 50, flexDirection: 'row', borderWidth: 1, borderColor: 'rgba(24,90,112,.72)', borderRadius: 6, backgroundColor: 'rgba(3,31,44,.45)' }, momentumCell: { flex: 1, paddingHorizontal: 8, justifyContent: 'center', gap: 3, borderRightWidth: 1, borderRightColor: 'rgba(24,90,112,.72)' },
  meta: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 7, letterSpacing: .5, textTransform: 'uppercase' }, momentumValue: { fontFamily: 'monospace', fontSize: 10, fontWeight: '800' },
  stats: { minHeight: 38, flexDirection: 'row', borderWidth: 1, borderColor: 'rgba(24,90,112,.72)', borderRadius: 6, backgroundColor: 'rgba(3,31,44,.45)' }, stat: { flex: 1, paddingHorizontal: 8, justifyContent: 'center', gap: 2, borderRightWidth: 1, borderRightColor: 'rgba(24,90,112,.72)' }, statValue: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 9 },
  positionRow: { minHeight: 20, justifyContent: 'center' }, warningRow: { minHeight: 20, flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' }, warningText: { color: semantic.text.dim, fontFamily: 'monospace', fontSize: 8 }, warning: { color: semantic.sentiment.negative, fontFamily: 'monospace', fontSize: 8 },
  actions: { flexDirection: 'row', gap: 8 }, tradeButton: { flex: 1, minHeight: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' }, buyButton: { backgroundColor: semantic.sentiment.positive }, sellButton: { borderWidth: 1, borderColor: semantic.sentiment.negative, backgroundColor: 'rgba(239,71,111,.09)' }, tradeButtonDisabled: { opacity: .35 }, tradeButtonText: { color: semantic.text.primary, fontSize: 12, fontWeight: '800' }, sellText: { color: semantic.sentiment.negative }, tradeButtonTextDisabled: { color: semantic.text.faint },
  listContent: { paddingBottom: 126 }, listEmpty: { flexGrow: 1 }, stateCard: { minHeight: 220, padding: 28, alignItems: 'center', justifyContent: 'center', gap: 8 }, stateTitle: { color: semantic.text.primary, fontSize: 17, fontWeight: '800', textAlign: 'center' }, stateText: { color: semantic.text.dim, fontSize: 13, lineHeight: 19, textAlign: 'center' }, stateButton: { minHeight: 40, borderRadius: 20, paddingHorizontal: 18, justifyContent: 'center', backgroundColor: semantic.text.accentDim, marginTop: 8 }, stateButtonText: { color: semantic.background.screen, fontWeight: '800' }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  profileContent: { padding: 16, paddingBottom: 82 }, profileLabel: { color: tokens.walletBrand.spot, fontFamily: 'monospace', fontSize: 9, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' }, portfolioCard: { marginTop: 9, padding: 15, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 8, backgroundColor: semantic.background.surfaceRaised, gap: 4 }, portfolioValue: { color: semantic.text.primary, fontSize: 31, fontWeight: '800', letterSpacing: -1.2 }, sectionTitle: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 9, letterSpacing: .8, textTransform: 'uppercase', marginTop: 19, marginBottom: 8 }, holdingRow: { minHeight: 62, paddingHorizontal: 10, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: 'rgba(24,90,112,.58)' }, holdingValue: { alignItems: 'flex-end', gap: 3 },
  search: { position: 'absolute', right: 12, bottom: 67, left: 12, minHeight: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 6, backgroundColor: 'rgba(6,51,67,.96)', flexDirection: 'row', alignItems: 'center', gap: 9 }, searchInput: { flex: 1, color: semantic.text.primary, fontFamily: 'monospace', fontSize: 12, padding: 0 }, tabs: { position: 'absolute', right: 12, bottom: 10, left: 12, height: 51, padding: 3, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 13, backgroundColor: 'rgba(3,31,44,.94)', flexDirection: 'row', gap: 4 }, tab: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: 9 }, tabActive: { backgroundColor: semantic.background.lift }, tabText: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8, fontWeight: '800', letterSpacing: .7, textTransform: 'uppercase' }, tabTextActive: { color: semantic.text.primary }, staleBanner: { paddingHorizontal: 16, paddingVertical: 5, color: semantic.text.accentDim, backgroundColor: 'rgba(255,209,102,.08)', fontFamily: 'monospace', fontSize: 8 }, partialBanner: { paddingHorizontal: 16, paddingVertical: 5, color: semantic.text.dim, backgroundColor: 'rgba(17,138,178,.08)', fontFamily: 'monospace', fontSize: 8 }, errorBanner: { paddingHorizontal: 16, paddingVertical: 5, color: semantic.sentiment.negative, backgroundColor: 'rgba(239,71,111,.08)', fontFamily: 'monospace', fontSize: 8 },
});
