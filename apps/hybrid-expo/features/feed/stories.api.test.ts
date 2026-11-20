import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchStoryMarketCandles, parseStorySummary } from './stories.api';
import type { StorySummary } from './feed.types';

const rawStory = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  storySlug: 'us-iran',
  name: 'US vs Iran',
  latestDevelopment: 'Talks stall again.',
  eventCount: 4,
  updatedAt: '2026-10-26T07:02:09.000Z',
  imageUrl: null,
  imageKind: null,
  imageAttribution: null,
  ...overrides,
});

const rawMarket = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  symbol: 'BTC',
  displaySymbol: 'BTC',
  displayName: 'Bitcoin',
  rank: 1,
  price: 68_000.5,
  change24hPct: 2.84,
  asOf: '2026-10-26T07:00:00.000Z',
  ...overrides,
});

test('parseStorySummary reads up to three markets, sorted by rank', () => {
  const parsed = parseStorySummary(rawStory({
    markets: [
      rawMarket({ rank: 2, symbol: 'WTI', displaySymbol: 'WTI', displayName: 'WTI crude oil', price: 71.2, change24hPct: -0.61 }),
      rawMarket({ rank: 1 }),
      rawMarket({ rank: 3, symbol: 'xyz:CL', displayName: 'Crude linking futures', asOf: null }),
    ],
  })) as StorySummary;
  assert.deepEqual(parsed.markets.map((item) => item.symbol), ['BTC', 'WTI', 'xyz:CL']);
  assert.equal(parsed.markets[0]?.rank, 1);
  assert.equal(parsed.markets[0]?.price, 68_000.5);
  assert.equal(parsed.markets[0]?.displaySymbol, 'BTC');
  assert.equal(parsed.markets[1]?.price, 71.2);
  assert.equal(parsed.markets[1]?.change24hPct, -0.61);
  assert.equal(parsed.markets[2]?.asOf, null);
});

test('a missing or non-array markets value gives an empty list', () => {
  assert.deepEqual(parseStorySummary(rawStory())?.markets ?? [], []);
  assert.deepEqual(parseStorySummary(rawStory({ markets: 'markets' }))?.markets ?? [], []);
  assert.deepEqual(parseStorySummary(rawStory({ markets: {} }))?.markets ?? [], []);
});

test('entries missing a field or carrying a bad rank are dropped', () => {
  const parsed = parseStorySummary(rawStory({
    markets: [
      rawMarket({ rank: 4 }),
      rawMarket({ rank: '1' }),
      rawMarket({ symbol: '   ' }),
      rawMarket({ displayName: '' }),
      'not-an-object',
      rawMarket({ symbol: 'KEEP', displaySymbol: 'KEEP', displayName: 'Kept market' }),
    ],
  })) as StorySummary;
  assert.deepEqual(parsed.markets.map((item) => item.symbol), ['KEEP']);
});

test('a duplicate symbol keeps the lowest rank and four valid stay capped at three', () => {
  const duplicate = parseStorySummary(rawStory({
    markets: [rawMarket({ rank: 2 }), rawMarket({ rank: 1, price: 68_001.25 })],
  })) as StorySummary;
  assert.deepEqual(duplicate.markets.map((item) => [item.symbol, item.price]), [['BTC', 68_001.25]]);

  const capped = parseStorySummary(rawStory({
    markets: [
      rawMarket({ rank: 3, symbol: 'C', displayName: 'C' }),
      rawMarket({ rank: 2, symbol: 'B', displayName: 'B' }),
      rawMarket({ rank: 1, symbol: 'A', displayName: 'A' }),
      rawMarket({ rank: 3, symbol: 'D', displayName: 'D' }),
    ],
  })) as StorySummary;
  assert.deepEqual(capped.markets.map((item) => item.symbol), ['A', 'B', 'C']);
});

test('a null or non-finite price forces the move and stamp to null', () => {
  for (const price of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const parsed = parseStorySummary(rawStory({
      markets: [rawMarket({ price, change24hPct: 3.2, asOf: '2026-10-26T07:00:00.000Z' })],
    })) as StorySummary;
    const first = parsed.markets[0];
    assert.equal(first?.price, null);
    assert.equal(first?.change24hPct, null);
    assert.equal(first?.asOf, null);
  }
  // A finite price keeps the move; an unusable stamp alone only blanks the stamp.
  const pricedOnly = parseStorySummary(rawStory({
    markets: [rawMarket({ asOf: 'not-a-date' })],
  })) as StorySummary;
  assert.equal(pricedOnly.markets[0]?.change24hPct, 2.84);
  assert.equal(pricedOnly.markets[0]?.asOf, null);
});

test('a malformed markets value never drops the story', () => {
  const parsed = parseStorySummary(rawStory({ markets: [{ nope: true }, 7, null] })) as StorySummary;
  assert.equal(parsed.storySlug, 'us-iran');
  assert.deepEqual(parsed.markets, []);
});

test('a story without market fields still parses', () => {
  const parsed = parseStorySummary(rawStory({
    eventCount: 1,
    markets: [],
  })) as StorySummary;
  assert.equal(parsed.eventCount, 1);
  assert.deepEqual(parsed.markets, []);
});

const originalFetch = globalThis.fetch;

const candleRow = (timeMs: number, close: number) => ({
  timeMs,
  open: close - 1,
  high: close + 1,
  low: close - 2,
  close,
  volume: 12,
});

test('fetchStoryMarketCandles requests 24 one-hour candles and returns them unshuffled', async () => {
  const requested: URL[] = [];
  const payload = { symbol: 'xyz:CL', interval: '1h', candles: [candleRow(0, 70), candleRow(1, 71), candleRow(2, 72)] };
  globalThis.fetch = async (input) => {
    requested.push(new URL(String(input)));
    return Response.json(payload);
  };
  try {
    const candles = await fetchStoryMarketCandles('xyz:CL');
    assert.equal(requested[0]?.pathname, '/market/hyperliquid/candles');
    assert.equal(requested[0]?.search, '?symbol=xyz%3ACL&interval=1h&count=24');
    assert.deepEqual(candles.map((candle) => candle.close), [70, 71, 72]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a non-OK candles response throws', async () => {
  globalThis.fetch = async () => new Response('nope', { status: 404 });
  try {
    await assert.rejects(fetchStoryMarketCandles('BTC'), /404/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  globalThis.fetch = async () => new Response('nope', { status: 400 });
  try {
    await assert.rejects(fetchStoryMarketCandles('BTC'), /400/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
