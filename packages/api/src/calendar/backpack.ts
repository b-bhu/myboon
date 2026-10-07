import { createHash } from 'node:crypto'
import { parseCalendarDate, parseEconomicTime } from './dates.js'
import type { CalendarCategory, CalendarEvent, CalendarRange, CalendarSourceError } from './types.js'

export const BACKPACK_CALENDAR_URL = 'https://backpack.exchange/stocks/calendar'
const ENDPOINTS: Record<CalendarCategory, string> = {
  earnings: 'earningsCalendar',
  economic: 'economicCalendar',
}

export class CalendarUpstreamError extends Error {
  constructor(public readonly detail: CalendarSourceError) {
    super(detail.code)
  }
}

export interface CalendarBatch {
  events: CalendarEvent[]
  invalidEvents: number
}

export async function fetchBackpackCalendar(
  type: CalendarCategory,
  range: CalendarRange,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CalendarBatch> {
  const url = new URL(`https://api.backpack.exchange/wapi/v1/stocks/${ENDPOINTS[type]}`)
  url.searchParams.set('from', range.from)
  url.searchParams.set('to', range.to)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const request = (async () => {
      const response = await (options.fetchImpl ?? fetch)(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) {
        throw new CalendarUpstreamError({
          code: 'UPSTREAM_HTTP_ERROR',
          retryable: response.status === 429 || response.status >= 500,
        })
      }
      let payload: unknown
      try { payload = await response.json() } catch {
        throw new CalendarUpstreamError({ code: 'INVALID_UPSTREAM_RESPONSE', retryable: true })
      }
      return normalizeBackpackCalendar(type, payload, range)
    })()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new CalendarUpstreamError({ code: 'UPSTREAM_TIMEOUT', retryable: true }))
        controller.abort()
      }, options.timeoutMs ?? 8000)
    })
    return await Promise.race([request, timeout])
  } catch (error) {
    if (error instanceof CalendarUpstreamError) throw error
    throw new CalendarUpstreamError({ code: 'UPSTREAM_UNAVAILABLE', retryable: true })
  } finally {
    clearTimeout(timer)
  }
}

export function normalizeBackpackCalendar(
  type: CalendarCategory, payload: unknown, range: CalendarRange,
): CalendarBatch {
  if (!Array.isArray(payload) || payload.length > 10_000) {
    throw new CalendarUpstreamError({ code: 'INVALID_UPSTREAM_RESPONSE', retryable: true })
  }
  const events = new Map<string, CalendarEvent>()
  let invalidEvents = 0
  for (const raw of payload) {
    try {
      const row = record(raw)
      const timing = type === 'earnings'
        ? { date: parseCalendarDate(row.date), startsAt: null, timePrecision: 'date' as const }
        : parseEconomicTime(row.date)
      const title = type === 'earnings' ? `${requiredText(row.symbol)} earnings` : requiredText(row.event)
      const country = type === 'economic' ? optionalText(row.country) : null
      const key = [type, timing.date, timing.startsAt, country, title.toLowerCase()].join('|')
      const common = {
        id: `backpack:${type}:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
        title,
        ...timing,
        source: 'backpack' as const,
        sourceUrl: BACKPACK_CALENDAR_URL,
      }
      const event: CalendarEvent = type === 'earnings' ? {
        ...common, type: 'earnings', symbol: requiredText(row.symbol),
        epsEstimated: optionalNumber(row.epsEstimated), epsActual: optionalNumber(row.epsActual),
        revenueEstimated: optionalNumber(row.revenueEstimated), revenueActual: optionalNumber(row.revenueActual),
        providerUpdatedAt: optionalText(row.lastUpdated),
      } : {
        ...common, type: 'economic', country,
        currency: optionalText(row.currency), impact: optionalText(row.impact), unit: optionalText(row.unit),
        previous: optionalNumber(row.previous), estimate: optionalNumber(row.estimate), actual: optionalNumber(row.actual),
        change: optionalNumber(row.change), changePercentage: optionalNumber(row.changePercentage),
      }
      if (event.date >= range.from && event.date <= range.to) events.set(event.id, event)
    } catch { invalidEvents++ }
  }
  // Non-empty malformed payloads cannot establish a successfully empty period.
  if (payload.length > 0 && invalidEvents === payload.length) {
    throw new CalendarUpstreamError({ code: 'INVALID_UPSTREAM_RESPONSE', retryable: true })
  }
  return { events: [...events.values()], invalidEvents }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid row')
  return value as Record<string, unknown>
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error('Invalid text')
  return value.trim().replace(/\s+/g, ' ')
}

function optionalText(value: unknown): string | null {
  return value == null ? null : requiredText(value)
}

function optionalNumber(value: unknown): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid number')
  return value
}
