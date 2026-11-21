import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import {
  CalendarHistoryEntityError, CalendarHistoryUnavailableError,
  type CalendarHistoryReader,
} from './history.js'
import { createCalendarRoutes } from './routes.js'
import type { CalendarResult, EarningsEvent, EconomicEvent } from './types.js'
import type { CalendarHistoryResponse } from '@myboon/shared/calendar'

const HISTORY_SERVICE_KEY = 'route-test-service-key'
const HISTORY_ENTITY_ID = '0f10c100-0000-7000-8000-0000000000c1'

function econ(event: CalendarResult['events'][number] | undefined): EconomicEvent {
  if (!event || event.type !== 'economic') throw new Error(`Missing economic event: ${event?.title}`)
  return event
}

function earn(event: CalendarResult['events'][number] | undefined): EarningsEvent {
  if (!event || event.type !== 'earnings') throw new Error(`Missing earnings event: ${event?.title}`)
  return event
}

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

test('/calendar economic events carry the entity from the fixed series list and ids stay unchanged', async () => {
  const routes = app({ fetchImpl: async () => Response.json([
    { date: '2026-10-13 13:30:00', event: 'Inflation Rate YoY (Oct)', country: 'US', unit: '%', previous: 2.9, estimate: 3.0, actual: 3.1 },
    { date: '2026-10-13 13:00:00', event: 'Inflation Rate YoY (Oct)', country: 'JP', unit: '%' },
    { date: '2026-10-14', symbol: 'DAL' },
  ]) })
  const response = await routes.request('/calendar?from=2026-10-11&to=2026-10-15')
  assert.equal(response.status, 200)
  const body = await response.json() as CalendarResult
  assert.equal(body.events.length, 3)
  const us = econ(body.events.find((event) => event.type === 'economic' && event.country === 'US'))
  assert.equal(us.entitySlug, 'us-cpi')
  // The identity hash predates #703 and must not move: entitySlug never joins the key.
  assert.equal(us.id, 'backpack:economic:5b5484444fc1a4ffb6901f23', 'US CPI id')
  const jp = econ(body.events.find((event) => event.type === 'economic' && event.country === 'JP'))
  assert.equal(jp.entitySlug, null)
  assert.equal(jp.id, 'backpack:economic:43053ff548030dcfe896ea9e', 'JP CPI id')
  const dal = earn(body.events.find((event) => event.type === 'earnings'))
  assert.equal(dal.entitySlug, null)
  assert.equal(dal.id, 'backpack:earnings:3ba45922f49b745e3dbc0c30', 'DAL earnings id')
})

test('/calendar/history rejects bad params before any read', async () => {
  let calls = 0
  const routes = app({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: HISTORY_SERVICE_KEY,
    fetchImpl: async () => { calls++; return Response.json([]) },
  })
  for (const query of [
    '', 'entity=cpi&before=2026-11-20', 'entity=us-cpi-fake&before=2026-11-20',
    'entity=us-cpi&before=2026-13-01', 'entity=us-cpi&before=2026-02-30',
    'entity=us-cpi&before=not-a-date', 'entity=us-cpi',
  ]) {
    const response = await routes.request(`/calendar/history?${query}`)
    assert.equal(response.status, 400, query)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(((await response.json()) as { error: string }).error, 'Bad request')
  }
  assert.equal(calls, 0)
})

test('/calendar/history maps reader outcomes to 404 and 503 and serves the reader response on 200', async () => {
  const notFound: CalendarHistoryReader = { getHistory: async () => { throw new CalendarHistoryEntityError('us-cpi') } }
  const missing = await app({ history: notFound }).request('/calendar/history?entity=us-cpi&before=2026-11-20')
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: 'Calendar history entity not found' })

  const down: CalendarHistoryReader = { getHistory: async () => { throw new CalendarHistoryUnavailableError('rest down') } }
  const unavailable = await app({ history: down }).request('/calendar/history?entity=us-cpi&before=2026-11-20')
  assert.equal(unavailable.status, 503)
  assert.deepEqual(await unavailable.json(), { error: 'Calendar history unavailable' })

  const body: CalendarHistoryResponse = {
    entity: { slug: 'us-cpi', name: 'US CPI' },
    markets: [{ symbol: 'BTC', displaySymbol: 'BTC', displayName: 'Bitcoin', rank: 1 }],
    releases: [{
      date: '2026-10-13', startsAt: '2026-10-13T13:30:00+00:00', title: 'Inflation Rate YoY',
      period: 'Oct', unit: '%', actual: 3.1, estimate: 3.0, previous: 2.9,
      moves: [{ symbol: 'BTC', changePct: 2 }],
    }],
  }
  const ready: CalendarHistoryReader = { getHistory: async () => body }
  const response = await app({ history: ready }).request('/calendar/history?entity=us-cpi&before=2026-11-20')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await response.json(), body)
})

test('/calendar/history serves the configured reader end to end without guessing a move', async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const table = url.pathname.replace(/^\/rest\/v1\//, '')
    const headers = (init?.headers ?? {}) as Record<string, string>
    assert.equal(headers['apikey'], HISTORY_SERVICE_KEY)
    assert.equal(headers['Authorization'], `Bearer ${HISTORY_SERVICE_KEY}`)
    assert.equal(headers['Accept-Profile'], 'atlas')
    const params = url.searchParams
    if (table === 'entities') {
      assert.equal(params.get('slug'), 'eq.us-cpi')
      return Response.json([{ id: HISTORY_ENTITY_ID, slug: 'us-cpi', name: 'US CPI' }])
    }
    if (table === 'event_releases') {
      assert.equal(params.get('entity_id'), `eq.${HISTORY_ENTITY_ID}`)
      assert.equal(params.get('release_date'), 'lt.2026-11-20')
      return Response.json([{
        entity_id: HISTORY_ENTITY_ID,
        source_title: 'Inflation Rate YoY',
        period: null,
        release_date: '2026-10-13',
        starts_at: null,
        unit: '%',
        actual: null,
        estimate: null,
        previous: 2.9,
      }])
    }
    assert.equal(table, 'entity_markets')
    return Response.json([{ entity_id: HISTORY_ENTITY_ID, rank: 1, symbol: 'BTC' }])
  }
  const routes = app({
    supabaseUrl: 'https://project.supabase.co',
    serviceRoleKey: HISTORY_SERVICE_KEY,
    fetchImpl,
  })
  const response = await routes.request('/calendar/history?entity=us-cpi&before=2026-11-20')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(await response.json(), {
    entity: { slug: 'us-cpi', name: 'US CPI' },
    markets: [{ symbol: 'BTC', displaySymbol: 'BTC', displayName: 'Bitcoin', rank: 1 }],
    releases: [{
      date: '2026-10-13',
      startsAt: null,
      title: 'Inflation Rate YoY',
      period: null,
      unit: '%',
      actual: null,
      estimate: null,
      previous: 2.9,
      moves: [{ symbol: 'BTC', changePct: null }],
    }],
  } satisfies CalendarHistoryResponse)
})
