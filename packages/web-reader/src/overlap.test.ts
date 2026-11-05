import { describe, expect, test } from 'vitest';

import { hasEnoughOverlap, normalizeTokens } from './overlap.js';

describe('overlap guard (#582)', () => {
  test('tokenizes lowercase word runs of length >= 4', () => {
    expect(normalizeTokens('The North-Korea denies $6.3B hack!!')).toEqual(new Set(['north', 'korea', 'denies', 'hack']));
    expect(normalizeTokens('an of to at')).toEqual(new Set());
    expect(normalizeTokens(null)).toEqual(new Set());
    expect(normalizeTokens('Résumé 2027')).toEqual(new Set(['résumé', '2027']));
  });

  test('ok: body shares >= 2 tokens (>= 4 chars) with the title', () => {
    const title = 'North Korea denies $6.3B Binance hack, calls FBI finding a political provocation';
    const body = 'SEOUL — North Korea on Tuesday denied any role in the Binance hack and called the FBI finding a political provocation, according to state media.';
    expect(hasEnoughOverlap(body, title)).toBe(true);
  });

  test('fail: no shared tokens means no overlap (word-for-word fabricated body)', () => {
    const title = 'France postpones 2027 budget vote';
    const body = 'Completely unrelated words about weather forecasting in Tokyo markets today.';
    expect(hasEnoughOverlap(body, title)).toBe(false);
  });

  test('exactly one shared token is not enough (N=2)', () => {
    expect(hasEnoughOverlap('france budget news roundup of other stories', 'France postpones budget vote in parliament')).toBe(true); // france + budget = 2
    expect(hasEnoughOverlap('france news roundup of other stories entirely', 'France postpones budget vote in parliament')).toBe(false); // france only
  });

  test('short tokens (< 4 chars) never count as shared', () => {
    expect(hasEnoughOverlap('us de it markets were calm', 'us and de talks end')).toBe(false);
  });

  test('the plain-fetched extract is the second overlap source', () => {
    const title = 'Some headline without any matching words really';
    const body = 'Hyperliquid co founder Jeff Yan spoke about the US market entry plans.';
    const plainExtract = 'Hyperliquid co-founder Jeff Yan would like to break into the US market, saying expansion is near.';
    expect(hasEnoughOverlap(body, title)).toBe(false);
    expect(hasEnoughOverlap(body, title, plainExtract)).toBe(true);
  });

  test('empty body never overlaps', () => {
    expect(hasEnoughOverlap('', 'France postpones budget vote')).toBe(false);
    expect(hasEnoughOverlap('   ', 'France postpones budget vote')).toBe(false);
  });
});
