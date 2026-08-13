import { Hono } from 'hono'
import type { Context } from 'hono'
import { Direction, OrderFlags, Side, StopLossOrderKind, baseLots, baseUnitsToBaseLotsWithMarketParams, createPhoenixClient, priceUsdToTicksWithMarketParams } from '@ellipsis-labs/rise'
import type { Authority, BaseLots, Symbol as PhoenixSymbol, TriggerOrderParams } from '@ellipsis-labs/rise'
import { perpIconPath } from './tokens/identity-service.js'

const PHOENIX_API_BASE = process.env.PHOENIX_API_BASE || 'https://perp-api.phoenix.trade'
const PHOENIX_WS_URL = process.env.PHOENIX_WS_URL || `${PHOENIX_API_BASE.replace(/^http/i, 'ws').replace(/\/$/, '')}/v1/ws`
const PHOENIX_RPC_URL = process.env.PHOENIX_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
const PHOENIX_BUILDER_AUTHORITY = sdkAuthority(process.env.PHOENIX_BUILDER_AUTHORITY || '9R2btPADiQUZ4p7duXJJFxW9jnUeUqafb5Ln6DU8jnwu')
const PHOENIX_BUILDER_PDA_INDEX = parseEnvIntAllowZero('PHOENIX_BUILDER_PDA_INDEX', 0)
const PHOENIX_BUILDER_SUBACCOUNT_INDEX = parseEnvIntAllowZero('PHOENIX_BUILDER_SUBACCOUNT_INDEX', 0)
const REQUEST_TIMEOUT_MS = parseEnvInt('PHOENIX_REQUEST_TIMEOUT_MS', 10_000)
const STATUS_CACHE_TTL_MS = parseEnvInt('PHOENIX_STATUS_CACHE_TTL_MS', 15_000)
const MARKETS_CACHE_TTL_MS = parseEnvInt('PHOENIX_MARKETS_CACHE_TTL_MS', 60_000)
const MARKET_STATS_CACHE_TTL_MS = parseEnvInt('PHOENIX_MARKET_STATS_CACHE_TTL_MS', 10_000)
const MARKET_STATS_TIMEOUT_MS = parseEnvInt('PHOENIX_MARKET_STATS_TIMEOUT_MS', 5_000)
const CANDLES_CACHE_TTL_MS = parseEnvInt('PHOENIX_CANDLES_CACHE_TTL_MS', 15_000)
const MAX_CANDLE_LIMIT = parseEnvInt('PHOENIX_MAX_CANDLE_LIMIT', 500)

const SUPPORTED_CANDLE_INTERVALS = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d'])
const SOLANA_PUBLIC_KEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

type CacheEntry<T> = {
  data: T
  fetchedAt: number
  expiresAt: number
}

interface PhoenixLeverageTier {
  maxLeverage?: unknown
  maxSizeBaseLots?: unknown
  limitOrderRiskFactor?: unknown
}

interface PhoenixFundingConfig {
  fundingIntervalSeconds?: unknown
  fundingPeriodSeconds?: unknown
  maxFundingRatePerInterval?: unknown
}

interface PhoenixMarketConfig {
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

interface PhoenixExchangeSnapshot {
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

interface PhoenixCandle {
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

interface PhoenixMarketStats {
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

interface PhoenixFetchOptions {
  method?: 'GET' | 'POST'
  body?: unknown
}

interface PhoenixInstructionBuilderResult {
  venueId: 'phoenix'
  action: string
  mode: 'solana_instruction_builder'
  endpoint: string
  instructions: unknown[]
  raw: unknown
  estimatedLiquidationPriceUsd?: number | null
}

type PhoenixSdkClient = ReturnType<typeof createPhoenixClient>

interface PhoenixPositionTriggerEnrichment {
  takeProfitPrice: number | null
  stopLossPrice: number | null
  takeProfitTriggers: unknown[]
  stopLossTriggers: unknown[]
  conditionalTakeProfitTriggers: unknown[]
  conditionalStopLossTriggers: unknown[]
  syntheticOrders: unknown[]
}

let phoenixSdkClient: PhoenixSdkClient | null = null
let phoenixRawSdkClient: PhoenixSdkClient | null = null

interface NormalizedPhoenixMarket {
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

const statusCache = new Map<string, CacheEntry<PhoenixExchangeSnapshot>>()
const marketsCache = new Map<string, CacheEntry<PhoenixMarketConfig[]>>()
const marketStatsCache = new Map<string, CacheEntry<Map<string, PhoenixMarketStats>>>()
const candlesCache = new Map<string, CacheEntry<unknown[]>>()

function parseEnvInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseEnvIntAllowZero(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' ? input as Record<string, unknown> : null
}

function asString(input: unknown): string | null {
  return typeof input === 'string' && input.length > 0 ? input : null
}

function asNonEmptyString(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asBoolean(input: unknown): boolean | null {
  return typeof input === 'boolean' ? input : null
}

function parseNullableNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null
  if (typeof input !== 'string') return null
  const parsed = Number.parseFloat(input)
  return Number.isFinite(parsed) ? parsed : null
}

function parseFiniteJsonNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null
  if (typeof input !== 'string') return null

