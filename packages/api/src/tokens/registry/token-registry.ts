import type { TokenIdentityV1, TokenResolveResponseV1 } from '@myboon/shared/tokens'
import { fetchJupiterTokenBatch } from '../jupiter-tokens.js'
import { categoryForSymbol, fallbackLetter, parseTokenRef } from '../types.js'
import { resolveRef } from '../identity-service.js'
import { Lru } from './lru.js'
import { UpstreamLimiter, UpstreamStatusError } from './limiter.js'
import { TokenUpstreamCounter } from './counter.js'
import { mergeTokenRow, type TokenRegistryIncoming, type TokenRegistryRow } from './merge.js'
import type { TokenRegistryStore } from './store.js'

export interface RegistryConfig {
  lruMax: number; foundTtlMs: number; missTtlMs: number; staleAfterMs: number
  maxConcurrency: number; rpm: number; cooldownMs: number; maxPerRequest: number; requestBudgetMs: number; queueMax: number
}
export interface TokenRegistryOptions {
  store: TokenRegistryStore
  fetchBatch?: (mints: readonly string[]) => Promise<TokenRegistryIncoming[]>
  seeds?: readonly TokenRegistryIncoming[]
  config: RegistryConfig
  limiter?: UpstreamLimiter
  counter?: TokenUpstreamCounter
  now?: () => number
  fetchImpl?: typeof fetch
}
const DEFAULT_SEEDS: TokenRegistryIncoming[] = []

