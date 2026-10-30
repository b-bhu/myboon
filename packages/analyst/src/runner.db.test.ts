/**
 * #512 analyst worker run, on a throwaway LOCAL Postgres (ANALYST_TEST_ADMIN_URL). The worker pool
 * runs as a test analyst_worker role with DB Guy's grants and RLS policies (mirrored below, RLS on),
 * so the test proves they suffice; DB Guy ships the real role migration separately. The LLM, Jev
 * and Clef are scripted. One run processes due signals up to the cap, writes through
 * PgDecisionSink, logs one summary line and ends its pool.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';

import { DeciderError, type Decider, type DecisionCase } from './deciders.js';
import { PgDecisionSink, shelfSearchFromDb, type D36Options } from './d36-worker.js';
import { analystMain, runAnalystOnce } from './runner.js';
import type { ChatMessage, Llm } from './session.js';
import { spikeCases, spikeShelves } from './test-fixtures/d36-spike.js';

const ADMIN_URL = process.env.ANALYST_TEST_ADMIN_URL?.trim() ?? '';
const KALSHI = spikeCases[5].signal;

/**
 * Mirror of DB Guy's analyst_worker grant + RLS policy SQL on #512 (issuecomment-6517565746; the real
 * migration is 20261030120000_analyst_worker_role.sql, his PR). decisions/items/shelves use the same
 * INSERT and SELECT column lists service_role has today (20261025114823, 20261027120000, 20261029180000).
 * atlas.tool_log is skipped on plain local Postgres (pg_cron), so its sequence grant and policy are guarded.
 * RLS stays on for every atlas table (atlas_core enables it).
 */
const ANALYST_WORKER_GRANTS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'analyst_worker') then
      create role analyst_worker nologin noinherit;
    end if;
  end $$;
  grant usage on schema atlas to analyst_worker;
  grant select (signal_id, source, source_id, status, text, excerpt, link, occurred_at, created_at,
                attempts, claim_token, claim_expires_at, claimed_by, last_error, next_attempt_at, parked_reason)
    on atlas.signals to analyst_worker;
  grant update (status, attempts, claim_token, claim_expires_at, claimed_by, last_error, next_attempt_at, parked_reason)
    on atlas.signals to analyst_worker;
  grant insert on atlas.decisions to analyst_worker;
  grant select (signal_id, summary, decision, targets) on atlas.decisions to analyst_worker;
  grant select on atlas.items to analyst_worker;
  grant insert (item_key, title, summary, main_shelf_id, occurred_at, signal_id, angle, note) on atlas.items to analyst_worker;
  grant select on atlas.shelves to analyst_worker;
  grant insert (slug, name, type, aliases, summary, status) on atlas.shelves to analyst_worker;
  grant execute on function atlas.signal_claim, atlas.signal_fail, atlas.signal_finish,
                            atlas.analyst_targets_valid to analyst_worker;
  create policy analyst_worker_select on atlas.signals   for select to analyst_worker using (true);
  create policy analyst_worker_update on atlas.signals   for update to analyst_worker using (true) with check (true);
  create policy analyst_worker_select on atlas.decisions for select to analyst_worker using (true);
  create policy analyst_worker_insert on atlas.decisions for insert to analyst_worker with check (true);
  create policy analyst_worker_select on atlas.items     for select to analyst_worker using (true);
  create policy analyst_worker_insert on atlas.items     for insert to analyst_worker with check (true);
  create policy analyst_worker_select on atlas.shelves   for select to analyst_worker using (true);
  create policy analyst_worker_insert on atlas.shelves   for insert to analyst_worker with check (true);
  do $$ begin
    if pg_catalog.to_regclass('atlas.tool_log') is not null then
      execute 'grant insert on atlas.tool_log to analyst_worker';
      execute 'grant usage on sequence atlas.tool_log_id_seq to analyst_worker';
      execute 'create policy analyst_worker_insert on atlas.tool_log for insert to analyst_worker with check (true)';
    end if;
  end $$;