  const trimmed = input.trim()
  if (!trimmed) return null

  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function parseNullableInt(input: unknown): number | null {
  const value = parseNullableNumber(input)
  return value === null ? null : Math.trunc(value)
}

function stringifyNullable(input: unknown): string | null {
  if (typeof input === 'string') return input
  if (typeof input === 'number' && Number.isFinite(input)) return String(input)
  if (typeof input === 'bigint') return input.toString()
  return null
}

function rawNumberOrString(input: unknown): number | string | null {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input === 'string') return input
  return null
}

function parseNonNegativeInteger(input: unknown): number | null {
  if (typeof input === 'number') {
    return Number.isSafeInteger(input) && input >= 0 ? input : null
  }

  if (typeof input !== 'string' || !/^\d+$/.test(input)) return null
  const parsed = Number.parseInt(input, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function parsePositiveInteger(input: unknown): number | null {
  const parsed = parseNonNegativeInteger(input)
  return parsed !== null && parsed > 0 ? parsed : null
}

function historyLimit(input: string | undefined, fallback = 50, max = 100): number {
  const parsed = input === undefined ? null : parsePositiveInteger(input)
  return parsed === null ? fallback : Math.min(parsed, max)
}

function isNonNegativeInteger(input: unknown): boolean {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
}

function normalizeVenueSymbol(input: string | null | undefined): string | null {
  if (!input) return null
  const normalized = input.trim().toUpperCase().replace(/-PERP$/, '')
  return /^[A-Z0-9]{1,24}$/.test(normalized) ? normalized : null
}

function appSymbolFromVenueSymbol(venueSymbol: string): string {
  return `${venueSymbol}-PERP`
}

function normalizeMarketSymbol(input: string | null | undefined): string | null {
  const venueSymbol = normalizeVenueSymbol(input)
  return venueSymbol ? appSymbolFromVenueSymbol(venueSymbol) : null
}

async function getPhoenixTraderStateV1(authority: string, traderPdaIndex: number): Promise<unknown | null> {
  try {
    return await phoenixFetchJson<unknown>(
      `/v1/trader/state/${encodeURIComponent(authority)}?traderPdaIndex=${traderPdaIndex}`,
    )
  } catch (err) {
    console.warn(`[api] Phoenix v1 trader state ${authority} unavailable:`, err instanceof Error ? err.message : err)
    return null
  }
}

function triggerRecordPriceUsd(triggerRecord: Record<string, unknown>, positionRecord: Record<string, unknown>): number | null {
  const trigger = asRecord(triggerRecord.trigger)
  if (!trigger) return null

  const directPrice = parseNullableNumber(
    trigger.triggerPriceUsd ?? trigger.priceUsd ?? trigger.triggerPrice ?? trigger.price,
  )
  if (directPrice !== null) return directPrice

  const triggerTicks = parseNullableNumber(trigger.triggerPriceTicks)
  if (triggerTicks === null) return null

  const entryTicks = parseNullableNumber(positionRecord.entryPriceTicks)
  const entryUsd = parseNullableNumber(positionRecord.entryPriceUsd)
  const tickDivisor = entryTicks !== null && entryUsd !== null && entryUsd > 0
    ? entryTicks / entryUsd
    : 1000

  return tickDivisor > 0 ? triggerTicks / tickDivisor : null
}

function activeTriggerRows(input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input)) return []

  return input
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => {
      if (!item) return false
      const status = asString(item.status)?.toLowerCase()
      return status === null || status === 'active' || status === 'open'
    })
}

function enrichTriggerPriceRows(rows: Record<string, unknown>[], positionRecord: Record<string, unknown>): unknown[] {
  return rows.map((row) => {
    const trigger = asRecord(row.trigger)
    const triggerPriceUsd = triggerRecordPriceUsd(row, positionRecord)

    if (!trigger || triggerPriceUsd === null) {
      return row
    }

    return {
      ...row,
      trigger: {
        ...trigger,
        triggerPriceUsd,
      },
    }
  })
}

function firstTriggerPriceUsd(rows: Record<string, unknown>[], positionRecord: Record<string, unknown>): number | null {
  for (const row of rows) {
    const price = triggerRecordPriceUsd(row, positionRecord)
    if (price !== null) return price
  }

  return null
}

function syntheticOrderFromTrigger(
  symbol: string,
  kind: 'take_profit' | 'stop_loss',
  row: Record<string, unknown>,
  positionRecord: Record<string, unknown>,
): Record<string, unknown> | null {
  const trigger = asRecord(row.trigger)
  if (!trigger) return null

  const price = triggerRecordPriceUsd(row, positionRecord)
  if (price === null) return null

  const positionLots = Math.abs(parseNullableNumber(positionRecord.basePositionLots) ?? 0)
  const positionDecimals = parseNullableInt(positionRecord.baseLotsDecimals) ?? 2
  const sizeUi = positionLots > 0
    ? positionLots / (10 ** positionDecimals)
    : parseNullableNumber(asRecord(positionRecord.positionSize)?.ui)
  const percent = parseNullableNumber(trigger.percent)
  const id = asString(row.conditionalTakeProfitId)
    ?? asString(row.conditionalStopLossId)
    ?? asString(row.orderId)
    ?? `${symbol}-${kind}-${price}`
  const cancelMeta = conditionalTriggerCancelMeta(row, id)

  return {
    orderSequenceNumber: id,
    symbol,
    side: asString(trigger.side),
    price,
    triggerPrice: price,
    tradeSizeRemaining: sizeUi === null ? null : { value: sizeUi, decimals: 0, ui: String(sizeUi) },
    initialTradeSize: sizeUi === null ? null : { value: sizeUi, decimals: 0, ui: String(sizeUi) },
    isReduceOnly: true,
    isConditionalOrder: true,
    conditionalOrderKind: kind,
    conditionalOrderIndex: cancelMeta.conditionalOrderIndex,
    executionDirection: cancelMeta.executionDirection,
    status: asString(row.status) ?? 'active',
    percent,
    raw: row,
  }
}

function conditionalTriggerCancelMeta(
  row: Record<string, unknown>,
  id: string,
): { conditionalOrderIndex: number | null; executionDirection: string | null } {
  const directIndex = parseNullableInt(row.conditionalOrderIndex ?? row.index)
  const directDirection = asString(row.executionDirection ?? row.triggerDirection)
  if (directIndex !== null && directDirection !== null) {
    return { conditionalOrderIndex: directIndex, executionDirection: directDirection }
  }

  const match = id.match(/-(\d+)-(gt|lt)$/i)
  return {
    conditionalOrderIndex: directIndex ?? (match ? Number.parseInt(match[1], 10) : null),
    executionDirection: directDirection ?? (match ? match[2].toLowerCase() : null),
  }
}

function buildPhoenixTriggerEnrichment(v1Raw: unknown): Map<string, PhoenixPositionTriggerEnrichment> {
  const result = new Map<string, PhoenixPositionTriggerEnrichment>()
  const v1Record = asRecord(v1Raw)
  const snapshot = asRecord(v1Record?.snapshot)
  const subaccounts = Array.isArray(snapshot?.subaccounts) ? snapshot.subaccounts : []

  for (const rawSubaccount of subaccounts) {
    const subaccount = asRecord(rawSubaccount)
    if (!subaccount) continue

    const subaccountIndex = parseNullableInt(subaccount.subaccountIndex) ?? 0
    const positions = Array.isArray(subaccount.positions) ? subaccount.positions : []

    for (const rawPosition of positions) {
      const position = asRecord(rawPosition)
      const venueSymbol = normalizeVenueSymbol(asString(position?.symbol))
      if (!position || !venueSymbol) continue

      const takeProfitRows = activeTriggerRows(position.takeProfitTriggers)
      const stopLossRows = activeTriggerRows(position.stopLossTriggers)
      const conditionalTakeProfitRows = activeTriggerRows(position.conditionalTakeProfitTriggers)
      const conditionalStopLossRows = activeTriggerRows(position.conditionalStopLossTriggers)
      const allTakeProfitRows = [...conditionalTakeProfitRows, ...takeProfitRows]
      const allStopLossRows = [...conditionalStopLossRows, ...stopLossRows]
      const syntheticOrders = [
        ...allTakeProfitRows.map((row) => syntheticOrderFromTrigger(venueSymbol, 'take_profit', row, position)),
        ...allStopLossRows.map((row) => syntheticOrderFromTrigger(venueSymbol, 'stop_loss', row, position)),
      ].filter((order): order is Record<string, unknown> => order !== null)

      result.set(`${subaccountIndex}:${venueSymbol}`, {
        takeProfitPrice: firstTriggerPriceUsd(allTakeProfitRows, position),
        stopLossPrice: firstTriggerPriceUsd(allStopLossRows, position),
        takeProfitTriggers: enrichTriggerPriceRows(takeProfitRows, position),
        stopLossTriggers: enrichTriggerPriceRows(stopLossRows, position),
        conditionalTakeProfitTriggers: enrichTriggerPriceRows(conditionalTakeProfitRows, position),
        conditionalStopLossTriggers: enrichTriggerPriceRows(conditionalStopLossRows, position),
        syntheticOrders,
      })
    }
  }

  return result
}

function mergePhoenixTraderState(raw: unknown, v1Raw: unknown | null): { traders: unknown[]; triggerSource: 'v1' | 'legacy' } {
  const rawRecord = asRecord(raw)
  const traders = Array.isArray(rawRecord?.traders) ? rawRecord.traders : []
  if (!v1Raw) return { traders, triggerSource: 'legacy' }

  const enrichment = buildPhoenixTriggerEnrichment(v1Raw)
  if (enrichment.size === 0) return { traders, triggerSource: 'legacy' }

  const enrichedTraders = traders.map((rawTrader) => {
    const trader = asRecord(rawTrader)
    if (!trader) return rawTrader

    const traderSubaccountIndex = parseNullableInt(trader.traderSubaccountIndex) ?? 0
    const positions = Array.isArray(trader.positions)
      ? trader.positions.map((rawPosition) => {
        const position = asRecord(rawPosition)
        const venueSymbol = normalizeVenueSymbol(asString(position?.symbol))
        const trigger = venueSymbol ? enrichment.get(`${traderSubaccountIndex}:${venueSymbol}`) : undefined
        if (!position || !trigger) return rawPosition

        return {
          ...position,
          takeProfitPrice: position.takeProfitPrice ?? trigger.takeProfitPrice,
          stopLossPrice: position.stopLossPrice ?? trigger.stopLossPrice,
          takeProfitTriggers: trigger.takeProfitTriggers,
          stopLossTriggers: trigger.stopLossTriggers,
          conditionalTakeProfitTriggers: trigger.conditionalTakeProfitTriggers,
          conditionalStopLossTriggers: trigger.conditionalStopLossTriggers,
        }
      })
      : trader.positions

    const limitOrders = asRecord(trader.limitOrders) ? { ...asRecord(trader.limitOrders) } : {}
    for (const [key, trigger] of enrichment.entries()) {
      const [subaccountIndex, venueSymbol] = key.split(':')
      if (Number(subaccountIndex) !== traderSubaccountIndex || trigger.syntheticOrders.length === 0) continue

      const existing = Array.isArray(limitOrders[venueSymbol]) ? limitOrders[venueSymbol] as unknown[] : []
      const existingIds = new Set(
        existing
          .map((order) => asString(asRecord(order)?.orderSequenceNumber))
          .filter((id): id is string => id !== null),
      )
      const newOrders = trigger.syntheticOrders.filter((order) => {
        const id = asString(asRecord(order)?.orderSequenceNumber)
        return id === null || !existingIds.has(id)
      })
      limitOrders[venueSymbol] = [...existing, ...newOrders]
    }

    return { ...trader, positions, limitOrders }
  })

  return { traders: enrichedTraders, triggerSource: 'v1' }
}

function maxLeverage(leverageTiers: PhoenixLeverageTier[] | undefined): number | null {
  if (!Array.isArray(leverageTiers)) return null
  const leverages = leverageTiers
    .map((tier) => parseNullableNumber(tier.maxLeverage))
    .filter((value): value is number => value !== null)
  if (leverages.length === 0) return null
  return Math.max(...leverages)
}

function fundingConfig(market: PhoenixMarketConfig): PhoenixFundingConfig {
  return {
    fundingIntervalSeconds: market.fundingConfig?.fundingIntervalSeconds ?? market.fundingIntervalSeconds,
    fundingPeriodSeconds: market.fundingConfig?.fundingPeriodSeconds ?? market.fundingPeriodSeconds,
    maxFundingRatePerInterval: market.fundingConfig?.maxFundingRatePerInterval ?? market.maxFundingRatePerInterval,
  }
}

async function phoenixFetchJson<T>(path: string, options: PhoenixFetchOptions = {}): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }
  const init: RequestInit = { method, signal: controller.signal, headers }

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }

