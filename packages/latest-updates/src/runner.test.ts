import { describe, expect, it } from 'vitest';

import { loadRunConfig, type RunConfig } from './config.js';
import { runOnce } from './runner.js';
import { passingCase, uuid } from './fixtures.js';
import type { Candidate, DecisionWrite, Store, WriteResult } from './store.js';
import type { Bundle } from './types.js';

const cfg = (over: Partial<RunConfig> = {}): RunConfig => ({ ...loadRunConfig({}), ...over });

function cand(slug: string, at: string): Candidate {
  return { entityId: uuid(), slug, newestItemId: uuid(), newestOccurredAt: at, errorCount: 0 };
}

/** A fake store: serves the same passing bundle for every candidate and records what it is asked to write. */
function fakeStore(candidates: Candidate[], over: Partial<Store> = {}) {
  const writes: DecisionWrite[] = [];
  const listed: Array<{ limit: number; windowHours: number }> = [];
  const store: Store = {
    async listCandidates(o) { listed.push({ limit: o.limit, windowHours: o.windowHours }); return candidates; },
    async loadBundle(c): Promise<Bundle> {
      const { bundle } = passingCase();
      return { ...bundle, entity: { ...bundle.entity, id: c.entityId, slug: c.slug }, newest_item_id: c.newestItemId, new_items: [{ ...bundle.new_items[0]!, id: c.newestItemId }] };
    },
    async record(w): Promise<WriteResult> { writes.push(w); return { outcome: 'written', decision: w.decision, attempt: 1 }; },
    ...over,
  };
  return { store, writes, listed };
}

/** A model reply that writes the passing draft, citing the candidate's newest item (what fakeStore serves). */
const writeReply = (c: Candidate, over: Record<string, unknown> = {}) => async () => JSON.stringify({
  decision: 'write', reason: 'new number', ...passingCase().draft,
  claims: [{ text: 'ETF outflow of $2.1 billion', source_item_id: c.newestItemId, source_signal_id: null }], ...over,
});

