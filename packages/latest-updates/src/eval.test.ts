import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { main } from './eval.js';
import { evaluateEntity, loadSnapshot, parseLabels, score, snapshotToBundle, type EntityResult, type SnapshotEntity } from './eval-lib.js';

const EVAL_DIR = fileURLToPath(new URL('../eval/', import.meta.url));

const entity = (slug: string, summary = 'ETF outflows hit $2.1 billion on Thursday; IBIT drove 78%.'): SnapshotEntity => ({
  id: `id-${slug}`, slug, name: slug, type: 'asset', summary: null,
  new_items: [{ id: `item-${slug}`, title: `${slug} news`, summary, created_at: '2026-11-13T00:00:00Z', occurred_at: '2026-11-10T10:00:00Z', signal_id: null, note: null }],
  last_update: null, prior_items: [], origin_signals: [],
});

/** A model that publishes a good draft for entities whose slug starts with "w" and holds the others. */
const llmFor = (entities: SnapshotEntity[]) => async (messages: Array<{ role: string; content: string }>) => {
  const user = messages[1]!.content;
  const slug = /slug: (\S+)/.exec(user)![1]!;
  if (!slug.startsWith('w')) return '{"decision":"hold","reason":"thin"}';
  const e = entities.find((x) => x.slug === slug)!;
  return JSON.stringify({
    decision: 'write', reason: 'new number', title: `${slug} slips`,
    what_happened: 'ETF outflows hit $2.1 billion, with IBIT driving 78% of it.', how_we_got_here: 'Selling continued all week.',
    what_to_watch: 'Watch the Dec 10 Fed decision.', claims: [{ text: 'outflow', source_item_id: e.new_items[0]!.id, source_signal_id: null }],
  });
};

function fixture(labelsCsv: string, entities: SnapshotEntity[]) {
  const dir = mkdtempSync(join(tmpdir(), 'lu-eval-'));
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ meta: {}, entities }));
  writeFileSync(join(dir, 'labels.csv'), labelsCsv);
  return ['--snapshot', join(dir, 'snapshot.json'), '--labels', join(dir, 'labels.csv')];
}

async function run(argv: string[], env: NodeJS.ProcessEnv = {}, llm?: Parameters<typeof main>[3]) {
  const lines: string[] = [];
  const code = await main(argv, env, (s) => lines.push(s), llm);
  return { code, text: lines.join('\n') };
}

describe('labels', () => {
  it('parses write/hold, blanks and quoted notes', () => {
    const l = parseLabels('slug,label,note\nbitcoin,write,"has a number, a date"\nadobe,HOLD,\nkospi,,\n');
    expect([...l.byslug]).toEqual([['bitcoin', 'write'], ['adobe', 'hold']]);
    expect(l.rows).toBe(3);
    expect(l.blank).toBe(1);
  });
  it('rejects a bad header and a bad label', () => {
    expect(() => parseLabels('a,b\nx,write')).toThrow(/header/);
    expect(() => parseLabels('slug,label,note\nx,maybe,')).toThrow(/row 2 \(x\): label must be write or hold/);
  });
});

describe('the real frozen set (#629)', () => {
  it('has 32 entities, a labels.csv row for each, and every row loads', () => {
    const snap = loadSnapshot(`${EVAL_DIR}snapshot.json`);
    const labels = parseLabels(readFileSync(`${EVAL_DIR}labels.csv`, 'utf8'));
    expect(snap.entities).toHaveLength(32);
    expect(labels.rows).toBe(32);
    for (const e of snap.entities) {
      const b = snapshotToBundle(e);
      expect(b.new_items.some((i) => i.id === b.newest_item_id)).toBe(true);
    }
  });

  it('with no model key and blank labels: says clearly it cannot score, and exits 0', async () => {
    const { code, text } = await run([], {});
    expect(code).toBe(0);
    expect(text).toContain('frozen entities: 32');
    expect(text).toContain('model run: SKIPPED (OLLAMA_API_KEY is not set)');
    expect(text).toContain('CANNOT SCORE: labels.csv has no labels (32 rows, 32 blank)');
    expect(text).toContain('RESULT: NOT SCORED');
  });

  it('with a model and blank labels: reports the label-free numbers, says it cannot score, and exits 0', async () => {
    const snap = loadSnapshot(`${EVAL_DIR}snapshot.json`);
    const { code, text } = await run([], {}, async () => '{"decision":"hold","reason":"thin"}');
    expect(code).toBe(0);
    expect(text).toContain(`entities run: ${snap.entities.length}`);
    expect(text).toMatch(/answers: published 0, hold 32, skip 0, error after retry 0/);
    expect(text).toContain('timeouts after retry: 0 of 32');
    expect(text).toContain('CANNOT SCORE');
    expect(text).toContain('RESULT: NOT SCORED');
  });
});