  try {
    const res = await fetch(`${PHOENIX_API_BASE}${path}`, init)

    if (!res.ok) {
      const upstreamBody = await res.text().catch(() => '')
      throw new PhoenixUpstreamError(res.status, upstreamBody)
    }

    const text = await res.text()
    if (text.trim() === '') return null as T
    return JSON.parse(text) as T
  } finally {
    clearTimeout(timeout)
  }
}

class PhoenixUpstreamError extends Error {
  constructor(readonly status: number, readonly upstreamBody: string) {
    super(`Phoenix upstream failed (${status})`)
  }
}

async function cachedJson<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<CacheEntry<T>> {
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now) return cached

  const data = await fetcher()
  const entry = { data, fetchedAt: now, expiresAt: now + ttlMs }
  cache.set(key, entry)
  return entry
}

async function getExchangeSnapshot(): Promise<CacheEntry<PhoenixExchangeSnapshot>> {
  return cachedJson(statusCache, 'snapshot', STATUS_CACHE_TTL_MS, () => (
    phoenixFetchJson<PhoenixExchangeSnapshot>('/v1/exchange/snapshot')
  ))
}

async function getRawMarkets(): Promise<CacheEntry<PhoenixMarketConfig[]>> {
  return cachedJson(marketsCache, 'markets', MARKETS_CACHE_TTL_MS, () => (
    phoenixFetchJson<PhoenixMarketConfig[]>('/exchange/markets')
  ))
}

async function getMarketByVenueSymbol(venueSymbol: string): Promise<{ market: PhoenixMarketConfig; fetchedAt: number } | null> {
  const entry = await getRawMarkets()
  const market = entry.data.find((candidate) => normalizeVenueSymbol(asString(candidate.symbol)) === venueSymbol)
  return market ? { market, fetchedAt: entry.fetchedAt } : null
}

function marketStatsCacheKey(venueSymbols: string[]): string {
  return [...new Set(venueSymbols)].sort().join(',')
}

async function getMarketStats(venueSymbols: string[]): Promise<Map<string, PhoenixMarketStats>> {
  const symbols = [...new Set(venueSymbols.map((symbol) => normalizeVenueSymbol(symbol)).filter((symbol): symbol is string => symbol !== null))]
  if (symbols.length === 0) return new Map()

  return (await cachedJson(marketStatsCache, marketStatsCacheKey(symbols), MARKET_STATS_CACHE_TTL_MS, () => (
    fetchMarketStatsViaWebSocket(symbols)
  ))).data
}

function fetchMarketStatsViaWebSocket(venueSymbols: string[]): Promise<Map<string, PhoenixMarketStats>> {
  return new Promise((resolve) => {
    const expected = new Set(venueSymbols)
    const stats = new Map<string, PhoenixMarketStats>()
    let settled = false
    let ws: WebSocket | null = null

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close()
      }
      resolve(stats)
    }

    const timeout = setTimeout(finish, MARKET_STATS_TIMEOUT_MS)

    try {
      ws = new WebSocket(PHOENIX_WS_URL)
      ws.onopen = () => {
        for (const symbol of expected) {
          ws?.send(JSON.stringify({
            type: 'subscribe',
            subscription: { channel: 'market', symbol },
          }))
        }
      }
      ws.onmessage = (event: MessageEvent) => {
        const message = parseMarketStatsMessage(event.data)
        if (!message || !expected.has(message.symbol)) return

        stats.set(message.symbol, message)
        if (stats.size >= expected.size) finish()
      }
      ws.onerror = finish
      ws.onclose = finish
    } catch {
      finish()
    }
  })
}

function parseMarketStatsMessage(input: unknown): PhoenixMarketStats | null {
  const raw = typeof input === 'string' ? input : input instanceof Buffer ? input.toString('utf8') : null
  if (!raw) return null

  const record = asRecord(safeJsonParse(raw))
  if (!record || record.channel !== 'market') return null

  const symbol = normalizeVenueSymbol(asString(record.symbol))
  if (!symbol) return null

  return {
    symbol,
    markPrice: parseNullableNumber(record.markPx),
    midPrice: parseNullableNumber(record.midPx),
    oraclePrice: parseNullableNumber(record.oraclePx),
    fundingRate: parseNullableNumber(record.funding),
    openInterest: parseNullableNumber(record.openInterest),
    volume24h: parseNullableNumber(record.dayNtlVlm),
    yesterdayPrice: parseNullableNumber(record.prevDayPx),
    receivedAt: Date.now(),
  }
}

function changeFromPrices(markPrice: number | null, yesterdayPrice: number | null): number | null {
  if (markPrice === null || yesterdayPrice === null || yesterdayPrice <= 0) return null
  return ((markPrice - yesterdayPrice) / yesterdayPrice) * 100
}

function notionalOpenInterest(openInterestBase: number | null, markPrice: number | null): number | null {
  if (openInterestBase === null || markPrice === null) return null
  return openInterestBase * markPrice
}

function mergeMarketStats(market: NormalizedPhoenixMarket, stats: PhoenixMarketStats | undefined): NormalizedPhoenixMarket {
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

function normalizeMarket(market: PhoenixMarketConfig, fetchedAt: number): NormalizedPhoenixMarket | null {
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

function normalizedStatus(snapshot: CacheEntry<PhoenixExchangeSnapshot>) {
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

function parseCandleLimit(input: string | undefined): number {
  const parsed = Number.parseInt(input ?? '100', 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 100
  return Math.min(parsed, MAX_CANDLE_LIMIT)
}

function appendOptionalQuery(params: URLSearchParams, name: string, value: string | undefined): void {
  if (value !== undefined && value.trim() !== '') params.set(name, value)
}

function appendOptionalIntegerQuery(
  params: URLSearchParams,
  name: string,
  value: string | undefined,
): Response | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = parseNonNegativeInteger(value)
  if (parsed === null) {
    return Response.json({ error: `Invalid ${name}`, code: 'INVALID_QUERY_PARAM', field: name }, { status: 400 })
  }
  params.set(name, String(parsed))
  return null
}

async function readJsonRecord(c: Context): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  let parsed: unknown
  try {
    parsed = await c.req.json()
  } catch {
    return { response: c.json({ error: 'Invalid JSON body', code: 'INVALID_JSON' }, 400) }
  }

  const body = !Array.isArray(parsed) ? asRecord(parsed) : null
  if (!body) {
    return { response: c.json({ error: 'Expected JSON object body', code: 'INVALID_JSON_OBJECT' }, 400) }
  }

  return { body }
}

function missingStringFields(body: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter((field) => asNonEmptyString(body[field]) === null)
}

function invalidNonNegativeIntegerFields(body: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter((field) => !isNonNegativeInteger(body[field]))
}

function missingFieldsPayload(fields: string[]) {
  return {
    error: 'Missing required fields',
    code: 'MISSING_REQUIRED_FIELDS',
    fields,
  }
}

function invalidFieldsPayload(fields: string[]) {
  return {
    error: 'Invalid required fields',
    code: 'INVALID_REQUIRED_FIELDS',
    fields,
  }
}

function instructionBuilderResponse(
  action: string,
  endpoint: string,
  raw: unknown,
): PhoenixInstructionBuilderResult {
  const rawRecord = asRecord(raw)
  const instructions = Array.isArray(raw)
    ? raw
    : (Array.isArray(rawRecord?.instructions) ? rawRecord.instructions : [])
  const result: PhoenixInstructionBuilderResult = {
    venueId: 'phoenix',
    action,
    mode: 'solana_instruction_builder',
    endpoint,
    instructions,
    raw,
  }

  if (rawRecord && 'estimatedLiquidationPriceUsd' in rawRecord) {
    result.estimatedLiquidationPriceUsd = parseNullableNumber(rawRecord.estimatedLiquidationPriceUsd)
  }

  return result
}

function getPhoenixSdkClient(): PhoenixSdkClient {
  if (!phoenixSdkClient) {
    phoenixSdkClient = createPhoenixClient({
      apiUrl: PHOENIX_API_BASE,
      rpcUrl: PHOENIX_RPC_URL,
      exchangeMetadata: { stream: true },
      flight: {
        builderAuthority: PHOENIX_BUILDER_AUTHORITY,
        builderPdaIndex: PHOENIX_BUILDER_PDA_INDEX,
        builderSubaccountIndex: PHOENIX_BUILDER_SUBACCOUNT_INDEX,
      },
    })
  }
  return phoenixSdkClient
}

function getPhoenixRawSdkClient(): PhoenixSdkClient {
  if (!phoenixRawSdkClient) {
    phoenixRawSdkClient = createPhoenixClient({
      apiUrl: PHOENIX_API_BASE,
      rpcUrl: PHOENIX_RPC_URL,
      exchangeMetadata: { stream: true },
    })
  }
  return phoenixRawSdkClient
}

function parseUsdcAmountAtomic(input: unknown): bigint | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null
  const text = String(input).trim()
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null

  const [whole, fraction = ''] = text.split('.')
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  return atomic > 0n ? atomic : null
}

function parseAtomicAmount(input: unknown): bigint | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null
  const text = String(input).trim()
  if (!/^\d+$/.test(text)) return null
  const atomic = BigInt(text)
  return atomic > 0n ? atomic : null
}

