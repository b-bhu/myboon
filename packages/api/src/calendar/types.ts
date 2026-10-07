export type CalendarCategory = 'earnings' | 'economic'
export type CalendarStatus = 'ready' | 'partial' | 'stale' | 'unavailable'

export interface CalendarRange {
  from: string
  to: string
  timeZone: 'UTC'
}

interface CalendarEventBase {
  id: string
  type: CalendarCategory
  title: string
  date: string
  startsAt: string | null
  timePrecision: 'date' | 'time'
  source: 'backpack'
  sourceUrl: string
}

export interface EarningsEvent extends CalendarEventBase {
  type: 'earnings'
  symbol: string
  epsEstimated: number | null
  epsActual: number | null
  revenueEstimated: number | null
  revenueActual: number | null
  providerUpdatedAt: string | null
}

export interface EconomicEvent extends CalendarEventBase {
  type: 'economic'
  country: string | null
  currency: string | null
  impact: string | null
  unit: string | null
  previous: number | null
  estimate: number | null
  actual: number | null
  change: number | null
  changePercentage: number | null
}

export type CalendarEvent = EarningsEvent | EconomicEvent

export interface CalendarSourceError {
  code: 'UPSTREAM_HTTP_ERROR' | 'UPSTREAM_TIMEOUT' | 'UPSTREAM_UNAVAILABLE'
    | 'INVALID_UPSTREAM_RESPONSE' | 'DISABLED' | 'BUSY'
  retryable: boolean
}

export interface CalendarSource {
  type: CalendarCategory
  provider: 'backpack'
  status: CalendarStatus
  // When our backend fetched the data, not the provider's publication time.
  fetchedAt: string | null
  eventCount: number
  invalidEvents: number
  error: CalendarSourceError | null
}

export interface CalendarResult {
  range: CalendarRange
  events: CalendarEvent[]
  sources: CalendarSource[]
  status: CalendarStatus
  partial: boolean
  stale: boolean
  generatedAt: string
  nextRefreshAt: string | null
}
