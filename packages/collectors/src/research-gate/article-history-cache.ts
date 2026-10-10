export interface ArticleHistoryEntry {
  id: string
  source: 'legacy' | 'managed'
  title: string
  summary: string
  eventAt: string
}

interface CacheEntry {
  expiresAt: number
  pending: Promise<ArticleHistoryEntry[]>
  value?: ArticleHistoryEntry[]
  bytes: number
}

/** Runner-owned recent-history cache. No decisions, identity lookups or writes. */
export class ArticleHistoryCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly loading = new Set<Promise<ArticleHistoryEntry[]>>()
  private bytes = 0
  private generation = 0

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 128,
    private readonly maxBytes = 1_048_576,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > 60_000
      || !Number.isSafeInteger(maxEntries) || maxEntries < 1
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('Recent history cache requires TTL 0–60000 and positive entry/byte bounds')
    }
  }

  /** Loader must reject on incomplete coverage. Rejections are never cached. */
  async read(key: string, load: () => Promise<ArticleHistoryEntry[]>): Promise<ArticleHistoryEntry[]> {
    if (this.ttlMs === 0) return copy(await load())
    this.expire()
    const cached = this.entries.get(key)
    if (cached) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return copy(cached.value ?? await cached.pending)
    }
    if (this.loading.size >= this.maxEntries) {
      const generation = this.generation
      await Promise.race([...this.loading].map(pending => pending.then(() => undefined, () => undefined)))
      this.assertCurrent(generation)
      return this.read(key, load)
    }
    while (this.entries.size >= this.maxEntries) this.remove(this.entries.keys().next().value!)
    const generation = this.generation
    const entry: CacheEntry = { expiresAt: this.now() + this.ttlMs, pending: undefined!, bytes: 0 }
    this.entries.set(key, entry)
    entry.pending = Promise.resolve().then(load).then(value => {
      this.assertCurrent(generation)
      const retained = copy(value)
      const bytes = Buffer.byteLength(JSON.stringify({ key, value: retained }))
      // Slow/oversized results can satisfy this read, but cannot become a hit.
      if (this.entries.get(key) === entry) {
        if (entry.expiresAt <= this.now() || bytes > this.maxBytes) this.remove(key)
        else {
          while (this.bytes + bytes > this.maxBytes) this.remove(this.entries.keys().next().value!)
          if (this.entries.get(key) === entry) {
            entry.value = retained
            entry.bytes = bytes
            this.bytes += bytes
          }
        }
      }
      return retained
    }).catch(error => {
      if (this.entries.get(key) === entry) this.remove(key)
      throw error
    }).finally(() => { this.loading.delete(entry.pending) })
    this.loading.add(entry.pending)
    return copy(await entry.pending)
  }

  /** Invalidates in-flight results too, so an outage cannot warm the cache. */
  clear(): void {
    this.generation += 1
    this.entries.clear()
    this.bytes = 0
  }

  private expire(): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= this.now()) this.remove(key)
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) {
      throw Object.assign(new Error('Recent history cache was invalidated; fresh context is required'),
        { code: 'CONTEXT_CACHE_INVALIDATED' })
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key) }
  }
}

function copy(value: readonly ArticleHistoryEntry[]): ArticleHistoryEntry[] {
  return value.map(entry => ({ ...entry }))
}