function isBlankInput(input: unknown): boolean {
  return input === undefined || input === null || (typeof input === 'string' && input.trim() === '')
}

function isPlausibleSolanaPublicKey(input: string): boolean {
  return SOLANA_PUBLIC_KEY_PATTERN.test(input.trim())
}

function sdkAuthority(input: string): Authority {
  return input as Authority
}

function sdkSymbol(input: string): PhoenixSymbol {
  return input as PhoenixSymbol
}

function invalidPublicKeyPayload(field: string) {
  return {
    error: `Invalid ${field}`,
    code: field === 'authority' ? 'INVALID_AUTHORITY' : `INVALID_${field.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`,
    field,
  }
}

function parseTransferBuilderInput(body: Record<string, unknown>): { input: Record<string, unknown>; response?: Response } {
  const authority = asNonEmptyString(body.authority)
  if (!authority) {
    return {
      input: {},
      response: Response.json({
        error: 'Missing required fields',
        code: 'MISSING_REQUIRED_FIELDS',
        fields: ['authority'],
      }, { status: 400 }),
    }
  }
  if (!isPlausibleSolanaPublicKey(authority)) {
    return {
      input: {},
      response: Response.json(invalidPublicKeyPayload('authority'), { status: 400 }),
    }
  }

  const amountSource = body.amountAtomic === undefined ? body.amount ?? body.amountUsdc : body.amountAtomic
  if (isBlankInput(amountSource)) {
    return {
      input: {},
      response: Response.json({
        error: 'Missing required fields',
        code: 'MISSING_REQUIRED_FIELDS',
        fields: ['amount'],
      }, { status: 400 }),
    }
  }

  const amount = body.amountAtomic === undefined
    ? parseUsdcAmountAtomic(amountSource)
    : parseAtomicAmount(amountSource)
  if (amount === null) {
    return {
      input: {},
      response: Response.json({ error: 'Invalid amount', code: 'INVALID_AMOUNT', field: 'amount' }, { status: 400 }),
    }
  }

  const input: Record<string, unknown> = {
    authority,
    amount,
  }

  const feePayer = asNonEmptyString(body.feePayer)
  if (feePayer) {
    if (!isPlausibleSolanaPublicKey(feePayer)) {
      return {
        input: {},
        response: Response.json(invalidPublicKeyPayload('feePayer'), { status: 400 }),
      }
    }
    input.feePayer = feePayer
  }

  const traderPdaIndex = body.traderPdaIndex ?? body.pdaIndex
  if (traderPdaIndex !== undefined) {
    const parsed = parseNonNegativeInteger(traderPdaIndex)
    if (parsed === null) {
      return {
        input: {},
        response: Response.json({ error: 'Invalid traderPdaIndex', code: 'INVALID_PDA_INDEX' }, { status: 400 }),
      }
    }
    input.traderPdaIndex = parsed
  }

  if (body.traderSubaccountIndex !== undefined) {
    const parsed = parseNonNegativeInteger(body.traderSubaccountIndex)
    if (parsed === null) {
      return {
        input: {},
        response: Response.json({ error: 'Invalid traderSubaccountIndex', code: 'INVALID_SUBACCOUNT_INDEX' }, { status: 400 }),
      }
    }
    input.traderSubaccountIndex = parsed
  }

  const permissionAddress = asNonEmptyString(body.permissionAddress)
  if (permissionAddress) {
    if (!isPlausibleSolanaPublicKey(permissionAddress)) {
      return {
        input: {},
        response: Response.json(invalidPublicKeyPayload('permissionAddress'), { status: 400 }),
      }
    }
    input.permissionAddress = permissionAddress
  }

  return { input }
}

function roleIsSigner(role: unknown): boolean {
  return role === 2 || role === 3 || role === 'READONLY_SIGNER' || role === 'WRITABLE_SIGNER'
}

function roleIsWritable(role: unknown): boolean {
  return role === 1 || role === 3 || role === 'WRITABLE' || role === 'WRITABLE_SIGNER'
}

function serializeInstructionData(data: unknown): number[] {
  if (data instanceof Uint8Array) return Array.from(data)
  if (Array.isArray(data)) return data.map((value) => Number(value))
  if (data && typeof data === 'object' && 'length' in data) {
    return Array.from(data as ArrayLike<number>)
  }
  return []
}

function serializeSdkInstruction(raw: unknown) {
  const ix = asRecord(raw) ?? {}
  const accounts = Array.isArray(ix.accounts) ? ix.accounts : []
  return {
    programId: asString(ix.programAddress) ?? asString(ix.programId),
    keys: accounts.map((rawAccount) => {
      const account = asRecord(rawAccount) ?? {}
      const role = account.role
      return {
        pubkey: asString(account.address) ?? asString(account.pubkey),
        isSigner: account.isSigner === true || roleIsSigner(role),
        isWritable: account.isWritable === true || roleIsWritable(role),
      }
    }),
    data: serializeInstructionData(ix.data),
  }
}

function sdkInstructionsFromRaw(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw.map(serializeSdkInstruction)

  const rawRecord = asRecord(raw)
  if (Array.isArray(rawRecord?.instructions)) {
    return rawRecord.instructions.map(serializeSdkInstruction)
  }
  if (rawRecord && (Array.isArray(rawRecord.accounts) || 'programAddress' in rawRecord || 'programId' in rawRecord)) {
    return [serializeSdkInstruction(raw)]
  }

  return []
}

function sdkInstructionBuilderResponse(
  action: string,
  endpoint: string,
  raw: unknown,
): PhoenixInstructionBuilderResult {
  const rawRecord = asRecord(raw)
  const instructions = sdkInstructionsFromRaw(raw)

  return {
    venueId: 'phoenix',
    action,
    mode: 'solana_instruction_builder',
    endpoint,
    instructions,
    raw: {
      instructionCount: instructions.length,
      named: rawRecord && asRecord(rawRecord.named) ? Object.keys(asRecord(rawRecord.named) ?? {}) : [],
    },
  }
}

function sdkSideFromInput(input: unknown): Side | null {
  const normalized = String(input ?? '').trim().toLowerCase()
  if (normalized === 'long' || normalized === 'bid' || normalized === 'side.bid') return Side.Bid
  if (normalized === 'short' || normalized === 'ask' || normalized === 'side.ask') return Side.Ask
  return null
}

function parseOrderFlag(input: unknown): OrderFlags {
  return input === true ? OrderFlags.ReduceOnly : OrderFlags.None
}

function sdkPositionSideFromInput(input: unknown): 'long' | 'short' | null {
  const normalized = String(input ?? '').trim().toLowerCase()
  if (normalized === 'long' || normalized === 'bid') return 'long'
  if (normalized === 'short' || normalized === 'ask') return 'short'
  return null
}

function parseOrderBuilderIndexes(body: Record<string, unknown>): {
  traderPdaIndex: number
  traderSubaccountIndex: number
} | { response: Response } {
  const traderPdaIndexInput = body.traderPdaIndex ?? body.pdaIndex
  const traderSubaccountIndexInput = body.traderSubaccountIndex ?? body.subaccountIndex

  const traderPdaIndex = traderPdaIndexInput === undefined ? 0 : parseNonNegativeInteger(traderPdaIndexInput)
  if (traderPdaIndex === null) {
    return { response: Response.json({ error: 'Invalid traderPdaIndex', code: 'INVALID_PDA_INDEX' }, { status: 400 }) }
  }

  const traderSubaccountIndex = traderSubaccountIndexInput === undefined ? 0 : parseNonNegativeInteger(traderSubaccountIndexInput)
  if (traderSubaccountIndex === null) {
    return { response: Response.json({ error: 'Invalid traderSubaccountIndex', code: 'INVALID_SUBACCOUNT_INDEX' }, { status: 400 }) }
  }

  return { traderPdaIndex, traderSubaccountIndex }
}

