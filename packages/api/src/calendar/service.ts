import { CalendarUpstreamError, fetchBackpackCalendar, type CalendarBatch } from './backpack.js'
import { parseCalendarRange } from './dates.js'
import type { CalendarCategory, CalendarRange, CalendarResult, CalendarSource, CalendarSourceError } from './types.js'

const CATEGORIES: CalendarCategory[] = ['earnings', 'economic']
interface Snapshot extends CalendarBatch { fetchedAt: number }
interface CacheEntry {
  snapshots: Partial<Record<CalendarCategory, Snapshot>>
  failures: Partial<Record<CalendarCategory, CalendarSourceError>>
  nextRefreshAt: number
}

export interface CalendarServiceOptions {
  enabled?: boolean
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
  cacheTtlMs?: number
  retryAfterMs?: number
  maxStaleMs?: number
  maxEntries?: number
  maxInFlight?: number
}

export class CalendarService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<CacheEntry>>()
  private readonly now: () => number

  constructor(private readonly options: CalendarServiceOptions = {}) {
    this.now = options.now ?? Date.now
  }

  async getCalendar(from: unknown, to: unknown): Promise<CalendarResult> {
    const range = parseCalendarRange(from, to)
    if (this.options.enabled === false) return this.unavailable(range, 'DISABLED')
    const key = `${range.from}:${range.to}`
    const cached = this.cache.get(key)
    if (cached && this.now() < cached.nextRefreshAt) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return this.result(range, cached)
    }
    let refresh = this.inFlight.get(key)
    if (!refresh) {
      if (this.inFlight.size >= (this.options.maxInFlight ?? 8)) {
        if (!cached) return this.unavailable(range, 'BUSY')
        return this.result(range, {
          ...cached,
          failures: Object.fromEntries(CATEGORIES.map((type) => [type, { code: 'BUSY', retryable: true }])),
          nextRefreshAt: this.now() + (this.options.retryAfterMs ?? 30_000),
        })
      }
      refresh = this.refresh(range, cached).then((entry) => {
        this.cache.delete(key)
        this.cache.set(key, entry)
        while (this.cache.size > Math.max(1, this.options.maxEntries ?? 32)) {
          this.cache.delete(this.cache.keys().next().value!)
        }
        return entry
      }).finally(() => { this.inFlight.delete(key) })
      this.inFlight.set(key, refresh)
    }
    return this.result(range, await refresh)
  }

  private async refresh(range: CalendarRange, cached?: CacheEntry): Promise<CacheEntry> {
    const ttl = this.options.cacheTtlMs ?? 300_000
    const settled = await Promise.allSettled(CATEGORIES.map(async (type): Promise<Snapshot> => {
      const snapshot = cached?.snapshots[type]
      if (snapshot && !cached?.failures[type] && !snapshot.invalidEvents && this.now() - snapshot.fetchedAt < ttl) {
        return snapshot
      }
      return { ...await fetchBackpackCalendar(type, range, this.options), fetchedAt: this.now() }
    }))
    const entry: CacheEntry = { snapshots: { ...cached?.snapshots }, failures: {}, nextRefreshAt: 0 }
    settled.forEach((result, index) => {
      const type = CATEGORIES[index]!
      if (result.status === 'fulfilled') entry.snapshots[type] = result.value
      else entry.failures[type] = result.reason instanceof CalendarUpstreamError
        ? result.reason.detail : { code: 'UPSTREAM_UNAVAILABLE', retryable: true }
    })
    const degraded = CATEGORIES.some((type) => entry.failures[type] || entry.snapshots[type]?.invalidEvents)
    const nextHealthyRefreshes = CATEGORIES.flatMap((type) => {
      const snapshot = entry.snapshots[type]
      return snapshot && !entry.failures[type] && !snapshot.invalidEvents ? [snapshot.fetchedAt + ttl] : []
    })
    entry.nextRefreshAt = Math.min(
      this.now() + (degraded ? (this.options.retryAfterMs ?? 30_000) : ttl),
      ...nextHealthyRefreshes,
    )
    return entry
  }

  private result(range: CalendarRange, entry: CacheEntry): CalendarResult {
    const now = this.now()
    const maxStaleMs = this.options.maxStaleMs ?? 86_400_000
    const sources: CalendarSource[] = CATEGORIES.map((type) => {
      const stored = entry.snapshots[type]
      const error = entry.failures[type] ?? null
      const snapshot = stored && (!error || now - stored.fetchedAt <= maxStaleMs) ? stored : undefined
      return {
        type, provider: 'backpack',
        status: !snapshot ? 'unavailable' : error ? 'stale' : snapshot.invalidEvents > 0 ? 'partial' : 'ready',
        fetchedAt: snapshot ? new Date(snapshot.fetchedAt).toISOString() : null,
        eventCount: snapshot?.events.length ?? 0,
        invalidEvents: snapshot?.invalidEvents ?? 0,
        error,
      }
    })
    const events = sources.flatMap((source) => source.status === 'unavailable' ? [] : entry.snapshots[source.type]!.events)
      .sort((a, b) => a.date.localeCompare(b.date)
        || (a.startsAt === null ? (b.startsAt === null ? 0 : 1) : b.startsAt === null ? -1 : a.startsAt.localeCompare(b.startsAt))
        || a.id.localeCompare(b.id))
    const partial = sources.some((source) => source.status === 'partial' || source.status === 'unavailable' || source.invalidEvents > 0)
    const stale = sources.some((source) => source.status === 'stale')
    return {
      range, events, sources, partial, stale,
      status: sources.every((source) => source.status === 'unavailable') ? 'unavailable' : partial ? 'partial' : stale ? 'stale' : 'ready',
      generatedAt: new Date(now).toISOString(),
      nextRefreshAt: new Date(entry.nextRefreshAt).toISOString(),
    }
  }

  private unavailable(range: CalendarRange, code: 'DISABLED' | 'BUSY'): CalendarResult {
    return {
      range, events: [], status: 'unavailable', partial: true, stale: false,
      generatedAt: new Date(this.now()).toISOString(), nextRefreshAt: null,
      sources: CATEGORIES.map((type) => ({
        type, provider: 'backpack', status: 'unavailable', fetchedAt: null, eventCount: 0, invalidEvents: 0,
        error: { code, retryable: code === 'BUSY' },
      })),
    }
  }
}
