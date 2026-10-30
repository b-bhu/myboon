import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_REACTION_SAMPLE,
  countdown,
  countdownLower,
  eventCountdown,
  eventFigures,
  eventLocalDate,
  eventLocalTime,
  eventMetaLabel,
  eventReactionSample,
  eventWhen,
  eventsByDay,
  isHighImpact,
  localDateKey,
  monthGrid,
  monthRange,
  nextBigEvent,
  shiftDate,
  shiftMonth,
  weekCount,
} from './feed-calendar';
import type { CalendarEvent } from './calendar.types';

type EconomicEvent = Extract<CalendarEvent, { type: 'economic' }>;
type EarningsEvent = Extract<CalendarEvent, { type: 'earnings' }>;

// Builders keep one field per line of variance; defaults are a high-impact FOMC.
const economic = (date: string, startsAt: string | null, patch: Partial<EconomicEvent> = {}): CalendarEvent => ({
  id: 'fomc',
  title: 'FOMC rate decision',
  date,
  startsAt,
  timePrecision: startsAt ? 'time' : 'date',
  source: 'backpack',
  sourceUrl: 'https://example.com/fomc',
  type: 'economic',
  country: null,
  currency: 'USD',
  impact: 'High',
  unit: '%',
  previous: 4.5,
  estimate: 4.25,
  actual: null,
  change: null,
  changePercentage: null,
  ...patch,
});

const earnings = (date: string, startsAt: string | null, patch: Partial<EarningsEvent> = {}): CalendarEvent => ({
  id: 'meta',
  title: 'Meta Q3 earnings',
  date,
  startsAt,
  timePrecision: startsAt ? 'time' : 'date',
  source: 'backpack',
  sourceUrl: 'https://example.com/meta',
  type: 'earnings',
  symbol: 'META',
  epsEstimated: 5.25,
  epsActual: null,
  revenueEstimated: null,
  revenueActual: null,
  providerUpdatedAt: null,
  ...patch,
});

// A timed event's own fields barely matter for the when-helpers; only its
// instant does. The event date still has to parse for grouping helpers.
const timed = (startsAt: string): CalendarEvent => economic('2026-10-28', startsAt);