describe('runOnce decisions', () => {
  it('model write that clears the bar is published with visibility from config, linking the new items', async () => {
    const c = cand('bitcoin', '2026-11-14T06:00:00Z');
    const { store, writes } = fakeStore([c]);
    const summary = await runOnce({ store, llm: writeReply(c), config: cfg({ visibility: 'live' }) });
    expect(summary.published).toBe(1);
    expect(writes[0]).toMatchObject({ decision: 'published', entityId: c.entityId, newestItemId: c.newestItemId, checkFailures: [] });
    expect(writes[0]!.publish).toMatchObject({ model: 'glm-5.3-flash', visibility: 'live' });
    expect(writes[0]!.publish!.itemIds).toEqual([c.newestItemId]);
  });

  it('defaults to dark', async () => {
    const c = cand('bitcoin', '2026-11-14T06:00:00Z');
    const { store, writes } = fakeStore([c]);
    await runOnce({ store, llm: writeReply(c), config: cfg() });
    expect(writes[0]!.publish!.visibility).toBe('dark');
  });

  it('model write that fails the bar becomes a hold that lists the failed checks', async () => {
    const c = cand('bitcoin', '2026-11-14T06:00:00Z');
    const { store, writes } = fakeStore([c]);
    const { draft } = passingCase();
    const llm = async () => JSON.stringify({ decision: 'write', reason: 'r', ...draft, what_to_watch: 'Watch how the market reacts.', claims: [] });
    const summary = await runOnce({ store, llm, config: cfg() });
    expect(summary.hold).toBe(1);
    expect(writes[0]).toMatchObject({ decision: 'hold' });
    expect(writes[0]!.publish).toBeUndefined();
    expect(writes[0]!.checkFailures.map((f) => f.check).sort()).toEqual(['claims', 'watch']);
    expect(writes[0]!.reason).toBe('write bar failed: claims, watch');
  });

  it('model hold and skip are recorded as such, with no draft', async () => {
    const a = cand('a', '2026-11-14T01:00:00Z');
    const b = cand('b', '2026-11-14T02:00:00Z');
    const { store, writes } = fakeStore([a, b]);
    const llm = async (m: Array<{ role: string; content: string }>) => (m[1]!.content.includes('slug: a') ? '{"decision":"hold","reason":"thin"}' : '{"decision":"skip","reason":"repeat"}');
    const s = await runOnce({ store, llm, config: cfg({ concurrency: 1 }) });
    expect(s).toMatchObject({ candidates: 2, hold: 1, skip: 1, published: 0 });
    expect(writes.map((w) => [w.decision, w.reason, w.publish])).toEqual([['hold', 'thin', undefined], ['skip', 'repeat', undefined]]);
  });

  it('a timeout or bad JSON writes an error row and nothing else', async () => {
    const a = cand('a', '2026-11-14T01:00:00Z');
    const b = cand('b', '2026-11-14T02:00:00Z');
    const { store, writes } = fakeStore([a, b]);
    const llm = async (m: Array<{ role: string; content: string }>) => {
      if (m[1]!.content.includes('slug: a')) throw Object.assign(new Error('slow'), { name: 'TimeoutError' });
      return 'not json';
    };
    const s = await runOnce({ store, llm, config: cfg({ concurrency: 1 }) });
    expect(s.error).toBe(2);
    expect(writes.map((w) => [w.decision, w.publish])).toEqual([['error', undefined], ['error', undefined]]);
    expect(writes[0]!.reason).toBe('timeout: model timed out');
    expect(writes[1]!.reason).toMatch(/^bad_json:/);
  });

  it('splits the error count by reason and logs one line per error with its code and reason', async () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((slug, i) => cand(slug, `2026-11-14T0${i + 1}:00:00Z`)) as [Candidate, Candidate, Candidate, Candidate];
    const { store } = fakeStore([a, b, c, d]);
    const llm = async (m: Array<{ role: string; content: string }>) => {
      const body = m[1]!.content;
      if (body.includes('slug: a') || body.includes('slug: b')) throw Object.assign(new Error('slow'), { name: 'TimeoutError' });
      if (body.includes('slug: c')) return '{"decision":"write","reason":"r","title":"t"}';
      throw new Error('LLM HTTP 502: bad gateway');
    };
    const lines: string[] = [];
    const s = await runOnce({ store, llm, config: cfg({ concurrency: 1 }), log: (l) => lines.push(l) });
    expect(s).toMatchObject({ error: 4, error_timeout: 2, error_bad_json: 1, error_other: 1 });
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(logged.map((l) => [l.event, l.entity, l.code, l.attempt, l.recorded])).toEqual([
      ['latest_updates_entity_error', 'a', 'timeout', 1, 'error'],
      ['latest_updates_entity_error', 'b', 'timeout', 1, 'error'],
      ['latest_updates_entity_error', 'c', 'bad_json', 1, 'error'],
      ['latest_updates_entity_error', 'd', 'llm_error', 1, 'error'],
    ]);
    expect(logged[0]!.reason).toBe('model timed out');
    expect(logged[2]!.reason).toBe('write draft is missing one of the three parts');
    expect(logged[3]!.reason).toBe('LLM HTTP 502: bad gateway');
  });

  it('decisions log nothing, and a clean run reports zero in every error bucket', async () => {
    const lines: string[] = [];
    const { store } = fakeStore([cand('a', '2026-11-14T01:00:00Z')]);
    const s = await runOnce({ store, llm: async () => '{"decision":"hold","reason":"thin"}', config: cfg(), log: (l) => lines.push(l) });
    expect(s).toMatchObject({ hold: 1, error: 0, error_timeout: 0, error_bad_json: 0, error_other: 0 });
    expect(lines).toEqual([]);
  });

  it('a third failure still logs its reason, but counts as retries_exhausted, not in an error bucket', async () => {
    const lines: string[] = [];
    const { store } = fakeStore([cand('a', '2026-11-14T01:00:00Z')], {
      async record(w) { return { outcome: 'written', decision: w.decision === 'error' ? 'hold' : w.decision, attempt: 3 }; },
    });
    const llm = async () => { throw Object.assign(new Error('slow'), { name: 'TimeoutError' }); };
    const s = await runOnce({ store, llm, config: cfg(), log: (l) => lines.push(l) });
    expect(s).toMatchObject({ hold: 1, retries_exhausted: 1, error: 0, error_timeout: 0 });
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'latest_updates_entity_error', code: 'timeout', attempt: 3, recorded: 'hold' });
  });

  it('counts a third failed attempt (the store turns it into a hold) as retries_exhausted', async () => {
    const { store } = fakeStore([cand('a', '2026-11-14T01:00:00Z')], {
      async record(w) { return { outcome: 'written', decision: w.decision === 'error' ? 'hold' : w.decision, attempt: 3 }; },
    });
    const s = await runOnce({ store, llm: async () => 'oops', config: cfg() });
    expect(s).toMatchObject({ hold: 1, retries_exhausted: 1, error: 0 });
  });

  it('already_decided and a missing bundle are counted and nothing else happens', async () => {
    const a = cand('a', '2026-11-14T01:00:00Z');
    const b = cand('b', '2026-11-14T02:00:00Z');
    let calls = 0;
    const { store } = fakeStore([a, b], {
      async loadBundle(c) { if (c.slug === 'b') return null; return passingCase().bundle; },
      async record() { return { outcome: 'already_decided' }; },
    });
    const s = await runOnce({ store, llm: async () => { calls += 1; return '{"decision":"hold","reason":"x"}'; }, config: cfg({ concurrency: 1 }) });
    expect(s).toMatchObject({ already_decided: 1, no_bundle: 1, hold: 0 });
    expect(calls).toBe(1);
  });
});

