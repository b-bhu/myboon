/**
 * Meteora per-venue portfolio drill-down (#657, D2).
 *
 * Moves the retired `features/meteora/MeteoraProfileScreen.tsx` onto the shared
 * VenuePortfolioScreen shell with the fixed Positions · Orders · History tabs —
 * Meteora has no order concept, so its Orders tab renders the shared empty
 * state instead of a different tab set. Data fetching, range status, pair
 * resolution and the full-state branches are moved verbatim. Rebalancing,
 * fee claims, removals and closes run through the existing
 * MeteoraPositionActionSheet (row tap), unchanged; this file adds no new
 * execution path.
 */

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
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { METEORA_COLORS } from '@/features/meteora/meteora.theme';
import { tokens } from '@/theme/tokens';
import { MeteoraPositionActionSheet } from '@/features/meteora/components/MeteoraPositionActionSheet';
import { meteoraClient } from '@/features/meteora/meteora.client';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import { mintRef, useTokenIdentities } from '@/lib/token-identity';
import { useWallet } from '@/hooks/useWallet';
import { VenuePortfolioScreen } from '@/features/portfolio/VenuePortfolioScreen';
import type { PortfolioTabKey, VenuePortfolioScreenTab } from '@/features/portfolio/VenuePortfolioScreen';



const PROFILE_PAGE_SIZE = 20;
const HISTORY_POSITION_LIMIT = 20;

export function MeteoraPortfolioScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();


  const wallet = useWallet();
  const connectSheet = useConnectionSheet('solana');
  const profileRequestId = useRef(0);
  const historyRequestId = useRef(0);

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


  const [historyTabActive, setHistoryTabActive] = useState(false);

  useEffect(() => {
    if (historyTabActive) void loadHistory();
  }, [historyTabActive, loadHistory]);

  const handleTabChange = useCallback((tab: PortfolioTabKey) => {
    setHistoryTabActive(tab === 'history');
  }, []);

  const tabs = useMemo(() => {
    const build = (
      rows: VenuePortfolioScreenTab['sections'],
    ): VenuePortfolioScreenTab => ({ status: 'ready', sections: rows });

    const notices: VenuePortfolioScreenTab['above'] = (
      <>
        {freshness?.state === 'stale' ? (
          <View style={styles.inlineNotice}>
            <MaterialIcons name="schedule" size={15} color={METEORA_COLORS.warning} />
            <Text style={styles.inlineNoticeText}>Showing the latest cached Meteora data.</Text>
          </View>
        ) : null}
        {partialMessage ? (
          <View style={styles.inlineNotice}>
            <MaterialIcons name="info-outline" size={15} color={METEORA_COLORS.primary} />
            <Text style={styles.inlineNoticeText}>{partialMessage}</Text>
          </View>
        ) : null}
      </>
    );

    const positionRows = (portfolio?.pools ?? []).map((pool) => ({
      key: pool.poolAddress,
      title: pool.pair,
      subtitle: `${formatInteger(pool.openPositionCount)} ${pool.openPositionCount === 1 ? 'position' : 'positions'} · ${positionStatus(pool)} · Fees ${formatUsd(pool.unclaimedFeesUsd)}`,
      value: formatUsd(pool.balanceUsd),
      valueTone: numberValue(pool.pnlUsd) >= 0 ? ('pos' as const) : ('neg' as const),
      subValue: formatSignedUsd(pool.pnlUsd),
      subValueTone: numberValue(pool.pnlUsd) >= 0 ? ('pos' as const) : ('neg' as const),
      actionLabel: 'Manage',
      onActionPress: () => openPositionSheet(pool.poolAddress),
      onPress: () => openPositionSheet(pool.poolAddress),
    }));

    const historyRows = history.map((event) => {
      const pair = resolvePairLabel(event, poolSymbolsByAddress, historyIdentities);
      return {
        key: `${event.signature}:${event.instructionIndex}`,
        title: formatEventType(event.eventType),
        subtitle: `${pair} · ${formatDate(event.blockTime, event.createdAt)}`,
        value: formatUsd(event.totalUsd),
      };
    });

    const historyTab: VenuePortfolioScreenTab =
      historyLoading && !historyLoaded
        ? { status: 'loading', sections: [] }
        : historyError && history.length === 0
          ? {
              status: 'failed',
              error: historyError,
              sections: [],
              onRetry: () => {
                setHistoryLoaded(false);
                setHistoryError(null);
              },
            }
          : {
              ...build([{ key: 'history', label: 'Recent activity', rows: historyRows }]),
              empty: { title: 'No recent activity', message: 'Position events will appear here in date order.' },
              below:
                historyError && history.length > 0 ? (
                  <Text style={styles.historyWarning}>{historyError}</Text>
                ) : null,
            };

    return {
      positions: {
        ...(loading
          ? { status: 'loading' as const, sections: [] }
          : build([{ key: 'positions', label: 'Open positions', rows: positionRows }])),
        empty: portfolio !== null ? { title: 'No open positions', message: 'Open a pool to create your first liquidity position.' } : null,
        above: notices,
        below:
          portfolio?.hasNext ? (
            <Text style={styles.listFootnote}>Showing the first {portfolio.pools.length} pool groups.</Text>
          ) : null,
      },
      orders: {
        status: 'ready' as const,
        sections: [],
        empty: { title: 'No open orders', message: 'Meteora positions have no separate standing orders.' },
      },
      history: historyTab,
    };
  }, [
    portfolio, history, historyLoading, historyLoaded, historyError, loading,
    freshness, partialMessage, poolSymbolsByAddress, historyIdentities, openPositionSheet,
  ]);

  if (!wallet.connected) {
    return (
      <>
        <View style={[styles.screen, { paddingTop: insets.top }]}>
          <DisconnectedState
            onConnect={() => connectSheet.open('solana')}
            onBrowse={() => router.replace('/markets/meteora')}
          />
        </View>
        <ConnectionSheet
          visible={connectSheet.visible}
          chain={connectSheet.chain}
          onClose={connectSheet.close}
        />
      </>
    );
  }

  if (wallet.source !== 'mwa') {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <UnsupportedWalletState onBrowse={() => router.replace('/markets/meteora')} />
      </View>
    );
  }

  if (errorMessage && !portfolio && !loading) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <FailureState message={errorMessage} onRetry={() => void loadProfile()} />
      </View>
    );
  }

  return (
    <>
      <VenuePortfolioScreen
        venueId="meteora"
        hero={{
          value: portfolio ? formatUsd(portfolio.totalBalanceUsd) : '--',
          change: formatSignedUsd(portfolio?.totalPnlUsd ?? null),
          changeTone: numberValue(portfolio?.totalPnlUsd) >= 0 ? 'pos' : 'neg',
          note: portfolio
            ? `Unclaimed fees ${formatUsd(portfolio.totalUnclaimedFeesUsd)} · Open positions ${formatInteger(portfolio.totalPositions)}`
            : null,
        }}
        tabs={tabs}
        onTabChange={handleTabChange}
        refreshing={refreshing}
        onRefresh={() => void loadProfile({ refresh: true })}
        testID="meteora-portfolio"
      />

      <MeteoraPositionActionSheet
        visible={!!actionSheetPool}
        pool={actionSheetPool}
        onClose={closeActionSheet}
        onAddLiquidity={goToAddLiquidity}
        onChanged={handlePositionChanged}
      />

      <ConnectionSheet
        visible={connectSheet.visible}
        chain={connectSheet.chain}
        onClose={connectSheet.close}
      />
    </>
  );
}



