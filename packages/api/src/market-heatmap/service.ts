import {
  fetchJupiterVerifiedSnapshot,
  JupiterProviderError,
  type JupiterFetchOptions,
  type JupiterSnapshotToken,
  type ProviderErrorDetail,
} from './jupiter.js'
import type {
  MarketHeatmapError,
  MarketHeatmapInterval,
  MarketHeatmapResponse,
  MarketHeatmapToken,
} from './types.js'

const DEFAULT_TTL_MS = 5 * 60_000
const DEFAULT_MAX_STALE_MS = 30 * 60_000
const DEFAULT_COOLDOWN_MS = 60_000

interface CacheSnapshot {
  tokens: JupiterSnapshotToken[]
  fetchedAt: number
  partial: boolean
  partialByInterval: Record<MarketHeatmapInterval, boolean>
}

interface CacheEntry {
  snapshot?: CacheSnapshot
  failure?: ProviderErrorDetail
  retryAt: number | null
}

export interface MarketHeatmapServiceOptions extends JupiterFetchOptions {
  now?: () => number
  ttlMs?: number
  maxStaleMs?: number
  cooldownMs?: number
}

export class MarketHeatmapService {
  private cache: CacheEntry | undefined
  private inFlight: Promise<CacheEntry> | undefined
  private readonly now: () => number

  constructor(private readonly options: MarketHeatmapServiceOptions = {}) {
    this.now = options.now ?? Date.now
  }

  async getHeatmap(interval: MarketHeatmapInterval): Promise<MarketHeatmapResponse> {
    const now = this.now()
    const cached = this.cache
    if (cached) {
      if (this.isFresh(cached, now)) return this.response(interval, cached, now)
      if (cached.failure && (!cached.failure.retryable || this.inCooldown(cached, now))) {
        return this.response(interval, cached, now)
      }
    }

    if (!this.inFlight) {
      this.inFlight = this.refresh(cached).finally(() => { this.inFlight = undefined })
    }
    const entry = await this.inFlight
    return this.response(interval, entry, this.now())
  }

  private async refresh(cached: CacheEntry | undefined): Promise<CacheEntry> {
    let entry: CacheEntry
    try {
      const result = await fetchJupiterVerifiedSnapshot(this.options)
      entry = {
        snapshot: {
          tokens: result.tokens,
          fetchedAt: this.now(),
          partial: result.partial,
          partialByInterval: result.partialByInterval,
        },
        retryAt: null,
      }
    } catch (error) {
      const failure = error instanceof JupiterProviderError
        ? error.detail
        : {
            code: 'UPSTREAM_UNAVAILABLE',
            retryable: true,
            message: 'Jupiter is unavailable',
          }
      const cooldown = failure.retryable
        ? Math.max(this.options.cooldownMs ?? DEFAULT_COOLDOWN_MS, failure.retryAfterMs ?? 0)
        : 0
      entry = {
        snapshot: cached?.snapshot,
        failure,
        retryAt: failure.retryable ? this.now() + cooldown : null,
      }
    }
    this.cache = entry
    return entry
  }

  private isFresh(entry: CacheEntry, now: number): boolean {
    return Boolean(entry.snapshot)
      && !entry.failure
      && now - entry.snapshot!.fetchedAt < (this.options.ttlMs ?? DEFAULT_TTL_MS)
  }

  private inCooldown(entry: CacheEntry, now: number): boolean {
    return entry.retryAt !== null && now < entry.retryAt
  }

  private response(
    interval: MarketHeatmapInterval,
    entry: CacheEntry,
    now: number,
  ): MarketHeatmapResponse {
    const snapshot = entry.snapshot
    const staleAge = snapshot ? now - snapshot.fetchedAt : Number.POSITIVE_INFINITY
    const hasUsableSnapshot = Boolean(snapshot)
      && staleAge <= (this.options.maxStaleMs ?? DEFAULT_MAX_STALE_MS)
    const error = entry.failure ? publicError(entry.failure) : undefined

    if (!hasUsableSnapshot) {
      return {
        chain: 'solana',
        interval,
        limit: 20,
        source: 'jupiter',
        status: 'unavailable',
        tokens: [],
        fetchedAt: null,
        nextRefreshAt: entry.retryAt === null ? null : new Date(entry.retryAt).toISOString(),
        stale: false,
        partial: true,
        ...(error ? { error } : {}),
      }
    }

    const tokens = selectIntervalTokens(snapshot!.tokens, interval)
    const stale = Boolean(entry.failure) || staleAge >= (this.options.ttlMs ?? DEFAULT_TTL_MS)
    const intervalPartial = snapshot!.partialByInterval[interval]
    const status = stale ? 'stale' : intervalPartial ? 'partial' : 'ready'
    const nextRefreshAt = entry.failure
      ? entry.retryAt === null ? null : new Date(entry.retryAt).toISOString()
      : new Date(snapshot!.fetchedAt + (this.options.ttlMs ?? DEFAULT_TTL_MS)).toISOString()
    return {
      chain: 'solana',
      interval,
      limit: 20,
      source: 'jupiter',
      status,
      tokens,
      fetchedAt: new Date(snapshot!.fetchedAt).toISOString(),
      nextRefreshAt,
      stale,
      partial: stale || intervalPartial,
      ...(error ? { error } : {}),
    }
  }

}

function selectIntervalTokens(
  tokens: readonly JupiterSnapshotToken[],
  interval: MarketHeatmapInterval,
): MarketHeatmapToken[] {
  return tokens
    .map((token) => ({ token, metric: token.metrics[interval] }))
    .filter(({ metric }) => metric.volumeUsd !== null && metric.volumeUsd > 0)
    .sort((left, right) => (right.metric.volumeUsd! - left.metric.volumeUsd!)
      || left.token.address.localeCompare(right.token.address))
    .slice(0, 20)
    .map(({ token, metric }) => ({
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      priceUsd: token.priceUsd,
      volumeUsd: metric.volumeUsd!,
      priceChangePct: metric.priceChangePct,
      marketCapUsd: token.marketCapUsd,
      liquidityUsd: token.liquidityUsd,
    }))
}

function publicError(detail: ProviderErrorDetail): MarketHeatmapError {
  return { code: detail.code, retryable: detail.retryable, message: detail.message }
}
