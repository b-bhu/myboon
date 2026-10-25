import { describe, expect, it } from 'vitest';

import { fileOnlySkill, mustFile } from './run-eval.js';
import { readFileSync } from 'node:fs';
import { parseLabelsCsv, renderMarkdown, scoreRun, type LabelRow, type RunRecord } from './score.js';

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
    const result = scoreRun([signal('aa')], [label('aa', 'competitions', { expected_action: 'keep' })], [run({
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

  it('applies 31/36 main shelf and 43/50 keep/skip, both required', () => {
    const ids = Array.from({ length: 50 }, (_, i) => hexSeed(i));
    const signals = ids.map(signal);
    // 36 shelf-labelled, 14 blank shelf; all 50 have expected_action keep.
    const labels = ids.map((seed, i) => label(seed, i < 36 ? 'competitions' : '', { expected_action: 'keep' }));
    const build = (mainOk: number, actionOk: number) => ids.map((seed, i) => run({
      signal_id: SIG(seed),
      decision: decision(SIG(seed), {
        main: i < mainOk ? SHELF_MAIN : SHELF_OTHER,
        action: i < actionOk ? 'keep' : 'skip',
      }),
    }));
    const atMarks = scoreRun(signals, labels, build(31, 43), SLUGS);
    expect(atMarks.labeledCount).toBe(36);
    expect(atMarks.correctCount).toBe(31);
    expect(atMarks.actionTotal).toBe(50);
    expect(atMarks.actionAgreeCount).toBe(43);
    expect(atMarks.mainPass).toBe(true);
    expect(atMarks.actionPass).toBe(true);
    expect(atMarks.pass).toBe(true);

    const shelfShort = scoreRun(signals, labels, build(30, 50), SLUGS);
    expect(shelfShort.correctCount).toBe(30);
    expect(shelfShort.actionPass).toBe(true);
    expect(shelfShort.pass).toBe(false);

    const actionShort = scoreRun(signals, labels, build(36, 42), SLUGS);
    expect(actionShort.mainPass).toBe(true);
    expect(actionShort.actionAgreeCount).toBe(42);
    expect(actionShort.pass).toBe(false);
  });

  it('scores keep/skip on blank-shelf rows, treats merge as keep and no decision as a miss', () => {
    const MERGED = '66666666-6666-4666-8666-666666666666';
    const signals = ['aa', 'ab', 'ac', 'ad'].map(signal);
    const labels = [
      label('aa', '', { expected_action: 'skip' }),
      label('ab', 'competitions', { expected_action: 'keep' }),
      label('ac', 'competitions', { expected_action: 'keep' }),
      label('ad', 'competitions', { expected_action: '' }),
    ];
    const runs = [
      run({ signal_id: SIG('aa'), decision: decision(SIG('aa'), { main: SHELF_MAIN, action: 'skip' }) }),
      run({
        signal_id: SIG('ab'),
        decision: {
          decision_type: 'merge', schema_version: 1, signal_id: SIG('ab'), analyst_version: 'x',
          reason: 'dup', confidence: 0.8, target_item_id: ITEM_ONE, merged_into_id: MERGED,
        },
      }),
      run({ signal_id: SIG('ac'), parse_ok: false }),
      run({ signal_id: SIG('ad'), decision: decision(SIG('ad'), { main: SHELF_MAIN }) }),
    ];
    const result = scoreRun(signals, labels, runs, SLUGS);
    expect(result.rows.map((r) => r.got_action)).toEqual(['skip', 'keep', null, 'keep']);
    expect(result.rows.map((r) => r.action_agree)).toEqual([true, true, false, null]);
    expect(result.actionTotal).toBe(3);
    expect(result.actionAgreeCount).toBe(2);
  });

  it('reports UNCERTAIN labels separately as soft misses', () => {
    const signals = ['aa', 'ab', 'ac'].map(signal);
    const labels = [
      label('aa', 'competitions', { expected_action: 'keep', notes: 'UNCERTAIN: could be markets' }),
      label('ab', 'competitions', { expected_action: 'skip', notes: 'uncertain, noise' }),
      label('ac', 'competitions', { expected_action: 'keep', notes: 'clear' }),
    ];
    const runs = [
      run({ signal_id: SIG('aa'), decision: decision(SIG('aa'), { main: SHELF_OTHER }) }), // shelf miss
      run({ signal_id: SIG('ab'), decision: decision(SIG('ab'), { main: SHELF_MAIN, action: 'skip' }) }), // hit
      run({ signal_id: SIG('ac'), decision: decision(SIG('ac'), { main: SHELF_OTHER }) }), // hard miss
    ];
    const result = scoreRun(signals, labels, runs, SLUGS);
    expect(result.rows.map((r) => r.uncertain)).toEqual([true, true, false]);
    expect(result.uncertainCount).toBe(2);
    expect(result.uncertainMisses).toBe(1);
    expect(result.correctCount).toBe(1); // uncertain rows still count in the headline score
    const md = renderMarkdown(1, result);
    expect(md).toContain('UNCERTAIN labels (soft misses): 1/2 missed');
    expect(md).toContain('keep/skip agreement: 3/3');
    expect(md).toContain('overall: FAIL');
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

  it('counts a tool-budget hit as needs review, not a parse failure or overrun', () => {
    const result = scoreRun([signal('cd'), signal('ce')], [label('cd', 'competitions'), label('ce', 'competitions')], [
      run({ signal_id: SIG('cd'), parse_ok: false, needs_review: true, tool_calls: 10, error: 'needs review: still searching after the tool budget' }),
      run({ signal_id: SIG('ce'), decision: decision(SIG('ce'), { main: SHELF_MAIN }) }),
    ], SLUGS);
    expect(result.needsReview).toBe(1);
    expect(result.parseFailures).toBe(0);
    expect(result.overruns).toBe(0);
    expect(result.rows[0]!.ok).toBe(false);
    expect(result.correctCount).toBe(1);
    const md = renderMarkdown(2, result);
    expect(md).toContain('needs-review');
    expect(md).toContain('needs review: 1');
  });

  it('scores an explicit none against a no-shelf label as correct and a picked shelf as a miss', () => {
    const none = (seed: string, reason = 'no atlas shelf covers this') => ({
      ...decision(SIG(seed), { main: SHELF_MAIN }),
      shelves: [{ shelf_id: 'none', role: 'main' }],
      reason,
    });
    const result = scoreRun(
      [signal('d1'), signal('d2'), signal('d3'), signal('d4')],
      [label('d1', ''), label('d2', ''), label('d3', 'competitions'), label('d4', '')],
      [
        run({ signal_id: SIG('d1'), decision: none('d1') }),
        run({ signal_id: SIG('d2'), decision: decision(SIG('d2'), { main: SHELF_MAIN }) }),
        run({ signal_id: SIG('d3'), decision: none('d3') }),
        run({ signal_id: SIG('d4'), decision: none('d4', '  ') }),
      ],
      SLUGS,
    );
    const [d1, d2, d3, d4] = result.rows;
    expect(d1!.got_main_shelf).toBe('none');
    expect(d1!.ok).toBe(true);
    expect(d2!.decision_valid).toBe(true);
    expect(d2!.ok).toBe(false);
    expect(d3!.ok).toBe(false); // labeled shelf, model said none
    expect(d4!.decision_valid).toBe(false); // none needs a reason
    expect(result.noneCorrect).toBe(1);
    expect(result.noneTotal).toBe(3);
    expect(result.labeledCount).toBe(1); // no-shelf rows stay outside the 31/36 gate
    expect(renderMarkdown(2, result)).toContain('no-shelf signals filed as none: 1/3');
  });

  it('rejects an empty shelves list and a shelf the signal never saw in search results', () => {
    const result = scoreRun([signal('e1'), signal('e2')], [label('e1', 'competitions'), label('e2', 'competitions')], [
      run({ signal_id: SIG('e1'), decision: { ...decision(SIG('e1'), { main: SHELF_MAIN }), shelves: [] } }),
      run({ signal_id: SIG('e2'), seen_shelf_ids: [SHELF_OTHER], decision: decision(SIG('e2'), { main: SHELF_MAIN }) }),
    ], SLUGS);
    expect(result.rows[0]!.decision_valid).toBe(false);
    expect(result.rows[1]!.decision_valid).toBe(false);
    expect(result.correctCount).toBe(0);
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

  it('treats a shelf id not in atlas as an invalid decision and a miss, whatever the label', () => {
    const UNKNOWN = '55555555-5555-4555-8555-555555555555';
    const result = scoreRun([signal('aa'), signal('ab')], [label('aa', 'competitions'), label('ab', '')], [
      run({ signal_id: SIG('aa'), decision: decision(SIG('aa'), { main: UNKNOWN }) }),
      run({ signal_id: SIG('ab'), decision: decision(SIG('ab'), { main: UNKNOWN }) }),
    ], SLUGS);
    expect(result.rows[1]!.decision_valid).toBe(false);
    expect(result.rows[1]!.ok).toBe(false);
    expect(result.rows[0]!.decision_valid).toBe(false);
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
describe('run-eval filing turn', () => {
  it('forces filing once ~10k of the 25k budget remains or 10 tools are used', () => {
    expect(mustFile(1, 14_999)).toBe(false);
    expect(mustFile(1, 15_000)).toBe(true);
    expect(mustFile(10, 0)).toBe(true);
  });

  it('does not offer the search tool on the forced filing turn', () => {
    const skill = readFileSync(new URL('./analyst.SKILL.md', import.meta.url), 'utf8');
    expect(skill).toContain('search_atlas');
    const fileOnly = fileOnlySkill(skill);
    expect(fileOnly).not.toContain('search_atlas');
    expect(fileOnly).toContain('"final"');
  });
});
