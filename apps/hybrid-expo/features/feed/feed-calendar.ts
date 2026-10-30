import { withMock } from './feed-mocks';
import type { CalendarEvent } from './calendar.types';

/**
 * Pure helpers for the "Markets now" calendar carousel and the full Calendar
 * screen (issue #498, markup per docs/mockups/design-language/feed-mock.html
 * #s-home #s-slides #s-calendar #s-eventsheet, DESIGN.md sections 7, 8, 12).
 *
 * Deliberately react-free and side-effect free so plain-node tooling
 * (node:test) can exercise every branch, mirroring feed-home.ts and
 * feed-stories.ts. All dates are UTC.
 */

const DAY_MS = 86_400_000;

const pad = (value: number): string => String(value).padStart(2, '0');

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** First and last day (YYYY-MM-DD) of the UTC month containing isoDate. */
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

export interface CalendarCell {
  date: string;
  inMonth: boolean;
}

/**
 * Monday-first month grid (UTC) covering the month: leading/trailing padding
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

/** Events grouped by their YYYY-MM-DD date; every group sorted by eventOrder. */
export function eventsByDay(events: CalendarEvent[]): Record<string, CalendarEvent[]> {
  const days: Record<string, CalendarEvent[]> = {};
  for (const event of events) {
    const day = (days[event.date] ??= []);
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
 * unusable startsAt) the very end of that UTC day.
 */
function eventInstant(event: CalendarEvent): number | null {
  const startMs = event.startsAt ? Date.parse(event.startsAt) : Number.NaN;
  if (!Number.isNaN(startMs)) return startMs;
  const dayMs = Date.parse(`${event.date}T23:59:59Z`);
  return Number.isNaN(dayMs) ? null : dayMs;
}

function byInstantThenTitle(a: CalendarEvent, b: CalendarEvent): number {
  const aMs = eventInstant(a);
  const bMs = eventInstant(b);
  if (aMs !== bMs) return (aMs ?? Number.POSITIVE_INFINITY) - (bMs ?? Number.POSITIVE_INFINITY);
  return a.title.localeCompare(b.title);
}

/**
 * "Next big event": the earliest high-impact event that has not passed;
 * anything left counts as the end of its UTC day. No high-impact event
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

/**
 * '2D 07H' from one day out, '07H 05M' inside the final day, 'NOW' at or
 * past the moment, '' for unusable targets.
 */
export function countdown(target: string, now: Date): string {
  const targetMs = Date.parse(target);
  if (Number.isNaN(targetMs)) return '';
  const diff = targetMs - now.getTime();
  if (diff <= 0) return 'NOW';
  if (diff >= DAY_MS) {
    return `${Math.floor(diff / DAY_MS)}D ${pad(Math.floor((diff % DAY_MS) / 3_600_000))}H`;
  }
  return `${pad(Math.floor(diff / 3_600_000))}H ${pad(Math.floor((diff % 3_600_000) / 60_000))}M`;
}

/** Spoken form of countdown(): 'in 2d 07h', 'in 7h 05m', 'now' or ''. */
export function countdownLower(target: string, now: Date): string {
  const text = countdown(target, now);
  if (!text) return '';
  // In the final day the spoken form drops the hour's leading zero ('7h 05m').
  const lowered = text.toLowerCase().replace(/^0+(?=\d)/, '');
  return lowered === 'now' ? 'now' : `in ${lowered}`;
}

/** Events from now's UTC date through the following six days, inclusive. */
export function weekCount(events: CalendarEvent[], now: Date): number {
  const from = now.toISOString().slice(0, 10);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 6))
    .toISOString()
    .slice(0, 10);
  return events.filter((event) => event.date >= from && event.date <= to).length;
}

/** 'Macro · USD' / 'Macro · United States' / 'Macro', or 'Earnings · META'. */
export function eventMetaLabel(event: CalendarEvent): string {
  if (event.type === 'earnings') return `Earnings · ${event.symbol}`;
  const region = event.currency || event.country;
  return region ? `Macro · ${region}` : 'Macro';
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

export interface EventReactionRow {
  date: string;
  result: string;
  btc: string;
  spx: string;
  gold: string;
}

/**
 * Prototype-only last-three-times table (mock #s-eventsheet .rt): generic
 * placeholders — no real market history claims behind the sheet.
 */
export const EVENT_REACTION_SAMPLE: EventReactionRow[] = [
  { date: 'Sample one', result: 'Sample result', btc: '-1.8%', spx: '+0.6%', gold: '+0.9%' },
  { date: 'Sample two', result: 'Sample result', btc: '+1.4%', spx: '-0.5%', gold: '-0.2%' },
  { date: 'Sample three', result: 'Sample result', btc: '-0.7%', spx: '+0.2%', gold: '+0.4%' },
];

/** Sample reaction table only when mocks are active; null otherwise. */
export function eventReactionSample(enabled?: boolean): EventReactionRow[] | null {
  return withMock(EVENT_REACTION_SAMPLE, enabled);
}