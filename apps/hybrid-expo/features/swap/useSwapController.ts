import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { AppState, type AppStateStatus } from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { SpotDataApiClient } from '@myboon/shared/spot';
import {
  createSwapOrder,
  executeSwap,
  fetchTokenPrices,
  searchSwapTokens,
  SwapApiError,
} from '@/features/swap/swap.api';
import {
  formatAtomicAmount,
  isAtomicAmountAtLeast,
  parseSlippagePercentToBps,
  parseUiAmountToAtomic,
} from '@/features/swap/swap.math';
import {
  createSwapPendingStore,
  isPendingSwapExpired,
  shouldDiscardExpiredPendingSwap,
} from '@/features/swap/swap.pending';
import {
  finalizeWalletSignedSwapTransaction,
  simulateValidatedSwap,
  validateSwapTransactionForSigning,
} from '@/features/swap/swap-transaction-validation';
import type { SwapControllerDependencies } from '@/features/swap/swap.controller.dependencies';
import type {
  PendingSwapExecution,
  SwapEntryMode,
  SwapExecutionPhase,
  SwapOrderResponse,
  SwapSide,
  SwapToken,
} from '@/features/swap/swap.types';
import {
  createSwapSession,
  endSwapSession,
  invalidatePreparedSession,
} from '@/features/swap/swap.controller.core';
import { useWalletSheet } from '@/features/wallet/WalletSheetProvider';
import { notifyWalletDataChanged } from '@/features/wallet/wallet.refresh';
import { SOLANA_RPC, SOLANA_RPC_WS } from '@/features/perps/pacific.config';
import { useWallet } from '@/hooks/useWallet';
import { resolveApiBaseUrl } from '@/lib/api';

export const SOL: SwapToken = {
  address: 'So11111111111111111111111111111111111111112',
  symbol: 'SOL',
  name: 'Solana',
  decimals: 9,
  logoURI: `${resolveApiBaseUrl()}/tokens/icon/sol`,
};
export const USDC: SwapToken = {
  address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: `${resolveApiBaseUrl()}/tokens/icon/usdc`,
};
export const SOL_FEE_RESERVE_LAMPORTS = 5_000_000n;
const pendingStore = createSwapPendingStore({
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
});
const activeIntents = new Set<string>();

export type SlippageMode = 'auto' | 'fixed' | 'custom';

export function modeFrom(value: string | string[] | undefined): SwapEntryMode {
  const item = Array.isArray(value) ? value[0] : value;
  return item === 'buy' || item === 'sell' ? item : 'swap';
}

export function errorMessage(error: unknown): string {
  if (error instanceof SwapApiError)
    return error.code === 'ORDER_PROVIDER_INVALID'
      ? 'The quote changed while preparing your trade. Refresh and try again.'
      : error.message;
  return error instanceof Error ? error.message : 'The trade could not be completed.';
}

export function sumAtomicStrings(...values: (string | null)[]): string {
  return values.reduce<bigint>((total, value) => total + BigInt(value ?? '0'), 0n).toString();
}
export function maximumReviewedInput(
  order: Extract<SwapOrderResponse, { kind: 'signable' }>,
): string {
  return sumAtomicStrings(
    order.inAmountAtomic,
    order.fees.providerFeeMint === order.inputMint ? order.fees.providerFeeAtomic : null,
  );
}
export function maximumReviewedNetworkCost(
  order: Extract<SwapOrderResponse, { kind: 'signable' }>,
): string {
  return sumAtomicStrings(
    order.fees.signatureFeeLamports,
    order.fees.priorityFeeLamports,
    order.fees.rentFeeLamports,
  );
}

async function reconcileSubmittedSignature(
  connection: Pick<Connection, 'getSignatureStatuses'>,
  signature: string,
  timeoutMs = 20_000,
): Promise<'confirmed' | 'failed' | 'unknown'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = (
        await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
      ).value[0];
      if (status?.err) return 'failed';
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized')
        return 'confirmed';
    } catch {
      return 'unknown';
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
  }
  return 'unknown';
}

export interface SwapControllerOptions {
  mode?: SwapEntryMode;
  active?: boolean;
  requestedMint?: string;
  /** Explicit disposable seams used only by the native verification fixture. */
  controllerOptions?: SwapControllerDependencies;
}

export interface SwapController {
  mode: SwapEntryMode;
  wallet: ReturnType<typeof useWallet>;
  inputToken: SwapToken;
  outputToken: SwapToken;
  selectedToken: SwapToken | null;
  amount: string;
  phase: SwapExecutionPhase;
  pickerSide: SwapSide;
  tokenQuery: string;
  tokenResults: SwapToken[];
  tokenLoading: boolean;
  tokenError: string | null;
  balances: Record<string, string>;
  balancesResolved: boolean;
  balancesError: string | null;
  pendingReady: boolean;
  pendingError: string | null;
  prices: Record<string, number | null>;
  quote: SwapOrderResponse | null;
  quoteExpired: boolean;
  quoteError: string | null;
  reviewOrder: Extract<SwapOrderResponse, { kind: 'signable' }> | null;
  simulationWarning: string | null;
  simulationWarningAccepted: boolean;
  slippageMode: SlippageMode;
  customSlippage: string;
  customSlippageError: string | null;
  slippageBps: number | undefined;
  extremeConfirmation: string;
  failure: string | null;
  unknownRequestId: string | null;
  resultMessage: string | null;
  amountAtomic: string | null;
  inputUsd: number | null;
  outputUi: string;
  outputUsd: number | null;
  balanceError: string | null;
  receiveAtLeast: string;
  inputBalanceAtomic?: string;
  outputBalanceAtomic?: string;
  isDangerousSlippage: boolean;
  isExtremeSlippage: boolean;
  interactionBusy: boolean;
  tradeInteractionBusy: boolean;
  prepareReview: () => Promise<void>;
  confirmTrade: () => Promise<void>;
  invalidatePreparedTrade: () => boolean;
  setManualAmount: (value: string) => void;
  openPicker: (side: SwapSide) => void;
  selectToken: (token: SwapToken) => void;
  cancelPicker: () => void;
  setTokenQuery: (value: string) => void;
  reversePair: () => void;
  retry: () => void;
  retryBalances: () => Promise<void>;
  setSlippageMode: (mode: SlippageMode) => void;
  setCustomSlippage: (value: string) => void;
  setExtremeConfirmation: (value: string) => void;
  setSimulationWarningAccepted: (value: boolean) => void;
  balancePercent: (percent: number) => void;
  setBalancePercent: (percent: number) => void;
  reconcilePending: () => Promise<void>;
}

