/**
 * #702 saves past US macro releases from Backpack into atlas.event_releases:
 * fetches in <= 14-day windows (Backpack silently truncates long ranges),
 * matches the fixed series list (series.ts) and upserts each release keyed on
 * (entity_id, release_date, source_title). The query function and the calendar
 * fetch are injected so tests need no database or network; the defaults are the
 * production paths. GET /calendar (service.ts) and its ids/caching are
 * untouched by everything here.
 */
import { CalendarUpstreamError, fetchBackpackCalendar, type CalendarBatch } from './backpack.js'
import { RELEASE_ENTITY_SLUGS, matchSeries } from './series.js'
import type { CalendarRange, EconomicEvent } from './types.js'

export type ReleasesMode = 'daily' | 'backfill'

export interface CalendarWindow {
  from: string
  to: string
}

/** pg.Pool.query-compatible: text + values in, rows out. */
export type ReleasesQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>

export interface ReleasesRunOptions {
  mode: ReleasesMode
  /** The daily gate (CALENDAR_RELEASES_ENABLED). --backfill ignores it. */
  enabled?: boolean
  query?: ReleasesQuery
  fetchCalendar?: (range: CalendarRange) => Promise<CalendarBatch>
  now?: () => number
  /** Pause between windows; default 500 ms (Backpack rate safety). */
  delayMs?: number
  log?: (line: Record<string, unknown>) => void
}

export interface ReleasesSummary {
  windows: number
  failedWindows: number
  fetched: number
  matched: number
  inserted: number
  updated: number
  unchanged: number
  skippedFuture: number
}

export interface ReleasesRunResult {
  /** False only when every window failed (the database is unreachable = throws). */
  ok: boolean
  summary: ReleasesSummary | null
}

/** Inclusive days covered per mode, ending today (UTC). */
export const DAILY_DAYS = 14
export const BACKFILL_DAYS = 183
// Backpack truncated a 7-month request to its last ~2 months, so no fetch can
// ever span more than 14 days.
export const MAX_WINDOW_DAYS = 14
export const WINDOW_DELAY_MS = 500

/** Last `days` inclusive days (UTC), split into contiguous windows of at most 14 days. */
export function planReleaseWindows(today: string, days: number): CalendarWindow[] {
  if (days < 1) throw new Error('calendar releases: days must be at least 1')
  const windows: CalendarWindow[] = []
  let from = addUtcDays(today, -(days - 1))
  while (from <= today) {
    const to = minDate(addUtcDays(from, MAX_WINDOW_DAYS - 1), today)
    windows.push({ from, to })
    from = addUtcDays(to, 1)
  }
  return windows
}

function addUtcDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error(`calendar releases: invalid UTC date ${JSON.stringify(isoDate)}`)
  }
  return new Date(Date.UTC(year!, month! - 1, day!) + days * 86_400_000).toISOString().slice(0, 10)
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b
}

// One lookup per run (#701 grants calendar_worker column-level select of id,
// slug, status on atlas.entities).
const ENTITY_SQL = "select id, slug from atlas.entities where slug = any($1) and status = 'active'"

/**
 * Row-counting upsert (#701 key event_releases_entity_date_title_key).
 * `updated_at` moves to now() only when data actually changed (is distinct
 * from); fetched_at is stamped every time. The outcome comes back straight
 * from Postgres: a fresh insert leaves xmax = 0; an on-conflict row is
 * 'updated' when the update set moved updated_at to this statement's now()
 * and 'unchanged' when it kept the old value.
 */
export const RELEASES_UPSERT_SQL = `insert into atlas.event_releases
  (entity_id, source_event_id, source_title, country, period, release_date, starts_at, unit, actual, estimate, previous, fetched_at)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
on conflict on constraint event_releases_entity_date_title_key do update set
  source_event_id = excluded.source_event_id,
  country = excluded.country,
  period = excluded.period,
  starts_at = excluded.starts_at,
  unit = excluded.unit,
  actual = excluded.actual,
  estimate = excluded.estimate,
  previous = excluded.previous,
  fetched_at = now(),
  updated_at = case when
    (atlas.event_releases.starts_at is distinct from excluded.starts_at) or
    (atlas.event_releases.source_event_id is distinct from excluded.source_event_id) or
    (atlas.event_releases.unit is distinct from excluded.unit) or
    (atlas.event_releases.actual is distinct from excluded.actual) or
    (atlas.event_releases.estimate is distinct from excluded.estimate) or
    (atlas.event_releases.previous is distinct from excluded.previous)
  then now() else atlas.event_releases.updated_at end
returning case when xmax = 0 then 'inserted'
  when updated_at = now() then 'updated'
  else 'unchanged' end as outcome`

