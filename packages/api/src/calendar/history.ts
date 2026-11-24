/**
 * #703 GET /calendar/history: an entity's last (up to 3) saved releases
 * before a date, each with the 24h move of every Hyperliquid market linked to
 * that entity. Reads `atlas.entities` / `atlas.event_releases` /
 * `atlas.entity_markets` through PostgREST (service key, atlas profile), the
 * same shape as stories.ts, and fetches past-window `1h` candles through the
 * shared Hyperliquid price service's `candlesBetween`. GET /calendar,
 * /market/hyperliquid/* and /stories are untouched by everything here.
 *
 * Caches, in memory per API process: a finished move (non-null, window
 * complete) by `symbol|startsAt` with no expiry, capped at 2,000 entries
 * (oldest dropped); whole responses by `slug|before` for 10 minutes. Errors
 * and null moves from failed calls are never cached.
 */
import type { CalendarHistoryMarket, CalendarHistoryMove, CalendarHistoryRelease, CalendarHistoryResponse } from '@myboon/shared/calendar'
import type { MarketCandle } from '@myboon/shared/stories'
import { createSupabaseRest } from '@myboon/shared/supabase-rest'
import type { CandleInterval } from '../hyperliquid.js'
import { hyperliquidDisplaySymbol, hyperliquidDisplayName } from '../hyperliquid-names.js'
import { parseCalendarDate } from './dates.js'
import { RELEASE_ENTITY_SLUGS } from './series.js'

const REQUEST_TIMEOUT_MS = 10_000
/** A move covers the 24h after the release starts. */
const MOVE_WINDOW_MS = 24 * 60 * 60 * 1000
/** One `1h` candle covers its `t` to `t + 1h`. */
const HOUR_MS = 60 * 60 * 1000
/** Candle read starts one base candle earlier (startsAt − 2h) so the base candle is complete. */
const BASE_PAD_MS = 2 * HOUR_MS
const MAX_RELEASES = 3
const MAX_MARKETS = 3
/** Whole responses are cached by `slug|before` for this long. */
const RESPONSE_TTL_MS = 10 * 60 * 1000
/** Finished-move cache cap; the oldest entry is dropped beyond it. */
const MOVE_CACHE_MAX = 2_000

export class CalendarHistoryParamError extends Error {}
export class CalendarHistoryEntityError extends Error {}
/** Any Supabase read failure; the response is still built when only Hyperliquid calls fail. */
export class CalendarHistoryUnavailableError extends Error {}

/** The slice of the shared price service the history reader needs (the real createHyperliquidPrices() satisfies it). */
export interface CalendarHistoryPrices {
  candlesBetween(symbol: string, interval: CandleInterval, startMs: number, endMs: number): Promise<MarketCandle[]>
}

export interface CalendarHistoryOptions {
  supabaseUrl: string
  serviceRoleKey: string
  /** Absent (or failing) prices mean null moves, never a failed response. */
  prices?: CalendarHistoryPrices
  fetch?: typeof globalThis.fetch
  /** Clock for cache TTLs and the finished-window check; defaults to Date.now. Tests inject it. */
  now?: () => number
  /** Whole-response cache TTL; default 10 minutes. */
  ttlMs?: number
}

export interface CalendarHistoryReader {
  /**
   * The last (up to 3) releases of the entity's series strictly before
   * `before`, newest first, with one move per linked market in rank order.
   */
  getHistory(entitySlug: string, before: string): Promise<CalendarHistoryResponse>
}

interface EntityRow {
  id: unknown
  slug: unknown
  name: unknown
}

interface ReleaseRow {
  release_date: unknown
  starts_at: unknown
  source_title: unknown
  period: unknown
  unit: unknown
  actual: unknown
  estimate: unknown
  previous: unknown
}

interface MarketRow {
  rank: unknown
  symbol: unknown
}

interface EntityRead {
  id: string
  slug: string
  name: string
}

interface ReleaseRead {
  date: string
  startsAt: string | null
  title: string
  period: string | null
  unit: string | null
  actual: number | null
  estimate: number | null
  previous: number | null
}

interface MarketLink {
  rank: 1 | 2 | 3
  symbol: string
}

interface HistoryRead {
  entity: EntityRead
  markets: MarketLink[]
  releases: ReleaseRead[]
}

const ALLOWED_SLUGS = new Set<string>(RELEASE_ENTITY_SLUGS)

