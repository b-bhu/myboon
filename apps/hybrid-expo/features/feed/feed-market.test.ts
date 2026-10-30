import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MARKET_CATEGORIES,
  MARKET_CATEGORY_LABELS,
  MARKET_INTERVALS,
  changeText,
  filterByCategory,
  formatTokenPrice,
  intervalLabel,
  marketSample,
  movers,
  sampleCategory,
  sampleNews,
  sampleSparkline,
  tableRows,
  treemapCaption,
  upDownCounts,
  isStablecoin,
} from './feed-market';
import type { HeatmapToken } from './token-heatmap.types';

const make = (address: string, patch: Partial<HeatmapToken> = {}): HeatmapToken => ({
  address,
  symbol: address,
  name: `Token ${address}`,
  priceUsd: 1,
  volumeUsd: 100,
  priceChangePct: 0,
  marketCapUsd: null,
  liquidityUsd: null,
  ...patch,
});

test('movers ranks gainers by price change desc, drops null changes, ties by symbol asc', () => {
  const tokens = [
    make('BBB', { priceChangePct: 2.4, volumeUsd: 300 }),
    make('AAA', { priceChangePct: 2.4, volumeUsd: 500 }),
    make('NULLY', { priceChangePct: null }),
    make('CCC', { priceChangePct: 7.4, volumeUsd: 50 }),
    make('DDD', { priceChangePct: -1, volumeUsd: 900 }),
  ];
  assert.deepEqual(movers(tokens, 'gainers').map((token) => token.symbol), ['CCC', 'AAA', 'BBB']);
  // n is adjustable; the null-change token can never appear.
  assert.deepEqual(movers(tokens, 'gainers', 2).map((token) => token.symbol), ['CCC', 'AAA']);
  assert.equal(movers(tokens, 'gainers', 10).some((token) => token.symbol === 'NULLY'), false);
});

test('movers ranks losers by price change ascending (not negatives-only), nulls excluded', () => {
  const tokens = [
    make('BBB', { priceChangePct: 2.4 }),
    make('AAA', { priceChangePct: 2.4 }),
    make('NULLY', { priceChangePct: null }),
    make('CCC', { priceChangePct: 7.4 }),
    make('DDD', { priceChangePct: -1 }),
  ];
  assert.deepEqual(movers(tokens, 'losers').map((token) => token.symbol), ['DDD', 'AAA', 'BBB']);
});

test('movers ranks volume by volumeUsd desc across every token, ties by symbol asc', () => {
  const tokens = [
    make('BBB', { volumeUsd: 300, priceChangePct: null }),
    make('AAA', { volumeUsd: 500 }),
    make('NULLY', { volumeUsd: 100, priceChangePct: null }),
    make('CCC', { volumeUsd: 50 }),
    make('A9', { volumeUsd: 10 }),
    make('Z9', { volumeUsd: 10 }),
  ];
  assert.deepEqual(movers(tokens, 'volume').map((token) => token.symbol), ['AAA', 'BBB', 'NULLY']);
  assert.deepEqual(movers(tokens, 'volume', 5).slice(3).map((token) => token.symbol), ['CCC', 'A9']);
});

test('movers does not mutate the input order', () => {
  const tokens = [make('BBB', { volumeUsd: 1 }), make('AAA', { volumeUsd: 900 })];
  movers(tokens, 'volume');
  assert.deepEqual(tokens.map((token) => token.symbol), ['BBB', 'AAA']);
});

test('tableRows sorts by volumeUsd desc with symbol asc ties', () => {
  const rows = tableRows([
    make('Z9', { volumeUsd: 100 }),
    make('AAA', { volumeUsd: 500 }),
    make('A9', { volumeUsd: 100 }),
    make('BBB', { volumeUsd: 300 }),
  ]);
  assert.deepEqual(rows.map((token) => token.symbol), ['AAA', 'BBB', 'A9', 'Z9']);
});

test('upDownCounts uses heatmap tone: zero and null are neither', () => {
  const tokens = [
    make('UP1', { priceChangePct: 2.4 }),
    make('UP2', { priceChangePct: 0.01 }),
    make('DOWN1', { priceChangePct: -3.2 }),
    make('FLAT', { priceChangePct: 0 }),
    make('NULLY', { priceChangePct: null }),
  ];
  assert.deepEqual(upDownCounts(tokens), { up: 2, down: 1 });
  assert.deepEqual(upDownCounts([]), { up: 0, down: 0 });
});

test('treemapCaption counts the tokens shown', () => {
  assert.equal(treemapCaption(new Array(16).fill(null).map((_, index) => make(`T${index}`))), '16 tokens · sized by volume');
  assert.equal(treemapCaption([]), '0 tokens · sized by volume');
});

test('formatTokenPrice: 2 decimals at/above 1, 4 decimals below, 2 significant digits tiny', () => {
  assert.equal(formatTokenPrice(182.4), '$182.40');
  assert.equal(formatTokenPrice(2.5), '$2.50');
  assert.equal(formatTokenPrice(1), '$1.00');
  assert.equal(formatTokenPrice(0.7124), '$0.7124');
  assert.equal(formatTokenPrice(0.01), '$0.0100');
  assert.equal(formatTokenPrice(0.9999), '$0.9999');
  assert.equal(formatTokenPrice(0.0000123), '$0.000012');
  assert.equal(formatTokenPrice(0.000022), '$0.000022');
  assert.equal(formatTokenPrice(0.0041), '$0.0041');
  assert.equal(formatTokenPrice(0), '$0.00');
  assert.equal(formatTokenPrice(null), '—');
});

