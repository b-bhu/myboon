import { describe, expect, it } from 'vitest';

import { checkClaims, checkDraftNumbers, checkNovelty, checkWatch, factKeys, runWriteBar } from './checks.js';
import { bundle, draft, item, passingCase, signal } from './fixtures.js';

describe('the passing case', () => {
  it('clears the whole write bar', () => {
    const { bundle: b, draft: d } = passingCase();
    expect(runWriteBar(d, b)).toEqual([]);
  });
});

describe('bar (a) novelty backstop', () => {
  const lastText = 'Bitcoin ranges between $78,000 and $87,000. Strategy holds 848,000 BTC.';
  const mk = (summary: string) => bundle({
    new_items: [item({ title: 'New item', summary })],
    last_update: { kind: 'earlier_item', id: 'x', title: 'last', date: null, text: lastText },
  });

  it('passes when what_happened has a number from the new items that the last update lacks', () => {
    const b = mk('ETF outflows hit $2.1 billion on Thursday.');
    expect(checkNovelty(draft({ what_happened: 'ETF outflows hit $2.1 billion.' }), b)).toEqual([]);
  });

  it('passes on a date from the new items that the last update lacks', () => {
    const b = mk('The vote is on Dec 10.');
    expect(checkNovelty(draft({ what_happened: 'A vote is set for December 10.' }), b)).toEqual([]);
  });

  it('passes on a named actor from the new items that the last update lacks', () => {
    const b = mk('Reports say Metaplanet keeps buying.');
    expect(checkNovelty(draft({ what_happened: 'Bitcoin is being bought by Metaplanet.' }), b)).toEqual([]);
  });

  it('holds when the draft only repeats what the last update already says', () => {
    const b = bundle({
      new_items: [item({ title: 'Range again', summary: 'Bitcoin ranges between $78,000 and $87,000.' })],
      last_update: { kind: 'earlier_item', id: 'x', title: 'last', date: null, text: lastText },
    });
    const failures = checkNovelty(draft({ what_happened: 'Bitcoin ranges between $78,000 and $87,000 again.' }), b);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.check).toBe('novelty');
  });

  it('holds when the new fact is in the draft but not in the new items (invented)', () => {
    const b = mk('Prices were quiet.');
    expect(checkNovelty(draft({ what_happened: 'Bitcoin fell 12% on a hack at Acme.' }), b)).toHaveLength(1);
  });

  it('with no last update, any number, date or actor from the new items is enough', () => {
    const b = bundle({ new_items: [item({ title: 'Adobe adds Gemini', summary: 'Adobe brings Google models into Creative Cloud.' })] });
    expect(checkNovelty(draft({ what_happened: 'Adobe is adding Gemini to Creative Cloud.' }), b)).toEqual([]);
  });

  it('does not treat a sentence-initial common word as an actor', () => {
    expect([...factKeys('Prices rose. Traders watched.')].filter((k) => k.startsWith('a:'))).toEqual([]);
    expect([...factKeys('Prices rose after Waller spoke. SEC filed.')].filter((k) => k.startsWith('a:')).sort()).toEqual(['a:sec', 'a:waller']);
  });

  it('keys years out and normalises dates', () => {
    const keys = factKeys('On Dec 10, 2026 the 10th of December vote; also 2026-12-10.');
    expect([...keys].filter((k) => k.startsWith('d:')).sort()).toEqual(['d:2026-12-10', 'd:dec-10']);
    expect([...keys].some((k) => k === 'n:2026')).toBe(false);
  });
});

describe('bar (b) claims and numbers', () => {
  const ids = new Set(['item-1']);
  const sigs = new Set(['sig-1']);

  it('needs at least one claim', () => {
    expect(checkClaims([], ids, sigs)[0]!.detail).toMatch(/no claims/);
  });
  it('a claim must cite a source', () => {
    const f = checkClaims([{ text: 'x', source_item_id: null, source_signal_id: null }], ids, sigs);
    expect(f[0]!.detail).toMatch(/cites no source/);
  });
  it('a claim must cite a supplied item or signal', () => {
    const f = checkClaims([
      { text: 'a', source_item_id: 'nope', source_signal_id: null },
      { text: 'b', source_item_id: null, source_signal_id: 'nope' },
      { text: 'c', source_item_id: 'item-1', source_signal_id: 'sig-1' },
    ], ids, sigs);
    expect(f.map((x) => x.detail)).toEqual(['"a" cites unknown source_item_id', '"b" cites unknown source_signal_id']);
  });
  it('every number in the draft must appear in a source; dates and years are ignored', () => {
    const corpus = '2.1billion 78% 75000';
    expect(checkDraftNumbers('fell to $75,000 on 2026-11-10 in 2026, $2.1 billion, 78%', corpus)).toEqual([]);
    const f = checkDraftNumbers('rose 12% to $90,000', corpus);
    expect(f.map((x) => x.detail)).toEqual(['number 12% is not in the items or their origin signals', 'number $90000 is not in the items or their origin signals']);
  });
  it('a number only in the last update still counts as sourced', () => {
    const { bundle: b, draft: d } = passingCase();
    const withLast = { ...b, last_update: { ...b.last_update!, text: `${b.last_update!.text}\nStrategy holds 848,000 BTC.` } };
    expect(runWriteBar({ ...d, how_we_got_here: 'Strategy holds 848,000 BTC.' }, withLast)).toEqual([]);
  });
  it('an invented number holds the draft', () => {
    const { bundle: b, draft: d } = passingCase();
    const f = runWriteBar({ ...d, how_we_got_here: 'Selling hit 9,999 BTC.' }, b);
    expect(f.map((x) => x.check)).toEqual(['numbers']);
  });
  it('an unsourced claim holds the draft', () => {
    const { bundle: b, draft: d } = passingCase();
    const f = runWriteBar({ ...d, claims: [{ text: 'x', source_item_id: null, source_signal_id: null }] }, b);
    expect(f.map((x) => x.check)).toEqual(['claims']);
  });
});

describe('bar (c) what_to_watch', () => {
  const watch = (what_to_watch: string) => checkWatch(draft({ what_to_watch }));
  it.each([
    'Watch the Dec 10 meeting.',
    'The next print on 2026-12-10.',
    'Whether $74,000 holds.',
    'Whether it holds 74K.',
    'A move above 5%.',
    'The SEC decision on the ETF.',
    'Earnings arrive in Q4.',
    'Wednesday brings the CPI release.',
    'A vote expected in December.',
  ])('names something concrete (case %#)', (text) => {
    expect(watch(text)).toEqual([]);
  });
  it.each([
    'Watch how the market reacts.',
    'Whether demand returns.',
    'More news to come, and volatility.',
  ])('fails when nothing concrete is named (case %#)', (text) => {
    const f = watch(text);
    expect(f).toHaveLength(1);
    expect(f[0]!.check).toBe('watch');
  });
  it('a missing date holds a draft that is otherwise fine', () => {
    const { bundle: b, draft: d } = passingCase();
    expect(runWriteBar({ ...d, what_to_watch: 'Watch how the market reacts.' }, b).map((x) => x.check)).toEqual(['watch']);
  });
});

describe('origin signals feed the corpus', () => {
  it('a number only in an origin signal is sourced', () => {
    const { bundle: b, draft: d } = passingCase();
    const sig = signal({ signal_id: 'b'.repeat(64), text: 'Open interest 431,000 BTC' });
    expect(runWriteBar({ ...d, how_we_got_here: 'Open interest is 431,000 BTC.' }, { ...b, origin_signals: [...b.origin_signals, sig] })).toEqual([]);
  });
});
