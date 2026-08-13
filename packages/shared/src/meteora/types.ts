import type { Keypair, Transaction } from '@solana/web3.js'
import type { PlaceLimitOrderParams } from '@meteora-ag/dlmm'

export type MeteoraNetwork = 'mainnet-beta' | 'devnet'
export type MeteoraStrategy = 'spot' | 'curve' | 'bid_ask'
export type MeteoraPositionStatus = 'open' | 'closed' | 'all'
export type MeteoraTimeframe = '5m' | '30m' | '1h' | '2h' | '4h' | '12h' | '24h'
export type MeteoraSortDirection = 'asc' | 'desc'

export interface MeteoraClientConfig {
  rpcUrl?: string
  network?: MeteoraNetwork
  dataApiUrl?: string
  fetch?: typeof fetch
  requestTimeoutMs?: number
  maxRetries?: number
  execution?: Partial<MeteoraExecutionDefaults>
}

export interface MeteoraFreshness {
  state: 'live' | 'fresh' | 'stale'
  source: 'meteora_data_api' | 'solana_rpc'
  servedAt: string
  ageMs: number
}

export interface MeteoraResult<T> {
  data: T
  freshness: MeteoraFreshness
}

export interface MeteoraTokenSummary {
  address: string
  symbol: string
  name: string
  decimals: number
  iconUrl: string | null
  verified: boolean
}

/**
 * Token reference for pool legs whose decimals/verified status the upstream
 * endpoint does not actually provide (the portfolio and open-limit-order
 * endpoints, unlike the pool listing endpoint). `MeteoraTokenSummary`
 * hardcoded `decimals: 0` and `verified: true` for these — a fabrication,
 * not a real answer, and anything doing math downstream of those was wrong.
 * This type makes the unknown honest: null, not a guessed value. See
 * docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md.
 */
export interface MeteoraTokenRef {
  address: string
  symbol: string
  name: string
  decimals: number | null
  iconUrl: string | null
  verified: boolean | null
}

export interface MeteoraPoolSummary {
  address: string
  pair: string
  tokenX: MeteoraTokenSummary
  tokenY: MeteoraTokenSummary
  currentPrice: string | null
  tvlUsd: string | null
  volume24hUsd: string | null
  fees24hUsd: string | null
  feeTvl24hPct: string | null
  baseFeePct: string | null
  dynamicFeePct: string | null
  apr24hPct: string | null
  apy24hPct: string | null
  binStep: number
  hasFarm: boolean
  tags: string[]
  approvedByMeteora: boolean
}

export interface MeteoraPoolDetail extends MeteoraPoolSummary {
  reserveX: string
  reserveY: string
  tokenXAmount: string | null
  tokenYAmount: string | null
  maxFeePct: string | null
  protocolFeePct: string | null
  collectFeeMode: number
  rewardMintX: string | null
  rewardMintY: string | null
  createdAt: string | null
}

export interface MeteoraPage<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
  hasNext: boolean
}

export interface MeteoraPoolQuery {
  page?: number
  pageSize?: number
  query?: string
  sortBy?: string
  minTvlUsd?: string
  includeUnverified?: boolean
}

export interface MeteoraProtocolMetrics {
  totalTvlUsd: string
  volume24hUsd: string
  fees24hUsd: string
  totalVolumeUsd: string
  totalFeesUsd: string
  totalPools: number
}

export interface MeteoraOhlcvQuery {
  timeframe?: MeteoraTimeframe
  startTime?: number
  endTime?: number
}

export interface MeteoraOhlcvCandle {
  timestamp: number
  timestampIso: string
  open: string
  high: string
  low: string
  close: string
  volume: string
}

export interface MeteoraOhlcvSeries {
  timeframe: string | null
  startTime: number
  endTime: number
  candles: MeteoraOhlcvCandle[]
}

export interface MeteoraPortfolioPool {
  poolAddress: string
  pair: string
  tokenX: MeteoraTokenRef
  tokenY: MeteoraTokenRef
  binStep: number
  baseFeePct: string
  currentPrice: string | null
  balanceUsd: string
  balanceSol: string | null
  unclaimedFeesUsd: string
  unclaimedFeesSol: string | null
  pnlUsd: string
  pnlPct: string
  totalDepositUsd: string
  openPositionCount: number
  positionAddresses: string[]
  outOfRangePositionAddresses: string[]
  outOfRange: boolean | null
}

export interface MeteoraPortfolio {
  pools: MeteoraPortfolioPool[]
  page: number
  pageSize: number
  totalPools: number
  totalPositions: number
  hasNext: boolean
  totalBalanceUsd: string | null
  totalUnclaimedFeesUsd: string | null
  totalPnlUsd: string | null
  solPriceUsd: string | null
}