describe('scoring', () => {
  const ents = ['w1', 'w2', 'h1', 'h2', 'h3'].map((s) => entity(s));

  it('prints PASS and exits 0 when every bar is met', async () => {
    const argv = fixture('slug,label,note\nw1,write,\nw2,write,\nh1,hold,\nh2,hold,\nh3,hold,\n', ents);
    const { code, text } = await run(argv, {}, llmFor(ents));
    expect(code).toBe(0);
    expect(text).toContain('agreement with labels');
    expect(text).toMatch(/agreement with labels\s+100.0% \(5\/5\)\s+>= 80%\s+PASS/);
    expect(text).toMatch(/hold-recall\s+100.0% \(3\/3\)\s+>= 80%\s+PASS/);
    expect(text).toMatch(/untraced claims \(published\)\s+0\s+0\s+PASS/);
    expect(text).toMatch(/period mismatches \(published\)\s+0\s+0\s+PASS/);
    expect(text).toContain('warning: only 3 hold labels');
    expect(text).toContain('RESULT: PASS');
  });

  it('prints FAIL and exits 1 when the job writes entities Bibhu labelled hold (low hold-recall)', async () => {
    const argv = fixture('slug,label,note\nw1,hold,\nw2,hold,\nh1,hold,\nh2,hold,\nh3,hold,\n', ents);
    const { code, text } = await run(argv, {}, llmFor(ents));
    expect(code).toBe(1);
    expect(text).toMatch(/hold-recall\s+60.0% \(3\/5\)\s+>= 80%\s+FAIL/);
    expect(text).toContain('RESULT: FAIL');
  });

  it('counts a model skip as hold, and a write the bar holds as hold', async () => {
    const mk = (slug: string, answer: EntityResult['answer']): EntityResult => ({ slug, answer, modelDecision: null, reason: '', attempts: 1, timedOut: false, failures: [], untracedClaimsInDraft: 0, periodMismatchesInDraft: 0, untracedPublished: 0, periodMismatchesPublished: 0 });
    const labels = parseLabels('slug,label,note\na,hold,\nb,hold,\nc,write,\n');
    const s = score([mk('a', 'skip'), mk('b', 'hold'), mk('c', 'write')], labels);
    expect(s).toMatchObject({ scored: true, agreement: 1, holdRecall: 1, pass: true });
  });

  it('timeouts over 5% after retry fail the run', () => {
    const mk = (slug: string, timedOut: boolean): EntityResult => ({ slug, answer: timedOut ? 'error' : 'hold', modelDecision: null, reason: '', attempts: 3, timedOut, failures: [], untracedClaimsInDraft: 0, periodMismatchesInDraft: 0, untracedPublished: 0, periodMismatchesPublished: 0 });
    const results = [mk('a', true), ...Array.from({ length: 19 }, (_, i) => mk(`x${i}`, false))];
    const labels = parseLabels(['slug,label,note', ...results.map((r) => `${r.slug},hold,`)].join('\n'));
    const s = score(results, labels);
    expect(s.scored && s.timeoutRate).toBe(0.05);
    expect(s.scored && s.bars.find((b) => b.name.startsWith('timeouts'))!.pass).toBe(false);
  });

  it('no hold labels means hold-recall cannot pass', () => {
    const labels = parseLabels('slug,label,note\na,write,\n');
    const s = score([{ slug: 'a', answer: 'write', modelDecision: 'write', reason: '', attempts: 1, timedOut: false, failures: [], untracedClaimsInDraft: 0, periodMismatchesInDraft: 0, untracedPublished: 0, periodMismatchesPublished: 0 }], labels);
    expect(s.scored && s.bars.find((b) => b.name === 'hold-recall')).toMatchObject({ pass: false });
  });

  it('reports the draft problems the gate caught, and shows none published', async () => {
    const e = [entity('w1')];
    const llm = async () => JSON.stringify({
      decision: 'write', reason: 'r', title: 'T', what_happened: 'ETF outflows hit $2.1 billion; a hack cost 9,999 BTC.', how_we_got_here: 'x',
      what_to_watch: 'Watch the Dec 10 decision.', claims: [{ text: 'c', source_item_id: null, source_signal_id: null }],
    });
    const r = await evaluateEntity(e[0]!, llm);
    expect(r.answer).toBe('hold');
    expect(r.untracedClaimsInDraft).toBeGreaterThan(0);
    expect(r.untracedPublished).toBe(0);
  });
});

describe('retries and errors', () => {
  it('retries a timeout up to 3 attempts and then reports it', async () => {
    let calls = 0;
    const r = await evaluateEntity(entity('w1'), async () => { calls += 1; throw Object.assign(new Error('x'), { name: 'TimeoutError' }); });
    expect(calls).toBe(3);
    expect(r).toMatchObject({ answer: 'error', timedOut: true, attempts: 3 });
  });
  it('a retry that succeeds is not a timeout', async () => {
    let calls = 0;
    const r = await evaluateEntity(entity('w1'), async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      return '{"decision":"hold","reason":"thin"}';
    });
    expect(r).toMatchObject({ answer: 'hold', timedOut: false, attempts: 3 });
  });
  it('bad input exits 2 with a message', async () => {
    const argv = fixture('slug,label,note\nnope,write,\n', [entity('w1')]);
    const { code, text } = await run(argv, {});
    expect(code).toBe(2);
    expect(text).toContain('labels.csv has slugs that are not in the snapshot: nope');
    expect((await run(['--snapshot', '/nonexistent.json'], {})).code).toBe(2);
  });
});

describe('freeze override (eval only)', () => {
  it('prints a read-only query with the window and basis the person freezing chose', async () => {
    const { code, text } = await run(['--print-freeze-sql', '--hours', '72', '--basis', 'created_at', '--until', '2026-11-14T01:00:00Z', '--slugs', 'bitcoin,adobe']);
    expect(code).toBe(0);
    expect(text).toContain("interval '72 hours'");
    expect(text).toContain('i.created_at >= p.since');
    expect(text).toContain("slug in ('bitcoin','adobe')");
    expect(text).not.toMatch(/\b(insert|update|delete|drop|alter)\b/i);
  });
  it('rejects a bad basis, hours and slug', async () => {
    expect((await run(['--print-freeze-sql', '--basis', 'status'])).code).toBe(2);
    expect((await run(['--print-freeze-sql', '--hours', '0'])).code).toBe(2);
    expect((await run(['--print-freeze-sql', '--slugs', "x'); drop table atlas.entities;--"])).code).toBe(2);
  });
});