`;

type Rule = (c: DecisionCase) => string | 'error';
function scripted(name: 'jev' | 'clef', rule: Rule): Decider {
  return {
    name, modelName: name, modelVersion: `${name}-test`,
    async decide(c: DecisionCase) {
      const r = rule(c);
      if (r === 'error') throw new DeciderError('error', `${name} 503`);
      return { choice: r, probabilities: { [r]: 0.9 } };
    },
  } as Decider;
}
const keepAll: Rule = (c) => (c.choices.includes('keep') ? 'keep' : c.choices.includes('new_story') ? 'existing_story' : 'existing');

/** Scripted LLM: the reply depends on how many turns this session has already had, so each signal gets a fresh script. */
const kalshiLlm: Llm = async (messages: ChatMessage[]) => {
  const turn = messages.filter((m) => m.role === 'assistant').length;
  const replies = [
    { summary: 'Kalshi raised $1B at a $40B valuation, per Cointelegraph.', mentions: [{ name: 'Kalshi', type: 'organization', search_terms: [] }] },
    { reasoning: [{ mention: 'Kalshi', reasoning: 'Continues its growth story.' }], reason: 'Not interesting.' },
    { targets: [{ mention: 'Kalshi', type: 'organization', note: 'Cointelegraph reports the raise.' }], reason: 'Routed.' },
  ];
  return JSON.stringify(replies[Math.min(turn, replies.length - 1)]);
};

describe.skipIf(ADMIN_URL === '')('#512 analyst worker run (local Postgres, analyst_worker role)', () => {
  let db: ThrowawayDatabase;
  let pool: Pool;
  let workerPool: Pool;
  const workerPoolFor = (url: string) => {
    const p = new Pool({ connectionString: url, max: 2 });
    p.on('connect', (c) => c.query('set role analyst_worker'));
    return p;
  };
  const opts = (o: Partial<D36Options> = {}): D36Options => ({
    llm: kalshiLlm, primary: scripted('jev', keepAll), fallback: scripted('clef', keepAll), shadow: null,
    search: shelfSearchFromDb(workerPool), sink: new PgDecisionSink(workerPool, () => {}), log: () => {},
    leaseMs: 60_000, timeoutMs: 1_000, backoffMs: 60_000, maxAttempts: 3, worker: 'w512', ...o,
  });
  const seedSignals = async (n: number) => {
    for (let i = 0; i < n; i += 1) {
      await pool.query(
        `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
         values ($1, 1, $2, $3, 'news', $4, $5, now() - ($6 || ' minutes')::interval)`,
        [`${KALSHI.signal_id}-${i}`, KALSHI.source ?? 'tokens_xyz', `src-kalshi-${i}`, KALSHI.text, KALSHI.link, String(i)]);
    }
  };
  const statuses = async () => (await pool.query<{ status: string; n: number }>(
    'select status, count(*)::int n from atlas.signals group by status order by status')).rows;

  beforeAll(async () => {
    db = await createThrowawayDatabase(ADMIN_URL);
    pool = new Pool({ connectionString: db.url, max: 2 });
    await pool.query(ANALYST_WORKER_GRANTS);
    workerPool = workerPoolFor(db.url);
  });
  afterAll(async () => { await workerPool?.end(); await pool?.end(); await db?.drop(); });
  beforeEach(async () => {
    await pool.query('truncate atlas.item_signals, atlas.items, atlas.decisions, atlas.signals cascade');
    await pool.query('delete from atlas.shelves');
    for (const s of spikeShelves) {
      await pool.query('insert into atlas.shelves (slug, name, type, aliases) values ($1, $2, $3, $4)', [s.slug, s.name, s.type, s.aliases]);
    }
  });

  it('RLS is on for every atlas table the worker touches', async () => {
    const { rows } = await pool.query<{ relname: string; on: boolean }>(
      `select c.relname, c.relrowsecurity as on from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'atlas' and c.relname = any($1) order by c.relname`, [['decisions', 'items', 'shelves', 'signals']]);
    expect(rows).toEqual(['decisions', 'items', 'shelves', 'signals'].map((relname) => ({ relname, on: true })));
  });

  it('processes every due signal as analyst_worker and writes decisions and items through PgDecisionSink', async () => {
    await seedSignals(3);
    const lines: string[] = [];
    const s = await runAnalystOnce(workerPool, opts(), { maxSignals: 20, log: (l) => lines.push(l) });
    expect(s).toEqual({ processed: 3, analysed: 3, parked: 0, failed: 0, lost_claim: 0 });
    expect(await statuses()).toEqual([{ status: 'analysed', n: 3 }]);
    expect((await pool.query('select count(*)::int n from atlas.decisions')).rows[0].n).toBe(3);
    expect((await pool.query('select count(*)::int n from atlas.items')).rows[0].n).toBe(3);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'analyst_run', processed: 3, analysed: 3 });
  });

  it('stops at the per-run cap and leaves the rest for the next tick', async () => {
    await seedSignals(5);
    const s = await runAnalystOnce(workerPool, opts(), { maxSignals: 2, log: () => {} });
    expect(s.processed).toBe(2);
    expect(await statuses()).toEqual([{ status: 'analysed', n: 2 }, { status: 'received', n: 3 }]);
  });

  it('an empty queue is a clean zero run', async () => {
    expect(await runAnalystOnce(workerPool, opts(), { maxSignals: 20, log: () => {} }))
      .toEqual({ processed: 0, analysed: 0, parked: 0, failed: 0, lost_claim: 0 });
  });

  it('Jev and Clef both failing counts as failed and the signal waits for a retry; the run does not throw', async () => {
    await seedSignals(1);
    const s = await runAnalystOnce(workerPool, opts({ primary: scripted('jev', () => 'error'), fallback: scripted('clef', () => 'error') }),
      { maxSignals: 20, log: () => {} });
    expect(s).toMatchObject({ processed: 1, failed: 1, analysed: 0 });
    const row = (await pool.query('select status, attempts::int attempts from atlas.signals')).rows[0];
    expect(row).toEqual({ status: 'received', attempts: 1 });
  });

  it('analystMain with the flag-on wiring: builds the pool from ANALYST_DATABASE_URL, runs once, ends the pool', async () => {
    await seedSignals(2);
    let created: Pool | null = null;
    let ended = false;
    const lines: string[] = [];
    const summary = await analystMain({
      env: { ANALYST_DATABASE_URL: db.url, OLLAMA_API_KEY: 'k', JEV_API_TOKEN: 't', ANALYST_WORKER: 'w512-main' },
      createPool: (url) => {
        const p = workerPoolFor(url);
        const end = p.end.bind(p);
        p.end = (async () => { ended = true; await end(); }) as Pool['end'];
        created = p;
        return p;
      },
      createLlm: () => kalshiLlm,
      createDeciders: () => ({ primary: scripted('jev', keepAll), fallback: scripted('clef', keepAll), shadow: null }),
      log: (l) => lines.push(l),
    });
    expect(created).not.toBeNull();
    expect(ended).toBe(true);
    expect(summary).toMatchObject({ processed: 2, analysed: 2 });
    expect((await pool.query("select count(*)::int n from atlas.signals where claimed_by is null and status = 'analysed'")).rows[0].n).toBe(2);
    expect(lines.some((l) => l.includes('"analyst_run"'))).toBe(true);
  });
});
