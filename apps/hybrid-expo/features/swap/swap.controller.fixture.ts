// Node-only test harness. Not imported by the application or selectable in a build.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';
import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import * as math from './swap.math';
import * as pending from './swap.pending';
import * as core from './swap.controller.core';
import type { SwapController, SwapControllerOptions } from './useSwapController';
import type {
  SwapExecuteResponse,
  SwapOrderRequest,
  SwapOrderResponse,
  SwapToken,
} from './swap.types';

const require = createRequire(import.meta.url);
export const fixtureSol = 'So11111111111111111111111111111111111111112';
export const fixtureUsdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function createControllerFixture(
  initialOptions: SwapControllerOptions = {},
  strict = false,
) {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const key = Keypair.generate();
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: key.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [],
    }).compileToV0Message(),
  );
  const memoryStorage = pending.createMemorySwapPendingStorage();
  const storage = {
    getItem: async (name: string) => {
      if (fixture.storageReadError) throw fixture.storageReadError;
      return memoryStorage.getItem(name);
    },
    setItem: async (name: string, value: string) => {
      if (fixture.storageWriteRequest) await fixture.storageWriteRequest();
      return memoryStorage.setItem(name, value);
    },
  };
  const store = pending.createSwapPendingStore(storage);
  const listeners = new Set<(state: string) => void>();
  const calls = {
    quotes: [] as SwapOrderRequest[],
    orders: [] as SwapOrderRequest[],
    sign: 0,
    execute: 0,
    validate: 0,
    simulate: 0,
    refresh: 0,
    connect: 0,
    balance: 0,
  };
  const tokens: SwapToken[] = [
    { address: fixtureSol, name: 'Solana', symbol: 'SOL', decimals: 9 },
    { address: fixtureUsdc, name: 'USD Coin', symbol: 'USDC', decimals: 6 },
  ];
  const fixture = {
    calls,
    store,
    tokens,
    storageReadError: null as Error | null,
    storageWriteRequest: null as null | (() => Promise<void>),
    balances: { [fixtureSol]: '3000000000', [fixtureUsdc]: '1000000000' } as Record<string, string>,
    balanceError: null as Error | null,
    balanceRequest: null as null | (() => Promise<Record<string, string>>),
    quoteRequest: null as null | ((request: SwapOrderRequest) => Promise<SwapOrderResponse>),
    orderRequest: null as null | ((request: SwapOrderRequest) => Promise<SwapOrderResponse>),
    searchRequest: null as null | ((query: string) => Promise<SwapToken[]>),
    validationError: null as Error | null,
    simulationError: null as Error | null,
    simulationWarning: null as string | null,
    signatureStatus: null as null | { err: unknown; confirmationStatus: string },
    statusError: null as Error | null,
    blockHeight: 100,
    executionOutcome: 'confirmed' as 'confirmed' | 'failed' | 'unknown',
    executeRequest: null as null | (() => Promise<SwapExecuteResponse>),
    signError: null as Error | null,
    signRequest: null as null | (() => Promise<VersionedTransaction>),
    wallet: {} as SwapController['wallet'],
    walletSheet: {
      isOpen: false,
      open: () => {
        calls.connect++;
      },
      close: () => {},
    },
  };
  function executionResult(): SwapExecuteResponse {
    return {
      outcome: fixture.executionOutcome,
      signature: 'fixture-signature',
      slot: '123',
      code: null,
      message: fixture.executionOutcome === 'failed' ? 'Fixture execution failed' : null,
      totalInputAmountAtomic: '1000000000',
      totalOutputAmountAtomic: '150000000',
      inputAmountResultAtomic: '1000000000',
      outputAmountResultAtomic: '150000000',
    };
  }
  const rpc = {
    getBlockHeight: async () => fixture.blockHeight,
    getSignatureStatuses: async () => {
      if (fixture.statusError) throw fixture.statusError;
      return { value: [fixture.signatureStatus] };
    },
  };
  fixture.wallet = {
    connected: true,
    address: key.publicKey.toBase58(),
    shortAddress: 'test',
    sessionKey: `mwa:${key.publicKey.toBase58()}`,
    source: 'mwa',
    isPreparing: false,
    connection: rpc,
    walletOptions: [],
    connect: async () => {},
    disconnect: async () => {},
    signMessage: async () => new Uint8Array(),
    signAndSendTransaction: null,
    signTransaction: async () => {
      calls.sign++;
      if (fixture.signError) throw fixture.signError;
      if (fixture.signRequest) return fixture.signRequest();
      transaction.sign([key]);
      return transaction;
    },
  } as unknown as SwapController['wallet'];
  const baseOrder = (request: SwapOrderRequest): SwapOrderResponse =>
    ({
      kind: request.taker ? 'signable' : 'quote',
      requestId: `fixture-${calls.orders.length}-${calls.quotes.length}`,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmountAtomic: request.amountAtomic,
      outAmountAtomic: '150000000',
      minimumOutAmountAtomic: '149250000',
      inUsdValue: 150,
      outUsdValue: 150,
      priceImpactPct: 0.02,
      slippageBps: request.slippageBps ?? 50,
      router: 'metis',
      route: [{ label: 'Fixture route', percent: 100 }],
      fees: {
        providerFeeBps: 0,
        providerFeeAtomic: '0',
        providerFeeMint: request.inputMint,
        signatureFeeLamports: '5000',
        priorityFeeLamports: '0',
        rentFeeLamports: '0',
        myboonFeeAtomic: '0',
        gasless: false,
      },
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      taker: request.taker ?? null,
      transaction: request.taker ? Buffer.from(transaction.serialize()).toString('base64') : null,
      lastValidBlockHeight: request.taker ? '1000' : null,
    }) as SwapOrderResponse;
  class SwapApiError extends Error {
    code = 'FIXTURE_ERROR';
  }
  const api = {
    SwapApiError,
    createSwapOrder: async (request: SwapOrderRequest) => {
      if (request.taker) {
        calls.orders.push(request);
        return fixture.orderRequest ? fixture.orderRequest(request) : baseOrder(request);
      }
      calls.quotes.push(request);
      return fixture.quoteRequest ? fixture.quoteRequest(request) : baseOrder(request);
    },
    executeSwap: async () => {
      calls.execute++;
      return fixture.executeRequest ? fixture.executeRequest() : executionResult();
    },
    fetchSwapTokens: async () => tokens,
    searchSwapTokens: async (query: string) =>
      fixture.searchRequest ? fixture.searchRequest(query) : tokens,
    fetchTokenPrices: async () => ({
      prices: [
        { mint: fixtureSol, usdPrice: 150 },
        { mint: fixtureUsdc, usdPrice: 1 },
      ],
    }),
  };
  class SpotDataApiClient {
    clearCache() {}
    async getWalletBalances() {
      calls.balance++;
      if (fixture.balanceError) throw fixture.balanceError;
      const values = fixture.balanceRequest ? await fixture.balanceRequest() : fixture.balances;
      return {
        data: { tokens: Object.entries(values).map(([mint, amount]) => ({ mint, amount })) },
      };
    }
  }
  const mocks: Record<string, unknown> = {
    react: React,
    'react-native': {
      AppState: {
        addEventListener: (_: string, listener: (state: string) => void) => {
          listeners.add(listener);
          return { remove: () => listeners.delete(listener) };
        },
      },
    },
    '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
    'expo-haptics': {
      NotificationFeedbackType: { Success: 'success' },
      notificationAsync: async () => {},
    },
    '@myboon/shared/spot': { SpotDataApiClient },
    '@/features/swap/swap.api': api,
    '@/features/swap/swap.math': math,
    '@/features/swap/swap.pending': pending,
    '@/features/swap/swap.controller.core': core,
    '@/features/swap/swap-transaction-validation': {
      validateSwapTransactionForSigning: async () => {
        calls.validate++;
        if (fixture.validationError) throw fixture.validationError;
        return { transaction };
      },
      simulateValidatedSwap: async () => {
        calls.simulate++;
        if (fixture.simulationError) throw fixture.simulationError;
        return { unavailableWarning: fixture.simulationWarning };
      },
      finalizeWalletSignedSwapTransaction: async ({
        signedTransaction,
      }: {
        signedTransaction: VersionedTransaction;
      }) => signedTransaction,
    },
    '@/features/wallet/WalletSheetProvider': { useWalletSheet: () => fixture.walletSheet },
    '@/features/wallet/wallet.refresh': {
      notifyWalletDataChanged: () => {
        calls.refresh++;
      },
    },
    '@/features/perps/pacific.config': { SOLANA_RPC: 'http://fixture.invalid' },
    '@/hooks/useWallet': { useWallet: () => fixture.wallet },
    '@/lib/api': { resolveApiBaseUrl: () => 'http://fixture.invalid' },
  };
  // Evaluate the actual production hook, replacing only platform/service imports.
  // Transaction safety is independently verified by swap-transaction-validation.test.ts.
  const source = ts.transpileModule(
    readFileSync(new URL('./useSwapController.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const exports: { useSwapController?: (options: SwapControllerOptions) => SwapController } = {};
  runInNewContext(
    source,
    {
      exports,
      require: (name: string) => (name in mocks ? mocks[name] : require(name)),
      Buffer,
      AbortController,
      Date,
      Error,
      setTimeout,
      clearTimeout,
    },
    { filename: 'useSwapController.fixture.js' },
  );
  const hook = exports.useSwapController!;
  let options = initialOptions;
  let current!: SwapController;
  let renderer!: ReactTestRenderer;
  function Harness() {
    current = hook(options);
    return null;
  }
  const element = () =>
    strict
      ? React.createElement(React.StrictMode, null, React.createElement(Harness))
      : React.createElement(Harness);
  await act(async () => {
    renderer = create(element());
  });
  return {
    fixture,
    baseOrder,
    get current() {
      return current;
    },
    async update(next: SwapControllerOptions = options) {
      options = next;
      await act(async () => {
        renderer.update(element());
      });
    },
    async run(action: (controller: SwapController) => void | Promise<void>) {
      await act(async () => {
        await action(current);
      });
    },
    async settle(ms = 0) {
      await act(async () => {
        if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
        else await Promise.resolve();
      });
    },
    async resume() {
      await act(async () => {
        for (const listener of listeners) listener('active');
      });
    },
    async dispose() {
      await act(async () => renderer.unmount());
    },
  };
}
