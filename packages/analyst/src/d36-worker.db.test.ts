/**
 * #504 D36 analyst worker on a throwaway LOCAL Postgres (ANALYST_TEST_ADMIN_URL). Claim and finish use the
 * existing atlas.signal_* functions (#478/#479). The decision write goes to a DecisionSink: the in-memory sink
 * here; the atlas.decisions write lands with #503. The LLM, Jev and Clef are scripted (answers, errors, timeouts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';

import { DeciderError, type Decider, type DecisionCase } from './deciders.js';
import { InMemoryDecisionSink, processNextD36, shelfSearchFromDb, type D36Options } from './d36-worker.js';
import type { ChatMessage, JevLogEntry, Llm } from './session.js';
import { spikeCases, spikeShelves } from './test-fixtures/d36-spike.js';

const ADMIN_URL = process.env.ANALYST_TEST_ADMIN_URL?.trim() ?? '';
const KALSHI = spikeCases[5].signal; // a real scout signal (Cointelegraph via tokens_xyz)

type Rule = (c: DecisionCase) => string | 'error' | 'timeout';
/** Scripted decider: a rule maps each case to a choice, an error or a hang until abort. */
function scripted(name: 'jev' | 'clef', rule: Rule): Decider & { calls: number } {
  const d = {
    name, modelName: name, modelVersion: `${name}-test`, calls: 0,
    async decide(c: DecisionCase, signal: AbortSignal) {
      d.calls += 1;
      const r = rule(c);
      if (r === 'timeout') return new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
      if (r === 'error') throw new DeciderError('error', `${name} 503`);
      return { choice: r, probabilities: { [r]: 0.9 } };
    },
  };
  return d;
}
const keepAll: Rule = (c) => (c.choices.includes('keep') ? 'keep' : c.choices.includes('new_story') ? 'existing_story' : 'existing');

/** Scripted LLM for the Kalshi signal: dissect, reasoning, notes (ignore path uses the 2nd reply as the reason). */
function kalshiLlm(o: { fail?: boolean } = {}): Llm & { turns: number } {
  const replies = [
    { summary: 'Kalshi raised $1B at a $40B valuation, per Cointelegraph.', mentions: [{ name: 'Kalshi', type: 'organization', search_terms: [] }] },
    { reasoning: [{ mention: 'Kalshi', reasoning: 'Continues its growth story.' }], reason: 'Not interesting.' },
    { targets: [{ mention: 'Kalshi', type: 'organization', note: 'Cointelegraph reports the raise.' }], reason: 'Routed.' },
  ];
  const llm = (async (_m: ChatMessage[]) => {
    llm.turns += 1;
    if (o.fail) throw new Error('LLM HTTP 500');
    return JSON.stringify(replies[Math.min(llm.turns - 1, replies.length - 1)]);
  }) as Llm & { turns: number };
  llm.turns = 0;
  return llm;
}

