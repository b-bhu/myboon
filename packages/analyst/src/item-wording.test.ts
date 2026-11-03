import { describe, expect, it } from 'vitest';

import { HEADLINE_MAX_CHARS, itemSummary, itemTitle, stripSourceAttribution } from './item-wording.js';
import { SYSTEM_PROMPT } from './session.js';

const PANEWS_SUMMARY =
  'According to a PANews report shared by tokens_xyz, China Merchants Bank added digital RMB payments to its mobile app. '
  + 'The feature lets users pay with e-CNY directly, widening retail access.';

describe('#559 entity item wording', () => {
  it('prompt carries the no-attribution rule', () => {
    expect(SYSTEM_PROMPT).toMatch(/Never name the source, publisher, sharer or account/);
    for (const w of ['According to', 'per', 'reports', 'shared by']) expect(SYSTEM_PROMPT).toContain(`"${w}"`);
  });

  it('PANews signal: title has no PANews, tokens_xyz, According to or shared by', () => {
    const title = itemTitle(undefined, PANEWS_SUMMARY, 'note');
    expect(title).toBe('China Merchants Bank added digital RMB payments to its mobile app.');
    for (const bad of ['PANews', 'tokens_xyz', 'According to', 'shared by']) expect(title).not.toContain(bad);
  });

  it.each([
    ['According to CoinDesk, Kalshi raised $1B.', 'Kalshi raised $1B.'],
    ['Per The Block: Solana ETF filings rose.', 'Solana ETF filings rose.'],
    ['As reported by Lookonchain, a whale sold 10k ETH.', 'A whale sold 10k ETH.'],
    ['Cointelegraph reports that Kalshi raised $1B.', 'Kalshi raised $1B.'],
    ['Kalshi raised $1B, shared by @tokens.', 'Kalshi raised $1B.'],
    ['Kalshi raised $1B via @tokens', 'Kalshi raised $1B'],
    ['Kalshi raised $1B at a $40B valuation.', 'Kalshi raised $1B at a $40B valuation.'],
  ])('strips source lead-ins: %s', (input, want) => {
    expect(stripSourceAttribution(input)).toBe(want);
  });

  it('title is the LLM headline, whole, never truncated', () => {
    const headline = 'China Merchants Bank adds digital RMB payments to its mobile app';
    expect(headline.length).toBeLessThanOrEqual(HEADLINE_MAX_CHARS);
    expect(itemTitle(headline, PANEWS_SUMMARY, 'n')).toBe(headline);
    const long = 'A '.repeat(150).trim() + ' end.';
    expect(itemTitle(long, '', 'n')).toBe(long); // no slice: the old builder cut at 200
  });

  it('without a headline the title is one whole sentence, never cut mid-sentence', () => {
    const title = itemTitle('', 'Kalshi raised $1B at a $40B valuation. Traders expect more listings.', 'n');
    expect(title).toBe('Kalshi raised $1B at a $40B valuation.');
  });

  it('one signal, several entities: each title is complete and not truncated', () => {
    const titles = ['kalshi', 'polymarket'].map((e) => itemTitle('Kalshi and Polymarket both list new election markets', '', `note ${e}`));
    for (const t of titles) expect(t).toBe('Kalshi and Polymarket both list new election markets');
  });

  it('summary does not duplicate the note', () => {
    expect(itemSummary('Kalshi raised $1B.', 'Kalshi raised $1B.')).toBe('');
    expect(itemSummary(PANEWS_SUMMARY, 'The bank announced an e-CNY feature.')).not.toBe('The bank announced an e-CNY feature.');
    expect(itemSummary(PANEWS_SUMMARY, 'x')).not.toContain('PANews');
  });
});
