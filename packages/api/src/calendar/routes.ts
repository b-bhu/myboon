import { Hono } from 'hono'
import { CalendarRangeError, parseCalendarRange } from './dates.js'
import { CalendarService, type CalendarServiceOptions } from './service.js'

export function createCalendarRoutes(options: CalendarServiceOptions & {
  service?: Pick<CalendarService, 'getCalendar'>
} = {}): Hono {
  const routes = new Hono()
  const service = options.service ?? new CalendarService(options)
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
  return routes
}
