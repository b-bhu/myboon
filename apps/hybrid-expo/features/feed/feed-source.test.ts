import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchFeedItems, reportSourceName } from './feed.api';

test('report items keep a trimmed outlet and drop a blank, missing, or oversized source', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json([
    { updateKey: '1', title: 'A', summary: 'Summary', publishedAt: '2026-10-06T12:00:00Z', sourceName: '  CoinDesk  ' },
    { updateKey: '2', title: 'B', summary: 'Summary', publishedAt: '2026-10-06T11:00:00Z', sourceName: '   ' },
    { updateKey: '3', title: 'C', summary: 'Summary', publishedAt: '2026-10-06T10:00:00Z' },
    { updateKey: '4', title: 'D', summary: 'Summary', publishedAt: '2026-10-06T09:00:00Z', sourceName: 'A'.repeat(121) },
  ]);
  try {
    const items = await fetchFeedItems();
    assert.deepEqual(items.map((item) => item.sourceName), ['CoinDesk', null, null, null]);
    assert.equal(reportSourceName(null), null);
    assert.equal(reportSourceName(12), null);
  } finally {
    globalThis.fetch = original;
  }
});
