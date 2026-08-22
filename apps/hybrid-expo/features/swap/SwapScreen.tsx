import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { SpotDataApiClient } from '@myboon/shared/spot';
import bs58 from 'bs58';
import {
  createSwapOrder,
  executeSwap,
  fetchSwapTokens,
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
import { createSwapPendingStore, isPendingSwapExpired } from '@/features/swap/swap.pending';
import {
  finalizeWalletSignedSwapTransaction,
  simulateValidatedSwap,
  validateSwapTransactionForSigning,
} from '@/features/swap/swap-transaction-validation';
import type {
  PendingSwapExecution,
  SwapEntryMode,
  SwapExecutionPhase,
  SwapOrderResponse,
  SwapSide,
  SwapToken,
} from '@/features/swap/swap.types';
import { useWalletSheet } from '@/features/wallet/WalletSheetProvider';
import { notifyWalletDataChanged } from '@/features/wallet/wallet.refresh';
import { SOLANA_RPC } from '@/features/perps/pacific.config';
import { useWallet } from '@/hooks/useWallet';
import { resolveApiBaseUrl } from '@/lib/api';
import { semantic, tokens } from '@/theme';

const SOL: SwapToken = {
  address: 'So11111111111111111111111111111111111111112',
  symbol: 'SOL',
  name: 'Solana',
  decimals: 9,
  logoURI: `${resolveApiBaseUrl()}/tokens/icon/sol`,
};
const USDC: SwapToken = {
  address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: `${resolveApiBaseUrl()}/tokens/icon/usdc`,
};
const SOL_FEE_RESERVE_LAMPORTS = 5_000_000n;

const pendingStore = createSwapPendingStore({
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
});
const activeIntents = new Set<string>();

type SlippageMode = 'auto' | 'fixed' | 'custom';

function modeFrom(value: string | string[] | undefined): SwapEntryMode {
  const item = Array.isArray(value) ? value[0] : value;
  return item === 'buy' || item === 'sell' ? item : 'swap';
}

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Unavailable';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function sumAtomicStrings(...values: (string | null)[]): string {
  return values.reduce<bigint>((total, value) => total + BigInt(value ?? '0'), 0n).toString();
}

function maximumReviewedInput(order: Extract<SwapOrderResponse, { kind: 'signable' }>): string {
  const inputFee = order.fees.providerFeeMint === order.inputMint
    ? order.fees.providerFeeAtomic
    : null;
  return sumAtomicStrings(order.inAmountAtomic, inputFee);
}

function maximumReviewedNetworkCost(order: Extract<SwapOrderResponse, { kind: 'signable' }>): string {
  return sumAtomicStrings(
    order.fees.signatureFeeLamports,
    order.fees.priorityFeeLamports,
    order.fees.rentFeeLamports,
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof SwapApiError) {
    if (error.code === 'ORDER_PROVIDER_INVALID') return 'The quote changed while preparing your trade. Refresh and try again.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'The trade could not be completed.';
}

function inlineSwapError(message: string, inputSymbol: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('balance') && normalized.includes('lower')) return `Insufficient ${inputSymbol} balance`;
  if (normalized.includes('network') && normalized.includes('cost')) return 'Not enough SOL for network fees';
  if (normalized.includes('0.005 sol')) return 'Not enough SOL for network fees';
  if (normalized.includes('cancel') || normalized.includes('reject') || normalized.includes('declin')) return 'Swap cancelled in wallet';
  if (normalized.includes('rate') || normalized.includes('busy') || normalized.includes('refreshing')) return 'Prices are busy — try again';
  if (normalized.includes('route')) return 'No swap route available';
  if (normalized.includes('expired') || normalized.includes('expiry')) return 'Price expired — refresh and try again';
  if (normalized.includes('slippage') || normalized.includes('price moved')) return 'Price moved — refresh and try again';
  if (normalized.includes('different transaction') || normalized.includes('changed') || normalized.includes('unexpected mint')) return 'Swap changed — refresh price';
  if (normalized.includes('wallet') && normalized.includes('cannot sign')) return 'Wallet unavailable on this device';
  if (normalized.includes('connection') || normalized.includes('network request')) return 'Connection lost — try again';
  return message.length <= 48 ? message : 'Swap could not continue — tap to retry';
}

async function reconcileSubmittedSignature(
  connection: Pick<Connection, 'getSignatureStatuses'>,
  signature: string,
  timeoutMs = 20_000,
): Promise<'confirmed' | 'failed' | 'unknown'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.err) return 'failed';
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return 'confirmed';
    } catch {
      return 'unknown';
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
  }
  return 'unknown';
}

const SWIPE_THUMB_SIZE = 48;
const SWIPE_INSET = 4;
const SWIPE_THRESHOLD = 0.82;

