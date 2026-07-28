import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type {
  MeteoraFreshness,
  MeteoraPoolDetail,
  MeteoraPosition,
  MeteoraResult,
  MeteoraStrategy,
} from '@myboon/shared/meteora';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AutoFillControl,
  FormSection,
  InlineNotice,
  METEORA_COLORS,
  RangeVisualization,
  SegmentedControl,
  TokenAmountField,
} from '@/features/meteora/components/MeteoraExecutionControls';
import { AppProfileButton } from '@/components/AppProfileButton';
import { meteoraClient } from '@/features/meteora/meteora.client';
import { meteoraPhaseTwoAdapter } from '@/features/meteora/meteora.form-execution';
import {
  EMPTY_LIMIT_DRAFT,
  EMPTY_POSITION_DRAFT,
  createCenteredRange,
  decimalToAtomic,
  formatPoolPrice,
  formatUsdCompact,
  previewSecondsRemaining,
  relativeBinToRangePercent,
  sanitizeDecimalInput,
  validateAmount,
  validateLimitPrice,
  validateRange,
  type MeteoraExecutionTab,
  type MeteoraExecutionUpdate,
  type MeteoraLimitDraft,
  type MeteoraOperationState,
  type MeteoraPhaseTwoAdapter,
  type MeteoraPhaseTwoPreview,
  type MeteoraPositionDraft,
  type MeteoraPrepareContext,
} from '@/features/meteora/meteora.form';
import { meteoraPositionActionsAdapter } from '@/features/meteora/meteora.position-actions';
import { useWallet } from '@/hooks/useWallet';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';

const PREVIEW_DEBOUNCE_MS = 450;

const STRATEGIES: {
  id: MeteoraStrategy;
  label: string;
  description: string;
  icon: 'blur-on' | 'show-chart' | 'swap-horiz';
}[] = [
  {
    id: 'spot',
    label: 'Spot',
    description: 'Even liquidity across the selected range',
    icon: 'blur-on',
  },
  {
    id: 'curve',
    label: 'Curve',
    description: 'More liquidity around the current price',
    icon: 'show-chart',
  },
  {
    id: 'bid_ask',
    label: 'Bid Ask',
    description: 'Liquidity concentrated toward the range edges',
    icon: 'swap-horiz',
  },
];

