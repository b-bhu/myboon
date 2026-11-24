/** Normalizers for Phoenix market, status and candle payloads (#831). */

import { perpIconPath } from '../tokens/identity-service.js'
import {
  appSymbolFromVenueSymbol,
  asBoolean,
  asRecord,
  asString,
  normalizeVenueSymbol,
  parseNullableInt,
  parseNullableNumber,
  rawNumberOrString,
  stringifyNullable,
} from './parse.js'
import type {
  CacheEntry,
  NormalizedPhoenixMarket,
  PhoenixCandle,
  PhoenixExchangeSnapshot,
  PhoenixFundingConfig,
  PhoenixLeverageTier,
  PhoenixMarketConfig,
  PhoenixMarketStats,
} from './types.js'

export function maxLeverage(leverageTiers: PhoenixLeverageTier[] | undefined): number | null {
  if (!Array.isArray(leverageTiers)) return null
  const leverages = leverageTiers
    .map((tier) => parseNullableNumber(tier.maxLeverage))
    .filter((value): value is number => value !== null)
  if (leverages.length === 0) return null
  return Math.max(...leverages)
}

export function fundingConfig(market: PhoenixMarketConfig): PhoenixFundingConfig {
  return {
    fundingIntervalSeconds: market.fundingConfig?.fundingIntervalSeconds ?? market.fundingIntervalSeconds,
    fundingPeriodSeconds: market.fundingConfig?.fundingPeriodSeconds ?? market.fundingPeriodSeconds,
    maxFundingRatePerInterval: market.fundingConfig?.maxFundingRatePerInterval ?? market.maxFundingRatePerInterval,
  }
}

export function changeFromPrices(markPrice: number | null, yesterdayPrice: number | null): number | null {
  if (markPrice === null || yesterdayPrice === null || yesterdayPrice <= 0) return null
  return ((markPrice - yesterdayPrice) / yesterdayPrice) * 100
}

export function notionalOpenInterest(openInterestBase: number | null, markPrice: number | null): number | null {
  if (openInterestBase === null || markPrice === null) return null
  return openInterestBase * markPrice
}

export function mergeMarketStats(market: NormalizedPhoenixMarket, stats: PhoenixMarketStats | undefined): NormalizedPhoenixMarket {
  if (!stats) return market

  const markPrice = stats.markPrice ?? market.markPrice
  const yesterdayPrice = stats.yesterdayPrice ?? market.yesterdayPrice

  return {
    ...market,
    markPrice,
    midPrice: stats.midPrice ?? market.midPrice,
    oraclePrice: stats.oraclePrice ?? market.oraclePrice,
    fundingRate: stats.fundingRate ?? market.fundingRate,
    openInterest: notionalOpenInterest(stats.openInterest, markPrice) ?? market.openInterest,
    volume24h: stats.volume24h ?? market.volume24h,
    change24h: changeFromPrices(markPrice, yesterdayPrice) ?? market.change24h,
    yesterdayPrice,
    dataFreshness: 'live',
    dataFreshnessReason: 'Phoenix WebSocket market channel live stats merged with REST market config.',
  }
}

