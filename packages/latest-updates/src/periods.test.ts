import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadSnapshot, snapshotToBundle } from './eval-lib.js';
import { bundle, draft, item, signal } from './fixtures.js';
import { checkPeriods, extractPeriods } from './periods.js';

const labels = (text: string) => extractPeriods(text).map((p) => `${p.kind}:${p.n}:${p.year ?? ''}:${p.indicator ?? ''}`);

describe('period patterns (#623 write bar d)', () => {
  it('finds month names, full and 3-letter, with an optional year', () => {
    expect(labels('September CPI rose')).toEqual(['month:9::cpi']);
    expect(labels('in Oct 2026 and Sept. data')).toEqual(['month:10:2026:', 'month:9::data']);
    expect(labels('Dec.')).toEqual(['month:12::']);
  });
  it('finds Q1-Q4, H1/H2 and FY with optional years', () => {
    expect(labels('Q3 2026 earnings, then Q4')).toEqual(['quarter:3:2026:earnings', 'quarter:4::']);
    expect(labels('H2 2026 guidance and H1')).toEqual(['half:2:2026:guidance', 'half:1::']);
    expect(labels('FY25 revenue and FY2026 sales')).toEqual(['fy:0:2025:revenue', 'fy:0:2026:sales']);
  });
  it('ignores a month that is part of a calendar date', () => {
    expect(labels('The Fed meets Dec 10 and on 12 December, then 3rd of March.')).toEqual([]);
    expect(labels('Dec 10, 2026')).toEqual([]);
  });
  it('counts "May" only as a month, not as the verb', () => {
    expect(labels('Prices may rise. May rise further.')).toEqual([]);
    expect(labels('Data for May and in May 2026 CPI')).toEqual(['month:5::', 'month:5:2026:cpi']);
  });
  it('reads the indicator after the period, skipping US and core', () => {
    expect(labels('September US CPI and August core PCE')).toEqual(['month:9::cpi', 'month:8::pce']);
  });
});

describe('write bar (d): September CPI', () => {
  const sep = item({ title: 'Bitcoin sinks again as September CPI inflation tops expectations', summary: 'Bitcoin sold off after September US CPI came in above expectations.' });
  const d = (over: Parameters<typeof draft>[0] = {}) => draft({
    title: 'Bitcoin sinks after hot inflation',
    what_happened: 'Bitcoin sold off after September CPI topped expectations.',
    how_we_got_here: 'ETF outflows have weighed on price.',
    ...over,
  });

  it('holds a draft naming September CPI when the other sources call it the October print', () => {
    const oct = item({ title: 'Bitcoin falls on hot October CPI', summary: 'October CPI printed above forecasts.' });
    const failures = checkPeriods(d(), bundle({ new_items: [oct, sep] }));
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((f) => f.check === 'period')).toBe(true);
    expect(failures.map((f) => f.detail).join(' | ')).toMatch(/different periods for CPI: (october vs september|september vs october)/);
  });

  it('holds the reverse: the draft says October CPI, the sources only name September CPI', () => {
    const failures = checkPeriods(d({ what_happened: 'Bitcoin sold off after October CPI topped expectations.' }), bundle({ new_items: [sep] }));
    expect(failures.map((f) => f.detail)).toContain('the draft says October, but the new sources name CPI only for september');
    expect(failures.some((f) => /names October, which no supplied source names/.test(f.detail))).toBe(true);
  });

  it('does not hold a September CPI figure that the sources confirm was released in October', () => {
    const released = item({ title: 'US inflation: September CPI released in October', summary: 'The September CPI figure, released in October, rose 0.4%.' });
    expect(checkPeriods(d(), bundle({ new_items: [released, sep] }))).toEqual([]);
  });

  it('does not hold when the only September mention is in an earlier item or the last update', () => {
    const now = item({ title: 'Bitcoin edges lower', summary: 'Selling continued.' });
    const earlier = item({ title: 'September CPI hits risk assets', summary: 'September CPI above forecast.' });
    expect(checkPeriods(d(), bundle({ new_items: [now], prior_items: [earlier] }))).toEqual([]);
    expect(checkPeriods(d(), bundle({ new_items: [now], last_update: { kind: 'published', id: 'u', title: 't', date: null, text: 'September CPI shook the market.' } }))).toEqual([]);
  });

  it('holds a named month that no supplied source names', () => {
    const now = item({ title: 'Bitcoin edges lower', summary: 'Selling continued.' });
    const f = checkPeriods(d(), bundle({ new_items: [now] }));
    expect(f).toEqual([{ check: 'period', detail: 'the draft names September, which no supplied source names' }]);
  });

  it('a year must agree when both give one', () => {
    const src = item({ title: 'FY2025 revenue beat', summary: 'Revenue rose in FY2025.' });
    expect(checkPeriods(d({ what_happened: 'FY2025 revenue beat forecasts.' }), bundle({ new_items: [src] }))).toEqual([]);
    expect(checkPeriods(d({ what_happened: 'FY2026 revenue beat forecasts.' }), bundle({ new_items: [src] })).length).toBeGreaterThan(0);
  });

  it('quarters match across wording and use signal text too', () => {
    const src = item({ title: 'Earnings beat' });
    const sig = signal({ signal_id: 's1', text: 'Q3 earnings came in ahead.' });
    const b = bundle({ new_items: [{ ...src, signal_id: 's1' }], origin_signals: [sig] });
    expect(checkPeriods(d({ what_happened: 'Q3 earnings beat forecasts.' }), b)).toEqual([]);
    expect(checkPeriods(d({ what_happened: 'Q2 earnings beat forecasts.' }), b).length).toBeGreaterThan(0);
  });

  it("what_to_watch is out of scope: a future month there is not held", () => {
    const now = item({ title: 'Bitcoin edges lower', summary: 'Selling continued.' });
    expect(checkPeriods(d({ what_happened: 'Bitcoin edged lower.', what_to_watch: 'The December FOMC decision.' }), bundle({ new_items: [now] }))).toEqual([]);
  });

  it('a draft with no period words never trips the check', () => {
    expect(checkPeriods(d({ what_happened: 'Bitcoin edged lower.' }), bundle({ new_items: [sep] }))).toEqual([]);
  });
});

describe('the real Bitcoin bundle in the frozen eval set', () => {
  const snapshot = loadSnapshot(fileURLToPath(new URL('../eval/snapshot.json', import.meta.url)));
  const bitcoin = snapshotToBundle(snapshot.entities.find((e) => e.slug === 'bitcoin')!);

  it('names September CPI in its sources, so a September CPI draft agrees', () => {
    const f = checkPeriods(draft({ what_happened: 'Bitcoin sank after September CPI inflation topped expectations.', how_we_got_here: 'ETF outflows weighed.' }), bitcoin);
    expect(f).toEqual([]);
  });

  it('holds a draft that names the October CPI print, which no source names', () => {
    const f = checkPeriods(draft({ what_happened: 'Bitcoin sank after the October CPI print topped expectations.', how_we_got_here: 'ETF outflows weighed.' }), bitcoin);
    expect(f.length).toBeGreaterThan(0);
    expect(f.map((x) => x.detail).join(' ')).toMatch(/October/);
  });
});