export function MeteoraPoolPhaseTwoScreen({
  poolAddress,
  positionAddress,
  adapter = meteoraPhaseTwoAdapter,
  client = meteoraClient,
}: {
  poolAddress: string;
  /**
   * When present, the screen opens directly in "add to existing position"
   * mode (beta action-sheet Add liquidity flow): goal, distribution, and
   * range selection are skipped since they're already fixed by the position,
   * and only the amount step is shown.
   */
  positionAddress?: string;
  adapter?: MeteoraPhaseTwoAdapter;
  client?: {
    clearCache(): void;
    getPool(address: string): Promise<MeteoraResult<MeteoraPoolDetail>>;
  };
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const wallet = useWallet();
  const connectSheet = useConnectionSheet('solana');
  const requestId = useRef(0);
  const walletRef = useRef(wallet);
  const recoveryAttemptRef = useRef<string | null>(null);
  const defaultRangePoolRef = useRef<string | null>(null);
  const defaultRangeBoundsRef = useRef<{ minPrice: string; maxPrice: string } | null>(null);
  const rangeUserEditedRef = useRef(false);
  walletRef.current = wallet;

  const [pool, setPool] = useState<MeteoraPoolDetail | null>(null);
  const [freshness, setFreshness] = useState<MeteoraFreshness | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const activeTab: MeteoraExecutionTab = 'position';
  const [positionDraft, setPositionDraft] = useState<MeteoraPositionDraft>(EMPTY_POSITION_DRAFT);
  const [limitDraft, setLimitDraft] = useState<MeteoraLimitDraft>(EMPTY_LIMIT_DRAFT);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<MeteoraPhaseTwoPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [operationState, setOperationState] = useState<MeteoraOperationState>('editing');
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [operationExplorerUrl, setOperationExplorerUrl] = useState<string | null>(null);
  const [recoveryNonce, setRecoveryNonce] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [walletBalanceX, setWalletBalanceX] = useState<string | null>(null);
  const [walletBalanceY, setWalletBalanceY] = useState<string | null>(null);
  const [addModePosition, setAddModePosition] = useState<MeteoraPosition | null>(null);
  const [addModeError, setAddModeError] = useState<string | null>(null);
  const addModeAppliedRef = useRef(false);

  const loadPool = useCallback(async ({ clearCache = false }: { clearCache?: boolean } = {}) => {
    const id = requestId.current + 1;
    requestId.current = id;
    setLoadError(null);
    if (clearCache) client.clearCache();
    try {
      const result = await client.getPool(poolAddress);
      if (requestId.current !== id) return;
      setPool(result.data);
      setFreshness(result.freshness);
    } catch (error) {
      if (requestId.current !== id) return;
      setLoadError(error instanceof Error ? error.message : 'This Meteora pool is unavailable');
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, [client, poolAddress]);

  useEffect(() => {
    void loadPool();
  }, [loadPool]);

  useEffect(() => {
    if (!pool || defaultRangePoolRef.current === pool.address) return undefined;
    // Add-mode locks strategy and range to the existing position; skip the
    // fresh-position default-range calculation entirely.
    if (positionAddress) return undefined;
    defaultRangePoolRef.current = pool.address;
    defaultRangeBoundsRef.current = null;
    rangeUserEditedRef.current = false;

    const fallbackRange = createCenteredRange(pool.currentPrice, pool.binStep);
    if (fallbackRange) {
      defaultRangeBoundsRef.current = {
        minPrice: fallbackRange.requestedMinPrice,
        maxPrice: fallbackRange.requestedMaxPrice,
      };
      setPositionDraft((current) => ({
        ...current,
        preset: 'manual',
        requestedMinPrice: fallbackRange.requestedMinPrice,
        requestedMaxPrice: fallbackRange.requestedMaxPrice,
      }));
      setPreview(null);
      setPreviewError(null);
      setOperationMessage(null);
      setOperationExplorerUrl(null);
      setOperationState('editing');
    }

    if (!adapter.getDefaultRange) return undefined;
    let cancelled = false;
    void adapter.getDefaultRange(pool).then((range) => {
      if (cancelled || rangeUserEditedRef.current) return;
      defaultRangeBoundsRef.current = {
        minPrice: range.requestedMinPrice,
        maxPrice: range.requestedMaxPrice,
      };
      setPositionDraft((current) => ({
        ...current,
        preset: 'manual',
        requestedMinPrice: range.requestedMinPrice,
        requestedMaxPrice: range.requestedMaxPrice,
      }));
      setPreview(null);
      setPreviewError(null);
      setOperationMessage(null);
      setOperationExplorerUrl(null);
      setOperationState('editing');
    }).catch(() => {
      // The centered local range is already usable while the exact pool state
      // remains unavailable.
    });
    return () => {
      cancelled = true;
    };
  }, [adapter, pool, positionAddress]);

  // Add-mode: load the existing position so its range/distribution can be
  // shown as fixed context (TC-DETAIL-008) instead of re-asking goal,
  // distribution, or range.
  useEffect(() => {
    if (!pool || !positionAddress || !wallet.address || addModeAppliedRef.current) return undefined;
    let cancelled = false;
    setAddModeError(null);
    (async () => {
      try {
        const result = await meteoraClient.getPositions(pool.address, wallet.address!, {
          status: 'open',
          page: 1,
          pageSize: 20,
        });
        if (cancelled) return;
        const match = result.data.items.find((item) => item.address === positionAddress);
        if (!match) {
          setAddModeError('This position could not be found. It may have been closed.');
          return;
        }
        addModeAppliedRef.current = true;
        setAddModePosition(match);
        setPositionDraft((current) => ({
          ...current,
          preset: 'manual',
          requestedMinPrice: match.minPrice,
          requestedMaxPrice: match.maxPrice,
        }));
      } catch (error) {
        if (cancelled) return;
        setAddModeError(error instanceof Error ? error.message : 'This position could not be loaded.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pool, positionAddress, wallet.address]);

  // Fetch the connected wallet's balance for both pool tokens immediately on
  // mount/connect, independent of preview preparation. Without this, the
  // balance row shows "Checking…" indefinitely until the user enters a
  // valid amount and a preview is prepared — but a user needs to see their
  // balance before typing an amount (regression fix for METEORA_QA_ISSUES.md
  // Issue 2 / TC-DETAIL-004).
  //
  // This effect already depends on wallet.connected/wallet.address, so it
  // re-fires on its own once the wallet adapter's async autoConnect flips
  // `connected` from false to true after a hard reload — no separate
  // "wait for the wallet" logic is needed for that part. What it does add is
  // a small bounded retry (not infinite) for a *connected* wallet whose
  // balance read itself fails transiently (RPC rate limit/hiccup right after
  // the provider finishes reconnecting), so the row doesn't settle on a
  // stale "Unavailable" after a single bad request.
  useEffect(() => {
    if (!pool || !wallet.connected || !wallet.address || !adapter.getWalletBalances) {
      setWalletBalanceX(null);
      setWalletBalanceY(null);
      return undefined;
    }
    let cancelled = false;
    const walletAddress = wallet.address;
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 800;

    const attempt = (attemptNumber: number) => {
      void adapter.getWalletBalances!(pool, walletAddress).then((balances) => {
        if (cancelled) return;
        const resolvedX = balances.x ?? null;
        const resolvedY = balances.y ?? null;
        if ((resolvedX === null || resolvedY === null) && attemptNumber < MAX_ATTEMPTS) {
          setTimeout(() => {
            if (!cancelled) attempt(attemptNumber + 1);
          }, RETRY_DELAY_MS * attemptNumber);
          return;
        }
        setWalletBalanceX(resolvedX ?? 'Unavailable');
        setWalletBalanceY(resolvedY ?? 'Unavailable');
      }).catch(() => {
        if (cancelled) return;
        if (attemptNumber < MAX_ATTEMPTS) {
          setTimeout(() => {
            if (!cancelled) attempt(attemptNumber + 1);
          }, RETRY_DELAY_MS * attemptNumber);
          return;
        }
        setWalletBalanceX('Unavailable');
        setWalletBalanceY('Unavailable');
      });
    };
    attempt(1);

    return () => {
      cancelled = true;
    };
  }, [adapter, pool, wallet.address, wallet.connected]);

  useEffect(() => {
    if (
      !pool
      || !freshness
      || !wallet.connected
      || !wallet.address
      || wallet.source === 'privy'
      || !adapter.recoverPending
    ) {
      return undefined;
    }
    const recoveryKey = `${wallet.address}:${pool.address}`;
    if (recoveryAttemptRef.current === recoveryKey) return undefined;
    recoveryAttemptRef.current = recoveryKey;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const currentWallet = walletRef.current;
    void adapter.recoverPending({
      pool,
      poolFreshness: freshness,
      walletAddress: wallet.address,
      wallet: executionWallet(currentWallet),
      connection: currentWallet.connection,
      getWalletSnapshot: () => executionWallet(walletRef.current),
    }, (update) => {
      if (cancelled) return;
      setOperationState(update.state);
      setOperationMessage(update.message);
      if (update.explorerUrl) setOperationExplorerUrl(update.explorerUrl);
    }).then((result) => {
      if (cancelled || !result) return;
      if (result.state === 'confirmed') setOperationState('success');
      else if (result.state === 'syncing') setOperationState('syncing');
      else if (result.state === 'partial') setOperationState('partial');
      else if (result.state === 'cancelled') setOperationState('editing');
      else setOperationState('submitted');
      setOperationMessage(result.message);
      if (result.explorerUrl) setOperationExplorerUrl(result.explorerUrl);
      if (result.state === 'syncing' || result.state === 'submitted') {
        retryTimer = setTimeout(() => {
          recoveryAttemptRef.current = null;
          setRecoveryNonce((value) => value + 1);
        }, 5_000);
      }
    }).catch((error) => {
      if (cancelled) return;
      setOperationState('error');
      setOperationMessage(error instanceof Error ? error.message : 'Pending transaction recovery failed');
    });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    adapter,
    freshness,
    pool,
    wallet.address,
    wallet.connected,
    wallet.connection,
    wallet.source,
    recoveryNonce,
  ]);

  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    invalidatePreview();
    await loadPool({ clearCache: true });
    setRefreshing(false);
  }, [loadPool]);

  const amountXError = validateAmount(
    positionDraft.amountX,
    pool?.tokenX.decimals ?? 9,
    !!touched.amountX,
  );
  const amountYError = validateAmount(
    positionDraft.amountY,
    pool?.tokenY.decimals ?? 6,
    !!touched.amountY,
  );
  const localRangeError = positionDraft.preset === 'manual'
    ? validateRange(
      positionDraft.requestedMinPrice,
      positionDraft.requestedMaxPrice,
      true,
    )
    : null;
  const limitAmountError = validateAmount(
    limitDraft.amount,
    limitFundingToken(pool, limitDraft.side)?.decimals ?? 9,
    !!touched.limitAmount,
  );
  const limitPriceError = validateLimitPrice(
    limitDraft.requestedPrice,
    pool?.currentPrice ?? null,
    limitDraft.side,
    !!touched.limitPrice,
  );

  const positionLocallyValid = useMemo(() => {
    if (!pool) return false;
    if (addModePosition) {
      // Add-mode recalculates the token ratio for the existing range, so
      // either side (or both) may be entered — unlike a fresh create.
      const hasX = !!positionDraft.amountX;
      const hasY = !!positionDraft.amountY;
      if (!hasX && !hasY) return false;
      const errorX = hasX ? validateAmount(positionDraft.amountX, pool.tokenX.decimals, true) : null;
      const errorY = hasY ? validateAmount(positionDraft.amountY, pool.tokenY.decimals, true) : null;
      return !errorX && !errorY;
    }
    if (positionDraft.autoFill) {
      const hasX = !!positionDraft.amountX;
      const hasY = !!positionDraft.amountY;
      if (hasX === hasY) return false;
      const hasError = hasX
        ? validateAmount(positionDraft.amountX, pool.tokenX.decimals, true)
        : validateAmount(positionDraft.amountY, pool.tokenY.decimals, true);
      return !hasError && !localRangeError;
    }
    return !!positionDraft.amountX
      && !!positionDraft.amountY
      && !validateAmount(positionDraft.amountX, pool.tokenX.decimals, true)
      && !validateAmount(positionDraft.amountY, pool.tokenY.decimals, true)
      && !localRangeError;
  }, [
    localRangeError,
    pool,
    positionDraft,
    addModePosition,
  ]);

  const limitLocallyValid = !!pool
    && !!limitDraft.amount
    && !!limitDraft.requestedPrice
    && !validateAmount(
      limitDraft.amount,
      limitFundingToken(pool, limitDraft.side)?.decimals ?? 9,
      true,
    )
    && !validateLimitPrice(
      limitDraft.requestedPrice,
      pool.currentPrice,
      limitDraft.side,
      true,
    );
  const locallyValid = activeTab === 'position' ? positionLocallyValid : limitLocallyValid;

  const previewInputKey = useMemo(
    () => JSON.stringify({
      activeTab,
      positionDraft,
      limitDraft,
      poolAddress: pool?.address,
      freshness: freshness?.servedAt,
      wallet: wallet.address,
      addModePosition: addModePosition?.address,
    }),
    [
      activeTab,
      freshness?.servedAt,
      limitDraft,
      pool?.address,
      positionDraft,
      wallet.address,
      addModePosition,
    ],
  );

  useEffect(() => {
    if (!pool || !freshness || !locallyValid) {
      setPreview(null);
      setPreviewLoading(false);
      return undefined;
    }
    if (positionAddress && !addModePosition) {
      // Waiting on the existing position to load before an add-mode preview
      // can be prepared.
      return undefined;
    }
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    setOperationState('preparing');
    const timeout = setTimeout(async () => {
      try {
        const context = {
          pool,
          poolFreshness: freshness,
          walletAddress: wallet.address,
          wallet: executionWallet(wallet),
          connection: wallet.connection,
          getWalletSnapshot: () => executionWallet(walletRef.current),
        };
        let nextPreview: MeteoraPhaseTwoPreview;
        if (addModePosition) {
          nextPreview = await prepareAddModePreview(context, addModePosition, positionDraft, pool, adapter);
        } else {
          nextPreview = activeTab === 'position'
            ? await adapter.preparePosition(context, positionDraft)
            : await adapter.prepareLimitOrder(context, limitDraft);
        }
        if (cancelled) return;
        setPreview(nextPreview);
        setOperationState(nextPreview.canExecute ? 'ready' : 'editing');
      } catch (error) {
        if (cancelled) return;
        setPreviewError(error instanceof Error ? error.message : 'Unable to prepare preview');
        setOperationState('error');
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  // previewInputKey is a stable serialized representation of every preview input.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewInputKey, locallyValid, adapter, positionAddress, addModePosition]);

  const previewRemaining = useMemo(() => {
    void clock;
    return previewSecondsRemaining(preview);
  }, [clock, preview]);
  const previewExpired = !!preview && previewRemaining <= 0;
  const stalePool = freshness?.state === 'stale';

  const pair = pool ? `${pool.tokenX.symbol} / ${pool.tokenY.symbol}` : 'Pool';
  const conversion = pool
    ? `1 ${pool.tokenX.symbol} = ${formatPoolPrice(pool.currentPrice)} ${pool.tokenY.symbol}`
    : 'Loading current price…';

  const updatePosition = useCallback((patch: Partial<MeteoraPositionDraft>) => {
    setPositionDraft((current) => ({ ...current, ...patch }));
    invalidatePreview();
  }, []);

  const updateLimit = useCallback((patch: Partial<MeteoraLimitDraft>) => {
    setLimitDraft((current) => ({ ...current, ...patch }));
    invalidatePreview();
  }, []);

  function invalidatePreview() {
    setPreview(null);
    setPreviewError(null);
    setOperationMessage(null);
    setOperationExplorerUrl(null);
    setOperationState('editing');
  }

  const markTouched = useCallback((field: string) => {
    setTouched((current) => ({ ...current, [field]: true }));
  }, []);

  const handleExecute = useCallback(async () => {
    if (!pool || !freshness) return;
    if (stalePool || previewExpired) {
      await onRefresh();
      return;
    }
    if (!wallet.connected) {
      setOperationState('awaiting_wallet');
      setOperationMessage('Connect your Solana wallet, then review and press the action again.');
      // The sheet surfaces its own connection errors on an error step, so there
      // is no failure to catch and mirror into `operationMessage` here.
      connectSheet.open('solana');
      return;
    }
    if (wallet.source === 'privy' || typeof wallet.signAndSendTransaction !== 'function') {
      setOperationState('error');
      setOperationMessage('This wallet can view Meteora, but it cannot sign Solana transactions.');
      return;
    }
    if (!preview || previewExpired || stalePool || !preview.canExecute) return;
    setOperationState('awaiting_wallet');
    setOperationMessage('Approve the transaction in your wallet.');
    try {
      const context = {
        pool,
        poolFreshness: freshness,
        walletAddress: wallet.address,
        wallet: executionWallet(wallet),
        connection: wallet.connection,
        getWalletSnapshot: () => executionWallet(walletRef.current),
      };
      const result = addModePosition
        ? await meteoraPositionActionsAdapter.executeAdd(
          context,
          preview.sourcePreview as Awaited<ReturnType<typeof meteoraPositionActionsAdapter.prepareAdd>>,
          (update: MeteoraExecutionUpdate) => {
            setOperationState(update.state);
            setOperationMessage(update.message);
            if (update.explorerUrl) setOperationExplorerUrl(update.explorerUrl);
          },
        )
        : await adapter.execute(
          context,
          preview,
          (update) => {
            setOperationState(update.state);
            setOperationMessage(update.message);
            if (update.explorerUrl) setOperationExplorerUrl(update.explorerUrl);
          },
        );
      if (result.state === 'submitted') {
        setOperationState('submitted');
      } else if (result.state === 'syncing') {
        setOperationState('syncing');
      } else if (result.state === 'partial') {
        setOperationState('partial');
      } else if (result.state === 'cancelled') {
        setOperationState('editing');
      } else {
        setOperationState('success');
      }
      setOperationMessage(result.message);
      if (result.explorerUrl) setOperationExplorerUrl(result.explorerUrl);
    } catch (error) {
      setOperationState('error');
      setOperationMessage(error instanceof Error ? error.message : 'The transaction could not be completed');
    }
  }, [
    adapter,
    freshness,
    pool,
    preview,
    previewExpired,
    onRefresh,
    stalePool,
    wallet,
    connectSheet.open,
    addModePosition,
  ]);

  const cta = getCtaState({
    loading,
    pool,
    activeTab,
    positionDraft,
    locallyValid,
    preview,
    previewLoading,
    previewExpired,
    stalePool: !!stalePool,
    walletConnected: wallet.connected,
    walletSupported: wallet.source !== 'privy'
      && typeof wallet.signAndSendTransaction === 'function',
    operationState,
    addMode: !!addModePosition,
  });

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Go back to Meteora pools"
            hitSlop={8}
            style={styles.headerBack}
          >
            <MaterialIcons name="arrow-back" size={19} color={METEORA_COLORS.text} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.headerTitle} numberOfLines={1}>{pair}</Text>
            <Text style={styles.headerPrice} numberOfLines={1}>{conversion}</Text>
          </View>
        </View>
        <AppProfileButton
          onPress={() => router.push('/markets/meteora/profile')}
          connected={wallet.connected}
          label="Open Meteora profile"
          hint="View your Meteora positions, orders, and history"
          borderColor={METEORA_COLORS.border}
          iconColor={METEORA_COLORS.text}
          backgroundColor="rgba(21,27,48,0.72)"
        />
      </View>

      {loading ? (
        <LoadingPool />
      ) : loadError || !pool ? (
        <LoadFailure message={loadError ?? 'This pool is unavailable'} onRetry={() => loadPool()} />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={METEORA_COLORS.cyan}
              colors={[METEORA_COLORS.cyan]}
            />
          )}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: Math.max(insets.bottom, 18) + 24 },
          ]}
        >
          <PoolContext pool={pool} freshness={freshness} />

          {/*
           * Create Position is the fixed beta view for now.
           * Keep the Limit Order flow implemented, but hide the tab switch
           * until we revisit the combined execution experience.
           */}

          {addModeError ? (
            <InlineNotice tone="error" title="Position unavailable" message={addModeError} />
          ) : null}

          {positionAddress && !addModePosition && !addModeError ? (
            <View style={styles.centerState}>
              <ActivityIndicator color={METEORA_COLORS.cyan} />
              <Text style={styles.centerBody}>Loading your position…</Text>
            </View>
          ) : activeTab === 'position' ? (
            <>
              <FormSection
                title="Amount"
                caption={
                  addModePosition
                    ? 'Enter how much to add to your existing position.'
                    : 'Deposit both pool tokens.'
                }
              >
                {addModePosition ? (
                  <InlineNotice
                    tone="info"
                    title="Adding to your existing position"
                    message={`${formatPoolPrice(addModePosition.minPrice)} – ${formatPoolPrice(addModePosition.maxPrice)} range. The range is fixed and cannot be changed here. Added liquidity uses an even (Spot) distribution.`}
                  />
                ) : null}
                <TokenAmountField
                  symbol={pool.tokenX.symbol}
                  iconUrl={pool.tokenX.iconUrl}
                  value={positionDraft.amountX}
                  balance={
                    wallet.connected
                      ? preview?.spendableBalanceX ?? walletBalanceX ?? 'Checking…'
                      : 'Connect wallet'
                  }
                  error={amountXError}
                  accent={METEORA_COLORS.cyan}
                  onChangeText={(value) => updatePosition({
                    amountX: sanitizeDecimalInput(value, pool.tokenX.decimals),
                  })}
                  onBlur={() => markTouched('amountX')}
                />

                <TokenAmountField
                  symbol={pool.tokenY.symbol}
                  iconUrl={pool.tokenY.iconUrl}
                  value={positionDraft.amountY}
                  balance={
                    wallet.connected
                      ? preview?.spendableBalanceY ?? walletBalanceY ?? 'Checking…'
                      : 'Connect wallet'
                  }
                  error={amountYError}
                  accent={METEORA_COLORS.violet}
                  onChangeText={(value) => updatePosition({
                    amountY: sanitizeDecimalInput(value, pool.tokenY.decimals),
                  })}
                  onBlur={() => markTouched('amountY')}
                />

                {!addModePosition ? (
                  <>
                    <AutoFillControl
                      value={positionDraft.autoFill}
                      onChange={(autoFill) => updatePosition({ autoFill })}
                    />
                    {positionDraft.autoFill
                      && (!!positionDraft.amountX === !!positionDraft.amountY) ? (
                        <InlineNotice
                          tone="warning"
                          title="Enter one amount for Auto-Fill"
                          message="Leave the other token amount empty so Meteora can calculate it from the executable range."
                        />
                      ) : null}
                  </>
                ) : null}
              </FormSection>

              {!addModePosition ? (
                <FormSection
                  title="Strategy"
                  caption="Distribution is a separate choice from the calculated range."
                >
                  <SegmentedControl
                    value={positionDraft.strategy}
                    onChange={(strategy) => updatePosition({ strategy })}
                    accessibilityLabel="Liquidity distribution strategy"
                    options={STRATEGIES}
                  />
                  <Text style={styles.selectionExplanation}>
                    {STRATEGIES.find((option) => option.id === positionDraft.strategy)?.description}
                  </Text>
                </FormSection>
              ) : null}

              <View style={styles.rangeSection}>
                <RangeVisualization
                  strategy={positionDraft.strategy}
                  interactive={false}
                  minLabel={formatPoolPrice(
                    preview?.executableMinPrice
                      ?? positionDraft.requestedMinPrice
                      ?? null,
                  )}
                  maxLabel={formatPoolPrice(
                    preview?.executableMaxPrice
                      ?? positionDraft.requestedMaxPrice
                      ?? null,
                  )}
                  currentLabel={formatPoolPrice(pool.currentPrice)}
                  minPercent={rangePercent(
                    preview?.minBinId,
                    preview?.activeBinId,
                    positionDraft.requestedMinPrice,
                    pool.currentPrice,
                    pool.binStep,
                  )}
                  maxPercent={rangePercent(
                    preview?.maxBinId,
                    preview?.activeBinId,
                    positionDraft.requestedMaxPrice,
                    pool.currentPrice,
                    pool.binStep,
                  )}
                />
                <RangePreview preview={preview} />
              </View>
            </>
          ) : (
            <LimitOrderForm
              pool={pool}
              draft={limitDraft}
              amountError={limitAmountError}
              priceError={limitPriceError}
              preview={preview}
              connected={wallet.connected}
              onChange={updateLimit}
              onTouch={markTouched}
            />
          )}

          {previewError ? (
            <InlineNotice tone="error" title="Preview unavailable" message={previewError} />
          ) : null}
          {preview?.warnings.map((warning) => (
            <InlineNotice
              key={warning.code}
              tone={warning.blocking ? 'error' : 'warning'}
              title={warning.blocking ? 'Action required' : 'Check before signing'}
              message={warning.message}
            />
          ))}
          {operationMessage ? (
            <InlineNotice
              tone={
                operationState === 'success'
                  ? 'success'
                  : operationState === 'error' || operationState === 'partial'
                    ? 'error'
                    : 'pending'
              }
              title={
                operationState === 'success'
                  ? 'Complete'
                  : operationState === 'error' || operationState === 'partial'
                    ? 'Needs attention'
                    : 'Transaction status'
              }
              message={operationMessage}
            />
          ) : null}
          {operationExplorerUrl ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Open transaction in Solana Explorer"
              onPress={() => {
                void Linking.openURL(operationExplorerUrl);
              }}
              style={styles.explorerLink}
            >
              <MaterialIcons name="open-in-new" size={16} color={METEORA_COLORS.cyan} />
              <Text style={styles.explorerLinkText}>View transaction</Text>
            </Pressable>
          ) : null}

          <View style={styles.advanced}>
            <Pressable
              onPress={() => setAdvancedOpen((open) => !open)}
              accessibilityRole="button"
              accessibilityState={{ expanded: advancedOpen }}
              accessibilityLabel="Advanced execution protection"
              style={styles.advancedTrigger}
            >
              <View style={styles.advancedTitleRow}>
                <MaterialIcons
                  name="verified-user"
                  size={17}
                  color={METEORA_COLORS.cyan}
                />
                <Text style={styles.advancedTitle}>Advanced protection</Text>
              </View>
              <MaterialIcons
                name={advancedOpen ? 'expand-less' : 'expand-more'}
                size={21}
                color={METEORA_COLORS.textDim}
              />
            </Pressable>
            {advancedOpen ? (
              <View style={styles.advancedBody}>
                <GuardedDefault label="Preview expiry" value="Automatic" />
                <GuardedDefault label="Active-bin movement" value="Protected" />
                <GuardedDefault label="Swap slippage" value="Guarded by quote" />
                <GuardedDefault label="Liquidity protection" value="Enabled" />
                <Text style={styles.advancedCaption}>
                  myBoon refreshes and simulates the executable plan before wallet approval.
                </Text>
              </View>
            ) : null}
          </View>

          <Pressable
            onPress={handleExecute}
            disabled={cta.disabled}
            accessibilityRole="button"
            accessibilityLabel={cta.label}
            accessibilityState={{
              disabled: cta.disabled,
              busy: cta.busy,
            }}
            style={({ pressed }) => [
              styles.cta,
              cta.disabled && styles.ctaDisabled,
              operationState === 'success' && styles.ctaSuccess,
              operationState === 'error' && styles.ctaError,
              pressed && !cta.disabled && styles.ctaPressed,
            ]}
          >
            {cta.busy ? (
              <ActivityIndicator size="small" color={METEORA_COLORS.text} />
            ) : (
              <MaterialIcons
                name={
                  operationState === 'success'
                    ? 'check-circle'
                    : operationState === 'error'
                      ? 'error-outline'
                      : wallet.connected
                        ? 'arrow-forward'
                        : 'account-balance-wallet'
                }
                size={19}
                color={METEORA_COLORS.text}
              />
            )}
            <Text style={styles.ctaText}>{cta.label}</Text>
          </Pressable>
          <Text style={styles.ctaFootnote}>
            You approve every transaction in your wallet. myBoon never stores generated secret keys.
          </Text>
        </ScrollView>
      )}

      <ConnectionSheet
        visible={connectSheet.visible}
        chain={connectSheet.chain}
        onClose={connectSheet.close}
      />
    </View>
  );
}

function PoolContext({
  pool,
  freshness,
}: {
  pool: MeteoraPoolDetail;
  freshness: MeteoraFreshness | null;
}) {
  const stale = freshness?.state === 'stale';
  return (
    <View style={styles.poolContext}>
      <View style={styles.metrics}>
        <Metric label="Liquidity" value={formatUsdCompact(pool.tvlUsd)} />
        <Metric label="24h Volume" value={formatUsdCompact(pool.volume24hUsd)} />
        <Metric label="24h Fees" value={formatUsdCompact(pool.fees24hUsd)} />
      </View>
      {stale ? (
        <InlineNotice
          tone="warning"
          title="Pool data needs a refresh"
          message="You can still inspect this pool, but execution stays disabled until a fresh preview is available."
        />
      ) : null}
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function LimitOrderForm({
  pool,
  draft,
  amountError,
  priceError,
  preview,
  connected,
  onChange,
  onTouch,
}: {
  pool: MeteoraPoolDetail;
  draft: MeteoraLimitDraft;
  amountError: string | null;
  priceError: string | null;
  preview: MeteoraPhaseTwoPreview | null;
  connected: boolean;
  onChange: (patch: Partial<MeteoraLimitDraft>) => void;
  onTouch: (field: string) => void;
}) {
  const fundingToken = limitFundingToken(pool, draft.side)!;
  const receiveToken = draft.side === 'buy' ? pool.tokenX : pool.tokenY;
  const spendableBalance = draft.side === 'buy'
    ? preview?.spendableBalanceY
    : preview?.spendableBalanceX;
  return (
    <>
      <FormSection
        title="Order"
        caption="Buy below the market or sell above it at one executable bin."
      >
        <SegmentedControl
          value={draft.side}
          onChange={(side) => onChange({ side, amount: '', requestedPrice: '' })}
          accessibilityLabel="Limit order side"
          options={[
            {
              id: 'buy',
              label: `Buy ${pool.tokenX.symbol}`,
              description: `Fund with ${pool.tokenY.symbol} below the current price`,
            },
            {
              id: 'sell',
              label: `Sell ${pool.tokenX.symbol}`,
              description: `Fund with ${pool.tokenX.symbol} above the current price`,
            },
          ]}
        />
        <TokenAmountField
          symbol={fundingToken.symbol}
          iconUrl={fundingToken.iconUrl}
          value={draft.amount}
          balance={connected ? spendableBalance ?? 'Checking…' : 'Connect wallet'}
          error={amountError}
          accent={draft.side === 'buy' ? METEORA_COLORS.violet : METEORA_COLORS.cyan}
          onChangeText={(amount) => onChange({
            amount: sanitizeDecimalInput(amount, fundingToken.decimals),
          })}
          onBlur={() => onTouch('limitAmount')}
        />
      </FormSection>

      <FormSection
        title="Target Price"
        caption={`Current: 1 ${pool.tokenX.symbol} = ${formatPoolPrice(pool.currentPrice)} ${pool.tokenY.symbol}`}
      >
        <View style={styles.limitPriceField}>
          <TextInput
            value={draft.requestedPrice}
            onChangeText={(requestedPrice) => onChange({
              requestedPrice: sanitizeDecimalInput(requestedPrice, 12),
            })}
            onBlur={() => onTouch('limitPrice')}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={METEORA_COLORS.textFaint}
            accessibilityLabel="Requested target price"
            style={styles.limitPriceInput}
          />
          <Text style={styles.limitPriceSuffix}>
            {pool.tokenY.symbol} per {pool.tokenX.symbol}
          </Text>
        </View>
        {priceError ? (
          <Text style={styles.fieldErrorText} accessibilityRole="alert">
            {priceError}
          </Text>
        ) : null}
        {preview?.executableTargetPrice ? (
          <View style={styles.snapRows}>
            <PreviewRow label="Requested" value={formatPoolPrice(preview.requestedTargetPrice ?? null)} />
            <PreviewRow label="Executable bin" value={formatPoolPrice(preview.executableTargetPrice)} />
            <PreviewRow label="From current price" value={preview.distanceFromCurrentPct ?? '—'} />
            <PreviewRow
              label={`Estimated ${receiveToken.symbol} at full fill`}
              value={preview.estimatedOutput ?? '—'}
            />
          </View>
        ) : null}
        <InlineNotice
          tone="info"
          title="Limit orders can fill partially"
          message="Your order may fill across time as the active price reaches this bin. Position monitoring and cancellation are available from Profile in Phase 3."
        />
      </FormSection>
    </>
  );
}

function RangePreview({ preview }: { preview: MeteoraPhaseTwoPreview | null }) {
  if (!preview?.executableMinPrice || !preview.executableMaxPrice) return null;
  const adjusted = preview.requestedMinPrice !== preview.executableMinPrice
    || preview.requestedMaxPrice !== preview.executableMaxPrice;
  return (
    <View style={styles.snapRows}>
      {adjusted ? (
        <>
          <PreviewRow
            label="Requested range"
            value={`${formatPoolPrice(preview.requestedMinPrice ?? null)} – ${formatPoolPrice(preview.requestedMaxPrice ?? null)}`}
          />
          <PreviewRow
            label="Executable range"
            value={`${formatPoolPrice(preview.executableMinPrice)} – ${formatPoolPrice(preview.executableMaxPrice)}`}
            accent
          />
        </>
      ) : (
        <PreviewRow
          label="Executable range"
          value={`${formatPoolPrice(preview.executableMinPrice)} – ${formatPoolPrice(preview.executableMaxPrice)}`}
          accent
        />
      )}
      <PreviewRow
        label="Total bins"
        value={preview.binCount ? `${preview.binCount} / 70` : '— / 70'}
      />
    </View>
  );
}

function PreviewRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <View style={styles.previewRow}>
      <Text style={styles.previewRowLabel}>{label}</Text>
      <Text style={[styles.previewRowValue, accent && styles.previewRowAccent]}>{value}</Text>
    </View>
  );
}

function GuardedDefault({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.guardedRow}>
      <Text style={styles.guardedLabel}>{label}</Text>
      <View style={styles.guardedValueWrap}>
        <MaterialIcons name="lock" size={12} color={METEORA_COLORS.textFaint} />
        <Text style={styles.guardedValue}>{value}</Text>
      </View>
    </View>
  );
}

function LoadingPool() {
  return (
    <View style={styles.centerState}>
      <ActivityIndicator color={METEORA_COLORS.cyan} />
      <Text style={styles.centerTitle}>Loading pool…</Text>
      <Text style={styles.centerBody}>Reading the latest approved Meteora pool state.</Text>
    </View>
  );
}

function LoadFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.centerState}>
      <MaterialIcons name="cloud-off" size={28} color={METEORA_COLORS.red} />
      <Text style={styles.centerTitle}>Pool unavailable</Text>
      <Text style={styles.centerBody}>{message}</Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        style={styles.retryButton}
      >
        <Text style={styles.retryText}>Try again</Text>
      </Pressable>
    </View>
  );
}