export function normalizeMarket(market: PhoenixMarketConfig, fetchedAt: number): NormalizedPhoenixMarket | null {
  const venueSymbol = normalizeVenueSymbol(asString(market.symbol))
  if (!venueSymbol) return null

  const marketStatus = asString(market.marketStatus) ?? 'unknown'
  const config = fundingConfig(market)

  return {
    venueId: 'phoenix',
    symbol: appSymbolFromVenueSymbol(venueSymbol),
    venueSymbol,
    baseSymbol: venueSymbol,
    quoteSymbol: 'USDC',
    status: marketStatus,
    marketStatus,
    tradeable: marketStatus === 'active',
    maxLeverage: maxLeverage(market.leverageTiers),
    tickSize: stringifyNullable(market.tickSize),
    lotSize: null,
    minOrderSize: null,
    markPrice: null,
    oraclePrice: null,
    midPrice: null,
    fundingRate: null,
    openInterest: null,
    volume24h: null,
    change24h: null,
    yesterdayPrice: null,
    iconPath: perpIconPath(venueSymbol),
    dataFreshness: 'partial',
    dataFreshnessReason: 'Phoenix REST market config does not include WS-only mark, mid, oracle, funding, open interest, or 24h volume stats in this slice.',
    configFetchedAt: new Date(fetchedAt).toISOString(),
    precision: {
      tickSize: stringifyNullable(market.tickSize),
      rawTickSize: rawNumberOrString(market.tickSize),
      baseLotsDecimals: parseNullableInt(market.baseLotsDecimals),
    },
    limits: {
      openInterestCapBaseLots: stringifyNullable(market.openInterestCapBaseLots),
      maxLiquidationSizeBaseLots: stringifyNullable(market.maxLiquidationSizeBaseLots),
      leverageTiers: Array.isArray(market.leverageTiers) ? market.leverageTiers : [],
    },
    fees: {
      makerFee: parseNullableNumber(market.makerFee),
      takerFee: parseNullableNumber(market.takerFee),
    },
    funding: {
      fundingIntervalSeconds: parseNullableInt(config.fundingIntervalSeconds),
      fundingPeriodSeconds: parseNullableInt(config.fundingPeriodSeconds),
      maxFundingRatePerInterval: stringifyNullable(config.maxFundingRatePerInterval),
      maxFundingRatePerIntervalPercentage: parseNullableNumber(market.maxFundingRatePerIntervalPercentage),
    },
    metadata: {
      assetId: parseNullableInt(market.assetId),
      marketPubkey: asString(market.marketPubkey),
      splinePubkey: asString(market.splinePubkey),
      isolatedOnly: asBoolean(market.isolatedOnly),
      riskFactors: market.riskFactors ?? null,
      commodityMetadata: market.commodityMetadata ?? null,
      markPriceParameters: market.markPriceParameters,
    },
  }
}

export function normalizedStatus(snapshot: CacheEntry<PhoenixExchangeSnapshot>) {
  const exchange = snapshot.data.exchange ?? {}
  return {
    venueId: 'phoenix',
    status: asBoolean(exchange.active) ? 'active' : 'inactive',
    active: asBoolean(exchange.active) ?? false,
    gated: asBoolean(exchange.gated) ?? null,
    slot: parseNullableInt(snapshot.data.slot),
    slotIndex: parseNullableInt(snapshot.data.slotIndex),
    version: parseNullableInt(snapshot.data.version),
    sequenceNumber: stringifyNullable(snapshot.data.sequenceNumber),
    features: Array.isArray(exchange.exchangeStatusFeatures) ? exchange.exchangeStatusFeatures : [],
    exchangeStatusBits: parseNullableInt(exchange.exchangeStatusBits),
    programId: asString(exchange.programId),
    canonicalMint: asString(exchange.canonicalMint),
    usdcMint: asString(exchange.usdcMint),
    dataFreshness: 'snapshot',
    fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
  }
}

export function normalizeCandle(raw: unknown) {
  const candle = asRecord(raw) as PhoenixCandle | null
  if (!candle) return null

  const time = parseNullableInt(candle.time)
  const open = parseNullableNumber(candle.open)
  const high = parseNullableNumber(candle.high)
  const low = parseNullableNumber(candle.low)
  const close = parseNullableNumber(candle.close)
  if (time === null || open === null || high === null || low === null || close === null) return null

  return {
    time,
    open,
    close,
    high,
    low,
    volume: parseNullableNumber(candle.volume) ?? 0,
    volumeQuote: parseNullableNumber(candle.volumeQuote),
    tradeCount: parseNullableInt(candle.tradeCount),
    mark: {
      open: parseNullableNumber(candle.markOpen),
      high: parseNullableNumber(candle.markHigh),
      low: parseNullableNumber(candle.markLow),
      close: parseNullableNumber(candle.markClose),
    },
    externalSource: asString(candle.externalSource),
  }
}
