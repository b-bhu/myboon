import type { CalendarHistoryRelease, CalendarHistoryResponse } from '@myboon/shared/calendar';
import type { CalendarEvent } from './calendar.types';

/**
 * Pure helpers for the "Markets now" calendar carousel and the full Calendar
 * screen (issue #498, markup per docs/mockups/design-language/feed-mock.html
 * #s-home #s-slides #s-calendar #s-eventsheet, DESIGN.md sections 7, 8, 12).
 *
 * Deliberately react-free and side-effect free so plain-node tooling
 * (node:test) can exercise every branch, mirroring feed-home.ts and
 * feed-stories.ts. Instants are UTC timestamps, but every displayed day, time
 * and grouping follows the device's LOCAL zone through Date's local getters,
 * so tests can pin behaviour by running the suite under a fixed process
 * timezone (e.g. TZ=Asia/Calcutta). Month/shift math stays date-string based.
 */

const DAY_MS = 86_400_000;

const pad = (value: number): string => String(value).padStart(2, '0');

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** First and last day (YYYY-MM-DD) of the month containing isoDate. */
export function monthRange(isoDate: string): { from: string; to: string } {
  const date = parseDate(isoDate);
  if (!date) return { from: '', to: '' };
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  // Day 0 of the next month rolls back to this month's last day.
  const to = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  return { from: `${year}-${pad(month + 1)}-01`, to };
}

/** First day (YYYY-MM-DD) of the month delta steps away; wraps across years. */
export function shiftMonth(isoDate: string, delta: number): string {
  const date = parseDate(isoDate);
  if (!date || !Number.isFinite(delta)) return '';
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + Math.trunc(delta), 1))
    .toISOString()
    .slice(0, 10);
}

/** The YYYY-MM-DD key moved by whole days (negative fine); '' for unusable input. */
export function shiftDate(isoDate: string, days: number): string {
  const date = parseDate(isoDate);
  if (!date || !Number.isFinite(days)) return '';
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + Math.trunc(days)))
    .toISOString()
    .slice(0, 10);
}

export interface CalendarCell {
  date: string;
  inMonth: boolean;
}

/**
 * Monday-first month grid covering the month: leading/trailing padding
 * cells carry inMonth false. Always 4-6 rows of 7; [] for unusable input.
 */
export function monthGrid(isoMonthDate: string): CalendarCell[][] {
  const date = parseDate(isoMonthDate);
  if (!date) return [];
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  // (UTC weekday + 6) % 7 maps Sunday = 0 ... Saturday = 6 to Monday = 0.
  const lead = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const dayCount = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = Math.ceil((lead + dayCount) / 7) * 7;
  const rowLength = 7;
  const grid: CalendarCell[][] = [];
  for (let index = 0; index < cells; index += rowLength) {
    const row: CalendarCell[] = [];
    for (let offset = 0; offset < rowLength; offset += 1) {
      const day = index + offset - lead + 1;
      row.push({
        date: new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10),
        inMonth: day >= 1 && day <= dayCount,
      });
    }
    grid.push(row);
  }
  return grid;
}

/** Local YYYY-MM-DD of an instant, read through the device zone's getters. */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Local label for a YYYY-MM-DD day (moved here from the event sheet so the
 * Last-3-times rows share the sheet's one date formatter, #704).
 */
export function calendarDateLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  // Local noon keeps the calendar date stable across zones and DST edges.
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', options);
}

/**
 * The event's day in the device zone: the local date of startsAt when timed
 * (so a start near midnight can shift to the neighbouring day), otherwise
 * event.date unchanged — date-only events never shift.
 */
export function eventLocalDate(event: CalendarEvent): string {
  if (event.timePrecision === 'time' && event.startsAt) {
    const start = new Date(event.startsAt);
    if (!Number.isNaN(start.getTime())) return localDateKey(start);
  }
  return event.date;
}

/** '23:30' in the local 24-hour clock for timed events, 'All day' otherwise. */
export function eventLocalTime(event: CalendarEvent): string {
  if (event.timePrecision !== 'time' || !event.startsAt) return 'All day';
  const start = new Date(event.startsAt);
  if (Number.isNaN(start.getTime())) return 'All day';
  return `${pad(start.getHours())}:${pad(start.getMinutes())}`;
}

