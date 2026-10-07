export type CalendarStatus = 'ready' | 'partial' | 'stale' | 'unavailable';
interface EventBase {
  id: string; title: string; date: string; startsAt: string | null;
  timePrecision: 'date' | 'time'; source: 'backpack'; sourceUrl: string;
}
export type CalendarEvent = EventBase & ({
  type: 'earnings'; symbol: string; epsEstimated: number | null; epsActual: number | null;
  revenueEstimated: number | null; revenueActual: number | null;
  providerUpdatedAt: string | null;
} | {
  type: 'economic'; country: string | null; currency: string | null; impact: string | null;
  unit: string | null; previous: number | null; estimate: number | null; actual: number | null;
  change: number | null; changePercentage: number | null;
});
export interface CalendarResult {
  range: { from: string; to: string; timeZone: 'UTC' };
  events: CalendarEvent[];
  sources: { type: 'earnings' | 'economic'; status: CalendarStatus; fetchedAt: string | null;
    eventCount: number; invalidEvents: number;
    error: { code: string; retryable: boolean } | null }[];
  status: CalendarStatus; partial: boolean; stale: boolean; generatedAt: string;
  nextRefreshAt: string | null;
}
