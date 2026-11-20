import assert from 'node:assert/strict'
import test from 'node:test'
import type { CalendarRange, EconomicEvent } from './types.js'
import { CalendarUpstreamError, type CalendarBatch } from './backpack.js'
import {
  BACKFILL_DAYS, DAILY_DAYS, RELEASES_UPSERT_SQL,
  planReleaseWindows, runReleases,
  type ReleasesQuery, type ReleasesRunOptions,
} from './releases.js'

const TODAY = '2026-11-20'
const NOW_TS = Date.parse(`${TODAY}T00:00:00.000Z`)

const ENTITY_IDS: Record<string, string> = {
  'us-cpi': '0f10c100-0000-7000-8000-000000000001',
  'us-ppi': '0f10c100-0000-7000-8000-000000000002',
  'us-jobs-report-nfp': '0f10c100-0000-7000-8000-000000000003',
  'fomc-rate-decision': '0f10c100-0000-7000-8000-000000000004',
  'us-gdp': '0f10c100-0000-7000-8000-000000000005',
  'us-retail-sales': '0f10c100-0000-7000-8000-000000000006',
}
const DEFAULT_ENTITIES = Object.entries(ENTITY_IDS).map(([slug, id]) => ({ id, slug }))

let eventSeq = 0
function economicEvent(over: Partial<EconomicEvent> = {}): EconomicEvent {
  eventSeq += 1
  const hex = eventSeq.toString(16).padStart(24, '0')
  return {
    id: `backpack:economic:${hex}`,
    type: 'economic',
    title: 'Inflation Rate YoY (Oct)',
    date: '2026-10-13',
    startsAt: '2026-10-13T13:30:00.000Z',
    timePrecision: 'time',
    source: 'backpack',
    sourceUrl: 'https://backpack.exchange/stocks/calendar',
    country: 'US',
    currency: null,
    impact: null,
    unit: '%',
    previous: 3.0,
    estimate: 3.1,
    actual: 3.2,
    change: null,
    changePercentage: null,
    ...over,
  }
}

interface FakeDb {
  query: ReleasesQuery
  entityLookups: unknown[][]
  upserts: { text: string; values: unknown[] }[]
}

/**
 * Fake `query` seam: answers the entity lookup from `entities` and mirrors the
 * upsert SQL's conflict classification (fresh -> inserted; a change of
 * starts_at / source_event_id / unit / actual / estimate / previous ->
 * updated; otherwise unchanged). The SQL text is asserted separately, so the
 * mirror cannot drift from the real statement unnoticed.
 */
function createFakeDb(entities = DEFAULT_ENTITIES): FakeDb {
  const stored = new Map<string, Record<string, unknown>>()
  const entityLookups: unknown[][] = []
  const upserts: { text: string; values: unknown[] }[] = []
  const query: ReleasesQuery = async (text, values) => {
    if (text.includes('atlas.entities')) {
      entityLookups.push([...values])
      return { rows: entities.map((entity) => ({ ...entity })) }
    }
    upserts.push({ text, values: [...values] })
    const key = `${String(values[0])}|${String(values[5])}|${String(values[2])}`
    const before: Record<string, unknown> | null = stored.get(key) ?? null
    const next: Record<string, unknown> = {
      starts_at: values[6],
      source_event_id: values[1],
      unit: values[7],
      actual: values[8],
      estimate: values[9],
      previous: values[10],
    }
    const changed = ['starts_at', 'source_event_id', 'unit', 'actual', 'estimate', 'previous']
      .some((field) => (next[field] ?? null) !== (before?.[field] ?? null))
    const outcome = before === null ? 'inserted' : changed ? 'updated' : 'unchanged'
    stored.set(key, before !== null && !changed ? before : next)
    return { rows: [{ outcome }] }
  }
  return { query, entityLookups, upserts }
}

function captureLogs(): {
  log: (line: Record<string, unknown>) => void
  lines: Record<string, unknown>[]
} {
  const lines: Record<string, unknown>[] = []
  return { log: (line) => { lines.push(line) }, lines }
}