/**
 * The home card's one-line meta (issue #682): 'date · time' plus the figure
 * summary when one exists ('Thu 10 Dec · 00:30 · Est 4.25%'), never a
 * trailing separator.
 */
export function eventMetaLine(dateLabel: string, time: string, summary: string): string {
  return [dateLabel, time, summary].filter(Boolean).join(' · ');
}

/** Epoch ms of the last millisecond of the local day named by isoDate (NaN if unusable). */
function localDayEndMs(isoDate: string): number {
  const date = parseDate(isoDate);
  if (!date) return Number.NaN;
  // Local getters, so the day edge follows the process zone (fixed-TZ testable).
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999).getTime();
}

/** Whole days from one YYYY-MM-DD key to another (NaN when either is unusable). */
function localDaySpan(fromKey: string, toKey: string): number {
  const from = parseDate(fromKey);
  const to = parseDate(toKey);
  if (!from || !to) return Number.NaN;
  return Math.round(
    (Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
      - Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) / DAY_MS,
  );
}

/**
 * Deterministic list order: startsAt ascending with missing (null or
 * unusable) instants last, then title ascending.
 */
function eventOrder(a: CalendarEvent, b: CalendarEvent): number {
  const aMs = a.startsAt ? Date.parse(a.startsAt) : Number.NaN;
  const bMs = b.startsAt ? Date.parse(b.startsAt) : Number.NaN;
  const aRank = Number.isNaN(aMs) ? Number.POSITIVE_INFINITY : aMs;
  const bRank = Number.isNaN(bMs) ? Number.POSITIVE_INFINITY : bMs;
  if (aRank !== bRank) return aRank - bRank;
  return a.title.localeCompare(b.title);
}

/** Events grouped by their local day (eventLocalDate); every group sorted. */
export function eventsByDay(events: CalendarEvent[]): Record<string, CalendarEvent[]> {
  const days: Record<string, CalendarEvent[]> = {};
  for (const event of events) {
    const day = (days[eventLocalDate(event)] ??= []);
    day.push(event);
  }
  for (const list of Object.values(days)) list.sort(eventOrder);
  return days;
}

/** Economic event the mock marks heavy; earnings events are never flagged. */
export function isHighImpact(event: CalendarEvent): boolean {
  return event.type === 'economic' && typeof event.impact === 'string' && /high/i.test(event.impact);
}

/**
 * The event's instant: its start, or for date precision (including an
 * unusable startsAt) the very end of that local day.
 */
function eventInstant(event: CalendarEvent): number | null {
  const startMs = event.startsAt ? Date.parse(event.startsAt) : Number.NaN;
  if (!Number.isNaN(startMs)) return startMs;
  const dayEndMs = localDayEndMs(event.date);
  return Number.isNaN(dayEndMs) ? null : dayEndMs;
}

function byInstantThenTitle(a: CalendarEvent, b: CalendarEvent): number {
  const aMs = eventInstant(a);
  const bMs = eventInstant(b);
  if (aMs !== bMs) return (aMs ?? Number.POSITIVE_INFINITY) - (bMs ?? Number.POSITIVE_INFINITY);
  return a.title.localeCompare(b.title);
}

/**
 * "Next big event": the earliest high-impact event that has not passed;
 * anything left counts as the end of its local day. No high-impact event
 * means the earliest of any; null when nothing is upcoming.
 */
export function nextBigEvent(events: CalendarEvent[], now: Date): CalendarEvent | null {
  const upcoming = events.filter((event) => {
    const instant = eventInstant(event);
    return instant !== null && instant >= now.getTime();
  });
  const high = upcoming.filter(isHighImpact).sort(byInstantThenTitle);
  if (high.length) return high[0];
  return upcoming.sort(byInstantThenTitle)[0] ?? null;
}

/** How long after an event starts it still reads 'NOW' (15 minutes). */
export const NOW_WINDOW_MS = 15 * 60_000;

/**
 * Caps when-label for a target instant: '2D 07H' from one day out, '07H 05M'
 * inside the final day, 'NOW' during the first NOW_WINDOW_MS after the moment, then
 * time-ago floored ('5M AGO', '2H AGO', '3D AGO'); '' for unusable targets.
 */
