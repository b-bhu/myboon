import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoryMarket } from '@myboon/shared/stories';
import {
  formatSignedPercent,
  formatTileMove,
  heldMarket,
  isOfflineMessage,
  mosaicPages,
  pageSparkSymbols,
  pickDetailMarket,
  pricedMarkets,
  rankStories,
  shownMarket,
  tileShowsArrow,
  topicMarket,
} from './feed-mosaic';
import type { StorySummary } from './feed.types';

const story = (
  slug: string,
  eventCount: number,
  overrides: Partial<StorySummary> = {},
): StorySummary => ({
  storySlug: slug,
  name: slug,
  latestDevelopment: 'Latest',
  eventCount,
  updatedAt: '2026-10-26T07:02:09.000Z',
  imageUrl: null,
  imageKind: null,
  imageAttribution: null,
  markets: [],
  ...overrides,
});

const market = (
  rank: 1 | 2 | 3,
  symbol: string,
  change24hPct: number | null,
  price: number | null = 12.5,
): StoryMarket => ({
  symbol,
  displaySymbol: symbol.split(':')[1] ?? symbol,
  displayName: `Name of ${symbol}`,
  rank,
  price,
  change24hPct: price === null ? null : change24hPct,
  asOf: price === null ? null : '2026-10-26T07:00:00.000Z',
});

