/**
 * #512 analyst worker run, on a throwaway LOCAL Postgres (ANALYST_TEST_ADMIN_URL). The worker pool
 * runs as the analyst_worker role from the real migration 20261030120000_atlas_analyst_worker_role.sql
 * (#514, applied by createThrowawayDatabase with its tool_log stand-in), RLS on, so the test proves
 * those grants and policies suffice. The LLM, Jev
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