export function countdown(target: string, now: Date): string {
  const targetMs = Date.parse(target);
  if (Number.isNaN(targetMs)) return '';
  const elapsed = now.getTime() - targetMs;
  if (elapsed >= 0) {
    if (elapsed < NOW_WINDOW_MS) return 'NOW';
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}M AGO`;
    if (elapsed < DAY_MS) return `${Math.floor(elapsed / 3_600_000)}H AGO`;
    return `${Math.floor(elapsed / DAY_MS)}D AGO`;
  }
  const diff = -elapsed;
  if (diff >= DAY_MS) {
    return `${Math.floor(diff / DAY_MS)}D ${pad(Math.floor((diff % DAY_MS) / 3_600_000))}H`;
  }
  return `${pad(Math.floor(diff / 3_600_000))}H ${pad(Math.floor((diff % 3_600_000) / 60_000))}M`;
}

/**
 * Spoken form of countdown(): 'in 2d 07h', 'in 7h 05m', 'now' during the
 * first 15 minutes (NOW_WINDOW_MS), then '5m ago', '2h ago', '3d ago'; '' for unusable targets.
 */
export function countdownLower(target: string, now: Date): string {
  const text = countdown(target, now);
  if (!text) return '';
  if (text === 'NOW') return 'now';
  if (text.endsWith('AGO')) return text.toLowerCase();
  // In the final day the spoken form drops the hour's leading zero ('7h 05m').
  const lowered = text.toLowerCase().replace(/^0+(?=\d)/, '');
  return `in ${lowered}`;
}

/**
 * When-label for a whole event. Timed events speak their start instant
 * ('in 2d 07h', 'now', '5m ago'). Date-only events speak their local day:
 * 'today' when today, 'Nd ago' by day difference once behind, and counting
 * down to the end of that local day while ahead; '' when unusable.
 */
function whenLabel(event: CalendarEvent, now: Date, caps: boolean): string {
  const startsAt = event.timePrecision === 'time' && event.startsAt ? event.startsAt : null;
  if (startsAt && !Number.isNaN(Date.parse(startsAt))) {
    return caps ? countdown(startsAt, now) : countdownLower(startsAt, now);
  }
  const today = localDateKey(now);
  if (event.date === today) return caps ? 'TODAY' : 'today';
  const dayEndMs = localDayEndMs(event.date);
  if (Number.isNaN(dayEndMs)) return '';
  const behind = localDaySpan(event.date, today);
  if (Number.isFinite(behind) && behind >= 1) return caps ? `${behind}D AGO` : `${behind}d ago`;
  const target = new Date(dayEndMs).toISOString();
  return caps ? countdown(target, now) : countdownLower(target, now);
}

/** Lower-form when-label for an event, as spoken in the sheet and day list. */
export function eventWhen(event: CalendarEvent, now: Date): string {
  return whenLabel(event, now, false);
}

/** Caps when-label for an event — the slide's big countdown. */
export function eventCountdown(event: CalendarEvent, now: Date): string {
  return whenLabel(event, now, true);
}

/**
 * High-impact macro events only, from now's local day through the following
 * six days inclusive: earnings and low/medium/unrated impact never count.
 */
export function weekCount(events: CalendarEvent[], now: Date): number {
  const from = localDateKey(now);
  const to = shiftDate(from, 6);
  return events.filter((event) => {
    if (!isHighImpact(event)) return false;
    const day = eventLocalDate(event);
    return day >= from && day <= to;
  }).length;
}

/** 'Macro · USD' / 'Macro · United States' / 'Macro', or 'Earnings · META'. */
export function eventMetaLabel(event: CalendarEvent): string {
  if (event.type === 'earnings') return `Earnings · ${event.symbol}`;
  const region = event.currency || event.country;
  return region ? `Macro · ${region}` : 'Macro';
}

/**
 * The day-list card's painted meta (mock #s-calendar, #798): 'currency · Est
 * x · Prev y' with the figure's unit suffix. Whatever half the event lacks
 * is dropped; '' renders no line. Earnings speak the symbol and the EPS
 * estimate, the one figure they share with the mock's shape.
 */
export function eventCardMeta(event: CalendarEvent): string {
  if (event.type === 'earnings') {
    const parts = [event.symbol];
    if (event.epsEstimated !== null && Number.isFinite(event.epsEstimated)) {
      parts.push(`EPS est ${compactUsd(event.epsEstimated)}`);
    }
    return parts.filter(Boolean).join(' · ');
  }
  const unit = event.unit ?? '';
  const parts = [event.currency ?? ''];
  if (event.estimate !== null && Number.isFinite(event.estimate)) parts.push(`Est ${numbered(event.estimate, unit)}`);
  if (event.previous !== null && Number.isFinite(event.previous)) parts.push(`Prev ${numbered(event.previous, unit)}`);
  return parts.filter(Boolean).join(' · ');
}

/**
 * The day-list card's filled impact pips (mock .imp, #798): three pip boxes
 * with the impact level lighting them, high 3 / medium 2 / low 1; events
 * without an impact level (and every earnings event) stay unlit at 0.
 */
export function eventImpactPips(event: CalendarEvent): number {
  if (event.type !== 'economic' || typeof event.impact !== 'string') return 0;
  if (/high/i.test(event.impact)) return 3;
  if (/medium|moderate/i.test(event.impact)) return 2;
  if (/low/i.test(event.impact)) return 1;
  return 0;
}

export interface EventFigure {
  label: string;
  value: string;
}

/** Up to two decimals, trimming trailing zeros; used for compact money. */
function trimmed(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** Compact USD figures ('$2.04B', '$5.25'); null or unusable reads '—'. */
function compactUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${sign}$${trimmed(abs / 1e12)}T`;
  if (abs >= 1e9) return `${sign}$${trimmed(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}$${trimmed(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}$${trimmed(abs / 1e3)}K`;
  return `${sign}$${trimmed(abs)}`;
}

