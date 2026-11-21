import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  NOW_WINDOW_MS,
  calendarDateLabel,
  calendarHistoryRequest,
  countdown,
  countdownLower,
  eventCountdown,
  eventFigures,
  historyMoveCell,
  historyResultLabel,
  historyTableColumns,
  historyTableRows,
  eventLocalDate,
  eventLocalTime,
  eventMetaLabel,
  eventMetaLine,
  eventWhen,
  eventsByDay,
  isHighImpact,
  localDateKey,
  monthGrid,
  monthRange,
  nextBigEvent,
  releaseLocalDate,
  shiftDate,
  shiftMonth,
  weekCount,
} from './feed-calendar';
import { useCalendarHistory } from './use-calendar-history';
import type { CalendarEvent } from './calendar.types';
import type { CalendarHistoryMarket, CalendarHistoryRelease, CalendarHistoryResponse } from '@myboon/shared/calendar';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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
  entitySlug: null,
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
test('NOW_WINDOW_MS is the 15-minute NOW window', () => {
  assert.equal(NOW_WINDOW_MS, 15 * 60_000);
});
test('countdown says NOW during the first 15 minutes after the moment', () => {
  assert.equal(countdown('2026-10-30T12:00:00Z', now), 'NOW');
  assert.equal(countdown('2026-10-30T11:59:00Z', now), 'NOW');
  assert.equal(countdown('2026-10-30T11:45:01Z', now), 'NOW');
  // Minute fifteen flips to time-ago, floored.
  assert.equal(countdown('2026-10-30T11:45:00Z', now), '15M AGO');
});
test('countdown speaks time-ago in caps after the NOW window', () => {
  assert.equal(countdown('2026-10-30T11:40:00Z', now), '20M AGO');
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
  assert.equal(countdownLower('2026-10-30T11:45:01Z', now), 'now');
  assert.equal(countdownLower('2026-10-30T11:45:00Z', now), '15m ago');
  assert.equal(countdownLower('2026-10-30T11:40:00Z', now), '20m ago');
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
  assert.equal(eventCountdown(timed('2026-10-30T11:40:00Z'), now), '20M AGO');
  assert.equal(eventCountdown(timed('2026-10-27T12:00:00Z'), now), '3D AGO');
});

// The local-week window is expressed with the process zone's own getters so
// this subset also holds in any timezone, not just Asia/Calcutta.
const dayKeyNearNow = (offset: number): string => {
  const now = new Date();
  const shifted = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
};

// ISO startsAt for local `hour`:00 on now+offset days, so timed fixtures share
// the same local day as their dayKeyNearNow pair and never drift into the past.
const startsAtNearNow = (offset: number, hour = 9): string => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, 0, 0).toISOString();
};

