export interface LruOptions<K, V> {
  maxEntries: number
  ttlMs: number | ((value: V) => number)
  maxBytes?: number
  sizeOf?: (value: V, key: K) => number
  now?: () => number
}

/** Small bounded LRU with expiry checked on access and before eviction. */
export class Lru<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number; bytes: number }>()
  private bytes = 0
  private readonly now: () => number

  constructor(private readonly options: LruOptions<K, V>) {
    if (!Number.isFinite(options.maxEntries) || options.maxEntries < 1) throw new Error('maxEntries must be positive')
    this.now = options.now ?? Date.now
  }

  get size(): number { this.pruneExpired(); return this.entries.size }
  get byteSize(): number { this.pruneExpired(); return this.bytes }

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) { this.delete(key); return undefined }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: K, value: V, ttlMs?: number): void {
    this.delete(key)
    const ttl = ttlMs ?? (typeof this.options.ttlMs === 'function' ? this.options.ttlMs(value) : this.options.ttlMs)
    if (ttl <= 0) return
    const bytes = Math.max(0, this.options.sizeOf?.(value, key) ?? 0)
    if (this.options.maxBytes !== undefined && bytes > this.options.maxBytes) return
    this.entries.set(key, { value, expiresAt: this.now() + ttl, bytes })
    this.bytes += bytes
    this.evict()
  }

  delete(key: K): boolean {
    const old = this.entries.get(key)
    if (!old) return false
    this.entries.delete(key)
    this.bytes -= old.bytes
    return true
  }

  clear(): void { this.entries.clear(); this.bytes = 0 }

  private pruneExpired(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.delete(key)
  }

  private evict(): void {
    this.pruneExpired()
    while (this.entries.size > this.options.maxEntries || (this.options.maxBytes !== undefined && this.bytes > this.options.maxBytes)) {
      const oldest = this.entries.keys().next().value as K | undefined
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }
}