function numbered(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const decimals = Math.abs(value) < 1 ? 6 : 2;
  return `${value.toLocaleString('en-US', { maximumFractionDigits: decimals })}${unit}`;
}

/**
 * Figure boxes for the event sheet: Consensus/Previous for economic events
 * (Actual only once published) with the unit suffix, and the four earnings
 * values compactly formatted.
 */
export function eventFigures(event: CalendarEvent): EventFigure[] {
  if (event.type === 'earnings') {
    return [
      { label: 'EPS est', value: compactUsd(event.epsEstimated) },
      { label: 'EPS actual', value: compactUsd(event.epsActual) },
      { label: 'Revenue est', value: compactUsd(event.revenueEstimated) },
      { label: 'Revenue actual', value: compactUsd(event.revenueActual) },
    ];
  }
  const unit = event.unit ?? '';
  const figures: EventFigure[] = [
    { label: 'Consensus', value: numbered(event.estimate, unit) },
    { label: 'Previous', value: numbered(event.previous, unit) },
  ];
  if (event.actual !== null) figures.push({ label: 'Actual', value: numbered(event.actual, unit) });
  return figures;
}

/**
 * The Last-3-times request for a sheet event (#704): the entity's slug and the
 * `before` date — but only for economic events the API matched to a series.
 * Earnings events, unmatched economic events and a closed sheet (null) never
 * fetch and never show the table.
 */
export interface CalendarHistoryRequest {
  entity: string;
  before: string;
}

export function calendarHistoryRequest(event: CalendarEvent | null): CalendarHistoryRequest | null {
  if (!event || event.type !== 'economic' || !event.entitySlug) return null;
  return { entity: event.entitySlug, before: event.date };
}

/**
 * A past release's day in the device zone: startsAt's local day when an
 * instant is present, otherwise the release date; an unusable start falls
 * back to the date, the eventLocalDate way.
 */
export function releaseLocalDate(release: Pick<CalendarHistoryRelease, 'date' | 'startsAt'>): string {
  if (release.startsAt) {
    const start = new Date(release.startsAt);
    if (!Number.isNaN(start.getTime())) return localDateKey(start);
  }
  return release.date;
}

/**
 * The Result cell: `actual vs estimate` with units, the actual alone when no
 * estimate exists, or a plain '—' when the release has no actual at all.
 */