test('weekCount counts only high-impact macro events inside the local week window', () => {
  const events = [
    economic(dayKeyNearNow(0), null), // Today: counts (High default).
    economic(dayKeyNearNow(3), startsAtNearNow(3)), // Timed mid-week: counts.
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

test('eventMetaLine joins the date, the time and the summary', () => {
  assert.equal(eventMetaLine('Thu 10 Dec', '00:30', 'Est 4.25%'), 'Thu 10 Dec · 00:30 · Est 4.25%');
});
test('eventMetaLine stops after the time when there is no summary', () => {
  assert.equal(eventMetaLine('Thu 10 Dec', '00:30', ''), 'Thu 10 Dec · 00:30');
});
test('eventMetaLine keeps the All day label for date-only events', () => {
  assert.equal(eventMetaLine('Thu 10 Dec', 'All day', 'Est 4.25%'), 'Thu 10 Dec · All day · Est 4.25%');
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

// ---------------------------------------------------------------------------
// Last 3 times · 24h move (#704): the event sheet's real history table.
// ---------------------------------------------------------------------------

const historyMarket = (symbol: string, displaySymbol: string, rank: 1 | 2 | 3): CalendarHistoryMarket =>
  ({ symbol, displaySymbol, displayName: displaySymbol, rank });

const historyRelease = (patch: Partial<CalendarHistoryRelease> = {}): CalendarHistoryRelease => ({
  date: '2026-11-12',
  startsAt: null,
  title: 'Inflation Rate YoY (Oct)',
  period: 'Oct',
  unit: null,
  actual: null,
  estimate: null,
  previous: null,
  moves: [],
  ...patch,
});

const historyResponse = (patch: { markets?: CalendarHistoryMarket[]; releases?: CalendarHistoryRelease[] } = {}): CalendarHistoryResponse =>
  ({ entity: { slug: 'us-cpi', name: 'US CPI' }, markets: patch.markets ?? [], releases: patch.releases ?? [] });

test('historyTableColumns are Date, Result and one per market', () => {
  assert.deepEqual(
    historyTableColumns(historyResponse({
      markets: [historyMarket('BTC', 'BTC', 1), historyMarket('SPX', 'SPX', 2), historyMarket('WTI', 'WTI', 3)],
    })),
    ['Date', 'Result', 'BTC', 'SPX', 'WTI'],
  );
  // Zero linked markets: the Date and Result columns only.
  assert.deepEqual(historyTableColumns(historyResponse()), ['Date', 'Result']);
});

test('historyTableRows formats the example row and skips no-data moves in the spoken line', () => {
  const response = historyResponse({
    markets: [historyMarket('BTC', 'BTC', 1), historyMarket('SPX', 'SPX', 2)],
    releases: [historyRelease({
      date: '2026-11-10', unit: '%', actual: 3.7, estimate: 3.6,
      moves: [{ symbol: 'BTC', changePct: 1.24 }, { symbol: 'SPX', changePct: -0.8 }],
    })],
  });
  const rows = historyTableRows(response);
  assert.ok(rows);
  assert.equal(rows.length, 1);
  assert.deepEqual({ date: rows[0].date, result: rows[0].result }, { date: '10 Nov', result: '3.7% vs 3.6%' });
  assert.deepEqual(
    rows[0].moves.map((move) => [move.symbol, move.displaySymbol, move.text, move.dir]),
    [
      ['BTC', 'BTC', '+1.24%', 'up'],
      ['SPX', 'SPX', '−0.80%', 'down'],
    ],
  );
  assert.equal(rows[0].spoken, '10 Nov, 3.7% versus 3.6%, BTC up 1.24%, SPX down 0.80%');
});

test('historyTableRows keeps the served order, one move cell per market, and needs releases', () => {
  const rows = historyTableRows(historyResponse({
    markets: [historyMarket('BTC', 'BTC', 1)],
    releases: [
      historyRelease({ date: '2026-11-12', title: 'Inflation Rate YoY (Nov)', unit: '%', actual: 3.1, moves: [{ symbol: 'BTC', changePct: 0 }] }),
      historyRelease({ date: '2026-10-13', title: 'Inflation Rate YoY (Sep)', unit: '%', actual: 3.0, estimate: 3.2, moves: [] }),
    ],
  }));
  assert.ok(rows);
  assert.deepEqual(rows.map((row) => row.key), ['2026-11-12-Inflation Rate YoY (Nov)', '2026-10-13-Inflation Rate YoY (Sep)']);
  // A finished window with no move speaks flat; a missing cell stays a dash.
  assert.equal(rows[0].spoken, '12 Nov, 3.1%, BTC 0.00%');
  assert.equal(rows[1].spoken, '13 Oct, 3% versus 3.2%');
  // Zero markets → Date and Result rows only, no move cells at all.
  const noMarkets = historyTableRows(historyResponse({ releases: [historyRelease({ date: '2026-11-10', unit: '%', actual: 3.7, estimate: 3.6 })] }));
  assert.deepEqual(noMarkets?.map((row) => [row.date, row.result, row.moves.length]), [['10 Nov', '3.7% vs 3.6%', 0]]);
  // No releases → no block at all.
  assert.equal(historyTableRows(historyResponse()), null);
});

test('historyTableRows falls back to the series unit when a release carries none', () => {
  assert.equal(historyTableRows(historyResponse({ releases: [historyRelease({ actual: 3.7, estimate: 3.6 })] }), '%')?.[0].result, '3.7% vs 3.6%');
  // With no unit anywhere the numbered values read bare.
  assert.equal(historyTableRows(historyResponse({ releases: [historyRelease({ actual: 3.7, estimate: 3.6 })] }))?.[0].result, '3.7 vs 3.6');
});

test('historyResultLabel reads actual vs estimate, the actual alone, or a dash', () => {
  assert.equal(historyResultLabel(3.7, 3.6, '%'), '3.7% vs 3.6%');
  assert.equal(historyResultLabel(3.7, null, '%'), '3.7%');
  // No actual means no reading, estimate or not.
  assert.equal(historyResultLabel(null, 3.6, '%'), '—');
});

test('historyMoveCell formats up, down, zero and missing moves with their meaning direction', () => {
  assert.deepEqual(historyMoveCell(1.24), { text: '+1.24%', dir: 'up' });
  assert.deepEqual(historyMoveCell(-0.8), { text: '−0.80%', dir: 'down' });
  assert.deepEqual(historyMoveCell(0), { text: '0.00%', dir: 'flat' });
  assert.deepEqual(historyMoveCell(null), { text: '—', dir: 'none' });
});

test("releaseLocalDate takes startsAt's local day and falls back to the release date", () => {
  // Date-only releases (and unusable starts) never shift; the date is the day.
  assert.equal(releaseLocalDate({ date: '2026-11-10', startsAt: null }), '2026-11-10');
  assert.equal(releaseLocalDate({ date: '2026-11-10', startsAt: 'garbage' }), '2026-11-10');
});

test('calendarDateLabel formats the sheet-style day label for the table rows', () => {
  assert.equal(calendarDateLabel('2026-11-10', { day: 'numeric', month: 'short' }), '10 Nov');
});

test('calendarHistoryRequest fetches only matched economic events, with before = the event date', () => {
  assert.deepEqual(
    calendarHistoryRequest(economic('2026-12-10', '2026-12-10T08:30:00Z', { entitySlug: 'us-cpi', title: 'Inflation Rate YoY (Nov)' })),
    { entity: 'us-cpi', before: '2026-12-10' },
  );
  // Unmatched economic events and earnings events never fetch.
  assert.equal(calendarHistoryRequest(economic('2026-12-10', '2026-12-10T08:30:00Z')), null);
  assert.equal(calendarHistoryRequest(earnings('2026-12-10', '2026-12-10T21:00:00Z')), null);
  // A closed sheet fetches nothing.
  assert.equal(calendarHistoryRequest(null), null);
});

test('the sample reaction table is gone from feed-calendar', async () => {
  const mod = (await import('./feed-calendar')) as unknown as Record<string, unknown>;
  assert.equal(mod.EVENT_REACTION_SAMPLE, undefined);
  assert.equal(mod.eventReactionSample, undefined);
  // Not even mentioned in the module: no mock-gated sample path back.
  const feedCalendarSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'feed-calendar.ts'), 'utf8');
  assert.ok(!feedCalendarSource.includes('EVENT_REACTION_SAMPLE'));
  assert.ok(!feedCalendarSource.includes('eventReactionSample'));
  assert.ok(!feedCalendarSource.includes('EventReactionRow'));
  assert.ok(!feedCalendarSource.includes('feed-mocks'));
});

// Hook-level visibility (#704). One fetch stub per test; settle() drains the
// resolve → state microtasks, the feed-data.test.tsx way.
const settle = async () => {
  for (let hop = 0; hop < 20; hop += 1) await Promise.resolve();
};

const cpiOn = (date: string): CalendarEvent =>
  economic(date, `${date}T13:30:00Z`, { entitySlug: 'us-cpi', title: 'Inflation Rate YoY (Nov)' });

// A plain object holds the hook's latest state across renders (feed-data.test.tsx style).
function makeHarness(): { state: { history: ReturnType<typeof useCalendarHistory> | null }, Harness: (props: { event: CalendarEvent | null }) => null } {
  const state: { history: ReturnType<typeof useCalendarHistory> | null } = { history: null };
  function Harness({ event }: { event: CalendarEvent | null }) {
    state.history = useCalendarHistory(event);
    return null;
  }
  return { state, Harness };
}

test('useCalendarHistory never fetches for earnings, unmatched events or a closed sheet', async () => {
  const original = globalThis.fetch;
  const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://feed-api.example.test';
  let calls = 0;
  const urls: string[] = [];
  globalThis.fetch = (input) => {
    calls += 1;
    urls.push(String(input));
    return Promise.resolve(Response.json(historyResponse({ releases: [historyRelease()] })));
  };
  const { state, Harness } = makeHarness();
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(Harness, { event: earnings('2026-11-10', '2026-11-10T21:00:00Z') })); await settle(); });
    assert.equal(calls, 0);
    assert.equal(state.history, null);
    // An unmatched economic event (entitySlug null) never fetches either.
    await act(async () => { renderer.update(createElement(Harness, { event: economic('2026-11-10', '2026-11-10T13:30:00Z') })); await settle(); });
    assert.equal(calls, 0);
    assert.equal(state.history, null);
    // A matched economic event fetches once with the event's date as before.
    await act(async () => { renderer.update(createElement(Harness, { event: cpiOn('2026-11-10') })); await settle(); });
    assert.equal(calls, 1);
    assert.equal(urls[0], 'https://feed-api.example.test/calendar/history?entity=us-cpi&before=2026-11-10');
    assert.deepEqual(state.history, historyResponse({ releases: [historyRelease()] }));
    // Closing the sheet clears the table data and fetches nothing more.
    await act(async () => { renderer.update(createElement(Harness, { event: null })); await settle(); });
    assert.equal(calls, 1);
    assert.equal(state.history, null);
  } finally {
    if (renderer) await act(async () => { await renderer.unmount(); });
    globalThis.fetch = original;
    if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
    else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
  }
});