function emptyCells(placed: { col: number; row: number; colSpan: number; rowSpan: number }[]): number {
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

test('rankStories puts the busiest first, ties on the newer update, full ties on slug', () => {
  const stamp = '2026-10-26T07:02:09.000Z';
  const input = [
    story('z-tie', 4, { updatedAt: stamp }),
    story('b-tie', 4, { updatedAt: stamp }),
    // Activity outranks recency; the two 9s sort newest first.
    story('stale-nine', 9, { updatedAt: '2026-10-25T07:02:09.000Z' }),
    story('fresh-nine', 9, { updatedAt: '2026-10-26T07:02:09.000Z' }),
    story('quiet', 2, { updatedAt: stamp }),
  ];
  const ranked = rankStories(input);
  assert.deepEqual(ranked.map((item) => item.storySlug), ['fresh-nine', 'stale-nine', 'b-tie', 'z-tie', 'quiet']);
  // The input list is never reordered in place.
  assert.deepEqual(input.map((item) => item.storySlug), ['z-tie', 'b-tie', 'stale-nine', 'fresh-nine', 'quiet']);
});

test('one story fills only the large slot, two fill large and tall', () => {
  assert.deepEqual(mosaicPages([story('only', 1)])[0]?.placements, [
    { index: 0, kind: 'large', col: 0, row: 0, colSpan: 3, rowSpan: 2 },
  ]);
  const pair = mosaicPages([story('a', 2), story('b', 1)]);
  assert.deepEqual(pair[0]?.placements.map((placement) => placement.kind), ['large', 'tall']);
});

test('a full page holds all ten slots in the mock layout with no overlap', () => {
  const ten = mosaicPages(Array.from({ length: 10 }, (_, index) => story(`s${index}`, 10 - index)));
  assert.deepEqual(
    ten[0]?.placements.map((placement) => [placement.index, placement.kind, placement.col, placement.row, placement.colSpan, placement.rowSpan]),
    [
      [0, 'large', 0, 0, 3, 2],
      [1, 'tall', 3, 0, 2, 2],
      [2, 'wide', 0, 2, 2, 1],
      [3, 'wide', 2, 2, 2, 1],
      [4, 'wide', 4, 2, 2, 1],
      [5, 'wide', 0, 3, 2, 1],
      [6, 'wide', 2, 3, 2, 1],
      [7, 'wide', 4, 3, 2, 1],
      [8, 'slim', 5, 0, 1, 1],
      [9, 'slim', 5, 1, 1, 1],
    ],
  );
  assert.equal(emptyCells(ten[0]?.placements ?? []), 0);
  // Slot n carries the page's n-th busiest story.
  assert.deepEqual(ten[0]?.items.map((item) => item.storySlug), Array.from({ length: 10 }, (_, index) => `s${index}`));
});

test('pages split by ten with fixed tiles: one leftover large, three keep the first slots', () => {
  const eleven = mosaicPages(Array.from({ length: 11 }, (_, index) => story(`s${index}`, 11 - index)));
  assert.equal(eleven.length, 2);
  assert.equal(eleven[0]?.items.length, 10);
  assert.equal(eleven[1]?.items.length, 1);
  assert.deepEqual(eleven[1]?.placements, [
    { index: 0, kind: 'large', col: 0, row: 0, colSpan: 3, rowSpan: 2 },
  ]);

  const pages = mosaicPages(Array.from({ length: 23 }, (_, index) => story(`s${index}`, 23 - index)));
  assert.deepEqual(pages.map((page) => page.items.length), [10, 10, 3]);
  const last = pages[2]?.placements.map((placement) => placement.kind);
  assert.deepEqual(last, ['large', 'tall', 'wide']);
  assert.equal(pages[2]?.placements[0]?.colSpan, 3);
  assert.equal(pages[2]?.placements[0]?.rowSpan, 2);
  assert.equal(emptyCells(pages[2]?.placements ?? []), 24 - (6 + 4 + 2));
});

test('the busiest story on every page takes the large slot', () => {
  // API order is loud-quiet-loud: ranking must flip it.
  const ranked = mosaicPages([
    story('quiet', 1),
    story('loud', 99),
    story('middle', 50),
  ]);
  assert.deepEqual(ranked[0]?.items.map((item) => item.storySlug), ['loud', 'middle', 'quiet']);
  assert.equal(ranked[0]?.placements[0]?.kind, 'large');

  const spread = mosaicPages(Array.from({ length: 23 }, (_, index) => story(`s${index}`, 30 - index)));
  assert.ok(spread.every((page) => page.items[0]?.eventCount === Math.max(...page.items.map((item) => item.eventCount))));
  assert.ok(spread.every((page) => page.placements[0]?.kind === 'large'));
});

test('pricedMarkets keeps priced markets in rank order and skips stale ones', () => {
  const priced = pricedMarkets(story('a', 3, {
    markets: [
      market(3, 'SOL', -0.9),
      market(1, 'BTC', 2.8),
      // An unpriced rank 2 (stale snapshot) never reaches the cycle.
      market(2, 'STALE', 5, null),
      market(2, 'ETH', 0.5),
    ],
  }));
  assert.deepEqual(priced.map((item) => item.symbol), ['BTC', 'ETH', 'SOL']);
  assert.deepEqual(pricedMarkets(story('b', 1, { markets: [market(1, 'STALE', null, null)] })), []);
});

test('shownMarket cycles priced markets by tick and parks on rank 1 for reduce motion', () => {
  const three = story('a', 3, { markets: [market(1, 'BTC', 2.8), market(2, 'ETH', 0.5), market(3, 'SOL', -0.9)] });
  assert.deepEqual(
    [0, 1, 2, 3].map((tick) => shownMarket(three, tick, false)?.symbol),
    ['BTC', 'ETH', 'SOL', 'BTC'],
  );
  assert.equal(shownMarket(three, 41, true)?.symbol, 'BTC');

  // A stale rank 2 never shows; the cycle runs over the remaining two.
  const stale = story('b', 3, { markets: [market(1, 'BTC', 2.8), market(2, 'STALE', null), market(3, 'SOL', -0.9)] });
  assert.deepEqual(
    [0, 1, 2].map((tick) => shownMarket(stale, tick, false)?.symbol),
    ['BTC', 'SOL', 'BTC'],
  );
  assert.equal(shownMarket(stale, 7, true)?.symbol, 'BTC');

  assert.equal(shownMarket(story('c', 1, { markets: [market(1, 'STALE', null, null)] }), 0, false), null);
  assert.equal(shownMarket(story('d', 1), 0, false), null);
});

test('heldMarket holds the previous sparkline until the next market has candles (#798)', () => {
  const three = story('a', 3, { markets: [market(1, 'BTC', 2.8), market(2, 'ETH', 0.5), market(3, 'SOL', -0.9)] });
  // All candles ready: the display follows the rotation exactly.
  const all = new Set(['BTC', 'ETH', 'SOL']);
  assert.deepEqual(
    [0, 1, 2, 3].map((tick) => heldMarket(three, tick, false, (symbol) => all.has(symbol))?.symbol),
    ['BTC', 'ETH', 'SOL', 'BTC'],
  );
  // Rotation wants ETH next while only BTC has candles: the tile holds BTC
  // instead of fading in a bare slot, then advances once ETH lands.
  assert.equal(heldMarket(three, 1, false, (symbol) => symbol === 'BTC')?.symbol, 'BTC');
  assert.equal(heldMarket(three, 2, false, (symbol) => symbol === 'BTC')?.symbol, 'BTC');
  // A fetched-but-unusable answer still counts as ready: the fetched slot
  // shows and stays, it can never loop the hold waiting on dead candles.
  assert.equal(heldMarket(three, 1, false, (symbol) => symbol === 'ETH')?.symbol, 'ETH');
  // Nothing ready anywhere in the tile's cycle: no slot at all, nothing flickers.
  assert.equal(heldMarket(three, 2, false, () => false), null);
  // Reduce motion never rotates, so the first market holds regardless.
  assert.equal(heldMarket(three, 9, true, () => false)?.symbol, 'BTC');
  assert.equal(heldMarket(three, 9, true, () => true)?.symbol, 'BTC');
  // No priced market: nothing shows, with or without candles.
  assert.equal(heldMarket(story('e', 1), 0, false, () => true), null);
});

test('pageSparkSymbols lists every priced lead-tile market of one page (#798)', () => {
  const lead = story('btc', 9, { markets: [market(1, 'BTC', 2.8), market(2, 'ETH', 0.5)] });
  const second = story('oil', 4, { markets: [market(1, 'WTIOIL', -0.9), market(2, 'STALE', null, null)] });
  const pages = mosaicPages([story('quiet', 1), second, lead]);
  // Page 1: ranks 1-2 are the large and tall tiles; only those tiles' markets
  // load, and a symbol appears once however many tiles share it.
  assert.deepEqual(pageSparkSymbols(pages, 0), ['BTC', 'ETH', 'WTIOIL']);
  assert.deepEqual(pageSparkSymbols(pages, 5), []);
  assert.deepEqual(pageSparkSymbols([], 0), []);
});

test('formatTileMove colours one-decimal moves and dims a 0.0 move', () => {
  assert.deepEqual(formatTileMove(2.84), { text: '+2.8%', tone: 'up' });
  assert.deepEqual(formatTileMove(-0.61), { text: '-0.6%', tone: 'down' });
  assert.deepEqual(formatTileMove(0.04), { text: '0.0%', tone: 'dim' });
  assert.deepEqual(formatTileMove(-0.04), { text: '0.0%', tone: 'dim' });
});

test('tileShowsArrow gives the corner arrow to lead and wide tiles, never slim (#711)', () => {
  const up = formatTileMove(2.84);
  const down = formatTileMove(-0.61);
  const dim = formatTileMove(0.04);
  // Slim tiles: the colour and sign carry the direction alone.
  assert.equal(tileShowsArrow(up, 'slim'), false);
  assert.equal(tileShowsArrow(down, 'slim'), false);
  assert.equal(tileShowsArrow(dim, 'slim'), false);
  // Lead and wide tiles keep the corner arrow for a priced move.
  assert.equal(tileShowsArrow(up, 'large'), true);
  assert.equal(tileShowsArrow(down, 'tall'), true);
  assert.equal(tileShowsArrow(up, 'wide'), true);
  // A dim move shows no arrow on any tile, and no move means no arrow.
  assert.equal(tileShowsArrow(dim, 'large'), false);
  assert.equal(tileShowsArrow(null, 'wide'), false);
  assert.equal(tileShowsArrow(null, 'slim'), false);
});

test('pickDetailMarket opens the market param tab, else rank 1', () => {
  const markets = [market(1, 'BTC', 2.8), market(2, 'ETH', 0.5), market(3, 'SOL', -0.9)];
  assert.equal(pickDetailMarket(markets, 'ETH')?.symbol, 'ETH');
  assert.equal(pickDetailMarket(markets, 'nope')?.symbol, 'BTC');
  assert.equal(pickDetailMarket(markets, null)?.symbol, 'BTC');
  assert.equal(pickDetailMarket([], undefined), null);
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

test('offline copy and percents', () => {
  assert.equal(isOfflineMessage('Failed to fetch'), true);
  assert.equal(isOfflineMessage('Stories request failed (500)'), false);
  assert.equal(formatSignedPercent(2.4), '+2.40%');
  assert.equal(formatSignedPercent(-1.2), '-1.20%');
});
