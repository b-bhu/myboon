import { createPhoenixClient } from '@ellipsis-labs/rise'
import type { PhoenixConfig } from './config.js'
import { asRecord, asString, normalizeVenueSymbol, parseNullableNumber, safeJsonParse } from './parse.js'
import { sdkAuthority } from './sdk.js'
import type {
  CacheEntry,
  PhoenixExchangeSnapshot,
  PhoenixFetchOptions,
  PhoenixMarketConfig,
  PhoenixMarketStats,
  PhoenixSdkClient,
} from './types.js'

export class PhoenixUpstreamError extends Error {
  constructor(readonly status: number, readonly upstreamBody: string) {
    super(`Phoenix upstream failed (${status})`)
  }
}

export function upstreamStatusCode(err: unknown): 429 | 502 {
  if (err instanceof PhoenixUpstreamError && err.status === 429) return 429
  return 502
}

export function upstreamProxyStatusCode(err: unknown): 400 | 404 | 409 | 422 | 429 | 502 | 504 {
  if (err instanceof PhoenixUpstreamError) {
    if (err.status === 400 || err.status === 404 || err.status === 409 || err.status === 422 || err.status === 429 || err.status === 504) {
      return err.status
    }
  }
  return 502
}

export function upstreamErrorPayload(err: unknown, fallback: string) {
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

function marketStatsCacheKey(venueSymbols: string[]): string {
  return [...new Set(venueSymbols)].sort().join(',')
}

function fetchMarketStatsViaWebSocket(
  wsUrl: string,
  timeoutMs: number,
  venueSymbols: string[],
): Promise<Map<string, PhoenixMarketStats>> {
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

    const timeout = setTimeout(finish, timeoutMs)

    try {
      ws = new WebSocket(wsUrl)
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

/**
 * One Phoenix upstream per process (#831): the REST/WebSocket reads, their
 * response caches and the two lazily-built SDK clients, all driven by a
 * `PhoenixConfig` passed in rather than read from the env.
 */
export function createPhoenixUpstream(config: PhoenixConfig) {
  const statusCache = new Map<string, CacheEntry<PhoenixExchangeSnapshot>>()
  const marketsCache = new Map<string, CacheEntry<PhoenixMarketConfig[]>>()
  const marketStatsCache = new Map<string, CacheEntry<Map<string, PhoenixMarketStats>>>()
  const candlesCache = new Map<string, CacheEntry<unknown[]>>()

  let phoenixSdkClient: PhoenixSdkClient | null = null
  let phoenixRawSdkClient: PhoenixSdkClient | null = null

  async function fetchJson<T>(path: string, options: PhoenixFetchOptions = {}): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs)
    const method = options.method ?? 'GET'
    const headers: Record<string, string> = { Accept: 'application/json' }
    const init: RequestInit = { method, signal: controller.signal, headers }

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }

    try {
      const res = await fetch(`${config.apiBase}${path}`, init)

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

  async function getExchangeSnapshot(): Promise<CacheEntry<PhoenixExchangeSnapshot>> {
    return cachedJson(statusCache, 'snapshot', config.statusCacheTtlMs, () => (
      fetchJson<PhoenixExchangeSnapshot>('/v1/exchange/snapshot')
    ))
  }

  async function getRawMarkets(): Promise<CacheEntry<PhoenixMarketConfig[]>> {
    return cachedJson(marketsCache, 'markets', config.marketsCacheTtlMs, () => (
      fetchJson<PhoenixMarketConfig[]>('/exchange/markets')
    ))
  }

  async function getMarketByVenueSymbol(venueSymbol: string): Promise<{ market: PhoenixMarketConfig; fetchedAt: number } | null> {
    const entry = await getRawMarkets()
    const market = entry.data.find((candidate) => normalizeVenueSymbol(asString(candidate.symbol)) === venueSymbol)
    return market ? { market, fetchedAt: entry.fetchedAt } : null
  }

  async function getMarketStats(venueSymbols: string[]): Promise<Map<string, PhoenixMarketStats>> {
    const symbols = [...new Set(venueSymbols.map((symbol) => normalizeVenueSymbol(symbol)).filter((symbol): symbol is string => symbol !== null))]
    if (symbols.length === 0) return new Map()

    return (await cachedJson(marketStatsCache, marketStatsCacheKey(symbols), config.marketStatsCacheTtlMs, () => (
      fetchMarketStatsViaWebSocket(config.wsUrl, config.marketStatsTimeoutMs, symbols)
    ))).data
  }

  /** `query` is the already-built `/candles` query string; it doubles as the cache key. */
  async function getCandles(query: string): Promise<CacheEntry<unknown[]>> {
    return cachedJson(candlesCache, query, config.candlesCacheTtlMs, () => (
      fetchJson<unknown[]>(`/candles?${query}`)
    ))
  }

  function getSdkClient(): PhoenixSdkClient {
    if (!phoenixSdkClient) {
      phoenixSdkClient = createPhoenixClient({
        apiUrl: config.apiBase,
        rpcUrl: config.rpcUrl,
        exchangeMetadata: { stream: true },
        flight: {
          builderAuthority: sdkAuthority(config.builderAuthority),
          builderPdaIndex: config.builderPdaIndex,
          builderSubaccountIndex: config.builderSubaccountIndex,
        },
      })
    }
    return phoenixSdkClient
  }

  function getRawSdkClient(): PhoenixSdkClient {
    if (!phoenixRawSdkClient) {
      phoenixRawSdkClient = createPhoenixClient({
        apiUrl: config.apiBase,
        rpcUrl: config.rpcUrl,
        exchangeMetadata: { stream: true },
      })
    }
    return phoenixRawSdkClient
  }

  return {
    config,
    fetchJson,
    getExchangeSnapshot,
    getRawMarkets,
    getMarketByVenueSymbol,
    getMarketStats,
    getCandles,
    getSdkClient,
    getRawSdkClient,
  }
}

export type PhoenixUpstream = ReturnType<typeof createPhoenixUpstream>
