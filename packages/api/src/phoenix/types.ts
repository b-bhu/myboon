import type { createPhoenixClient } from '@ellipsis-labs/rise'

export type CacheEntry<T> = {
  data: T
  fetchedAt: number
  expiresAt: number
}

export interface PhoenixLeverageTier {
  maxLeverage?: unknown
  maxSizeBaseLots?: unknown
  limitOrderRiskFactor?: unknown
}

export interface PhoenixFundingConfig {
  fundingIntervalSeconds?: unknown
  fundingPeriodSeconds?: unknown
  maxFundingRatePerInterval?: unknown
}

export interface PhoenixMarketConfig {
  symbol?: unknown
  assetId?: unknown
  marketStatus?: unknown
  marketPubkey?: unknown
  splinePubkey?: unknown
  tickSize?: unknown
  baseLotsDecimals?: unknown
  takerFee?: unknown
  makerFee?: unknown
  leverageTiers?: PhoenixLeverageTier[]
  riskFactors?: unknown
  fundingIntervalSeconds?: unknown
  fundingPeriodSeconds?: unknown
  fundingConfig?: PhoenixFundingConfig
  maxFundingRatePerInterval?: unknown
  maxFundingRatePerIntervalPercentage?: unknown
  openInterestCapBaseLots?: unknown
  maxLiquidationSizeBaseLots?: unknown
  isolatedOnly?: unknown
  commodityMetadata?: unknown
  markPriceParameters?: unknown
}

export interface PhoenixExchangeSnapshot {
  version?: unknown
  slot?: unknown
  slotIndex?: unknown
  sequenceNumber?: unknown
  exchange?: {
    active?: unknown
    gated?: unknown
    exchangeStatusBits?: unknown
    exchangeStatusFeatures?: unknown
    programId?: unknown
    canonicalMint?: unknown
    usdcMint?: unknown
  }
  markets?: PhoenixMarketConfig[]
}

export interface PhoenixCandle {
  time?: unknown
  open?: unknown
  high?: unknown
  low?: unknown
  close?: unknown
  volume?: unknown
  volumeQuote?: unknown
  tradeCount?: unknown
  markOpen?: unknown
  markHigh?: unknown
  markLow?: unknown
  markClose?: unknown
  externalSource?: unknown
}

export interface PhoenixMarketStats {
  symbol: string
  markPrice: number | null
  midPrice: number | null
  oraclePrice: number | null
  fundingRate: number | null
  openInterest: number | null
  volume24h: number | null
  yesterdayPrice: number | null
  receivedAt: number
}

export interface PhoenixFetchOptions {
  method?: 'GET' | 'POST'
  body?: unknown
}

export interface PhoenixInstructionBuilderResult {
  venueId: 'phoenix'
  action: string
  mode: 'solana_instruction_builder'
  endpoint: string
  instructions: unknown[]
  raw: unknown
  estimatedLiquidationPriceUsd?: number | null
}

export type PhoenixSdkClient = ReturnType<typeof createPhoenixClient>

export interface PhoenixPositionTriggerEnrichment {
  takeProfitPrice: number | null
  stopLossPrice: number | null
  takeProfitTriggers: unknown[]
  stopLossTriggers: unknown[]
  conditionalTakeProfitTriggers: unknown[]
  conditionalStopLossTriggers: unknown[]
  syntheticOrders: unknown[]
}

export interface NormalizedPhoenixMarket {
  venueId: 'phoenix'
  symbol: string
  venueSymbol: string
  baseSymbol: string
  quoteSymbol: 'USDC'
  status: string
  marketStatus: string
  tradeable: boolean
  maxLeverage: number | null
  tickSize: string | null
  lotSize: string | null
  minOrderSize: string | null
  markPrice: number | null
  oraclePrice: number | null
  midPrice: number | null
  fundingRate: number | null
  openInterest: number | null
  volume24h: number | null
  change24h: number | null
  yesterdayPrice: number | null
  iconPath: string | null
  dataFreshness: 'live' | 'partial'
  dataFreshnessReason: string
  configFetchedAt: string
  precision: {
    tickSize: string | null
    rawTickSize: number | string | null
    baseLotsDecimals: number | null
  }
  limits: {
    openInterestCapBaseLots: string | null
    maxLiquidationSizeBaseLots: string | null
    leverageTiers: PhoenixLeverageTier[]
  }
  fees: {
    makerFee: number | null
    takerFee: number | null
  }
  funding: {
    fundingIntervalSeconds: number | null
    fundingPeriodSeconds: number | null
    maxFundingRatePerInterval: string | null
    maxFundingRatePerIntervalPercentage: number | null
  }
  metadata: {
    assetId: number | null
    marketPubkey: string | null
    splinePubkey: string | null
    isolatedOnly: boolean | null
    riskFactors: unknown
    commodityMetadata: unknown
    markPriceParameters?: unknown
  }
}
