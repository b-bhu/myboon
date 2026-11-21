import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
import type { CalendarHistoryMove, CalendarHistoryRelease, CalendarHistoryResponse } from '@myboon/shared/calendar';
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

/** A non-empty string. */
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

const optionalText = (value: unknown): value is string | null => value === null || typeof value === 'string';

const optionalNumber = (value: unknown): value is number | null => value === null || typeof value === 'number';

/** One saved release's consumed fields (#704); period/previous are not read by the table. */
function isCalendarHistoryRelease(release: unknown): release is CalendarHistoryRelease {
  if (typeof release !== 'object' || release === null) return false;
  const row = release as {
    date: unknown; startsAt: unknown; title: unknown; unit: unknown;
    actual: unknown; estimate: unknown; moves: unknown;
  };
  return isText(row.date)
    && (row.startsAt === null || isText(row.startsAt))
    && isText(row.title)
    && optionalText(row.unit)
    && optionalNumber(row.actual)
    && optionalNumber(row.estimate)
    && Array.isArray(row.moves) && row.moves.every(isCalendarHistoryMove);
}

/** One 24h move; `symbol` is what the table matches against its market columns. */
function isCalendarHistoryMove(move: unknown): move is CalendarHistoryMove {
  if (typeof move !== 'object' || move === null) return false;
  const row = move as { symbol: unknown; changePct: unknown };
  return isText(row.symbol) && optionalNumber(row.changePct);
}

/**
 * The slice of the /calendar/history answer the Last-3-times table consumes
 * (#704): entity slug, market columns and releases. Anything malformed — a
 * missing release date, a non-array moves list, an object instead of a market
 * — makes the whole request reject, like fetchCalendar's envelope checks.
 */
function isCalendarHistoryPayload(payload: unknown): payload is CalendarHistoryResponse {
  if (typeof payload !== 'object' || payload === null) return false;
  const body = payload as { entity?: { slug?: unknown }; markets?: unknown; releases?: unknown };
  if (typeof body.entity !== 'object' || body.entity === null || !isText((body.entity as { slug?: unknown }).slug)) return false;
  if (!Array.isArray(body.markets) || !Array.isArray(body.releases)) return false;
  return body.markets.every((market) => {
    if (typeof market !== 'object' || market === null) return false;
    const row = market as { symbol?: unknown; displaySymbol?: unknown };
    return isText(row.symbol) && isText(row.displaySymbol);
  }) && body.releases.every(isCalendarHistoryRelease);
}

/**
 * GET /calendar/history (#704): an entity's last (up to 3) saved releases
 * before `before` with the 24h move of every linked market. The sheet treats
 * this as optional context, so every failure here — bad params, unknown
 * entity, unavailable backend, malformed payload — rejects; the caller
 * renders nothing rather than a placeholder or a retry.
 */
export async function fetchCalendarHistory(entity: string, before: string, signal?: AbortSignal): Promise<CalendarHistoryResponse> {
  const response = await fetchWithTimeout(
    `${resolveApiBaseUrl()}/calendar/history?entity=${encodeURIComponent(entity)}&before=${encodeURIComponent(before)}`,
    { signal },
  );
  const payload: unknown = await response.json();
  if (response.ok && isCalendarHistoryPayload(payload)) return payload;
  throw new Error('Calendar history could not be loaded. Try again.');
}