export interface MeteoraPortfolioQuery {
  page?: number
  pageSize?: number
  sortBy?: 'current_balances' | 'unclaimed_fee' | 'fee_per_tvl24h'
  sortDirection?: MeteoraSortDirection
}

export interface MeteoraPosition {
  address: string
  minPrice: string
  maxPrice: string
  lowerBinId: number
  upperBinId: number
  activeBinId: number | null
  activePrice: string | null
  isClosed: boolean
  isOutOfRange: boolean | null
  pnlUsd: string
  pnlPct: string
  feeTvl24hPct: string
  createdAt: string | null
  closedAt: string | null
}

export interface MeteoraPositionQuery {
  status?: MeteoraPositionStatus
  page?: number
  pageSize?: number
}

export interface MeteoraPositionEvent {
  signature: string
  instructionIndex: number
  eventType: string
  positionAddress: string
  poolAddress: string
  walletAddress: string
  tokenXSymbol: string
  tokenYSymbol: string
  amountX: string
  amountY: string
  amountXUsd: string
  amountYUsd: string
  totalUsd: string
  blockTime: number
  slot: number
  createdAt: string
}

export interface MeteoraLimitOrderSummary {
  openOrders: number
  closedOrders: number
  totalDepositUsd: string
  totalDepositSol: string
  totalBonusUsd: string
  totalBonusSol: string
}

export interface MeteoraLimitOrderPool {
  poolAddress: string
  pair: string
  tokenX: MeteoraTokenRef
  tokenY: MeteoraTokenRef
  binStep: number
  baseFeePct: string
  totalOrders: number
  fullyFilledOrders: number
  filledPct: string
  totalDepositUsd: string
  totalDepositSol: string
  totalBonusUsd: string
  totalBonusSol: string
}

export interface MeteoraRangeQuote {
  poolAddress: string
  activeBinId: number
  activePrice: string
  requestedMinPrice: string
  requestedMaxPrice: string
  minBinId: number
  maxBinId: number
  executableMinPrice: string
  executableMaxPrice: string
  binCount: number
}

export interface MeteoraBuildCreatePositionInput {
  walletAddress: string
  poolAddress: string
  tokenXAtomic: string
  tokenYAtomic: string
  minBinId: number
  maxBinId: number
  strategy: MeteoraStrategy
  slippageBps?: number
}

export interface MeteoraBuildAddLiquidityInput extends MeteoraBuildCreatePositionInput {
  positionAddress: string
}

export interface MeteoraBuildRemoveLiquidityInput {
  walletAddress: string
  poolAddress: string
  positionAddress: string
  fromBinId: number
  toBinId: number
  removeBps: number
  claimAndClose?: boolean
}

export interface MeteoraBuildPositionActionInput {
  walletAddress: string
  poolAddress: string
  positionAddress: string
}

export interface MeteoraBuildPlaceLimitOrderInput {
  walletAddress: string
  poolAddress: string
  params: Omit<PlaceLimitOrderParams, 'padding'>
}

export interface MeteoraBuildLimitOrderActionInput {
  walletAddress: string
  poolAddress: string
  limitOrderAddress: string
  binIds?: number[]
}

export interface MeteoraTransactionBundle {
  action:
    | 'create_position'
    | 'add_liquidity'
    | 'claim'
    | 'remove_liquidity'
    | 'close_position'
    | 'place_limit_order'
    | 'cancel_limit_order'
    | 'close_limit_order'
    | 'zap_in'
  poolAddress: string
  resourceAddress: string | null
  transactions: Transaction[]
  additionalSigners: Keypair[]
  plan?: MeteoraTransactionPlan
}

export interface MeteoraExecutionDefaults {
  previewTtlMs: number
  liquiditySlippageBps: number
  swapSlippageBps: number
  maxActiveBinSlippage: number
  maxTransferAmountExtendPercentage: number
  maxAccounts: number
  favorXInActiveId: boolean
}

export interface MeteoraExecutionPoolState {
  poolAddress: string
  activeBinId: number
  activePrice: string
  binStep: number
  tokenX: Pick<MeteoraTokenSummary, 'address' | 'symbol' | 'decimals'>
  tokenY: Pick<MeteoraTokenSummary, 'address' | 'symbol' | 'decimals'>
  refreshedAt: string
}