function getCtaState({
  loading,
  pool,
  activeTab,
  positionDraft,
  locallyValid,
  preview,
  previewLoading,
  previewExpired,
  stalePool,
  walletConnected,
  walletSupported,
  operationState,
  addMode,
}: {
  loading: boolean;
  pool: MeteoraPoolDetail | null;
  activeTab: MeteoraExecutionTab;
  positionDraft: MeteoraPositionDraft;
  locallyValid: boolean;
  preview: MeteoraPhaseTwoPreview | null;
  previewLoading: boolean;
  previewExpired: boolean;
  stalePool: boolean;
  walletConnected: boolean;
  walletSupported: boolean;
  operationState: MeteoraOperationState;
  addMode: boolean;
}): { label: string; disabled: boolean; busy: boolean } {
  if (loading || !pool) return { label: 'Loading pool…', disabled: true, busy: true };
  if (operationState === 'building') {
    return { label: 'Building transaction…', disabled: true, busy: true };
  }
  if (operationState === 'simulating') {
    return { label: 'Simulating…', disabled: true, busy: true };
  }
  if (operationState === 'awaiting_wallet') {
    return { label: 'Approve in wallet', disabled: true, busy: true };
  }
  if (operationState === 'submitted') {
    return { label: 'Submitted — checking transaction', disabled: true, busy: true };
  }
  if (operationState === 'confirming') {
    return { label: 'Confirming…', disabled: true, busy: true };
  }
  if (operationState === 'syncing') {
    return { label: 'Confirmed — syncing', disabled: true, busy: true };
  }
  if (operationState === 'success') {
    return {
      label: addMode ? 'Liquidity added' : activeTab === 'position' ? 'Position created' : 'Order placed',
      disabled: true,
      busy: false,
    };
  }
  if (operationState === 'partial') {
    return { label: 'Transaction needs recovery', disabled: true, busy: false };
  }
  if (!locallyValid) {
    return {
      label: activeTab === 'position' ? 'Enter amount and range' : 'Enter amount and target price',
      disabled: true,
      busy: false,
    };
  }
  if (previewLoading) return { label: 'Preparing preview…', disabled: true, busy: true };
  if (stalePool || previewExpired) return { label: 'Refresh preview', disabled: false, busy: false };
  if (!walletConnected) return { label: 'Connect Solana wallet', disabled: false, busy: false };
  if (!walletSupported) {
    return { label: 'Wallet cannot sign transactions', disabled: true, busy: false };
  }
  if (!preview) return { label: 'Preparing preview…', disabled: true, busy: true };
  if (!preview.canExecute) return { label: 'Fix issues above', disabled: true, busy: false };
  if (activeTab === 'limit') return { label: 'Place limit order', disabled: false, busy: false };
  if (positionDraft.fundingMode === 'single') {
    return { label: 'Start with one token', disabled: false, busy: false };
  }
  return { label: 'Add liquidity', disabled: false, busy: false };
}

