import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type {
  MeteoraFreshness,
  MeteoraPoolDetail,
  MeteoraPosition,
  MeteoraResult,
  MeteoraStrategy,
  MeteoraExecutionPoolState,
  MeteoraPoolBinLiquidity,
} from '@myboon/shared/meteora';
import { resolveManualRangeForDisplay, snapRangeToPoolState } from '@myboon/shared/meteora';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
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
  PriceField,
  RangeVisualization,
  SegmentedControl,
  TokenAmountField,
} from '@/features/meteora/components/MeteoraExecutionControls';
import { METEORA_COLORS } from '@/features/meteora/meteora.theme';
import { MeteoraPriceChart } from '@/features/meteora/components/meteora-price-chart';
import { MeteoraPositionReviewSheet } from '@/features/meteora/components/meteora-position-review-sheet';
import { isMeteoraReviewCurrent, type MeteoraPositionReview } from '@/features/meteora/meteora.review';
import { estimateAutoFillAmounts } from '@/features/meteora/meteora.auto-fill';
import { createMeteoraRecoveryCoordinator } from '@/features/meteora/meteora.recovery';
import { getMeteoraPreviewBlocker, getMeteoraPreviewCta } from '@/features/meteora/meteora.preview-cta';
import { isEmptyTokenAmount, validateMeteoraPositionDraft } from '@/features/meteora/meteora.position-validation';
import { applyDefaultTokenRange, getPositionTokenMode } from '@/features/meteora/meteora.position-range';
import { createMeteoraPositionCostKey, getMeteoraPositionCostShape } from '@/features/meteora/meteora.position-cost';
import {
  getMeteoraLiquidityDistribution,
  getMeteoraPoolLiquidityDistribution,
  getMeteoraSdkLiquidityDistribution,
} from '@/features/meteora/meteora.liquidity-distribution';
import { rangeShiftPatch } from '@/features/meteora/meteora.range-drag';
import {
  amountFromBalance,
  autoFillPatch,
  canUseMeteoraBalanceShortcut,
  exceedsBalance,
  getMeteoraPoolLiquidityViewport,
  getMeteoraPoolStateSnapshotKey,
  mergePositionDraftPatch,
  priceDeltaLabel,
  rangeBinDeltaPatch,
  rangePoolBinDeltaPatch,
  rangePoolBinShiftPatch,
  nextMeteoraChartBinViewport,
  rangeChartBinGeometry,
  reciprocalPrice,
  tokenAmountPatch,
  tokenQuoteLabel,
} from '@/features/meteora/meteora.position-form';
import { tokens } from '@/theme/tokens';
import { AppProfileButton } from '@/components/AppProfileButton';
import { meteoraClient } from '@/features/meteora/meteora.client';
import { meteoraPhaseTwoAdapter } from '@/features/meteora/meteora.form-execution';
import {
  EMPTY_LIMIT_DRAFT,
  EMPTY_POSITION_DRAFT,
  createCenteredRange,
  decimalToAtomic,
  formatPoolPrice,
  formatMeteoraRangePrice,
  movePriceByBins,
  normalizePoolPrice,
  isPositiveDecimal,
  previewSecondsRemaining,
  sanitizeDecimalInput,
  validateAmount,
  validateLimitPrice,
  type MeteoraExecutionTab,
  type MeteoraExecutionUpdate,
  type MeteoraLimitDraft,
  type MeteoraOperationState,
  type MeteoraPhaseTwoAdapter,
  type MeteoraPhaseTwoPreview,
  type MeteoraPositionDraft,
  type MeteoraPositionCostEstimate,
  type MeteoraPrepareContext,
} from '@/features/meteora/meteora.form';
import { meteoraPositionActionsAdapter } from '@/features/meteora/meteora.position-actions';
import { mintRef, resolveTokenIdentities, tokenIconUrl, useTokenIdentities } from '@/lib/token-identity';
import { useWallet } from '@/hooks/useWallet';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import { walletBalanceClient } from '@/features/wallet/wallet.balance-client';
import { notifyWalletDataChanged, subscribeWalletDataChanged } from '@/features/wallet/wallet.refresh';

const PREVIEW_DEBOUNCE_MS = 450;

/** Narrow dev-fixture boundary; normal routes always use the connected wallet hook. */
export type MeteoraScreenWalletOverride = ReturnType<typeof useWallet>;

