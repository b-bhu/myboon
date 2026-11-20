import type { MarketCandle } from '@myboon/shared/stories'

/**
 * One Hyperliquid public market data cache per API process (#691). Mark prices
 * and 24h moves for `quotes`, listing state for `isListed`, and a short-lived
 * candle cache for `candles`, all served from the public
 * `https://api.hyperliquid.xyz/info` endpoint (no API key). Nothing here ever
 * calls a private trading API (#619 stays parked).
 */

const INFO_URL = 'https://api.hyperliquid.xyz/info'
const UPSTREAM_TIMEOUT_MS = 5_000
const DEFAULT_PRICES_TTL_MS = 30_000
/** A price entry answers with nulls once its snapshot is older than this (never a guess). */
const PRICE_STALE_MS = 15 * 60 * 1000
const CANDLES_TTL_MS = 60_000
/** Keeps the candle cache bounded across symbols, intervals and counts. */
const CANDLE_CACHE_PRUNE_SIZE = 256

export const CANDLE_INTERVALS = ['15m', '1h', '4h', '1d'] as const
export type CandleInterval = (typeof CANDLE_INTERVALS)[number]

const CANDLE_COUNT_DEFAULT = 168
const CANDLE_COUNT_MIN = 1
const CANDLE_COUNT_MAX = 500

const CANDLE_INTERVAL_MS: Record<CandleInterval, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

export interface HyperliquidQuote {
  price: number | null
  change24hPct: number | null
  asOf: string | null
}

/** Map with one quote per requested symbol; missing symbols carry all-null quotes. */
export type HyperliquidQuoteMap = Map<string, HyperliquidQuote>

/** The slice of the price service the stories route reads prices through (#691). */
export interface HyperliquidQuotes {
  quotes(symbols: readonly string[], options: { waitMs: number }): Promise<HyperliquidQuoteMap>
}

export interface HyperliquidPriceService extends HyperliquidQuotes {
  /** true when listed, false when missing from the snapshot or delisted, 'unavailable' when no snapshot ever loaded. */
  isListed(symbol: string): Promise<boolean | 'unavailable'>
  /** Cached OHLCV candles, oldest first; keeps the last good candles when a refresh fails. */
  candles(symbol: string, interval: CandleInterval, count: number): Promise<MarketCandle[]>
}

interface PriceEntry {
  price: number | null
  change24hPct: number | null
  delisted: boolean
}

interface DexSnapshot {
  fetchedAt: number
  entries: Map<string, PriceEntry>
}

interface CandleCacheEntry {
  fetchedAt: number
  candles: MarketCandle[]
}

interface MergedEntry extends PriceEntry {
  fetchedAt: number
}