function limitFundingToken(pool: MeteoraPoolDetail | null, side: 'buy' | 'sell') {
  if (!pool) return null;
  return side === 'buy' ? pool.tokenY : pool.tokenX;
}

/**
 * Normalizes an add-liquidity preview into the same MeteoraPhaseTwoPreview
 * shape the create/limit-order flows use, so the shared review, warnings,
 * and CTA rendering below need no add-mode-specific branching. The raw
 * MeteoraAddLiquidityPreview is stashed on sourcePreview for handleExecute.
 */
async function prepareAddModePreview(
  context: MeteoraPrepareContext,
  position: MeteoraPosition,
  draft: MeteoraPositionDraft,
  pool: MeteoraPoolDetail,
  adapter: MeteoraPhaseTwoAdapter,
): Promise<MeteoraPhaseTwoPreview> {
  const hasX = draft.amountX.length > 0;
  const hasY = draft.amountY.length > 0;
  if (!hasX && !hasY) {
    throw new Error('Enter an amount for at least one token.');
  }
  const tokenXAtomic = hasX ? decimalToAtomic(draft.amountX, pool.tokenX.decimals) : '0';
  const tokenYAtomic = hasY ? decimalToAtomic(draft.amountY, pool.tokenY.decimals) : '0';

  const summary = {
    positionAddress: position.address,
    poolAddress: pool.address,
    lowerBinId: position.lowerBinId,
    upperBinId: position.upperBinId,
    activeBinId: position.activeBinId,
    isOutOfRange: position.isOutOfRange,
  };
  const addPreview = await meteoraPositionActionsAdapter.prepareAdd(context, summary, {
    tokenXAtomic,
    tokenYAtomic,
  });

  const warnings: MeteoraPhaseTwoPreview['warnings'] = [];
  let spendableBalanceX: string | undefined;
  let spendableBalanceY: string | undefined;
  if (context.walletAddress && adapter.getWalletBalances) {
    try {
      const balances = await adapter.getWalletBalances(pool, context.walletAddress);
      spendableBalanceX = balances.x ?? undefined;
      spendableBalanceY = balances.y ?? undefined;
    } catch {
      // Balance display degrades to "Unavailable" via the screen's own
      // balance-fetch effect; execution validation still runs server-side.
    }
  }
  if (!context.pool.approvedByMeteora) {
    warnings.push({
      code: 'POOL_NOT_SUPPORTED',
      message: 'This pool is not currently approved for myBoon execution.',
      blocking: true,
    });
  }

  const now = Date.now();
  return {
    id: `add_${position.address}_${now}`,
    kind: 'position',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    currentPrice: pool.currentPrice ?? '0',
    requestedMinPrice: position.minPrice,
    requestedMaxPrice: position.maxPrice,
    executableMinPrice: position.minPrice,
    executableMaxPrice: position.maxPrice,
    minBinId: position.lowerBinId,
    maxBinId: position.upperBinId,
    binCount: position.upperBinId - position.lowerBinId + 1,
    requiredAmountX: draft.amountX || '0',
    requiredAmountY: draft.amountY || '0',
    spendableBalanceX,
    spendableBalanceY,
    transactionCount: addPreview.transactionCount,
    costs: [
      {
        label: 'Network fee and account rent',
        value: 'Validated before wallet approval',
      },
    ],
    warnings,
    canExecute: warnings.every((warning) => !warning.blocking),
    walletAddress: context.walletAddress,
    network: 'mainnet-beta',
    sourcePreview: addPreview,
  };
}