async function run(
  db: FakeDb,
  fetchCalendar: ReleasesRunOptions['fetchCalendar'],
  mode: 'daily' | 'backfill' = 'daily',
  extra: Partial<ReleasesRunOptions> = {},
): Promise<{ result: Awaited<ReturnType<typeof runReleases>>; lines: Record<string, unknown>[] }> {
  const { log, lines } = captureLogs()
  const result = await runReleases({
    mode,
    enabled: true,
    query: db.query,
    fetchCalendar,
    now: () => NOW_TS,
    delayMs: 0,
    log,
    ...extra,
  })
  return { result, lines }
}

function fetchEvents(events: EconomicEvent[], ranges?: CalendarRange[]) {
  return async (range: CalendarRange): Promise<CalendarBatch> => {
    ranges?.push(range)
    return { events, invalidEvents: 0 }
  }
}

function tallies(lines: Record<string, unknown>[]): { inserted: number; updated: number; unchanged: number } {
  const line = lines.at(-1)!
  return {
    inserted: line['inserted'] as number,
    updated: line['updated'] as number,
    unchanged: line['unchanged'] as number,
  }
}

test('plans the backfill as contiguous windows of at most 14 days, ending today', () => {
  const windows = planReleaseWindows(TODAY, 183)
  let covered = 0
  for (const [index, window] of windows.entries()) {
    const spanDays = Math.round((Date.parse(`${window.to}T00:00:00Z`)
      - Date.parse(`${window.from}T00:00:00Z`)) / 86_400_000) + 1
    assert.ok(spanDays >= 1 && spanDays <= 14, `window ${index} spans ${spanDays} days`)
    if (index > 0) {
      // No gaps or overlaps: each window starts the day after the previous one.
      const dayAfter = new Date(Date.parse(`${windows[index - 1]!.to}T00:00:00Z`) + 86_400_000)
        .toISOString().slice(0, 10)
      assert.equal(window.from, dayAfter)
    }
    covered += spanDays
  }
  assert.equal(windows.length, Math.ceil(183 / DAILY_DAYS))
  assert.equal(windows.at(-1)!.to, TODAY)
  assert.equal(windows[0]!.from, '2026-05-22')
  assert.equal(covered, 183)
  assert.equal(planReleaseWindows(TODAY, DAILY_DAYS - 1).length, 1)
})

test('plans the daily run as exactly one window of the 14 days ending today', () => {
  assert.deepEqual(planReleaseWindows(TODAY, DAILY_DAYS), [{ from: '2026-11-07', to: '2026-11-20' }])
  assert.equal(DAILY_DAYS, 14)
  assert.equal(BACKFILL_DAYS, 183)
})

test('the daily run fetches one window and saves the matched release with its period', async () => {
  const db = createFakeDb()
  const ranges: CalendarRange[] = []
  const { result, lines } = await run(db, fetchEvents([economicEvent()], ranges))
  assert.ok(result.ok)
  assert.deepEqual(ranges, [{ from: '2026-11-07', to: '2026-11-20', timeZone: 'UTC' }])
  assert.equal(db.upserts.length, 1)
  // entity_id, source_event_id, source_title, country, period,
  // release_date, starts_at, unit, actual, estimate, previous
  const eventId = String(db.upserts[0]!.values[1])
  assert.match(eventId, /^backpack:economic:[0-9a-f]{24}$/)
  assert.deepEqual(db.upserts[0]!.values, [
    ENTITY_IDS['us-cpi'], eventId, 'Inflation Rate YoY (Oct)', 'US', 'Oct',
    '2026-10-13', '2026-10-13T13:30:00.000Z', '%', 3.2, 3.1, 3.0,
  ])
  assert.deepEqual(lines.at(-1), {
    event: 'calendar_releases',
    mode: 'daily',
    windows: 1, failedWindows: 0, fetched: 1,
    matched: 1, inserted: 1, updated: 0, unchanged: 0, skippedFuture: 0,
  })
})