test('changeText arrows by sign, one decimal, bare zero, em dash for null', () => {
  assert.equal(changeText(2.4), '▲ 2.4%');
  assert.equal(changeText(12.34), '▲ 12.3%');
  assert.equal(changeText(-3.2), '▼ 3.2%');
  assert.equal(changeText(0), '0.0%');
  assert.equal(changeText(null), '—');
});

test('market intervals are 24h and 1h with uppercase labels', () => {
  assert.deepEqual([...MARKET_INTERVALS], ['24h', '1h']);
  assert.equal(intervalLabel('24h'), '24H');
  assert.equal(intervalLabel('1h'), '1H');
});

test('market categories are the four mock tabs with uppercase labels', () => {
  assert.deepEqual([...MARKET_CATEGORIES], ['trending', 'crypto', 'stocks', 'memes']);
  assert.equal(MARKET_CATEGORY_LABELS.trending, 'TRENDING');
  assert.equal(MARKET_CATEGORY_LABELS.crypto, 'CRYPTO');
  assert.equal(MARKET_CATEGORY_LABELS.stocks, 'TOKENIZED STOCKS');
  assert.equal(MARKET_CATEGORY_LABELS.memes, 'MEMES');
});

test('sampleCategory is deterministic from the address and never trending', () => {
  const addresses = ['A1', 'B2', 'So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'x9'.repeat(20), 'q7'.repeat(21)];
  for (const address of addresses) {
    const first = sampleCategory({ ...make(address) });
    assert.equal(sampleCategory({ ...make(address) }), first, `same address must repeat for ${address}`);
    assert.notEqual(first, 'trending');
    assert.ok(['crypto', 'stocks', 'memes'].includes(first));
  }
});

test('filterByCategory keeps everything for trending and only the matching sample bucket otherwise', () => {
  const tokens = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'].map((address) => make(address));
  assert.deepEqual(filterByCategory(tokens, 'trending'), tokens);
  const crypto = filterByCategory(tokens, 'crypto');
  assert.ok(crypto.every((token) => sampleCategory(token) === 'crypto'));
  const all = new Set([
    ...filterByCategory(tokens, 'crypto').map((token) => token.address),
    ...filterByCategory(tokens, 'stocks').map((token) => token.address),
    ...filterByCategory(tokens, 'memes').map((token) => token.address),
  ]);
  assert.deepEqual([...all].sort(), [...tokens.map((token) => token.address)].sort());
  assert.deepEqual(filterByCategory(tokens, 'stocks'), filterByCategory(tokens, 'stocks'));
});

test('sampleSparkline is deterministic, has the requested length, and stays within 0..1', () => {
  const first = sampleSparkline('So11111111111111111111111111111111111111112');
  assert.equal(first.length, 12);
  assert.deepEqual(sampleSparkline('So11111111111111111111111111111111111111112'), first);
  assert.deepEqual(sampleSparkline('So11111111111111111111111111111111111111112', 13).length, 13);
  for (const value of first) {
    assert.ok(value >= 0 && value <= 1, `sparkline value ${value} outside 0..1`);
  }
  // Different addresses disagree, so tokens do not share a curve.
  assert.notDeepEqual(sampleSparkline('A1'), sampleSparkline('B2'));
});

test('sampleNews is generic sample copy with a relative age, deterministic per token', () => {
  const token = make('JUP', { symbol: 'JUP', name: 'Jupiter' });
  const news = sampleNews(token);
  assert.equal(typeof news.title, 'string');
  assert.ok(news.title.includes('Jupiter'));
  assert.ok(/\d+[mh]?$|just now/.test(news.ago) && news.ago.length <= 8);
  assert.deepEqual(sampleNews(token), news);
});

test('marketSample gates on withMock: explicit on is true, explicit off is null', () => {
  assert.equal(marketSample(true), true);
  assert.equal(marketSample(false), null);
});
test('isStablecoin matches the stablecoin list and its jl/wrapped/bridged variants', () => {
  for (const symbol of ['USDC', 'usdt', 'USDG', 'PYUSD', 'USDS', 'jlUSDC', 'JLUSDT', 'wUSDC', 'USDC.e', 'USDT.E', 'FDUSD', 'USDe', 'DAI']) {
    assert.equal(isStablecoin(make(symbol)), true, symbol);
  }
  for (const symbol of ['SOL', 'JUP', 'USD1X', 'WIF', 'BUSDX', 'JLP', 'W']) {
    assert.equal(isStablecoin(make(symbol)), false, symbol);
  }
});

test('movers and tableRows leave stablecoins out', () => {
  const tokens = [
    make('USDG', { priceChangePct: 9, volumeUsd: 900 }),
    make('jlUSDC', { priceChangePct: -9, volumeUsd: 800 }),
    make('SOL', { priceChangePct: 2, volumeUsd: 500 }),
    make('BONK', { priceChangePct: -3, volumeUsd: 100 }),
  ];
  assert.deepEqual(movers(tokens, 'gainers').map((t) => t.symbol), ['SOL', 'BONK']);
  assert.deepEqual(movers(tokens, 'losers').map((t) => t.symbol), ['BONK', 'SOL']);
  assert.deepEqual(movers(tokens, 'volume').map((t) => t.symbol), ['SOL', 'BONK']);
  assert.deepEqual(tableRows(tokens).map((t) => t.symbol), ['SOL', 'BONK']);
});
