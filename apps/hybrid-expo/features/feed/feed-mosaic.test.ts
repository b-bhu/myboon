import assert from 'node:assert/strict';
import test from 'node:test';
import {
  feedBandHeights,
  formatSignedPercent,
  isOfflineMessage,
  mosaicPages,
  placeMosaicTiles,
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

function emptyCells(placed: ReturnType<typeof placeMosaicTiles>): number {
  const grid = Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => false));
  for (const tile of placed) {
    for (let y = 0; y < tile.rowSpan; y += 1) {
      for (let x = 0; x < tile.colSpan; x += 1) {
        const row = grid[tile.row + y];
        if (!row || row[tile.col + x]) throw new Error(`overlap at ${tile.col + x},${tile.row + y}`);
        row[tile.col + x] = true;
      }
    }
  }
  return grid.flat().filter((filled) => !filled).length;
}

test('mosaic pages fill the grid for 1–10 stories and keep a short last page small', () => {
  assert.equal(mosaicPages([]).length, 0);
  for (let count = 1; count <= 10; count += 1) {
    const placed = placeMosaicTiles(count);
    assert.equal(placed.length, count, `count ${count}`);
    assert.equal(emptyCells(placed), 0, `empty cells for ${count}`);
  }
  const pages = mosaicPages(Array.from({ length: 11 }, (_, index) => index));
  assert.equal(pages.length, 2);
  assert.equal(pages[0]?.items.length, 10);
  assert.equal(pages[1]?.items.length, 1);
  assert.equal(pages[1]?.placements[0]?.colSpan, 3);
  assert.equal(pages[1]?.placements[0]?.rowSpan, 2);
  const dozen = mosaicPages(Array.from({ length: 12 }, (_, index) => index));
  assert.equal(dozen[1]?.items.length, 2);
  assert.equal(emptyCells(dozen[1]?.placements ?? []), 0);
});

test('mosaicPages keeps API order and pages twelve stories as ten then two', () => {
  const quietFirst = [story('quiet-new', 1), story('loud-old', 99)];
  assert.deepEqual(
    mosaicPages(quietFirst)[0]?.items.map((item) => item.storySlug),
    ['quiet-new', 'loud-old'],
  );

  const dozen = Array.from({ length: 12 }, (_, index) => story(`topic-${index}`, 12 - index));
  const pages = mosaicPages(dozen);
  assert.equal(pages.length, 2);
  assert.equal(pages[0]?.items.length, 10);
  assert.equal(pages[0]?.placements.length, 10);
  assert.equal(pages[0]?.placements[0]?.kind, 'large');
  assert.equal(pages[0]?.placements[0]?.index, 0);
  assert.equal(pages[1]?.items.length, 2);
  assert.equal(pages[1]?.placements.length, 2);
  assert.deepEqual(
    pages.flatMap((page) => page.items.map((item) => item.storySlug)),
    dozen.map((item) => item.storySlug),
  );
  assert.equal(emptyCells(pages[1]?.placements ?? []), 0);
});

test('topicMarket matches exact slugs and ignores words in the name', () => {
  assert.equal(topicMarket('bitcoin', 'Bitcoin')?.symbol, 'BTC-PERP');
  assert.equal(topicMarket('bitcoin', 'Bitcoin')?.action, 'Trade BTC perps');
  assert.equal(topicMarket('us-iran-conflict', 'U.S.–Iran Conflict')?.symbol, 'WTIOIL-PERP');
  assert.equal(topicMarket('us-iran-conflict', 'U.S.–Iran Conflict')?.assetName, 'WTI crude');
  assert.equal(topicMarket('sol-etf', 'SOL ETF'), null);
  assert.equal(topicMarket('spy-ring', 'Russian Spy Ring'), null);
  assert.equal(topicMarket('pound-note', 'Pound of flesh'), null);
  assert.equal(topicMarket('iran-nuclear', 'Iran nuclear talks'), null);
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
