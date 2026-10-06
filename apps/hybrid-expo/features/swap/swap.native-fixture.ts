import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import {
  createMemorySwapPendingStorage,
  createSwapPendingStore,
} from '@/features/swap/swap.pending';
import type { SwapControllerDependencies } from '@/features/swap/swap.controller.dependencies';
import type {
  SwapExecuteResponse,
  SwapOrderRequest,
  SwapOrderResponse,
  SwapToken,
} from '@/features/swap/swap.types';

export const NATIVE_FIXTURE_SOL = 'So11111111111111111111111111111111111111112';
export const NATIVE_FIXTURE_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type SwapNativeFixtureCase =
  | 'solana'
  | 'guest'
  | 'evm-only'
  | 'dual'
  | 'balances-loading'
  | 'balances-failed'
  | 'quote-failed'
  | 'quote-expired'
  | 'quote-out-of-order'
  | 'approval-rejected'
  | 'confirmed'
  | 'execution-failed'
  | 'unknown-recovery'
  | 'validation-refused'
  | 'simulation-refused'
  | 'simulation-unavailable';

export const SWAP_NATIVE_FIXTURE_CASES: {
  id: SwapNativeFixtureCase;
  label: string;
}[] = [
  { id: 'solana', label: 'Solana wallet' },
  { id: 'guest', label: 'Guest / disconnected' },
  { id: 'evm-only', label: 'EVM-only wallet' },
  { id: 'dual', label: 'Dual-chain wallet' },
  { id: 'balances-loading', label: 'Balances loading' },
  { id: 'balances-failed', label: 'Balances failed' },
  { id: 'quote-failed', label: 'Quote failed' },
  { id: 'quote-expired', label: 'Quote expired' },
  { id: 'quote-out-of-order', label: 'Quote out of order' },
  { id: 'approval-rejected', label: 'Approval rejected' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'execution-failed', label: 'Execution failed' },
  { id: 'unknown-recovery', label: 'Unknown / recover' },
  { id: 'validation-refused', label: 'Validation refused' },
  { id: 'simulation-refused', label: 'Simulation refused' },
  { id: 'simulation-unavailable', label: 'Simulation unavailable' },
];

export interface NativeSwapFixture {
  dependencies: SwapControllerDependencies;
  walletAddress: string;
  setPendingConfirmed: () => void;
  subscribe: (listener: () => void) => () => void;
  getCallCountsSnapshot: () => string;
  getCallCounts: () => {
    quote: number;
    order: number;
    sign: number;
    execute: number;
    search: number;
    prices: number;
    refresh: number;
    walletSheet: number;
  };
}

function transactionFor(key: Keypair): VersionedTransaction {
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: key.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [],
    }).compileToV0Message(),
  );
}

function responseFor(
  request: SwapOrderRequest,
  transaction: VersionedTransaction,
  expiresAt: string,
  requestId: string,
): SwapOrderResponse {
  const inputDecimals = request.inputMint === NATIVE_FIXTURE_SOL ? 9 : 6;
  const outputDecimals = request.outputMint === NATIVE_FIXTURE_SOL ? 9 : 6;
  const inputUi = Number(request.amountAtomic) / 10 ** inputDecimals;
  const outputUi = request.inputMint === NATIVE_FIXTURE_SOL ? inputUi * 150 : inputUi / 150;
  const outputAtomic = Math.max(1, Math.round(outputUi * 10 ** outputDecimals)).toString();
  const minimumAtomic = ((BigInt(outputAtomic) * 995n) / 1000n).toString();
  const base = {
    requestId,
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inAmountAtomic: request.amountAtomic,
    outAmountAtomic: outputAtomic,
    minimumOutAmountAtomic: minimumAtomic,
    inUsdValue: inputUi * (request.inputMint === NATIVE_FIXTURE_SOL ? 150 : 1),
    outUsdValue: outputUi * (request.outputMint === NATIVE_FIXTURE_SOL ? 150 : 1),
    priceImpactPct: 0.02,
    slippageBps: request.slippageBps ?? 50,
    router: 'metis' as const,
    route: [{ label: 'Disposable fixture route', percent: 100 }],
    fees: {
      providerFeeBps: 0,
      providerFeeAtomic: '0',
      providerFeeMint: request.inputMint,
      signatureFeeLamports: '5000',
      priorityFeeLamports: '0',
      rentFeeLamports: '0',
      myboonFeeAtomic: '0' as const,
      gasless: false,
    },
    expiresAt,
  };
  return request.taker
    ? {
        ...base,
        kind: 'signable',
        taker: request.taker,
        transaction: Buffer.from(transaction.serialize()).toString('base64'),
        lastValidBlockHeight: '1000',
      }
    : {
        ...base,
        kind: 'quote',
        taker: null,
        transaction: null,
        lastValidBlockHeight: null,
      };
}

