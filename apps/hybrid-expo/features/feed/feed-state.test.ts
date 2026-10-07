import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarPeriod, selectedStorySlug, selectedToken, shiftCalendarDate, mergeReports } from './feed-state';
import { formatFeedUsd } from './feed-format';
import type { FeedItem, StorySummary } from './feed.types';

test('UTC calendar crosses leap days and year boundaries with Monday–Sunday weeks', () => {
  assert.deepEqual(calendarPeriod('2026-10-06', 'week'), { from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(calendarPeriod('2026-10-11', 'week'), { from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(calendarPeriod('2027-01-01', 'week'), { from: '2026-12-28', to: '2027-01-03' });
  assert.deepEqual(calendarPeriod('2024-02-29', 'day'), { from: '2024-02-29', to: '2024-02-29' });
  assert.equal(shiftCalendarDate('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftCalendarDate('2026-12-31', 1), '2027-01-01');
});
test('Story selection survives reordered data and falls back only when removed', () => {
  const rows = ['a', 'b', 'c'].map((storySlug) => ({ storySlug }) as StorySummary);
  assert.equal(selectedStorySlug([rows[2]!, rows[1]!, rows[0]!], 'b'), 'b');
  assert.equal(selectedStorySlug([rows[0]!, rows[2]!], 'b'), 'a');
  assert.equal(selectedStorySlug([], 'b'), null);
});
test('overlapping offset pages and a fresh head retain every report once in newest-first order', () => {
  const row = (id: number): FeedItem => ({ id: String(id), category: 'feed', createdAt: new Date(Date.UTC(2026, 9, 6, 0, id)).toISOString(), headline: `Report ${id}`, description: 'Published report', actions: [] });
  const older = Array.from({ length: 40 }, (_, index) => row(40 - index));
  const fresh = [row(42), row(41), ...older.slice(0, 18)];
  let visible = mergeReports(older, fresh);
  visible = mergeReports(visible, [row(22), row(21), ...Array.from({ length: 20 }, (_, index) => row(20 - index))]);
  assert.deepEqual(visible.map((item) => item.id), Array.from({ length: 42 }, (_, index) => String(42 - index)));
  assert.equal(visible.filter((item) => item.isTop).length, 1);
});
test('token data displays missing values honestly and compacts on Hermes without Intl notation', () => {
  assert.equal(formatFeedUsd(null), 'Unavailable');
  assert.equal(formatFeedUsd(NaN), 'Unavailable');
  assert.equal(formatFeedUsd(0, true), '$0.00');
  assert.equal(formatFeedUsd(70_800_000_000, true), '$70.8B');
  assert.equal(formatFeedUsd(0.00000012), '$1.200e-7');
});

test('a selected token disappearing from provider data cannot silently show another token', () => {
  const items = [{ identity: { key: 'sol' } }, { identity: { key: 'jup' } }];
  assert.equal(selectedToken(items, 'jup')?.identity.key, 'jup');
  assert.equal(selectedToken([items[0]!], 'jup'), undefined);
  assert.equal(selectedToken(items, null)?.identity.key, 'sol');
});

test('reports sharing a publication time keep the API id-descending tie order', () => {
  const row = (id: string): FeedItem => ({ id, createdAt: '2026-10-06T12:00:00Z', category: 'feed', headline: id, description: '', actions: [] });
  assert.deepEqual(mergeReports([row('bbbb'), row('1111')], [row('ffff'), row('bbbb')]).map((item) => item.id), ['ffff', 'bbbb', '1111']);
});
