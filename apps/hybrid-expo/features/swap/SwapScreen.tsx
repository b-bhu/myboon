import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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
import { createSwapPendingStore } from '@/features/swap/swap.pending';
import {
  finalizeWalletSignedSwapTransaction,
  simulateValidatedSwap,
  validateSwapTransactionForSigning,
} from '@/features/swap/swap-transaction-validation';
import type {
  PendingSwapExecution,
  SimulatedBalanceChange,
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

function shortAddress(value: string): string {
  return `${value.slice(0, 4)}···${value.slice(-4)}`;
}

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Unavailable';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  return `${value.toFixed(Math.abs(value) < 0.1 ? 3 : 2)}%`;
}

function lamportsToSol(value: string | null): string {
  return value ? `${formatAtomicAmount(value, 9, 9)} SOL` : 'Unavailable';
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

function statusCopy(phase: SwapExecutionPhase): { title: string; detail: string } {
  switch (phase) {
    case 'quoting': return { title: 'Refreshing quote', detail: 'Getting current price, route, slippage, and fees.' };
    case 'ordering': return { title: 'Building transaction', detail: 'Creating one fresh transaction for this review.' };
    case 'validating': return { title: 'Checking transaction', detail: 'Verifying programs, accounts, assets, and wallet authority.' };
    case 'simulating': return { title: 'Simulating changes', detail: 'Checking the exact result before your wallet opens.' };
    case 'awaiting_signature': return { title: 'Approve in wallet', detail: 'Your selected wallet is reviewing this exact transaction.' };
    case 'executing': return { title: 'Transaction submitted', detail: 'Waiting for Solana and Jupiter to confirm the result.' };
    default: return { title: '', detail: '' };
  }
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

export default function SwapScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    mode?: string;
    token?: string;
    caller?: string;
  }>();
  const insets = useSafeAreaInsets();
  const wallet = useWallet();
  const walletSheet = useWalletSheet();
  const mode = modeFrom(params.mode);
  const requestedMint = Array.isArray(params.token) ? params.token[0] : params.token;
  const caller = (Array.isArray(params.caller) ? params.caller[0] : params.caller) === 'spot' ? 'spot' : 'wallet';
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
  const [reviewOrder, setReviewOrder] = useState<Extract<SwapOrderResponse, { kind: 'signable' }> | null>(null);
  const [balanceChanges, setBalanceChanges] = useState<SimulatedBalanceChange[]>([]);
  const [simulationWarning, setSimulationWarning] = useState<string | null>(null);
  const [simulationWarningAccepted, setSimulationWarningAccepted] = useState(false);
  const [slippageMode, setSlippageMode] = useState<SlippageMode>('auto');
  const [customSlippage, setCustomSlippage] = useState('0.5');
  const [extremeConfirmation, setExtremeConfirmation] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [terminalSignature, setTerminalSignature] = useState<string | null>(null);
  const [unknownRequestId, setUnknownRequestId] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const resumeReviewRef = useRef(false);
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
  }, [amount, customSlippageState.error, inputToken.address, inputToken.decimals, outputToken.address, phase, slippageBps]);

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
      for (const item of pending) {
        if (cancelled) continue;
        if (!item.signature) {
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
    setBalanceChanges([]);
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
        const reserveLamports = 5_000_000n;
        if (BigInt(latestBalance ?? '0') - BigInt(amountAtomic) < reserveLamports) {
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
      const simulatedChanges: SimulatedBalanceChange[] = simulation.balanceChanges.tokens
        .filter((change) => change.mint === order.inputMint || change.mint === order.outputMint)
        .map((change) => ({
          mint: change.mint,
          beforeAtomic: change.beforeAtomic,
          afterAtomic: change.afterAtomic,
          decimals: change.mint === order.inputMint ? inputToken.decimals : outputToken.decimals,
        }));
      if (order.inputMint === SOL.address || order.outputMint === SOL.address) {
        simulatedChanges.push({
          mint: SOL.address,
          beforeAtomic: simulation.balanceChanges.nativeLamports.before,
          afterAtomic: simulation.balanceChanges.nativeLamports.after,
          decimals: 9,
        });
      }
      setBalanceChanges(simulatedChanges.filter((change, index, rows) => rows.findIndex((row) => row.mint === change.mint) === index));
      setSimulationWarning(simulation.unavailableWarning ?? null);
      setReviewOrder(order);
      setPhase('reviewing');
    } catch (error) {
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

  function openPicker(side: SwapSide): void {
    if ((mode === 'sell' && side === 'input') || (mode === 'buy' && side === 'output')) return;
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
    setFailure(null);
    setPhase('compose');
  }

  function reversePair(): void {
    setInputToken(outputToken);
    setOutputToken(inputToken);
    setAmount('');
    setQuote(null);
    setFailure(null);
  }

  function setManualAmount(value: string): void {
    setAmount(value);
    setFailure(null);
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
      && BigInt(inputBalanceAtomic ?? '0') - BigInt(amountAtomic) < 5_000_000n
    ) {
      return 'Keep at least 0.005 SOL for network and account-creation costs.';
    }
    return null;
  }, [amountAtomic, balancesResolved, inputBalanceAtomic, inputToken.address, inputToken.symbol, wallet.connected]);
  const balanceAllowsReview = !wallet.connected || (balancesResolved && !balanceError);
  const canReview = !!amountAtomic && !!quote && balanceAllowsReview && !customSlippageState.error && inputToken.address !== outputToken.address && !isExtremeSlippage
    ? true
    : !!amountAtomic && !!quote && balanceAllowsReview && !customSlippageState.error && inputToken.address !== outputToken.address && extremeConfirmation.trim().toUpperCase() === 'CONFIRM';

  const content = phase === 'picker'
    ? renderPicker()
    : phase === 'compose'
      ? renderCompose()
      : phase === 'reviewing'
        ? renderReview()
        : phase === 'confirmed' || phase === 'failed' || phase === 'unknown'
          ? renderTerminal()
          : renderProgress();

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
              invalid={!!balanceError}
              onAmount={setManualAmount}
              onAsset={() => openPicker('input')}
              onMax={() => {
                if (!inputBalanceAtomic) return;
                setAmount(formatAtomicAmount(inputBalanceAtomic, inputToken.decimals, inputToken.decimals));
                setFailure(null);
              }}
            />
            <View style={styles.seam}>
              {mode === 'swap' ? (
                <Pressable onPress={reversePair} accessibilityRole="button" accessibilityLabel="Reverse pair" style={styles.reverseButton}>
                  <MaterialIcons name="swap-vert" size={17} color={tokens.walletBrand.spot} />
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
                  <Pressable key={item} onPress={() => { setSlippageMode(item); setExtremeConfirmation(''); setFailure(null); }} style={[styles.smallChoice, slippageMode === item && styles.smallChoiceActive]}>
                    <Text style={[styles.smallChoiceText, slippageMode === item && styles.smallChoiceTextActive]}>{item === 'fixed' ? '0.5%' : item}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            {slippageMode === 'custom' ? (
              <TextInput
                value={customSlippage}
                onChangeText={(value) => { setCustomSlippage(value.replace(/[^\d.]/g, '')); setExtremeConfirmation(''); setFailure(null); }}
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
              onChangeText={(value) => { setExtremeConfirmation(value); setFailure(null); }}
              autoCapitalize="characters"
              placeholder="Type CONFIRM for slippage above 15%"
              placeholderTextColor={semantic.text.faint}
              style={styles.confirmInput}
            />
          ) : null}
          {quoteError ? <Text selectable style={styles.errorText}>{quoteError}</Text> : null}
          {failure && failure !== balanceError ? <Text selectable style={styles.errorText}>{failure}</Text> : null}
          <Pressable
            disabled={!canReview}
            onPress={() => {
              Keyboard.dismiss();
              void prepareReview();
            }}
            style={[styles.primaryButton, styles.reviewButton, !canReview && !balanceError && styles.primaryButtonDisabled]}
          >
            <Text style={[styles.primaryButtonText, balanceError && styles.primaryButtonErrorText]}>
              {balanceError ? `Insufficient ${inputToken.symbol} balance` : wallet.connected ? `Review ${mode}` : 'Connect wallet to review'}
            </Text>
          </Pressable>
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
          {tokenLoading ? <ActivityIndicator color={tokens.walletBrand.spot} style={styles.loader} /> : null}
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

  function renderReview() {
    if (!reviewOrder || !wallet.address) return renderProgress();
    const feeToken = reviewOrder.fees.providerFeeMint === inputToken.address
      ? inputToken
      : reviewOrder.fees.providerFeeMint === outputToken.address
        ? outputToken
        : null;
    const providerFee = reviewOrder.fees.providerFeeAtomic && feeToken
      ? `${formatAtomicAmount(reviewOrder.fees.providerFeeAtomic, feeToken.decimals, feeToken.decimals)} ${feeToken.symbol}`
      : reviewOrder.fees.providerFeeAtomic
        ? `${reviewOrder.fees.providerFeeAtomic} atomic units`
        : reviewOrder.fees.providerFeeBps !== null
          ? `${reviewOrder.fees.providerFeeBps} bps`
          : 'Unavailable';
    const route = reviewOrder.route.length > 0
      ? reviewOrder.route.map((part) => part.label).join(' → ')
      : reviewOrder.router === 'unknown' ? 'Jupiter' : reviewOrder.router;
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
          <View style={styles.reviewHero}>
            <Text style={styles.reviewLabel}>You send</Text>
            <Text selectable style={styles.reviewAmount}>{formatAtomicAmount(maximumReviewedInput(reviewOrder), inputToken.decimals, inputToken.decimals)} {inputToken.symbol}</Text>
            <MaterialIcons name="south" size={18} color={tokens.walletBrand.spot} />
            <Text style={styles.reviewLabel}>You receive at least</Text>
            <Text selectable style={styles.reviewReceive}>{formatAtomicAmount(reviewOrder.minimumOutAmountAtomic, outputToken.decimals, outputToken.decimals)} {outputToken.symbol}</Text>
          </View>
          <View style={styles.reviewCard}>
            <MetricRow label="Wallet · Solana" value={`${shortAddress(wallet.address)} · ${wallet.source === 'privy' ? 'myboon' : 'External'}`} />
            <View style={styles.metricGrid}>
              <ReviewMetric label="Expected output" value={`${formatAtomicAmount(reviewOrder.outAmountAtomic, outputToken.decimals, outputToken.decimals)} ${outputToken.symbol}`} />
              <ReviewMetric label="Price impact" value={formatPercent(reviewOrder.priceImpactPct)} />
              <ReviewMetric label="Slippage" value={`${(reviewOrder.slippageBps / 100).toFixed(2)}%`} />
              <ReviewMetric label="Route" value={route} />
              <ReviewMetric label="Jupiter/router fee" value={providerFee} />
              <ReviewMetric label="Network fee" value={lamportsToSol(reviewOrder.fees.signatureFeeLamports)} />
              <ReviewMetric label="Priority fee" value={lamportsToSol(reviewOrder.fees.priorityFeeLamports)} />
              <ReviewMetric label="Account rent" value={lamportsToSol(reviewOrder.fees.rentFeeLamports)} />
              <ReviewMetric label="myboon fee" value="0" positive />
            </View>
          </View>
          {balanceChanges.length ? (
            <View style={styles.changeCard}>
              {balanceChanges.map((change) => (
                <MetricRow
                  key={change.mint}
                  label={`${change.mint === inputToken.address ? inputToken.symbol : outputToken.symbol} after simulation`}
                  value={`${formatAtomicAmount(change.beforeAtomic, change.decimals, change.decimals)} → ${formatAtomicAmount(change.afterAtomic, change.decimals, change.decimals)}`}
                />
              ))}
            </View>
          ) : null}
          {simulationWarning ? (
            <Text selectable style={styles.warning}>{simulationWarning}{simulationWarningAccepted ? ' Confirm again to continue.' : ''}</Text>
          ) : null}
          <Text style={styles.reviewHint}>The next step opens your selected wallet to approve this exact transaction.</Text>
          <Pressable onPress={() => void confirmTrade()} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>{simulationWarning && !simulationWarningAccepted ? 'Acknowledge simulation warning' : `Confirm ${mode}`}</Text>
          </Pressable>
      </ScrollView>
    );
  }

  function renderProgress() {
    const copy = statusCopy(phase);
    return (
      <View style={styles.statusBody}>
          <ActivityIndicator size="large" color={tokens.walletBrand.spot} />
          <Text style={styles.statusTitle}>{copy.title}</Text>
          <Text style={styles.statusDetail}>{copy.detail}</Text>
          <Text selectable style={styles.statusPair}>{amount || '0'} {inputToken.symbol} → {outputToken.symbol}</Text>
          {terminalSignature ? (
            <Pressable onPress={() => void Linking.openURL(`https://solscan.io/tx/${encodeURIComponent(terminalSignature)}`)}>
              <Text style={styles.explorerLink}>View submitted transaction</Text>
            </Pressable>
          ) : null}
      </View>
    );
  }

  function renderTerminal() {
    const confirmed = phase === 'confirmed';
    const unknown = phase === 'unknown';
    const title = confirmed ? 'Swap confirmed' : unknown ? 'Outcome unknown' : 'Swap not completed';
    const detail = confirmed
      ? 'Balances have been refreshed.'
      : unknown
        ? 'This transaction may already have landed. Do not submit it again.'
        : failure ?? 'Your pair and amount are preserved.';
    return (
      <View style={styles.statusBody}>
          <View style={[styles.statusMark, confirmed && styles.statusMarkSuccess, unknown && styles.statusMarkUnknown]}>
            <MaterialIcons name={confirmed ? 'check' : unknown ? 'schedule' : 'close'} size={28} color={confirmed ? semantic.sentiment.positive : unknown ? semantic.text.accentDim : semantic.sentiment.negative} />
          </View>
          <Text style={styles.statusTitle}>{title}</Text>
          <Text selectable style={styles.statusDetail}>{resultMessage ?? detail}</Text>
          {unknownRequestId ? <Text selectable style={styles.requestId}>Request {unknownRequestId.slice(0, 10)}…</Text> : null}
          {terminalSignature ? (
            <Pressable onPress={() => void Linking.openURL(`https://solscan.io/tx/${encodeURIComponent(terminalSignature)}`)}>
              <Text style={styles.explorerLink}>View on Solscan</Text>
            </Pressable>
          ) : null}
          {phase === 'failed' ? (
            <Pressable onPress={() => { setReviewOrder(null); setPhase('compose'); }} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Refresh quote and try again</Text>
            </Pressable>
          ) : unknown ? (
            <Pressable onPress={close} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Close · keep pending</Text>
            </Pressable>
          ) : (
            <Pressable onPress={close} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>{caller === 'spot' ? 'Back to token' : 'Back to Wallet'}</Text>
            </Pressable>
          )}
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.overlay}
      behavior="padding"
      enabled={phase === 'compose' || phase === 'picker'}
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
  invalid = false,
  onAmount,
  onAsset,
  onMax,
}: {
  label: string;
  token: SwapToken;
  balanceAtomic?: string;
  amount: string;
  usd: number | null;
  editable: boolean;
  locked: boolean;
  invalid?: boolean;
  onAmount: (value: string) => void;
  onAsset: () => void;
  onMax?: () => void;
}) {
  return (
    <View style={styles.assetBlock}>
      <View style={styles.assetMeta}>
        <Text style={styles.assetLabel}>{label}</Text>
        <View style={styles.balanceRow}>
          <Text style={styles.balanceText}>Balance {balanceAtomic ? formatAtomicAmount(balanceAtomic, token.decimals, 6) : '—'}</Text>
          {onMax && balanceAtomic ? <Pressable onPress={onMax}><Text style={styles.maxText}>Max</Text></Pressable> : null}
        </View>
      </View>
      <View style={styles.assetMain}>
        <Pressable disabled={locked} onPress={onAsset} style={[styles.assetSelector, locked && styles.assetSelectorLocked]}>
          <TokenAvatar token={token} size={26} />
          <Text style={styles.assetSymbol}>{token.symbol}</Text>
          {!locked ? <MaterialIcons name="expand-more" size={17} color={semantic.text.dim} /> : null}
        </Pressable>
        <View style={styles.amountColumn}>
          {editable ? (
            <TextInput
              value={amount}
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

function ReviewMetric({ label, value, positive = false }: { label: string; value: string; positive?: boolean }) {
  return (
    <View style={styles.reviewMetric}>
      <Text style={styles.reviewMetricLabel}>{label}</Text>
      <Text selectable style={[styles.reviewMetricValue, positive && styles.metricPositive]}>{value}</Text>
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
  maxText: { color: semantic.text.accentDim, fontFamily: 'monospace', fontSize: 8, fontWeight: '800' },
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
  reverseButton: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: semantic.background.screen, backgroundColor: semantic.background.lift },
  quoteCard: { borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 9, borderCurve: 'continuous', backgroundColor: semantic.background.surface, overflow: 'hidden' },
  metricRow: { minHeight: 34, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: semantic.border.muted },
  metricLabel: { color: semantic.text.dim, fontSize: 10 },
  metricValue: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 9, fontWeight: '700', textAlign: 'right', fontVariant: ['tabular-nums'] },
  metricPositive: { color: semantic.sentiment.positive },
  slippageRow: { minHeight: 38, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  slippageOptions: { flexDirection: 'row', gap: 4 },
  smallChoice: { minHeight: 27, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: semantic.border.muted, borderRadius: tokens.radius.sm },
  smallChoiceActive: { borderColor: tokens.walletBrand.spot, backgroundColor: 'rgba(153,69,255,0.12)' },
  smallChoiceText: { color: semantic.text.dim, fontFamily: 'monospace', fontSize: 8, textTransform: 'capitalize' },
  smallChoiceTextActive: { color: semantic.text.primary },
  customInput: { minHeight: 38, paddingHorizontal: 10, color: semantic.text.primary, textAlign: 'right', fontFamily: 'monospace', fontSize: 11, borderTopWidth: 1, borderTopColor: semantic.border.muted },
  warning: { color: semantic.text.accentDim, fontSize: 10, lineHeight: 15, textAlign: 'center' },
  confirmInput: { minHeight: 42, paddingHorizontal: 11, borderWidth: 1, borderColor: semantic.text.accentDim, borderRadius: 8, color: semantic.text.primary, fontFamily: 'monospace', fontSize: 10, textAlign: 'center' },
  errorText: { color: semantic.sentiment.negative, fontSize: 10, lineHeight: 15, textAlign: 'center' },
  primaryButton: { minHeight: 48, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderCurve: 'continuous', backgroundColor: tokens.walletBrand.spot },
  reviewButton: { backgroundColor: tokens.colors.walletCore },
  primaryButtonDisabled: { opacity: 0.35 },
  primaryButtonText: { color: semantic.text.primary, fontSize: 13, fontWeight: '900', letterSpacing: 0.4, textTransform: 'capitalize' },
  primaryButtonErrorText: { color: semantic.sentiment.negative },
  searchInput: { minHeight: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: tokens.walletBrand.spot, borderRadius: 9, color: semantic.text.primary, fontSize: 13, backgroundColor: semantic.background.surface },
  loader: { paddingVertical: 12 },
  tokenList: { maxHeight: 390 },
  tokenResult: { minHeight: 54, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: semantic.border.muted },
  tokenResultCopy: { flex: 1, minWidth: 0, gap: 2 },
  tokenSymbol: { color: semantic.text.primary, fontSize: 13, fontWeight: '800' },
  tokenName: { color: semantic.text.dim, fontSize: 10 },
  mintText: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8 },
  tokenFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.walletBrand.spot },
  tokenFallbackText: { color: semantic.text.primary, fontSize: 11, fontWeight: '900' },
  reviewHero: { alignItems: 'center', gap: 4, paddingVertical: 4 },
  reviewLabel: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8, letterSpacing: 1, textTransform: 'uppercase' },
  reviewAmount: { color: semantic.text.primary, fontSize: 25, fontWeight: '900', fontVariant: ['tabular-nums'] },
  reviewReceive: { color: semantic.sentiment.positive, fontSize: 21, fontWeight: '900', fontVariant: ['tabular-nums'] },
  reviewCard: { borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 9, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: semantic.background.surface },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  reviewMetric: { width: '33.333%', minHeight: 50, padding: 8, justifyContent: 'center', gap: 4, borderRightWidth: StyleSheet.hairlineWidth, borderTopWidth: StyleSheet.hairlineWidth, borderColor: semantic.border.muted },
  reviewMetricLabel: { color: semantic.text.faint, fontSize: 8 },
  reviewMetricValue: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 9, fontWeight: '800', fontVariant: ['tabular-nums'] },
  changeCard: { borderWidth: 1, borderColor: semantic.border.muted, borderRadius: 9, overflow: 'hidden', backgroundColor: semantic.background.surface },
  reviewHint: { color: semantic.text.faint, fontSize: 9, lineHeight: 14, textAlign: 'center' },
  statusBody: { minHeight: 250, padding: 20, alignItems: 'center', justifyContent: 'center', gap: 10 },
  statusTitle: { color: semantic.text.primary, fontSize: 20, fontWeight: '900', textAlign: 'center' },
  statusDetail: { maxWidth: 310, color: semantic.text.dim, fontSize: 11, lineHeight: 17, textAlign: 'center' },
  statusPair: { color: semantic.text.primary, fontFamily: 'monospace', fontSize: 10, fontVariant: ['tabular-nums'] },
  statusMark: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(239,71,111,0.5)', backgroundColor: 'rgba(239,71,111,0.08)' },
  statusMarkSuccess: { borderColor: 'rgba(6,214,160,0.5)', backgroundColor: 'rgba(6,214,160,0.08)' },
  statusMarkUnknown: { borderColor: 'rgba(255,209,102,0.5)', backgroundColor: 'rgba(255,209,102,0.08)' },
  requestId: { color: semantic.text.faint, fontFamily: 'monospace', fontSize: 8 },
  explorerLink: { color: semantic.text.accentDim, fontSize: 10, fontWeight: '800', textDecorationLine: 'underline' },
});