function SwapPairIcon() {
  return (
    <Svg width={17} height={17} viewBox="0 0 24 24">
      <Path
        d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4"
        fill="none"
        stroke={tokens.colors.primary}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function SwipeToConfirm({
  receiveAmount,
  outputToken,
  onComplete,
}: {
  receiveAmount: string;
  outputToken: SwapToken;
  onComplete: () => void;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const maxTravelRef = useRef(0);
  const completedRef = useRef(false);

  const reset = useCallback(() => {
    completedRef.current = false;
    Animated.spring(translateX, {
      toValue: 0,
      speed: 28,
      bounciness: 4,
      useNativeDriver: false,
    }).start();
  }, [translateX]);

  const complete = useCallback(() => {
    if (completedRef.current || maxTravelRef.current <= 0) return;
    completedRef.current = true;
    Animated.timing(translateX, {
      toValue: maxTravelRef.current,
      duration: 150,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (!finished) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => null);
      onComplete();
    });
  }, [onComplete, translateX]);

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => maxTravelRef.current > 0,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 5 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_, gesture) => {
      if (completedRef.current) return;
      translateX.setValue(Math.max(0, Math.min(maxTravelRef.current, gesture.dx)));
    },
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dx >= maxTravelRef.current * SWIPE_THRESHOLD) complete();
      else reset();
    },
    onPanResponderTerminate: reset,
  }), [complete, reset, translateX]);

  useEffect(() => {
    completedRef.current = false;
    translateX.setValue(0);
  }, [outputToken.address, receiveAmount, translateX]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    maxTravelRef.current = Math.max(0, event.nativeEvent.layout.width - SWIPE_THUMB_SIZE - SWIPE_INSET * 2);
    completedRef.current = false;
    translateX.setValue(0);
  }, [translateX]);

  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Do the swap to get ${receiveAmount} ${outputToken.symbol}`}
      accessibilityHint="Swipe right to open your wallet"
      accessibilityActions={[{ name: 'activate', label: 'Open wallet' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'activate') complete();
      }}
      onLayout={onLayout}
      style={styles.swipeTrack}
      {...responder.panHandlers}
    >
      <Animated.View style={[styles.swipeFill, { width: Animated.add(translateX, SWIPE_THUMB_SIZE + SWIPE_INSET * 2) }]} />
      <View pointerEvents="none" style={styles.swipeCopy}>
        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82} style={styles.swipeText}>
          Do the swap to get <Text style={styles.swipeAmount}>{receiveAmount} {outputToken.symbol}</Text>
        </Text>
        <TokenAvatar token={outputToken} size={17} />
      </View>
      <Animated.View style={[styles.swipeThumb, { transform: [{ translateX }] }]}>
        <MaterialIcons name="chevron-right" size={24} color={semantic.text.primary} />
      </Animated.View>
    </View>
  );
}

type InlineActionTone = 'default' | 'loading' | 'error' | 'warning' | 'success';

function InlineSwapAction({
  label,
  tone = 'default',
  onPress,
  disabled = false,
  token,
  accessibilityHint,
}: {
  label: string;
  tone?: InlineActionTone;
  onPress?: () => void;
  disabled?: boolean;
  token?: SwapToken;
  accessibilityHint?: string;
}) {
  const loading = tone === 'loading';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading || !onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.inlineAction,
        tone === 'error' && styles.inlineActionError,
        tone === 'warning' && styles.inlineActionWarning,
        tone === 'success' && styles.inlineActionSuccess,
        (disabled || loading || !onPress) && styles.inlineActionStatic,
        pressed && styles.inlineActionPressed,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={tokens.colors.primary} /> : null}
      <Text
        selectable={tone === 'error' || tone === 'warning'}
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={0.78}
        style={[
          styles.inlineActionText,
          tone === 'error' && styles.inlineActionTextError,
          tone === 'warning' && styles.inlineActionTextWarning,
          tone === 'success' && styles.inlineActionTextSuccess,
        ]}
      >
        {label}
      </Text>
      {token ? <TokenAvatar token={token} size={17} /> : null}
    </Pressable>
  );
}

export default function SwapScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    mode?: string;
    token?: string;
  }>();
  const insets = useSafeAreaInsets();
  const wallet = useWallet();
  const walletSheet = useWalletSheet();
  const mode = modeFrom(params.mode);
  const requestedMint = Array.isArray(params.token) ? params.token[0] : params.token;
  const rpc = useMemo(
    () => wallet.connection ?? new Connection(SOLANA_RPC, 'confirmed'),
    [wallet.connection],
  );
  const spotClient = useMemo(() => new SpotDataApiClient({ apiBaseUrl: resolveApiBaseUrl() }), []);

  const [selectedToken, setSelectedToken] = useState<SwapToken | null>(null);
  const [inputToken, setInputToken] = useState<SwapToken>(SOL);
  const [outputToken, setOutputToken] = useState<SwapToken>(USDC);
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<SwapExecutionPhase>('compose');
  const [pickerSide, setPickerSide] = useState<SwapSide>('input');
  const [tokenQuery, setTokenQuery] = useState('');
  const [tokenResults, setTokenResults] = useState<SwapToken[]>([]);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [balancesResolved, setBalancesResolved] = useState(false);
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const [quote, setQuote] = useState<SwapOrderResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteRefreshKey, setQuoteRefreshKey] = useState(0);
  const [reviewOrder, setReviewOrder] = useState<Extract<SwapOrderResponse, { kind: 'signable' }> | null>(null);
  const [simulationWarning, setSimulationWarning] = useState<string | null>(null);
  const [simulationWarningAccepted, setSimulationWarningAccepted] = useState(false);
  const [slippageMode, setSlippageMode] = useState<SlippageMode>('auto');
  const [customSlippage, setCustomSlippage] = useState('0.5');
  const [extremeConfirmation, setExtremeConfirmation] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [, setTerminalSignature] = useState<string | null>(null);
  const [unknownRequestId, setUnknownRequestId] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const resumeReviewRef = useRef(false);
  const openWalletAfterPreparationRef = useRef(false);
  const preparingReviewRef = useRef(false);
  const quoteSequence = useRef(0);

  const inputBalanceAtomic = balances[inputToken.address];
  const outputBalanceAtomic = balances[outputToken.address];
  const customSlippageState = useMemo(() => {
    if (slippageMode !== 'custom') return { value: undefined, error: null as string | null };
    try { return { value: parseSlippagePercentToBps(customSlippage), error: null as string | null }; }
    catch (error) { return { value: undefined, error: errorMessage(error) }; }
  }, [customSlippage, slippageMode]);
  const slippageBps = slippageMode === 'auto' ? undefined : slippageMode === 'fixed' ? 50 : customSlippageState.value;
  // Jupiter RTSE owns slippage in Auto mode. Confirmation applies only when
  // the user explicitly overrides Jupiter with a fixed/custom value.
  const explicitSlippageBps = slippageBps ?? 0;
  const isDangerousSlippage = explicitSlippageBps > 500;
  const isExtremeSlippage = explicitSlippageBps > 1500;

  const close = useCallback(() => {
    if (phase === 'ordering' || phase === 'validating' || phase === 'simulating' || phase === 'awaiting_signature' || phase === 'executing') return;
    router.back();
  }, [phase, router]);

  const loadBalances = useCallback(async (force = false) => {
    if (!wallet.connected || !wallet.address) {
      setBalances({});
      setBalancesResolved(false);
      return null;
    }
    if (force) spotClient.clearCache();
    const result = await spotClient.getWalletBalances(wallet.address);
    const next: Record<string, string> = {};
    for (const token of result.data.tokens) next[token.mint] = token.amount;
    setBalances(next);
    setBalancesResolved(true);
    return next;
  }, [spotClient, wallet.address, wallet.connected]);

  useEffect(() => {
    setBalancesResolved(false);
    void loadBalances().catch(() => {
      setBalances({});
      setBalancesResolved(false);
    });
  }, [loadBalances]);

  useEffect(() => {
    let cancelled = false;
    if (!requestedMint || (requestedMint === SOL.address && mode !== 'swap')) {
      setSelectedToken(requestedMint === SOL.address ? SOL : null);
      return;
    }
    void searchSwapTokens(requestedMint)
      .then((tokensFound) => {
        if (cancelled) return;
        const exact = tokensFound.find((token) => token.address === requestedMint) ?? null;
        setSelectedToken(exact);
      })
      .catch((error) => { if (!cancelled) setFailure(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [mode, requestedMint]);

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
    let cancelled = false;
    void fetchTokenPrices([inputToken.address, outputToken.address])
      .then((response) => {
        if (cancelled) return;
        setPrices(Object.fromEntries(response.prices.map((price) => [price.mint, price.usdPrice])));
      })
      .catch(() => { if (!cancelled) setPrices({}); });
    return () => { cancelled = true; };
  }, [inputToken.address, outputToken.address]);

  useEffect(() => {
    if (phase !== 'compose') return;
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
    const sequence = ++quoteSequence.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void createSwapOrder({
        inputMint: inputToken.address,
        outputMint: outputToken.address,
        amountAtomic,
        ...(slippageBps === undefined ? {} : { slippageBps }),
      }, controller.signal)
        .then((nextQuote) => {
          if (sequence !== quoteSequence.current) return;
          setQuote(nextQuote);
          setQuoteError(null);
        })
        .catch((error) => {
          if (controller.signal.aborted || sequence !== quoteSequence.current) return;
          setQuote(null);
          if (error instanceof SwapApiError && (error.code === 'UPSTREAM_RATE_LIMITED' || error.code === 'RATE_LIMITED')) {
            setQuoteError('Price is refreshing. Try again in a moment.');
          } else {
            setQuoteError(error instanceof SwapApiError && error.code === 'TRADING_PAUSED' ? 'Trading is temporarily paused.' : errorMessage(error));
          }
        });
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [amount, customSlippageState.error, inputToken.address, inputToken.decimals, outputToken.address, phase, quoteRefreshKey, slippageBps]);

  useEffect(() => {
    if (!wallet.connected || !wallet.address || !resumeReviewRef.current) return;
    resumeReviewRef.current = false;
    void prepareReview();
    // prepareReview intentionally reads the latest render state after connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.connected, wallet.address]);

  useEffect(() => {
    if (!wallet.address) return;
    let cancelled = false;
    void pendingStore.list(wallet.address).then(async (pending) => {
      const currentBlockHeight = await rpc.getBlockHeight('confirmed').catch(() => null);
      for (const item of pending) {
        if (cancelled) continue;
        const expired = currentBlockHeight !== null && isPendingSwapExpired(item, currentBlockHeight);
        if (!item.signature) {
          if (expired) {
            await pendingStore.remove(item.requestId);
            continue;
          }
          setUnknownRequestId(item.requestId);
          setTerminalSignature(null);
          setResultMessage('A previous swap may have been submitted. Do not submit it again while its status is unknown.');
          setPhase('unknown');
          break;
        }
        try {
          const status = (await rpc.getSignatureStatuses([item.signature], { searchTransactionHistory: true })).value[0];
          if (status?.err) {
            await pendingStore.remove(item.requestId);
            setTerminalSignature(item.signature);
            setFailure('The previous swap failed on Solana.');
            setResultMessage('The previous swap failed on Solana. Review a fresh quote before trying again.');
            setPhase('failed');
            break;
          } else if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            await pendingStore.remove(item.requestId);
            spotClient.clearCache();
            const balancesRefreshed = await loadBalances(true).then(() => true).catch(() => false);
            notifyWalletDataChanged();
            setTerminalSignature(item.signature);
            setResultMessage(balancesRefreshed
              ? 'The previous swap is confirmed. Balances have been refreshed.'
              : 'The previous swap is confirmed. Refresh Wallet to update balances.');
            setPhase('confirmed');
            break;
          } else if (expired) {
            await pendingStore.remove(item.requestId);
            continue;
          } else if (!cancelled) {
            setUnknownRequestId(item.requestId);
            setTerminalSignature(item.signature);
            setResultMessage('A previous swap is still being reconciled. Do not submit it again.');
            setPhase('unknown');
            break;
          }
        } catch {
          if (!cancelled) {
            setUnknownRequestId(item.requestId);
            setTerminalSignature(item.signature);
            setResultMessage('A previous swap still needs a status check. Do not submit it again.');
            setPhase('unknown');
            break;
          }
        }
      }
    });
    return () => { cancelled = true; };
  }, [loadBalances, rpc, spotClient, wallet.address]);

  async function prepareReview(): Promise<void> {
    if (!wallet.connected || !wallet.address) {
      resumeReviewRef.current = true;
      walletSheet.open('solana');
      return;
    }
    if (preparingReviewRef.current) return;
    preparingReviewRef.current = true;

    setFailure(null);
    setTerminalSignature(null);
    setUnknownRequestId(null);
    setResultMessage(null);
    setReviewOrder(null);
    setSimulationWarning(null);
    setSimulationWarningAccepted(false);
    if (customSlippageState.error) {
      setFailure(customSlippageState.error);
      preparingReviewRef.current = false;
      return;
    }
    let amountAtomic: string;
    try {
      amountAtomic = parseUiAmountToAtomic(amount, inputToken.decimals);
    } catch (error) {
      setFailure(errorMessage(error));
      preparingReviewRef.current = false;
      return;
    }

    if (isExtremeSlippage && extremeConfirmation.trim().toUpperCase() !== 'CONFIRM') {
      setFailure('Type CONFIRM to use slippage above 15%.');
      preparingReviewRef.current = false;
      return;
    }

    try {
      setPhase('ordering');
      const latestBalances = await loadBalances(true);
      const latestBalance = latestBalances?.[inputToken.address];
      if (!isAtomicAmountAtLeast(latestBalance, amountAtomic)) {
        throw new Error(`Your ${inputToken.symbol} balance is lower than this amount.`);
      }
      if (inputToken.address === SOL.address) {
        if (BigInt(latestBalance ?? '0') - BigInt(amountAtomic) < SOL_FEE_RESERVE_LAMPORTS) {
          throw new Error('Keep at least 0.005 SOL for network and account-creation costs.');
        }
      }

      const order = await createSwapOrder({
        inputMint: inputToken.address,
        outputMint: outputToken.address,
        amountAtomic,
        taker: wallet.address,
        ...(slippageBps === undefined ? {} : { slippageBps }),
      });
      if (order.kind !== 'signable') throw new Error('The server did not return a signable transaction.');
      setQuote(order);

      setPhase('validating');
      const validated = await validateSwapTransactionForSigning({
        transactionBase64: order.transaction,
        walletAddress: wallet.address,
        inputMint: order.inputMint,
        outputMint: order.outputMint,
        inAmountAtomic: order.inAmountAtomic,
        minimumOutAmountAtomic: order.minimumOutAmountAtomic,
        maximumNetworkCostLamports: maximumReviewedNetworkCost(order),
        connection: rpc,
      });
      setPhase('simulating');
      const simulation = await simulateValidatedSwap({
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
      setSimulationWarning(simulation.unavailableWarning ?? null);
      setReviewOrder(order);
      setPhase('reviewing');
    } catch (error) {
      openWalletAfterPreparationRef.current = false;
      setFailure(errorMessage(error));
      setPhase('failed');
    } finally {
      preparingReviewRef.current = false;
    }
  }

  async function confirmTrade(): Promise<void> {
    if (!reviewOrder || !wallet.address || !wallet.signTransaction) {
      setFailure('The active Solana wallet cannot sign this transaction.');
      setPhase('failed');
      return;
    }
    if (simulationWarning && !simulationWarningAccepted) {
      setSimulationWarningAccepted(true);
      return;
    }

    const intentId = `${wallet.address}:${reviewOrder.requestId}`;
    if (activeIntents.has(intentId)) return;
    activeIntents.add(intentId);
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
      if (reviewOrder.expiresAt && Date.parse(reviewOrder.expiresAt) <= Date.now()) {
        throw new Error('This quote expired. Refresh it before opening your wallet.');
      }
      setPhase('awaiting_signature');
      const currentBlockHeight = await rpc.getBlockHeight('confirmed');
      if (BigInt(currentBlockHeight) + 10n >= BigInt(reviewOrder.lastValidBlockHeight)) {
        throw new Error('This transaction is too close to expiry. Refresh the quote before signing.');
      }
      const unsigned = VersionedTransaction.deserialize(Buffer.from(reviewOrder.transaction, 'base64'));
      const signTransaction = wallet.signTransaction as (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
      const walletSigned = await signTransaction(unsigned);
      setPhase('validating');
      const signed = await finalizeWalletSignedSwapTransaction({
        reviewedTransactionBase64: reviewOrder.transaction,
        signedTransaction: walletSigned,
        walletAddress: wallet.address,
        inputMint: reviewOrder.inputMint,
        outputMint: reviewOrder.outputMint,
        inputAmountAtomic: reviewOrder.inAmountAtomic,
        maximumInputAmountAtomic: maximumReviewedInput(reviewOrder),
        maximumNetworkCostLamports: maximumReviewedNetworkCost(reviewOrder),
        minimumOutAmountAtomic: reviewOrder.minimumOutAmountAtomic,
        connection: rpc,
      });
      const signatureBytes = signed.signatures[0];
      const localSignature = bs58.encode(signatureBytes);
      const signedBase64 = Buffer.from(signed.serialize()).toString('base64');
      submittedPending = { ...pending, signature: localSignature, updatedAt: new Date().toISOString() };
      await pendingStore.save(submittedPending);
      setTerminalSignature(localSignature);

      setPhase('executing');
      executionStarted = true;
      const result = await executeSwap({
        signedTransaction: signedBase64,
        requestId: reviewOrder.requestId,
        lastValidBlockHeight: reviewOrder.lastValidBlockHeight,
      });
      setTerminalSignature(result.signature ?? localSignature);
      setResultMessage(result.message);

      if (result.outcome === 'confirmed') {
        await pendingStore.remove(reviewOrder.requestId);
        spotClient.clearCache();
        const balancesRefreshed = await loadBalances(true).then(() => true).catch(() => false);
        notifyWalletDataChanged();
        setResultMessage(balancesRefreshed ? 'Balances have been refreshed.' : 'Swap confirmed. Refresh Wallet to update balances.');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => null);
        setPhase('confirmed');
      } else if (result.outcome === 'failed') {
        await pendingStore.remove(reviewOrder.requestId);
        setFailure(result.message ?? 'The transaction failed on Solana.');
        setReviewOrder(null);
        setPhase('failed');
      } else {
        await pendingStore.save({
          ...submittedPending,
          signature: result.signature ?? localSignature,
          outcome: 'unknown',
          updatedAt: new Date().toISOString(),
        });
        const reconciled = await reconcileSubmittedSignature(rpc, result.signature ?? localSignature);
        if (reconciled === 'confirmed') {
          await pendingStore.remove(reviewOrder.requestId);
          spotClient.clearCache();
          const balancesRefreshed = await loadBalances(true).then(() => true).catch(() => false);
          notifyWalletDataChanged();
          setResultMessage(balancesRefreshed
            ? 'The transaction was confirmed and balances have been refreshed.'
            : 'The transaction was confirmed. Refresh Wallet to update balances.');
          setPhase('confirmed');
        } else if (reconciled === 'failed') {
          await pendingStore.remove(reviewOrder.requestId);
          setFailure('The transaction failed on Solana. Review a fresh quote before trying again.');
          setReviewOrder(null);
          setPhase('failed');
        } else {
          setUnknownRequestId(reviewOrder.requestId);
          setPhase('unknown');
        }
      }
    } catch (error) {
      if (executionStarted) {
        await pendingStore.save({
          ...submittedPending,
          outcome: 'unknown',
          updatedAt: new Date().toISOString(),
        }).catch(() => null);
        setFailure(null);
        setUnknownRequestId(reviewOrder.requestId);
        setResultMessage('The submission response was interrupted. This swap may have landed; do not submit it again.');
        setPhase('unknown');
      } else {
        const rejected = /reject|declin|denied|cancel/i.test(errorMessage(error));
        setFailure(rejected ? 'The wallet approval was cancelled.' : errorMessage(error));
        setReviewOrder(null);
        setPhase('failed');
      }
    } finally {
      activeIntents.delete(intentId);
    }
  }

  useEffect(() => {
    if (phase !== 'reviewing' || !reviewOrder || !openWalletAfterPreparationRef.current) return;
    if (simulationWarning && !simulationWarningAccepted) return;
    openWalletAfterPreparationRef.current = false;
    void confirmTrade();
    // confirmTrade intentionally reads the exact reviewed order from this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, reviewOrder, simulationWarning, simulationWarningAccepted]);

  function tradeInteractionBusy(): boolean {
    return phase === 'ordering'
      || phase === 'validating'
      || phase === 'simulating'
      || phase === 'awaiting_signature'
      || phase === 'executing'
      || phase === 'unknown';
  }

  function invalidatePreparedTrade(): boolean {
    if (tradeInteractionBusy()) return false;
    openWalletAfterPreparationRef.current = false;
    setReviewOrder(null);
    setSimulationWarning(null);
    setSimulationWarningAccepted(false);
    setFailure(null);
    setTerminalSignature(null);
    setUnknownRequestId(null);
    setResultMessage(null);
    if (phase !== 'compose' && phase !== 'picker') setPhase('compose');
    return true;
  }

  function openPicker(side: SwapSide): void {
    if ((mode === 'sell' && side === 'input') || (mode === 'buy' && side === 'output')) return;
    if (!invalidatePreparedTrade()) return;
    setPickerSide(side);
    setTokenQuery('');
    setPhase('picker');
    setTokenLoading(true);
    void fetchSwapTokens(30)
      .then(setTokenResults)
      .catch((error) => setTokenError(errorMessage(error)))
      .finally(() => setTokenLoading(false));
  }

  useEffect(() => {
    if (phase !== 'picker') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setTokenLoading(true);
      setTokenError(null);
      void searchSwapTokens(tokenQuery)
        .then((results) => { if (!cancelled) setTokenResults(results); })
        .catch((error) => { if (!cancelled) setTokenError(errorMessage(error)); })
        .finally(() => { if (!cancelled) setTokenLoading(false); });
    }, 320);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [phase, tokenQuery]);

  function selectToken(token: SwapToken): void {
    if (pickerSide === 'input') {
      if (token.address === outputToken.address) setOutputToken(inputToken);
      setInputToken(token);
    } else {
      if (token.address === inputToken.address) setInputToken(outputToken);
      setOutputToken(token);
    }
    setAmount('');
    setQuote(null);
    invalidatePreparedTrade();
    setPhase('compose');
  }

  function reversePair(): void {
    if (!invalidatePreparedTrade()) return;
    setInputToken(outputToken);
    setOutputToken(inputToken);
    setAmount('');
    setQuote(null);
  }

  function setManualAmount(value: string): void {
    if (!invalidatePreparedTrade()) return;
    setAmount(value);
  }

  const amountAtomic = useMemo(() => {
    try { return parseUiAmountToAtomic(amount, inputToken.decimals); } catch { return null; }
  }, [amount, inputToken.decimals]);
  const inputUsd = amountAtomic && prices[inputToken.address] != null
    ? Number(formatAtomicAmount(amountAtomic, inputToken.decimals, inputToken.decimals)) * (prices[inputToken.address] ?? 0)
    : null;
  const outputUi = quote ? formatAtomicAmount(quote.outAmountAtomic, outputToken.decimals, 8) : '0';
  const outputUsd = quote?.outUsdValue ?? null;
  const balanceError = useMemo(() => {
    if (!wallet.connected || !balancesResolved || !amountAtomic) return null;
    if (!isAtomicAmountAtLeast(inputBalanceAtomic, amountAtomic)) {
      return `Your ${inputToken.symbol} balance is lower than this amount.`;
    }
    if (
      inputToken.address === SOL.address
      && BigInt(inputBalanceAtomic ?? '0') - BigInt(amountAtomic) < SOL_FEE_RESERVE_LAMPORTS
    ) {
      return 'Keep at least 0.005 SOL for network and account-creation costs.';
    }
    return null;
  }, [amountAtomic, balancesResolved, inputBalanceAtomic, inputToken.address, inputToken.symbol, wallet.connected]);
  const interactionBusy = tradeInteractionBusy();
  const receiveAtLeast = reviewOrder
    ? formatAtomicAmount(reviewOrder.minimumOutAmountAtomic, outputToken.decimals, 4)
    : quote
      ? formatAtomicAmount(quote.minimumOutAmountAtomic, outputToken.decimals, 4)
      : '0';

  const content = phase === 'picker'
    ? renderPicker()
    : renderCompose();

  function retryInlineAction(): void {
    if (phase === 'unknown') return;
    openWalletAfterPreparationRef.current = false;
    setReviewOrder(null);
    setSimulationWarning(null);
    setSimulationWarningAccepted(false);
    setFailure(null);
    setTerminalSignature(null);
    setUnknownRequestId(null);
    setResultMessage(null);
    setQuote(null);
    setQuoteError(null);
    setPhase('compose');
    setQuoteRefreshKey((value) => value + 1);
  }

  function renderInlineAction() {
    if (phase === 'confirmed') {
      return (
        <InlineSwapAction
          label={receiveAtLeast === '0' ? 'Swap confirmed' : `${receiveAtLeast} ${outputToken.symbol} received`}
          tone="success"
          token={receiveAtLeast === '0' ? undefined : outputToken}
          onPress={close}
          accessibilityHint={resultMessage ?? 'Close this swap'}
        />
      );
    }
    if (phase === 'unknown') {
      return (
        <InlineSwapAction
          label="Checking transaction — don’t retry"
          tone="loading"
          accessibilityHint={resultMessage ?? (unknownRequestId ? `Pending request ${unknownRequestId}` : undefined)}
        />
      );
    }
    if (phase === 'failed') {
      return (
        <InlineSwapAction
          label={inlineSwapError(failure ?? 'Swap could not continue.', inputToken.symbol)}
          tone="error"
          onPress={retryInlineAction}
          accessibilityHint="Tap to refresh the quote and try again"
        />
      );
    }
    if (phase === 'quoting') return <InlineSwapAction label="Getting the latest price…" tone="loading" />;
    if (phase === 'ordering') return <InlineSwapAction label="Building your swap…" tone="loading" />;
    if (phase === 'validating') return <InlineSwapAction label={reviewOrder ? 'Checking wallet response…' : 'Checking the swap…'} tone="loading" />;
    if (phase === 'simulating') return <InlineSwapAction label="Checking the expected result…" tone="loading" />;
    if (phase === 'awaiting_signature') return <InlineSwapAction label="Approve the swap in your wallet" tone="loading" />;
    if (phase === 'executing') return <InlineSwapAction label="Sending swap…" tone="loading" />;
    if (phase === 'reviewing' && reviewOrder) {
      if (simulationWarning && !simulationWarningAccepted) {
        return (
          <InlineSwapAction
            label="Simulation unavailable — tap to continue"
            tone="warning"
            onPress={() => setSimulationWarningAccepted(true)}
            accessibilityHint={simulationWarning}
          />
        );
      }
      return <InlineSwapAction label="Opening your wallet…" tone="loading" />;
    }
    if (!amountAtomic) return <InlineSwapAction label="Enter an amount" disabled />;
    if (inputToken.address === outputToken.address) return <InlineSwapAction label="Choose two different assets" tone="warning" disabled />;
    if (wallet.connected && !balancesResolved) return <InlineSwapAction label="Checking your balance…" tone="loading" />;
    if (balanceError) return <InlineSwapAction label={inlineSwapError(balanceError, inputToken.symbol)} tone="error" disabled />;
    if (customSlippageState.error) return <InlineSwapAction label={customSlippageState.error} tone="error" disabled />;
    if (isExtremeSlippage && extremeConfirmation.trim().toUpperCase() !== 'CONFIRM') {
      return <InlineSwapAction label="Type CONFIRM to continue" tone="warning" disabled />;
    }
    if (quoteError) {
      return (
        <InlineSwapAction
          label={inlineSwapError(quoteError, inputToken.symbol)}
          tone="error"
          onPress={() => {
            setQuoteError(null);
            setQuoteRefreshKey((value) => value + 1);
          }}
          accessibilityHint="Tap to request a new price"
        />
      );
    }
    if (!quote) return <InlineSwapAction label="Getting the latest price…" tone="loading" />;
    if (!wallet.connected) {
      return (
        <InlineSwapAction
          label="Connect wallet to swap"
          onPress={() => {
            Keyboard.dismiss();
            openWalletAfterPreparationRef.current = true;
            void prepareReview();
          }}
        />
      );
    }
    return (
      <SwipeToConfirm
        receiveAmount={receiveAtLeast}
        outputToken={outputToken}
        onComplete={() => {
          Keyboard.dismiss();
          openWalletAfterPreparationRef.current = true;
          void prepareReview();
        }}
      />
    );
  }

  function renderCompose() {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.body}
      >
          <View style={styles.composer}>
            <AssetAmount
              label="You pay"
              token={inputToken}
              balanceAtomic={inputBalanceAtomic}
              amount={amount}
              usd={inputUsd}
              editable
              locked={mode === 'sell'}
              disabled={interactionBusy}
              invalid={!!balanceError}
              onAmount={setManualAmount}
              onAsset={() => openPicker('input')}
              onBalancePercent={(percent) => {
                if (!inputBalanceAtomic) return;
                const balance = BigInt(inputBalanceAtomic);
                const spendable = inputToken.address === SOL.address
                  ? balance > SOL_FEE_RESERVE_LAMPORTS
                    ? balance - SOL_FEE_RESERVE_LAMPORTS
                    : 0n
                  : balance;
                const selected = spendable * BigInt(percent) / 100n;
                setManualAmount(formatAtomicAmount(selected.toString(), inputToken.decimals, inputToken.decimals));
              }}
            />
            <View style={styles.seam}>
              {mode === 'swap' ? (
                <Pressable disabled={interactionBusy} onPress={reversePair} accessibilityRole="button" accessibilityLabel="Reverse pair" accessibilityState={{ disabled: interactionBusy }} style={styles.reverseButton}>
                  <SwapPairIcon />
                </Pressable>
              ) : null}
            </View>
            <AssetAmount
              label="You receive"
              token={outputToken}
              balanceAtomic={outputBalanceAtomic}
              amount={outputUi}
              usd={outputUsd}
              editable={false}
              locked={mode === 'buy'}
              disabled={interactionBusy}
              onAmount={() => {}}
              onAsset={() => openPicker('output')}
            />
          </View>

          <View style={styles.quoteCard}>
            <MetricRow label="Minimum received" value={quote ? `${formatAtomicAmount(quote.minimumOutAmountAtomic, outputToken.decimals, 8)} ${outputToken.symbol}` : '—'} />
            <View style={styles.slippageRow}>
              <Text style={styles.metricLabel}>Slippage</Text>
              <View style={styles.slippageOptions}>
                {(['auto', 'fixed', 'custom'] as const).map((item) => (
                  <Pressable key={item} disabled={interactionBusy} onPress={() => { if (!invalidatePreparedTrade()) return; setSlippageMode(item); setExtremeConfirmation(''); }} style={[styles.smallChoice, slippageMode === item && styles.smallChoiceActive]}>
                    <Text style={[styles.smallChoiceText, slippageMode === item && styles.smallChoiceTextActive]}>{item === 'fixed' ? '0.5%' : item}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            {slippageMode === 'custom' ? (
              <TextInput
                value={customSlippage}
                editable={!interactionBusy}
                onChangeText={(value) => { if (!invalidatePreparedTrade()) return; setCustomSlippage(value.replace(/[^\d.]/g, '')); setExtremeConfirmation(''); }}
                keyboardType="decimal-pad"
                placeholder="0–50%"
                placeholderTextColor={semantic.text.faint}
                style={styles.customInput}
                accessibilityLabel="Custom slippage percentage"
              />
            ) : null}
          </View>

          {isDangerousSlippage ? <Text style={styles.warning}>High slippage applies only to this trade and resets when this sheet closes.</Text> : null}
          {isExtremeSlippage ? (
            <TextInput
              value={extremeConfirmation}
              editable={!interactionBusy}
              onChangeText={(value) => { if (!invalidatePreparedTrade()) return; setExtremeConfirmation(value); }}
              autoCapitalize="characters"
              placeholder="Type CONFIRM for slippage above 15%"
              placeholderTextColor={semantic.text.faint}
              style={styles.confirmInput}
            />
          ) : null}
          {renderInlineAction()}
      </ScrollView>
    );
  }

  function renderPicker() {
    return (
      <View style={styles.body}>
          <TextInput
            autoFocus
            value={tokenQuery}
            onChangeText={setTokenQuery}
            placeholder="Search token or paste mint"
            placeholderTextColor={semantic.text.faint}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.searchInput}
          />
          {tokenLoading ? <ActivityIndicator color={tokens.colors.primary} style={styles.loader} /> : null}
          {tokenError ? <Text selectable style={styles.errorText}>{tokenError}</Text> : null}
          <ScrollView keyboardShouldPersistTaps="handled" style={styles.tokenList} showsVerticalScrollIndicator={false}>
            {tokenResults.map((token) => (
              <Pressable key={token.address} onPress={() => selectToken(token)} style={styles.tokenResult}>
                <TokenAvatar token={token} size={32} />
                <View style={styles.tokenResultCopy}>
                  <Text style={styles.tokenSymbol}>{token.symbol}</Text>
                  <Text style={styles.tokenName} numberOfLines={1}>{token.name}</Text>
                </View>
                <Text selectable style={styles.mintText}>{`${token.address.slice(0, 4)}…${token.address.slice(-4)}`}</Text>
              </Pressable>
            ))}
          </ScrollView>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.overlay}
      behavior="padding"
      enabled={Platform.OS === 'ios'}
    >
      <Pressable style={styles.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel="Close trade sheet" />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>{content}</View>
    </KeyboardAvoidingView>
  );
}

function TokenAvatar({ token, size }: { token: SwapToken; size: number }) {
  return token.logoURI ? (
    <Image source={token.logoURI} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: semantic.background.lift }} contentFit="cover" />
  ) : (
    <View style={[styles.tokenFallback, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={styles.tokenFallbackText}>{token.symbol.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

function AssetAmount({
  label,
  token,
  balanceAtomic,
  amount,
  usd,
  editable,
  locked,
  disabled = false,
  invalid = false,
  onAmount,
  onAsset,
  onBalancePercent,
}: {
  label: string;
  token: SwapToken;
  balanceAtomic?: string;
  amount: string;
  usd: number | null;
  editable: boolean;
  locked: boolean;
  disabled?: boolean;
  invalid?: boolean;
  onAmount: (value: string) => void;
  onAsset: () => void;
  onBalancePercent?: (percent: number) => void;
}) {
  return (
    <View style={styles.assetBlock}>
      <View style={styles.assetMeta}>
        <Text style={styles.assetLabel}>{label}</Text>
        <View style={styles.balanceRow}>
          <Text style={styles.balanceText}>Balance {balanceAtomic ? formatAtomicAmount(balanceAtomic, token.decimals, 6) : '—'}</Text>
          {onBalancePercent && balanceAtomic ? (
            <View style={styles.balanceActions}>
              {[25, 50, 100].map((percent, index) => (
                <View key={percent} style={styles.balanceActionGroup}>
                  {index > 0 ? <Text style={styles.balanceActionSeparator}>·</Text> : null}
                  <Pressable
                    disabled={disabled}
                    onPress={() => onBalancePercent(percent)}
                    hitSlop={9}
                    accessibilityRole="button"
                    accessibilityLabel={`Use ${percent} percent of available ${token.symbol} balance`}
                    accessibilityState={{ disabled }}
                    style={styles.balanceAction}
                  >
                    <Text style={styles.balanceActionText}>{percent}%</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>
      <View style={styles.assetMain}>
        <Pressable disabled={locked || disabled} onPress={onAsset} accessibilityState={{ disabled: locked || disabled }} style={[styles.assetSelector, (locked || disabled) && styles.assetSelectorLocked]}>
          <TokenAvatar token={token} size={26} />
          <Text style={styles.assetSymbol}>{token.symbol}</Text>
          {!locked ? <MaterialIcons name="expand-more" size={17} color={semantic.text.dim} /> : null}
        </Pressable>
        <View style={styles.amountColumn}>
          {editable ? (
            <TextInput
              value={amount}
              editable={!disabled}
              onChangeText={(value) => onAmount(value.replace(/[^\d.]/g, ''))}
              keyboardType="decimal-pad"
              returnKeyType="done"
              onSubmitEditing={Keyboard.dismiss}
              placeholder="0"
              placeholderTextColor={semantic.text.faint}
              style={[styles.amountInput, invalid && styles.amountInputInvalid]}
              accessibilityLabel={`${label} amount`}
            />
          ) : (
            <Text
              selectable
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.62}
              style={[
                styles.amountOutput,
                amount.length > 9 && styles.amountOutputCompact,
                amount.length > 13 && styles.amountOutputDense,
                amount === '0' && styles.amountMuted,
              ]}
            >
              {amount}
            </Text>
          )}
          <Text style={styles.amountUsd}>{amount.trim() === '' || Number(amount) === 0 ? '$0.00' : formatUsd(usd)}</Text>
        </View>
      </View>
    </View>
  );
}

function MetricRow({ label, value, positive = false }: { label: string; value: string; positive?: boolean }) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text selectable style={[styles.metricValue, positive && styles.metricPositive]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(1, 13, 19, 0.72)' },
  sheet: {
    maxHeight: '92%',
    minHeight: 280,
    backgroundColor: semantic.background.screen,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: semantic.border.muted,
    overflow: 'hidden',
  },
  body: { padding: 14, gap: 10 },
  composer: { borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 12, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: semantic.background.surface },
  assetBlock: { padding: 12, gap: 8 },
  assetMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  assetLabel: { color: semantic.text.dim, fontFamily: 'monospace', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1 },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  balanceText: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8 },
  balanceActions: { flexDirection: 'row', alignItems: 'center' },
  balanceActionGroup: { flexDirection: 'row', alignItems: 'center' },
  balanceActionSeparator: { color: semantic.border.muted, fontFamily: 'monospace', fontSize: 11 },
  balanceAction: { minHeight: 32, paddingHorizontal: 1, alignItems: 'center', justifyContent: 'center', marginVertical: -8 },
  balanceActionText: { color: semantic.text.accentDim, fontFamily: 'monospace', fontSize: 10, fontWeight: '900', fontVariant: ['tabular-nums'] },
  assetMain: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  assetSelector: { minWidth: 112, minHeight: 42, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 9, borderCurve: 'continuous', backgroundColor: semantic.background.surfaceRaised },
  assetSelectorLocked: { borderColor: 'transparent', backgroundColor: semantic.background.surface },
  assetSymbol: { color: semantic.text.primary, fontSize: 15, fontWeight: '800' },
  amountColumn: { flex: 1, alignItems: 'flex-end' },
  amountInput: { width: '100%', padding: 0, color: semantic.text.primary, fontSize: 34, lineHeight: 38, fontWeight: '700', textAlign: 'right', fontVariant: ['tabular-nums'] },
  amountInputInvalid: { color: semantic.sentiment.negative },
  amountOutput: { width: '100%', flexShrink: 1, color: semantic.text.primary, fontSize: 34, lineHeight: 38, fontWeight: '700', textAlign: 'right', fontVariant: ['tabular-nums'] },
  amountOutputCompact: { fontSize: 28, lineHeight: 34 },
  amountOutputDense: { fontSize: 23, lineHeight: 29 },
  amountMuted: { color: semantic.text.faint },
  amountUsd: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8, fontVariant: ['tabular-nums'] },
  seam: { height: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: semantic.border.muted, zIndex: 2 },
  reverseButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: semantic.border.muted, backgroundColor: tokens.colors.walletCore },
  quoteCard: { borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 9, borderCurve: 'continuous', backgroundColor: semantic.background.surface, overflow: 'hidden' },
  metricRow: { minHeight: 34, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: semantic.border.muted },
  metricLabel: { color: semantic.text.dim, fontSize: 10 },
  metricValue: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 9, fontWeight: '700', textAlign: 'right', fontVariant: ['tabular-nums'] },
  metricPositive: { color: semantic.sentiment.positive },
  slippageRow: { minHeight: 38, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  slippageOptions: { flexDirection: 'row', gap: 4 },
  smallChoice: { minHeight: 27, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: semantic.border.muted, borderRadius: tokens.radius.sm },
  smallChoiceActive: { borderColor: tokens.colors.primary, backgroundColor: 'rgba(17,138,178,0.11)' },
  smallChoiceText: { color: semantic.text.dim, fontFamily: 'monospace', fontSize: 8, textTransform: 'capitalize' },
  smallChoiceTextActive: { color: semantic.text.primary },
  customInput: { minHeight: 38, paddingHorizontal: 10, color: semantic.text.primary, textAlign: 'right', fontFamily: 'monospace', fontSize: 11, borderTopWidth: 1, borderTopColor: semantic.border.muted },
  warning: { color: semantic.text.accentDim, fontSize: 10, lineHeight: 15, textAlign: 'center' },
  confirmInput: { minHeight: 42, paddingHorizontal: 11, borderWidth: 1, borderColor: semantic.text.accentDim, borderRadius: 8, color: semantic.text.primary, fontFamily: 'monospace', fontSize: 10, textAlign: 'center' },
  errorText: { color: semantic.sentiment.negative, fontSize: 10, lineHeight: 15, textAlign: 'center' },
  inlineAction: { minHeight: 56, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 10, borderCurve: 'continuous', backgroundColor: tokens.colors.walletCore },
  inlineActionError: { borderColor: 'rgba(239,71,111,0.72)', backgroundColor: 'rgba(239,71,111,0.06)' },
  inlineActionWarning: { borderColor: 'rgba(255,209,102,0.68)', backgroundColor: 'rgba(255,209,102,0.06)' },
  inlineActionSuccess: { borderColor: 'rgba(6,214,160,0.72)', backgroundColor: 'rgba(6,214,160,0.07)' },
  inlineActionStatic: { opacity: 1 },
  inlineActionPressed: { opacity: 0.78 },
  inlineActionText: { maxWidth: '88%', color: semantic.text.primary, fontSize: 13, lineHeight: 17, fontWeight: '900', textAlign: 'center' },
  inlineActionTextError: { color: semantic.sentiment.negative },
  inlineActionTextWarning: { color: semantic.text.accentDim },
  inlineActionTextSuccess: { color: semantic.sentiment.positive },
  swipeTrack: { position: 'relative', height: 58, overflow: 'hidden', borderWidth: 1, borderColor: tokens.colors.primary, borderRadius: 10, borderCurve: 'continuous', backgroundColor: tokens.colors.walletCore },
  swipeFill: { position: 'absolute', top: 0, bottom: 0, left: 0, backgroundColor: 'rgba(17,138,178,0.24)' },
  swipeCopy: { ...StyleSheet.absoluteFillObject, paddingLeft: 54, paddingRight: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  swipeText: { flexShrink: 1, color: semantic.text.dim, fontSize: 12, fontWeight: '800', textAlign: 'center' },
  swipeAmount: { color: semantic.text.primary, fontWeight: '900', fontVariant: ['tabular-nums'] },
  swipeThumb: { position: 'absolute', top: SWIPE_INSET, left: SWIPE_INSET, width: SWIPE_THUMB_SIZE, height: SWIPE_THUMB_SIZE, alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderCurve: 'continuous', backgroundColor: tokens.colors.primary, boxShadow: '0 5px 15px rgba(0,0,0,0.25)' },
  searchInput: { minHeight: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: tokens.colors.primary, borderRadius: 9, color: semantic.text.primary, fontSize: 13, backgroundColor: semantic.background.surface },
  loader: { paddingVertical: 12 },
  tokenList: { maxHeight: 390 },
  tokenResult: { minHeight: 54, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: semantic.border.muted },
  tokenResultCopy: { flex: 1, minWidth: 0, gap: 2 },
  tokenSymbol: { color: semantic.text.primary, fontSize: 13, fontWeight: '800' },
  tokenName: { color: semantic.text.dim, fontSize: 10 },
  mintText: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8 },
  tokenFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.primary },
  tokenFallbackText: { color: semantic.text.primary, fontSize: 11, fontWeight: '900' },
});
