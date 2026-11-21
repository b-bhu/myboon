import { Hono } from 'hono'
import { CalendarRangeError, parseCalendarRange } from './dates.js'
import {
  CalendarHistoryEntityError, CalendarHistoryParamError, CalendarHistoryUnavailableError,
  createCalendarHistory, type CalendarHistoryPrices, type CalendarHistoryReader,
} from './history.js'
import { CalendarService, type CalendarServiceOptions } from './service.js'

export function createCalendarRoutes(options: CalendarServiceOptions & {
  service?: Pick<CalendarService, 'getCalendar'>
  supabaseUrl?: string
  serviceRoleKey?: string
  /** The shared per-process Hyperliquid price service (#703), like /stories markets. */
  prices?: CalendarHistoryPrices
  history?: CalendarHistoryReader
} = {}): Hono {
  const routes = new Hono()
  const service = options.service ?? new CalendarService(options)
  // /calendar/history defaults to the real reader when the app passes its
  // Supabase and price wiring; a history override keeps route tests cheap.
  const history: CalendarHistoryReader | null = options.history ?? (options.supabaseUrl && options.serviceRoleKey
    ? createCalendarHistory({
      supabaseUrl: options.supabaseUrl,
      serviceRoleKey: options.serviceRoleKey,
      prices: options.prices,
      fetch: options.fetchImpl,
      now: options.now,
    })
    : null)
  routes.get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    try {
      const range = parseCalendarRange(c.req.query('from'), c.req.query('to'))
      const result = await service.getCalendar(range.from, range.to)
      return c.json(result, result.status === 'unavailable' ? 503 : 200)
    } catch (error) {
      if (error instanceof CalendarRangeError) {
        return c.json({ error: 'Bad request', detail: error.message }, 400)
      }
      return c.json({ error: 'Calendar unavailable' }, 500)
    }
  })
  routes.get('/history', async (c) => {
    c.header('Cache-Control', 'no-store')
    if (!history) return c.json({ error: 'Calendar history unavailable' }, 503)
    try {
      const result = await history.getHistory(c.req.query('entity') ?? '', c.req.query('before') ?? '')
      return c.json(result)
    } catch (error) {
      if (error instanceof CalendarHistoryParamError) {
        return c.json({ error: 'Bad request', detail: error.message }, 400)
      }
      if (error instanceof CalendarHistoryEntityError) {
        return c.json({ error: 'Calendar history entity not found' }, 404)
      }
      if (error instanceof CalendarHistoryUnavailableError) {
        return c.json({ error: 'Calendar history unavailable' }, 503)
      }
      console.error('[calendar-history] unexpected failure', error instanceof Error ? error.message : 'unknown error')
      return c.json({ error: 'Calendar history unavailable' }, 500)
    }
  })
  return routes
}