describe.skipIf(ADMIN_URL === '')('#504 D36 analyst worker (local Postgres)', () => {
  let db: ThrowawayDatabase;
  let pool: Pool;
  let sink: InMemoryDecisionSink;
  const logs: JevLogEntry[] = [];
  const opts = (o: Partial<D36Options>): D36Options => ({
    llm: kalshiLlm(), primary: scripted('jev', keepAll), fallback: scripted('clef', keepAll), shadow: null,
    search: shelfSearchFromDb(pool), sink, log: (e) => logs.push(e),
    leaseMs: 60_000, timeoutMs: 100, backoffMs: 60_000, maxAttempts: 3, worker: 'w504', ...o,
  });
  const sig = async () => (await pool.query(
    'select status, parked_reason, attempts::int attempts, last_error, claim_token from atlas.signals where signal_id = $1', [KALSHI.signal_id])).rows[0];

  beforeAll(async () => {
    db = await createThrowawayDatabase(ADMIN_URL);
    pool = new Pool({ connectionString: db.url, max: 4 });
  });
  afterAll(async () => { await pool?.end(); await db?.drop(); });
  beforeEach(async () => {
    logs.length = 0;
    sink = new InMemoryDecisionSink();
    await pool.query('truncate atlas.item_signals, atlas.decisions, atlas.signals cascade');
    await pool.query('delete from atlas.shelves');
    for (const s of spikeShelves) {
      await pool.query('insert into atlas.shelves (slug, name, type, aliases) values ($1, $2, $3, $4)', [s.slug, s.name, s.type, s.aliases]);
    }
    await pool.query(
      `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
       values ($1, 1, $2, $3, 'news', $4, $5, now())`,
      [KALSHI.signal_id, KALSHI.source ?? 'tokens_xyz', 'src-kalshi', KALSHI.text, KALSHI.link]);
  });

  it('keep: the signal is analysed and one output with Jev-decided targets is saved', async () => {
    const r = await processNextD36(pool, opts({}));
    expect(r).toMatchObject({ signalId: KALSHI.signal_id, result: 'analysed' });
    expect(await sig()).toMatchObject({ status: 'analysed', claim_token: null });
    expect(sink.outputs()).toHaveLength(1);
    expect(sink.outputs()[0]).toMatchObject({ decision: 'keep', analyst_version: 'analyst-504-v1', schema_version: 1,
      targets: [{ entity: 'kalshi', kind: 'existing', type: 'organization', angle: 'existing_story' }] });
    expect(logs.map((l) => l.provider)).toEqual(['jev', 'jev', 'jev']);
  });

  it('ignore: the signal is analysed and the output has a reason and no targets', async () => {
    const r = await processNextD36(pool, opts({ primary: scripted('jev', () => 'ignore') }));
    expect(r?.result).toBe('analysed');
    expect(sink.outputs()[0]).toMatchObject({ decision: 'ignore', reason: 'Not interesting.', targets: [] });
  });

  it('unclear: the signal is parked with the reason', async () => {
    const r = await processNextD36(pool, opts({ primary: scripted('jev', (c) => (c.choices.includes('keep') ? 'keep' : 'banana')) }));
    expect(r?.result).toBe('parked');
    const s = await sig();
    expect(s.status).toBe('parked');
    expect(s.parked_reason).toMatch(/banana/);
    expect(sink.outputs()[0]).toMatchObject({ decision: 'unclear', targets: [] });
  });

  it('Jev times out: Clef answers (fallback) and the signal is analysed', async () => {
    const clef = scripted('clef', keepAll);
    const r = await processNextD36(pool, opts({ primary: scripted('jev', () => 'timeout'), fallback: clef }));
    expect(r?.result).toBe('analysed');
    expect(clef.calls).toBe(3);
    expect(logs.every((l) => l.provider === 'clef')).toBe(true);
    expect(sink.outputs()).toHaveLength(1);
  });

  it('Jev and Clef both fail: the signal stays unfinished (received, claim cleared, attempt counted) and is retried', async () => {
    const r = await processNextD36(pool, opts({ primary: scripted('jev', () => 'error'), fallback: scripted('clef', () => 'timeout') }));
    expect(r?.result).toBe('failed');
    const s = await sig();
    expect(s).toMatchObject({ status: 'received', attempts: 1, claim_token: null });
    expect(s.last_error).toMatch(/jev/);
    expect(s.last_error).toMatch(/clef/);
    expect(sink.outputs()).toHaveLength(0);
    await pool.query('update atlas.signals set next_attempt_at = now() where signal_id = $1', [KALSHI.signal_id]);
    expect((await processNextD36(pool, opts({})))?.result).toBe('analysed');
  });

  it('the LLM fails: the signal stays unfinished and is retried', async () => {
    const r = await processNextD36(pool, opts({ llm: kalshiLlm({ fail: true }) }));
    expect(r?.result).toBe('failed');
    expect(await sig()).toMatchObject({ status: 'received', attempts: 1 });
    expect(sink.outputs()).toHaveLength(0);
  });

  it('the Clef shadow is off by default and never changes the output when on', async () => {
    const shadow = scripted('clef', () => 'ignore');
    await processNextD36(pool, opts({}));
    expect(shadow.calls).toBe(0);
    await pool.query("update atlas.signals set status = 'received', next_attempt_at = now() where signal_id = $1", [KALSHI.signal_id]);
    sink = new InMemoryDecisionSink();
    await processNextD36(pool, opts({ shadow, sink }));
    expect(shadow.calls).toBe(3);
    expect(sink.outputs()[0]).toMatchObject({ decision: 'keep', targets: [{ entity: 'kalshi' }] });
  });

  it('the same signal processed twice keeps one output in the sink', async () => {
    await processNextD36(pool, opts({}));
    await pool.query("update atlas.signals set status = 'received', next_attempt_at = now() where signal_id = $1", [KALSHI.signal_id]);
    await processNextD36(pool, opts({}));
    expect(sink.outputs()).toHaveLength(1);
  });

  it('nothing due: returns null', async () => {
    await pool.query("update atlas.signals set next_attempt_at = now() + interval '1 hour'");
    expect(await processNextD36(pool, opts({}))).toBeNull();
  });

  it.todo('the same signal processed twice gives one atlas.decisions row (pending #503 schema)');
});
