import type { MarketHeatmapInterval, MarketHeatmapToken } from './types.js'

export const JUPITER_VERIFIED_TOKENS_PATH = '/tokens/v2/tag'
export const MARKET_HEATMAP_LIMIT = 20
export const MARKET_HEATMAP_TIMEOUT_MS = 8_000
export const MAX_PROVIDER_BODY_BYTES = 16 * 1024 * 1024
export const MAX_PROVIDER_ROWS = 5_000

const DEFAULT_JUPITER_API_BASE = 'https://api.jup.ag'
const RETRY_AFTER_MAX_MS = 60_000
const STATS_KEYS: Record<MarketHeatmapInterval, string> = {
  '5m': 'stats5m',
  '1h': 'stats1h',
  '6h': 'stats6h',
  '24h': 'stats24h',
}
const EXCLUDED_HEATMAP_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
])

export interface ProviderErrorDetail {
  code: string
  retryable: boolean
  message: string
  retryAfterMs?: number
  global?: boolean
}

export class JupiterProviderError extends Error {
  constructor(public readonly detail: ProviderErrorDetail) {
    super(detail.message)
    this.name = 'JupiterProviderError'
  }
}

export interface JupiterMetric {
  volumeUsd: number | null
  priceChangePct: number | null
  partial: boolean
}

export interface JupiterSnapshotToken {
  address: string
  symbol: string
  name: string
  priceUsd: number | null
  marketCapUsd: number | null
  liquidityUsd: number | null
  metrics: Record<MarketHeatmapInterval, JupiterMetric>
}

export interface NormalizedJupiterSnapshot {
  tokens: JupiterSnapshotToken[]
  partial: boolean
  partialByInterval: Record<MarketHeatmapInterval, boolean>
  malformedRows: number
}

export interface JupiterFetchOptions {
  jupApiKey?: string
  jupApiBase?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function fetchJupiterVerifiedSnapshot(
  options: JupiterFetchOptions = {},
): Promise<NormalizedJupiterSnapshot> {
  const apiKey = options.jupApiKey?.trim()
  if (!apiKey) {
    throw new JupiterProviderError({
      code: 'CONFIGURATION',
      retryable: false,
      message: 'Jupiter is not configured',
    })
  }

  const base = options.jupApiBase?.trim() || DEFAULT_JUPITER_API_BASE
  // The base is server configuration, while the path and query stay fixed.
  const requestUrl = new URL(JUPITER_VERIFIED_TOKENS_PATH, `${base.replace(/\/+$/, '')}/`)
  requestUrl.searchParams.set('query', 'verified')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const request = (async () => {
      let response: Response
      try {
        response = await (options.fetchImpl ?? fetch)(requestUrl, {
          headers: {
            Accept: 'application/json',
            'x-api-key': apiKey,
          },
          signal: controller.signal,
          redirect: 'error',
        })
      } catch (error) {
        if (error instanceof JupiterProviderError) throw error
        throw new JupiterProviderError({
          code: 'UPSTREAM_UNAVAILABLE',
          retryable: true,
          message: 'Jupiter is unavailable',
        })
      }

      if (!response.ok) throw httpError(response)

      let payload: unknown
      try {
        payload = await readBoundedJson(response)
      } catch (error) {
        if (error instanceof JupiterProviderError) throw error
        throw new JupiterProviderError({
          code: 'INVALID_UPSTREAM_RESPONSE',
          retryable: true,
          message: 'Jupiter returned invalid data',
        })
      }
      return normalizeJupiterSnapshot(payload)
    })()

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new JupiterProviderError({
          code: 'UPSTREAM_TIMEOUT',
          retryable: true,
          message: 'Jupiter request timed out',
        }))
      }, options.timeoutMs ?? MARKET_HEATMAP_TIMEOUT_MS)
    })
    return await Promise.race([request, timeout])
  } catch (error) {
    if (error instanceof JupiterProviderError) throw error
    throw new JupiterProviderError({
      code: 'UPSTREAM_UNAVAILABLE',
      retryable: true,
      message: 'Jupiter is unavailable',
    })
  } finally {
    clearTimeout(timer)
  }
}

