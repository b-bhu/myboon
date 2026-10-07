import type { CalendarRange } from './types.js'

const DAY_MS = 86_400_000
export const MAX_CALENDAR_DAYS = 31

export class CalendarRangeError extends Error {}

export function parseCalendarDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CalendarRangeError('from and to must be valid YYYY-MM-DD dates')
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new CalendarRangeError('from and to must be valid YYYY-MM-DD dates')
  }
  return value
}

export function parseCalendarRange(from: unknown, to: unknown): CalendarRange {
  const range = { from: parseCalendarDate(from), to: parseCalendarDate(to), timeZone: 'UTC' as const }
  const days = (Date.parse(range.to) - Date.parse(range.from)) / DAY_MS + 1
  if (days < 1 || days > MAX_CALENDAR_DAYS) {
    throw new CalendarRangeError(`from must precede to; request at most ${MAX_CALENDAR_DAYS} inclusive days`)
  }
  return range
}

export function parseEconomicTime(value: unknown): {
  date: string
  startsAt: string | null
  timePrecision: 'date' | 'time'
} {
  if (typeof value !== 'string') throw new Error('Missing event date')
  const date = parseCalendarDate(value.slice(0, 10))
  if (value.length === 10) return { date, startsAt: null, timePrecision: 'date' }

  const naive = /^\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value)
  const zoned = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  const clock = naive ?? zoned
  if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3]) > 59) {
    throw new Error('Invalid event time')
  }
  // Backpack's macroUtcTimestamp helper treats naive 00:00 as an unknown
  // time. Other naive macro timestamps are UTC, not the server's timezone.
  if (naive && clock[1] === '00' && clock[2] === '00') {
    return { date, startsAt: null, timePrecision: 'date' }
  }
  const timestamp = Date.parse(naive ? `${value.replace(' ', 'T')}Z` : value)
  if (!Number.isFinite(timestamp)) throw new Error('Invalid event time')
  const startsAt = new Date(timestamp).toISOString()
  return { date: startsAt.slice(0, 10), startsAt, timePrecision: 'time' }
}