/**
 * Creates a local-only controller dependency set. Every wallet, transaction,
 * balance, order, storage and execution result is disposable fixture state.
 */
export function createNativeSwapFixture(
  fixtureCase: SwapNativeFixtureCase = 'solana',
): NativeSwapFixture {
  const key = Keypair.generate();
  const walletAddress = key.publicKey.toBase58();
  const transaction = transactionFor(key);
  const storage = createMemorySwapPendingStorage();
  const store = createSwapPendingStore(storage);
  const state = {
    balanceCalls: 0,
    quoteCalls: 0,
    orderCalls: 0,
    signCalls: 0,
    executeCalls: 0,
    searchCalls: 0,
    priceCalls: 0,
    refreshCalls: 0,
    walletSheetCalls: 0,
    pendingConfirmed: false,
    orders: new Map<string, { input: string; output: string }>(),
  };
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const tokens: SwapToken[] = [
    { address: NATIVE_FIXTURE_SOL, symbol: 'SOL', name: 'Fixture SOL', decimals: 9 },
    { address: NATIVE_FIXTURE_USDC, symbol: 'USDC', name: 'Fixture USD Coin', decimals: 6 },
  ];
  const disconnected = fixtureCase === 'guest' || fixtureCase === 'evm-only';
  const balancesUnavailable = fixtureCase === 'balances-failed';
  const wallet = {
    connected: !disconnected,
    address: disconnected ? null : walletAddress,
    shortAddress: disconnected ? null : 'FIXT···WALLET',
    sessionKey: disconnected ? 'fixture:disconnected' : `fixture:${walletAddress}`,
    source: fixtureCase === 'evm-only' ? 'privy' : 'mwa',
    isPreparing: false,
    connection: null,
    walletOptions: [],
    connect: async () => emit(),
    disconnect: async () => emit(),
    signMessage: async () => new Uint8Array(),
    signAndSendTransaction: null,
    signTransaction: async (unsigned: VersionedTransaction) => {
      state.signCalls += 1;
      emit();
      if (fixtureCase === 'approval-rejected') throw new Error('User rejected the fixture approval.');
      unsigned.sign([key]);
      return unsigned;
    },
  } as unknown as NonNullable<SwapControllerDependencies['wallet']>;
  const walletSheet = {
    isOpen: false,
    open: () => { state.walletSheetCalls += 1; emit(); },
    close: () => {},
  };
  const rpc = {
    getBlockHeight: async () => 100,
    getSignatureStatuses: async () => {
      if (fixtureCase === 'unknown-recovery' && !state.pendingConfirmed) {
        throw new Error('Fixture status is intentionally unavailable.');
      }
      return {
        value: [
          state.pendingConfirmed
            ? { err: null, confirmationStatus: 'confirmed' }
            : null,
        ],
      };
    },
  } as unknown as Connection;
  const createOrder = async (request: SwapOrderRequest) => {
    if (request.taker) state.orderCalls += 1;
    else state.quoteCalls += 1;
    emit();
    if (fixtureCase === 'quote-failed' && !request.taker && state.quoteCalls === 1)
      throw new Error('Fixture quote service unavailable.');
    if (fixtureCase === 'quote-out-of-order' && !request.taker && state.quoteCalls === 1)
      await new Promise((resolve) => setTimeout(resolve, 900));
    const expiresAt =
      fixtureCase === 'quote-expired' && state.quoteCalls === 1
        ? new Date(Date.now() - 1_000).toISOString()
        : new Date(Date.now() + 60_000).toISOString();
    const requestId = `native-fixture-${request.taker ? 'order' : 'quote'}-${request.taker ? state.orderCalls : state.quoteCalls}`;
    const response = responseFor(request, transaction, expiresAt, requestId);
    if (response.kind === 'signable') {
      state.orders.set(requestId, {
        input: response.inAmountAtomic,
        output: response.outAmountAtomic,
      });
    }
    return response;
  };
  const execute = async (request: { requestId: string }): Promise<SwapExecuteResponse> => {
    state.executeCalls += 1;
    emit();
    const amounts = state.orders.get(request.requestId);
    if (fixtureCase === 'execution-failed') {
      return {
        outcome: 'failed',
        signature: null,
        slot: null,
        code: 4901,
        message: 'Fixture execution failed.',
        totalInputAmountAtomic: null,
        totalOutputAmountAtomic: null,
        inputAmountResultAtomic: null,
        outputAmountResultAtomic: null,
      };
    }
    if (fixtureCase === 'unknown-recovery') {
      return {
        outcome: 'unknown',
        signature: 'fixture-signature',
        slot: null,
        code: 4902,
        message: 'Fixture submission status is unknown.',
        totalInputAmountAtomic: null,
        totalOutputAmountAtomic: null,
        inputAmountResultAtomic: null,
        outputAmountResultAtomic: null,
      };
    }
    return {
      outcome: 'confirmed',
      signature: 'fixture-signature',
      slot: '1',
      code: null,
      message: null,
      totalInputAmountAtomic: amounts?.input ?? null,
      totalOutputAmountAtomic: amounts?.output ?? null,
      inputAmountResultAtomic: amounts?.input ?? null,
      outputAmountResultAtomic: amounts?.output ?? null,
    };
  };
  const dependencies: SwapControllerDependencies = {
    wallet,
    walletSheet,
    rpc,
    pendingStore: store,
    getWalletBalances: async () => {
      state.balanceCalls += 1;
      emit();
      if (fixtureCase === 'balances-loading') await new Promise((resolve) => setTimeout(resolve, 1_500));
      if (balancesUnavailable && state.balanceCalls === 1)
        throw new Error('Fixture balances are unavailable.');
      return { [NATIVE_FIXTURE_SOL]: '3000000000', [NATIVE_FIXTURE_USDC]: '1000000000' };
    },
    createSwapOrder: createOrder,
    executeSwap: execute,
    searchSwapTokens: async () => {
      state.searchCalls += 1;
      emit();
      return tokens;
    },
    fetchTokenPrices: async () => {
      state.priceCalls += 1;
      emit();
      return {
      prices: [
        { mint: NATIVE_FIXTURE_SOL, usdPrice: 150 },
        { mint: NATIVE_FIXTURE_USDC, usdPrice: 1 },
      ],
      };
    },
    validateSwapTransactionForSigning: async (input) => {
      if (fixtureCase === 'validation-refused') throw new Error('Fixture validation refused.');
      return { transaction, resolvedAddressLookupTableAccounts: [] };
    },
    simulateValidatedSwap: async () => {
      if (fixtureCase === 'simulation-refused') throw new Error('Fixture simulation refused.');
      const balanceChanges = {
        nativeLamports: { before: '0', after: '0', delta: '0' },
        tokens: [],
      };
      return fixtureCase === 'simulation-unavailable'
        ? { balanceChanges, unavailableWarning: 'Fixture simulation is unavailable.' }
        : { balanceChanges };
    },
    finalizeWalletSignedSwapTransaction: async ({ signedTransaction }) => signedTransaction,
    notifyWalletDataChanged: () => { state.refreshCalls += 1; emit(); },
    notifySuccess: () => {},
  };
  return {
    dependencies,
    walletAddress,
    setPendingConfirmed: () => {
      state.pendingConfirmed = true;
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getCallCountsSnapshot: () => JSON.stringify({
      quote: state.quoteCalls,
      order: state.orderCalls,
      sign: state.signCalls,
      execute: state.executeCalls,
      search: state.searchCalls,
      prices: state.priceCalls,
      refresh: state.refreshCalls,
      walletSheet: state.walletSheetCalls,
    }),
    getCallCounts: () => ({
      quote: state.quoteCalls,
      order: state.orderCalls,
      sign: state.signCalls,
      execute: state.executeCalls,
      search: state.searchCalls,
      prices: state.priceCalls,
      refresh: state.refreshCalls,
      walletSheet: state.walletSheetCalls,
    }),
  };
}
