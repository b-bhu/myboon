import assert from 'node:assert/strict'
import test from 'node:test'
import { CalendarService } from './service.js'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const FROM = '2026-10-05'
const TO = '2026-10-11'
const earnings = [{ date: '2026-10-06', symbol: 'DAL', epsEstimated: 1.85 }]
const economic = [{ date: '2026-10-06 14:00:00', event: 'CPI', country: 'US' }]
function payload(input: RequestInfo | URL) {
  return String(input).includes('earningsCalendar') ? earnings : economic
}

test('deduplicates concurrent requests, shares cached results and orders timed events before date-only events', async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const service = new CalendarService({ now: () => NOW, fetchImpl: async (input) => {
    calls++
    await gate
    return Response.json(payload(input))
  } })
  const pending = Array.from({ length: 8 }, () => service.getCalendar(FROM, TO))
  assert.equal(calls, 2)
  release()
  const results = await Promise.all(pending)
  assert.equal(results[0]!.status, 'ready')
  assert.deepEqual(results[0]!.events.map((event) => event.type), ['economic', 'earnings'])
  assert.equal(results[0]!.range.timeZone, 'UTC')
  assert.equal((await service.getCalendar(FROM, TO)).status, 'ready')
  assert.equal(calls, 2)
})

test('keeps a healthy category visible and retries only the failed category until its peer expires', async () => {
  let now = NOW
  let failed = true
  const calls: string[] = []
  const service = new CalendarService({ now: () => now, fetchImpl: async (input) => {
    calls.push(String(input))
    return failed && String(input).includes('economicCalendar')
      ? new Response(null, { status: 503 }) : Response.json(payload(input))
  } })
  const initial = await service.getCalendar(FROM, TO)
  assert.equal(initial.status, 'partial')
  assert.equal(initial.events.length, 1)
  assert.equal(initial.sources[1]!.status, 'unavailable')
  assert.equal(initial.sources[1]!.fetchedAt, null)
  await service.getCalendar(FROM, TO)
  assert.equal(calls.length, 2)
  now += 30_001
  failed = false
  const recovered = await service.getCalendar(FROM, TO)
  assert.equal(recovered.status, 'ready')
  assert.equal(recovered.events.length, 2)
  assert.equal(calls.length, 3)
  assert.equal(recovered.sources[0]!.fetchedAt, new Date(NOW).toISOString())
  assert.equal(recovered.nextRefreshAt, new Date(NOW + 300_000).toISOString())
})

test('serves last-good data as stale during outages, bounds its age and clears it on successful empty recovery', async () => {
  let now = NOW
  let mode: 'ready' | 'failed' | 'empty' = 'ready'
  let calls = 0
  const service = new CalendarService({ now: () => now, cacheTtlMs: 100, retryAfterMs: 50, maxStaleMs: 500,
    fetchImpl: async (input) => {
      calls++
      return mode === 'failed' ? new Response(null, { status: 503 }) : Response.json(mode === 'empty' ? [] : payload(input))
    },
  })
  await service.getCalendar(FROM, TO)
  now += 101
  mode = 'failed'
  const stale = await service.getCalendar(FROM, TO)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.stale, true)
  assert.equal(stale.events.length, 2)
  assert.equal(stale.sources[0]!.fetchedAt, new Date(NOW).toISOString())
  await service.getCalendar(FROM, TO)
  assert.equal(calls, 4)
  now = NOW + 501
  const expired = await service.getCalendar(FROM, TO)
  assert.equal(expired.status, 'unavailable')
  assert.equal(expired.events.length, 0)
  assert.equal(expired.sources[0]!.fetchedAt, null)
  now += 51
  mode = 'empty'
  const recovered = await service.getCalendar(FROM, TO)
  assert.equal(recovered.status, 'ready')
  assert.equal(recovered.stale, false)
  assert.equal(recovered.partial, false)
  assert.equal(recovered.events.length, 0)
})

test('marks partial malformed data explicitly and keeps healthy sources independent', async () => {
  const service = new CalendarService({ fetchImpl: async (input) => Response.json(
    String(input).includes('economicCalendar') ? [...economic, { broken: true }] : earnings,
  ) })
  const result = await service.getCalendar(FROM, TO)
  assert.equal(result.status, 'partial')
  assert.equal(result.events.length, 2)
  assert.equal(result.sources[0]!.status, 'ready')
  assert.equal(result.sources[1]!.status, 'partial')
  assert.equal(result.sources[1]!.invalidEvents, 1)
})

test('bounds the shared cache and limits simultaneous distinct upstream periods', async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const service = new CalendarService({ now: () => NOW, maxEntries: 1, maxInFlight: 1, fetchImpl: async () => {
    calls++
    await gate
    return Response.json([])
  } })
  const pending = service.getCalendar(FROM, TO)
  const busy = await service.getCalendar('2026-10-12', '2026-10-18')
  assert.equal(busy.status, 'unavailable')
  assert.equal(busy.sources[0]!.error?.code, 'BUSY')
  assert.equal(calls, 2)
  release()
  await pending
  await service.getCalendar('2026-10-12', '2026-10-18')
  await service.getCalendar(FROM, TO)
  assert.equal(calls, 6)
})