function identity(mint: string, row: TokenRegistryRow | null): TokenIdentityV1 {
  const symbol = row?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`
  return { key: `mint:${mint}`, assetId: null, symbol, name: row?.name ?? symbol,
    iconUrl: row?.icon_source_url ? `/tokens/icon/mint/${mint}` : null, decimals: row?.decimals ?? null,
    mint, verified: row?.verified ?? false, category: row ? categoryForSymbol(symbol) : 'unknown',
    fallbackLetter: fallbackLetter(symbol), source: row ? 'venue' : 'static' }
}

export function createOptionalTokenRegistry<T>(enabled: boolean, factory: () => T): T | undefined {
  return enabled ? factory() : undefined
}

export class TokenRegistry {
  readonly limiter: UpstreamLimiter
  readonly counter: TokenUpstreamCounter
  private readonly cache: Lru<string, TokenRegistryRow | null>
  private readonly now: () => number
  private readonly seedByMint = new Map<string, TokenRegistryRow>()
  private readonly inFlight = new Map<string, Promise<TokenRegistryRow | null>>()
  private readonly refreshing = new Set<string>()
  private readonly backgroundQueue: string[] = []
  private queueRunning = false
  private readonly fetchBatch: (mints: readonly string[]) => Promise<TokenRegistryIncoming[]>

  constructor(private readonly options: TokenRegistryOptions) {
    this.now = options.now ?? Date.now
    this.cache = new Lru({ maxEntries: options.config.lruMax, ttlMs: (row) => row ? options.config.foundTtlMs : options.config.missTtlMs, now: this.now })
    this.limiter = options.limiter ?? new UpstreamLimiter({ maxConcurrency: options.config.maxConcurrency, requestsPerMinute: options.config.rpm, cooldownMs: options.config.cooldownMs, now: this.now })
    this.counter = options.counter ?? new TokenUpstreamCounter()
    this.fetchBatch = options.fetchBatch ?? ((mints) => this.fetchJupiter(mints))
    for (const seed of options.seeds ?? DEFAULT_SEEDS) this.seedByMint.set(seed.mint, seed)
  }

  /** Resolves mint refs; other refs keep the synchronous legacy identity behavior. */
  async resolve(refs: readonly string[]): Promise<TokenResolveResponseV1> {
    const mints = [...new Set(refs.flatMap((ref) => {
      const parsed = parseTokenRef(ref)
      return parsed.kind === 'mint' ? [parsed.mint] : []
    }))]
    const deadline = this.now() + this.options.config.requestBudgetMs
    const rows = new Map<string, TokenRegistryRow | null>()
    const misses: string[] = []
    for (const mint of mints) {
      const cached = this.cache.get(mint)
      if (cached !== undefined) {
        rows.set(mint, cached)
        if (cached && this.isStale(cached)) this.refreshInBackground(mint)
      } else misses.push(mint)
    }
    let fromStore = new Map<string, TokenRegistryRow>()
    if (misses.length) {
      try { fromStore = await this.options.store.getMany(misses) }
      catch (error) { console.error('[api] Token registry read failed:', error instanceof Error ? error.message : String(error)) }
    }
    const afterStore: string[] = []
    for (const mint of misses) {
      const stored = fromStore.get(mint)
      const row = stored ?? this.seedByMint.get(mint) ?? null
      if (row) {
        rows.set(mint, row); this.cache.set(mint, row)
        if (stored && this.isStale(stored)) this.refreshInBackground(mint)
      } else afterStore.push(mint)
    }

    const allowed = afterStore.slice(0, this.options.config.maxPerRequest)
    const deferred = afterStore.slice(allowed.length)
    const batches: string[][] = []
    for (let i = 0; i < allowed.length; i += 10) batches.push(allowed.slice(i, i + 10))
    const unresolved: string[] = []
    const work = Promise.all(batches.map(async (batch) => {
      try {
        const fetched = await this.loadUpstream(batch)
        for (const mint of batch) rows.set(mint, fetched.get(mint) ?? null)
      } catch (error) {
        for (const mint of batch) {
          const fallback = this.seedByMint.get(mint) ?? null
          rows.set(mint, fallback)
          if (!fallback) this.cache.set(mint, null)
          unresolved.push(`mint:${mint}`)
        }
      }
    }))
    let timeout: NodeJS.Timeout | undefined
    const completed = await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), Math.max(0, deadline - this.now())) }),
    ])
    if (timeout) clearTimeout(timeout)
    if (!completed) {
      for (const mint of allowed) if (!rows.has(mint)) unresolved.push(`mint:${mint}`)
      this.enqueue(allowed.filter((mint) => !rows.has(mint)))
      void work.catch(() => undefined)
    }
    for (const mint of deferred) unresolved.push(`mint:${mint}`)
    if (deferred.length) this.enqueue(deferred)
    const responseRows = new Map(rows)
    const identities = refs.map((ref) => {
      const parsed = parseTokenRef(ref)
      if (parsed.kind !== 'mint') return resolveRef(ref)
      const mint = parsed.mint
      const row = responseRows.has(mint) ? responseRows.get(mint)! : null
      return { ...identity(mint, row), key: ref }
    })
    const unresolvedSet = new Set(unresolved)
    return {
      v: 1, identities, partial: unresolved.length > 0,
      unresolved: refs.filter((ref) => {
        const parsed = parseTokenRef(ref)
        return parsed.kind === 'mint' && unresolvedSet.has(`mint:${parsed.mint}`)
      }),
    }
  }

  getCachedRow(mint: string): TokenRegistryRow | null | undefined { return this.cache.get(mint) }

  async lookupMany(mints: readonly string[]): Promise<Map<string, TokenRegistryRow | null>> {
    const result = await this.resolve(mints.map((mint) => `mint:${mint}`))
    const output = new Map<string, TokenRegistryRow | null>()
    for (const mint of mints) {
      const cached = this.cache.get(mint)
      if (cached !== undefined) output.set(mint, cached)
      else output.set(mint, this.seedByMint.get(mint) ?? null)
    }
    return output
  }

  private async loadUpstream(mints: readonly string[]): Promise<Map<string, TokenRegistryRow | null>> {
    const output = new Map<string, TokenRegistryRow | null>()
    const needing = mints.filter((mint) => !this.inFlight.has(mint))
    if (needing.length) {
      // Per-mint deferreds keep overlapping batches from issuing duplicate fetches.
      const pending = this.fetchWithLimiter(needing)
      for (const mint of needing) this.inFlight.set(mint, pending.then((map) => map.get(mint) ?? null).finally(() => this.inFlight.delete(mint)))
    }
    await Promise.all(mints.map(async (mint) => {
      const row = await this.inFlight.get(mint)
      output.set(mint, row ?? null)
    }))
    return output
  }

  private async fetchWithLimiter(mints: readonly string[]): Promise<Map<string, TokenRegistryRow | null>> {
    let status = 'error'
    try {
      const incoming = await this.limiter.schedule(async () => {
        try {
          const rows = await this.fetchBatch(mints)
          status = '200'
          return rows
        } catch (error) {
          if (error instanceof UpstreamStatusError) status = String(error.status)
          this.counter.increment('jupiter', status)
          throw error
        } finally {
          if (status === '200') this.counter.increment('jupiter', status)
        }
      }, this.options.config.requestBudgetMs)
      let stored = new Map<string, TokenRegistryRow>()
      try { stored = await this.options.store.getMany(mints) }
      catch (error) { console.error('[api] Token registry read failed:', error instanceof Error ? error.message : String(error)) }
      const merged = new Map<string, TokenRegistryRow | null>()
      const writes: TokenRegistryIncoming[] = []
      const incomingByMint = new Map(incoming.map((row) => [row.mint, row]))
      for (const mint of mints) {
        const item = incomingByMint.get(mint)
        const row = item ? mergeTokenRow(stored.get(mint) ?? null, item) : stored.get(mint) ?? this.seedByMint.get(mint) ?? null
        if (item) writes.push(item)
        if (row) this.cache.set(mint, row)
        else this.cache.set(mint, null)
        merged.set(mint, row)
      }
      if (writes.length) {
        try { await this.options.store.upsertMany(writes, stored) }
        catch (error) { console.error('[api] Token registry write failed:', error instanceof Error ? error.message : String(error)) }
      }
      return merged
    } catch (error) {
      if (error instanceof UpstreamStatusError) status = String(error.status)
      throw error
    }
  }

  private isStale(row: TokenRegistryRow): boolean {
    return row.upstream_seen_at !== null && this.now() - Date.parse(row.upstream_seen_at) > this.options.config.staleAfterMs
  }
  private refreshInBackground(mint: string): void {
    if (this.refreshing.has(mint) || this.limiter.isOpen) return
    this.refreshing.add(mint)
    void this.loadUpstream([mint]).catch(() => undefined).finally(() => this.refreshing.delete(mint))
  }
  private enqueue(mints: readonly string[]): void {
    const cap = this.options.config.queueMax
    for (const mint of mints) if (this.backgroundQueue.length < cap && !this.backgroundQueue.includes(mint)) this.backgroundQueue.push(mint)
    if (this.queueRunning || this.backgroundQueue.length === 0) return
    this.queueRunning = true
    queueMicrotask(() => { void this.drainQueue() })
  }
  private async drainQueue(): Promise<void> {
    try {
      while (this.backgroundQueue.length && !this.limiter.isOpen) {
        const batch = this.backgroundQueue.splice(0, 10)
        try { await this.loadUpstream(batch) } catch { /* background failures preserve old values */ }
      }
    } finally { this.queueRunning = false }
  }
  private async fetchJupiter(mints: readonly string[]): Promise<TokenRegistryIncoming[]> {
    const found = await fetchJupiterTokenBatch(mints, this.options.fetchImpl ?? globalThis.fetch)
    const seenAt = new Date(this.now()).toISOString()
    return found.map((token) => ({
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      icon_source_url: token.iconUrl,
      verified: token.verified,
      sources: {
        ...(token.symbol !== null ? { symbol: 'jupiter' } : {}),
        ...(token.name !== null ? { name: 'jupiter' } : {}),
        ...(token.decimals !== null ? { decimals: 'jupiter' } : {}),
        ...(token.iconUrl !== null ? { icon_source_url: 'jupiter' } : {}),
        verified: 'jupiter',
      },
      upstream_seen_at: seenAt,
    }))
  }
}
