import assert from 'node:assert/strict';
import test from 'node:test';
import {
  feedBandHeights,
  formatSignedPercent,
  isOfflineMessage,
  mosaicPages,
  placeMosaicTiles,
  rankStories,
  topicMarket,
} from './feed-mosaic';
import type { StorySummary } from './feed.types';

const story = (slug: string, eventCount: number, name = slug): StorySummary => ({
  storySlug: slug,
  name,
  latestDevelopment: 'Latest',
  eventCount,
  updatedAt: '2026-10-26T07:02:09.000Z',
  imageUrl: null,
  imageKind: null,
  imageAttribution: null,
});

test('rankStories orders by event count, then recency, then slug', () => {
  const ranked = rankStories([
    story('small', 2),
    { ...story('older', 9), updatedAt: '2026-10-01T00:00:00.000Z' },
    { ...story('newer', 9), updatedAt: '2026-10-20T00:00:00.000Z' },
    story('big', 40),
  ]);
  assert.deepEqual(ranked.map((item) => item.storySlug), ['big', 'newer', 'older', 'small']);
});

test('mosaic pages place every story and open a second page after ten', () => {
  assert.equal(mosaicPages([]).length, 0);
  for (let count = 1; count <= 10; count += 1) {
    const placed = placeMosaicTiles(count);
    assert.equal(placed.length, count, `count ${count}`);
    assert.equal(new Set(placed.map((tile) => `${tile.col},${tile.row},${tile.colSpan},${tile.rowSpan}`)).size, count);
  }
  const pages = mosaicPages(Array.from({ length: 11 }, (_, index) => index));
  assert.equal(pages.length, 2);
  assert.equal(pages[0]?.items.length, 10);
  assert.equal(pages[1]?.items.length, 1);
  assert.equal(pages[1]?.placements[0]?.kind, 'large');
});

test('topicMarket matches real story fields and stays quiet otherwise', () => {
  assert.equal(topicMarket('bitcoin', 'Bitcoin')?.symbol, 'BTC-PERP');
  assert.equal(topicMarket('bitcoin', 'Bitcoin')?.action, 'Trade BTC perps');
  assert.equal(topicMarket('us-iran-conflict', 'U.S.–Iran Conflict')?.symbol, 'WTIOIL-PERP');
  assert.equal(topicMarket('sol-etf', 'SOL ETF')?.symbol, 'SOL-PERP');
  assert.equal(topicMarket('methodology', 'A method note'), null);
  assert.equal(topicMarket('weather', 'Weekend weather'), null);
});

test('feed bands keep the 25/40 split when the column can hold them', () => {
  assert.deepEqual(feedBandHeights(844, 700), { today: 211, mosaic: 338 });
  const tight = feedBandHeights(844, 500);
  assert.ok(tight.today < 211);
  assert.ok(tight.mosaic < 338);
  assert.ok(tight.today + tight.mosaic <= 500 - 16 - 96);
});

test('offline copy and percents', () => {
  assert.equal(isOfflineMessage('Failed to fetch'), true);
  assert.equal(isOfflineMessage('Stories request failed (500)'), false);
  assert.equal(formatSignedPercent(2.4), '+2.40%');
  assert.equal(formatSignedPercent(-1.2), '-1.20%');
});
