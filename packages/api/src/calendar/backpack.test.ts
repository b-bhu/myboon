import assert from 'node:assert/strict'
import test from 'node:test'
import { CalendarUpstreamError, fetchBackpackCalendar, normalizeBackpackCalendar } from './backpack.js'
import { parseCalendarRange, parseEconomicTime } from './dates.js'

const range = parseCalendarRange('2026-10-05', '2026-10-11')

test('normalizes real earnings fields, preserves zero and unknown times, and deduplicates by identity', () => {
  const row = { date: '2026-10-09', symbol: 'DAL', epsEstimated: 1.85, epsActual: 0, lastUpdated: '2026-10-06' }
  const result = normalizeBackpackCalendar('earnings', [row, row, { ...row, date: '2026-10-12' }], range)
  assert.equal(result.invalidEvents, 0)
  assert.equal(result.events.length, 1)
  const event = result.events[0]!
  assert.equal(event.type, 'earnings')
  if (event.type !== 'earnings') throw new Error('Wrong event type')
  assert.equal(event.symbol, 'DAL')
  assert.equal(event.epsActual, 0)
  assert.equal(event.revenueActual, null)
  assert.equal(event.providerUpdatedAt, '2026-10-06')
  assert.equal(event.startsAt, null)
  assert.equal(event.timePrecision, 'date')
  assert.equal(event.id, normalizeBackpackCalendar('earnings', [row], range).events[0]!.id)
})

test('normalizes naive economic timestamps as UTC and filters on the normalized UTC day', () => {
  const result = normalizeBackpackCalendar('economic', [
    { date: '2026-10-06 14:00:00', event: 'CPI', country: 'US', actual: 0, unit: '%' },
    { date: '2026-10-04T23:30:00-02:00', event: 'Boundary event' },
    { date: '2026-10-11T23:30:00-02:00', event: 'Outside UTC period' },
  ], range)
  assert.equal(result.events.length, 2)
  assert.equal(result.events[0]!.startsAt, '2026-10-06T14:00:00.000Z')
  assert.equal(result.events[1]!.date, '2026-10-05')
  assert.equal(result.events[1]!.startsAt, '2026-10-05T01:30:00.000Z')
  const event = result.events[0]!
  if (event.type !== 'economic') throw new Error('Wrong event type')
  assert.equal(event.actual, 0)
  assert.equal(event.estimate, null)
  assert.equal(event.unit, '%')
})

test('keeps Backpack unknown midnight times date-only but preserves explicit zoned midnight', () => {
  for (const date of ['2026-10-06', '2026-10-06 00:00:00']) {
    assert.deepEqual(parseEconomicTime(date), { date: '2026-10-06', startsAt: null, timePrecision: 'date' })
  }
  assert.equal(parseEconomicTime('2026-10-06T00:00:00Z').startsAt, '2026-10-06T00:00:00.000Z')
  assert.equal(parseEconomicTime('2026-10-06T14:00:00').startsAt, '2026-10-06T14:00:00.000Z')
  for (const date of ['2026-02-30 14:00:00', '2026-10-06 24:00:00', '2026-10-06 14:60:00']) {
    assert.throws(() => parseEconomicTime(date))
  }
})

test('reports malformed rows and rejects incompatible payloads instead of reporting an empty period', () => {
  const result = normalizeBackpackCalendar('economic', [
    { date: '2026-10-06 14:00:00', event: 'CPI' },
    { date: '2026-02-30', event: 'Impossible date' },
    { date: '2026-10-06', event: 'Invalid value', actual: 'broken' },
  ], range)
  assert.equal(result.events.length, 1)
  assert.equal(result.invalidEvents, 2)
  for (const payload of [{ data: [] }, [{ error: 'Not events' }], null]) {
    assert.throws(() => normalizeBackpackCalendar('economic', payload, range),
      (error) => error instanceof CalendarUpstreamError && error.detail.code === 'INVALID_UPSTREAM_RESPONSE')
  }
  assert.deepEqual(normalizeBackpackCalendar('economic', [], range), { events: [], invalidEvents: 0 })
})

test('calls the fixed anonymous read endpoint with the inclusive date bounds', async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://api.backpack.exchange')
    assert.equal(url.pathname, '/wapi/v1/stocks/earningsCalendar')
    assert.equal(url.searchParams.get('from'), range.from)
    assert.equal(url.searchParams.get('to'), range.to)
    assert.deepEqual(init?.headers, { Accept: 'application/json' })
    assert.ok(init?.signal)
    return Response.json([])
  }
  assert.equal((await fetchBackpackCalendar('earnings', range, { fetchImpl })).events.length, 0)
})

test('handles HTTP errors, invalid JSON and timeouts while cancelling the request', async () => {
  for (const [response, code] of [
    [new Response(null, { status: 429 }), 'UPSTREAM_HTTP_ERROR'],
    [new Response('<html>unavailable</html>'), 'INVALID_UPSTREAM_RESPONSE'],
  ] as const) {
    await assert.rejects(fetchBackpackCalendar('economic', range, { fetchImpl: async () => response }),
      (error) => error instanceof CalendarUpstreamError && error.detail.code === code)
  }
  let signal: AbortSignal | null | undefined
  await assert.rejects(fetchBackpackCalendar('economic', range, {
    timeoutMs: 5,
    fetchImpl: async (_, init) => {
      signal = init?.signal
      return new Promise<Response>(() => {})
    },
  }), (error) => error instanceof CalendarUpstreamError && error.detail.code === 'UPSTREAM_TIMEOUT')
  assert.equal(signal?.aborted, true)
})
