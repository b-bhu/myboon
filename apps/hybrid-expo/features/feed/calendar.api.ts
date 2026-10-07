import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
import type { CalendarResult } from './calendar.types';

export async function fetchCalendar(from: string, to: string, signal?: AbortSignal): Promise<CalendarResult> {
  const response = await fetchWithTimeout(`${resolveApiBaseUrl()}/calendar?from=${from}&to=${to}`, { signal });
  const payload = await response.json();
  // An unavailable provider has a useful 503 status envelope; keep its meaning in the UI.
  if ((response.ok || response.status === 503) && payload?.range?.from === from && payload?.range?.to === to
    && payload.range.timeZone === 'UTC' && Array.isArray(payload.events) && Array.isArray(payload.sources)
    && ['ready', 'partial', 'stale', 'unavailable'].includes(payload.status)) return payload;
  throw new Error('Calendar could not be loaded. Try again.');
}
