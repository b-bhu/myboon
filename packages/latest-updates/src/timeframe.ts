/**
 * Bar (f) stale_timeframe (#671): relative time words in the draft must still be true at the run's `now`. The bar does
 * not rewrite prose; stale wording anywhere in title, what_happened, how_we_got_here or what_to_watch is a hold.
 *
 *   "<weekday>'s session / open / close"  the most recent such weekday's US cash session (09:30-16:00 America/New_York);
 *                                         held once that session has closed at `now` ("next Monday's open" is exempt)
 *   today, this morning, this afternoon,  a new item must fall on now's calendar day in Asia/Kolkata
 *   tonight
 *   yesterday                             a new item must fall on the IST calendar day before now
 *   this week                             a new item must fall in now's ISO week in IST
 *
 * Item time is occurred_at, else created_at.
 */
import { draftText } from './text.js';
import type { Bundle, CheckFailure, Draft } from './types.js';

const IST = 'Asia/Kolkata';
const NEW_YORK = 'America/New_York';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

type Wall = { y: number; m: number; d: number; minutes: number; dow: number };

/** The wall-clock date, minute of day and weekday of an instant in a time zone. */
export function wallClock(instant: Date, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'long',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    dow: WEEKDAYS.indexOf(get('weekday').toLowerCase() as (typeof WEEKDAYS)[number]),
  };
}

/** Days since 1970-01-01 for a calendar date (zone-free arithmetic on wall dates). */
const dayNumber = (w: Pick<Wall, 'y' | 'm' | 'd'>): number => Math.floor(Date.UTC(w.y, w.m - 1, w.d) / 86_400_000);

/** ISO week key ("2026-W47") of a calendar date. */
function isoWeek(w: Pick<Wall, 'y' | 'm' | 'd'>): string {
  const date = new Date(Date.UTC(w.y, w.m - 1, w.d));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${week}`;
}

const SESSION_RE = /\b(monday|tuesday|wednesday|thursday|friday)(?:['\u2019]s)?\s+(?:(?:regular|trading|cash)\s+)?(session|open|opening|close|closing)\b/gi;
const FORWARD_RE = /\b(?:next|upcoming|coming)\s+$/i;
const TODAY_RE = /\b(today|this morning|this afternoon|tonight)\b/i;
const YESTERDAY_RE = /\byesterday\b/i;
const THIS_WEEK_RE = /\bthis week\b/i;
const CASH_CLOSE_MINUTES = 16 * 60;

export function checkStaleTimeframe(draft: Draft, bundle: Bundle): CheckFailure[] {
  const now = new Date(bundle.now);
  if (Number.isNaN(now.getTime())) return [{ check: 'stale_timeframe', detail: 'run clock is missing, so relative time words cannot be checked' }];
  const text = draftText(draft);
  const failures: CheckFailure[] = [];

  const ny = wallClock(now, NEW_YORK);
  for (const m of text.matchAll(SESSION_RE)) {
    if (FORWARD_RE.test(text.slice(0, m.index ?? 0))) continue;
    const daysBack = (ny.dow - WEEKDAYS.indexOf(m[1]!.toLowerCase() as (typeof WEEKDAYS)[number]) + 7) % 7;
    if (daysBack > 0 || ny.minutes >= CASH_CLOSE_MINUTES) {
      failures.push({ check: 'stale_timeframe', detail: `"${m[0]}" refers to a US session that has already closed` });
    }
  }

  const ist = wallClock(now, IST);
  const today = dayNumber(ist);
  const itemDays = bundle.new_items
    .map((i) => new Date(i.occurred_at ?? i.created_at))
    .filter((d) => !Number.isNaN(d.getTime()))
    .map((d) => wallClock(d, IST));
  const todayWord = text.match(TODAY_RE);
  if (todayWord && !itemDays.some((d) => dayNumber(d) === today)) {
    failures.push({ check: 'stale_timeframe', detail: `"${todayWord[1]}" but no new item is from today (IST)` });
  }
  if (YESTERDAY_RE.test(text) && !itemDays.some((d) => dayNumber(d) === today - 1)) {
    failures.push({ check: 'stale_timeframe', detail: '"yesterday" but no new item is from yesterday (IST)' });
  }
  if (THIS_WEEK_RE.test(text) && !itemDays.some((d) => isoWeek(d) === isoWeek(ist))) {
    failures.push({ check: 'stale_timeframe', detail: '"this week" but no new item is from this ISO week (IST)' });
  }
  return failures;
}