function DisconnectedState({ onConnect, onBrowse }: { onConnect: () => void; onBrowse: () => void }) {
  return (
    <View style={styles.fullState}>
      <MaterialIcons name="account-balance-wallet" size={34} color={METEORA_COLORS.primary} />
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
      <MaterialIcons name="info-outline" size={34} color={METEORA_COLORS.primary} />
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
      <ActivityIndicator size="small" color={METEORA_COLORS.primary} />
      <Text style={styles.stateMessage}>Loading Meteora profile…</Text>
    </View>
  );
}

function FailureState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.fullState}>
      <MaterialIcons name="cloud-off" size={34} color={METEORA_COLORS.negative} />
      <Text style={styles.stateTitle}>Profile unavailable</Text>
      <Text style={styles.stateMessage}>{message}</Text>
      <Pressable onPress={onRetry} style={styles.primaryAction} accessibilityRole="button">
        <Text style={styles.primaryActionText}>Try again</Text>
      </Pressable>
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
    backgroundColor: METEORA_COLORS.screen,
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
  sectionHeading: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: METEORA_COLORS.border,
  },
  sectionHeadingText: {
    color: METEORA_COLORS.accent,
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
  listFootnote: {
    paddingVertical: 12,
    color: METEORA_COLORS.textFaint,
    fontSize: 9,
    lineHeight: 13,
    textAlign: 'center',
  },
  historyWarning: {
    paddingVertical: 10,
    color: METEORA_COLORS.negative,
    fontSize: 10,
    lineHeight: 14,
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
    borderRadius: tokens.radius.md,
    backgroundColor: METEORA_COLORS.accent,
  },
  primaryActionText: {
    color: METEORA_COLORS.onAccent,
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
    color: METEORA_COLORS.accent,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
  },
});