export function normalizeJupiterSnapshot(payload: unknown): NormalizedJupiterSnapshot {
  if (!Array.isArray(payload)) invalidResponse()
  if (payload.length > MAX_PROVIDER_ROWS) tooLargeResponse()
  if (payload.length === 0) return { tokens: [], partial: false, partialByInterval: emptyPartialByInterval(), malformedRows: 0 }

  const byAddress = new Map<string, JupiterSnapshotToken>()
  const partialByInterval = emptyPartialByInterval()
  let malformedRows = 0
  let recognizedRows = 0

  for (const item of payload) {
    const normalized = normalizeRow(item)
    if (normalized.kind === 'unverified') {
      if (normalized.recognized) recognizedRows++
      if (normalized.malformed) {
        malformedRows++
        markAllPartial(partialByInterval)
      }
      continue
    }
    if (!normalized.token) {
      malformedRows++
      markAllPartial(partialByInterval)
      continue
    }
    recognizedRows++
    for (const interval of Object.keys(STATS_KEYS) as MarketHeatmapInterval[]) {
      partialByInterval[interval] ||= normalized.partialByInterval[interval]
    }
    const previous = byAddress.get(normalized.token.address)
    byAddress.set(normalized.token.address, previous
      ? mergeTokens(previous, normalized.token)
      : normalized.token)
  }

  if (byAddress.size === 0 && recognizedRows === 0 && malformedRows > 0) invalidResponse()

  const allTokens = [...byAddress.values()]
  const selected = new Map<string, JupiterSnapshotToken>()
  for (const interval of Object.keys(STATS_KEYS) as MarketHeatmapInterval[]) {
    const ranked = allTokens
      .filter((token) => (token.metrics[interval].volumeUsd ?? 0) > 0)
      .sort((left, right) => compareMetric(left, right, interval))
      .slice(0, MARKET_HEATMAP_LIMIT)
    for (const token of ranked) selected.set(token.address, token)
  }

  const partial = Object.values(partialByInterval).some(Boolean)
  return { tokens: [...selected.values()], partial, partialByInterval, malformedRows }
}

type NormalizedRow =
  | { kind: 'unverified'; recognized: boolean; malformed: boolean }
  | {
      kind: 'verified'
      token: JupiterSnapshotToken | null
      partialByInterval: Record<MarketHeatmapInterval, boolean>
    }

function normalizeRow(value: unknown): NormalizedRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'verified', token: null, partialByInterval: allPartialByInterval() }
  }
  const row = value as Record<string, unknown>
  const address = text(row.id)
  if (row.isVerified === false) {
    return isSolanaAddress(address ?? '')
      ? { kind: 'unverified', recognized: true, malformed: false }
      : { kind: 'unverified', recognized: false, malformed: true }
  }
  if (row.isVerified !== true) {
    return { kind: 'unverified', recognized: false, malformed: true }
  }
  if (EXCLUDED_HEATMAP_MINTS.has(address ?? '')) {
    return { kind: 'unverified', recognized: true, malformed: false }
  }
  if (!address || !isSolanaAddress(address)) {
    return { kind: 'verified', token: null, partialByInterval: allPartialByInterval() }
  }

  const symbol = text(row.symbol)
  const name = text(row.name)
  if (!symbol || !name) return { kind: 'verified', token: null, partialByInterval: allPartialByInterval() }

  const partialByInterval = emptyPartialByInterval()
  const markBasePartial = () => markAllPartial(partialByInterval)
  const priceUsd = optionalNonNegativeNumber(row.usdPrice, markBasePartial)
  const marketCapUsd = optionalNonNegativeNumber(row.mcap, markBasePartial)
  const liquidityUsd = optionalNonNegativeNumber(row.liquidity, markBasePartial)
  const metrics = {} as Record<MarketHeatmapInterval, JupiterMetric>
  for (const interval of Object.keys(STATS_KEYS) as MarketHeatmapInterval[]) {
    const metric = normalizeMetric(row[STATS_KEYS[interval]])
    metrics[interval] = metric
    partialByInterval[interval] ||= metric.partial
  }

  return {
    kind: 'verified',
    partialByInterval,
    token: { address, symbol, name, priceUsd, marketCapUsd, liquidityUsd, metrics },
  }
}