function executionWallet(wallet: ReturnType<typeof useWallet>) {
  return {
    connected: wallet.connected,
    address: wallet.address,
    source: wallet.source,
    isPreparing: 'isPreparing' in wallet ? wallet.isPreparing : false,
    signAndSendTransaction: typeof wallet.signAndSendTransaction === 'function'
      ? (transaction: unknown) => (
        wallet.signAndSendTransaction as (value: unknown) => Promise<unknown>
      )(transaction)
      : null,
  };
}

function rangePercent(
  binId: number | undefined,
  activeBinId: number | undefined,
  requestedPrice: string,
  currentPrice: string | null,
  binStep: number,
): number | undefined {
  let relativeBin: number | null = null;
  if (binId !== undefined && activeBinId !== undefined) {
    relativeBin = binId - activeBinId;
  } else {
    const requested = Number(requestedPrice);
    const current = Number(currentPrice);
    const step = 1 + binStep / 10_000;
    if (
      Number.isFinite(requested)
      && requested > 0
      && Number.isFinite(current)
      && current > 0
      && step > 1
    ) {
      relativeBin = Math.log(requested / current) / Math.log(step);
    }
  }
  if (relativeBin === null || !Number.isFinite(relativeBin)) return undefined;
  return relativeBinToRangePercent(relativeBin);
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: METEORA_COLORS.screen,
  },
  headerTitleRow: {
    flex: 1,
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
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: 'rgba(21,27,48,0.72)',
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  headerTitle: {
    color: METEORA_COLORS.text,
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '800',
  },
  headerPrice: {
    marginTop: 1,
    color: METEORA_COLORS.textDim,
    fontFamily: 'monospace',
    fontSize: 9,
    lineHeight: 13,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  poolContext: {
    gap: 12,
    paddingTop: 4,
    paddingBottom: 18,
  },
  metrics: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
    borderRadius: 14,
    backgroundColor: 'rgba(21,27,48,0.78)',
    overflow: 'hidden',
  },
  metric: {
    flex: 1,
    minHeight: 68,
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 11,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: METEORA_COLORS.border,
  },
  metricLabel: {
    color: METEORA_COLORS.textFaint,
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  metricValue: {
    color: METEORA_COLORS.text,
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
  },
  selectionExplanation: {
    color: METEORA_COLORS.textDim,
    fontSize: 11,
    lineHeight: 16,
  },
  rangeSection: {
    gap: 12,
    paddingVertical: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: METEORA_COLORS.border,
  },
  fieldErrorText: {
    color: METEORA_COLORS.red,
    fontSize: 11,
    lineHeight: 15,
  },
  snapRows: {
    gap: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(21,27,48,0.58)',
  },
  explorerLink: {
    minHeight: 44,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 4,
  },
  explorerLinkText: {
    color: METEORA_COLORS.cyan,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
  },
  previewRow: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  previewRowLabel: {
    flex: 1,
    color: METEORA_COLORS.textDim,
    fontSize: 11,
    lineHeight: 16,
  },
  previewRowValue: {
    maxWidth: '58%',
    color: METEORA_COLORS.text,
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'right',
  },
  previewRowAccent: {
    color: METEORA_COLORS.cyan,
  },
  advanced: {
    marginTop: 14,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
    backgroundColor: 'rgba(21,27,48,0.56)',
    overflow: 'hidden',
  },
  advancedTrigger: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
  },
  advancedTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  advancedTitle: {
    color: METEORA_COLORS.text,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
  advancedBody: {
    gap: 9,
    paddingHorizontal: 14,
    paddingBottom: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: METEORA_COLORS.border,
  },
  guardedRow: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  guardedLabel: {
    color: METEORA_COLORS.textDim,
    fontSize: 11,
    lineHeight: 15,
  },
  guardedValueWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  guardedValue: {
    color: METEORA_COLORS.text,
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
  },
  advancedCaption: {
    color: METEORA_COLORS.textFaint,
    fontSize: 10,
    lineHeight: 14,
  },
  cta: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    marginTop: 18,
    borderRadius: 14,
    backgroundColor: METEORA_COLORS.coral,
  },
  ctaDisabled: {
    backgroundColor: '#40303A',
    opacity: 0.72,
  },
  ctaSuccess: {
    backgroundColor: '#16765B',
    opacity: 1,
  },
  ctaError: {
    backgroundColor: '#793144',
    opacity: 1,
  },
  ctaPressed: {
    transform: [{ scale: 0.992 }],
    opacity: 0.9,
  },
  ctaText: {
    color: METEORA_COLORS.text,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '900',
  },
  ctaFootnote: {
    marginTop: 9,
    paddingHorizontal: 12,
    color: METEORA_COLORS.textFaint,
    fontSize: 9,
    lineHeight: 13,
    textAlign: 'center',
  },
  limitPriceField: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
    borderRadius: 14,
    backgroundColor: METEORA_COLORS.surfaceLift,
  },
  limitPriceInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 58,
    color: METEORA_COLORS.text,
    fontFamily: 'monospace',
    fontSize: 21,
    lineHeight: 27,
  },
  limitPriceSuffix: {
    maxWidth: 82,
    color: METEORA_COLORS.textDim,
    fontSize: 9,
    lineHeight: 13,
    textAlign: 'right',
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  centerTitle: {
    marginTop: 13,
    color: METEORA_COLORS.text,
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '800',
    textAlign: 'center',
  },
  centerBody: {
    maxWidth: 300,
    marginTop: 6,
    color: METEORA_COLORS.textDim,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  retryButton: {
    minWidth: 110,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    borderRadius: 22,
    backgroundColor: METEORA_COLORS.surfaceLift,
  },
  retryText: {
    color: METEORA_COLORS.cyan,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
  },
});