export type MeteoraRangeRequest =
  | {
      kind: 'manual'
      minPrice: string
      maxPrice: string
    }
  | {
      kind: 'meteora_preset'
      /**
       * Meteora's bin delta, supplied by the current Meteora preset definition.
       * myBoon does not translate presets into custom percentages.
       */
      binDelta: number
      label?: string
    }

export interface MeteoraRangePresetDefinition {
  id: string
  label: string
  source: 'meteora'
  /**
   * Null means Meteora has not supplied an exact bin delta and the preset must
   * remain disabled. There is deliberately no myBoon percentage fallback.
   */
  binDelta: number | null
}

export interface MeteoraSnappedRange {
  source: MeteoraRangeRequest['kind']
  requestedMinPrice: string
  requestedMaxPrice: string
  executableMinPrice: string
  executableMaxPrice: string
  minBinId: number
  maxBinId: number
  binCount: number
}

export type MeteoraCreatePositionRequest =
  | {
      poolAddress: string
      strategy: MeteoraStrategy
      range: MeteoraRangeRequest
      depositMode: 'two_token'
      tokenXAmount: string
      tokenYAmount: string
    }
  | {
      poolAddress: string
      strategy: MeteoraStrategy
      range: MeteoraRangeRequest
      depositMode: 'single_sided'
      inputToken: 'x' | 'y'
      amount: string
    }

export interface MeteoraAutoFillRequest {
  poolAddress: string
  strategy: MeteoraStrategy
  range: MeteoraRangeRequest
  inputToken: 'x' | 'y'
  amount: string
}

export interface MeteoraAutoFillQuote {
  poolState: MeteoraExecutionPoolState
  range: MeteoraSnappedRange
  inputToken: 'x' | 'y'
  tokenXAmount: string
  tokenYAmount: string
  tokenXAtomic: string
  tokenYAtomic: string
}

export interface MeteoraPreviewBase {
  schemaVersion: 1
  previewId: string
  inputHash: string
  createdAt: string
  expiresAt: string
  poolState: MeteoraExecutionPoolState
  defaults: MeteoraExecutionDefaults
}

export interface MeteoraCreatePositionPreview extends MeteoraPreviewBase {
  kind: 'create_position'
  request: MeteoraCreatePositionRequest
  strategy: MeteoraStrategy
  range: MeteoraSnappedRange
  amounts: {
    tokenXAtomic: string
    tokenYAtomic: string
  }
  depositMode: 'two_token' | 'single_sided'
  transactionPlan: MeteoraTransactionPlanPreview
}

export type MeteoraLimitOrderSide = 'buy' | 'sell'

export interface MeteoraLimitOrderRequest {
  poolAddress: string
  side: MeteoraLimitOrderSide
  amount: string
  price: string
}

export interface MeteoraLimitOrderPreview extends MeteoraPreviewBase {
  kind: 'limit_order'
  request: MeteoraLimitOrderRequest
  side: MeteoraLimitOrderSide
  inputToken: 'x' | 'y'
  inputTokenAtomic: string
  requestedPrice: string
  executablePrice: string
  binId: number
  relativeBinId: number
  protocolMaxBins: number
  estimatedFullFillOutput: string
  transactionPlan: MeteoraTransactionPlanPreview
}

export interface MeteoraZapInRequest {
  poolAddress: string
  strategy: MeteoraStrategy
  range: MeteoraRangeRequest
  inputToken: 'x' | 'y'
  amount: string
}

export interface MeteoraZapInPreview extends MeteoraPreviewBase {
  kind: 'zap_in'
  request: MeteoraZapInRequest
  strategy: MeteoraStrategy
  range: MeteoraSnappedRange
  inputToken: 'x' | 'y'
  inputTokenAtomic: string
  estimate: {
    route: 'dlmm' | 'jupiter' | 'none'
    swapAmountAtomic: string
    expectedOutputAtomic: string
    minimumOutputAtomic: string
    priceImpactPct: string
    postSwapXAtomic: string
    postSwapYAtomic: string
  } | null
  transactionPlan: MeteoraTransactionPlanPreview
}

export interface MeteoraTransactionPlanStep {
  id: string
  kind: 'setup' | 'swap' | 'ledger' | 'execute' | 'cleanup'
  label: string
  transactionIndex: number
  requiresWalletSignature: true
}

export interface MeteoraTransactionPlanPreview {
  action: 'create_position' | 'place_limit_order' | 'zap_in'
  expectedSteps: Array<Pick<MeteoraTransactionPlanStep, 'id' | 'kind' | 'label'>>
}

export interface MeteoraTransactionPlan {
  planId: string
  previewId: string | null
  createdAt: string
  expiresAt: string | null
  steps: MeteoraTransactionPlanStep[]
}