function normalizeMetric(value: unknown): JupiterMetric {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { volumeUsd: null, priceChangePct: null, partial: true }
  }
  const row = value as Record<string, unknown>
  let partial = false
  const buy = optionalNonNegativeNumber(row.buyVolume, () => { partial = true })
  const sell = optionalNonNegativeNumber(row.sellVolume, () => { partial = true })
  const priceChangePct = signedNumber(row.priceChange, () => { partial = true })
  const volumeUsd = buy !== null && sell !== null && Number.isFinite(buy + sell)
    ? buy + sell
    : null
  if (volumeUsd === null || priceChangePct === null) partial = true
  return { volumeUsd, priceChangePct, partial }
}

function mergeTokens(left: JupiterSnapshotToken, right: JupiterSnapshotToken): JupiterSnapshotToken {
  const metrics = {} as Record<MarketHeatmapInterval, JupiterMetric>
  for (const interval of Object.keys(STATS_KEYS) as MarketHeatmapInterval[]) {
    metrics[interval] = mergeMetric(left.metrics[interval], right.metrics[interval])
  }
  return {
    address: left.address,
    symbol: left.symbol.localeCompare(right.symbol) <= 0 ? left.symbol : right.symbol,
    name: left.name.localeCompare(right.name) <= 0 ? left.name : right.name,
    priceUsd: left.priceUsd ?? right.priceUsd,
    marketCapUsd: left.marketCapUsd ?? right.marketCapUsd,
    liquidityUsd: left.liquidityUsd ?? right.liquidityUsd,
    metrics,
  }
}

function mergeMetric(left: JupiterMetric, right: JupiterMetric): JupiterMetric {
  if (left.volumeUsd === null) return right
  if (right.volumeUsd === null) return left
  if (right.volumeUsd > left.volumeUsd) return right
  return left
}

function compareMetric(
  left: JupiterSnapshotToken,
  right: JupiterSnapshotToken,
  interval: MarketHeatmapInterval,
): number {
  return (right.metrics[interval].volumeUsd! - left.metrics[interval].volumeUsd!)
    || left.address.localeCompare(right.address)
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 200 ? normalized : null
}

function optionalNonNegativeNumber(value: unknown, onInvalid: () => void): number | null {
  if (value === null || value === undefined) {
    onInvalid()
    return null
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    onInvalid()
    return null
  }
  return value
}

function signedNumber(value: unknown, onInvalid: () => void): number | null {
  if (value === null || value === undefined) {
    onInvalid()
    return null
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    onInvalid()
    return null
  }
  return value
}

function isSolanaAddress(value: string): boolean {
  return value.length >= 32 && value.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)
}

function invalidResponse(): never {
  throw new JupiterProviderError({
    code: 'INVALID_UPSTREAM_RESPONSE',
    retryable: true,
    message: 'Jupiter returned invalid data',
  })
}

function tooLargeResponse(): never {
  throw new JupiterProviderError({
    code: 'UPSTREAM_RESPONSE_TOO_LARGE',
    retryable: true,
    message: 'Jupiter response is too large',
  })
}

function emptyPartialByInterval(): Record<MarketHeatmapInterval, boolean> {
  return { '5m': false, '1h': false, '6h': false, '24h': false }
}

function allPartialByInterval(): Record<MarketHeatmapInterval, boolean> {
  return { '5m': true, '1h': true, '6h': true, '24h': true }
}

function markAllPartial(partialByInterval: Record<MarketHeatmapInterval, boolean>): void {
  for (const interval of Object.keys(STATS_KEYS) as MarketHeatmapInterval[]) {
    partialByInterval[interval] = true
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) invalidResponse()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_PROVIDER_BODY_BYTES) {
        await reader.cancel()
        tooLargeResponse()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new JupiterProviderError({
      code: 'INVALID_UPSTREAM_RESPONSE',
      retryable: true,
      message: 'Jupiter returned invalid data',
    })
  }
}

function httpError(response: Response): JupiterProviderError {
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500
  const code = response.status === 401 || response.status === 403
    ? 'AUTHENTICATION'
    : response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_HTTP_ERROR'
  return new JupiterProviderError({
    code,
    retryable: code === 'AUTHENTICATION' ? false : retryable,
    message: code === 'AUTHENTICATION'
      ? 'Jupiter authentication failed'
      : code === 'RATE_LIMITED' ? 'Jupiter rate limit reached' : 'Jupiter request failed',
    retryAfterMs: retryable ? parseRetryAfter(response.headers.get('retry-after')) : undefined,
  })
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.min(Math.max(0, timestamp - Date.now()), RETRY_AFTER_MAX_MS)
}
