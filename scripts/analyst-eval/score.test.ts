import { describe, expect, it } from 'vitest';

import { parseLabelsCsv, scoreRun, type LabelRow, type RunRecord } from './score.js';

const SHELF_MAIN = '11111111-1111-4111-8111-111111111111';
const SHELF_OTHER = '22222222-2222-4222-8222-222222222222';
const ITEM_ONE = '33333333-3333-4333-8333-333333333333';
const ITEM_TWO = '44444444-4444-4444-8444-444444444444';
const SLUGS = new Map([
  [SHELF_MAIN, 'competitions'],
  [SHELF_OTHER, 'markets'],
]);

const hexSeed = (n: number) => n.toString(16).padStart(2, '0');
const SIG = (seed: string) => (seed + 'a'.repeat(64)).slice(0, 64);

const signal = (seed: string) => ({ signal_id: SIG(seed) });

function run(overrides: Partial<RunRecord> & { signal_id: string }): RunRecord {
  return {
    decision: null,
    parse_ok: true,
    error: null,
    tool_calls: 2,
    seconds: 30,
    tokens: 4_000,
    cost_usd: 0.01,
    api_calls: 3,
    hermes_calls: 3,
    overrun: false,
    ...overrides,
  };
}

function decision(
  signalId: string,
  opts: { main: string; also?: string; action?: 'keep' | 'skip'; target?: string | null },
): Record<string, unknown> {
  return {
    decision_type: 'file',
    schema_version: 1,
    signal_id: signalId,
    analyst_version: 'analyst-eval-0.1',
    reason: 'clear match',
    confidence: 0.9,
    shelves: [
      { shelf_id: opts.main, role: 'main' },
      ...((opts.also ? [{ shelf_id: opts.also, role: 'also_affects' }] : [])),
    ],
    target_item_id: opts.target ?? null,
    item_key: 'some-story-key',
    action: opts.action ?? 'keep',
  };
}

const label = (seed: string, shelf: string, extra: Partial<LabelRow> = {}): LabelRow => ({
  signal_id: SIG(seed),
  expected_main_shelf: shelf,
  expected_target_item_id: '',
  expected_action: '',
  notes: '',
  ...extra,
});