test('monthRange returns the full month of the given day', () => {
  assert.deepEqual(monthRange('2026-10-15'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(monthRange('2027-02-14'), { from: '2027-02-01', to: '2027-02-28' });
});
test('monthRange keeps 29 days in the 2028 leap February', () => {
  assert.deepEqual(monthRange('2028-02-16'), { from: '2028-02-01', to: '2028-02-29' });
});
test('monthRange rejects unusable dates', () => {
  assert.deepEqual(monthRange('not-a-date'), { from: '', to: '' });
});

test('shiftMonth steps one month at a time', () => {
  assert.equal(shiftMonth('2026-10-30', 0), '2026-10-01');
  assert.equal(shiftMonth('2026-10-15', 1), '2026-11-01');
  assert.equal(shiftMonth('2026-01-31', 1), '2026-02-01');
});
test('shiftMonth handles the December to January year wrap', () => {
  assert.equal(shiftMonth('2026-12-20', 1), '2027-01-01');
  assert.equal(shiftMonth('2026-01-10', -2), '2025-11-01');
});
test('shiftMonth rejects unusable inputs', () => {
  assert.equal(shiftMonth('not-a-date', 1), '');
  assert.equal(shiftMonth('2026-10-15', Number.NaN), '');
});

test('monthGrid is Monday-first with padding days marked out of month', () => {
  // October 2026 starts on a Thursday, so the first cell is Mon Sep 28.
  const grid = monthGrid('2026-10-15');
  assert.equal(grid.length, 5);
  for (const row of grid) assert.equal(row.length, 7);
  assert.deepEqual(grid[0][0], { date: '2026-09-28', inMonth: false });
  assert.deepEqual(grid[0][3], { date: '2026-10-01', inMonth: true });
  assert.deepEqual(grid[4][6], { date: '2026-11-01', inMonth: false });
  const inMonth = grid.flat().filter((cell) => cell.inMonth);
  assert.equal(inMonth.length, 31);
  assert.equal(inMonth[0].date, '2026-10-01');
  assert.equal(inMonth[inMonth.length - 1].date, '2026-10-31');
});
test('monthGrid can fill four full rows when a 28-day month starts on Monday', () => {
  // February 2027 starts on a Monday and has 28 days: no padding at all.
  const grid = monthGrid('2027-02-10');
  assert.equal(grid.length, 4);
  assert.deepEqual(grid[0][0], { date: '2027-02-01', inMonth: true });
  assert.equal(grid.flat().filter((cell) => cell.inMonth).length, 28);
});
test('monthGrid keeps 29 days in the 2028 leap February', () => {
  const grid = monthGrid('2028-02-14');
  assert.equal(grid.length, 5);
  assert.deepEqual(grid[0][0], { date: '2028-01-31', inMonth: false });
  const inMonth = grid.flat().filter((cell) => cell.inMonth);
  assert.equal(inMonth.length, 29);
  assert.equal(inMonth[inMonth.length - 1].date, '2028-02-29');
});
test('monthGrid uses six rows when a month starts on Sunday', () => {
  // November 2026 starts on a Sunday: six leading padding cells, 30 days.
  const grid = monthGrid('2026-11-05');
  assert.equal(grid.length, 6);
  assert.deepEqual(grid[0][0], { date: '2026-10-26', inMonth: false });
  assert.equal(grid.flat().filter((cell) => cell.inMonth).length, 30);
  assert.deepEqual(grid[5][6], { date: '2026-12-06', inMonth: false });
});
test('monthGrid cells are all parseable YYYY-MM-DD dates', () => {
  for (const cell of monthGrid('2026-10-15').flat()) {
    assert.match(cell.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!Number.isNaN(Date.parse(cell.date)));
  }
});
test('monthGrid rejects unusable months', () => {
  assert.deepEqual(monthGrid('not-a-date'), []);
});

test('shiftDate moves a date by whole days across month and year edges', () => {
  assert.equal(shiftDate('2026-10-15', 0), '2026-10-15');
  assert.equal(shiftDate('2026-10-15', -1), '2026-10-14');
  assert.equal(shiftDate('2026-10-31', 1), '2026-11-01');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
});
test('shiftDate rejects unusable inputs', () => {
  assert.equal(shiftDate('not-a-date', 1), '');
  assert.equal(shiftDate('2026-10-15', Number.NaN), '');
});

test('isHighImpact matches the economic impact case-insensitively', () => {
  assert.equal(isHighImpact(economic('2026-10-28', null, { impact: 'High' })), true);
  assert.equal(isHighImpact(economic('2026-10-28', null, { impact: 'HIGH' })), true);
  assert.equal(isHighImpact(economic('2026-10-28', null, { impact: 'medium', title: 'Anything' })), false);
  assert.equal(isHighImpact(economic('2026-10-28', null, { impact: null })), false);
  assert.equal(isHighImpact(earnings('2026-10-28', null)), false);
});

const now = new Date('2026-10-30T12:00:00Z'); // Friday.

test('nextBigEvent prefers the earliest high-impact event over earlier low-impact ones', () => {
  const lowToday = economic('2026-10-30', '2026-10-30T14:00:00Z', { impact: 'Low', title: 'Small event' });
  const highTomorrow = economic('2026-10-31', '2026-10-31T09:00:00Z');
  const highLater = economic('2026-11-02', '2026-11-02T09:00:00Z');
  assert.equal(nextBigEvent([highLater, lowToday, highTomorrow], now), highTomorrow);
});
test('nextBigEvent falls back to the earliest of any impact when no high-impact event is left', () => {
  const later = economic('2026-10-31', '2026-10-31T09:00:00Z', { impact: 'Medium', title: 'Later event' });
  const earlier = economic('2026-10-30', '2026-10-30T14:00:00Z', { impact: 'Low', title: 'Earlier event' });
  assert.equal(nextBigEvent([later, earlier], now), earlier);
});
test('nextBigEvent skips events already in the past', () => {
  const past = economic('2026-10-30', '2026-10-30T09:00:00Z');
  assert.equal(nextBigEvent([past], now), null);
});
test('nextBigEvent returns null for empty or exhausted lists', () => {
  assert.equal(nextBigEvent([], now), null);
});

test('countdown shows days with zero-padded hours at a day or more', () => {
  assert.equal(countdown('2026-11-01T19:00:00Z', now), '2D 07H');
  assert.equal(countdown('2026-11-01T12:00:00Z', now), '2D 00H');
});
test('countdown shows zero-padded hours and minutes inside the last day', () => {
  assert.equal(countdown('2026-10-30T19:05:00Z', now), '07H 05M');
  assert.equal(countdown('2026-10-30T19:00:00Z', now), '07H 00M');
  assert.equal(countdown('2026-10-31T11:59:00Z', now), '23H 59M');
});
test('countdown reads exactly 24 hours as one day', () => {
  assert.equal(countdown('2026-10-31T12:00:00Z', now), '1D 00H');
});
test('countdown says NOW only during the first minute after the moment', () => {
  assert.equal(countdown('2026-10-30T12:00:00Z', now), 'NOW');
  assert.equal(countdown('2026-10-30T11:59:59Z', now), 'NOW');
  assert.equal(countdown('2026-10-30T11:59:01Z', now), 'NOW');
  // Minute one flips to time-ago, floored.
  assert.equal(countdown('2026-10-30T11:59:00Z', now), '1M AGO');
});
test('countdown speaks time-ago in caps after the first minute', () => {
  assert.equal(countdown('2026-10-30T11:55:00Z', now), '5M AGO');
  assert.equal(countdown('2026-10-30T10:00:00Z', now), '2H AGO');
  assert.equal(countdown('2026-10-27T12:00:00Z', now), '3D AGO');
  // Floored: extra hours never round a day up.
  assert.equal(countdown('2026-10-27T11:00:00Z', now), '3D AGO');
  assert.equal(countdown('2026-10-29T10:30:00Z', now), '1D AGO');
});
test('countdown rejects unusable targets', () => {
  assert.equal(countdown('not-a-date', now), '');
});

test('countdownLower speaks the countdown in lower case', () => {
  assert.equal(countdownLower('2026-11-01T19:00:00Z', now), 'in 2d 07h');
  assert.equal(countdownLower('2026-10-30T19:05:00Z', now), 'in 7h 05m');
});
test('countdownLower echoes the NOW window and time-ago', () => {
  assert.equal(countdownLower('2026-10-30T12:00:00Z', now), 'now');
  assert.equal(countdownLower('2026-10-30T11:59:01Z', now), 'now');
  assert.equal(countdownLower('2026-10-30T11:55:00Z', now), '5m ago');
  assert.equal(countdownLower('2026-10-30T10:00:00Z', now), '2h ago');
  assert.equal(countdownLower('2026-10-27T12:00:00Z', now), '3d ago');
  assert.equal(countdownLower('2026-10-29T10:30:00Z', now), '1d ago');
});
test('countdownLower rejects unusable targets', () => {
  assert.equal(countdownLower('not-a-date', now), '');
});

test('eventCountdown mirrors countdown for timed events', () => {
  assert.equal(eventCountdown(timed('2026-11-01T19:00:00Z'), now), '2D 07H');
  assert.equal(eventCountdown(timed('2026-10-30T19:05:00Z'), now), '07H 05M');
  assert.equal(eventCountdown(timed('2026-10-30T12:00:00Z'), now), 'NOW');
  assert.equal(eventCountdown(timed('2026-10-30T11:55:00Z'), now), '5M AGO');
  assert.equal(eventCountdown(timed('2026-10-27T12:00:00Z'), now), '3D AGO');
});

// The local-week window is expressed with the process zone's own getters so
// this subset also holds in any timezone, not just Asia/Calcutta.
const dayKeyNearNow = (offset: number): string => {
  const now = new Date();
  const shifted = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
};

test('weekCount counts only high-impact macro events inside the local week window', () => {
  const events = [
    economic(dayKeyNearNow(0), null), // Today: counts (High default).
    economic(dayKeyNearNow(3), '2026-11-04T09:00:00Z'), // Timed mid-week: counts.
    economic(dayKeyNearNow(6), null), // Last day of the window: counts.
    economic(dayKeyNearNow(-1), null), // Yesterday: out.
    economic(dayKeyNearNow(7), null), // Past the window: out.
    economic(dayKeyNearNow(0), null, { impact: 'Low' }), // Low impact: never counts.
    economic(dayKeyNearNow(1), null, { impact: 'Medium' }), // Medium: never counts.
    economic(dayKeyNearNow(1), null, { impact: null }), // Unrated: never counts.
    earnings(dayKeyNearNow(0), null), // Earnings: never counts.
  ];
  assert.equal(weekCount(events, new Date()), 3);
  assert.equal(weekCount([], new Date()), 0);
});

test('weekCount keeps counting the shown high-impact next event', () => {
  // The slide subtracts the displayed card only when it is itself counted,
  // which is exactly the high-impact case; clamp never goes below zero.
  const shown = economic(dayKeyNearNow(0), null);
  assert.equal(weekCount([shown], new Date()) - 1, 0);
  assert.equal(weekCount([earnings(dayKeyNearNow(0), null)], new Date()) - 1, -1);
});

test('eventsByDay groups date-only events by their date', () => {
  const alpha = economic('2026-10-28', null, { title: 'Alpha event' });
  const meta = earnings('2026-10-29', null);
  const days = eventsByDay([meta, alpha]);
  assert.deepEqual(Object.keys(days).sort(), ['2026-10-28', '2026-10-29']);
  assert.deepEqual(days['2026-10-28'].map((event) => event.title), ['Alpha event']);
  assert.deepEqual(days['2026-10-29'].map((event) => event.title), ['Meta Q3 earnings']);
});
test('eventsByDay never reorders the input list', () => {
  const first = economic('2026-10-28', null, { title: 'Alpha event' });
  const second = earnings('2026-10-29', null);
  const input = [first, second];
  eventsByDay(input);
  assert.deepEqual(input, [first, second]);
});
test('eventsByDay on an empty list stays empty', () => {
  assert.deepEqual(eventsByDay([]), {});
});

test('eventMetaLabel reads Macro with the currency, country, or nothing', () => {
  assert.equal(eventMetaLabel(economic('2026-10-28', null, { currency: 'USD' })), 'Macro · USD');
  assert.equal(eventMetaLabel(economic('2026-10-28', null, { currency: null, country: 'United States' })), 'Macro · United States');
  assert.equal(eventMetaLabel(economic('2026-10-28', null, { currency: null, country: null })), 'Macro');
});
test('eventMetaLabel reads Earnings with the symbol', () => {
  assert.equal(eventMetaLabel(earnings('2026-10-28', null)), 'Earnings · META');
});

test('eventFigures labels the economic boxes with their unit suffix', () => {
  assert.deepEqual(
    eventFigures(economic('2026-10-28', null, { estimate: 4.25, previous: 3.5, actual: 4.1, unit: '%' })),
    [
      { label: 'Consensus', value: '4.25%' },
      { label: 'Previous', value: '3.5%' },
      { label: 'Actual', value: '4.1%' },
    ],
  );
});
test('eventFigures omits the Actual box until an actual is published', () => {
  assert.deepEqual(
    eventFigures(economic('2026-10-28', null, { estimate: 4.25, previous: 3.5, actual: null, unit: '%' })),
    [
      { label: 'Consensus', value: '4.25%' },
      { label: 'Previous', value: '3.5%' },
    ],
  );
});
test('eventFigures shows a dash without a unit for missing economic numbers', () => {
  assert.deepEqual(
    eventFigures(economic('2026-10-28', null, { estimate: null, previous: null, actual: null, unit: null })),
    [
      { label: 'Consensus', value: '—' },
      { label: 'Previous', value: '—' },
    ],
  );
});
test('eventFigures reads earnings compactly', () => {
  assert.deepEqual(
    eventFigures(earnings('2026-10-28', null, { epsEstimated: 5.25, epsActual: null, revenueEstimated: 2_040_000_000, revenueActual: 2_180_000_000 })),
    [
      { label: 'EPS est', value: '$5.25' },
      { label: 'EPS actual', value: '—' },
      { label: 'Revenue est', value: '$2.04B' },
      { label: 'Revenue actual', value: '$2.18B' },
    ],
  );
});

test('EVENT_REACTION_SAMPLE ships three clearly sample rows', () => {
  assert.equal(EVENT_REACTION_SAMPLE.length, 3);
  for (const row of EVENT_REACTION_SAMPLE) {
    assert.equal(typeof row.date, 'string');
    assert.equal(typeof row.result, 'string');
    assert.match(row.date, /Sample/i);
    assert.match(row.result, /Sample/i);
    assert.match(row.btc, /^[+-]/);
    assert.match(row.spx, /^[+-]/);
    assert.match(row.gold, /^[+-]/);
  }
});
test('eventReactionSample follows the mock gate', () => {
  assert.equal(eventReactionSample(true), EVENT_REACTION_SAMPLE);
  assert.equal(eventReactionSample(false), null);
  // The test environment runs with mocks off; no implicit sample leaks in.
  assert.equal(eventReactionSample(), null);
});

// ---------------------------------------------------------------------------
// Timezone-explicit tests. The suite is meant to run under TZ=Asia/Calcutta
// (UTC+05:30, no DST), where e.g. 18:00Z lands at 23:30 the same local day
// and 19:00Z lands at 00:30 the next one. Skip with a note when the process
// zone does not match so a plain run outside IST stays green.
// ---------------------------------------------------------------------------
const IST_SKIP = new Date(0).getTimezoneOffset() !== -330
  ? `requires TZ=Asia/Calcutta (UTC+05:30); process offset is ${new Date(0).getTimezoneOffset()} minutes`
  : false;

// 12:00Z is 17:30 on Friday, October 30, 2026 in IST.
const istNow = new Date('2026-10-30T12:00:00Z');

test('localDateKey renders instants in the local zone', { skip: IST_SKIP }, () => {
  assert.equal(localDateKey(new Date('2026-10-28T18:00:00Z')), '2026-10-28'); // 23:30.
  assert.equal(localDateKey(new Date('2026-10-28T19:00:00Z')), '2026-10-29'); // 00:30.
  assert.equal(localDateKey(new Date('2026-10-28T18:29:59Z')), '2026-10-28');
  assert.equal(localDateKey(new Date('2026-10-28T18:30:00Z')), '2026-10-29');
  assert.equal(localDateKey(new Date('1970-01-01T00:00:00Z')), '1970-01-01'); // 05:30.
});

test('eventLocalDate shifts timed events to their local day and keeps date-only events', { skip: IST_SKIP }, () => {
  assert.equal(eventLocalDate(economic('2026-10-28', '2026-10-28T18:00:00Z')), '2026-10-28');
  assert.equal(eventLocalDate(economic('2026-10-28', '2026-10-28T19:00:00Z')), '2026-10-29');
  // Date-only events never shift; an unusable start falls back to the date.
  assert.equal(eventLocalDate(economic('2026-10-28', null, { timePrecision: 'date' })), '2026-10-28');
  assert.equal(eventLocalDate(economic('2026-10-28', 'garbage')), '2026-10-28');
});

test('eventLocalTime reads a 24-hour local clock or All day', { skip: IST_SKIP }, () => {
  assert.equal(eventLocalTime(economic('2026-10-28', '2026-10-28T18:00:00Z')), '23:30');
  assert.equal(eventLocalTime(economic('2026-10-28', '2026-10-28T19:00:00Z')), '00:30');
  assert.equal(eventLocalTime(economic('2026-10-28', '2026-10-28T05:05:00Z')), '10:35');
  assert.equal(eventLocalTime(economic('2026-10-28', null, { timePrecision: 'date' })), 'All day');
  assert.equal(eventLocalTime(economic('2026-10-28', 'garbage')), 'All day');
});

test('eventsByDay groups timed events by their local day', { skip: IST_SKIP }, () => {
  const crossing = economic('2026-10-28', '2026-10-28T19:00:00Z', { title: 'Crossing event' });
  const dayOnly = earnings('2026-10-28', null);
  const days = eventsByDay([crossing, dayOnly]);
  assert.deepEqual(Object.keys(days).sort(), ['2026-10-28', '2026-10-29']);
  assert.deepEqual(days['2026-10-29'].map((event) => event.title), ['Crossing event']);
  assert.deepEqual(days['2026-10-28'].map((event) => event.title), ['Meta Q3 earnings']);
});
test('eventsByDay orders each local group by instant then title', { skip: IST_SKIP }, () => {
  // 10:00Z is mid-day locally, so every event below shares local day 10-28.
  const timedEarly = economic('2026-10-28', '2026-10-28T10:00:00Z', { title: 'Timed event' });
  const untitledA = economic('2026-10-28', null, { title: 'Alpha event' });
  const untitledB = economic('2026-10-28', null, { title: 'Beta event' });
  const broken = economic('2026-10-28', 'garbage', { title: 'Zulu event' });
  const other = economic('2026-10-29', null, { title: 'Later day event' });
  const days = eventsByDay([broken, untitledB, other, untitledA, timedEarly]);
  assert.deepEqual(Object.keys(days).sort(), ['2026-10-28', '2026-10-29']);
  assert.deepEqual(
    days['2026-10-28'].map((event) => event.title),
    ['Timed event', 'Alpha event', 'Beta event', 'Zulu event'],
  );
  assert.deepEqual(days['2026-10-29'].map((event) => event.title), ['Later day event']);
});

test('nextBigEvent counts date-only events at the end of their local day', { skip: IST_SKIP }, () => {
  const todayDateOnly = economic('2026-10-30', null, { timePrecision: 'date' });
  // 23:59 local (18:29Z) is still inside the local day; local midnight is past it.
  assert.equal(nextBigEvent([todayDateOnly], new Date('2026-10-30T18:29:00Z')), todayDateOnly);
  assert.equal(nextBigEvent([todayDateOnly], new Date('2026-10-30T18:30:00Z')), null);
  const yesterdayDateOnly = economic('2026-10-29', null, { timePrecision: 'date' });
  assert.equal(nextBigEvent([yesterdayDateOnly], new Date('2026-10-30T18:29:00Z')), null);
});
test('nextBigEvent treats an unusable startsAt as date precision', { skip: IST_SKIP }, () => {
  const broken = economic('2026-10-30', 'garbage');
  assert.equal(nextBigEvent([broken], new Date('2026-10-30T18:29:00Z')), broken);
  assert.equal(nextBigEvent([broken], new Date('2026-10-30T18:30:00Z')), null);
});

test('eventWhen speaks the future countdown for timed events', { skip: IST_SKIP }, () => {
  assert.equal(eventWhen(timed('2026-11-01T19:00:00Z'), istNow), 'in 2d 07h');
  assert.equal(eventWhen(timed('2026-10-30T19:05:00Z'), istNow), 'in 7h 05m');
  assert.equal(eventWhen(timed('2026-10-30T12:00:00Z'), istNow), 'now');
  assert.equal(eventWhen(timed('2026-10-30T11:59:01Z'), istNow), 'now');
  assert.equal(eventWhen(timed('2026-10-30T11:59:00Z'), istNow), '1m ago');
  assert.equal(eventWhen(timed('2026-10-30T11:55:00Z'), istNow), '5m ago');
  assert.equal(eventWhen(timed('2026-10-30T10:00:00Z'), istNow), '2h ago');
  assert.equal(eventWhen(timed('2026-10-27T12:00:00Z'), istNow), '3d ago');
});
test('eventWhen labels date-only events by their local day', { skip: IST_SKIP }, () => {
  assert.equal(eventWhen(economic('2026-10-30', null), istNow), 'today');
  assert.equal(eventWhen(economic('2026-10-29', null), istNow), '1d ago');
  assert.equal(eventWhen(economic('2026-10-27', null), istNow), '3d ago');
  // Ahead: counts to the end of that local day (23:59:59 IST).
  assert.equal(eventWhen(economic('2026-11-01', null), istNow), 'in 2d 06h');
  assert.equal(eventWhen(economic('2026-10-31', null), istNow), 'in 1d 06h');
  assert.equal(eventWhen(economic('not-a-date', null), istNow), '');
});
test('eventCountdown labels date-only events in caps', { skip: IST_SKIP }, () => {
  assert.equal(eventCountdown(economic('2026-10-30', null), istNow), 'TODAY');
  assert.equal(eventCountdown(economic('2026-10-29', null), istNow), '1D AGO');
  assert.equal(eventCountdown(economic('2026-10-27', null), istNow), '3D AGO');
  assert.equal(eventCountdown(economic('2026-11-01', null), istNow), '2D 06H');
  assert.equal(eventCountdown(economic('2026-10-31', null), istNow), '1D 06H');
  assert.equal(eventCountdown(economic('not-a-date', null), istNow), '');
});

test('weekCount windows by the local day of now, not the UTC date', { skip: IST_SKIP }, () => {
  // 22:30 IST on October 30: the local window is Oct 30 .. Nov 5.
  const evening = new Date('2026-10-30T17:00:00Z');
  const events = [
    economic('2026-10-30', '2026-10-30T19:00:00Z'), // Local 00:30 Oct 31: in.
    economic('2026-10-28', '2026-10-28T18:00:00Z'), // Local Oct 28: out.
    economic('2026-11-05', '2026-11-05T19:00:00Z'), // Local Nov 6: out.
    economic('2026-11-05', null), // Last local day of the window: in.
    economic('2026-11-06', null), // Past the window: out.
    economic('2026-10-29', null), // Yesterday: out.
  ];
  assert.equal(weekCount(events, evening), 2);
});
test('weekCount rolls its window when now passes local midnight', { skip: IST_SKIP }, () => {
  const justPastMidnight = new Date('2026-10-30T18:30:01Z'); // Local Oct 31 00:00:01.
  const events = [
    economic('2026-10-30', null), // Now local yesterday: out.
    economic('2026-10-31', null), // Now local today: in.
    economic('2026-11-06', null), // Six days ahead: in.
    economic('2026-11-07', null), // Seven days ahead: out.
  ];
  assert.equal(weekCount(events, justPastMidnight), 2);
});