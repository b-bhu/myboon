import type { TokenIdentity } from '@/lib/token-identity.core';

export type SwapEntryMode = 'swap' | 'buy' | 'sell';
export type SwapSide = 'input' | 'output';
export type SwapRouter = 'metis' | 'jupiterz' | 'dflow' | 'okx' | 'unknown';

export interface SwapToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  balanceAtomic?: string;
}

export interface SpotTokenSummary {
  identity: TokenIdentity;
  usdPrice: number | null;
  momentumPct: {
    m5: number | null;
    h1: number | null;
    h6: number | null;
    h24: number | null;
  };
  market: {
    marketCapUsd: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
  };
  warnings: {
    verification: 'verified' | 'unverified' | 'unknown';
    organicActivity: 'high' | 'medium' | 'low' | 'unknown';
    suspicious: true | null;
  };
  updatedAt: string | null;
}

export interface SpotTokenSearchResponse {
  query: string;
  items: SpotTokenSummary[];
  asOf: string;
  partial: boolean;
}

export interface SpotPriceResponse {
  prices: {
    mint: string;
    usdPrice: number | null;
    blockId: number | null;
  }[];
  asOf: string;
}

export interface SwapApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string | null;
  };
}

export interface SwapOrderRequest {
  inputMint: string;
  outputMint: string;
  amountAtomic: string;
  taker?: string;
  slippageBps?: number;
}

export interface SwapOrderBase {
  requestId: string;
  inputMint: string;
  outputMint: string;
  inAmountAtomic: string;
  outAmountAtomic: string;
  minimumOutAmountAtomic: string;
  inUsdValue: number | null;
  outUsdValue: number | null;
  priceImpactPct: number | null;
  slippageBps: number;
  router: SwapRouter;
  route: { label: string; percent: number }[];
  fees: {
    providerFeeBps: number | null;
    providerFeeAtomic: string | null;
    providerFeeMint: string | null;
    signatureFeeLamports: string | null;
    priorityFeeLamports: string | null;
    rentFeeLamports: string | null;
    myboonFeeAtomic: '0';
    gasless: boolean;
  };
  expiresAt: string | null;
}

export type SwapOrderResponse = SwapOrderBase & (
  | {
      kind: 'quote';
      taker: null;
      transaction: null;
      lastValidBlockHeight: null;
    }
  | {
      kind: 'signable';
      taker: string;
      transaction: string;
      lastValidBlockHeight: string;
    }
);

export interface SwapExecuteRequest {
  signedTransaction: string;
  requestId: string;
  lastValidBlockHeight?: string;
}

export interface SwapExecuteResponse {
  outcome: 'confirmed' | 'failed' | 'unknown';
  signature: string | null;
  slot: string | null;
  code: number | null;
  message: string | null;
  totalInputAmountAtomic: string | null;
  totalOutputAmountAtomic: string | null;
  inputAmountResultAtomic: string | null;
  outputAmountResultAtomic: string | null;
}

export type SwapExecutionPhase =
  | 'compose'
  | 'picker'
  | 'quoting'
  | 'reviewing'
  | 'ordering'
  | 'validating'
  | 'simulating'
  | 'awaiting_signature'
  | 'executing'
  | 'confirmed'
  | 'failed'
  | 'unknown';

export interface SimulatedBalanceChange {
  mint: string;
  beforeAtomic: string;
  afterAtomic: string;
  decimals: number;
}

export interface PendingSwapExecution {
  version: 1;
  requestId: string;
  walletAddress: string;
  inputMint: string;
  outputMint: string;
  inAmountAtomic: string;
  minimumOutAmountAtomic: string;
  signature: string | null;
  lastValidBlockHeight: string | null;
  outcome: 'submitted' | 'unknown';
  createdAt: string;
  updatedAt: string;
}