test('first run inserts; the same payload again is unchanged; a filled actual updates', async () => {
  const db = createFakeDb()
  const events = [economicEvent({
    title: 'Retail Sales MoM (Sep)', date: '2026-10-16', startsAt: '2026-10-16T13:30:00.000Z',
    actual: null,
  })]
  const first = await run(db, fetchEvents(events))
  assert.deepEqual(tallies(first.lines), { inserted: 1, updated: 0, unchanged: 0 })

  const second = await run(db, fetchEvents(events))
  assert.deepEqual(tallies(second.lines), { inserted: 0, updated: 0, unchanged: 1 })
  assert.equal(db.upserts.length, 2)
  assert.deepEqual(db.upserts[1]!.values, db.upserts[0]!.values, 'same payload, identical parameters')

  const revised = [{ ...events[0]!, actual: 0.4 }]
  const third = await run(db, fetchEvents(revised))
  assert.deepEqual(tallies(third.lines), { inserted: 0, updated: 1, unchanged: 0 })
  assert.notEqual(db.upserts[2]!.values[8], db.upserts[1]!.values[8], 'only actual differs')
})

test('the upsert SQL is keyed on the #701 constraint and only bumps updated_at on real changes', () => {
  assert.match(RELEASES_UPSERT_SQL, /on conflict on constraint event_releases_entity_date_title_key/)
  for (const column of ['starts_at', 'source_event_id', 'unit', 'actual', 'estimate', 'previous']) {
    assert.match(RELEASES_UPSERT_SQL, new RegExp(`${column} is distinct from excluded\\.${column}`))
  }
  assert.match(RELEASES_UPSERT_SQL, /then now\(\) else atlas\.event_releases\.updated_at end/)
  assert.match(RELEASES_UPSERT_SQL, /fetched_at = now\(\)/)
  for (const column of ['entity_id', 'release_date', 'source_title']) {
    assert.doesNotMatch(RELEASES_UPSERT_SQL, new RegExp(`^\\s*${column} = excluded`, 'm'),
      'key columns stay as inserted')
  }
})

test('a date-precision release saves a null starts_at', async () => {
  const db = createFakeDb()
  await run(db, fetchEvents([economicEvent({ date: '2026-11-04', startsAt: null, timePrecision: 'date' })]))
  assert.equal(db.upserts.length, 1)
  assert.equal(db.upserts[0]!.values[6], null)
})

test('two matched PPI titles on the same date save two rows (per title, not per day)', async () => {
  const db = createFakeDb()
  const events = [
    economicEvent({
      id: `backpack:economic:${'a'.repeat(24)}`,
      title: 'Producer Price Index MoM (Oct)', date: '2026-10-15', startsAt: '2026-10-15T13:30:00.000Z',
    }),
    economicEvent({
      id: `backpack:economic:${'b'.repeat(24)}`,
      title: 'Producer Price Index MoM (Nov)', date: '2026-10-15', startsAt: '2026-10-15T14:30:00.000Z',
    }),
  ]
  const { result, lines } = await run(db, fetchEvents(events))
  assert.ok(result.ok)
  assert.equal(db.upserts.length, 2)
  assert.equal(db.upserts[0]!.values[2], 'Producer Price Index MoM (Oct)')
  assert.equal(db.upserts[0]!.values[4], 'Oct')
  assert.equal(db.upserts[1]!.values[2], 'Producer Price Index MoM (Nov)')
  assert.equal(db.upserts[1]!.values[4], 'Nov')
  assert.deepEqual(tallies(lines), { inserted: 2, updated: 0, unchanged: 0 })
})

test('a future-dated matched release is counted in skippedFuture and never written', async () => {
  const db = createFakeDb()
  const events = [
    economicEvent({ title: 'Inflation Rate YoY (Nov)', date: '2026-12-09', startsAt: '2026-12-09T13:30:00.000Z' }),
    economicEvent({ title: 'GDP Growth Rate QoQ (Q3)', date: '2026-10-29', startsAt: '2026-10-29T13:30:00.000Z' }),
  ]
  const { result, lines } = await run(db, fetchEvents(events))
  assert.ok(result.ok)
  assert.equal(db.upserts.length, 1)
  assert.equal(db.upserts[0]!.values[2], 'GDP Growth Rate QoQ (Q3)')
  const line = lines.at(-1)!
  assert.equal(line['matched'], 2)
  assert.equal(line['skippedFuture'], 1)
  assert.equal(line['inserted'], 1)
})