describe('scoreRun', () => {
  it('scores a correct main shelf as ok and passes at 100% accuracy', () => {
    const result = scoreRun([signal('aa')], [label('aa', 'competitions')], [run({
      signal_id: SIG('aa'),
      decision: decision(SIG('aa'), { main: SHELF_MAIN }),
    })], SLUGS);
    expect(result.labeledCount).toBe(1);
    expect(result.correctCount).toBe(1);
    expect(result.accuracy).toBe(1);
    expect(result.pass).toBe(true);
    expect(result.rows[0]!.ok).toBe(true);
    expect(result.rows[0]!.got_main_shelf).toBe('competitions');
    expect(result.rows[0]!.confidence).toBe(0.9);
  });

  it('scores a wrong main shelf and applies the 43/50 pass mark', () => {
    const ids = Array.from({ length: 50 }, (_, i) => hexSeed(i));
    const signals = ids.map(signal);
    const labels = ids.map((seed) => label(seed, 'competitions'));
    const runs = ids.map((seed, i) => run({
      signal_id: SIG(seed),
      decision: decision(SIG(seed), { main: i < 43 ? SHELF_MAIN : SHELF_OTHER }),
    }));
    const result = scoreRun(signals, labels, runs, SLUGS);
    expect(result.correctCount).toBe(43);
    expect(result.labeledCount).toBe(50);
    expect(result.accuracy).toBe(0.86);
    expect(result.pass).toBe(true);

    const oneLess = scoreRun(signals, labels, runs.slice(0, 42).concat(runs.slice(43).map((r) => ({ ...r, decision: decision(r.signal_id, { main: SHELF_OTHER }) }))), SLUGS);
    expect(oneLess.correctCount).toBe(42);
    expect(oneLess.pass).toBe(false);
  });

  it('counts a parse failure as wrong', () => {
    const result = scoreRun([signal('bb')], [label('bb', 'competitions')], [run({
      signal_id: SIG('bb'),
      parse_ok: false,
      error: 'model output on turn 1 contained no JSON object',
    })], SLUGS);
    expect(result.rows[0]!.ok).toBe(false);
    expect(result.parseFailures).toBe(1);
    expect(result.invalidDecisions).toBe(0);
    expect(result.accuracy).toBe(0);
  });

  it('scores an overrun wrong even with a valid decision', () => {
    const result = scoreRun([signal('cc')], [label('cc', 'competitions')], [run({
      signal_id: SIG('cc'),
      overrun: true,
      error: 'overrun: 180s signal budget exceeded',
      decision: decision(SIG('cc'), { main: SHELF_MAIN }),
    })], SLUGS);
    expect(result.overruns).toBe(1);
    expect(result.rows[0]!.ok).toBe(false);
    expect(result.accuracy).toBe(0);
  });

  it('counts schema-invalid decisions and missing main role as wrong', () => {
    const badShelves = run({
      signal_id: SIG('dd'),
      decision: { ...decision(SIG('dd'), { main: SHELF_MAIN }), shelves: [{ shelf_id: SHELF_MAIN, role: 'also_affects' }] },
    });
    const badSignalId = run({
      signal_id: SIG('ee'),
      decision: decision(SIG('ff'), { main: SHELF_MAIN }),
    });
    const result = scoreRun(
      [signal('dd'), signal('ee')],
      [label('dd', 'competitions'), label('ee', 'competitions')],
      [badShelves, badSignalId],
      SLUGS,
    );
    expect(result.invalidDecisions).toBe(2);
    expect(result.parseFailures).toBe(0);
    expect(result.correctCount).toBe(0);
  });

  it('counts skips in skipCount/skipRate without breaking main-shelf scoring', () => {
    const ids = ['aa', 'ab', 'ac'];
    const runs = ids.map((seed, i) => run({
      signal_id: SIG(seed),
      decision: decision(SIG(seed), {
        main: SHELF_MAIN,
        action: i < 2 ? 'skip' : 'keep',
      }),
    }));
    const result = scoreRun(ids.map(signal), [], runs, SLUGS);
    expect(result.skipCount).toBe(2);
    expect(result.skipRate).toBeCloseTo(2 / 3);
    expect(result.accuracy).toBeNull(); // unlabeled: no accuracy scoring
    expect(result.pass).toBe(false);
  });

  it('checks target_item_id agreement only where the label sets it', () => {
    const ids = ['aa', 'ab', 'ac'];
    const signals = ids.map(signal);
    const labels = [
      label('aa', 'competitions', { expected_target_item_id: ITEM_ONE }),
      label('ab', 'competitions', { expected_target_item_id: ITEM_ONE }),
    ]; // 'ac' has no target label
    const runs = [
      run({ signal_id: SIG('aa'), decision: decision(SIG('aa'), { main: SHELF_MAIN, target: ITEM_ONE }) }),
      run({ signal_id: SIG('ab'), decision: decision(SIG('ab'), { main: SHELF_MAIN, target: ITEM_TWO }) }),
      run({ signal_id: SIG('ac'), decision: decision(SIG('ac'), { main: SHELF_MAIN }) }),
    ];
    const result = scoreRun(signals, labels, runs, SLUGS);
    expect(result.targetTotal).toBe(2);
    expect(result.targetAgree).toBe(1);
    expect(result.rows.map((r) => r.target_agree)).toEqual([true, false, null]);
  });

  it('excludes unlabeled rows from accuracy and counts labeled rows without runs', () => {
    const result = scoreRun([signal('aa'), signal('ab')], [label('aa', 'competitions')], [], SLUGS);
    expect(result.labeledCount).toBe(1);
    expect(result.missing).toBe(1);
    expect(result.accuracy).toBe(0);
    expect(result.rows[0]!.ok).toBe(false);
    expect(result.rows[1]!.labeled).toBe(false);
  });

  it('marks a valid decision on an unknown shelf id with a null slug', () => {
    const UNKNOWN = '55555555-5555-4555-8555-555555555555';
    const result = scoreRun([signal('aa')], [label('aa', 'competitions')], [run({
      signal_id: SIG('aa'),
      decision: decision(SIG('aa'), { main: UNKNOWN }),
    })], SLUGS);
    expect(result.rows[0]!.decision_valid).toBe(true);
    expect(result.rows[0]!.got_main_shelf).toBeNull();
    expect(result.rows[0]!.ok).toBe(false);
  });
});

describe('parseLabelsCsv', () => {
  it('parses quoted commas, escaped quotes, and blank lines', () => {
    const csv = [
      'signal_id,expected_main_shelf,expected_target_item_id,expected_action,notes',
      'abc,competitions,"item-1-with, comma",keep,"note, has ""quotes"" inside"',
      'def,markets,,skip,',
      '',
    ].join('\n');
    const rows = parseLabelsCsv(csv);
    expect(rows).toEqual([
      {
        signal_id: 'abc',
        expected_main_shelf: 'competitions',
        expected_target_item_id: 'item-1-with, comma',
        expected_action: 'keep',
        notes: 'note, has "quotes" inside',
      },
      {
        signal_id: 'def',
        expected_main_shelf: 'markets',
        expected_target_item_id: '',
        expected_action: 'skip',
        notes: '',
      },
    ]);
  });

  it('handles CRLF line endings', () => {
    const rows = parseLabelsCsv('signal_id,expected_main_shelf,expected_target_item_id,expected_action,notes\r\nabc,competitions,,,');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      signal_id: 'abc',
      expected_main_shelf: 'competitions',
      expected_target_item_id: '',
      expected_action: '',
      notes: '',
    });
  });

  it('rejects a file with the wrong header', () => {
    expect(() => parseLabelsCsv('id,shelf\nabc,competitions')).toThrow(/signal_id/);
  });
});