test('useCalendarHistory shows nothing for zero releases or a failed fetch and never retries one', async () => {
  const original = globalThis.fetch;
  let mode: 'empty' | 'fail' | 'ok' = 'empty';
  let calls = 0;
  const okResponse = historyResponse({ releases: [historyRelease({ title: 'Inflation Rate YoY (Nov)' })] });
  globalThis.fetch = () => {
    calls += 1;
    if (mode === 'empty') return Promise.resolve(Response.json(historyResponse()));
    if (mode === 'fail') return Promise.reject(new Error('down'));
    return Promise.resolve(Response.json(okResponse));
  };
  const { state, Harness } = makeHarness();
  let renderer!: ReactTestRenderer;
  try {
    // Zero releases arrive as a valid response; the table block needs rows.
    await act(async () => { renderer = create(createElement(Harness, { event: cpiOn('2026-11-10') })); await settle(); });
    assert.equal(calls, 1);
    assert.deepEqual(state.history, historyResponse());
    assert.deepEqual(historyTableRows(historyResponse()), null); // → the sheet renders no block
    // A failed fetch on the next event reads as nothing, with no silent retry.
    mode = 'fail';
    await act(async () => { renderer.update(createElement(Harness, { event: cpiOn('2026-11-11') })); await settle(); });
    assert.equal(calls, 2);
    assert.equal(state.history, null);
    await act(async () => { await settle(); });
    assert.equal(calls, 2);
    // Only opening a different event fetches again (no retry for the same one).
    mode = 'ok';
    await act(async () => { renderer.update(createElement(Harness, { event: cpiOn('2026-11-12') })); await settle(); });
    assert.equal(calls, 3);
    assert.ok(state.history);
    assert.deepEqual(state.history, okResponse);
  } finally {
    if (renderer) await act(async () => { await renderer.unmount(); });
    globalThis.fetch = original;
  }
});