export function createHyperliquidPrices(
  options: { fetch?: typeof globalThis.fetch, now?: () => number } = {},
): HyperliquidPriceService {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const nowMs = options.now ?? Date.now
  const envTtlMs = Number(process.env.HYPERLIQUID_PRICES_TTL_MS)
  const pricesTtlMs = Number.isSafeInteger(envTtlMs) && envTtlMs > 0 ? envTtlMs : DEFAULT_PRICES_TTL_MS

  let coreSnapshot: DexSnapshot | null = null
  let xyzSnapshot: DexSnapshot | null = null
  let refreshInFlight: Promise<void> | null = null
  const candleCache = new Map<string, CandleCacheEntry>()

  function hasSnapshot(): boolean {
    return coreSnapshot !== null || xyzSnapshot !== null
  }

  /** Fresh when the newest successful dex fetch is within the TTL. */
  function isFresh(): boolean {
    const newest = Math.max(coreSnapshot?.fetchedAt ?? Number.NEGATIVE_INFINITY, xyzSnapshot?.fetchedAt ?? Number.NEGATIVE_INFINITY)
    return Number.isFinite(newest) && nowMs() - newest < pricesTtlMs
  }

  function mergedEntries(): Map<string, MergedEntry> {
    const merged = new Map<string, MergedEntry>()
    if (coreSnapshot) {
      for (const [symbol, entry] of coreSnapshot.entries) {
        merged.set(symbol, { ...entry, fetchedAt: coreSnapshot.fetchedAt })
      }
    }
    if (xyzSnapshot) {
      for (const [symbol, entry] of xyzSnapshot.entries) {
        merged.set(symbol, { ...entry, fetchedAt: xyzSnapshot.fetchedAt })
      }
    }
    return merged
  }

  /** Starts the one in-flight refresh; concurrent callers share it. */
  function runRefresh(): Promise<void> {
    refreshInFlight ??= refresh().finally(() => {
      refreshInFlight = null
    })
    return refreshInFlight
  }

  /**
   * One refresh = two POSTs (core and xyz dex), each with its own 5 s timeout.
   * A failed dex keeps that dex's previous entries with their own fetch time.
   */
  async function refresh(): Promise<void> {
    const [coreResult, xyzResult] = await Promise.allSettled([
      fetchMetaAndAssetCtxs(),
      fetchMetaAndAssetCtxs('xyz'),
    ])
    const fetchedAt = nowMs()
    if (coreResult.status === 'fulfilled') {
      coreSnapshot = { fetchedAt, entries: coreResult.value }
    } else {
      logRefreshFailure('core', coreResult.reason)
    }
    if (xyzResult.status === 'fulfilled') {
      xyzSnapshot = { fetchedAt, entries: xyzResult.value }
    } else {
      logRefreshFailure('xyz', xyzResult.reason)
    }
  }

  /** Logs once per refresh per failed source, never per request. */
  function logRefreshFailure(source: string, reason: unknown): void {
    console.error(
      '[hyperliquid] price refresh failed',
      source,
      reason instanceof Error ? reason.message : 'unknown error',
    )
  }

  async function fetchMetaAndAssetCtxs(dex?: 'xyz'): Promise<Map<string, PriceEntry>> {
    const body: Record<string, unknown> = { type: 'metaAndAssetCtxs' }
    if (dex) body.dex = dex
    const response = await fetchImpl(INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Hyperliquid responded ${response.status}`)
    }
    return parseMetaAndAssetCtxs(await response.json())
  }

  /** Response is `[meta, ctxs]`: zip `meta.universe[i].name` with `ctxs[i]` by index. */
  function parseMetaAndAssetCtxs(value: unknown): Map<string, PriceEntry> {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new Error('Hyperliquid sent an unexpected metaAndAssetCtxs response')
    }
    const meta = value[0] as { universe?: unknown } | null | undefined
    const universe = Array.isArray(meta?.universe) ? (meta as { universe: unknown[] }).universe : null
    const ctxs = Array.isArray(value[1]) ? value[1] : null
    if (!universe || !ctxs) {
      throw new Error('Hyperliquid sent an unexpected metaAndAssetCtxs response')
    }
    const entries = new Map<string, PriceEntry>()
    for (let index = 0; index < Math.min(universe.length, ctxs.length); index += 1) {
      const name = (universe[index] as { name?: unknown } | null | undefined)?.name
      if (typeof name !== 'string' || !name) continue
      const ctx = (ctxs[index] ?? null) as { markPx?: unknown, prevDayPx?: unknown } | null
      const delisted = (universe[index] as { isDelisted?: unknown } | null)?.isDelisted === true
      const price = toFiniteNumber(ctx?.markPx)
      const prevDayPx = toFiniteNumber(ctx?.prevDayPx)
      const change24hPct = price !== null && prevDayPx !== null && prevDayPx > 0
        ? round2((price / prevDayPx - 1) * 100)
        : null
      entries.set(name, {
        price: delisted ? null : price,
        change24hPct: delisted ? null : change24hPct,
        delisted,
      })
    }
    return entries
  }

  function quoteFor(symbol: string, merged: Map<string, MergedEntry>, now: number): HyperliquidQuote {
    const entry = merged.get(symbol)
    if (!entry || entry.delisted || now - entry.fetchedAt > PRICE_STALE_MS) {
      return { price: null, change24hPct: null, asOf: null }
    }
    return {
      price: entry.price,
      change24hPct: entry.change24hPct,
      asOf: new Date(entry.fetchedAt).toISOString(),
    }
  }

  async function quotes(symbols: readonly string[], quoteOptions: { waitMs: number }): Promise<HyperliquidQuoteMap> {
    try {
      if (symbols.length > 0 && !isFresh()) {
        await Promise.race([runRefresh(), waitTimer(quoteOptions.waitMs)])
      }
    } catch {
      // Never throws: a failed refresh simply leaves the last good snapshot in place.
    }
    const merged = mergedEntries()
    const now = nowMs()
    const result: HyperliquidQuoteMap = new Map()
    for (const symbol of symbols) result.set(symbol, quoteFor(symbol, merged, now))
    return result
  }

  async function isListed(symbol: string): Promise<boolean | 'unavailable'> {
    if (!hasSnapshot()) {
      try {
        await runRefresh()
      } catch {
        // refresh() is failure-tolerant; this guard only covers the dedup wrapper.
      }
      if (!hasSnapshot()) return 'unavailable'
    }
    const entry = mergedEntries().get(symbol)
    if (!entry) return false
    return !entry.delisted
  }

  async function candles(symbol: string, interval: CandleInterval, count: number): Promise<MarketCandle[]> {
    const key = `${symbol}|${interval}|${count}`
    const cached = candleCache.get(key)
    if (cached && nowMs() - cached.fetchedAt < CANDLES_TTL_MS) return cached.candles
    try {
      const fresh = await fetchCandles(symbol, interval, count, nowMs())
      pruneCandleCache()
      candleCache.set(key, { fetchedAt: nowMs(), candles: fresh })
      return fresh
    } catch (error) {
      // Upstream failure with a stale cache: keep serving the last good candles.
      if (cached) return cached.candles
      throw error
    }
  }

  async function fetchCandles(symbol: string, interval: CandleInterval, count: number, now: number): Promise<MarketCandle[]> {
    const response = await fetchImpl(INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: {
          coin: symbol,
          interval,
          startTime: now - count * CANDLE_INTERVAL_MS[interval],
          endTime: now,
        },
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Hyperliquid responded ${response.status}`)
    }
    return parseCandles(await response.json())
  }

  function parseCandles(value: unknown): MarketCandle[] {
    if (!Array.isArray(value)) {
      throw new Error('Hyperliquid sent an unexpected candleSnapshot response')
    }
    const candles: MarketCandle[] = []
    for (const row of value) {
      const candle = toCandle(row)
      if (candle) candles.push(candle)
    }
    return candles.sort((left, right) => left.timeMs - right.timeMs)
  }

  /** Maps `{ t, o, h, l, c, v }` to `MarketCandle`, dropping rows with a non-finite o/h/l/c. */
  function toCandle(row: unknown): MarketCandle | null {
    if (!row || typeof row !== 'object') return null
    const ctx = row as { t?: unknown, o?: unknown, h?: unknown, l?: unknown, c?: unknown, v?: unknown }
    const timeMs = toFiniteNumber(ctx.t)
    const open = toFiniteNumber(ctx.o)
    const high = toFiniteNumber(ctx.h)
    const low = toFiniteNumber(ctx.l)
    const close = toFiniteNumber(ctx.c)
    if (timeMs === null || open === null || high === null || low === null || close === null) return null
    return { timeMs, open, high, low, close, volume: toFiniteNumber(ctx.v) }
  }

  function pruneCandleCache(): void {
    if (candleCache.size < CANDLE_CACHE_PRUNE_SIZE) return
    const now = nowMs()
    for (const [key, entry] of candleCache) {
      if (now - entry.fetchedAt >= CANDLES_TTL_MS) candleCache.delete(key)
    }
  }

  return {
    quotes,
    isListed,
    candles,
  }
}

/** Clamps `count` to 1..500; anything missing or non-numeric falls back to 168. */
export function parseCandleCount(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return CANDLE_COUNT_DEFAULT
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) return CANDLE_COUNT_DEFAULT
  return Math.min(Math.max(parsed, CANDLE_COUNT_MIN), CANDLE_COUNT_MAX)
}

export function isCandleInterval(value: string): value is CandleInterval {
  return (CANDLE_INTERVALS as readonly string[]).includes(value)
}

function waitTimer(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms))
  })
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
