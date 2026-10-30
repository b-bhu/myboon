import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEWS_SHEET_RATIO,
  dayLabel,
  groupUpdatesByDay,
  newsSheetHeight,
  shouldDismissSheet,
  updateAge,
  updateMeta,
} from './feed-updates';
import type { FeedItem } from './feed.types';

// Fixed local wall-clock fixtures so the tests never depend on the host timezone.
const now = new Date(2026, 9, 30, 12, 0); // Fri 30 Oct 2026, local noon

const item = (id: number, y: number, mon: number, d: number, h = 12, min = 0, category = 'feed'): FeedItem => ({
  id: String(id),
  category,
  createdAt: new Date(y, mon - 1, d, h, min).toISOString(),
  headline: `Report ${id}`,
  description: 'Summary',
  actions: [],
});

test('newsSheetHeight is 90% of the screen height, rounded', () => {
  assert.equal(NEWS_SHEET_RATIO, 0.9);
  assert.equal(newsSheetHeight(844), 760);
  assert.equal(newsSheetHeight(915), 824); // 915 * 0.9 = 823.5 rounds to 824
  assert.equal(newsSheetHeight(1000), 900);
});

test('shouldDismissSheet opens past a quarter of the sheet height', () => {
  const height = 760; // quarter = 190
  assert.equal(shouldDismissSheet(190, 0, height), false);
  assert.equal(shouldDismissSheet(190, -3, height), false);
  assert.equal(shouldDismissSheet(191, 0, height), true);
  assert.equal(shouldDismissSheet(195, -3, height), true);
  assert.equal(shouldDismissSheet(760, 0, height), true);
});

test('shouldDismissSheet needs both a real drag past 24 and a downward flick', () => {
  const height = 760;
  assert.equal(shouldDismissSheet(24, 0.8, height), false);
  assert.equal(shouldDismissSheet(24, 2, height), false);
  assert.equal(shouldDismissSheet(24.1, 0.5, height), false);
  assert.equal(shouldDismissSheet(24.1, 0.81, height), true);
  assert.equal(shouldDismissSheet(120, 0.9, height), true);
});

test('shouldDismissSheet never dismisses at or below the dragged top', () => {
  const height = 760;
  assert.equal(shouldDismissSheet(0, 10, height), false);
  assert.equal(shouldDismissSheet(-50, 10, height), false);
});

test('dayLabel names calendar days Today and Yesterday across midnight', () => {
  assert.equal(dayLabel(new Date(2026, 9, 30, 8, 5).toISOString(), now), 'Today');
  assert.equal(dayLabel(new Date(2026, 9, 30, 0, 0).toISOString(), now), 'Today');
  assert.equal(dayLabel(new Date(2026, 9, 29, 23, 59).toISOString(), now), 'Yesterday');
  const justAfterMidnight = new Date(2026, 9, 30, 0, 30);
  assert.equal(dayLabel(new Date(2026, 9, 29, 23, 45).toISOString(), justAfterMidnight), 'Yesterday');
  assert.equal(dayLabel(new Date(2026, 9, 30, 0, 0).toISOString(), justAfterMidnight), 'Today');
});

test('dayLabel falls back to the mock weekday date month line', () => {
  assert.equal(dayLabel(new Date(2026, 9, 26, 12, 0).toISOString(), now), 'Mon 26 Oct');
  assert.equal(dayLabel(new Date(2026, 9, 6, 9, 0).toISOString(), now), 'Tue 6 Oct');
});

test('dayLabel rejects unusable timestamps', () => {
  assert.equal(dayLabel('not-a-date', now), '');
  assert.equal(dayLabel('', now), '');
});

test('updateAge formats minutes and hours on the same calendar day', () => {
  assert.equal(updateAge(new Date(2026, 9, 30, 11, 59, 30).toISOString(), now), 'NOW');
  assert.equal(updateAge(new Date(2026, 9, 30, 11, 59).toISOString(), now), '1M');
  assert.equal(updateAge(new Date(2026, 9, 30, 11, 55).toISOString(), now), '5M');
  assert.equal(updateAge(new Date(2026, 9, 30, 10, 0).toISOString(), now), '2H');
  assert.equal(updateAge(new Date(2026, 9, 30, 0, 30).toISOString(), now), '11H');
});

test('updateAge prefers hours for anything under 24h even across midnight', () => {
  assert.equal(updateAge(new Date(2026, 9, 29, 23, 0).toISOString(), now), '13H');
  assert.equal(updateAge(new Date(2026, 9, 29, 13, 1).toISOString(), now), '22H');
});

