/** #690 pure markets logic: validation, prompts and the rank assignment (no DB, no network). */
import { describe, expect, it } from 'vitest';

import { assignMarketRanks, type MarketRow } from './markets-worker.js';
import {
  MARKETS_SYSTEM_PROMPT,
  MARKET_REASON_MAX,
  cleanMarketReason,
  marketsUserMessage,
  validateMarkets,
} from './markets.js';

const LIVE = new Set(['BTC', 'ETH', 'kPEPE', 'xyz:CL', 'xyz:GOLD', 'xyz:BRENTOIL']);
const mk = (...markets: Array<{ symbol: string; reason?: string | null }>): Record<string, unknown> => ({ markets });
const symbols = (...names: string[]) => mk(...names.map((symbol) => ({ symbol, reason: `moves ${symbol}` })));

describe('#690 validateMarkets', () => {
  it('keeps valid picks in reply order, with ranks 1..n filled at write time', () => {
    expect(validateMarkets(symbols('xyz:CL', 'BTC', 'xyz:BRENTOIL'), LIVE)).toEqual({
      picks: [
        { symbol: 'xyz:CL', reason: 'moves xyz:CL' },
        { symbol: 'BTC', reason: 'moves BTC' },
        { symbol: 'xyz:BRENTOIL', reason: 'moves xyz:BRENTOIL' },
      ],
      dropped: [],
    });
  });

  it('drops an unknown symbol and reports it in dropped', () => {
    const r = validateMarkets(symbols('FOOBARBAZ', 'BTC'), LIVE);
    expect(r.picks).toEqual([{ symbol: 'BTC', reason: 'moves BTC' }]);
    expect(r.dropped).toEqual(['FOOBARBAZ']);
  });

  it('drops xyz:cl (wrong case): the live-set check is exact', () => {
    const r = validateMarkets(symbols('xyz:cl', 'xyz:CL'), LIVE);
    expect(r.picks).toEqual([{ symbol: 'xyz:CL', reason: 'moves xyz:CL' }]);
    expect(r.dropped).toEqual(['xyz:cl']);
  });

  it('drops BTC-PERP: not on the live list', () => {
    const r = validateMarkets(symbols('BTC-PERP'), LIVE);
    expect(r.picks).toEqual([]);
    expect(r.dropped).toEqual(['BTC-PERP']);
  });

  it('drops duplicates keeping the first occurrence', () => {
    const r = validateMarkets(symbols('BTC', 'BTC', 'ETH'), LIVE);
    expect(r.picks.map((p) => p.symbol)).toEqual(['BTC', 'ETH']);
    expect(r.dropped).toEqual([]);
  });

  it('keeps the first 3 of 5 valid picks', () => {
    const r = validateMarkets(symbols('BTC', 'ETH', 'xyz:CL', 'xyz:GOLD', 'kPEPE'), LIVE);
    expect(r.picks.map((p) => p.symbol)).toEqual(['BTC', 'ETH', 'xyz:CL']);
  });

  it('an empty markets list is a valid none', () => {
    expect(validateMarkets(mk(), LIVE)).toEqual({ picks: [], dropped: [] });
  });

  it('every pick dropped as unknown is also a valid none, with the dropped symbols', () => {
    const r = validateMarkets(symbols('NOPE', 'NIX'), LIVE);
    expect(r.picks).toEqual([]);
    expect(r.dropped).toEqual(['NOPE', 'NIX']);
  });

  for (const bad of [{}, { markets: 'BTC' }, { markets: [null] }, { markets: [{ reason: 'x' }] }, { markets: [42] }]) {
    it(`throws on an unusable reply ${JSON.stringify(bad)} (the entity stays unchecked, next run retries)`, () => {
      expect(() => validateMarkets(bad, LIVE)).toThrow(/markets/);
    });
  }

  it('cleans the reason: trimmed, newlines to spaces, cut to 200 characters, empty becomes null', () => {
    expect(cleanMarketReason('  US-Iran conflict moves crude. ')).toBe('US-Iran conflict moves crude.');
    expect(cleanMarketReason('line one\n\nline two')).toBe('line one  line two');
    expect(cleanMarketReason('x'.repeat(MARKET_REASON_MAX + 100))).toHaveLength(MARKET_REASON_MAX);
    expect(cleanMarketReason('')).toBeNull();
    expect(cleanMarketReason('   ')).toBeNull();
    expect(cleanMarketReason(42)).toBeNull();
  });
});

