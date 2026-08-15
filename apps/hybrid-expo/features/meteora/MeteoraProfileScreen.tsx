import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type {
  MeteoraFreshness,
  MeteoraPortfolio,
  MeteoraPortfolioPool,
  MeteoraPositionEvent,
} from '@myboon/shared/meteora';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { WalletTrigger } from '@/components/WalletTrigger';
import { METEORA_COLORS } from '@/features/meteora/components/MeteoraExecutionControls';
import { MeteoraPositionActionSheet } from '@/features/meteora/components/MeteoraPositionActionSheet';
import { meteoraClient } from '@/features/meteora/meteora.client';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import { mintRef, useTokenIdentities } from '@/lib/token-identity';
import { useWallet } from '@/hooks/useWallet';

type ProfileTab = 'positions' | 'history';

const PROFILE_PAGE_SIZE = 20;
const HISTORY_POSITION_LIMIT = 20;

const TABS: { id: ProfileTab; label: string; icon: 'layers' | 'history' }[] = [
  { id: 'positions', label: 'Positions', icon: 'layers' },
  { id: 'history', label: 'History', icon: 'history' },
];

export function MeteoraProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const wallet = useWallet();
  const connectSheet = useConnectionSheet({ chain: 'solana', applicationLabel: 'Meteora' });
  const profileRequestId = useRef(0);
  const historyRequestId = useRef(0);

  const [activeTab, setActiveTab] = useState<ProfileTab>('positions');
  const [portfolio, setPortfolio] = useState<MeteoraPortfolio | null>(null);
  const [history, setHistory] = useState<MeteoraPositionEvent[]>([]);
  const [freshness, setFreshness] = useState<MeteoraFreshness | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [partialMessage, setPartialMessage] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const solanaWalletReady = wallet.connected && wallet.source === 'mwa' && !!wallet.address;

  const resetProfile = useCallback(() => {
    setPortfolio(null);
    setHistory([]);
    setFreshness(null);
    setHistoryLoaded(false);
    setErrorMessage(null);
    setPartialMessage(null);
    setHistoryError(null);
  }, []);

  const loadProfile = useCallback(async ({ refresh = false }: { refresh?: boolean } = {}) => {
    const requestId = profileRequestId.current + 1;
    profileRequestId.current = requestId;

    if (!solanaWalletReady || !wallet.address) {
      resetProfile();
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (refresh) {
      setRefreshing(true);
      meteoraClient.clearCache();
    } else {
      setLoading(true);
    }
    setErrorMessage(null);
    setPartialMessage(null);

    const results = await Promise.allSettled([
      meteoraClient.getOpenPortfolio(wallet.address, {
        page: 1,
        pageSize: PROFILE_PAGE_SIZE,
        sortBy: 'current_balances',
        sortDirection: 'desc',
      }),
    ]);

    if (profileRequestId.current !== requestId) return;

    const [portfolioResult] = results;
    const failures = results.filter((result) => result.status === 'rejected').length;

    if (portfolioResult.status === 'fulfilled') {
      setPortfolio(portfolioResult.value.data);
      setFreshness(portfolioResult.value.freshness);
    } else {
      setPortfolio(null);
    }

    setHistory([]);
    setHistoryLoaded(false);
    setHistoryError(null);

    if (failures === results.length) {
      setErrorMessage('Your Meteora profile could not be loaded. Pull to refresh or try again.');
    } else if (failures > 0) {
      setPartialMessage('Some Meteora profile data is temporarily unavailable.');
    }

    setLoading(false);
    setRefreshing(false);
  }, [resetProfile, solanaWalletReady, wallet.address]);

  useEffect(() => {
    void loadProfile();
    return () => {
      profileRequestId.current += 1;
      historyRequestId.current += 1;
    };
  }, [loadProfile]);

  const positionAddresses = useMemo(
    () => Array.from(new Set(
      portfolio?.pools.flatMap((pool) => pool.positionAddresses) ?? [],
    )).slice(0, HISTORY_POSITION_LIMIT),
    [portfolio],
  );

  // Meteora's position-history endpoint returns tokenX/tokenY as raw mint
  // identifiers rather than symbols (METEORA_QA_ISSUES.md Issue 4). Resolve
  // the human-readable pair from the pool data already loaded for Profile
  // instead of trusting that field.
  const poolSymbolsByAddress = useMemo(() => {
    const map = new Map<string, { tokenXSymbol: string; tokenYSymbol: string }>();
    for (const pool of portfolio?.pools ?? []) {
      map.set(pool.poolAddress, {
        tokenXSymbol: pool.tokenX.symbol,
        tokenYSymbol: pool.tokenY.symbol,
      });
    }
    return map;
  }, [portfolio]);

  // Closed positions fall through to the raw upstream fields, which are mint
  // addresses rather than symbols (Issue 4 below). Resolve those through the
  // identity service so history shows "ANTFUN / SOL" instead of
  // "CWZ6Bsdnj… / So1111…". Non-blocking, as everywhere else.
  const historyMintRefs = useMemo(() => {
    const mints = new Set<string>();
    for (const event of history) {
      if (poolSymbolsByAddress.has(event.poolAddress)) continue;
      if (looksLikeMint(event.tokenXSymbol)) mints.add(mintRef(event.tokenXSymbol));
      if (looksLikeMint(event.tokenYSymbol)) mints.add(mintRef(event.tokenYSymbol));
    }
    return [...mints];
  }, [history, poolSymbolsByAddress]);
  const historyIdentities = useTokenIdentities(historyMintRefs);

  const loadHistory = useCallback(async () => {
    if (!solanaWalletReady || historyLoaded || historyLoading || !portfolio) return;
    if (positionAddresses.length === 0) {
      setHistory([]);
      setHistoryLoaded(true);
      return;
    }

    const requestId = historyRequestId.current + 1;
    historyRequestId.current = requestId;
    setHistoryLoading(true);
    setHistoryError(null);

    const results = await Promise.allSettled(
      positionAddresses.map((address) => meteoraClient.getPositionHistory(address)),
    );
    if (historyRequestId.current !== requestId) return;

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof meteoraClient.getPositionHistory>>> => (
        result.status === 'fulfilled'
      ),
    );
    const events = fulfilled
      .flatMap((result) => result.value.data)
      .sort((a, b) => b.blockTime - a.blockTime)
      .slice(0, 50);

    setHistory(events);
    setHistoryLoaded(true);
    setHistoryLoading(false);
    if (fulfilled.length < results.length) {
      setHistoryError(
        fulfilled.length === 0
          ? 'Recent Meteora activity could not be loaded.'
          : 'Some recent activity is temporarily unavailable.',
      );
    }
  }, [historyLoaded, historyLoading, portfolio, positionAddresses, solanaWalletReady]);

  useEffect(() => {
    if (activeTab === 'history') void loadHistory();
  }, [activeTab, loadHistory]);

  const [actionSheetPool, setActionSheetPool] = useState<MeteoraPortfolioPool | null>(null);

  const openPositionSheet = useCallback((poolAddress: string) => {
    const pool = portfolio?.pools.find((candidate) => candidate.poolAddress === poolAddress) ?? null;
    setActionSheetPool(pool);
  }, [portfolio]);

  const closeActionSheet = useCallback(() => {
    setActionSheetPool(null);
  }, []);

  const goToAddLiquidity = useCallback((positionAddress: string) => {
    if (!actionSheetPool) return;
    setActionSheetPool(null);
    router.push({
      pathname: '/markets/meteora/[poolAddress]',
      params: { poolAddress: actionSheetPool.poolAddress, positionAddress },
    });
  }, [actionSheetPool, router]);

  const handlePositionChanged = useCallback(() => {
    void loadProfile({ refresh: true });
  }, [loadProfile]);

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
            <MaterialIcons name="arrow-back" size={19} color={METEORA_COLORS.text} />
          </Pressable>
          <View>
            <Text style={styles.headerTitle}>Profile</Text>
            <Text style={styles.headerAddress} numberOfLines={1}>
              {wallet.shortAddress ?? 'Meteora portfolio'}
            </Text>
          </View>
        </View>
        <WalletTrigger />
      </View>

      {!wallet.connected ? (
        <DisconnectedState
          onConnect={() => { void connectSheet.open().catch(() => {}); }}
          onBrowse={() => router.replace('/markets/meteora')}
        />
      ) : wallet.source !== 'mwa' ? (
        <UnsupportedWalletState onBrowse={() => router.replace('/markets/meteora')} />
      ) : loading ? (
        <LoadingState />
      ) : errorMessage && !portfolio ? (
        <FailureState message={errorMessage} onRetry={() => void loadProfile()} />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void loadProfile({ refresh: true })}
              tintColor={METEORA_COLORS.cyan}
              colors={[METEORA_COLORS.cyan]}
            />
          )}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: Math.max(insets.bottom, 18) + 30 },
          ]}
        >
          {freshness?.state === 'stale' ? (
            <View style={styles.inlineNotice}>
              <MaterialIcons name="schedule" size={15} color={METEORA_COLORS.coral} />
              <Text style={styles.inlineNoticeText}>Showing the latest cached Meteora data.</Text>
            </View>
          ) : null}
          {partialMessage ? (
            <View style={styles.inlineNotice}>
              <MaterialIcons name="info-outline" size={15} color={METEORA_COLORS.cyan} />
              <Text style={styles.inlineNoticeText}>{partialMessage}</Text>
            </View>
          ) : null}

          <PortfolioLedger portfolio={portfolio} />
          <ProfileTabs activeTab={activeTab} onChange={setActiveTab} />

          {activeTab === 'positions' ? (
            <PositionsList portfolio={portfolio} onOpenPool={openPositionSheet} />
          ) : (
            <HistoryList
              events={history}
              poolSymbols={poolSymbolsByAddress}
              identities={historyIdentities}
              loading={historyLoading}
              loaded={historyLoaded}
              error={historyError}
              onRetry={() => {
                setHistoryLoaded(false);
                setHistoryError(null);
              }}
            />
          )}
        </ScrollView>
      )}

      <MeteoraPositionActionSheet
        visible={!!actionSheetPool}
        pool={actionSheetPool}
        onClose={closeActionSheet}
        onAddLiquidity={goToAddLiquidity}
        onChanged={handlePositionChanged}
      />

    </View>
  );
}