test('useCalendarHistory aborts on event change and close, and stale answers never land', async () => {
  const original = globalThis.fetch;
  const pending = new Map<string, { signal: AbortSignal | null; resolve: (response: Response) => void }>();
  const urls: string[] = [];
  globalThis.fetch = (input, options) => {
    const url = new URL(String(input));
    urls.push(`${url.pathname}${url.search}`);
    return new Promise<Response>((resolve) => {
      pending.set(url.searchParams.get('before') ?? '', { signal: (options?.signal as AbortSignal | undefined) ?? null, resolve });
    });
  };
  const { state, Harness } = makeHarness();
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(Harness, { event: cpiOn('2026-11-10') })); });
    assert.equal(urls[0], '/calendar/history?entity=us-cpi&before=2026-11-10');
    const first = pending.get('2026-11-10')!;
    // Switching events aborts the older request and opens the new one.
    await act(async () => { renderer.update(createElement(Harness, { event: cpiOn('2026-11-12') })); });
    assert.equal(first.signal?.aborted, true);
    const second = pending.get('2026-11-12')!;
    // The old event's answer landing late must never replace the new one's.
    await act(async () => { first.resolve(Response.json(historyResponse({ releases: [historyRelease({ title: 'Inflation Rate YoY (Oct)' })] }))); await settle(); });
    assert.equal(state.history, null);
    await act(async () => { second.resolve(Response.json(historyResponse({ releases: [historyRelease({ title: 'Inflation Rate YoY (Nov)' })] }))); await settle(); });
    // (The cast resets the control-flow narrowing left by the null assertion above.)
    const landed = state.history as ReturnType<typeof useCalendarHistory> | null;
    assert.ok(landed);
    assert.equal(landed.releases[0].title, 'Inflation Rate YoY (Nov)');
    // Closing aborts an in-flight request too, and a late answer after the
    // close cannot land.
    await act(async () => { renderer.update(createElement(Harness, { event: cpiOn('2026-11-14') })); });
    const third = pending.get('2026-11-14')!;
    await act(async () => { renderer.update(createElement(Harness, { event: null })); await settle(); });
    assert.equal(third.signal?.aborted, true);
    assert.equal(state.history, null);
    await act(async () => { third.resolve(Response.json(historyResponse({ releases: [historyRelease()] }))); await settle(); });
    assert.equal(state.history, null);
  } finally {
    if (renderer) await act(async () => { await renderer.unmount(); });
    globalThis.fetch = original;
  }
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

test('releaseLocalDate shifts releases across local midnight the same way', { skip: IST_SKIP }, () => {
  assert.equal(releaseLocalDate({ date: '2026-10-28', startsAt: '2026-10-28T18:00:00Z' }), '2026-10-28'); // 23:30.
  assert.equal(releaseLocalDate({ date: '2026-10-28', startsAt: '2026-10-28T19:00:00Z' }), '2026-10-29'); // 00:30 next day.
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
  assert.equal(eventWhen(timed('2026-10-30T11:50:00Z'), istNow), 'now');
  assert.equal(eventWhen(timed('2026-10-30T11:45:00Z'), istNow), '15m ago');
  assert.equal(eventWhen(timed('2026-10-30T11:40:00Z'), istNow), '20m ago');
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