test('a missing or retired entity slug skips its series and logs it, the others are written', async () => {
  const missing = 'us-ppi'
  const db = createFakeDb(DEFAULT_ENTITIES.filter((entity) => entity.slug !== missing))
  const events = [
    economicEvent({ title: 'Producer Price Index MoM (Oct)', date: '2026-10-15', startsAt: null, timePrecision: 'date' }),
    economicEvent({ title: 'Retail Sales MoM (Sep)', date: '2026-10-16', startsAt: '2026-10-16T13:30:00.000Z' }),
  ]
  const { result, lines } = await run(db, fetchEvents(events))
  assert.ok(result.ok)
  assert.equal(db.upserts.length, 1)
  assert.equal(db.upserts[0]!.values[2], 'Retail Sales MoM (Sep)')
  assert.ok(lines.some((line) => line['event'] === 'calendar_releases_missing_entity' && line['slug'] === missing))
  assert.deepEqual(tallies(lines), { inserted: 1, updated: 0, unchanged: 0 })
})

test('the entity lookup is exactly one query for all six active slugs', async () => {
  const db = createFakeDb()
  await run(db, fetchEvents([]))
  assert.equal(db.entityLookups.length, 1)
  assert.deepEqual(db.entityLookups[0]![0], [...Object.keys(ENTITY_IDS)])
})

test('one failed window skips only that window and the run exits 0', async () => {
  const db = createFakeDb()
  const ranges: CalendarRange[] = []
  let callNo = 0
  const fetchCalendar = async (range: CalendarRange): Promise<CalendarBatch> => {
    const call = callNo++
    ranges.push(range)
    if (call === 0) throw new CalendarUpstreamError({ code: 'UPSTREAM_HTTP_ERROR', retryable: true })
    // One matched release inside every surviving window (its last UTC day).
    return {
      events: [economicEvent({ title: 'Retail Sales MoM (Sep)', date: range.to, startsAt: `${range.to}T13:30:00.000Z` })],
      invalidEvents: 0,
    }
  }
  const { result, lines } = await run(db, fetchCalendar, 'backfill')
  assert.ok(result.ok, 'one failed window must not fail the run')
  assert.equal(ranges.length, Math.ceil(183 / DAILY_DAYS))
  assert.deepEqual(lines[0], {
    event: 'calendar_releases_window_failed',
    from: ranges[0]!.from,
    to: ranges[0]!.to,
    code: 'UPSTREAM_HTTP_ERROR',
  })
  assert.equal(db.upserts.length, ranges.length - 1, 'every surviving window still saves')
  const line = lines.at(-1)!
  assert.equal(line['windows'], ranges.length)
  assert.equal(line['failedWindows'], 1)
})

test('every window failed -> the run reports not ok (non-zero exit)', async () => {
  const db = createFakeDb()
  const fetchCalendar = async (): Promise<CalendarBatch> => {
    throw new CalendarUpstreamError({ code: 'UPSTREAM_TIMEOUT', retryable: true })
  }
  const { result, lines } = await run(db, fetchCalendar)
  assert.equal(result.ok, false)
  assert.equal(db.upserts.length, 0)
  const line = lines.at(-1)!
  assert.equal(line['windows'], 1)
  assert.equal(line['failedWindows'], 1)
  assert.equal(line['fetched'], 0)
})

test('the daily run with the gate off logs skipped: disabled and does no fetch or query', async () => {
  const db = createFakeDb()
  let fetchCalls = 0
  const { log, lines } = captureLogs()
  const probe = async (): Promise<CalendarBatch> => {
    fetchCalls++
    throw new Error('must not fetch when disabled')
  }
  const result = await runReleases({
    mode: 'daily', enabled: false, query: db.query, fetchCalendar: probe,
    now: () => NOW_TS, delayMs: 0, log,
  })
  assert.ok(result.ok)
  assert.equal(result.summary, null)
  assert.deepEqual(lines, [{ event: 'calendar_releases', skipped: 'disabled' }])
  assert.equal(db.entityLookups.length, 0, 'no query ran')
  assert.equal(db.upserts.length, 0)
  assert.equal(fetchCalls, 0)
})