type UpsertOutcome = 'inserted' | 'updated' | 'unchanged'

async function upsertRelease(
  query: ReleasesQuery,
  entityId: string,
  event: EconomicEvent,
  period: string | null,
): Promise<UpsertOutcome> {
  const result = await query(RELEASES_UPSERT_SQL, [
    entityId,
    event.id,
    event.title,
    event.country,
    period,
    event.date,
    event.timePrecision === 'time' ? event.startsAt : null,
    event.unit,
    event.actual,
    event.estimate,
    event.previous,
  ])
  const outcome = result.rows[0]?.['outcome']
  if (outcome === 'inserted' || outcome === 'updated' || outcome === 'unchanged') return outcome
  throw new Error('calendar releases: upsert returned no outcome')
}

export async function runReleases(options: ReleasesRunOptions): Promise<ReleasesRunResult> {
  const log = options.log ?? ((line: Record<string, unknown>) => { console.log(JSON.stringify(line)) })
  // The daily gate decides before any pool, fetch or database I/O.
  if (options.mode === 'daily' && options.enabled !== true) {
    log({ event: 'calendar_releases', skipped: 'disabled' })
    return { ok: true, summary: null }
  }
  const query = options.query
  if (!query) throw new Error('calendar releases: no query function provided')

  const today = new Date((options.now ?? Date.now)()).toISOString().slice(0, 10)
  const windows = planReleaseWindows(today, options.mode === 'daily' ? DAILY_DAYS : BACKFILL_DAYS)
  const fetchCalendar = options.fetchCalendar ??
    (async (range: CalendarRange) => fetchBackpackCalendar('economic', range))
  const waitMs = options.delayMs ?? WINDOW_DELAY_MS

  const { rows } = await query(ENTITY_SQL, [RELEASE_ENTITY_SLUGS])
  const entityIds = new Map<string, string>()
  for (const row of rows) {
    if (typeof row['id'] === 'string' && typeof row['slug'] === 'string') {
      entityIds.set(row['slug'], row['id'])
    }
  }
  for (const slug of RELEASE_ENTITY_SLUGS) {
    if (!entityIds.has(slug)) log({ event: 'calendar_releases_missing_entity', slug })
  }

  let failedWindows = 0
  let fetched = 0
  let matched = 0
  let inserted = 0
  let updated = 0
  let unchanged = 0
  let skippedFuture = 0

  for (let index = 0; index < windows.length; index++) {
    const window = windows[index]!
    const range: CalendarRange = { from: window.from, to: window.to, timeZone: 'UTC' }
    let batch: CalendarBatch
    try {
      batch = await fetchCalendar(range)
    } catch (error) {
      if (!(error instanceof CalendarUpstreamError)) throw error
      failedWindows++
      log({ event: 'calendar_releases_window_failed', from: window.from, to: window.to, code: error.detail.code })
      await pauseBetween(index, windows.length, waitMs)
      continue
    }
    fetched += batch.events.length
    for (const event of batch.events) {
      if (event.type !== 'economic' || event.country !== 'US') continue
      const match = matchSeries(event.title, event.country)
      // Non-series titles stay ignored; missing entities were logged above.
      if (!match || !entityIds.has(match.entitySlug)) continue
      const entityId = entityIds.get(match.entitySlug)!
      matched++
      // Upcoming releases are never saved; the daily re-run keeps filling and
      // revising what is already past.
      if (event.date > today) {
        skippedFuture++
        continue
      }
      const outcome = await upsertRelease(query, entityId, event, match.period)
      if (outcome === 'inserted') inserted++
      else if (outcome === 'updated') updated++
      else unchanged++
    }
    await pauseBetween(index, windows.length, waitMs)
  }

  const summary: ReleasesSummary = {
    windows: windows.length, failedWindows, fetched,
    matched, inserted, updated, unchanged, skippedFuture,
  }
  log({
    event: 'calendar_releases',
    mode: options.mode,
    windows: summary.windows,
    failedWindows: summary.failedWindows,
    fetched: summary.fetched,
    matched: summary.matched,
    inserted: summary.inserted,
    updated: summary.updated,
    unchanged: summary.unchanged,
    skippedFuture: summary.skippedFuture,
  })
  return { ok: failedWindows < windows.length, summary }
}

async function pauseBetween(index: number, total: number, waitMs: number): Promise<void> {
  if (waitMs > 0 && index < total - 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, waitMs) })
  }
}