export function historyResultLabel(actual: number | null, estimate: number | null, unit: string): string {
  if (actual === null) return '—';
  if (estimate === null) return numbered(actual, unit);
  return `${numbered(actual, unit)} vs ${numbered(estimate, unit)}`;
}

export type CalendarHistoryMoveDirection = 'up' | 'down' | 'flat' | 'none';

/**
 * One 24h move's text and meaning direction: signed 2 decimals ('+1.24%',
 * '−0.80%'), zero neutral ('0.00%'), and '—' in neutral colour when the move
 * is missing (no exact time, unfinished window, failed read).
 */
export function historyMoveCell(changePct: number | null): { text: string; dir: CalendarHistoryMoveDirection } {
  if (changePct === null || !Number.isFinite(changePct)) return { text: '—', dir: 'none' };
  if (changePct > 0) return { text: `+${changePct.toFixed(2)}%`, dir: 'up' };
  if (changePct < 0) return { text: `−${Math.abs(changePct).toFixed(2)}%`, dir: 'down' };
  return { text: '0.00%', dir: 'flat' };
}

export interface CalendarHistoryMoveColumn {
  /** Hyperliquid symbol of the column's market (stable React key). */
  symbol: string;
  /** Column header text, from the response's market list. */
  displaySymbol: string;
  /** Formatted cell: '+1.24%', '−0.80%', '0.00%' or '—'. */
  text: string;
  /** Meaning direction; flat/none render in the neutral text colour. */
  dir: CalendarHistoryMoveDirection;
}

export interface CalendarHistoryRow {
  /** Stable React key from the release's date and title. */
  key: string;
  /** Release day label, e.g. '10 Nov' (the sheet when line's form). */
  date: string;
  /** Result cell: '3.7% vs 3.6%', '3.7%' or '—'. */
  result: string;
  /** One move per linked market, in the response's (rank) order. */
  moves: CalendarHistoryMoveColumn[];
  /** Spoken form of the whole row, e.g. '10 Nov, 3.7% versus 3.6%, BTC up 1.24%, SPX down 0.80%'. */
  spoken: string;
}

/** The table's header cells: Date and Result, then one column per market. */
export function historyTableColumns(response: CalendarHistoryResponse): string[] {
  return ['Date', 'Result', ...response.markets.map((market) => market.displaySymbol)];
}

/** Spoken form of one move cell: '… up 1.24%', '… down 0.80%', 'BTC 0.00%'; no data stays unspoken. */
function spokenMove(move: CalendarHistoryMoveColumn): string | null {
  const magnitude = move.text.startsWith('+') || move.text.startsWith('−') ? move.text.slice(1) : move.text;
  if (move.dir === 'up') return `${move.displaySymbol} up ${magnitude}`;
  if (move.dir === 'down') return `${move.displaySymbol} down ${magnitude}`;
  if (move.dir === 'flat') return `${move.displaySymbol} ${magnitude}`;
  return null;
}

/**
 * The event sheet's LAST 3 TIMES rows (#704): one per served release (newest
 * first, at most three), each with the row's move per linked market in the
 * response's market order (rank 1 lead first) and a one-line spoken form.
 * Null when the response has no releases — the sheet renders no table block,
 * never an empty one. `fallbackUnit` fills in when a release carries no unit
 * of its own (the event's series unit).
 */
export function historyTableRows(response: CalendarHistoryResponse, fallbackUnit = ''): CalendarHistoryRow[] | null {
  if (!response.releases.length) return null;
  return response.releases.map((release) => {
    const unit = release.unit ?? fallbackUnit;
    const result = historyResultLabel(release.actual, release.estimate, unit);
    const date = calendarDateLabel(releaseLocalDate(release), { day: 'numeric', month: 'short' });
    const moves: CalendarHistoryMoveColumn[] = response.markets.map((market) => {
      const move = release.moves.find((entry) => entry.symbol === market.symbol);
      return { symbol: market.symbol, displaySymbol: market.displaySymbol, ...historyMoveCell(move ? move.changePct : null) };
    });
    return {
      key: `${release.date}-${release.title}`,
      date,
      result,
      moves,
      spoken: [date, result.replace(' vs ', ' versus '), ...moves.map(spokenMove)]
        .filter((part): part is string => part !== null)
        .join(', '),
    };
  });
}