describe('cap, order, budget, isolation', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => cand(`e${String(i).padStart(2, '0')}`, `2026-11-14T0${Math.floor(i / 10)}:${String((i % 10) * 5).padStart(2, '0')}:00Z`));
  const hold = async () => '{"decision":"hold","reason":"x"}';

  it('asks the store for at most MAX_PER_RUN, oldest first, and never handles more', async () => {
    const list = many(10);
    const { store, writes, listed } = fakeStore(list);
    const s = await runOnce({ store, llm: hold, config: cfg({ maxPerRun: 4, concurrency: 1 }) });
    expect(listed).toEqual([{ limit: 4, windowHours: 24 }]);
    expect(s.candidates).toBe(4);
    expect(writes.map((w) => w.entityId)).toEqual(list.slice(0, 4).map((c) => c.entityId));
  });

  it('defaults to a cap of 25', async () => {
    const { store, writes } = fakeStore(many(40));
    await runOnce({ store, llm: hold, config: cfg() });
    expect(writes).toHaveLength(25);
  });

  it('stops starting entities when the run budget is spent, and exits cleanly', async () => {
    let t = 0;
    const clock = () => t;
    const { store, writes } = fakeStore(many(6));
    const llm = async () => { t += 400; return '{"decision":"hold","reason":"x"}'; };
    const s = await runOnce({ store, llm, config: cfg({ runBudgetMs: 1000, concurrency: 1 }), clock });
    expect(writes).toHaveLength(3);
    expect(s.budget_stopped).toBe(3);
    expect(s.failed).toBe(0);
  });

  it('never has more than `concurrency` model calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const { store } = fakeStore(many(8));
    const llm = async () => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight -= 1; return '{"decision":"hold","reason":"x"}'; };
    await runOnce({ store, llm, config: cfg({ concurrency: 3 }) });
    expect(peak).toBe(3);
  });

  it('one entity failing in the store does not stop the others, and is logged without secrets', async () => {
    const logs: string[] = [];
    const { store, writes } = fakeStore(many(3), {
      async record(w) { if (writes.length === 1) { writes.push(w); throw new Error('connection terminated'); } writes.push(w); return { outcome: 'written', decision: w.decision, attempt: 1 }; },
    });
    const s = await runOnce({ store, llm: hold, config: cfg({ concurrency: 1 }), log: (l) => logs.push(l) });
    expect(s.failed).toBe(1);
    expect(s.hold).toBe(2);
    expect(JSON.parse(logs[0]!)).toMatchObject({ level: 'error', event: 'latest_updates_entity_failed', error: 'connection terminated' });
  });

  it('with no candidates it does nothing', async () => {
    const { store, writes } = fakeStore([]);
    const s = await runOnce({ store, llm: async () => { throw new Error('must not be called'); }, config: cfg() });
    expect(s.candidates).toBe(0);
    expect(writes).toEqual([]);
  });
});