export function useSwapController({
  mode = 'swap',
  active = true,
  requestedMint,
  controllerOptions,
}: SwapControllerOptions = {}): SwapController {
  // Call the real hooks on every render so hook ordering and production context
  // behavior remain unchanged. The fixture may then replace their returned
  // values with an explicitly supplied, disposable context.
  const runtimeWallet = useWallet();
  const runtimeWalletSheet = useWalletSheet();
  const wallet = controllerOptions?.wallet ?? runtimeWallet;
  const walletSheet = controllerOptions?.walletSheet ?? runtimeWalletSheet;
  const rpc = useMemo(
    () => controllerOptions?.rpc ?? wallet.connection ?? new Connection(SOLANA_RPC, {
      commitment: 'confirmed',
      wsEndpoint: SOLANA_RPC_WS,
    }),
    [controllerOptions?.rpc, wallet.connection],
  );
  const spotClient = useMemo(() => new SpotDataApiClient({ apiBaseUrl: resolveApiBaseUrl() }), []);
  const getWalletBalances = controllerOptions?.getWalletBalances;
  const swapPendingStore = controllerOptions?.pendingStore ?? pendingStore;
  const requestSwapOrder = controllerOptions?.createSwapOrder ?? createSwapOrder;
  const requestExecuteSwap = controllerOptions?.executeSwap ?? executeSwap;
  const requestSearchTokens = controllerOptions?.searchSwapTokens ?? searchSwapTokens;
  const requestTokenPrices = controllerOptions?.fetchTokenPrices ?? fetchTokenPrices;
  const requestValidateTransaction =
    controllerOptions?.validateSwapTransactionForSigning ?? validateSwapTransactionForSigning;
  const requestSimulateTransaction =
    controllerOptions?.simulateValidatedSwap ?? simulateValidatedSwap;
  const requestFinalizeTransaction =
    controllerOptions?.finalizeWalletSignedSwapTransaction ??
    finalizeWalletSignedSwapTransaction;
  const refreshWalletData = controllerOptions?.notifyWalletDataChanged ?? notifyWalletDataChanged;
  const notifySuccess = useMemo(
    () =>
      controllerOptions?.notifySuccess ??
      (() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
    [controllerOptions?.notifySuccess],
  );
  const [selectedToken, setSelectedToken] = useState<SwapToken | null>(null);
  const [inputToken, setInputToken] = useState<SwapToken>(SOL);
  const [outputToken, setOutputToken] = useState<SwapToken>(USDC);
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<SwapExecutionPhase>('compose');
  const [pickerSide, setPickerSide] = useState<SwapSide>('input');
  const [tokenQuery, setTokenQueryState] = useState('');
  const [tokenResults, setTokenResults] = useState<SwapToken[]>([]);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [balancesResolved, setBalancesResolved] = useState(false);
  const [balancesError, setBalancesError] = useState<string | null>(null);
  const [pendingReady, setPendingReady] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const [quote, setQuote] = useState<SwapOrderResponse | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteRefreshKey, setQuoteRefreshKey] = useState(0);
  const [reviewOrder, setReviewOrder] = useState<Extract<
    SwapOrderResponse,
    { kind: 'signable' }
  > | null>(null);
  const [simulationWarning, setSimulationWarning] = useState<string | null>(null);
  const [simulationWarningAccepted, setSimulationWarningAccepted] = useState(false);
  const [slippageMode, setSlippageModeState] = useState<SlippageMode>('auto');
  const [customSlippage, setCustomSlippageState] = useState('0.5');
  const [extremeConfirmation, setExtremeConfirmationState] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [, setTerminalSignature] = useState<string | null>(null);
  const [unknownRequestId, setUnknownRequestId] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const preparingReviewRef = useRef(false);
  const preparationSequenceRef = useRef(0);
  const sessionRef = useRef(createSwapSession());
  const preparedWalletRef = useRef<{ address: string; sessionKey?: string } | null>(null);
  const reviewOrderRef = useRef<Extract<SwapOrderResponse, { kind: 'signable' }> | null>(null);
  const draftRef = useRef({
    inputMint: inputToken.address,
    outputMint: outputToken.address,
    amount,
    inputDecimals: inputToken.decimals,
  });
  const pendingReadyRef = useRef(pendingReady);
  const pendingErrorRef = useRef(pendingError);
  const quoteSequence = useRef(0);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  const phaseRef = useRef(phase);
  const tradeBusyRef = useRef(false);
  const balanceRequestRef = useRef(0);
  const pendingSequenceRef = useRef(0);
  const walletAddressRef = useRef(wallet.address);
  const walletSessionRef = useRef(wallet.sessionKey);
  const previousModeRef = useRef(mode);
  const previousRequestedMintRef = useRef(requestedMint);
  const previousContextRef = useRef(
    `${mode}:${requestedMint ?? ''}:${wallet.sessionKey ?? wallet.address ?? 'disconnected'}`,
  );

  const customSlippageState = useMemo(() => {
    if (slippageMode !== 'custom') return { value: undefined, error: null as string | null };
    try {
      return { value: parseSlippagePercentToBps(customSlippage), error: null as string | null };
    } catch (error) {
      return { value: undefined, error: errorMessage(error) };
    }
  }, [customSlippage, slippageMode]);
  const slippageBps =
    slippageMode === 'auto' ? undefined : slippageMode === 'fixed' ? 50 : customSlippageState.value;
  const explicitSlippageBps = slippageBps ?? 0;
  const isDangerousSlippage = explicitSlippageBps > 500;
  const isExtremeSlippage = explicitSlippageBps > 1500;
  activeRef.current = active;
  walletAddressRef.current = wallet.address;
  walletSessionRef.current = wallet.sessionKey;
  phaseRef.current = phase;
  reviewOrderRef.current = reviewOrder;
  draftRef.current = {
    inputMint: inputToken.address,
    outputMint: outputToken.address,
    amount,
    inputDecimals: inputToken.decimals,
  };
  pendingReadyRef.current = pendingReady;
  pendingErrorRef.current = pendingError;
  tradeBusyRef.current =
    phase === 'ordering' ||
    phase === 'validating' ||
    phase === 'simulating' ||
    phase === 'awaiting_signature' ||
    phase === 'executing' ||
    phase === 'unknown';
  const tradeInteractionBusy = useCallback(() => tradeBusyRef.current, []);

  const clearPrepared = useCallback(
    (nextPhase?: SwapExecutionPhase, forceBoundary = false, preserveSubmittedRecovery = false) => {
      if (!forceBoundary && (tradeInteractionBusy() || preparingReviewRef.current)) return false;
      preparationSequenceRef.current += 1;
      sessionRef.current = invalidatePreparedSession(sessionRef.current);
      preparedWalletRef.current = null;
      if (forceBoundary) {
        setSimulationWarning(null);
        setSimulationWarningAccepted(false);
      }
      if (forceBoundary && !preserveSubmittedRecovery && phaseRef.current === 'unknown') {
        phaseRef.current = 'compose';
        tradeBusyRef.current = false;
        setReviewOrder(null);
        setUnknownRequestId(null);
        setFailure(null);
        setResultMessage(null);
        setPhase('compose');
        return true;
      }
      if (
        forceBoundary &&
        (phaseRef.current === 'ordering' ||
          phaseRef.current === 'validating' ||
          phaseRef.current === 'simulating' ||
          phaseRef.current === 'awaiting_signature')
      ) {
        preparingReviewRef.current = false;
        phaseRef.current = 'compose';
        tradeBusyRef.current = false;
        setReviewOrder(null);
        setPhase('compose');
        return false;
      }
      if (forceBoundary && phaseRef.current === 'executing') {
        if (preserveSubmittedRecovery) {
          phaseRef.current = 'unknown';
          tradeBusyRef.current = true;
          setPendingReady(false);
          setPhase('unknown');
        } else {
          // A wallet/session transition belongs to the new context. Keep the
          // submitted record durable for reconciliation, but never surface the
          // old wallet's busy/unknown phase in the new wallet's composer.
          phaseRef.current = 'compose';
          tradeBusyRef.current = false;
          setPendingReady(false);
          setReviewOrder(null);
          setPhase('compose');
        }
        return false;
      }
      if (tradeInteractionBusy() || preparingReviewRef.current) return false;
      setReviewOrder(null);
      setSimulationWarning(null);
      setSimulationWarningAccepted(false);
      setFailure(null);
      setTerminalSignature(null);
      setUnknownRequestId(null);
      setResultMessage(null);
      if (nextPhase && phase !== 'picker') setPhase(nextPhase);
      return true;
    },
    [phase, tradeInteractionBusy],
  );

  const loadBalances = useCallback(
    async (force = false) => {
      const request = ++balanceRequestRef.current;
      const address = wallet.address;
      const sessionKey = wallet.sessionKey;
      if (!wallet.connected || !address) {
        setBalances({});
        setBalancesResolved(false);
        setBalancesError(null);
        return null;
      }
      if (force) spotClient.clearCache();
      try {
        const next = getWalletBalances
          ? await getWalletBalances(address)
          : Object.fromEntries(
              (await spotClient.getWalletBalances(address)).data.tokens.map((token) => [
                token.mint,
                token.amount,
              ]),
            );
        if (
          mountedRef.current &&
          activeRef.current &&
          request === balanceRequestRef.current &&
          walletAddressRef.current === address &&
          walletSessionRef.current === sessionKey
        ) {
          setBalances(next);
          setBalancesResolved(true);
          setBalancesError(null);
        }
        if (
          request !== balanceRequestRef.current ||
          walletAddressRef.current !== address ||
          walletSessionRef.current !== sessionKey
        )
          return null;
        return next;
      } catch (error) {
        if (
          mountedRef.current &&
          request === balanceRequestRef.current &&
          walletAddressRef.current === address &&
          walletSessionRef.current === sessionKey
        ) {
          setBalances({});
          setBalancesResolved(false);
          setBalancesError(errorMessage(error));
        }
        throw error;
      }
    },
    [getWalletBalances, spotClient, wallet.address, wallet.connected, wallet.sessionKey],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      quoteSequence.current += 1;
      balanceRequestRef.current += 1;
      pendingSequenceRef.current += 1;
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    setBalancesResolved(false);
    setBalancesError(null);
    void loadBalances().catch(() => null);
  }, [active, loadBalances]);
  useEffect(() => {
    if (!active) return;
    if (!requestedMint || (requestedMint === SOL.address && mode !== 'swap')) {
      setSelectedToken(requestedMint === SOL.address ? SOL : null);
      return;
    }
    let cancelled = false;
    void requestSearchTokens(requestedMint)
      .then((found) => {
        if (!cancelled)
          setSelectedToken(found.find((token) => token.address === requestedMint) ?? null);
      })
      .catch((error) => {
        if (!cancelled) setFailure(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [active, mode, requestedMint, requestSearchTokens]);
  useEffect(() => {
    if (!selectedToken) return;
    if (mode === 'buy') {
      setInputToken(SOL);
      setOutputToken(selectedToken);
    } else if (mode === 'sell') {
      setInputToken(selectedToken);
      setOutputToken(SOL);
    }
  }, [mode, selectedToken]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void requestTokenPrices([inputToken.address, outputToken.address])
      .then((response) => {
        if (!cancelled)
          setPrices(
            Object.fromEntries(response.prices.map((price) => [price.mint, price.usdPrice])),
          );
      })
      .catch(() => {
        if (!cancelled) setPrices({});
      });
    return () => {
      cancelled = true;
    };
  }, [active, inputToken.address, outputToken.address, requestTokenPrices]);
  useEffect(() => {
    if (!active || phase !== 'compose') return;
    const sequence = ++quoteSequence.current;
    if (customSlippageState.error) {
      setQuote(null);
      setQuoteError(customSlippageState.error);
      return;
    }
    let amountAtomic: string;
    try {
      amountAtomic = parseUiAmountToAtomic(amount, inputToken.decimals);
    } catch {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    if (inputToken.address === outputToken.address) {
      setQuote(null);
      setQuoteError('Choose two different assets.');
      return;
    }
    setQuote(null);
    setQuoteError(null);
    setFailure(null);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void requestSwapOrder(
        {
          inputMint: inputToken.address,
          outputMint: outputToken.address,
          amountAtomic,
          ...(slippageBps === undefined ? {} : { slippageBps }),
        },
        controller.signal,
      )
        .then((nextQuote) => {
          if (sequence === quoteSequence.current && mountedRef.current) setQuote(nextQuote);
        })
        .catch((error) => {
          if (controller.signal.aborted || sequence !== quoteSequence.current) return;
          setQuote(null);
          setQuoteError(
            error instanceof SwapApiError &&
              (error.code === 'UPSTREAM_RATE_LIMITED' || error.code === 'RATE_LIMITED')
              ? 'Price is refreshing. Try again in a moment.'
              : error instanceof SwapApiError && error.code === 'TRADING_PAUSED'
                ? 'Trading is temporarily paused.'
                : errorMessage(error),
          );
        });
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    active,
    amount,
    customSlippageState.error,
    inputToken.address,
    inputToken.decimals,
    outputToken.address,
    phase,
    quoteRefreshKey,
    requestSwapOrder,
    slippageBps,
  ]);

  const quoteExpired = !!quote?.expiresAt && Date.parse(quote.expiresAt) <= clock;
  useEffect(() => {
    if (!quote?.expiresAt) return;
    const remaining = Date.parse(quote.expiresAt) - Date.now();
    if (remaining <= 0) {
      setClock(Date.now());
      return;
    }
    const timer = setTimeout(() => setClock(Date.now()), remaining + 1);
    return () => clearTimeout(timer);
  }, [quote?.expiresAt]);
  useEffect(() => {
    if (!quoteExpired) return;
    if (reviewOrder && phase === 'reviewing') {
      preparationSequenceRef.current += 1;
      sessionRef.current = invalidatePreparedSession(sessionRef.current);
      setReviewOrder(null);
      setSimulationWarning(null);
      setSimulationWarningAccepted(false);
      setFailure('This quote expired. Refresh it before continuing.');
      setPhase('failed');
    }
    setQuote(null);
    setQuoteError('Price expired — refresh and try again.');
  }, [phase, quoteExpired, reviewOrder]);

  const reconcilePending = useCallback(async () => {
    const sequence = ++pendingSequenceRef.current;
    const address = wallet.address;
    const sessionKey = wallet.sessionKey;
    setPendingError(null);
    if (!active || !address) {
      setPendingReady(true);
      return;
    }
    if (tradeBusyRef.current && phaseRef.current !== 'unknown') return;
    setPendingReady(false);
    const isCurrent = () =>
      sequence === pendingSequenceRef.current &&
      activeRef.current &&
      walletAddressRef.current === address &&
      walletSessionRef.current === sessionKey &&
      mountedRef.current;
    try {
      const pending = await swapPendingStore.list(address);
      if (!isCurrent()) return;
      const currentBlockHeight = await rpc.getBlockHeight('confirmed').catch(() => null);
      if (!isCurrent()) return;
      for (const item of pending) {
        if (!isCurrent()) return;
        const expired =
          currentBlockHeight !== null && isPendingSwapExpired(item, currentBlockHeight);
        if (!item.signature) {
          if (expired) {
            await swapPendingStore.remove(item.requestId);
            continue;
          }
          setUnknownRequestId(item.requestId);
          setResultMessage(
            'A previous swap may have been submitted. Do not submit it again while its status is unknown.',
          );
          setPendingReady(false);
          setPhase('unknown');
          return;
        }
        try {
          const status = (
            await rpc.getSignatureStatuses([item.signature], { searchTransactionHistory: true })
          ).value[0];
          if (!isCurrent()) return;
          if (status?.err) {
            await swapPendingStore.remove(item.requestId);
            if (!isCurrent()) return;
            setPendingReady(true);
            setTerminalSignature(item.signature);
            setFailure('The previous swap failed on Solana.');
            setResultMessage(
              'The previous swap failed on Solana. Review a fresh quote before trying again.',
            );
            setPhase('failed');
            return;
          }
          if (
            status?.confirmationStatus === 'confirmed' ||
            status?.confirmationStatus === 'finalized'
          ) {
            await swapPendingStore.remove(item.requestId);
            if (!isCurrent()) return;
            spotClient.clearCache();
            const refreshed = await loadBalances(true)
              .then((next) => next !== null)
              .catch(() => false);
            if (!isCurrent()) return;
            refreshWalletData();
            setPendingReady(true);
            setTerminalSignature(item.signature);
            setResultMessage(
              refreshed
                ? 'The previous swap is confirmed. Balances have been refreshed.'
                : 'The previous swap is confirmed. Refresh Wallet to update balances.',
            );
            setPhase('confirmed');
            return;
          }
          if (shouldDiscardExpiredPendingSwap(item, currentBlockHeight, status !== null)) {
            await swapPendingStore.remove(item.requestId);
            continue;
          }
          setPendingReady(false);
          setUnknownRequestId(item.requestId);
          setTerminalSignature(item.signature);
          setResultMessage('A previous swap is still being reconciled. Do not submit it again.');
          setPhase('unknown');
          return;
        } catch {
          if (!isCurrent()) return;
          setPendingReady(false);
          setUnknownRequestId(item.requestId);
          setTerminalSignature(item.signature);
          setResultMessage('A previous swap still needs a status check. Do not submit it again.');
          setPhase('unknown');
          return;
        }
      }
      if (isCurrent()) {
        setPendingReady(true);
        if (phaseRef.current === 'unknown') setPhase('compose');
      }
    } catch (error) {
      if (isCurrent()) {
        setPendingReady(false);
        setPendingError(errorMessage(error));
      }
    }
  }, [
    active,
    loadBalances,
    refreshWalletData,
    rpc,
    spotClient,
    swapPendingStore,
    wallet.address,
    wallet.sessionKey,
  ]);
  useEffect(() => {
    void reconcilePending().catch((error) => {
      if (activeRef.current) {
        setPendingReady(false);
        setPendingError(errorMessage(error));
      }
    });
  }, [reconcilePending]);
  useEffect(() => {
    if (!active) return;
    const listener = (next: AppStateStatus) => {
      if (next === 'active')
        void reconcilePending().catch((error) => {
          if (activeRef.current) {
            setPendingReady(false);
            setPendingError(errorMessage(error));
          }
        });
    };
    const subscription = AppState.addEventListener('change', listener);
    return () => subscription.remove();
  }, [active, reconcilePending]);

  useEffect(() => {
    const context = `${mode}:${requestedMint ?? ''}:${wallet.sessionKey ?? wallet.address ?? 'disconnected'}`;
    if (context === previousContextRef.current) return;
    previousContextRef.current = context;
    const modeChanged = previousModeRef.current !== mode;
    previousModeRef.current = mode;
    const requestedMintChanged = previousRequestedMintRef.current !== requestedMint;
    previousRequestedMintRef.current = requestedMint;
    sessionRef.current = endSwapSession(sessionRef.current);
    setSlippageModeState('auto');
    setCustomSlippageState('0.5');
    setExtremeConfirmationState('');
    setPendingReady(false);
    setPendingError(null);
    if (modeChanged || requestedMintChanged) setAmount('');
    quoteSequence.current += 1;
    clearPrepared('compose', true, false);
    if (active) {
      void reconcilePending().catch((error) => {
        if (activeRef.current) {
          setPendingReady(false);
          setPendingError(errorMessage(error));
        }
      });
    }
  }, [
    active,
    clearPrepared,
    mode,
    reconcilePending,
    requestedMint,
    wallet.address,
    wallet.sessionKey,
  ]);
  useEffect(() => {
    if (active) return;
    sessionRef.current = endSwapSession(sessionRef.current);
    setSlippageModeState('auto');
    setCustomSlippageState('0.5');
    setExtremeConfirmationState('');
    quoteSequence.current += 1;
    clearPrepared('compose', true, true);
  }, [active, clearPrepared]);

  const prepareReview = useCallback(async () => {
    if (!active) return;
    if (!wallet.connected || !wallet.address) {
      walletSheet.open('solana');
      return;
    }
    if (!pendingReady || phaseRef.current === 'unknown' || tradeBusyRef.current) return;
    if (preparingReviewRef.current || tradeInteractionBusy()) return;
    preparingReviewRef.current = true;
    const preparationSequence = ++preparationSequenceRef.current;
    const preparationWalletAddress = wallet.address;
    const preparationWalletSession = wallet.sessionKey;
    const isCurrentPreparation = () =>
      preparationSequence === preparationSequenceRef.current &&
      activeRef.current &&
      mountedRef.current &&
      walletAddressRef.current === preparationWalletAddress &&
      walletSessionRef.current === preparationWalletSession;
    const movePreparationPhase = (next: SwapExecutionPhase) => {
      phaseRef.current = next;
      tradeBusyRef.current =
        next === 'ordering' ||
        next === 'validating' ||
        next === 'simulating' ||
        next === 'awaiting_signature' ||
        next === 'executing' ||
        next === 'unknown';
      setPhase(next);
    };
    setFailure(null);
    setTerminalSignature(null);
    setUnknownRequestId(null);
    setResultMessage(null);
    setReviewOrder(null);
    setSimulationWarning(null);
    setSimulationWarningAccepted(false);
    try {
      if (quoteExpired) throw new Error('This quote expired. Refresh it before continuing.');
      if (customSlippageState.error) throw new Error(customSlippageState.error);
      const amountAtomic = parseUiAmountToAtomic(amount, inputToken.decimals);
      if (isExtremeSlippage && extremeConfirmation.trim().toUpperCase() !== 'CONFIRM')
        throw new Error('Type CONFIRM to use slippage above 15%.');
      movePreparationPhase('ordering');
      const latestBalances = await loadBalances(true);
      const latestBalance = latestBalances?.[inputToken.address];
      if (!isCurrentPreparation()) return;
      if (!isAtomicAmountAtLeast(latestBalance, amountAtomic))
        throw new Error(`Your ${inputToken.symbol} balance is lower than this amount.`);
      if (
        inputToken.address === SOL.address &&
        BigInt(latestBalance ?? '0') - BigInt(amountAtomic) < SOL_FEE_RESERVE_LAMPORTS
      )
        throw new Error('Keep at least 0.005 SOL for network and account-creation costs.');
      const order = await requestSwapOrder({
        inputMint: inputToken.address,
        outputMint: outputToken.address,
        amountAtomic,
        taker: wallet.address,
        ...(slippageBps === undefined ? {} : { slippageBps }),
      });
      if (!isCurrentPreparation()) return;
      if (order.kind !== 'signable')
        throw new Error('The server did not return a signable transaction.');
      setQuote(order);
      movePreparationPhase('validating');
      const validated = await requestValidateTransaction({
        transactionBase64: order.transaction,
        walletAddress: wallet.address,
        inputMint: order.inputMint,
        outputMint: order.outputMint,
        inAmountAtomic: order.inAmountAtomic,
        minimumOutAmountAtomic: order.minimumOutAmountAtomic,
        maximumNetworkCostLamports: maximumReviewedNetworkCost(order),
        connection: rpc,
      });
      if (!isCurrentPreparation()) return;
      movePreparationPhase('simulating');
      const simulation = await requestSimulateTransaction({
        transaction: validated.transaction,
        connection: rpc,
        walletAddress: wallet.address,
        inputMint: order.inputMint,
        outputMint: order.outputMint,
        inputAmountAtomic: order.inAmountAtomic,
        maximumInputAmountAtomic: maximumReviewedInput(order),
        maximumNetworkCostLamports: maximumReviewedNetworkCost(order),
        minimumOutAmountAtomic: order.minimumOutAmountAtomic,
        inputDecimals: inputToken.decimals,
        outputDecimals: outputToken.decimals,
      });
      if (!isCurrentPreparation()) return;
      setSimulationWarning(simulation.unavailableWarning ?? null);
      sessionRef.current = { ...sessionRef.current, preparedRequestId: order.requestId };
      preparedWalletRef.current = {
        address: preparationWalletAddress,
        sessionKey: preparationWalletSession,
      };
      setReviewOrder(order);
      movePreparationPhase('reviewing');
    } catch (error) {
      if (isCurrentPreparation()) {
        setFailure(errorMessage(error));
        movePreparationPhase('failed');
      }
    } finally {
      if (preparationSequence === preparationSequenceRef.current)
        preparingReviewRef.current = false;
      if (
        preparationSequence === preparationSequenceRef.current &&
        mountedRef.current &&
        (phaseRef.current === 'ordering' ||
          phaseRef.current === 'validating' ||
          phaseRef.current === 'simulating')
      )
        movePreparationPhase('compose');
    }
  }, [
    active,
    amount,
    customSlippageState.error,
    extremeConfirmation,
    inputToken.address,
    inputToken.decimals,
    inputToken.symbol,
    isExtremeSlippage,
    loadBalances,
    outputToken.address,
    outputToken.decimals,
    pendingReady,
    quoteExpired,
    requestSimulateTransaction,
    requestSwapOrder,
    requestValidateTransaction,
    rpc,
    slippageBps,
    tradeInteractionBusy,
    wallet.address,
    wallet.connected,
    wallet.sessionKey,
    walletSheet,
  ]);

  const acknowledgeSimulationWarning = useCallback((value: boolean) => {
    sessionRef.current = { ...sessionRef.current, simulationWarningAccepted: value };
    setSimulationWarningAccepted(value);
  }, []);

  const confirmTrade = useCallback(async () => {
    if (!activeRef.current || phaseRef.current !== 'reviewing') return;
    if (!pendingReadyRef.current || pendingErrorRef.current) return;
    const currentDraft = draftRef.current;
    let currentAmountAtomic: string | null = null;
    try {
      currentAmountAtomic = parseUiAmountToAtomic(currentDraft.amount, currentDraft.inputDecimals);
    } catch {
      currentAmountAtomic = null;
    }
    if (
      !reviewOrder ||
      reviewOrderRef.current !== reviewOrder ||
      sessionRef.current.preparedRequestId !== reviewOrder.requestId
    )
      return;
    if (
      !wallet.address ||
      reviewOrder.taker !== wallet.address ||
      !wallet.signTransaction
    ) {
      setFailure('The active Solana wallet cannot sign this transaction.');
      setPhase('failed');
      return;
    }
    const preparedWallet = preparedWalletRef.current;
    const reviewMatchesDraft =
      reviewOrder.inputMint === currentDraft.inputMint &&
      reviewOrder.outputMint === currentDraft.outputMint &&
      reviewOrder.inAmountAtomic === currentAmountAtomic;
    const reviewMatchesWallet =
      !!wallet.address &&
      wallet.address === walletAddressRef.current &&
      wallet.sessionKey === walletSessionRef.current &&
      preparedWallet?.address === wallet.address &&
      preparedWallet.sessionKey === wallet.sessionKey;
    if (!reviewMatchesDraft || !reviewMatchesWallet) {
      clearPrepared('compose');
      return;
    }
    if (simulationWarning && !simulationWarningAccepted) {
      acknowledgeSimulationWarning(true);
      return;
    }
    const intentId = `${wallet.address}:${reviewOrder.requestId}`;
    if (activeIntents.has(intentId)) return;
    activeIntents.add(intentId);
    const executionWalletAddress = wallet.address;
    const executionWalletSession = wallet.sessionKey;
    const executionRequestId = reviewOrder.requestId;
    const isCurrentExecution = () =>
      mountedRef.current &&
      activeRef.current &&
      phaseRef.current !== 'unknown' &&
      walletAddressRef.current === executionWalletAddress &&
      walletSessionRef.current === executionWalletSession &&
      sessionRef.current.preparedRequestId === executionRequestId;
    phaseRef.current = 'awaiting_signature';
    tradeBusyRef.current = true;
    const now = new Date().toISOString();
    const pending: PendingSwapExecution = {
      version: 1,
      requestId: reviewOrder.requestId,
      walletAddress: wallet.address,
      inputMint: reviewOrder.inputMint,
      outputMint: reviewOrder.outputMint,
      inAmountAtomic: reviewOrder.inAmountAtomic,
      minimumOutAmountAtomic: reviewOrder.minimumOutAmountAtomic,
      signature: null,
      lastValidBlockHeight: reviewOrder.lastValidBlockHeight,
      outcome: 'submitted',
      createdAt: now,
      updatedAt: now,
    };
    let executionStarted = false;
    let submittedPending = pending;
    try {
      setFailure(null);
      if (reviewOrder.expiresAt && Date.parse(reviewOrder.expiresAt) <= Date.now())
        throw new Error('This quote expired. Refresh it before opening your wallet.');
      setPhase('awaiting_signature');
      const currentBlockHeight = await rpc.getBlockHeight('confirmed');
      if (!isCurrentExecution()) return;
      if (BigInt(currentBlockHeight) + 10n >= BigInt(reviewOrder.lastValidBlockHeight))
        throw new Error(
          'This transaction is too close to expiry. Refresh the quote before signing.',
        );
      const unsigned = VersionedTransaction.deserialize(
        Buffer.from(reviewOrder.transaction, 'base64'),
      );
      const signTransaction = wallet.signTransaction as (
        transaction: VersionedTransaction,
      ) => Promise<VersionedTransaction>;
      const walletSigned = await signTransaction(unsigned);
      if (!isCurrentExecution()) return;
      phaseRef.current = 'validating';
      tradeBusyRef.current = true;
      setPhase('validating');
      const signed = await requestFinalizeTransaction({
        reviewedTransactionBase64: reviewOrder.transaction,
        signedTransaction: walletSigned,
        walletAddress: executionWalletAddress,
        inputMint: reviewOrder.inputMint,
        outputMint: reviewOrder.outputMint,
        inputAmountAtomic: reviewOrder.inAmountAtomic,
        maximumInputAmountAtomic: maximumReviewedInput(reviewOrder),
        maximumNetworkCostLamports: maximumReviewedNetworkCost(reviewOrder),
        minimumOutAmountAtomic: reviewOrder.minimumOutAmountAtomic,
        connection: rpc,
      });
      if (!isCurrentExecution()) return;
      const localSignature = bs58.encode(signed.signatures[0]);
      const signedBase64 = Buffer.from(signed.serialize()).toString('base64');
      submittedPending = {
        ...pending,
        signature: localSignature,
        updatedAt: new Date().toISOString(),
      };
      await swapPendingStore.save(submittedPending);
      if (!isCurrentExecution()) {
        if (!executionStarted) await swapPendingStore.remove(reviewOrder.requestId).catch(() => null);
        return;
      }
      setTerminalSignature(localSignature);
      setPhase('executing');
      phaseRef.current = 'executing';
      tradeBusyRef.current = true;
      executionStarted = true;
      const result = await requestExecuteSwap({
        signedTransaction: signedBase64,
        requestId: reviewOrder.requestId,
        lastValidBlockHeight: reviewOrder.lastValidBlockHeight,
      });
      if (!isCurrentExecution()) {
        await swapPendingStore
          .save({ ...submittedPending, outcome: 'unknown', updatedAt: new Date().toISOString() })
          .catch(() => null);
        return;
      }
      setTerminalSignature(result.signature ?? localSignature);
      setResultMessage(result.message);
      if (result.outcome === 'confirmed') {
        await swapPendingStore.remove(reviewOrder.requestId);
        if (!isCurrentExecution()) return;
        spotClient.clearCache();
        const refreshed = await loadBalances(true)
          .then((next) => next !== null)
          .catch(() => false);
        if (!isCurrentExecution()) return;
        refreshWalletData();
        setResultMessage(
          refreshed
            ? 'Balances have been refreshed.'
            : 'Swap confirmed. Refresh Wallet to update balances.',
        );
        await Promise.resolve(notifySuccess()).catch(() => null);
        if (!isCurrentExecution()) return;
        setPendingReady(true);
        setPhase('confirmed');
      } else if (result.outcome === 'failed') {
        await swapPendingStore.remove(reviewOrder.requestId);
        if (!isCurrentExecution()) return;
        setPendingReady(true);
        setFailure(result.message ?? 'The transaction failed on Solana.');
        setReviewOrder(null);
        setPhase('failed');
      } else {
        await swapPendingStore.save({
          ...submittedPending,
          signature: result.signature ?? localSignature,
          outcome: 'unknown',
          updatedAt: new Date().toISOString(),
        });
        if (!isCurrentExecution()) return;
        const reconciled = await reconcileSubmittedSignature(
          rpc,
          result.signature ?? localSignature,
        );
        if (!isCurrentExecution()) return;
        if (reconciled === 'confirmed') {
          await swapPendingStore.remove(reviewOrder.requestId);
          if (!isCurrentExecution()) return;
          spotClient.clearCache();
          const refreshed = await loadBalances(true)
            .then((next) => next !== null)
            .catch(() => false);
          if (!isCurrentExecution()) return;
          refreshWalletData();
          setResultMessage(
            refreshed
              ? 'The transaction was confirmed and balances have been refreshed.'
              : 'The transaction was confirmed. Refresh Wallet to update balances.',
          );
          setPendingReady(true);
          setPhase('confirmed');
        } else if (reconciled === 'failed') {
          await swapPendingStore.remove(reviewOrder.requestId);
          if (!isCurrentExecution()) return;
          setPendingReady(true);
          setFailure('The transaction failed on Solana. Review a fresh quote before trying again.');
          setReviewOrder(null);
          setPhase('failed');
        } else {
          setPendingReady(false);
          setUnknownRequestId(reviewOrder.requestId);
          setPhase('unknown');
        }
      }
    } catch (error) {
      if (!isCurrentExecution()) {
        if (executionStarted) {
          await swapPendingStore
            .save({ ...submittedPending, outcome: 'unknown', updatedAt: new Date().toISOString() })
            .catch(() => null);
        }
        return;
      }
      if (executionStarted) {
        await swapPendingStore
          .save({ ...submittedPending, outcome: 'unknown', updatedAt: new Date().toISOString() })
          .catch(() => null);
        setPendingReady(false);
        setFailure(null);
        setUnknownRequestId(reviewOrder.requestId);
        setResultMessage(
          'The submission response was interrupted. This swap may have landed; do not submit it again.',
        );
        setPhase('unknown');
      } else {
        const rejected = /reject|declin|denied|cancel/i.test(errorMessage(error));
        setPendingReady(true);
        setFailure(rejected ? 'The wallet approval was cancelled.' : errorMessage(error));
        setReviewOrder(null);
        setPhase('failed');
      }
    } finally {
      activeIntents.delete(intentId);
    }
  }, [
    acknowledgeSimulationWarning,
    clearPrepared,
    loadBalances,
    reviewOrder,
    rpc,
    simulationWarning,
    simulationWarningAccepted,
    refreshWalletData,
    requestExecuteSwap,
    requestFinalizeTransaction,
    spotClient,
    swapPendingStore,
    notifySuccess,
    wallet.address,
    wallet.sessionKey,
    wallet.signTransaction,
  ]);

  const invalidatePreparedTrade = useCallback(() => clearPrepared('compose'), [clearPrepared]);
  const setManualAmount = useCallback(
    (value: string) => {
      if (invalidatePreparedTrade()) setAmount(value);
    },
    [invalidatePreparedTrade],
  );
  const openPicker = useCallback(
    (side: SwapSide) => {
      if (
        (mode === 'sell' && side === 'input') ||
        (mode === 'buy' && side === 'output') ||
        !invalidatePreparedTrade()
      )
        return;
      setPickerSide(side);
      setTokenQueryState('');
      setTokenResults([]);
      setTokenError(null);
      setPhase('picker');
    },
    [invalidatePreparedTrade, mode],
  );
  const cancelPicker = useCallback(() => {
    if (phase === 'picker') setPhase('compose');
  }, [phase]);
  const selectToken = useCallback(
    (token: SwapToken) => {
      if (!invalidatePreparedTrade()) return;
      if (pickerSide === 'input') {
        if (token.address === outputToken.address) setOutputToken(inputToken);
        setInputToken(token);
      } else {
        if (token.address === inputToken.address) setInputToken(outputToken);
        setOutputToken(token);
      }
      setAmount('');
      setQuote(null);
      setPhase('compose');
    },
    [inputToken, invalidatePreparedTrade, outputToken, pickerSide],
  );
  const reversePair = useCallback(() => {
    if (!invalidatePreparedTrade()) return;
    setInputToken(outputToken);
    setOutputToken(inputToken);
    setAmount('');
    setQuote(null);
  }, [inputToken, invalidatePreparedTrade, outputToken]);
  const retry = useCallback(() => {
    if (phase === 'unknown' || !invalidatePreparedTrade()) return;
    setQuote(null);
    setQuoteError(null);
    setPhase('compose');
    setQuoteRefreshKey((value) => value + 1);
  }, [invalidatePreparedTrade, phase]);
  const setTokenQuery = useCallback((value: string) => setTokenQueryState(value), []);
  const setSlippageMode = useCallback(
    (value: SlippageMode) => {
      if (invalidatePreparedTrade()) {
        sessionRef.current = { ...sessionRef.current, slippageMode: value };
        setSlippageModeState(value);
        setExtremeConfirmationState('');
      }
    },
    [invalidatePreparedTrade],
  );
  const setCustomSlippage = useCallback(
    (value: string) => {
      if (invalidatePreparedTrade()) {
        sessionRef.current = {
          ...sessionRef.current,
          slippageMode: 'custom',
          customSlippage: value.replace(/[^\d.]/g, ''),
        };
        setCustomSlippageState(value.replace(/[^\d.]/g, ''));
        setExtremeConfirmationState('');
      }
    },
    [invalidatePreparedTrade],
  );
  const setExtremeConfirmation = useCallback(
    (value: string) => {
      if (invalidatePreparedTrade()) setExtremeConfirmationState(value);
    },
    [invalidatePreparedTrade],
  );
  const balancePercent = useCallback(
    (percent: number) => {
      const inputBalanceAtomic = balances[inputToken.address];
      if (!inputBalanceAtomic) return;
      const balance = BigInt(inputBalanceAtomic);
      const spendable =
        inputToken.address === SOL.address
          ? balance > SOL_FEE_RESERVE_LAMPORTS
            ? balance - SOL_FEE_RESERVE_LAMPORTS
            : 0n
          : balance;
      setManualAmount(
        formatAtomicAmount(
          ((spendable * BigInt(percent)) / 100n).toString(),
          inputToken.decimals,
          inputToken.decimals,
        ),
      );
    },
    [balances, inputToken.address, inputToken.decimals, setManualAmount],
  );
  useEffect(() => {
    if (phase !== 'picker' || !active) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setTokenLoading(true);
      setTokenError(null);
      void requestSearchTokens(tokenQuery)
        .then((results) => {
          if (!cancelled) setTokenResults(results);
        })
        .catch((error) => {
          if (!cancelled) setTokenError(errorMessage(error));
        })
        .finally(() => {
          if (!cancelled) setTokenLoading(false);
        });
    }, 320);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, phase, requestSearchTokens, tokenQuery]);

  const amountAtomic = useMemo(() => {
    try {
      return parseUiAmountToAtomic(amount, inputToken.decimals);
    } catch {
      return null;
    }
  }, [amount, inputToken.decimals]);
  const inputBalanceAtomic = balances[inputToken.address];
  const outputBalanceAtomic = balances[outputToken.address];
  const inputUsd =
    amountAtomic && prices[inputToken.address] != null
      ? Number(formatAtomicAmount(amountAtomic, inputToken.decimals, inputToken.decimals)) *
        (prices[inputToken.address] ?? 0)
      : null;
  const outputUi = quote ? formatAtomicAmount(quote.outAmountAtomic, outputToken.decimals, 8) : '—';
  const outputUsd = quote?.outUsdValue ?? null;
  const balanceError = useMemo(() => {
    if (!wallet.connected || !balancesResolved || !amountAtomic) return null;
    if (!isAtomicAmountAtLeast(inputBalanceAtomic, amountAtomic))
      return `Your ${inputToken.symbol} balance is lower than this amount.`;
    if (
      inputToken.address === SOL.address &&
      BigInt(inputBalanceAtomic ?? '0') - BigInt(amountAtomic) < SOL_FEE_RESERVE_LAMPORTS
    )
      return 'Keep at least 0.005 SOL for network and account-creation costs.';
    return null;
  }, [
    amountAtomic,
    balancesResolved,
    inputBalanceAtomic,
    inputToken.address,
    inputToken.symbol,
    wallet.connected,
  ]);
  const receiveAtLeast = reviewOrder
    ? formatAtomicAmount(reviewOrder.minimumOutAmountAtomic, outputToken.decimals, 4)
    : quote
      ? formatAtomicAmount(quote.minimumOutAmountAtomic, outputToken.decimals, 4)
      : '0';
  return {
    mode,
    wallet,
    inputToken,
    outputToken,
    selectedToken,
    amount,
    phase,
    pickerSide,
    tokenQuery,
    tokenResults,
    tokenLoading,
    tokenError,
    balances,
    balancesResolved,
    balancesError,
    pendingReady,
    pendingError,
    prices,
    quote,
    quoteExpired,
    quoteError,
    reviewOrder,
    simulationWarning,
    simulationWarningAccepted,
    slippageMode,
    customSlippage,
    customSlippageError: customSlippageState.error,
    slippageBps,
    extremeConfirmation,
    failure,
    unknownRequestId,
    resultMessage,
    amountAtomic,
    inputUsd,
    outputUi,
    outputUsd,
    balanceError,
    receiveAtLeast,
    inputBalanceAtomic,
    outputBalanceAtomic,
    isDangerousSlippage,
    isExtremeSlippage,
    interactionBusy: tradeInteractionBusy(),
    tradeInteractionBusy: tradeInteractionBusy(),
    prepareReview,
    confirmTrade,
    invalidatePreparedTrade,
    setManualAmount,
    openPicker,
    selectToken,
    cancelPicker,
    setTokenQuery,
    reversePair,
    retry,
    retryBalances: async () => {
      await loadBalances(true);
    },
    reconcilePending,
    setSlippageMode,
    setCustomSlippage,
    setExtremeConfirmation,
    setSimulationWarningAccepted: acknowledgeSimulationWarning,
    balancePercent,
    setBalancePercent: balancePercent,
  };
}