function parseSdkOrderBuilderBody(body: Record<string, unknown>, kind: 'market' | 'limit'): {
  authority: Authority
  positionAuthority?: Authority
  symbol: PhoenixSymbol
  side: Side
  baseUnits: string
  priceUsd?: string
  priceLimitUsd?: string | null
  traderPdaIndex: number
  traderSubaccountIndex: number
  orderFlags: OrderFlags
} | { response: Response } {
  const authority = asNonEmptyString(body.authority)
  if (!authority) {
    return { response: Response.json(missingFieldsPayload(['authority']), { status: 400 }) }
  }
  if (!isPlausibleSolanaPublicKey(authority)) {
    return { response: Response.json(invalidPublicKeyPayload('authority'), { status: 400 }) }
  }

  const positionAuthority = asNonEmptyString(body.positionAuthority)
  if (positionAuthority && !isPlausibleSolanaPublicKey(positionAuthority)) {
    return { response: Response.json(invalidPublicKeyPayload('positionAuthority'), { status: 400 }) }
  }

  const symbol = normalizeVenueSymbol(asNonEmptyString(body.symbol))
  if (!symbol) {
    return { response: Response.json({ error: 'Invalid Phoenix market symbol', code: 'INVALID_MARKET_SYMBOL' }, { status: 400 }) }
  }

  const side = sdkSideFromInput(body.side)
  if (side === null) {
    return { response: Response.json({ error: 'Invalid side', code: 'INVALID_SIDE', field: 'side' }, { status: 400 }) }
  }

  const quantitySource = body.quantity ?? body.baseUnits ?? body.baseQuantity ?? body.numBaseUnits
  const quantity = parseFiniteJsonNumber(quantitySource)
  if (quantity === null || quantity <= 0) {
    return { response: Response.json({ error: 'Invalid quantity', code: 'INVALID_QUANTITY', field: 'quantity' }, { status: 400 }) }
  }

  const indexes = parseOrderBuilderIndexes(body)
  if ('response' in indexes) return indexes

  const orderFlags = parseOrderFlag(body.isReduceOnly ?? body.reduceOnly)
  const base = {
    authority: sdkAuthority(authority),
    positionAuthority: positionAuthority ? sdkAuthority(positionAuthority) : undefined,
    symbol: sdkSymbol(symbol),
    side,
    baseUnits: String(quantity),
    traderPdaIndex: indexes.traderPdaIndex,
    traderSubaccountIndex: indexes.traderSubaccountIndex,
    orderFlags,
  }

  if (kind === 'limit') {
    const price = parseFiniteJsonNumber(body.price ?? body.priceUsd)
    if (price === null || price <= 0) {
      return { response: Response.json({ error: 'Invalid price', code: 'INVALID_PRICE', field: 'price' }, { status: 400 }) }
    }
    return { ...base, priceUsd: String(price) }
  }

  const priceLimitSource = body.priceLimitUsd ?? body.limitPriceUsd ?? body.price ?? body.maxPriceUsd
  const priceLimit = isBlankInput(priceLimitSource) ? null : parseFiniteJsonNumber(priceLimitSource)
  if (priceLimitSource !== undefined && !isBlankInput(priceLimitSource) && (priceLimit === null || priceLimit <= 0)) {
    return { response: Response.json({ error: 'Invalid priceLimitUsd', code: 'INVALID_PRICE_LIMIT', field: 'priceLimitUsd' }, { status: 400 }) }
  }

  return { ...base, priceLimitUsd: priceLimit === null ? null : String(priceLimit) }
}

function parsePositionConditionalOrderBody(body: Record<string, unknown>): {
  authority: Authority
  positionAuthority?: Authority
  symbol: PhoenixSymbol
  positionSide: 'long' | 'short'
  takeProfitPriceUsd: string | null
  stopLossPriceUsd: string | null
  baseUnits: string | null
  sizeBaseLots: BaseLots | null
  sizePercent: number | null
  traderPdaIndex: number
  traderSubaccountIndex: number
} | { response: Response } {
  const authority = asNonEmptyString(body.authority)
  if (!authority) {
    return { response: Response.json(missingFieldsPayload(['authority']), { status: 400 }) }
  }
  if (!isPlausibleSolanaPublicKey(authority)) {
    return { response: Response.json(invalidPublicKeyPayload('authority'), { status: 400 }) }
  }

  const positionAuthority = asNonEmptyString(body.positionAuthority)
  if (positionAuthority && !isPlausibleSolanaPublicKey(positionAuthority)) {
    return { response: Response.json(invalidPublicKeyPayload('positionAuthority'), { status: 400 }) }
  }

  const symbol = normalizeVenueSymbol(asNonEmptyString(body.symbol))
  if (!symbol) {
    return { response: Response.json({ error: 'Invalid Phoenix market symbol', code: 'INVALID_MARKET_SYMBOL' }, { status: 400 }) }
  }

  const positionSide = sdkPositionSideFromInput(body.positionSide ?? body.side)
  if (!positionSide) {
    return { response: Response.json({ error: 'Invalid positionSide', code: 'INVALID_POSITION_SIDE', field: 'positionSide' }, { status: 400 }) }
  }

  const takeProfitSource = body.takeProfitPriceUsd ?? body.takeProfitPrice ?? body.tpPrice ?? body.tp
  const stopLossSource = body.stopLossPriceUsd ?? body.stopLossPrice ?? body.slPrice ?? body.sl
  const takeProfitPrice = isBlankInput(takeProfitSource) ? null : parseFiniteJsonNumber(takeProfitSource)
  const stopLossPrice = isBlankInput(stopLossSource) ? null : parseFiniteJsonNumber(stopLossSource)

  if (takeProfitSource !== undefined && !isBlankInput(takeProfitSource) && (takeProfitPrice === null || takeProfitPrice <= 0)) {
    return { response: Response.json({ error: 'Invalid takeProfitPrice', code: 'INVALID_TAKE_PROFIT_PRICE', field: 'takeProfitPrice' }, { status: 400 }) }
  }
  if (stopLossSource !== undefined && !isBlankInput(stopLossSource) && (stopLossPrice === null || stopLossPrice <= 0)) {
    return { response: Response.json({ error: 'Invalid stopLossPrice', code: 'INVALID_STOP_LOSS_PRICE', field: 'stopLossPrice' }, { status: 400 }) }
  }
  if (takeProfitPrice === null && stopLossPrice === null) {
    return { response: Response.json({ error: 'Enter a take profit or stop loss price', code: 'MISSING_TRIGGER_PRICE' }, { status: 400 }) }
  }

  const baseUnitsSource = body.baseUnits ?? body.quantity ?? body.size
  const baseUnitsValue = isBlankInput(baseUnitsSource) ? null : parseFiniteJsonNumber(baseUnitsSource)
  if (baseUnitsSource !== undefined && !isBlankInput(baseUnitsSource) && (baseUnitsValue === null || baseUnitsValue <= 0)) {
    return { response: Response.json({ error: 'Invalid baseUnits', code: 'INVALID_BASE_UNITS', field: 'baseUnits' }, { status: 400 }) }
  }

  const sizeBaseLotsSource = body.sizeBaseLots ?? body.baseLots
  const sizeBaseLotsValue = isBlankInput(sizeBaseLotsSource) ? null : parsePositiveInteger(sizeBaseLotsSource)
  if (sizeBaseLotsSource !== undefined && !isBlankInput(sizeBaseLotsSource) && sizeBaseLotsValue === null) {
    return { response: Response.json({ error: 'Invalid sizeBaseLots', code: 'INVALID_SIZE_BASE_LOTS', field: 'sizeBaseLots' }, { status: 400 }) }
  }

  if (baseUnitsValue !== null && sizeBaseLotsValue !== null) {
    return { response: Response.json({ error: 'baseUnits and sizeBaseLots cannot both be set', code: 'DUPLICATE_SIZE_FIELD' }, { status: 400 }) }
  }

  const sizePercentSource = baseUnitsValue === null && sizeBaseLotsValue === null ? body.sizePercent ?? 100 : body.sizePercent
  const sizePercent = isBlankInput(sizePercentSource) ? null : parseNonNegativeInteger(sizePercentSource)
  if (sizePercent !== null && (sizePercent < 1 || sizePercent > 100)) {
    return { response: Response.json({ error: 'Invalid sizePercent', code: 'INVALID_SIZE_PERCENT', field: 'sizePercent' }, { status: 400 }) }
  }
  if ((baseUnitsValue !== null || sizeBaseLotsValue !== null) && sizePercent !== null) {
    return { response: Response.json({ error: 'Fixed size and sizePercent cannot both be set', code: 'DUPLICATE_SIZE_FIELD' }, { status: 400 }) }
  }

  const indexes = parseOrderBuilderIndexes(body)
  if ('response' in indexes) return indexes

  return {
    authority: sdkAuthority(authority),
    positionAuthority: positionAuthority ? sdkAuthority(positionAuthority) : undefined,
    symbol: sdkSymbol(symbol),
    positionSide,
    takeProfitPriceUsd: takeProfitPrice === null ? null : String(takeProfitPrice),
    stopLossPriceUsd: stopLossPrice === null ? null : String(stopLossPrice),
    baseUnits: baseUnitsValue === null ? null : String(baseUnitsValue),
    sizeBaseLots: sizeBaseLotsValue === null ? null : baseLots(sizeBaseLotsValue),
    sizePercent,
    traderPdaIndex: indexes.traderPdaIndex,
    traderSubaccountIndex: indexes.traderSubaccountIndex,
  }
}

