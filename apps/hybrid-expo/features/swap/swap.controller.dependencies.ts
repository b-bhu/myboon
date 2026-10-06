import type { Connection } from '@solana/web3.js';
import type { useWallet } from '@/hooks/useWallet';
import type { useWalletSheet } from '@/features/wallet/WalletSheetProvider';
import type { SwapPendingStore } from '@/features/swap/swap.pending';
import type {
  SwapExecuteResponse,
  SwapOrderRequest,
  SwapOrderResponse,
  SwapToken,
} from '@/features/swap/swap.types';
import type {
  finalizeWalletSignedSwapTransaction,
  simulateValidatedSwap,
  validateSwapTransactionForSigning,
} from '@/features/swap/swap-transaction-validation';

/**
 * Optional seams for deterministic, disposable verification fixtures.
 * Production callers omit this object and retain the normal wallet, API, RPC,
 * storage, validation and signing implementations.
 */
export interface SwapControllerDependencies {
  wallet?: ReturnType<typeof useWallet>;
  walletSheet?: Pick<ReturnType<typeof useWalletSheet>, 'isOpen' | 'open' | 'close'>;
  /** Fixture RPC must implement the validation/simulation methods it exposes. */
  rpc?: Connection;
  pendingStore?: SwapPendingStore;
  getWalletBalances?: (address: string) => Promise<Record<string, string>>;
  createSwapOrder?: (
    request: SwapOrderRequest,
    signal?: AbortSignal,
  ) => Promise<SwapOrderResponse>;
  executeSwap?: (request: {
    signedTransaction: string;
    requestId: string;
    lastValidBlockHeight: string;
  }) => Promise<SwapExecuteResponse>;
  searchSwapTokens?: (query: string) => Promise<SwapToken[]>;
  fetchTokenPrices?: (mints: string[]) => Promise<{
    prices: { mint: string; usdPrice: number | null }[];
  }>;
  validateSwapTransactionForSigning?: typeof validateSwapTransactionForSigning;
  simulateValidatedSwap?: typeof simulateValidatedSwap;
  finalizeWalletSignedSwapTransaction?: typeof finalizeWalletSignedSwapTransaction;
  notifyWalletDataChanged?: () => void;
  notifySuccess?: () => Promise<void> | void;
}
