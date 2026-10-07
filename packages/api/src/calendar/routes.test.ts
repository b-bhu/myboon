import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { createCalendarRoutes } from './routes.js'
import type { CalendarResult } from './types.js'

function app(options: Parameters<typeof createCalendarRoutes>[0] = {}) {
  const routes = new Hono()
  routes.route('/calendar', createCalendarRoutes(options))
  routes.get('/health', (c) => c.json({ status: 'ok' }))
  return routes
}

test('rejects missing, impossible, reversed or oversized date bounds before requesting a provider', async () => {
  let calls = 0
  const routes = app({ fetchImpl: async () => { calls++; return Response.json([]) } })
  for (const query of [
    '', 'from=2026-10-05', 'from=2026-02-30&to=2026-03-01',
    'from=2027-02-29&to=2027-03-01', 'from=2026-10-11&to=2026-10-05',
    'from=2026-10-01&to=2026-11-01', 'from=2026-1-01&to=2026-01-07',
  ]) {
    const response = await routes.request(`/calendar?${query}`)
    assert.equal(response.status, 400, query)
  }
  assert.equal(calls, 0)
})

test('supports inclusive leap-day, same-day and year-crossing ranges and successfully empty periods', async () => {
  const routes = app({ fetchImpl: async () => Response.json([]) })
  for (const query of [
    'from=2028-02-29&to=2028-03-01', 'from=2026-10-06&to=2026-10-06',
    'from=2026-12-28&to=2027-01-03', 'from=2026-12-01&to=2026-12-31',
  ]) {
    const response = await routes.request(`/calendar?${query}`)
    assert.equal(response.status, 200)
    const body = await response.json() as CalendarResult
    assert.equal(body.status, 'ready')
    assert.equal(body.range.timeZone, 'UTC')
    assert.deepEqual(body.events, [])
    assert.equal(body.sources.every((source) => source.status === 'ready'), true)
  }
})

test('distinguishes provider failure from empty data and keeps unrelated health available', async () => {
  const routes = app({ fetchImpl: async () => new Response(null, { status: 503 }) })
  const response = await routes.request('/calendar?from=2026-10-05&to=2026-10-11')
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const body = await response.json() as CalendarResult
  assert.equal(body.status, 'unavailable')
  assert.equal(body.sources.every((source) => source.status === 'unavailable' && source.error !== null), true)
  assert.equal((await routes.request('/health')).status, 200)
})

test('returns usable partial data when one source fails and unavailable when disabled without provider calls', async () => {
  const routes = app({ fetchImpl: async (input) => String(input).includes('economicCalendar')
    ? new Response(null, { status: 403 }) : Response.json([{ date: '2026-10-06', symbol: 'DAL' }]),
  })
  const response = await routes.request('/calendar?from=2026-10-05&to=2026-10-11')
  assert.equal(response.status, 200)
  const body = await response.json() as CalendarResult
  assert.equal(body.status, 'partial')
  assert.equal(body.events.length, 1)
  assert.equal(body.sources[1]!.error?.retryable, false)
  const disabled = app({ enabled: false, fetchImpl: async () => { throw new Error('Must not fetch') } })
  const unavailable = await disabled.request('/calendar?from=2026-10-05&to=2026-10-11')
  assert.equal(unavailable.status, 503)
  assert.equal(((await unavailable.json()) as CalendarResult).sources[0]!.error?.code, 'DISABLED')
})