const STRATEGIES: {
  id: MeteoraStrategy;
  label: string;
  description: string;
  icon: 'blur-on' | 'show-chart' | 'swap-horiz';
  strategy: MeteoraStrategy;
}[] = [
  {
    id: 'spot',
    strategy: 'spot',
    label: 'Spot',
    description: 'Even liquidity across the selected range',
    icon: 'blur-on',
  },
  {
    id: 'curve',
    strategy: 'curve',
    label: 'Curve',
    description: 'More liquidity around the current price',
    icon: 'show-chart',
  },
  {
    id: 'bid_ask',
    strategy: 'bid_ask',
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
  walletOverride,
  liquidityRefreshSignal,
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
  /** Dev fixture boundary. Production routes never pass this value. */
  walletOverride?: MeteoraScreenWalletOverride;
  /** Dev fixture boundary to exercise a lower-histogram SDK-state refresh. */
  liquidityRefreshSignal?: number;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const connectedWallet = useWallet();
  const wallet = walletOverride ?? connectedWallet;
  const walletReady = wallet.connected && !!wallet.address;
  const connectSheet = useConnectionSheet('solana');
  const requestId = useRef(0);
  const walletRef = useRef(wallet);
  const executionRunningRef = useRef(false);
  const recoveryCoordinatorRef = useRef<ReturnType<typeof createMeteoraRecoveryCoordinator> | null>(null);
  if (!recoveryCoordinatorRef.current) recoveryCoordinatorRef.current = createMeteoraRecoveryCoordinator();
  const recoveryCoordinator = recoveryCoordinatorRef.current;
  const defaultRangePoolRef = useRef<string | null>(null);
  const defaultRangePoolPriceRef = useRef<string | null>(null);
  const defaultRangeBoundsRef = useRef<{
    minPrice: string;
    maxPrice: string;
    xOnlyMaxPrice?: string;
    yOnlyMinPrice?: string;
  } | null>(null);
  const defaultRangePriceRef = useRef<string | null>(null);
  const rangeUserEditedRef = useRef(false);
  walletRef.current = wallet;

  const [pool, setPool] = useState<MeteoraPoolDetail | null>(null);
  const [iconReloadKey, setIconReloadKey] = useState(0);

  // Meteora's API carries no icon field, so identity is the only icon source
  // for a pool's tokens here — same as on the pools list. Non-blocking: the
  // screen renders with letter circles and swaps in icons when they land.
  const poolIdentityRefs = useMemo(
    () => (pool ? [mintRef(pool.tokenX.address), mintRef(pool.tokenY.address)] : []),
    [pool?.tokenX.address, pool?.tokenY.address],
  );
  const poolIdentities = useTokenIdentities(poolIdentityRefs);
  const tokenXIconUrl = pool
    ? tokenIconUrl(poolIdentities.get(mintRef(pool.tokenX.address))?.iconUrl) ?? pool.tokenX.iconUrl
    : null;
  const tokenYIconUrl = pool
    ? tokenIconUrl(poolIdentities.get(mintRef(pool.tokenY.address))?.iconUrl) ?? pool.tokenY.iconUrl
    : null;
  const [freshness, setFreshness] = useState<MeteoraFreshness | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const activeTab: MeteoraExecutionTab = 'position';
  const [positionDraft, setPositionDraft] = useState<MeteoraPositionDraft>(EMPTY_POSITION_DRAFT);
  const [rangePoolState, setRangePoolState] = useState<MeteoraExecutionPoolState | null>(null);
  const [poolLiquidity, setPoolLiquidity] = useState<{
    key: string;
    poolAddress: string;
    bins: readonly MeteoraPoolBinLiquidity[];
    error: string | null;
    loading: boolean;
  } | null>(null);
  const [poolLiquidityNonce, setPoolLiquidityNonce] = useState(0);
  const [chartViewport, setChartViewport] = useState<{ poolAddress: string; minBinId: number; maxBinId: number } | null>(null);
  // Keep queued pointer edits available before React commits the next render.
  const positionDraftRef = useRef(positionDraft);
  positionDraftRef.current = positionDraft;
  const [limitDraft, setLimitDraft] = useState<MeteoraLimitDraft>(EMPTY_LIMIT_DRAFT);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [preparedPreview, setPreview] = useState<MeteoraPhaseTwoPreview | null>(null);
  const [autoFillQuote, setAutoFillQuote] = useState<{
    key: string;
    amountX: string;
    amountY: string;
  } | null>(null);
  const preview = walletReady && preparedPreview?.walletAddress === wallet.address ? preparedPreview : null;
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewRetryNonce, setPreviewRetryNonce] = useState(0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBlocker, setPreviewBlocker] = useState<string | null>(null);
  const [review, setReview] = useState<MeteoraPositionReview | null>(null);
  const [operationState, setOperationState] = useState<MeteoraOperationState>('editing');
  const operationStateRef = useRef(operationState);
  operationStateRef.current = operationState;
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [operationExplorerUrl, setOperationExplorerUrl] = useState<string | null>(null);
  const [recoveryNonce, setRecoveryNonce] = useState(0);
  const [priceInverted, setPriceInverted] = useState(false);
  const [priceInputText, setPriceInputText] = useState<Partial<Record<'min' | 'max', string>>>({});
  const [clock, setClock] = useState(Date.now());
  const [walletBalanceNonce, setWalletBalanceNonce] = useState(0);
  const [costRetryNonce, setCostRetryNonce] = useState(0);
  const [positionCost, setPositionCost] = useState<{
    key: string;
    estimate: MeteoraPositionCostEstimate | null;
    error: string | null;
    loading: boolean;
  } | null>(null);
  const [nativeBalance, setNativeBalance] = useState<{
    key: string;
    value: string | null;
    error: string | null;
  } | null>(null);
  const walletPoolKey = pool && walletReady ? `${pool.address}:${wallet.address}` : null;
  recoveryCoordinator.setScope(walletPoolKey);
  const addModeKey = walletPoolKey && positionAddress ? `${walletPoolKey}:${positionAddress}` : null;
  const [walletBalances, setWalletBalances] = useState<{
    key: string;
    x: string | null;
    y: string | null;
    error?: string;
  } | null>(null);
  const walletBalanceX = walletBalances?.key === walletPoolKey ? walletBalances.x : null;
  const walletBalanceY = walletBalances?.key === walletPoolKey ? walletBalances.y : null;
  const walletBalanceError = walletBalances?.key === walletPoolKey ? walletBalances.error : null;
  const [addModeLookup, setAddModeLookup] = useState<{
    key: string;
    position: MeteoraPosition | null;
    error: string | null;
  } | null>(null);
  const addModePosition = addModeLookup?.key === addModeKey ? addModeLookup.position : null;
  const addModeError = addModeLookup?.key === addModeKey ? addModeLookup.error : null;

  const loadPool = useCallback(async ({ clearCache = false }: { clearCache?: boolean } = {}) => {
    const id = requestId.current + 1;
    requestId.current = id;
    setLoadError(null);
    if (clearCache) client.clearCache();
    try {
      const result = await client.getPool(poolAddress);
      if (requestId.current !== id) return;
      void resolveTokenIdentities([
        mintRef(result.data.tokenX.address), mintRef(result.data.tokenY.address),
      ], { force: clearCache });
      setPool(result.data);
      setIconReloadKey((key) => key + 1);
      setFreshness(result.freshness);
    } catch (error) {
      if (requestId.current !== id) return;
      setLoadError(error instanceof Error ? error.message : 'This Meteora pool is unavailable');
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, [client, poolAddress]);

  useFocusEffect(useCallback(() => {
    void loadPool();
    return () => { requestId.current += 1; };
  }, [loadPool]));

  useEffect(() => {
    if (!pool) return undefined;
    // Add-mode locks strategy and range to the existing position; skip the
    // fresh-position default-range calculation entirely.
    if (positionAddress) return undefined;
    const initialPool = defaultRangePoolRef.current !== pool.address;
    if (!initialPool && defaultRangePoolPriceRef.current === pool.currentPrice) return undefined;
    defaultRangePoolRef.current = pool.address;
    defaultRangePoolPriceRef.current = pool.currentPrice;
    if (initialPool) {
      defaultRangeBoundsRef.current = null;
      setRangePoolState(null);
    }
    defaultRangePriceRef.current = pool.currentPrice;
    if (initialPool) rangeUserEditedRef.current = false;

    const fallbackRange = createCenteredRange(pool.currentPrice, pool.binStep);
    if (fallbackRange) {
      defaultRangeBoundsRef.current = {
        minPrice: fallbackRange.requestedMinPrice,
        maxPrice: fallbackRange.requestedMaxPrice,
      };
      if (!rangeUserEditedRef.current && !executionRunningRef.current
        && !isBusyOperation(operationStateRef.current) && operationStateRef.current !== 'success') {
        setPositionDraft((current) => applyDefaultTokenRange({
          draft: current,
          bounds: { minPrice: fallbackRange.requestedMinPrice, maxPrice: fallbackRange.requestedMaxPrice },
          currentPrice: pool.currentPrice,
          rangeEdited: rangeUserEditedRef.current,
          fixedRange: false,
          tokenXDecimals: pool.tokenX.decimals,
          tokenYDecimals: pool.tokenY.decimals,
        }));
        setPreview(null);
        setPreviewError(null);
        setOperationMessage(null);
        setOperationExplorerUrl(null);
        setOperationState('editing');
      }
    }

    if (!initialPool || !adapter.getDefaultRange) return undefined;
    let cancelled = false;
    void adapter.getDefaultRange(pool).then((range) => {
      if (cancelled) return;
      defaultRangeBoundsRef.current = {
        minPrice: range.requestedMinPrice,
        maxPrice: range.requestedMaxPrice,
        xOnlyMaxPrice: range.xOnlyMaxPrice,
        yOnlyMinPrice: range.yOnlyMinPrice,
      };
      const currentPrice = range.currentPrice ?? pool.currentPrice;
      defaultRangePriceRef.current = currentPrice;
      if (Number.isInteger(range.activeBinId) && range.currentPrice) {
        setRangePoolState({
          poolAddress: pool.address,
          activeBinId: range.activeBinId!,
          activePrice: range.currentPrice,
          binStep: pool.binStep,
          tokenX: pool.tokenX,
          tokenY: pool.tokenY,
          refreshedAt: new Date().toISOString(),
        });
      }
      if (rangeUserEditedRef.current || executionRunningRef.current
        || isBusyOperation(operationStateRef.current) || operationStateRef.current === 'success') return;
        setPositionDraft((current) => applyDefaultTokenRange({
          draft: current,
          bounds: defaultRangeBoundsRef.current,
        currentPrice,
        rangeEdited: rangeUserEditedRef.current,
        fixedRange: false,
        tokenXDecimals: pool.tokenX.decimals,
        tokenYDecimals: pool.tokenY.decimals,
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

  // Resolve the same exact SDK bin boundaries used for validation. This stays
  // available for over-wide drafts so the UI can report e.g. 71 selected bins.
  const selectedLiquidityWindow = useMemo(() => {
    if (!pool || !rangePoolState || !positionDraft.requestedMinPrice || !positionDraft.requestedMaxPrice) return null;
    try {
      const range = resolveManualRangeForDisplay(
        rangePoolState, positionDraft.requestedMinPrice, positionDraft.requestedMaxPrice,
      );
      return {
        minBinId: range.minBinId, maxBinId: range.maxBinId, binCount: range.binCount,
        executableMinPrice: range.executableMinPrice, executableMaxPrice: range.executableMaxPrice,
      };
    } catch {
      return null;
    }
  }, [pool, rangePoolState, positionDraft.requestedMinPrice, positionDraft.requestedMaxPrice]);

  // Keep a compact viewport stable as a gesture translates a range. It expands
  // only when a selected endpoint leaves the current window.
  useEffect(() => {
    if (!pool || !selectedLiquidityWindow) {
      setChartViewport(null);
      return;
    }
    setChartViewport((previous) => {
      const prior = previous?.poolAddress === pool.address
        ? { minBinId: previous.minBinId, maxBinId: previous.maxBinId } : null;
      const next = nextMeteoraChartBinViewport(selectedLiquidityWindow, prior);
      return next ? { poolAddress: pool.address, ...next } : null;
    });
  }, [pool?.address, selectedLiquidityWindow?.minBinId, selectedLiquidityWindow?.maxBinId]);

  const effectiveChartViewport = useMemo(() => chartViewport && chartViewport.poolAddress === pool?.address
    ? { minBinId: chartViewport.minBinId, maxBinId: chartViewport.maxBinId }
    : selectedLiquidityWindow ? nextMeteoraChartBinViewport(selectedLiquidityWindow) : null,
  [chartViewport, pool?.address, selectedLiquidityWindow]);
  const poolLiquidityViewport = useMemo(
    () => getMeteoraPoolLiquidityViewport(selectedLiquidityWindow, effectiveChartViewport),
    [selectedLiquidityWindow, effectiveChartViewport],
  );
  const poolLiquidityRequestKey = pool && poolLiquidityViewport
    ? `${pool.address}:${poolLiquidityViewport.minBinId}:${poolLiquidityViewport.maxBinId}:${poolLiquidityNonce}`
    : null;

  // This is a wallet-independent, cancellable SDK read for every canonical
  // bin currently visible in the retained viewport. A far-translated range
  // therefore cannot show old or invented-zero lower bars in its margin.
  useEffect(() => {
    if (!pool || !adapter.getPoolLiquidity || !selectedLiquidityWindow) {
      setPoolLiquidity(null);
      return undefined;
    }
    if (!poolLiquidityViewport || !poolLiquidityRequestKey) {
      setPoolLiquidity({
        key: `${pool.address}:viewport-too-wide:${poolLiquidityNonce}`,
        poolAddress: pool.address,
        bins: [],
        error: 'Visible liquidity window is too wide to load safely.',
        loading: false,
      });
      return undefined;
    }
    const key = poolLiquidityRequestKey;
    let cancelled = false;
    setPoolLiquidity({ key, poolAddress: pool.address, bins: [], error: null, loading: true });
    void adapter.getPoolLiquidity(pool.address, poolLiquidityViewport.minBinId, poolLiquidityViewport.maxBinId).then((result) => {
      if (cancelled) return;
      setPoolLiquidity({ key, poolAddress: pool.address, bins: result.bins, error: null, loading: false });
      const activePrice = result.activePrice;
      if (activePrice && Number.isInteger(result.activeBinId)) {
        setRangePoolState((current) => {
          if (!current || current.poolAddress !== pool.address
            || (current.activeBinId === result.activeBinId && current.activePrice === activePrice)) return current;
          return { ...current, activeBinId: result.activeBinId, activePrice, refreshedAt: new Date().toISOString() };
        });
      }
    }).catch((error) => {
      if (!cancelled) setPoolLiquidity({
        key, poolAddress: pool.address, bins: [],
        error: error instanceof Error ? error.message : 'Pool liquidity is unavailable.', loading: false,
      });
    });
    return () => { cancelled = true; };
  }, [adapter, pool?.address, selectedLiquidityWindow, poolLiquidityViewport, poolLiquidityRequestKey, poolLiquidityNonce, liquidityRefreshSignal]);

  // A successful SDK preview is the authoritative active-bin/price snapshot.
  // Updating it changes local snapping and chart markers without replacing a
  // manually edited requested range.
  useEffect(() => {
    const state = preview?.poolState;
    if (!state || state.poolAddress !== pool?.address) return;
    setRangePoolState((current) => (
      current?.poolAddress === state.poolAddress
      && current.activeBinId === state.activeBinId
      && current.activePrice === state.activePrice
        ? current
        : state
    ));
  }, [preview?.poolState, pool?.address]);

  // Add-mode: load the existing position so its range/distribution can be
  // shown as fixed context (TC-DETAIL-008) instead of re-asking goal,
  // distribution, or range.
  useEffect(() => {
    if (!pool || !positionAddress || !walletReady || !addModeKey) return undefined;
    let cancelled = false;
    setAddModeLookup(null);
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
          setAddModeLookup({
            key: addModeKey,
            position: null,
            error: 'This position could not be found. It may have been closed.',
          });
          return;
        }
        setAddModeLookup({ key: addModeKey, position: match, error: null });
        setPositionDraft((current) => ({
          ...current,
          preset: 'manual',
          requestedMinPrice: match.minPrice,
          requestedMaxPrice: match.maxPrice,
        }));
      } catch (error) {
        if (cancelled) return;
        setAddModeLookup({
          key: addModeKey,
          position: null,
          error: error instanceof Error ? error.message : 'This position could not be loaded.',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pool, positionAddress, walletReady, wallet.address, addModeKey]);

  // Load balances on connection and wallet refresh, before amount entry.
  // Retries are bounded; obsolete wallet/pool responses cannot update the row.
  useEffect(() => {
    if (!pool || !walletReady || !walletPoolKey || !adapter.getWalletBalances) {
      setWalletBalances(null);
      return undefined;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setWalletBalances(null);
    const walletAddress = wallet.address!;
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 800;

    const attempt = (attemptNumber: number) => {
      void adapter.getWalletBalances!(pool, walletAddress).then((balances) => {
        if (cancelled) return;
        const resolvedX = balances.x ?? null;
        const resolvedY = balances.y ?? null;
        if ((resolvedX === null || resolvedY === null) && attemptNumber < MAX_ATTEMPTS) {
          retryTimer = setTimeout(() => {
            if (!cancelled) attempt(attemptNumber + 1);
          }, RETRY_DELAY_MS * attemptNumber);
          return;
        }
        setWalletBalances({ key: walletPoolKey, x: resolvedX ?? 'Unavailable', y: resolvedY ?? 'Unavailable' });
      }).catch(() => {
        if (cancelled) return;
        if (attemptNumber < MAX_ATTEMPTS) {
          retryTimer = setTimeout(() => {
            if (!cancelled) attempt(attemptNumber + 1);
          }, RETRY_DELAY_MS * attemptNumber);
          return;
        }
        setWalletBalances({
          key: walletPoolKey,
          x: 'Unavailable',
          y: 'Unavailable',
          error: 'Wallet balances are unavailable. Pull down to retry.',
        });
      });
    };
    attempt(1);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [adapter, pool, wallet.address, walletReady, walletPoolKey, walletBalanceNonce]);

  useEffect(() => {
    if (!walletReady) return undefined;
    return subscribeWalletDataChanged(() => {
      walletBalanceClient.clearCache();
      setWalletBalanceNonce((nonce) => nonce + 1);
      if (!executionRunningRef.current) setPreview(null);
    });
  }, [walletReady, wallet.address]);

  const costShape = getMeteoraPositionCostShape(
    positionDraft,
    pool?.tokenX.decimals ?? 9,
    pool?.tokenY.decimals ?? 6,
  );
  const { inputToken: costInputToken, depositMode: costDepositMode } = costShape;
  const costInputKey = useMemo(() => createMeteoraPositionCostKey({
    poolAddress: pool?.address,
    walletAddress: wallet.address,
    freshness: freshness?.servedAt,
    minPrice: positionDraft.requestedMinPrice,
    maxPrice: positionDraft.requestedMaxPrice,
    strategy: positionDraft.strategy,
    inputToken: costInputToken,
    depositMode: costDepositMode,
    retry: costRetryNonce,
  }), [pool?.address, wallet.address, freshness?.servedAt, positionDraft.requestedMinPrice,
    positionDraft.requestedMaxPrice, positionDraft.strategy, costInputToken, costDepositMode, costRetryNonce]);
  const costRangeValid = useMemo(() => {
    if (!rangePoolState || !positionDraft.requestedMinPrice || !positionDraft.requestedMaxPrice) return false;
    try {
      snapRangeToPoolState(rangePoolState, {
        kind: 'manual', minPrice: positionDraft.requestedMinPrice, maxPrice: positionDraft.requestedMaxPrice,
      });
      return true;
    } catch { return false; }
  }, [rangePoolState, positionDraft.requestedMinPrice, positionDraft.requestedMaxPrice]);

  // Costs are not a preview: they stay available for MAX and native-fee
  // validation while the amount draft is empty, invalid, or balance-blocked.
  useEffect(() => {
    if (!pool || !freshness || !walletReady || positionAddress || !adapter.getPositionCostEstimate || !costRangeValid) {
      setPositionCost(null);
      return undefined;
    }
    let cancelled = false;
    setPositionCost({ key: costInputKey, estimate: null, error: null, loading: true });
    const timeout = setTimeout(() => {
      void adapter.getPositionCostEstimate!({
        pool, poolFreshness: freshness, walletAddress: wallet.address,
        wallet: executionWallet(wallet), connection: wallet.connection,
        getWalletSnapshot: () => executionWallet(walletRef.current),
      }, {
        minPrice: positionDraft.requestedMinPrice, maxPrice: positionDraft.requestedMaxPrice,
        strategy: positionDraft.strategy, inputToken: costInputToken, depositMode: costDepositMode,
      }).then((estimate) => {
        if (!cancelled) setPositionCost({ key: costInputKey, estimate, error: null, loading: false });
      }).catch((error) => {
        if (!cancelled) setPositionCost({
          key: costInputKey, estimate: null,
          error: error instanceof Error ? error.message : 'Native cost estimate is unavailable.', loading: false,
        });
      });
    }, 150);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [adapter, pool, freshness, walletReady, wallet.address, wallet.connection, positionAddress, costInputKey, costRangeValid,
    positionDraft.requestedMinPrice, positionDraft.requestedMaxPrice, positionDraft.strategy, costInputToken, costDepositMode]);

  useEffect(() => {
    if (!walletReady || !wallet.address || !adapter.getNativeBalance) {
      setNativeBalance(null);
      return undefined;
    }
    const key = `${wallet.address}:${walletBalanceNonce}`;
    let cancelled = false;
    void adapter.getNativeBalance(wallet.address).then((value) => {
      if (!cancelled) setNativeBalance({ key, value, error: null });
    }).catch((error) => {
      if (!cancelled) setNativeBalance({ key, value: null, error: error instanceof Error ? error.message : 'Native SOL balance is unavailable.' });
    });
    return () => { cancelled = true; };
  }, [adapter, walletReady, wallet.address, walletBalanceNonce]);

  const currentPositionCost = positionCost?.key === costInputKey ? positionCost : null;
  const nativeBalanceKey = wallet.address ? `${wallet.address}:${walletBalanceNonce}` : null;
  const currentNativeBalance = nativeBalance?.key === nativeBalanceKey ? nativeBalance.value : null;
  const nativeSolX = pool?.tokenX.address === 'So11111111111111111111111111111111111111112';
  const nativeSolY = pool?.tokenY.address === 'So11111111111111111111111111111111111111112';
  const isCreatingPosition = !positionAddress;
  // A current SDK preview describes the transaction we will ask the wallet to
  // sign, so its complete cost snapshot wins everywhere. If it could not price
  // that transaction, do not quietly permit it using a surrogate range quote.
  const effectivePositionCost = isCreatingPosition && preview
    ? preview.nativeReserve !== null && preview.nativeReserve !== undefined
      ? { costs: preview.costs, nativeReserve: preview.nativeReserve, transactionCount: preview.transactionCount }
      : null
    : currentPositionCost?.estimate ?? null;
  const nativeReserve = isCreatingPosition ? effectivePositionCost?.nativeReserve ?? null : null;
  const anyPositionAmount = isPositiveDecimal(positionDraft.amountX) || isPositiveDecimal(positionDraft.amountY);
  const nativeCostInsufficient = isCreatingPosition && anyPositionAmount && nativeReserve !== null
    && exceedsBalance(nativeReserve, currentNativeBalance);
  // A cost estimate must describe this exact wallet/range/strategy before it is
  // allowed to open the review sheet.  This is intentionally independent from
  // preview state so invalid amounts cannot clear the MAX reservation.
  const nativeCostReady = !isCreatingPosition || !anyPositionAmount || (
    !!effectivePositionCost
    && (!preview && currentPositionCost?.key === costInputKey
      ? !currentPositionCost.loading && !currentPositionCost.error
      : !!preview)
    && nativeReserve !== null
    && currentNativeBalance !== null
    && !nativeCostInsufficient
  );

  useEffect(() => {
    if (
      !pool
      || !freshness
      || !walletReady
      || wallet.source === 'privy'
      || !adapter.recoverPending
      || executionRunningRef.current
    ) {
      return undefined;
    }
    const attempt = recoveryCoordinator.beginAttempt();
    if (!attempt) return undefined;
    const currentWallet = walletRef.current;
    void adapter.recoverPending({
      pool,
      poolFreshness: freshness,
      walletAddress: wallet.address,
      wallet: executionWallet(currentWallet),
      connection: currentWallet.connection,
      getWalletSnapshot: () => executionWallet(walletRef.current),
    }, (update) => {
      if (!attempt.isCurrent()) return;
      setOperationState(update.state);
      setOperationMessage(update.message);
      if (update.explorerUrl) setOperationExplorerUrl(update.explorerUrl);
    }).then((result) => {
      if (!attempt.isCurrent()) return;
      if (!result) return;
      if (result.state === 'confirmed') setOperationState('success');
      else if (result.state === 'syncing') setOperationState('syncing');
      else if (result.state === 'partial') setOperationState('partial');
      else if (result.state === 'cancelled') setOperationState('editing');
      else setOperationState('submitted');
      setOperationMessage(result.message);
      if (result.explorerUrl) setOperationExplorerUrl(result.explorerUrl);
      if (result.state === 'confirmed') notifyWalletDataChanged();
      if (result.state === 'syncing' || result.state === 'submitted') {
        attempt.retry(() => {
          setRecoveryNonce((value) => value + 1);
        });
      }
    }).catch((error) => {
      if (!attempt.isCurrent()) return;
      setOperationState('error');
      setOperationMessage(error instanceof Error ? error.message : 'Pending transaction recovery failed');
    });
    return () => attempt.cancel();
  }, [
    adapter,
    freshness,
    pool,
    wallet.address,
    walletReady,
    wallet.connection,
    wallet.source,
    recoveryNonce,
    recoveryCoordinator,
  ]);

  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  const onRefresh = useCallback(async () => {
    if (isBusyOperation(operationState) || executionRunningRef.current) return;
    setRefreshing(true);
    walletBalanceClient.clearCache();
    invalidatePreview();
    await loadPool({ clearCache: true });
    setWalletBalanceNonce((nonce) => nonce + 1);
    setRefreshing(false);
  }, [loadPool, operationState]);

  const positionValidation = useMemo(() => validateMeteoraPositionDraft({
    draft: positionDraft,
    tokenX: pool?.tokenX ?? { symbol: 'token X', decimals: 9 },
    tokenY: pool?.tokenY ?? { symbol: 'token Y', decimals: 6 },
    addMode: !!addModePosition,
    poolState: rangePoolState,
  }), [positionDraft, pool, addModePosition, rangePoolState]);
  const amountXError = touched.amountX ? positionValidation.amountXError : null;
  const amountYError = touched.amountY ? positionValidation.amountYError : null;
  const localRangeError = positionValidation.rangeError;
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

  const positionLocallyValid = !!pool
    && (!positionAddress || !!addModePosition)
    && positionValidation.valid;

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
      walletReady,
      addModePosition: addModePosition?.address,
      walletBalanceNonce,
      previewRetryNonce,
      sdkPoolState: getMeteoraPoolStateSnapshotKey(rangePoolState),
    }),
    [
      activeTab,
      freshness?.servedAt,
      limitDraft,
      pool?.address,
      positionDraft,
      wallet.address,
      walletReady,
      addModePosition,
      walletBalanceNonce,
      previewRetryNonce,
      rangePoolState?.poolAddress,
      rangePoolState?.activeBinId,
      rangePoolState?.activePrice,
    ],
  );
  const sdkPoolStateKey = getMeteoraPoolStateSnapshotKey(rangePoolState);
  const previewPoolStateCurrent = !preview?.poolState || !sdkPoolStateKey
    || getMeteoraPoolStateSnapshotKey(preview.poolState) === sdkPoolStateKey;

  // Do not spend an SDK preview request when the wallet rows already prove the
  // draft cannot be funded.  Auto-Fill requires both pool balances, so a zero
  // calculated-side balance is also conclusive before its live quote lands.
  const locallyKnownInsufficient = useMemo(() => {
    if (!pool || !walletReady) return false;
    const xPositive = isPositiveDecimal(positionDraft.amountX);
    const yPositive = isPositiveDecimal(positionDraft.amountY);
    const xReserve = isCreatingPosition && nativeSolX ? nativeReserve ?? '0' : '0';
    const yReserve = isCreatingPosition && nativeSolY ? nativeReserve ?? '0' : '0';
    if ((xPositive && exceedsBalance(positionDraft.amountX, walletBalanceX, false, xReserve))
      || (yPositive && exceedsBalance(positionDraft.amountY, walletBalanceY, false, yReserve))) return true;
    const autoFillSourceX = positionDraft.autoFill && positionDraft.fundingMode === 'both' && xPositive
      && isEmptyTokenAmount(positionDraft.amountY);
    const autoFillSourceY = positionDraft.autoFill && positionDraft.fundingMode === 'both' && yPositive
      && isEmptyTokenAmount(positionDraft.amountX);
    return (autoFillSourceX && walletBalanceY !== null && /^0(?:\.0+)?$/.test(walletBalanceY))
      || (autoFillSourceY && walletBalanceX !== null && /^0(?:\.0+)?$/.test(walletBalanceX))
      || nativeCostInsufficient;
  }, [pool, walletReady, positionDraft, walletBalanceX, walletBalanceY, isCreatingPosition, nativeSolX, nativeSolY, nativeReserve, nativeCostInsufficient]);

  useEffect(() => {
    if (operationState === 'success' || isBusyOperation(operationState) || executionRunningRef.current) return undefined;
    if (!pool || !freshness || !walletReady || !locallyValid || locallyKnownInsufficient) {
      setPreview(null);
      setPreviewLoading(false);
      if (locallyKnownInsufficient) {
        setPreviewError('Insufficient wallet balance for this deposit.');
        setPreviewBlocker('Insufficient balance');
      }
      return undefined;
    }
    if (positionAddress && !addModePosition) {
      // Waiting on the existing position to load before an add-mode preview
      // can be prepared.
      setPreview(null);
      setPreviewLoading(false);
      return undefined;
    }
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    setPreviewBlocker(null);
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
            ? await adapter.preparePosition(context, positionDraft, (amounts) => {
              if (!cancelled) setAutoFillQuote({ key: previewInputKey, ...amounts });
            })
            : await adapter.prepareLimitOrder(context, limitDraft);
        }
        if (cancelled) return;
        setPreview(nextPreview);
        setOperationState(nextPreview.canExecute ? 'ready' : 'editing');
      } catch (error) {
        if (cancelled) return;
        setPreviewError(error instanceof Error ? error.message : 'Unable to prepare preview');
        setPreviewBlocker(getMeteoraPreviewBlocker(error));
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
  }, [previewInputKey, locallyValid, locallyKnownInsufficient, walletReady, adapter, positionAddress, addModePosition]);

  const previewRemaining = useMemo(() => {
    void clock;
    return previewSecondsRemaining(preview);
  }, [clock, preview]);
  const previewExpired = !!preview && previewRemaining <= 0;
  const stalePool = freshness?.state === 'stale';

  const pair = pool ? `${pool.tokenX.symbol} / ${pool.tokenY.symbol}` : 'Pool';
  const conversion = pool
    ? `1 ${pool.tokenX.symbol} = ${formatPoolPrice(rangePoolState?.activePrice ?? pool.currentPrice, 3)} ${pool.tokenY.symbol}`
    : 'Loading current price…';

  const updatePosition = useCallback((
    patch: Partial<MeteoraPositionDraft> | ((current: MeteoraPositionDraft) => Partial<MeteoraPositionDraft>),
    options?: { resetRange?: boolean; rangeEdited?: boolean },
  ) => {
    const manualRangeEdit = options?.rangeEdited || (typeof patch !== 'function'
      && (patch.requestedMinPrice !== undefined || patch.requestedMaxPrice !== undefined));
    const rangeEdited = options?.resetRange ? false : manualRangeEdit || rangeUserEditedRef.current;
    const bounds = defaultRangeBoundsRef.current;
    const currentPrice = defaultRangePriceRef.current ?? pool?.currentPrice ?? null;
    const current = positionDraftRef.current;
    let next = mergePositionDraftPatch(current, typeof patch === 'function' ? patch(current) : patch);
    const tokenXDecimals = pool?.tokenX.decimals ?? 9;
    const tokenYDecimals = pool?.tokenY.decimals ?? 6;
    const changedMode = getPositionTokenMode(current, tokenXDecimals, tokenYDecimals)
      !== getPositionTokenMode(next, tokenXDecimals, tokenYDecimals);
    const validation = validateMeteoraPositionDraft({
      draft: next,
      tokenX: pool?.tokenX ?? { symbol: 'token X', decimals: tokenXDecimals },
      tokenY: pool?.tokenY ?? { symbol: 'token Y', decimals: tokenYDecimals },
      addMode: !!positionAddress,
      poolState: rangePoolState,
    });
    if (options?.resetRange || (changedMode && !validation.amountXError && !validation.amountYError)) {
      next = applyDefaultTokenRange({
        draft: next,
        bounds,
        currentPrice,
        rangeEdited,
        fixedRange: !!positionAddress,
        tokenXDecimals,
        tokenYDecimals,
      });
    }
    next = mergePositionDraftPatch(current, next);
    if (options?.resetRange) rangeUserEditedRef.current = false;
    if (next === current) return false;
    rangeUserEditedRef.current = !!rangeEdited;
    positionDraftRef.current = next;
    setPositionDraft(next);
    invalidatePreview();
    return true;
  }, [pool, positionAddress]);

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

  const balanceX = walletReady ? walletBalanceX ?? preview?.spendableBalanceX ?? null : null;
  const balanceY = walletReady ? walletBalanceY ?? preview?.spendableBalanceY ?? null : null;
  const autoFillActive = positionDraft.autoFill && positionDraft.fundingMode === 'both' && !addModePosition;
  const calculatedX = autoFillActive && isEmptyTokenAmount(positionDraft.amountX)
    && !positionValidation.amountXError && isPositiveDecimal(positionDraft.amountY) && !positionValidation.amountYError;
  const calculatedY = autoFillActive && isEmptyTokenAmount(positionDraft.amountY)
    && !positionValidation.amountYError && isPositiveDecimal(positionDraft.amountX) && !positionValidation.amountXError;
  const currentAutoFillQuote = autoFillQuote?.key === previewInputKey ? autoFillQuote : null;
  const rawCurrentPrice = rangePoolState?.activePrice ?? preview?.currentPrice ?? pool?.currentPrice ?? null;
  const estimatedAmounts = useMemo(() => estimateAutoFillAmounts({
    draft: { ...positionDraft, autoFill: autoFillActive },
    currentPrice: rawCurrentPrice,
    binStep: rangePoolState?.binStep ?? pool?.binStep ?? 1,
    tokenXDecimals: pool?.tokenX.decimals ?? 9,
    tokenYDecimals: pool?.tokenY.decimals ?? 9,
  }), [positionDraft, autoFillActive, rawCurrentPrice, rangePoolState?.binStep, pool?.binStep, pool?.tokenX.decimals, pool?.tokenY.decimals]);
  const quotedAmountX = preview?.requiredAmountX ?? currentAutoFillQuote?.amountX;
  const quotedAmountY = preview?.requiredAmountY ?? currentAutoFillQuote?.amountY;
  const estimatedX = calculatedX && !quotedAmountX && !!estimatedAmounts;
  const estimatedY = calculatedY && !quotedAmountY && !!estimatedAmounts;
  const autoFillPendingLabel = previewLoading ? 'Calculating…' : previewError ? 'Quote unavailable' : 'Waiting for quote';
  const displayedAmountX = calculatedX
    ? quotedAmountX ?? estimatedAmounts?.amountX ?? '' : positionDraft.amountX;
  const displayedAmountY = calculatedY
    ? quotedAmountY ?? estimatedAmounts?.amountY ?? '' : positionDraft.amountY;
  const insufficientX = exceedsBalance(displayedAmountX, balanceX, estimatedX, nativeSolX ? nativeReserve ?? '0' : '0');
  const insufficientY = exceedsBalance(displayedAmountY, balanceY, estimatedY, nativeSolY ? nativeReserve ?? '0' : '0');
  const nativeShortcutReadyX = canUseMeteoraBalanceShortcut({
    isNative: !!nativeSolX, isCreating: isCreatingPosition, nativeReserve, nativeBalance: currentNativeBalance,
  });
  const nativeShortcutReadyY = canUseMeteoraBalanceShortcut({
    isNative: !!nativeSolY, isCreating: isCreatingPosition, nativeReserve, nativeBalance: currentNativeBalance,
  });
  const spendableX = amountFromBalance(nativeSolX ? currentNativeBalance : balanceX, pool?.tokenX.decimals ?? 9, 1, nativeSolX ? nativeReserve ?? '0' : '0');
  const spendableY = amountFromBalance(nativeSolY ? currentNativeBalance : balanceY, pool?.tokenY.decimals ?? 6, 1, nativeSolY ? nativeReserve ?? '0' : '0');
  const canSpendX = nativeShortcutReadyX && !!spendableX && isPositiveDecimal(spendableX);
  const canSpendY = nativeShortcutReadyY && !!spendableY && isPositiveDecimal(spendableY);
  const chartCurrentPrice = normalizePoolPrice(rawCurrentPrice);
  const quoteLabel = pool
    ? priceInverted ? `${pool.tokenX.symbol}/${pool.tokenY.symbol}` : `${pool.tokenY.symbol}/${pool.tokenX.symbol}`
    : '';
  const displayCurrentPrice = priceInverted ? reciprocalPrice(chartCurrentPrice) : chartCurrentPrice ?? '';
  const displayMinPrice = priceInverted ? reciprocalPrice(positionDraft.requestedMaxPrice) : positionDraft.requestedMinPrice;
  const displayMaxPrice = priceInverted ? reciprocalPrice(positionDraft.requestedMinPrice) : positionDraft.requestedMaxPrice;
  const canonicalChartMinPrice = selectedLiquidityWindow?.executableMinPrice
    ?? preview?.executableMinPrice ?? positionDraft.requestedMinPrice;
  const canonicalChartMaxPrice = selectedLiquidityWindow?.executableMaxPrice
    ?? preview?.executableMaxPrice ?? positionDraft.requestedMaxPrice;
  const chartMinPrice = priceInverted ? reciprocalPrice(canonicalChartMaxPrice) : canonicalChartMinPrice;
  const chartMaxPrice = priceInverted ? reciprocalPrice(canonicalChartMinPrice) : canonicalChartMaxPrice;
  const chartGeometry = useMemo(() => (
    rangePoolState && selectedLiquidityWindow && effectiveChartViewport
      ? rangeChartBinGeometry({
        activeBinId: rangePoolState.activeBinId,
        minBinId: selectedLiquidityWindow.minBinId,
        maxBinId: selectedLiquidityWindow.maxBinId,
        viewport: effectiveChartViewport,
        inverted: priceInverted,
      })
      : null
  ), [rangePoolState, selectedLiquidityWindow, effectiveChartViewport, priceInverted]);
  // The bounded visible viewport is small enough to keep one screen column
  // per canonical bin. Grouping 70 bins into 56 columns aliases Spot's equal
  // per-bin allocation into an artificial jagged pattern.
  const chartBarCount = chartGeometry
    ? chartGeometry.domainMaxBin - chartGeometry.domainMinBin + 1
    : undefined;
  const axisMinPrice = chartGeometry && rangePoolState
    ? (priceInverted
      ? reciprocalPrice(movePriceByBins(rangePoolState.activePrice, rangePoolState.binStep, chartGeometry.domainMaxBin - rangePoolState.activeBinId))
      : movePriceByBins(rangePoolState.activePrice, rangePoolState.binStep, chartGeometry.domainMinBin - rangePoolState.activeBinId))
    : '';
  const axisMaxPrice = chartGeometry && rangePoolState
    ? (priceInverted
      ? reciprocalPrice(movePriceByBins(rangePoolState.activePrice, rangePoolState.binStep, chartGeometry.domainMinBin - rangePoolState.activeBinId))
      : movePriceByBins(rangePoolState.activePrice, rangePoolState.binStep, chartGeometry.domainMaxBin - rangePoolState.activeBinId))
    : '';
  const depositTokenMode = getPositionTokenMode(positionDraft, pool?.tokenX.decimals ?? 9, pool?.tokenY.decimals ?? 6, !!positionAddress);
  const sdkAllocationReady = !!preview?.strategyAllocation && !!chartGeometry && !!rangePoolState;
  // The live preview carries the official SDK allocator, including active-bin
  // reserve mix and strategy math. Editing before a preview uses the labeled
  // estimate below and never substitutes it into execution.
  const liquidityDistribution = useMemo(() => sdkAllocationReady && chartGeometry && rangePoolState
    ? getMeteoraSdkLiquidityDistribution({
      allocations: preview.strategyAllocation!,
      minBinId: chartGeometry.domainMinBin,
      maxBinId: chartGeometry.domainMaxBin,
      activeBinId: rangePoolState.activeBinId,
      activePrice: rangePoolState.activePrice,
      binStep: rangePoolState.binStep,
      tokenXDecimals: pool?.tokenX.decimals ?? 9,
      tokenYDecimals: pool?.tokenY.decimals ?? 6,
      inverted: priceInverted,
      barCount: chartBarCount,
    })
    : getMeteoraLiquidityDistribution({
    strategy: addModePosition ? 'spot' : positionDraft.strategy,
    mode: depositTokenMode,
    amountX: displayedAmountX,
    amountY: displayedAmountY,
    tokenXDecimals: pool?.tokenX.decimals ?? 9,
    tokenYDecimals: pool?.tokenY.decimals ?? 6,
    currentPrice: chartCurrentPrice ?? '',
    minPrice: canonicalChartMinPrice,
    maxPrice: canonicalChartMaxPrice,
    binStep: rangePoolState?.binStep ?? pool?.binStep ?? 1,
    inverted: priceInverted,
    barCount: chartBarCount,
      domainMinBin: chartGeometry && rangePoolState ? chartGeometry.domainMinBin - rangePoolState.activeBinId : undefined,
      domainMaxBin: chartGeometry && rangePoolState ? chartGeometry.domainMaxBin - rangePoolState.activeBinId : undefined,
    }), [
    sdkAllocationReady, preview?.strategyAllocation, rangePoolState, chartGeometry, chartBarCount,
    addModePosition, positionDraft.strategy, depositTokenMode, displayedAmountX, displayedAmountY,
    pool?.tokenX.decimals, pool?.tokenY.decimals, rangePoolState?.binStep, pool?.binStep, chartCurrentPrice,
    canonicalChartMinPrice, canonicalChartMaxPrice, priceInverted, rangePoolState?.activeBinId,
  ]);
  const currentPoolLiquidity = poolLiquidityRequestKey && poolLiquidity?.key === poolLiquidityRequestKey
    ? poolLiquidity : null;
  const poolLiquidityState = poolLiquidityViewport
    ? !currentPoolLiquidity || currentPoolLiquidity.loading ? 'loading'
      : currentPoolLiquidity.error ? 'error' : undefined
    : selectedLiquidityWindow ? 'error' : undefined;
  const poolLiquidityBars = useMemo(() => getMeteoraPoolLiquidityDistribution({
    bins: poolLiquidityState ? [] : currentPoolLiquidity?.bins ?? [],
    minBinId: chartGeometry?.domainMinBin ?? 0,
    maxBinId: chartGeometry?.domainMaxBin ?? 0,
    currentPrice: chartCurrentPrice ?? '',
    tokenXDecimals: pool?.tokenX.decimals ?? 9,
    tokenYDecimals: pool?.tokenY.decimals ?? 6,
    inverted: priceInverted,
    barCount: liquidityDistribution.bars.length,
  }), [currentPoolLiquidity, poolLiquidityState, chartGeometry, chartCurrentPrice,
    pool?.tokenX.decimals, pool?.tokenY.decimals, priceInverted, liquidityDistribution.bars.length]);
  const liveBinCount = selectedLiquidityWindow?.binCount ?? null;
  const executionBusy = isBusyOperation(operationState);

  function changeAmount(side: 'x' | 'y', value: string) {
    if (!pool || executionBusy) return;
    updatePosition((current) => tokenAmountPatch(
      { ...current, autoFill: current.autoFill && current.fundingMode === 'both' && !addModePosition },
      side,
      sanitizeDecimalInput(value, side === 'x' ? pool.tokenX.decimals : pool.tokenY.decimals),
    ));
  }

  function fillFromBalance(side: 'x' | 'y', divisor: 1 | 2) {
    if (!pool) return;
    const isNativeSide = side === 'x' ? nativeSolX : nativeSolY;
    if (isNativeSide && !canUseMeteoraBalanceShortcut({
      isNative: true, isCreating: isCreatingPosition, nativeReserve, nativeBalance: currentNativeBalance,
    })) return;
    const nativeReserveForSide = isNativeSide ? nativeReserve ?? '0' : '0';
    const amount = amountFromBalance(isNativeSide ? currentNativeBalance : side === 'x' ? balanceX : balanceY,
      side === 'x' ? pool.tokenX.decimals : pool.tokenY.decimals, divisor, nativeReserveForSide);
    if (amount !== null) {
      changeAmount(side, amount);
      markTouched(side === 'x' ? 'amountX' : 'amountY');
    }
  }

  function toggleAutoFill(autoFill: boolean) {
    if (executionBusy) return;
    updatePosition((current) => autoFillPatch(current, autoFill, { amountX: quotedAmountX, amountY: quotedAmountY }));
    setTouched((current) => ({ ...current, amountX: false, amountY: false }));
  }

  function changeRangePrice(edge: 'min' | 'max', value: string) {
    if (positionAddress || executionBusy) return;
    const text = sanitizeDecimalInput(value, 36);
    setPriceInputText((current) => ({ ...current, [edge]: text }));
    const canonicalEdge = priceInverted ? edge === 'min' ? 'max' : 'min' : edge;
    updatePosition({
      preset: 'manual',
      [canonicalEdge === 'min' ? 'requestedMinPrice' : 'requestedMaxPrice']: priceInverted ? reciprocalPrice(text) : text,
    });
  }

  function blurRangePrice(edge: 'min' | 'max') {
    markTouched('range');
    if (!localRangeError) setPriceInputText((current) => ({ ...current, [edge]: undefined }));
  }

  function adjustRangePrice(edge: 'min' | 'max', deltaBins: number) {
    if (!pool || positionAddress || executionBusy) return 0;
    setPriceInputText({});
    markTouched('range');
    const canonicalEdge = priceInverted ? edge === 'min' ? 'max' : 'min' : edge;
    const canonicalDelta = priceInverted ? -deltaBins : deltaBins;
    const changed = updatePosition((current) => rangePoolState
      ? rangePoolBinDeltaPatch(current, { poolState: rangePoolState, edge: canonicalEdge, deltaBins: canonicalDelta })
      : rangeBinDeltaPatch(current, {
        currentPrice: pool.currentPrice, binStep: pool.binStep, edge: canonicalEdge, deltaBins: canonicalDelta,
      }), { rangeEdited: true });
    return changed ? deltaBins : 0;
  }

  function shiftRange(deltaBins: number) {
    if (!pool || positionAddress || executionBusy) return 0;
    setPriceInputText({});
    markTouched('range');
    const changed = updatePosition((current) => rangePoolState
      ? rangePoolBinShiftPatch(current, rangePoolState, priceInverted ? -deltaBins : deltaBins)
      : rangeShiftPatch(current, pool.binStep, priceInverted ? -deltaBins : deltaBins), { rangeEdited: true });
    return changed ? deltaBins : 0;
  }

  function resetRange() {
    if (!pool || positionAddress || executionBusy) return;
    const centered = createCenteredRange(pool.currentPrice, pool.binStep);
    const bounds = defaultRangeBoundsRef.current ?? (centered
      ? { minPrice: centered.requestedMinPrice, maxPrice: centered.requestedMaxPrice } : null);
    if (!bounds) return;
    defaultRangeBoundsRef.current = bounds;
    if (!defaultRangePriceRef.current) defaultRangePriceRef.current = pool.currentPrice;
    setPriceInputText({});
    setTouched((current) => ({ ...current, range: false }));
    updatePosition({}, { resetRange: true });
  }

  const handleExecute = useCallback(async () => {
    if (!pool || !freshness || executionRunningRef.current || isBusyOperation(operationState)) return;
    if (!walletReady) return;
    if (positionAddress && !addModePosition) return;
    if (stalePool || previewExpired) {
      await onRefresh();
      return;
    }
    if (wallet.source === 'privy' || typeof wallet.signAndSendTransaction !== 'function') {
      setOperationState('error');
      setOperationMessage('This wallet can view Meteora, but it cannot sign Solana transactions.');
      return;
    }
    if (!preview || previewExpired || stalePool || !preview.canExecute || !nativeCostReady || !previewPoolStateCurrent) return;
    executionRunningRef.current = true;
    // Invalidate an earlier recovery callback before the wallet flow starts.
    const execution = recoveryCoordinator.beginExecution();
    let executionResultState: string | null = null;
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
            if (!execution.isCurrent()) return;
            setOperationState(update.state);
            setOperationMessage(update.message);
            if (update.explorerUrl) setOperationExplorerUrl(update.explorerUrl);
          },
        )
        : await adapter.execute(
          context,
          preview,
          (update) => {
            if (!execution.isCurrent()) return;
            setOperationState(update.state);
            setOperationMessage(update.message);
            if (update.explorerUrl) setOperationExplorerUrl(update.explorerUrl);
          },
        );
      executionResultState = result.state;
      if (!execution.isCurrent()) return;
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
      if (result.state === 'confirmed' || result.state === 'syncing') notifyWalletDataChanged();
    } catch (error) {
      if (!execution.isCurrent()) return;
      setOperationState('error');
      setOperationMessage(error instanceof Error ? error.message : 'The transaction could not be completed');
    } finally {
      executionRunningRef.current = false;
      if (!execution.isCurrent()) {
        setOperationState('editing');
        setOperationMessage(null);
        setOperationExplorerUrl(null);
      }
      if (execution.finish(executionResultState)) {
        setRecoveryNonce((value) => value + 1);
      }
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
    walletReady,
    addModePosition,
    positionAddress,
    operationState,
    nativeCostReady,
    previewPoolStateCurrent,
    recoveryCoordinator,
  ]);

  const nativeCostBlocker = activeTab === 'position' && isCreatingPosition && anyPositionAmount
    ? !preview && currentPositionCost?.loading ? 'Calculating native cost'
      : !preview && currentPositionCost?.error ? 'Retry native cost estimate'
        : nativeReserve === null ? 'Native cost estimate unavailable'
          : currentNativeBalance === null ? nativeBalance?.error ? 'Retry native SOL balance' : 'Checking native SOL balance'
            : nativeCostInsufficient ? 'Insufficient native SOL for fees'
              : null
    : null;
  const actualPreviewCostUnavailable = isCreatingPosition && !!preview
    && (preview.nativeReserve === null || preview.nativeReserve === undefined);
  const retryNativeCost = () => {
    setReview(null);
    setPreview(null);
    setPreviewError(null);
    setPreviewBlocker(null);
    setCostRetryNonce((value) => value + 1);
    setPreviewRetryNonce((value) => value + 1);
  };
  const cta = getMeteoraPreviewCta({
    loading,
    poolAvailable: !!pool,
    activeTab,
    positionFundingMode: positionDraft.fundingMode,
    locallyValid,
    formBlocker: activeTab === 'position'
      ? positionAddress && !addModePosition ? 'Loading position…' : positionValidation.blockerLabel
      : limitAmountError ? 'Fix order amount' : limitPriceError ? 'Fix target price' : null,
    executionBlocker: !previewPoolStateCurrent ? 'Refreshing SDK price' : nativeCostBlocker,
    insufficientBalance: insufficientX || insufficientY,
    preview,
    previewError,
    previewBlocker,
    previewLoading,
    previewExpired,
    stalePool: !!stalePool,
    walletConnected: walletReady,
    walletSupported: wallet.source !== 'privy'
      && typeof wallet.signAndSendTransaction === 'function',
    operationState,
    addMode: !!addModePosition,
  });
  const canReview = walletReady && !cta.disabled && !executionBusy && !stalePool
    && !previewError && !previewExpired && !!preview?.canExecute && previewPoolStateCurrent;
  const reviewCurrent = isMeteoraReviewCurrent(review, preview, {
    inputKey: previewInputKey,
    poolAddress: pool?.address ?? null,
    walletAddress: walletReady ? wallet.address : null,
    ready: canReview,
    nowMs: clock,
  });
  const reviewBlocker = !review || reviewCurrent ? null : previewExpired
    ? 'This quote expired. Go back to refresh and review the updated position.'
    : 'The position details changed. Go back and review the updated quote.';
  const footerLabel = !walletReady ? 'Connect wallet' : canReview ? 'Review position' : cta.label;
  const footerDisabled = walletReady && cta.disabled;
  const footerBusy = walletReady && cta.busy;
  const ctaForeground = footerDisabled && operationState !== 'success' && operationState !== 'error'
    ? METEORA_COLORS.textDim
    : METEORA_COLORS.onAccent;

  useEffect(() => {
    if (review && (!walletReady || wallet.address !== review.walletAddress || pool?.address !== review.pool.address)) {
      setReview(null);
    }
  }, [review, walletReady, wallet.address, pool?.address]);

  function handlePrimaryAction() {
    if (!walletReady) {
      connectSheet.open('solana');
      return;
    }
    if (cta.disabled) return;
    if (stalePool || previewExpired || previewError || !preview) {
      void onRefresh();
      return;
    }
    if (!canReview || !preview || !pool || !wallet.address) return;
    Keyboard.dismiss();
    setReview({
      pool,
      preview,
      inputKey: previewInputKey,
      walletAddress: wallet.address,
      amountX: preview.requiredAmountX ?? displayedAmountX,
      amountY: preview.requiredAmountY ?? displayedAmountY,
      strategy: addModePosition ? 'spot' : positionDraft.strategy,
      inverted: priceInverted,
      addMode: !!positionAddress,
      costs: effectivePositionCost?.costs ?? preview.costs,
      transactionCount: effectivePositionCost?.transactionCount ?? preview.transactionCount,
    });
  }

  function handleConfirmReview() {
    if (!nativeCostReady || !isMeteoraReviewCurrent(review, preview, {
      inputKey: previewInputKey,
      poolAddress: pool?.address ?? null,
      walletAddress: walletReady ? wallet.address : null,
      ready: canReview,
    })) return;
    setReview(null);
    void handleExecute();
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
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
        />
      </View>

      {loading ? (
        <LoadingPool />
      ) : loadError || !pool ? (
        <LoadFailure message={loadError ?? 'This pool is unavailable'} onRetry={() => loadPool()} />
      ) : (
        <ScrollView
          style={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              enabled={!executionBusy}
              onRefresh={onRefresh}
              tintColor={METEORA_COLORS.accent}
              colors={[METEORA_COLORS.accent]}
            />
          )}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: 20 },
          ]}
        >
          <View style={styles.fullWidthChart}>
            <MeteoraPriceChart
              poolAddress={pool.address}
              currentPrice={chartCurrentPrice}
              quoteLabel={quoteLabel}
              inverted={priceInverted}
              defaultMode="line"
              height={208}
            />
          </View>
          {stalePool ? (
            <InlineNotice
              tone="warning"
              title="Pool data needs a refresh"
              message="Refresh this pool before creating a position."
            />
          ) : null}

          {addModeError ? (
            <InlineNotice tone="error" title="Position unavailable" message={addModeError} />
          ) : null}

          {positionAddress && walletReady && !addModePosition && !addModeError ? (
            <View style={styles.centerState}>
              <ActivityIndicator color={METEORA_COLORS.accent} />
              <Text style={styles.centerBody}>Loading your position…</Text>
            </View>
          ) : activeTab === 'position' ? (
            <>
              <View style={styles.amountSection}>
                <View style={styles.amountHeading}>
                  <Text style={styles.rangeTitle}>Amount</Text>
                  {!positionAddress ? (
                    <AutoFillControl compact value={positionDraft.autoFill} onChange={toggleAutoFill} disabled={executionBusy} />
                  ) : null}
                </View>
                {addModePosition ? (
                  <Text style={styles.selectionExplanation}>Adding to your position · Fixed range · Spot distribution</Text>
                ) : null}
                <View style={styles.amountGroup}>
                  <TokenAmountField
                    compact
                    symbol={pool.tokenX.symbol}
                    iconUrl={tokenXIconUrl}
                    iconReloadKey={iconReloadKey}
                    venueIconUrl={pool.tokenX.iconUrl}
                    value={displayedAmountX}
                    calculated={calculatedX}
                    estimated={estimatedX}
                    disabled={executionBusy}
                    secondaryValue={calculatedX && !displayedAmountX
                      ? autoFillPendingLabel
                      : tokenQuoteLabel(displayedAmountX, chartCurrentPrice, 'x', pool.tokenY.symbol)
                        ?? (!autoFillActive && isEmptyTokenAmount(displayedAmountX) ? 'Optional' : undefined)}
                    balance={walletReady
                      ? balanceX ?? 'Checking…'
                      : undefined}
                    error={insufficientX ? `Insufficient ${pool.tokenX.symbol} balance` : calculatedX ? null : amountXError}
                    hideErrorMessage={insufficientX}
                    accent={METEORA_COLORS.tokenX}
                    onChangeText={(value) => changeAmount('x', value)}
                    onBlur={() => markTouched('amountX')}
                    onHalf={walletReady && canSpendX ? () => fillFromBalance('x', 2) : undefined}
                    onMax={walletReady && canSpendX ? () => fillFromBalance('x', 1) : undefined}
                  />
                  <TokenAmountField
                    compact
                    symbol={pool.tokenY.symbol}
                    iconUrl={tokenYIconUrl}
                    iconReloadKey={iconReloadKey}
                    venueIconUrl={pool.tokenY.iconUrl}
                    value={displayedAmountY}
                    calculated={calculatedY}
                    estimated={estimatedY}
                    disabled={executionBusy}
                    secondaryValue={calculatedY && !displayedAmountY
                      ? autoFillPendingLabel
                      : tokenQuoteLabel(displayedAmountY, chartCurrentPrice, 'y', pool.tokenX.symbol)
                        ?? (!autoFillActive && isEmptyTokenAmount(displayedAmountY) ? 'Optional' : undefined)}
                    balance={walletReady
                      ? balanceY ?? 'Checking…'
                      : undefined}
                    error={insufficientY ? `Insufficient ${pool.tokenY.symbol} balance` : calculatedY ? null : amountYError}
                    hideErrorMessage={insufficientY}
                    accent={METEORA_COLORS.tokenY}
                    onChangeText={(value) => changeAmount('y', value)}
                    onBlur={() => markTouched('amountY')}
                    onHalf={walletReady && canSpendY ? () => fillFromBalance('y', 2) : undefined}
                    onMax={walletReady && canSpendY ? () => fillFromBalance('y', 1) : undefined}
                  />
                </View>

                {walletBalanceError ? (
                  <Text style={styles.fieldErrorText} accessibilityRole="alert">{walletBalanceError}</Text>
                ) : null}

                {walletReady && !preview && currentPositionCost?.loading ? (
                  <Text style={styles.selectionExplanation}>Calculating native cost and refundable rent…</Text>
                ) : !preview && currentPositionCost?.error ? (
                  <Pressable
                    onPress={retryNativeCost}
                    accessibilityRole="button"
                    accessibilityLabel="Retry native cost estimate"
                  >
                    <Text style={styles.fieldErrorText}>Native cost estimate unavailable. Tap to retry.</Text>
                  </Pressable>
                ) : actualPreviewCostUnavailable ? (
                  <Pressable
                    onPress={retryNativeCost}
                    accessibilityRole="button"
                    accessibilityLabel="Retry current preview native cost estimate"
                  >
                    <Text style={styles.fieldErrorText}>Current preview native cost is unavailable. Tap to retry.</Text>
                  </Pressable>
                ) : effectivePositionCost ? (
                  <View style={styles.costSummary} testID="meteora-native-cost-estimate">
                    {effectivePositionCost.costs.map((cost) => (
                      <View key={cost.label} style={styles.costSummaryRow}>
                        <Text style={styles.costSummaryLabel}>{cost.label}{cost.refundable ? ' · refundable' : ''}</Text>
                        <Text style={styles.costSummaryValue}>{cost.value}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                {walletReady && nativeBalance?.key === nativeBalanceKey && nativeBalance.error ? (
                  <Pressable
                    onPress={() => setWalletBalanceNonce((value) => value + 1)}
                    accessibilityRole="button"
                    accessibilityLabel="Retry native SOL balance"
                  >
                    <Text style={styles.fieldErrorText}>Native SOL balance unavailable. Tap to retry.</Text>
                  </Pressable>
                ) : null}

                {insufficientX || insufficientY ? (
                  <InlineNotice
                    tone="info"
                    title={`Insufficient balance for ${[
                      insufficientX ? pool.tokenX.symbol : null,
                      insufficientY ? pool.tokenY.symbol : null,
                    ].filter(Boolean).join(' and ')}`}
                    message="Lower the amount or add tokens to your wallet to create this position."
                  />
                ) : autoFillActive && !positionDraft.amountX && !positionDraft.amountY ? (
                  <Text style={styles.selectionExplanation}>Enter either token amount to calculate the other.</Text>
                ) : null}
                {nativeCostInsufficient ? (
                  <InlineNotice tone="info" title="Insufficient native SOL for fees" message="This wallet needs enough native SOL for the displayed rent and maximum network fee." />
                ) : null}
              </View>

              <View style={styles.rangeSection}>
                <View style={styles.rangeHeading}>
                  <View style={styles.rangeTitleRow}>
                    <Text style={styles.rangeTitle}>Price Range</Text>
                    {!positionAddress ? (
                      <Pressable
                        onPress={resetRange}
                        disabled={executionBusy}
                        accessibilityRole="button"
                        accessibilityLabel="Reset price range"
                        accessibilityState={{ disabled: executionBusy }}
                        style={styles.rangeIconButton}
                      >
                        <MaterialIcons name="restart-alt" size={17} color={METEORA_COLORS.textDim} />
                      </Pressable>
                    ) : null}
                  </View>
                  <Pressable
                    onPress={() => { setPriceInverted((inverted) => !inverted); setPriceInputText({}); }}
                    accessibilityRole="button"
                    accessibilityLabel={`Invert price quote. Currently ${quoteLabel}`}
                    style={styles.quoteToggle}
                  >
                    <Text style={styles.quoteText}>{quoteLabel}</Text>
                    <MaterialIcons name="swap-horiz" size={16} color={METEORA_COLORS.textDim} />
                  </Pressable>
                </View>
                {!addModePosition ? (
                  <SegmentedControl
                    value={positionDraft.strategy}
                    onChange={(strategy) => updatePosition({ strategy })}
                    accessibilityLabel="Liquidity distribution strategy"
                    options={STRATEGIES}
                    disabled={executionBusy}
                  />
                ) : null}
                  <RangeVisualization
                  bars={liquidityDistribution.bars}
                  poolLiquidityBars={poolLiquidityBars}
                  poolLiquidityState={poolLiquidityState}
                  tokenMode={depositTokenMode}
                  priceInverted={priceInverted}
                  interactive={!positionAddress && !executionBusy}
                  minLabel={formatMeteoraRangePrice(chartMinPrice)}
                  maxLabel={formatMeteoraRangePrice(chartMaxPrice)}
                  currentLabel={formatMeteoraRangePrice(displayCurrentPrice)}
                  quoteLabel={quoteLabel}
                  tokenXSymbol={pool.tokenX.symbol}
                  tokenYSymbol={pool.tokenY.symbol}
                  leftTokenSymbol={priceInverted ? pool.tokenX.symbol : pool.tokenY.symbol}
                  rightTokenSymbol={priceInverted ? pool.tokenY.symbol : pool.tokenX.symbol}
                  leftColor={priceInverted ? METEORA_COLORS.primary : METEORA_COLORS.accent}
                  rightColor={priceInverted ? METEORA_COLORS.accent : METEORA_COLORS.primary}
                  minPercent={chartGeometry?.minPercent}
                  maxPercent={chartGeometry?.maxPercent}
                  currentPercent={chartGeometry?.currentPercent}
                  dragBinSpan={chartGeometry?.binSpan}
                  axisMinLabel={formatMeteoraRangePrice(axisMinPrice || null)}
                  axisMaxLabel={formatMeteoraRangePrice(axisMaxPrice || null)}
                  onAdjustMin={(delta) => adjustRangePrice('min', delta)}
                  onAdjustMax={(delta) => adjustRangePrice('max', delta)}
                  onShiftRange={shiftRange}
                />
                <Text style={styles.selectionExplanation} testID="meteora-live-bin-count">
                  {liveBinCount === null ? 'Calculating executable bins…' : `${liveBinCount} bins selected`}
                </Text>
                {poolLiquidityState === 'loading' ? (
                  <Text style={styles.selectionExplanation}>Loading real pool liquidity for these bins…</Text>
                ) : null}
                <Text style={styles.selectionExplanation} testID="meteora-distribution-source">
                  {sdkAllocationReady ? 'Live SDK strategy allocation' : 'Deposit distribution is an estimate until the SDK preview is ready.'}
                </Text>
                {poolLiquidityState === 'error' ? (
                  <Pressable
                    onPress={() => setPoolLiquidityNonce((value) => value + 1)}
                    accessibilityRole="button"
                    accessibilityLabel="Retry pool liquidity"
                  >
                    <Text style={styles.selectionExplanation}>Pool liquidity unavailable. Tap to retry.</Text>
                  </Pressable>
                ) : null}
                <View style={styles.priceFields}>
                  <PriceField
                    compact
                    label="Min Price"
                    value={priceInputText.min ?? displayMinPrice}
                    displayValue={formatMeteoraRangePrice(displayMinPrice)}
                    suffix={priceDeltaLabel(displayMinPrice, displayCurrentPrice)}
                    disabled={!!positionAddress || executionBusy}
                    error={touched.range ? localRangeError : null}
                    hideErrorMessage
                    onChangeText={(value) => changeRangePrice('min', value)}
                    onBlur={() => blurRangePrice('min')}
                    onStep={(direction) => adjustRangePrice('min', direction === 'increment' ? 1 : -1)}
                  />
                  <PriceField
                    compact
                    label="Max Price"
                    value={priceInputText.max ?? displayMaxPrice}
                    displayValue={formatMeteoraRangePrice(displayMaxPrice)}
                    suffix={priceDeltaLabel(displayMaxPrice, displayCurrentPrice)}
                    disabled={!!positionAddress || executionBusy}
                    error={touched.range ? localRangeError : null}
                    hideErrorMessage
                    onChangeText={(value) => changeRangePrice('max', value)}
                    onBlur={() => blurRangePrice('max')}
                    onStep={(direction) => adjustRangePrice('max', direction === 'increment' ? 1 : -1)}
                  />
                </View>
                {touched.range && localRangeError ? (
                  <Text style={styles.fieldErrorText} accessibilityRole="alert">{localRangeError}</Text>
                ) : null}
              </View>
            </>
          ) : (
            <LimitOrderForm
              pool={pool}
              draft={limitDraft}
              amountError={limitAmountError}
              priceError={limitPriceError}
              preview={preview}
              connected={walletReady}
              onChange={updateLimit}
              onTouch={markTouched}
            />
          )}

          {previewError ? (
            <InlineNotice tone="error" title={previewBlocker ?? 'Preview unavailable'} message={previewError} />
          ) : null}
          {preview?.warnings.filter((warning) => warning.blocking && !(
            warning.code === 'INSUFFICIENT_TOKEN_BALANCE' && (insufficientX || insufficientY)
          )).map((warning) => (
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
              <MaterialIcons name="open-in-new" size={16} color={METEORA_COLORS.accent} />
              <Text style={styles.explorerLinkText}>View transaction</Text>
            </Pressable>
          ) : null}

        </ScrollView>
      )}

      {!loading && !loadError && pool ? (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <Pressable
            onPress={handlePrimaryAction}
            disabled={footerDisabled}
            accessibilityRole="button"
            accessibilityLabel={footerLabel}
            accessibilityState={{
              disabled: footerDisabled,
              busy: footerBusy,
            }}
            style={({ pressed }) => [
              styles.cta,
              footerDisabled && styles.ctaDisabled,
              walletReady && operationState === 'success' && styles.ctaSuccess,
              walletReady && operationState === 'error' && styles.ctaError,
              pressed && !footerDisabled && styles.ctaPressed,
            ]}
          >
            {footerBusy ? (
              <ActivityIndicator size="small" color={ctaForeground} />
            ) : (
              <MaterialIcons
                name={
                  !walletReady
                    ? 'account-balance-wallet'
                    : operationState === 'success'
                    ? 'check-circle'
                    : operationState === 'error'
                      ? 'error-outline'
                      : 'arrow-forward'
                }
                size={19}
                color={ctaForeground}
              />
            )}
            <Text style={[styles.ctaText, { color: ctaForeground }]}>{footerLabel}</Text>
          </Pressable>
        </View>
      ) : null}

      <MeteoraPositionReviewSheet
        visible={!!review}
        pool={review?.pool ?? null}
        preview={review?.preview ?? null}
        strategy={review?.strategy ?? 'spot'}
        amountX={review?.amountX ?? ''}
        amountY={review?.amountY ?? ''}
        inverted={review?.inverted ?? false}
        addMode={review?.addMode ?? false}
        confirmDisabled={!reviewCurrent}
        blockerMessage={reviewBlocker}
        costs={review?.costs}
        transactionCount={review?.transactionCount}
        onClose={() => setReview(null)}
        onConfirm={handleConfirmReview}
      />

      <ConnectionSheet
        visible={connectSheet.visible}
        chain={connectSheet.chain}
        onClose={connectSheet.close}
      />
    </KeyboardAvoidingView>
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
          balance={connected ? spendableBalance ?? 'Checking…' : undefined}
          error={amountError}
          accent={draft.side === 'buy' ? METEORA_COLORS.tokenY : METEORA_COLORS.tokenX}
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

function LoadingPool() {
  return (
    <View style={styles.centerState}>
      <ActivityIndicator color={METEORA_COLORS.accent} />
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
      <MaterialIcons name="cloud-off" size={28} color={METEORA_COLORS.negative} />
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

function isBusyOperation(state: MeteoraOperationState): boolean {
  return ['building', 'simulating', 'awaiting_wallet', 'submitted', 'confirming', 'syncing', 'partial'].includes(state);
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
  const validation = validateMeteoraPositionDraft({ draft, tokenX: pool.tokenX, tokenY: pool.tokenY, addMode: true });
  if (!validation.valid) throw new Error(validation.amountXError ?? validation.amountYError ?? validation.blockerLabel ?? 'Fix position inputs');
  const hasX = isPositiveDecimal(draft.amountX);
  const hasY = isPositiveDecimal(draft.amountY);
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
    const balances = await adapter.getWalletBalances(pool, context.walletAddress);
    spendableBalanceX = balances.x ?? undefined;
    spendableBalanceY = balances.y ?? undefined;
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
    backgroundColor: METEORA_COLORS.surfaceRaised,
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
  scroll: { flex: 1 },
  fullWidthChart: {
    marginHorizontal: -16,
  },
  amountSection: {
    gap: 8,
    paddingTop: 8,
    paddingBottom: 12,
  },
  amountHeading: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  amountGroup: {
    gap: 12,
  },
  priceFields: { flexDirection: 'row', gap: 10 },
  selectionExplanation: {
    color: METEORA_COLORS.textDim,
    fontSize: 11,
    lineHeight: 16,
  },
  costSummary: {
    gap: 5,
    padding: 10,
    borderRadius: 10,
    backgroundColor: METEORA_COLORS.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: METEORA_COLORS.border,
  },
  costSummaryRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  costSummaryLabel: { flex: 1, color: METEORA_COLORS.textDim, fontSize: 11, lineHeight: 16 },
  costSummaryValue: { color: METEORA_COLORS.text, fontFamily: 'monospace', fontSize: 11, lineHeight: 16 },
  rangeSection: {
    gap: 8,
    paddingTop: 0,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: METEORA_COLORS.border,
  },
  rangeHeading: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  rangeTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rangeTitle: {
    color: METEORA_COLORS.text,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
  },
  rangeIconButton: {
    width: 36,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quoteToggle: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    flexShrink: 1,
  },
  quoteText: {
    color: METEORA_COLORS.textDim,
    fontSize: 11,
    lineHeight: 15,
    flexShrink: 1,
  },
  fieldErrorText: {
    color: METEORA_COLORS.negative,
    fontSize: 11,
    lineHeight: 15,
  },
  snapRows: {
    gap: 8,
    padding: 12,
    borderRadius: tokens.radius.md,
    backgroundColor: METEORA_COLORS.surface,
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
    color: METEORA_COLORS.accent,
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
    color: METEORA_COLORS.accent,
  },
  cta: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    borderRadius: tokens.radius.md,
    backgroundColor: METEORA_COLORS.accent,
  },
  ctaDisabled: {
    backgroundColor: METEORA_COLORS.surfaceLift,
    opacity: 0.72,
  },
  ctaSuccess: {
    backgroundColor: METEORA_COLORS.positive,
    opacity: 1,
  },
  ctaError: {
    backgroundColor: METEORA_COLORS.negative,
    opacity: 1,
  },
  ctaPressed: {
    transform: [{ scale: 0.992 }],
    opacity: 0.9,
  },
  ctaText: {
    color: METEORA_COLORS.onAccent,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '900',
  },
  footer: {
    paddingTop: 8,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: METEORA_COLORS.border,
    backgroundColor: METEORA_COLORS.screen,
  },
  limitPriceField: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: METEORA_COLORS.border,
    borderRadius: tokens.radius.md,
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
    color: METEORA_COLORS.accent,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '800',
  },
});
