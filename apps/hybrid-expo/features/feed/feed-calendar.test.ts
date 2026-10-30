import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_REACTION_SAMPLE,
  countdown,
  countdownLower,
  eventFigures,
  eventMetaLabel,
  eventsByDay,
  eventReactionSample,
  isHighImpact,
  monthGrid,
  monthRange,
  nextBigEvent,
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

test('monthRange returns the full UTC month of the given day', () => {
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

test('eventsByDay groups by date with startsAt order and nulls last', () => {
  const timed = economic('2026-10-28', '2026-10-28T10:00:00Z', { title: 'Timed event' });
  const untitledA = economic('2026-10-28', null, { title: 'Alpha event' });
  const untitledB = economic('2026-10-28', null, { title: 'Beta event' });
  const broken = economic('2026-10-28', 'garbage', { title: 'Zulu event' });
  const other = earnings('2026-10-29', '2026-10-29T20:00:00Z');
  const days = eventsByDay([broken, untitledB, other, untitledA, timed]);
  assert.deepEqual(Object.keys(days).sort(), ['2026-10-28', '2026-10-29']);
  assert.deepEqual(
    days['2026-10-28'].map((event) => event.title),
    ['Timed event', 'Alpha event', 'Beta event', 'Zulu event'],
  );
  assert.equal(days['2026-10-29'][0], other);
});
test('eventsByDay never reorders the input list', () => {
  const first = economic('2026-10-28', '2026-10-28T14:00:00Z');
  const second = economic('2026-10-28', '2026-10-28T10:00:00Z');
  const input = [first, second];
  eventsByDay(input);
  assert.deepEqual(input, [first, second]);
});
test('eventsByDay on an empty list stays empty', () => {
  assert.deepEqual(eventsByDay([]), {});
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
test('nextBigEvent counts date-only events at the end of their UTC day', () => {
  const todayDateOnly = economic('2026-10-30', null, { timePrecision: 'date' });
  assert.equal(nextBigEvent([todayDateOnly], now), todayDateOnly);
  const yesterdayDateOnly = economic('2026-10-29', null, { timePrecision: 'date' });
  assert.equal(nextBigEvent([yesterdayDateOnly], now), null);
});
test('nextBigEvent skips events already in the past', () => {
  const past = economic('2026-10-30', '2026-10-30T09:00:00Z');
  assert.equal(nextBigEvent([past], now), null);
});
test('nextBigEvent treats an unusable startsAt as date precision', () => {
  const broken = economic('2026-10-30', 'garbage');
  assert.equal(nextBigEvent([broken], now), broken);
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
test('countdown clamps the present and the past to NOW', () => {
  assert.equal(countdown('2026-10-30T12:00:00Z', now), 'NOW');
  assert.equal(countdown('2026-10-30T11:59:59Z', now), 'NOW');
});
test('countdown rejects unusable targets', () => {
  assert.equal(countdown('not-a-date', now), '');
});

test('countdownLower speaks the countdown in lower case', () => {
  assert.equal(countdownLower('2026-11-01T19:00:00Z', now), 'in 2d 07h');
  assert.equal(countdownLower('2026-10-30T19:05:00Z', now), 'in 7h 05m');
  assert.equal(countdownLower('2026-10-30T12:00:00Z', now), 'now');
});
test('countdownLower rejects unusable targets', () => {
  assert.equal(countdownLower('not-a-date', now), '');
});

test('weekCount counts today through the following six days', () => {
  const events = [
    earnings('2026-10-29', null), // Too early.
    earnings('2026-10-30', null), // Today.
    economic('2026-11-01', null), // This week.
    earnings('2026-11-05', null), // Last day of the week.
    earnings('2026-11-06', null), // Tomorrow's week.
  ];
  assert.equal(weekCount(events, now), 3);
  assert.equal(weekCount([], now), 0);
});
test('weekCount sticks to the UTC date of now', () => {
  const lateTonight = new Date('2026-10-30T23:59:59Z');
  assert.equal(weekCount([earnings('2026-10-30', null)], lateTonight), 1);
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