describe('#690 reason normalization through validateMarkets', () => {
  it('a reason with a newline and 300 characters is cleaned to a flat 200-character line, or null', () => {
    const long = `${'a'.repeat(150)}\n${'b'.repeat(150)}`;
    const r = validateMarkets(mk({ symbol: 'BTC', reason: long }, { symbol: 'ETH', reason: ' ' }), LIVE);
    expect(r.picks[0]).toEqual({ symbol: 'BTC', reason: `${'a'.repeat(150)} ${'b'.repeat(49)}` });
    expect(r.picks[1]).toEqual({ symbol: 'ETH', reason: null });
    for (const p of r.picks) expect(p.reason ?? '').not.toMatch(/[\r\n]/);
  });
});

describe('#690 prompt', () => {
  it('MARKETS_SYSTEM_PROMPT states the contract: 0 to 3 exact live symbols, else none, JSON only', () => {
    expect(MARKETS_SYSTEM_PROMPT).toContain('0 to 3');
    expect(MARKETS_SYSTEM_PROMPT).toContain('copied exactly');
    expect(MARKETS_SYSTEM_PROMPT).toContain('xyz:CL');
    expect(MARKETS_SYSTEM_PROMPT).toContain('Return none rather than a weak link');
    expect(MARKETS_SYSTEM_PROMPT).toContain('"markets":[{"symbol":"xyz:CL","reason":"one line, under 200 characters"}]');
  });

  it('the user message carries the entity name, type, summary, item titles and every live symbol', () => {
    const entity = { id: 'e1', slug: 'iran-oil', name: 'US–Iran conflict', type: 'event', summary: 'Escalating conflict.' };
    const items = [{ id: 'i1', title: 'Strikes hit tankers', summary: null, date: '2026-11-20T00:00:00Z' }];
    const msg = marketsUserMessage(entity, items, ['BTC', 'xyz:CL', 'xyz:BRENTOIL']);
    expect(msg).toContain('US–Iran conflict');
    expect(msg).toContain('event');
    expect(msg).toContain('Escalating conflict.');
    expect(msg).toContain('Strikes hit tankers');
    expect(msg).toContain('BTC');
    expect(msg).toContain('xyz:CL');
    expect(msg).toContain('xyz:BRENTOIL');
  });

  it('the user message shows none-yet items when the entity has no recent item', () => {
    const msg = marketsUserMessage({ id: 'e', slug: 's', name: 'S', type: 'topic', summary: null }, [], ['BTC']);
    expect(msg).toContain('(none yet)');
  });
});

describe('#690 assignMarketRanks', () => {
  const row = (symbol: string): MarketRow => ({ symbol, reason: null, setBy: 'model', pinned: false });

  it('fills ranks 1..n in order when nothing is pinned', () => {
    expect(assignMarketRanks([row('BTC'), row('ETH')], [])).toEqual([
      { rank: 1, row: row('BTC') },
      { rank: 2, row: row('ETH') },
    ]);
  });

  it('a pinned xyz:GOLD at rank 1 survives and new picks take ranks 2-3, its pinned symbol skipped', () => {
    const out = assignMarketRanks([row('xyz:GOLD'), row('BTC'), row('ETH')], [{ rank: 1, symbol: 'xyz:GOLD' }]);
    expect(out).toEqual([
      { rank: 2, row: row('BTC') },
      { rank: 3, row: row('ETH') },
    ]);
  });

  it('writes at most 3 rows in total: with two pinned ranks only one free rank is used', () => {
    const out = assignMarketRanks([row('BTC'), row('ETH')], [
      { rank: 2, symbol: 'xyz:CL' },
      { rank: 3, symbol: 'xyz:GOLD' },
    ]);
    expect(out).toEqual([{ rank: 1, row: row('BTC') }]);
  });

  it('three pinned ranks leave nothing to write', () => {
    expect(assignMarketRanks([row('BTC')], [
      { rank: 1, symbol: 'A' },
      { rank: 2, symbol: 'B' },
      { rank: 3, symbol: 'C' },
    ])).toEqual([]);
  });
});