async function resolvePositionConditionalSize(
  client: PhoenixSdkClient,
  symbol: PhoenixSymbol,
  builder: {
    baseUnits: string | null
    sizeBaseLots: BaseLots | null
    sizePercent: number | null
  },
): Promise<{ sizeBaseLots: BaseLots | null; sizePercent: number | null }> {
  if (builder.sizeBaseLots !== null) {
    return { sizeBaseLots: builder.sizeBaseLots, sizePercent: null }
  }

  if (builder.baseUnits === null) {
    return { sizeBaseLots: null, sizePercent: builder.sizePercent }
  }

  await client.exchange.ready()
  const market = client.exchange.market(symbol)
  if (!market) throw new Error(`Unknown Phoenix market symbol '${symbol}'`)

  return {
    sizeBaseLots: baseUnitsToBaseLotsWithMarketParams(builder.baseUnits, {
      baseLotsDecimals: market.baseLotsDecimals,
    }),
    sizePercent: null,
  }
}

async function positionConditionalTriggers(
  client: PhoenixSdkClient,
  symbol: PhoenixSymbol,
  positionSide: 'long' | 'short',
  takeProfitPriceUsd: string | null,
  stopLossPriceUsd: string | null,
): Promise<{
  greaterTriggerOrder: TriggerOrderParams | null
  lessTriggerOrder: TriggerOrderParams | null
}> {
  await client.exchange.ready()
  const market = client.exchange.market(symbol)
  if (!market) throw new Error(`Unknown Phoenix market symbol '${symbol}'`)

  const marketParams = {
    tickSize: market.tickSize,
    baseLotsDecimals: market.baseLotsDecimals,
  }
  const tradeSide = positionSide === 'long' ? Side.Ask : Side.Bid
  const buildTrigger = (direction: Direction, priceUsd: string): TriggerOrderParams => {
    const triggerPrice = priceUsdToTicksWithMarketParams(priceUsd, marketParams)
    const executionPriceUsd = iocExecutionPriceWithSlippage(priceUsd, tradeSide)
    const executionPrice = priceUsdToTicksWithMarketParams(executionPriceUsd, marketParams)
    return {
      triggerDirection: direction,
      tradeSide,
      orderKind: StopLossOrderKind.IOC,
      triggerPrice,
      executionPrice,
    }
  }

  let greaterTriggerOrder: TriggerOrderParams | null = null
  let lessTriggerOrder: TriggerOrderParams | null = null

  if (takeProfitPriceUsd !== null) {
    if (positionSide === 'long') {
      greaterTriggerOrder = buildTrigger(Direction.GreaterThan, takeProfitPriceUsd)
    } else {
      lessTriggerOrder = buildTrigger(Direction.LessThan, takeProfitPriceUsd)
    }
  }

  if (stopLossPriceUsd !== null) {
    if (positionSide === 'long') {
      lessTriggerOrder = buildTrigger(Direction.LessThan, stopLossPriceUsd)
    } else {
      greaterTriggerOrder = buildTrigger(Direction.GreaterThan, stopLossPriceUsd)
    }
  }

  return { greaterTriggerOrder, lessTriggerOrder }
}

function iocExecutionPriceWithSlippage(priceUsd: string, tradeSide: Side): string {
  const price = Number.parseFloat(priceUsd)
  const buffered = tradeSide === Side.Ask ? price * 0.9 : price * 1.1
  return buffered.toFixed(8).replace(/\.?0+$/, '')
}

async function phoenixAccountExists(client: PhoenixSdkClient, address: string): Promise<boolean | null> {
  if (!client.rpc.available) return null

  try {
    await client.rpc.accounts.fetchAccount(address as never)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/not found|does not exist|account does not exist|could not find|404/i.test(message)) {
      return false
    }
    console.warn('[api] Phoenix conditional account existence check failed:', message)
    return null
  }
}

async function buildMissingConditionalOrdersAccountIxs(
  client: PhoenixSdkClient,
  builder: {
    authority: Authority
    positionAuthority?: Authority
    traderPdaIndex: number
    traderSubaccountIndex: number
  },
): Promise<unknown[]> {
  const traderAccount = await client.pda.getTraderAddress({
    authority: builder.authority,
    traderPdaIndex: builder.traderPdaIndex,
    subaccountIndex: builder.traderSubaccountIndex,
  })
  const conditionalOrdersAccount = await client.pda.getConditionalOrdersAddress({ traderAccount })
  const exists = await phoenixAccountExists(client, conditionalOrdersAccount)

  if (exists !== false) return []

  const createIx = await client.ixs.buildCreateConditionalOrdersAccount({
    authority: builder.authority,
    positionAuthority: builder.positionAuthority,
    traderPdaIndex: builder.traderPdaIndex,
    traderSubaccountIndex: builder.traderSubaccountIndex,
  })

  return [createIx]
}

function normalizeCandle(raw: unknown) {
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

function upstreamStatusCode(err: unknown): 429 | 502 {
  if (err instanceof PhoenixUpstreamError && err.status === 429) return 429
  return 502
}

function upstreamProxyStatusCode(err: unknown): 400 | 404 | 409 | 422 | 429 | 502 | 504 {
  if (err instanceof PhoenixUpstreamError) {
    if (err.status === 400 || err.status === 404 || err.status === 409 || err.status === 422 || err.status === 429 || err.status === 504) {
      return err.status
    }
  }
  return 502
}

function upstreamErrorPayload(err: unknown, fallback: string) {
  if (err instanceof PhoenixUpstreamError) {
    const upstream = err.upstreamBody ? asRecord(safeJsonParse(err.upstreamBody)) : null
    const upstreamError = upstream?.error
    const upstreamText = err.upstreamBody.trim()
    return {
      error: typeof upstreamError === 'string' ? upstreamError : upstreamText || fallback,
      upstreamStatus: err.status,
    }
  }
  return { error: fallback }
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input) as unknown
  } catch {
    return null
  }
}

export const phoenixRoutes = new Hono()

// GET /perps/phoenix/health
phoenixRoutes.get('/health', (c) => {
  return c.json({
    venueId: 'phoenix',
    status: 'ok',
    upstreamBase: PHOENIX_API_BASE,
    readOnly: false,
    executionMode: 'solana_instruction_builder',
    depositBuilderAvailable: true,
    withdrawBuilderAvailable: true,
  })
})

