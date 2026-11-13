/**
 * #625 intake filter in the analyst worker, on a throwaway LOCAL Postgres (ANALYST_TEST_ADMIN_URL; skipped when unset).
 * Worker connections run as analyst_worker, so the column grants the filter query relies on are proven too.
 * The LLM and deciders are stubs that count calls: a dropped signal must never reach them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';

import type { Decider } from './deciders.js';
import { InMemoryHandoffSink, processNextD36, type D36Options } from './signal-worker.js';
import type { Llm } from './session.js';

const ADMIN_URL = process.env.ANALYST_TEST_ADMIN_URL?.trim() ?? '';
const TITLE = 'Hedge funds unwind Bitcoin basis trade as CME net shorts fall 89%';

describe.skipIf(ADMIN_URL === '')('#625 intake filter (local Postgres)', () => {
  let db: ThrowawayDatabase;
  let admin: Pool;
  let worker: Pool;
  let llmCalls = 0;
  const llm: Llm = async () => { llmCalls += 1; throw new Error('stub llm'); };
  const decider = (name: 'jev' | 'clef'): Decider => ({ name, modelName: name, modelVersion: 't', async decide() { throw new Error('stub decider'); } }) as unknown as Decider;
  const logs: Record<string, unknown>[] = [];
  const opts = (o: Partial<D36Options>): D36Options => ({
    llm, primary: decider('jev'), fallback: decider('clef'), shadow: null, lookup: { async shortlist() { return []; } } as never, sink: new InMemoryHandoffSink(),
    intakeLog: (e) => logs.push(e), failLog: () => {}, leaseMs: 60_000, timeoutMs: 100, backoffMs: 3_600_000, maxAttempts: 3, worker: 'w625', ...o,
  });

  let n = 0;
  async function seed(text: string, ageMinutes: number, link?: string): Promise<string> {
    n += 1;
    const id = `s625-${n}`;
    await admin.query(
      `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at, created_at)
       values ($1, 1, 'tokens_xyz', $1, 'news', $2, $3, now() - make_interval(mins => $4), now() - make_interval(mins => $4))`,
      [id, text, link ?? `https://ex.com/${id}`, ageMinutes]);
    return id;
  }
  const row = async (id: string) => (await admin.query('select status, parked_reason from atlas.signals where signal_id = $1', [id])).rows[0];
  async function drain(o: D36Options) { const out = []; for (let i = 0; i < 10; i++) { const r = await processNextD36(worker, o); if (!r) break; out.push(r); } return out; }

  beforeAll(async () => {
    db = await createThrowawayDatabase(ADMIN_URL);
    admin = new Pool({ connectionString: db.url, max: 2 });
    worker = new Pool({ connectionString: db.url, max: 2 });
    worker.on('connect', (c) => c.query('set role analyst_worker'));
  });
  afterAll(async () => { await worker?.end(); await admin?.end(); await db?.drop(); });
  beforeEach(async () => {
    llmCalls = 0; logs.length = 0;
    await admin.query('truncate atlas.decisions, atlas.signals cascade');
  });

  it('flag off (default): nothing is filtered, every signal reaches the session', async () => {
    const a = await seed(TITLE, 120);
    const b = await seed(TITLE, 60);
    await drain(opts({}));
    expect(llmCalls).toBe(2);
    expect(logs).toHaveLength(0);
    for (const id of [a, b]) expect((await row(id)).parked_reason).toBeNull();
  });

  it('flag on: the repeat is parked with the rule and the matched signal, counted in the log, and never reaches the LLM', async () => {
    const a = await seed(TITLE, 120);
    const b = await seed(`COINTELEGRAPH: ${TITLE}`, 60);
    const c = await seed('Enjin launches Governance 2.0 system', 30);
    const results = await drain(opts({ intakeFilter: true }));
    expect(results.filter((r) => r.result === 'parked')).toHaveLength(1);
    expect(llmCalls).toBe(2); // a and c reach the (stub) session; b does not
    expect(await row(b)).toEqual({ status: 'parked', parked_reason: `intake_filter:near_dup:${a}` });
    expect((await row(a)).parked_reason).toBeNull();
    expect((await row(c)).parked_reason).toBeNull();
    expect(logs).toEqual([{ event: 'intake_filter_drop', signal_id: b, rule: 'near_dup', match_signal_id: a, score: expect.any(Number) }]);
    expect((await admin.query('select count(*)::int c from atlas.decisions')).rows[0].c).toBe(0);
  });

  it('flag on: a signal repeating one the filter already dropped is matched against the kept original, and nothing is deleted', async () => {
    const a = await seed(TITLE, 120);
    await seed(`REUTERS: ${TITLE}`, 90);
    const c = await seed(TITLE, 60);
    await drain(opts({ intakeFilter: true }));
    expect((await row(c)).parked_reason).toBe(`intake_filter:near_dup:${a}`);
    expect((await admin.query('select count(*)::int c from atlas.signals')).rows[0].c).toBe(3);
  });

  it('flag on: a repeat from more than 24 hours earlier is kept', async () => {
    await seed(TITLE, 26 * 60);
    const b = await seed(TITLE, 60);
    await drain(opts({ intakeFilter: true }));
    expect((await row(b)).parked_reason).toBeNull();
  });

  it('flag on: an empty title is parked as low_content', async () => {
    const a = await seed('???', 10);
    await drain(opts({ intakeFilter: true }));
    expect(await row(a)).toEqual({ status: 'parked', parked_reason: 'intake_filter:low_content' });
    expect(llmCalls).toBe(0);
  });

  it('flag on: if the filter query fails the signal goes on to the session (fail open) and the error is logged', async () => {
    const a = await seed(TITLE, 120);
    await seed(TITLE, 60);
    const flaky = { query: (sql: string, p?: unknown[]) => (sql.includes('parked_reason is null') ? Promise.reject(new Error('boom')) : worker.query(sql, p as never)) } as unknown as Pool;
    const o = opts({ intakeFilter: true });
    for (let i = 0; i < 2; i++) await processNextD36(flaky, o);
    expect(llmCalls).toBe(2);
    expect(logs.filter((l) => l.event === 'intake_filter_error')).toHaveLength(2);
    expect((await row(a)).parked_reason).toBeNull();
  });
});