test('updateAge marks yesterday older than 24h', () => {
  assert.equal(updateAge(new Date(2026, 9, 29, 12, 0).toISOString(), now), 'YDA'); // exactly 24h
  assert.equal(updateAge(new Date(2026, 9, 29, 10, 0).toISOString(), now), 'YDA');
});

test('updateAge falls back to the upper-case date for older updates', () => {
  assert.equal(updateAge(new Date(2026, 9, 26, 8, 0).toISOString(), now), '26 OCT');
  assert.equal(updateAge(new Date(2026, 9, 6, 9, 0).toISOString(), now), '6 OCT');
});

test('updateAge rejects unusable timestamps', () => {
  assert.equal(updateAge('not-a-date', now), '');
});

test('updateMeta joins the age with the upper-cased category', () => {
  assert.equal(updateMeta(item(1, 2026, 10, 30, 10, 0), now), '2H · LATEST');
  assert.equal(updateMeta(item(2, 2026, 10, 30, 11, 55), now), '5M · LATEST');
  assert.equal(updateMeta({ ...item(3, 2026, 10, 30, 10), category: 'macro' }, now), '2H · MACRO');
  assert.equal(updateMeta({ ...item(4, 2026, 10, 30, 10), category: 'deFi' }, now), '2H · DEFI');
  assert.equal(updateMeta({ ...item(5, 2026, 10, 30, 10), category: '' }, now), '2H · LATEST');
});

test('updateMeta omits the age part when the timestamp is unusable', () => {
  assert.equal(updateMeta({ ...item(6, 2026, 10, 30, 10), createdAt: 'garbage' }, now), 'LATEST');
  assert.equal(updateMeta({ ...item(7, 2026, 10, 30, 10), createdAt: 'garbage', category: 'macro' }, now), 'MACRO');
});

test('groupUpdatesByDay keeps item order and inserts one header per calendar day', () => {
  const rows = groupUpdatesByDay(
    [item(1, 2026, 10, 30, 10), item(2, 2026, 10, 30, 8), item(3, 2026, 10, 29, 20), item(4, 2026, 10, 26, 9)],
    now,
  );
  assert.deepEqual(rows, [
    { kind: 'day', key: 'day-2026-10-30', label: 'Today' },
    { kind: 'item', key: '1', item: item(1, 2026, 10, 30, 10) },
    { kind: 'item', key: '2', item: item(2, 2026, 10, 30, 8) },
    { kind: 'day', key: 'day-2026-10-29', label: 'Yesterday' },
    { kind: 'item', key: '3', item: item(3, 2026, 10, 29, 20) },
    { kind: 'day', key: 'day-2026-10-26', label: 'Mon 26 Oct' },
    { kind: 'item', key: '4', item: item(4, 2026, 10, 26, 9) },
  ]);
});

test('groupUpdatesByDay returns no rows without updates', () => {
  assert.deepEqual(groupUpdatesByDay([], now), []);
});

test('groupUpdatesByDay crosses midnight: late-night rows group under their own day', () => {
  const justAfterMidnight = new Date(2026, 9, 30, 0, 30);
  const rows = groupUpdatesByDay(
    [item(1, 2026, 10, 30, 0, 0), item(2, 2026, 10, 29, 23, 45)],
    justAfterMidnight,
  );
  assert.deepEqual(
    rows.map((row) => (row.kind === 'day' ? row.label : row.item.id)),
    ['Today', '1', 'Yesterday', '2'],
  );
});

test('groupUpdatesByDay groups unusable timestamps under Earlier where they appear', () => {
  const rows = groupUpdatesByDay(
    [item(1, 2026, 10, 30, 10), { ...item(2, 2026, 10, 29), createdAt: 'garbage' }, item(3, 2026, 10, 29, 20)],
    now,
  );
  assert.deepEqual(rows, [
    { kind: 'day', key: 'day-2026-10-30', label: 'Today' },
    { kind: 'item', key: '1', item: item(1, 2026, 10, 30, 10) },
    { kind: 'day', key: 'day-unknown', label: 'Earlier' },
    { kind: 'item', key: '2', item: { ...item(2, 2026, 10, 29), createdAt: 'garbage' } },
    { kind: 'day', key: 'day-2026-10-29', label: 'Yesterday' },
    { kind: 'item', key: '3', item: item(3, 2026, 10, 29, 20) },
  ]);
});