// GET /perps/phoenix/status
phoenixRoutes.get('/status', async (c) => {
  try {
    return c.json(normalizedStatus(await getExchangeSnapshot()))
  } catch (err) {
    console.error('[api] Phoenix status unavailable:', err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix status unavailable'), upstreamStatusCode(err))
  }
})

// GET /perps/phoenix/markets
phoenixRoutes.get('/markets', async (c) => {
  try {
    const markets = await getRawMarkets()
    const stats = await getMarketStats(
      markets.data
        .map((market) => normalizeVenueSymbol(asString(market.symbol)))
        .filter((symbol): symbol is string => symbol !== null),
    )
    const data = markets.data
      .map((market) => normalizeMarket(market, markets.fetchedAt))
      .filter((market): market is NormalizedPhoenixMarket => market !== null)
      .map((market) => mergeMarketStats(market, stats.get(market.venueSymbol)))
      .sort((a, b) => a.baseSymbol.localeCompare(b.baseSymbol))

    return c.json(data)
  } catch (err) {
    console.error('[api] Phoenix markets unavailable:', err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix markets unavailable'), upstreamStatusCode(err))
  }
})

// GET /perps/phoenix/markets/:symbol
phoenixRoutes.get('/markets/:symbol', async (c) => {
  const venueSymbol = normalizeVenueSymbol(c.req.param('symbol'))
  if (!venueSymbol) return c.json({ error: 'Invalid Phoenix market symbol' }, 400)

  try {
    const result = await getMarketByVenueSymbol(venueSymbol)
    if (!result) return c.json({ error: 'Phoenix market not found' }, 404)

    const market = normalizeMarket(result.market, result.fetchedAt)
    if (!market) return c.json({ error: 'Phoenix market not found' }, 404)

    const stats = await getMarketStats([market.venueSymbol])
    return c.json(mergeMarketStats(market, stats.get(market.venueSymbol)))
  } catch (err) {
    console.error(`[api] Phoenix market ${venueSymbol} unavailable:`, err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix market unavailable'), upstreamStatusCode(err))
  }
})

// GET /perps/phoenix/trader/:authority/state?pdaIndex=0
phoenixRoutes.get('/trader/:authority/state', async (c) => {
  const authority = asNonEmptyString(c.req.param('authority'))
  if (!authority) return c.json({ error: 'Missing or invalid authority' }, 400)

  const pdaIndex = parseNonNegativeInteger(c.req.query('pdaIndex') ?? '0')
  if (pdaIndex === null) {
    return c.json({ error: 'Invalid pdaIndex', code: 'INVALID_PDA_INDEX' }, 400)
  }

  const params = new URLSearchParams({ pdaIndex: String(pdaIndex) })
  try {
    const [raw, v1Raw] = await Promise.all([
      phoenixFetchJson<unknown>(`/trader/${encodeURIComponent(authority)}/state?${params.toString()}`),
      getPhoenixTraderStateV1(authority, pdaIndex),
    ])
    const rawRecord = asRecord(raw)
    const v1Record = asRecord(v1Raw)
    const merged = mergePhoenixTraderState(raw, v1Raw)
    return c.json({
      venueId: 'phoenix',
      action: 'get_trader_state',
      authority,
      pdaIndex,
      slot: parseNullableInt(v1Record?.slot) ?? parseNullableInt(rawRecord?.slot),
      slotIndex: parseNullableInt(v1Record?.slotIndex) ?? parseNullableInt(rawRecord?.slotIndex),
      traders: merged.traders,
      triggerSource: merged.triggerSource,
      raw: {
        legacy: raw,
        v1: v1Raw,
      },
    })
  } catch (err) {
    console.error(`[api] Phoenix trader state ${authority} unavailable:`, err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix trader state unavailable'), upstreamProxyStatusCode(err))
  }
})

// GET /perps/phoenix/trader/:authority/order-history?traderPdaIndex=0&limit=50
phoenixRoutes.get('/trader/:authority/order-history', async (c) => {
  const authority = asNonEmptyString(c.req.param('authority'))
  if (!authority) return c.json({ error: 'Missing or invalid authority' }, 400)

  const params = new URLSearchParams({ limit: String(historyLimit(c.req.query('limit'))) })
  const traderPdaIndex = c.req.query('traderPdaIndex') ?? c.req.query('pdaIndex')
  const invalidPda = appendOptionalIntegerQuery(params, 'traderPdaIndex', traderPdaIndex)
  if (invalidPda) return invalidPda

  const marketSymbol = normalizeMarketSymbol(c.req.query('marketSymbol') ?? c.req.query('symbol'))
  if ((c.req.query('marketSymbol') ?? c.req.query('symbol')) && !marketSymbol) {
    return c.json({ error: 'Invalid marketSymbol', code: 'INVALID_MARKET_SYMBOL' }, 400)
  }
  if (marketSymbol) params.set('marketSymbol', marketSymbol)
  appendOptionalQuery(params, 'cursor', c.req.query('cursor'))
  appendOptionalQuery(params, 'privyId', c.req.query('privyId'))
  appendOptionalQuery(params, 'orderStatus', c.req.query('orderStatus'))

  try {
    const raw = await phoenixFetchJson<unknown>(`/trader/${encodeURIComponent(authority)}/order-history?${params.toString()}`)
    const rawRecord = asRecord(raw)
    return c.json({
      venueId: 'phoenix',
      action: 'get_order_history',
      authority,
      data: Array.isArray(rawRecord?.data) ? rawRecord.data : [],
      hasMore: asBoolean(rawRecord?.hasMore) ?? false,
      nextCursor: asString(rawRecord?.nextCursor),
      prevCursor: asString(rawRecord?.prevCursor),
      raw,
    })
  } catch (err) {
    console.error(`[api] Phoenix order history ${authority} unavailable:`, err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix order history unavailable'), upstreamProxyStatusCode(err))
  }
})

// GET /perps/phoenix/trader/:authority/trades-history?pdaIndex=0&limit=50
phoenixRoutes.get('/trader/:authority/trades-history', async (c) => {
  const authority = asNonEmptyString(c.req.param('authority'))
  if (!authority) return c.json({ error: 'Missing or invalid authority' }, 400)

  const params = new URLSearchParams({ limit: String(historyLimit(c.req.query('limit'))) })
  const invalidPda = appendOptionalIntegerQuery(params, 'pdaIndex', c.req.query('pdaIndex'))
  if (invalidPda) return invalidPda

  const marketSymbol = normalizeMarketSymbol(c.req.query('marketSymbol') ?? c.req.query('symbol'))
  if ((c.req.query('marketSymbol') ?? c.req.query('symbol')) && !marketSymbol) {
    return c.json({ error: 'Invalid marketSymbol', code: 'INVALID_MARKET_SYMBOL' }, 400)
  }
  if (marketSymbol) params.set('marketSymbol', marketSymbol)
  appendOptionalQuery(params, 'cursor', c.req.query('cursor'))

  try {
    const raw = await phoenixFetchJson<unknown>(`/trader/${encodeURIComponent(authority)}/trades-history?${params.toString()}`)
    const rawRecord = asRecord(raw)
    return c.json({
      venueId: 'phoenix',
      action: 'get_trade_history',
      authority,
      data: Array.isArray(rawRecord?.data) ? rawRecord.data : [],
      hasMore: asBoolean(rawRecord?.hasMore) ?? false,
      nextCursor: asString(rawRecord?.nextCursor),
      prevCursor: asString(rawRecord?.prevCursor),
      raw,
    })
  } catch (err) {
    console.error(`[api] Phoenix trade history ${authority} unavailable:`, err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix trade history unavailable'), upstreamProxyStatusCode(err))
  }
})

// GET /perps/phoenix/trader/:authority/collateral-history?pdaIndex=0&limit=50
phoenixRoutes.get('/trader/:authority/collateral-history', async (c) => {
  const authority = asNonEmptyString(c.req.param('authority'))
  if (!authority) return c.json({ error: 'Missing or invalid authority' }, 400)

  const params = new URLSearchParams({ limit: String(historyLimit(c.req.query('limit'))) })
  const invalidPda = appendOptionalIntegerQuery(params, 'pdaIndex', c.req.query('pdaIndex'))
  if (invalidPda) return invalidPda

  appendOptionalQuery(params, 'cursor', c.req.query('cursor'))
  appendOptionalQuery(params, 'nextCursor', c.req.query('nextCursor'))
  appendOptionalQuery(params, 'prevCursor', c.req.query('prevCursor'))

  try {
    const raw = await phoenixFetchJson<unknown>(`/trader/${encodeURIComponent(authority)}/collateral-history?${params.toString()}`)
    const rawRecord = asRecord(raw)
    return c.json({
      venueId: 'phoenix',
      action: 'get_collateral_history',
      authority,
      data: Array.isArray(rawRecord?.data) ? rawRecord.data : [],
      hasMore: asBoolean(rawRecord?.hasMore) ?? false,
      nextCursor: asString(rawRecord?.nextCursor),
      prevCursor: asString(rawRecord?.prevCursor),
      raw,
    })
  } catch (err) {
    console.error(`[api] Phoenix collateral history ${authority} unavailable:`, err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix collateral history unavailable'), upstreamProxyStatusCode(err))
  }
})

// POST /perps/phoenix/invite/activate
phoenixRoutes.post('/invite/activate', async (c) => {
  const parsed = await readJsonRecord(c)
  if ('response' in parsed) return parsed.response

  const missing = missingStringFields(parsed.body, ['authority', 'code'])
  if (missing.length > 0) return c.json(missingFieldsPayload(missing), 400)

  try {
    const raw = await phoenixFetchJson<unknown>('/v1/invite/activate', { method: 'POST', body: parsed.body })
    const rawRecord = asRecord(raw)
    return c.json({
      venueId: 'phoenix',
      action: 'activate_invite',
      authority: asNonEmptyString(parsed.body.authority),
      traderPda: asString(rawRecord?.trader_pda),
      raw,
    })
  } catch (err) {
    console.error('[api] Phoenix invite activation unavailable:', err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix invite activation unavailable'), upstreamProxyStatusCode(err))
  }
})

// POST /perps/phoenix/invite/activate-with-referral
phoenixRoutes.post('/invite/activate-with-referral', async (c) => {
  const parsed = await readJsonRecord(c)
  if ('response' in parsed) return parsed.response

  const missing = missingStringFields(parsed.body, ['authority', 'referral_code'])
  if (missing.length > 0) return c.json(missingFieldsPayload(missing), 400)

  try {
    const raw = await phoenixFetchJson<unknown>('/v1/invite/activate-with-referral', { method: 'POST', body: parsed.body })
    const rawRecord = asRecord(raw)
    return c.json({
      venueId: 'phoenix',
      action: 'activate_referral',
      authority: asNonEmptyString(parsed.body.authority),
      traderPda: asString(rawRecord?.trader_pda),
      raw,
    })
  } catch (err) {
    console.error('[api] Phoenix referral activation unavailable:', err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix referral activation unavailable'), upstreamProxyStatusCode(err))
  }
})

// POST /perps/phoenix/tx/market-order
phoenixRoutes.post('/tx/market-order', async (c) => {
  const parsed = await readJsonRecord(c)
  if ('response' in parsed) return parsed.response

  const builder = parseSdkOrderBuilderBody(parsed.body, 'market')
  if ('response' in builder) return builder.response

  const useRawClient = builder.orderFlags !== OrderFlags.None
  const endpoint = useRawClient ? 'sdk:ixs.buildPlaceMarketOrder:raw' : 'sdk:ixs.buildPlaceMarketOrder'
  try {
    const client = useRawClient ? getPhoenixRawSdkClient() : getPhoenixSdkClient()
    await client.exchange.ready()
    const orderPacket = await client.orderPackets.buildMarketOrderPacket({
      symbol: builder.symbol,
      side: builder.side,
      baseUnits: builder.baseUnits,
      priceLimitUsd: builder.priceLimitUsd,
      orderFlags: builder.orderFlags,
    })
    const raw = await client.ixs.buildPlaceMarketOrder({
      authority: builder.authority,
      positionAuthority: builder.positionAuthority,
      symbol: builder.symbol,
      orderPacket,
      traderPdaIndex: builder.traderPdaIndex,
      traderSubaccountIndex: builder.traderSubaccountIndex,
    })
    return c.json(sdkInstructionBuilderResponse('place_market_order', endpoint, raw))
  } catch (err) {
    console.error('[api] Phoenix market order builder unavailable:', err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix market order builder unavailable'), upstreamProxyStatusCode(err))
  }
})

// POST /perps/phoenix/tx/limit-order
phoenixRoutes.post('/tx/limit-order', async (c) => {
  const parsed = await readJsonRecord(c)
  if ('response' in parsed) return parsed.response

  const builder = parseSdkOrderBuilderBody(parsed.body, 'limit')
  if ('response' in builder) return builder.response

  const useRawClient = builder.orderFlags !== OrderFlags.None
  const endpoint = useRawClient ? 'sdk:ixs.buildPlaceLimitOrder:raw' : 'sdk:ixs.buildPlaceLimitOrder'
  try {
    const client = useRawClient ? getPhoenixRawSdkClient() : getPhoenixSdkClient()
    await client.exchange.ready()
    const orderPacket = await client.orderPackets.buildLimitOrderPacket({
      symbol: builder.symbol,
      side: builder.side,
      priceUsd: builder.priceUsd,
      baseUnits: builder.baseUnits,
      orderFlags: builder.orderFlags,
    })
    const raw = await client.ixs.buildPlaceLimitOrder({
      authority: builder.authority,
      positionAuthority: builder.positionAuthority,
      symbol: builder.symbol,
      orderPacket,
      traderPdaIndex: builder.traderPdaIndex,
      traderSubaccountIndex: builder.traderSubaccountIndex,
    })
    return c.json(sdkInstructionBuilderResponse('place_limit_order', endpoint, raw))
  } catch (err) {
    console.error('[api] Phoenix limit order builder unavailable:', err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix limit order builder unavailable'), upstreamProxyStatusCode(err))
  }
})

// POST /perps/phoenix/tx/cancel-conditional-order
phoenixRoutes.post('/tx/cancel-conditional-order', async (c) => {
  const parsed = await readJsonRecord(c)
  if ('response' in parsed) return parsed.response

  const missing = missingStringFields(parsed.body, ['authority', 'symbol', 'executionDirection'])
  if (missing.length > 0) return c.json(missingFieldsPayload(missing), 400)

  const invalid = invalidNonNegativeIntegerFields(parsed.body, ['traderPdaIndex', 'conditionalOrderIndex'])
  if (invalid.length > 0) return c.json(invalidFieldsPayload(invalid), 400)

  const endpoint = '/v1/ix/cancel-conditional-order'
  try {
    const raw = await phoenixFetchJson<unknown>(endpoint, { method: 'POST', body: parsed.body })
    return c.json(instructionBuilderResponse('cancel_conditional_order', endpoint, raw))
  } catch (err) {
    console.error('[api] Phoenix conditional cancel builder unavailable:', err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix conditional cancel builder unavailable'), upstreamProxyStatusCode(err))
  }
})

// POST /perps/phoenix/tx/position-conditional-order
phoenixRoutes.post('/tx/position-conditional-order', async (c) => {
  const parsed = await readJsonRecord(c)
  if ('response' in parsed) return parsed.response

  const builder = parsePositionConditionalOrderBody(parsed.body)
  if ('response' in builder) return builder.response

  const endpoint = 'sdk:ixs.buildPlacePositionConditionalOrder:raw'
  try {
    const client = getPhoenixRawSdkClient()
    const { greaterTriggerOrder, lessTriggerOrder } = await positionConditionalTriggers(
      client,
      builder.symbol,
      builder.positionSide,
      builder.takeProfitPriceUsd,
      builder.stopLossPriceUsd,
    )
    const size = await resolvePositionConditionalSize(client, builder.symbol, builder)
    const setupIxs = await buildMissingConditionalOrdersAccountIxs(client, builder)
    const placeIx = await client.ixs.buildPlacePositionConditionalOrder({
      authority: builder.authority,
      positionAuthority: builder.positionAuthority,
      symbol: builder.symbol,
      greaterTriggerOrder,
      lessTriggerOrder,
      sizeBaseLots: size.sizeBaseLots,
      sizePercent: size.sizePercent,
      traderPdaIndex: builder.traderPdaIndex,
      traderSubaccountIndex: builder.traderSubaccountIndex,
    })
    const raw = setupIxs.length > 0 ? [...setupIxs, placeIx] : placeIx
    return c.json(sdkInstructionBuilderResponse('place_position_conditional_order', endpoint, raw))
  } catch (err) {
    console.error('[api] Phoenix position conditional builder unavailable:', err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix position conditional builder unavailable'), upstreamProxyStatusCode(err))
  }
})

// POST /perps/phoenix/tx/deposit
phoenixRoutes.post('/tx/deposit', async (c) => {
  const parsed = await readJsonRecord(c)
  if ('response' in parsed) return parsed.response

  const builder = parseTransferBuilderInput(parsed.body)
  if (builder.response) return builder.response

  try {
    const raw = await getPhoenixSdkClient().ixs.buildDepositIxs(builder.input as never)
    return c.json(sdkInstructionBuilderResponse('deposit', '/tx/deposit', raw))
  } catch (err) {
    console.error('[api] Phoenix deposit builder unavailable:', err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix deposit builder unavailable'), upstreamProxyStatusCode(err))
  }
})

// POST /perps/phoenix/tx/withdraw
phoenixRoutes.post('/tx/withdraw', async (c) => {
  const parsed = await readJsonRecord(c)
  if ('response' in parsed) return parsed.response

  const builder = parseTransferBuilderInput(parsed.body)
  if (builder.response) return builder.response

  try {
    const raw = await getPhoenixSdkClient().ixs.buildWithdrawIxs(builder.input as never)
    return c.json(sdkInstructionBuilderResponse('withdraw', '/tx/withdraw', raw))
  } catch (err) {
    console.error('[api] Phoenix withdraw builder unavailable:', err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix withdraw builder unavailable'), upstreamProxyStatusCode(err))
  }
})

// GET /perps/phoenix/candles?symbol=&interval=&count=&startTime=&endTime=
phoenixRoutes.get('/candles', async (c) => {
  const venueSymbol = normalizeVenueSymbol(c.req.query('symbol'))
  if (!venueSymbol) return c.json({ error: 'Missing or invalid symbol' }, 400)

  const interval = c.req.query('interval') ?? '1h'
  if (!SUPPORTED_CANDLE_INTERVALS.has(interval)) {
    return c.json({
      error: 'Unsupported Phoenix candle interval',
      code: 'UNSUPPORTED_INTERVAL',
      supportedIntervals: [...SUPPORTED_CANDLE_INTERVALS],
    }, 400)
  }

  try {
    const knownMarket = await getMarketByVenueSymbol(venueSymbol)
    if (!knownMarket) return c.json({ error: 'Phoenix market not found' }, 404)

    const limit = parseCandleLimit(c.req.query('count') ?? c.req.query('limit'))
    const params = new URLSearchParams({ symbol: venueSymbol, timeframe: interval, limit: String(limit) })
    appendOptionalQuery(params, 'startTime', c.req.query('startTime'))
    appendOptionalQuery(params, 'endTime', c.req.query('endTime'))
    appendOptionalQuery(params, 'enableExternalSource', c.req.query('enableExternalSource'))

    const cacheKey = params.toString()
    const raw = await cachedJson(candlesCache, cacheKey, CANDLES_CACHE_TTL_MS, () => (
      phoenixFetchJson<unknown[]>(`/candles?${cacheKey}`)
    ))
    const candles = raw.data.map(normalizeCandle).filter((candle): candle is NonNullable<ReturnType<typeof normalizeCandle>> => candle !== null)
    return c.json(candles)
  } catch (err) {
    console.error(`[api] Phoenix candles ${venueSymbol} unavailable:`, err instanceof Error ? err.message : err)
    return c.json(upstreamErrorPayload(err, 'Phoenix candles unavailable'), upstreamStatusCode(err))
  }
})