/** PostgREST returns uuid/date columns as plain strings. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const YYYY_MM_DD_RE = /^\d{4}-\d{2}-\d{2}$/

export function createCalendarHistory(options: CalendarHistoryOptions): CalendarHistoryReader {
  const nowMs = options.now ?? Date.now
  const responseTtlMs = options.ttlMs ?? RESPONSE_TTL_MS
  // Every Supabase read in this file goes through the one shared helper (#832); all of them are atlas-schema reads.
  const rest = createSupabaseRest({
    supabaseUrl: options.supabaseUrl,
    serviceRoleKey: options.serviceRoleKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  // Finished moves: symbol|startsAt (ms) -> changePct. Nulls and errors never enter.
  const moveCache = new Map<string, number>()
  // Whole responses: slug|before -> { at, body }; only failure-free responses are stored.
  const responseCache = new Map<string, { at: number, body: CalendarHistoryResponse }>()

  function readRows<T>(table: string, params: URLSearchParams): Promise<T[]> {
    return rest.readRows<T>(table, params, 'atlas')
  }

  async function getHistory(entitySlug: string, before: string): Promise<CalendarHistoryResponse> {
    validateParams(entitySlug, before)
    const cacheKey = `${entitySlug}|${before}`
    const cached = responseCache.get(cacheKey)
    if (cached && nowMs() - cached.at < responseTtlMs) return cached.body

    let failed = false
    try {
      const read = await readHistory(entitySlug, before)
      const body = await withMoves(read, () => { failed = true })
      if (!failed) {
        const now = nowMs()
        for (const [key, entry] of responseCache) {
          if (now - entry.at >= responseTtlMs) responseCache.delete(key)
        }
        responseCache.set(cacheKey, { at: now, body })
      }
      return body
    } catch (error) {
      if (error instanceof CalendarHistoryEntityError) throw error
      throw new CalendarHistoryUnavailableError(
        error instanceof Error ? error.message : 'unknown error', { cause: error },
      )
    }
  }

  function validateParams(entitySlug: string, before: string): void {
    if (typeof entitySlug !== 'string' || !ALLOWED_SLUGS.has(entitySlug)) {
      throw new CalendarHistoryParamError(`entity must be one of ${RELEASE_ENTITY_SLUGS.join(', ')}`)
    }
    if (typeof before !== 'string') throw new CalendarHistoryParamError('before must be a valid YYYY-MM-DD date')
    try {
      parseCalendarDate(before)
    } catch {
      throw new CalendarHistoryParamError('before must be a valid YYYY-MM-DD date')
    }
  }

  async function readHistory(entitySlug: string, before: string): Promise<HistoryRead> {
    const entityRows = await readRows<EntityRow>('entities', new URLSearchParams({
      select: 'id,slug,name',
      slug: `eq.${entitySlug}`,
      status: 'eq.active',
      limit: '1',
    }))
    const entity = entityRead(entityRows[0])
    if (!entity) throw new CalendarHistoryEntityError(entitySlug)

    const [releaseRows, marketRows] = await Promise.all([
      readRows<ReleaseRow>('event_releases', new URLSearchParams({
        select: 'release_date,starts_at,source_title,period,unit,actual,estimate,previous',
        entity_id: `eq.${entity.id}`,
        release_date: `lt.${before}`,
        order: 'release_date.desc,source_title.desc',
        limit: String(MAX_RELEASES),
      })),
      readRows<MarketRow>('entity_markets', new URLSearchParams({
        select: 'rank,symbol',
        entity_id: `eq.${entity.id}`,
        order: 'rank.asc',
      })),
    ])

    const releases = releaseRows
      .map(releaseRead)
      .filter((release): release is ReleaseRead => release !== null)
      // PostgREST orders, but the projection keeps the contract against a
      // reshuffled or over-long answer: newest first, at most three.
      .sort((left, right) => right.date.localeCompare(left.date) || right.title.localeCompare(left.title))
      .slice(0, MAX_RELEASES)
    const markets = marketLinks(marketRows)
    return { entity, markets, releases }
  }

  function entityRead(row: EntityRow | undefined): EntityRead | null {
    if (!row || typeof row.id !== 'string' || !UUID_RE.test(row.id)) return null
    if (typeof row.name !== 'string' || !row.name.trim()) return null
    return { id: row.id, slug: typeof row.slug === 'string' ? row.slug : '', name: row.name.trim() }
  }

  function releaseRead(row: ReleaseRow): ReleaseRead | null {
    const date = typeof row.release_date === 'string' && YYYY_MM_DD_RE.test(row.release_date) ? row.release_date : null
    const title = typeof row.source_title === 'string' && row.source_title.trim() ? row.source_title.trim() : null
    if (!date || !title) return null
    return {
      date,
      title,
      // No exact time means no move, never a guessed one.
      startsAt: typeof row.starts_at === 'string' && Number.isFinite(Date.parse(row.starts_at)) ? row.starts_at : null,
      period: optionalText(row.period),
      unit: optionalText(row.unit),
      actual: optionalNumber(row.actual),
      estimate: optionalNumber(row.estimate),
      previous: optionalNumber(row.previous),
    }
  }

  /** The entity's 0-3 market links: rank 1..3, unique symbols, lead first. */
  function marketLinks(rows: MarketRow[]): MarketLink[] {
    const links: MarketLink[] = []
    for (const row of rows) {
      const rank = row.rank
      const symbol = row.symbol
      if (rank !== 1 && rank !== 2 && rank !== 3) continue
      if (typeof symbol !== 'string' || !symbol) continue
      if (links.some((link) => link.symbol === symbol)) continue
      links.push({ rank, symbol })
    }
    return links
      .sort((left, right) => left.rank - right.rank || (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0))
      .slice(0, MAX_MARKETS)
  }

  /**
   * Builds the response: markets in rank order with display names, one moves
   * row per market per release (a release with null startsAt or a failed or
   * unfinished window carries null changePct — the app shows a dash). Releases
   * are processed in order and each release's markets move together, so at
   * most MAX_MARKETS Hyperliquid calls are ever in flight per request.
   */
  async function withMoves(
    read: HistoryRead,
    onFailed: () => void,
  ): Promise<CalendarHistoryResponse> {
    const markets: CalendarHistoryMarket[] = read.markets.map((link) => ({
      symbol: link.symbol,
      displaySymbol: hyperliquidDisplaySymbol(link.symbol),
      displayName: hyperliquidDisplayName(link.symbol),
      rank: link.rank,
    }))
    const releases: CalendarHistoryRelease[] = []
    for (const release of read.releases) {
      const moves = await Promise.all(read.markets.map(async (link): Promise<CalendarHistoryMove> => {
        const startsAtMs = release.startsAt === null ? null : Date.parse(release.startsAt)
        const changePct = await moveFor(link.symbol, startsAtMs, onFailed)
        return { symbol: link.symbol, changePct }
      }))
      releases.push({
        date: release.date,
        startsAt: release.startsAt,
        title: release.title,
        period: release.period,
        unit: release.unit,
        actual: release.actual,
        estimate: release.estimate,
        previous: release.previous,
        moves,
      })
    }
    return { entity: { slug: read.entity.slug, name: read.entity.name }, markets, releases }
  }

  /**
   * The 24h move of one market around one release start. Null when the
   * release has no exact time, when the window has not finished, when either
   * anchor candle is missing or the base is not a price, or when the
   * Hyperliquid call fails (reported to `onFailed` so the response stays
   * uncached and retryable).
   */
  async function moveFor(symbol: string, startsAtMs: number | null, onFailed: () => void): Promise<number | null> {
    if (startsAtMs === null) return null
    const endMs = startsAtMs + MOVE_WINDOW_MS
    if (endMs > nowMs()) return null
    const cacheKey = `${symbol}|${startsAtMs}`
    const cached = moveCache.get(cacheKey)
    if (cached !== undefined) return cached
    if (!options.prices) return null
    let candles: MarketCandle[]
    try {
      candles = await options.prices.candlesBetween(symbol, '1h', startsAtMs - BASE_PAD_MS, endMs)
    } catch (error) {
      console.error(
        '[calendar-history] move fetch failed',
        symbol,
        error instanceof Error ? error.message : 'unknown error',
      )
      onFailed()
      return null
    }
    const changePct = moveFromCandles(candles, startsAtMs)
    if (changePct === null) return null
    moveCache.set(cacheKey, changePct)
    while (moveCache.size > MOVE_CACHE_MAX) {
      moveCache.delete(moveCache.keys().next().value!)
    }
    return changePct
  }

  /**
   * A candle `t` covers `t` to `t + 1h`: base is the close of the last candle
   * that finished at-or-before the print (the price just before it), end the
   * close of the last candle that finished at-or-before 24h after it. CPI at
   * 13:30 UTC therefore compares the 13:00 close with the next day's 13:00
   * close. Either anchor missing, or a base of zero or less, means no move.
   */
  function moveFromCandles(candles: MarketCandle[], startsAtMs: number): number | null {
    const base = closeAtOrBefore(candles, startsAtMs)
    const end = closeAtOrBefore(candles, startsAtMs + MOVE_WINDOW_MS)
    if (base === null || end === null || base <= 0) return null
    return round2((end / base - 1) * 100)
  }

  function closeAtOrBefore(candles: MarketCandle[], deadlineMs: number): number | null {
    let best: MarketCandle | null = null
    for (const candle of candles) {
      if (candle.timeMs + HOUR_MS > deadlineMs) continue
      if (!best || candle.timeMs > best.timeMs) best = candle
    }
    return best?.close ?? null
  }

  return { getHistory }
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