function PortfolioLedger({ portfolio }: { portfolio: MeteoraPortfolio | null }) {
  const pnl = portfolio?.totalPnlUsd ?? null;
  const pnlTone = numberValue(pnl) >= 0 ? styles.positive : styles.negative;
  return (
    <View style={styles.ledger} accessibilityLabel="Meteora portfolio totals">
      <LedgerMetric label="CURRENT LIQUIDITY" value={formatUsd(portfolio?.totalBalanceUsd)} />
      <LedgerMetric label="UNCLAIMED FEES" value={formatUsd(portfolio?.totalUnclaimedFeesUsd)} />
      <LedgerMetric label="INDEXED P&L" value={formatSignedUsd(pnl)} valueStyle={pnl ? pnlTone : undefined} />
      <LedgerMetric label="OPEN POSITIONS" value={portfolio ? formatInteger(portfolio.totalPositions) : 'Unavailable'} />
    </View>
  );
}

function LedgerMetric({
  label,
  value,
  valueStyle,
}: {
  label: string;
  value: string;
  valueStyle?: object;
}) {
  return (
    <View style={styles.ledgerMetric}>
      <Text style={styles.ledgerLabel}>{label}</Text>
      <Text style={[styles.ledgerValue, valueStyle]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function ProfileTabs({
  activeTab,
  onChange,
}: {
  activeTab: ProfileTab;
  onChange: (tab: ProfileTab) => void;
}) {
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {TABS.map((tab) => {
        const selected = tab.id === activeTab;
        return (
          <Pressable
            key={tab.id}
            onPress={() => onChange(tab.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={[styles.tab, selected && styles.tabActive]}
          >
            <MaterialIcons
              name={tab.icon}
              size={16}
              color={selected ? METEORA_COLORS.text : METEORA_COLORS.textDim}
            />
            <Text style={[styles.tabText, selected && styles.tabTextActive]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function PositionsList({
  portfolio,
  onOpenPool,
}: {
  portfolio: MeteoraPortfolio | null;
  onOpenPool: (poolAddress: string) => void;
}) {
  if (!portfolio) {
    return <InlineEmpty title="Positions unavailable" message="Pull to refresh your Meteora positions." />;
  }
  if (portfolio.pools.length === 0) {
    return <InlineEmpty title="No open positions" message="Open a pool to create your first liquidity position." />;
  }

  return (
    <View style={styles.listSection}>
      <SectionHeading label="OPEN POSITIONS" count={portfolio.totalPositions} />
      {portfolio.pools.map((pool) => (
        <PositionPoolRow key={pool.poolAddress} pool={pool} onPress={onOpenPool} />
      ))}
      {portfolio.hasNext ? (
        <Text style={styles.listFootnote}>Showing the first {portfolio.pools.length} pool groups.</Text>
      ) : null}
    </View>
  );
}

function PositionPoolRow({
  pool,
  onPress,
}: {
  pool: MeteoraPortfolioPool;
  onPress: (poolAddress: string) => void;
}) {
  const status = positionStatus(pool);
  const pnl = numberValue(pool.pnlUsd);
  return (
    <Pressable
      onPress={() => onPress(pool.poolAddress)}
      accessibilityRole="button"
      accessibilityLabel={`${pool.pair}. ${pool.openPositionCount} open positions. ${status}. ${formatUsd(pool.balanceUsd)} current liquidity.`}
      accessibilityHint="Open position actions: add liquidity, claim fees, remove, or close"
      style={({ pressed }) => [styles.dataRow, pressed && styles.dataRowPressed]}
    >
      <View style={styles.rowTop}>
        <View style={styles.rowIdentity}>
          <Text style={styles.rowTitle} numberOfLines={1}>{pool.pair}</Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {formatInteger(pool.openPositionCount)} {pool.openPositionCount === 1 ? 'position' : 'positions'} · {status}
          </Text>
        </View>
        <View style={styles.rowValueWrap}>
          <Text style={styles.rowValue}>{formatUsd(pool.balanceUsd)}</Text>
          <Text style={[styles.rowDelta, pnl >= 0 ? styles.positive : styles.negative]}>
            {formatSignedUsd(pool.pnlUsd)}
          </Text>
        </View>
        <MaterialIcons name="chevron-right" size={20} color={METEORA_COLORS.textFaint} />
      </View>
      <View style={styles.rowFacts}>
        <RowFact label="Pool price" value={formatPrice(pool.currentPrice)} />
        <RowFact label="Fees" value={formatUsd(pool.unclaimedFeesUsd)} />
        <RowFact label="Range" value={status} />
      </View>
    </Pressable>
  );
}

function HistoryList({
  identities,
  events,
  poolSymbols,
  loading,
  loaded,
  error,
  onRetry,
}: {
  events: MeteoraPositionEvent[];
  poolSymbols: Map<string, { tokenXSymbol: string; tokenYSymbol: string }>;
  identities: ReadonlyMap<string, { symbol: string }>;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <View style={styles.inlineLoading}>
        <ActivityIndicator size="small" color={METEORA_COLORS.cyan} />
        <Text style={styles.stateMessage}>Loading recent activity…</Text>
      </View>
    );
  }
  if (error && events.length === 0) {
    return <InlineFailure message={error} onRetry={onRetry} />;
  }
  if (loaded && events.length === 0) {
    return <InlineEmpty title="No recent activity" message="Position events will appear here in date order." />;
  }

  return (
    <View style={styles.listSection}>
      {error ? <Text style={styles.historyWarning}>{error}</Text> : null}
      <SectionHeading label="RECENT ACTIVITY" count={events.length} />
      {events.map((event) => {
        const pair = resolvePairLabel(event, poolSymbols, identities);
        return (
          <View key={`${event.signature}:${event.instructionIndex}`} style={styles.historyRow}>
            <View style={styles.historyIcon}>
              <MaterialIcons name={historyIcon(event.eventType)} size={16} color={METEORA_COLORS.cyan} />
            </View>
            <View style={styles.historyCopy}>
              <Text style={styles.rowTitle}>{formatEventType(event.eventType)}</Text>
              <Text style={styles.rowMeta}>
                {pair} · {formatDate(event.blockTime, event.createdAt)}
              </Text>
            </View>
            <Text style={styles.historyValue}>{formatUsd(event.totalUsd)}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** Base58 and long enough to be a mint rather than a ticker. */
function looksLikeMint(value: string): boolean {
  return value.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

/**
 * Prefer the loaded portfolio, then token identity, then the raw upstream
 * field. The middle tier matters for CLOSED positions: their pool is no longer
 * in the portfolio, and upstream returns mint addresses rather than symbols
 * there (METEORA_QA_ISSUES.md Issue 4), so without identity the user sees
 * "CWZ6Bsdnj… / So1111…" in their own history.
 */
function resolvePairLabel(
  event: MeteoraPositionEvent,
  poolSymbols: Map<string, { tokenXSymbol: string; tokenYSymbol: string }>,
  identities: ReadonlyMap<string, { symbol: string }>,
): string {
  const resolved = poolSymbols.get(event.poolAddress);
  if (resolved) return `${resolved.tokenXSymbol} / ${resolved.tokenYSymbol}`;

  const label = (raw: string): string => {
    if (!looksLikeMint(raw)) return raw;
    const identity = identities.get(mintRef(raw));
    if (identity?.symbol) return identity.symbol;
    // Still unresolved: a shortened mint reads far better than 44 characters.
    return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
  };
  return `${label(event.tokenXSymbol)} / ${label(event.tokenYSymbol)}`;
}

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionHeadingText}>{label}</Text>
      <Text style={styles.sectionCount}>{formatInteger(count)}</Text>
    </View>
  );
}

function RowFact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.rowFact}>
      <Text style={styles.rowFactLabel}>{label}</Text>
      <Text style={styles.rowFactValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function DisconnectedState({ onConnect, onBrowse }: { onConnect: () => void; onBrowse: () => void }) {
  return (
    <View style={styles.fullState}>
      <MaterialIcons name="account-balance-wallet" size={34} color={METEORA_COLORS.cyan} />
      <Text style={styles.stateTitle}>Connect wallet</Text>
      <Text style={styles.stateMessage}>Your address is needed to load Meteora positions, orders, and history.</Text>
      <Pressable onPress={onConnect} style={styles.primaryAction} accessibilityRole="button">
        <Text style={styles.primaryActionText}>Connect wallet</Text>
      </Pressable>
      <Pressable onPress={onBrowse} style={styles.secondaryAction} accessibilityRole="button">
        <Text style={styles.secondaryActionText}>Browse pools</Text>
      </Pressable>
    </View>
  );
}

function UnsupportedWalletState({ onBrowse }: { onBrowse: () => void }) {
  return (
    <View style={styles.fullState}>
      <MaterialIcons name="info-outline" size={34} color={METEORA_COLORS.cyan} />
      <Text style={styles.stateTitle}>Solana wallet required</Text>
      <Text style={styles.stateMessage}>Choose a Solana wallet from the account menu to view this Meteora profile.</Text>
      <Pressable onPress={onBrowse} style={styles.secondaryAction} accessibilityRole="button">
        <Text style={styles.secondaryActionText}>Browse pools</Text>
      </Pressable>
    </View>
  );
}

function LoadingState() {
  return (
    <View style={styles.fullState}>
      <ActivityIndicator size="small" color={METEORA_COLORS.cyan} />
      <Text style={styles.stateMessage}>Loading Meteora profile…</Text>
    </View>
  );
}

function FailureState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.fullState}>
      <MaterialIcons name="cloud-off" size={34} color={METEORA_COLORS.coral} />
      <Text style={styles.stateTitle}>Profile unavailable</Text>
      <Text style={styles.stateMessage}>{message}</Text>
      <Pressable onPress={onRetry} style={styles.primaryAction} accessibilityRole="button">
        <Text style={styles.primaryActionText}>Try again</Text>
      </Pressable>
    </View>
  );
}

function InlineEmpty({ title, message }: { title: string; message: string }) {
  return (
    <View style={styles.inlineState}>
      <Text style={styles.inlineStateTitle}>{title}</Text>
      <Text style={styles.stateMessage}>{message}</Text>
    </View>
  );
}

function InlineFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.inlineState}>
      <Text style={styles.inlineStateTitle}>Activity unavailable</Text>
      <Text style={styles.stateMessage}>{message}</Text>
      <Pressable onPress={onRetry} style={styles.inlineRetry} accessibilityRole="button">
        <MaterialIcons name="refresh" size={16} color={METEORA_COLORS.cyan} />
        <Text style={styles.inlineRetryText}>Retry</Text>
      </Pressable>
    </View>
  );
}

function positionStatus(pool: MeteoraPortfolioPool): string {
  if (pool.outOfRange === null) return 'Status unavailable';
  const outOfRangeCount = pool.outOfRangePositionAddresses.length;
  if (outOfRangeCount > 0 && outOfRangeCount < pool.openPositionCount) return 'Mixed range';
  return pool.outOfRange ? 'Out of range' : 'In range';
}

function formatUsd(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'Unavailable';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Unavailable';
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: Math.abs(amount) >= 100_000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(amount) >= 1_000 ? 1 : 2,
  });
}

function formatSignedUsd(value: string | null | undefined): string {
  const amount = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(amount)) return 'Unavailable';
  if (amount === 0) return '$0.00';
  const formatted = formatUsd(String(Math.abs(amount)));
  return `${amount > 0 ? '+' : '−'}${formatted}`;
}

function formatPrice(value: string | null | undefined): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Unavailable';
  if (amount === 0) return '0';
  if (Math.abs(amount) >= 1) return amount.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return amount.toPrecision(5);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function numberValue(value: string | null | undefined): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatEventType(value: string): string {
  const normalized = value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  if (!normalized) return 'Position activity';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function historyIcon(eventType: string): 'add' | 'remove' | 'payments' | 'swap-horiz' | 'history' {
  const normalized = eventType.toLowerCase();
  if (normalized.includes('add') || normalized.includes('deposit')) return 'add';
  if (normalized.includes('remove') || normalized.includes('close')) return 'remove';
  if (normalized.includes('claim') || normalized.includes('fee') || normalized.includes('reward')) return 'payments';
  if (normalized.includes('swap') || normalized.includes('order')) return 'swap-horiz';
  return 'history';
}

function formatDate(blockTime: number, createdAt: string): string {
  const timestamp = blockTime > 0 ? blockTime * 1000 : Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: new Date(timestamp).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  }).format(new Date(timestamp));
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#103D4C',
  },
  header: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
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
    color: METEORA_COLORS.text,
    fontSize: 19,
    lineHeight: 22,
    fontWeight: '800',
  },
  headerAddress: {
    maxWidth: 180,
    color: METEORA_COLORS.textDim,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 12,
  },
  content: {
    paddingHorizontal: 16,
  },
  inlineNotice: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: METEORA_COLORS.border,
  },
  inlineNoticeText: {
    flex: 1,
    color: METEORA_COLORS.textDim,
    fontSize: 10,
    lineHeight: 14,
  },
  ledger: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: METEORA_COLORS.border,
  },
  ledgerMetric: {
    width: '50%',
    minHeight: 72,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: METEORA_COLORS.border,
  },
  ledgerLabel: {
    color: METEORA_COLORS.textFaint,
    fontFamily: 'monospace',
    fontSize: 8,
    lineHeight: 11,
    fontWeight: '700',
    letterSpacing: 0.9,
  },
  ledgerValue: {
    marginTop: 5,
    color: METEORA_COLORS.text,
    fontFamily: 'monospace',
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '800',
  },
  tabs: {
    minHeight: 52,
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: METEORA_COLORS.border,
  },
  tab: {
    flex: 1,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: METEORA_COLORS.coral,
  },
  tabText: {
    color: METEORA_COLORS.textDim,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
  },
  tabTextActive: {
    color: METEORA_COLORS.text,
  },
  listSection: {
    paddingBottom: 8,
  },
  sectionHeading: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: METEORA_COLORS.border,
  },
  sectionHeadingText: {
    color: METEORA_COLORS.cyan,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
  sectionCount: {
    color: METEORA_COLORS.textDim,
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 14,
  },
  dataRow: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: METEORA_COLORS.border,
  },
  dataRowPressed: {
    backgroundColor: 'rgba(122,108,255,0.08)',
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowIdentity: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    color: METEORA_COLORS.text,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '800',
  },
  rowMeta: {
    marginTop: 3,
    color: METEORA_COLORS.textDim,
    fontSize: 10,
    lineHeight: 14,
  },
  rowValueWrap: {
    alignItems: 'flex-end',
  },
  rowValue: {
    color: METEORA_COLORS.text,
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
  },
  rowDelta: {
    marginTop: 2,
    color: METEORA_COLORS.textDim,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 12,
  },
  rowFacts: {
    marginTop: 10,
    flexDirection: 'row',
  },
  rowFact: {
    flex: 1,
    gap: 3,
  },
  rowFactLabel: {
    color: METEORA_COLORS.textFaint,
    fontSize: 8,
    lineHeight: 11,
    textTransform: 'uppercase',
  },
  rowFactValue: {
    color: METEORA_COLORS.textDim,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 13,
  },
  positive: {
    color: '#34D399',
  },
  negative: {
    color: METEORA_COLORS.coral,
  },
  listFootnote: {
    paddingVertical: 12,
    color: METEORA_COLORS.textFaint,
    fontSize: 9,
    lineHeight: 13,
    textAlign: 'center',
  },
  inlineLoading: {
    minHeight: 150,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  historyWarning: {
    paddingVertical: 10,
    color: METEORA_COLORS.coral,
    fontSize: 10,
    lineHeight: 14,
  },
  historyRow: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: METEORA_COLORS.border,
  },
  historyIcon: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
    borderRadius: 6,
  },
  historyCopy: {
    flex: 1,
    minWidth: 0,
  },
  historyValue: {
    color: METEORA_COLORS.text,
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
  },
  fullState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 11,
    paddingHorizontal: 34,
  },
  stateTitle: {
    color: METEORA_COLORS.text,
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '800',
    textAlign: 'center',
  },
  stateMessage: {
    maxWidth: 320,
    color: METEORA_COLORS.textDim,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
  },
  primaryAction: {
    minWidth: 180,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    borderRadius: 12,
    backgroundColor: METEORA_COLORS.coral,
  },
  primaryActionText: {
    color: METEORA_COLORS.text,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
  },
  secondaryAction: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  secondaryActionText: {
    color: METEORA_COLORS.cyan,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
  },
  inlineState: {
    minHeight: 160,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 22,
  },
  inlineStateTitle: {
    color: METEORA_COLORS.text,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
  },
  inlineRetry: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  inlineRetryText: {
    color: METEORA_COLORS.cyan,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
  },
});
