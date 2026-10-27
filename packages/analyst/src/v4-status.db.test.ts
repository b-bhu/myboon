/**
 * Issue #478 (rewritten Oct 27): status + claim columns on atlas.signals, decisions
 * with Jev provenance, Jev default / Clef fallback / Clef shadow. Behaviour tests on a
 * throwaway LOCAL Postgres; deciders are scripted (answers, errors, timeouts, out of credit).
 * Assertions read DB state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Pool } from 'pg';
import { newsSampleSignals } from '@myboon/contracts/test-fixtures';
import { MIGRATIONS_DIR, ROLLBACKS_DIR, applySqlFile, createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';

import {
  DeciderError,
  claimNext,
  failClaim,
  finishClaim,
  processNext,
  type Decider,
  type DecisionCase,
  type ProcessOptions,
} from './index.js';

const ADMIN_URL = process.env.ANALYST_TEST_ADMIN_URL?.trim() ?? '';
const MIGRATION = '20261027120000_atlas_signal_status.sql';
const ROLLBACK = '20261027120000_atlas_signal_status.down.sql';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Step = { choice: string; probabilities: Record<string, number> } | 'error' | 'timeout' | 'out_of_credit';

/** Scripted decider: replays steps (last one repeats); counts calls per signal. */
function scripted(name: 'jev' | 'clef', steps: Step[], delayMs = 0): Decider & { calls: number } {
  const d = {
    name,
    modelName: name === 'jev' ? 'jev' : 'clef',
    modelVersion: name === 'jev' ? 'jev-1.13.0' : 'clef-test',
    calls: 0,
    async decide(_c: DecisionCase, signal: AbortSignal) {
      const step = steps[Math.min(d.calls, steps.length - 1)];
      d.calls += 1;
      if (delayMs) await sleep(delayMs);
      if (step === 'timeout') return new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
      if (step === 'error') throw new DeciderError('error', `${name} 503`);
      if (step === 'out_of_credit') throw new DeciderError('out_of_credit', `${name} 402 payment required`);
      return step;
    },
  };
  return d;
}

const YES: Step = { choice: 'new_story', probabilities: { new_story: 0.82, adds_nothing: 0.12, link: 0.06 } };
const NO: Step = { choice: 'adds_nothing', probabilities: { new_story: 0.2, adds_nothing: 0.7, link: 0.1 } };

const buildCase = (s: { signal_id: string; text: string | null }): DecisionCase => ({
  question: 'Does this signal start a new story?',
  choices: ['new_story', 'adds_nothing', 'link'],
  shortlist: [{ slug: 'bitcoin', score: 2 }, { slug: 'xrp', score: 1 }],
  itemIds: ['00000000-0000-7000-8000-000000000001'],
  state: { signal_id: s.signal_id, text: s.text },
});

describe.skipIf(ADMIN_URL === '')('#478 V4 signal status, decider slot and decision provenance (local Postgres)', () => {
  let db: ThrowawayDatabase;
  let pool: Pool;
  const ids = newsSampleSignals.map((s) => s.signal_id);
  const opts = (o: Partial<ProcessOptions> & Pick<ProcessOptions, 'primary' | 'fallback' | 'shadow'>): ProcessOptions => ({
    buildCase, promptVersion: 'story-v1', leaseMs: 60_000, timeoutMs: 200, backoffMs: 60_000, maxAttempts: 3, worker: 'w1', ...o,
  });
  const sig = async (id: string) => (await pool.query(
    `select status, parked_reason, attempts::int attempts, last_error, claim_token, next_attempt_at > now() backing_off
       from atlas.signals where signal_id = $1`, [id])).rows[0];
  const decisionsFor = async (id: string) => (await pool.query('select * from atlas.decisions where signal_id = $1', [id])).rows;
  const statusCounts = async () => Object.fromEntries((await pool.query<{ status: string; n: number }>(
    'select status, count(*)::int n from atlas.signals group by status order by 1')).rows.map((r) => [r.status, r.n]));

  beforeAll(async () => {
    db = await createThrowawayDatabase(ADMIN_URL);
    pool = new Pool({ connectionString: db.url, max: 8 });
  });
  afterAll(async () => { await pool?.end(); await db?.drop(); });
  beforeEach(async () => {
    await pool.query('truncate atlas.item_signals, atlas.decisions, atlas.signals cascade');
    for (const s of newsSampleSignals) {
      await pool.query(
        `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [s.signal_id, s.schema_version, s.source, s.source_id, s.type, s.text, s.link, s.occurred_at]);
    }
  });

  it('a new scout signal is received and claimable by default (the scout insert is the handoff)', async () => {
    expect(await statusCounts()).toEqual({ received: ids.length });
    expect(await pool.query(`select 1 from pg_tables where schemaname = 'atlas' and tablename in ('signal_queue','signal_states','jev_decisions')`)).toMatchObject({ rowCount: 0 });
  });

  it('crash mid-item: after claim_expires_at the next claim picks it up and it ends with exactly one decision', async () => {
    await pool.query(`update atlas.signals set next_attempt_at = now() + interval '1 hour' where signal_id <> $1`, [ids[0]]);
    const first = await claimNext(pool, { leaseMs: 50, worker: 'crashy' });
    expect(first?.signalId).toBe(ids[0]);
    expect(await claimNext(pool, { leaseMs: 60_000, worker: 'other' })).toBeNull(); // held, not expired
    await sleep(120);
    const res = await processNext(pool, opts({ primary: scripted('jev', [YES]), fallback: scripted('clef', [YES]), shadow: scripted('clef', [YES]) }));
    expect(res?.signalId).toBe(ids[0]);
    expect(await finishClaim(pool, first!, { status: 'analysed' })).toBe(false); // stale token
    expect(await sig(ids[0])).toMatchObject({ status: 'analysed', attempts: 2, claim_token: null });
    expect(await decisionsFor(ids[0])).toHaveLength(1);
  });

  it('two workers claiming at once: no signal is ever held by both', async () => {
    const claims = (await Promise.all(Array.from({ length: 8 }, (_, i) => claimNext(pool, { leaseMs: 60_000, worker: `w${i}` })))).filter((c) => c !== null);
    const got = claims.map((c) => c!.signalId);
    expect(new Set(got).size).toBe(got.length);
    expect(got.length).toBe(ids.length);
  });

  it.each(['error', 'timeout', 'out_of_credit'] as const)('Jev %s: Clef decides, decided_by = clef, the attempt is recorded', async (failure) => {
    const target = ids[0];
    await pool.query(`update atlas.signals set next_attempt_at = now() + interval '1 hour' where signal_id <> $1`, [target]);
    await processNext(pool, opts({ primary: scripted('jev', [failure]), fallback: scripted('clef', [YES]), shadow: scripted('clef', [YES]) }));
    expect(await sig(target)).toMatchObject({ status: 'analysed', attempts: 1 });
    const [d] = await decisionsFor(target);
    expect(d).toMatchObject({ decided_by: 'clef', model_name: 'clef', model_version: 'clef-test', outcome: 'decided' });
    expect(d.primary_error).toMatch(failure === 'timeout' ? /timeout/ : failure === 'out_of_credit' ? /out_of_credit/ : /error/);
  });

  it('Jev and Clef both fail: attempts, last_error, backoff; after the cap status = dead, never lost', async () => {
    const target = ids[0];
    await pool.query(`update atlas.signals set next_attempt_at = now() + interval '1 hour' where signal_id <> $1`, [target]);
    const run = () => processNext(pool, opts({ primary: scripted('jev', ['error']), fallback: scripted('clef', ['timeout']), shadow: scripted('clef', ['error']) }));
    await run();
    expect(await sig(target)).toMatchObject({ status: 'received', attempts: 1, backing_off: true });
    expect((await sig(target)).last_error).toMatch(/clef/);
    expect(await run()).toBeNull(); // backing off: not due
    for (let i = 2; i <= 3; i++) {
      await pool.query('update atlas.signals set next_attempt_at = now() where signal_id = $1', [target]);
      await run();
    }
    expect(await sig(target)).toMatchObject({ status: 'dead', attempts: 3, claim_token: null });
    expect(await decisionsFor(target)).toHaveLength(0);
    expect(Number((await pool.query('select count(*) n from atlas.signals')).rows[0].n)).toBe(ids.length);
    await pool.query('update atlas.signals set next_attempt_at = now() where signal_id = $1', [target]);
    expect(await run()).toBeNull(); // dead is never claimed
  });

  it('shadow disagrees: the shadow answer is saved and the outcome follows Jev only; a failing shadow never blocks', async () => {
    await pool.query(`update atlas.signals set next_attempt_at = now() + interval '1 hour' where signal_id not in ($1, $2)`, [ids[0], ids[1]]);
    await processNext(pool, opts({ primary: scripted('jev', [YES]), fallback: scripted('clef', [NO]), shadow: scripted('clef', [NO]) }));
    await processNext(pool, opts({ primary: scripted('jev', [YES]), fallback: scripted('clef', [NO]), shadow: scripted('clef', ['error']) }));
    const rows = (await pool.query('select signal_id, decided_by, answer, shadow_answer, shadow_outcome, shadow_model_version, shadow_probabilities from atlas.decisions order by signal_id')).rows;
    expect(rows).toHaveLength(2);
    const ok = rows.find((r) => r.shadow_outcome === 'decided')!;
    const bad = rows.find((r) => r.shadow_outcome === 'error')!;
    expect(ok).toMatchObject({ decided_by: 'jev', answer: { choice: 'new_story' }, shadow_answer: { choice: 'adds_nothing' }, shadow_model_version: 'clef-test' });
    expect(ok.shadow_probabilities).toMatchObject({ adds_nothing: 0.7 });
    expect(bad).toMatchObject({ decided_by: 'jev', answer: { choice: 'new_story' }, shadow_answer: null });
    expect(await statusCounts()).toMatchObject({ analysed: 2 });
  });

  it('reprocessing (rerun or expired claim) leaves at most one decision and one entity_item per signal', async () => {
    const target = ids[0];
    await pool.query(`update atlas.signals set next_attempt_at = now() + interval '1 hour' where signal_id <> $1`, [target]);
    const deciders = { primary: scripted('jev', [YES]), fallback: scripted('clef', [YES]), shadow: scripted('clef', [YES]) };
    await processNext(pool, opts(deciders));
    await pool.query(`update atlas.signals set status = 'received', next_attempt_at = now() where signal_id = $1`, [target]); // forced rerun
    await processNext(pool, opts(deciders));
    expect(await decisionsFor(target)).toHaveLength(1);
    await expect(pool.query(`insert into atlas.decisions (schema_version, signal_id, analyst_version, action) values (1, $1, 'other-version', 'keep')`, [target])).rejects.toThrow(/unique|duplicate/);
    const shelf = (await pool.query(`insert into atlas.shelves (slug, name, type) values ('t','T','topic') returning id`)).rows[0].id;
    const items = (await pool.query(`insert into atlas.items (item_key, title, main_shelf_id) values ('i1','I1',$1), ('i2','I2',$1) returning id`, [shelf])).rows;
    await pool.query('insert into atlas.item_signals (item_id, signal_id) values ($1, $2)', [items[0].id, target]);
    await expect(pool.query('insert into atlas.item_signals (item_id, signal_id) values ($1, $2)', [items[1].id, target])).rejects.toThrow(/unique|duplicate/);
  });

  it('Jev answers: the decision stores shortlist, item ids, prompt version, model and version, every probability, runner-up margin, latency and outcome', async () => {
    const target = ids[0];
    await pool.query(`update atlas.signals set next_attempt_at = now() + interval '1 hour' where signal_id <> $1`, [target]);
    await processNext(pool, opts({ primary: scripted('jev', [YES], 20), fallback: scripted('clef', [NO]), shadow: scripted('clef', [NO]) }));
    const [d] = await decisionsFor(target);
    expect(d).toMatchObject({
      shortlist: [{ slug: 'bitcoin', score: 2 }, { slug: 'xrp', score: 1 }],
      item_ids: ['00000000-0000-7000-8000-000000000001'],
      prompt_version: 'story-v1',
      model_name: 'jev',
      model_version: 'jev-1.13.0',
      decided_by: 'jev',
      outcome: 'decided',
      answer: { choice: 'new_story' },
      probabilities: { new_story: 0.82, adds_nothing: 0.12, link: 0.06 },
    });
    expect(Number(d.runner_up_margin)).toBeCloseTo(0.7);
    expect(Number(d.latency_ms)).toBeGreaterThanOrEqual(15);
    console.log('#478 final counts per status:', JSON.stringify(await statusCounts()));
  });

  it('CTO must-fix: a signal that crashes the worker every time ends dead at the attempt cap, never lost', async () => {
    const target = ids[0];
    await pool.query(`update atlas.signals set next_attempt_at = now() + interval '1 hour' where signal_id <> $1`, [target]);
    for (let i = 1; i <= 3; i++) {
      const c = await claimNext(pool, { leaseMs: 30, worker: 'crashy', maxAttempts: 3 });
      expect(c?.signalId).toBe(target);
      expect(c?.attempts).toBe(i);
      await sleep(70); // crash: never finishes or fails
    }
    expect(await claimNext(pool, { leaseMs: 30, worker: 'crashy', maxAttempts: 3 })).toBeNull();
    const s = await sig(target);
    expect(s).toMatchObject({ status: 'dead', attempts: 3, claim_token: null, last_error: 'claim expired after max attempts' });
    expect(Number((await pool.query('select count(*) n from atlas.signals')).rows[0].n)).toBe(ids.length);
  });

  it('DB Guy: signal_finish returns false (and writes no decision) when its final update hits 0 rows', async () => {
    const target = ids[0];
    await pool.query(`update atlas.signals set next_attempt_at = now() + interval '1 hour' where signal_id <> $1`, [target]);
    const c = await claimNext(pool, { leaseMs: 60_000, worker: 'w', maxAttempts: 3 });
    // Simulate the claim vanishing between the check and the update: a trigger skips the row.
    const client = await pool.connect();
    try {
      await client.query(`create function public.t478_skip() returns trigger language plpgsql as $$ begin return null; end $$`);
      await client.query(`create trigger t478_skip before update on atlas.signals for each row execute function public.t478_skip()`);
      const ok = await finishClaim(client, c!, { status: 'analysed', decision: { schema_version: 1, signal_id: target, analyst_version: 'a', decision_type: 'file', action: 'keep' } });
      expect(ok).toBe(false);
      expect(Number((await client.query('select count(*) n from atlas.decisions where signal_id = $1', [target])).rows[0].n)).toBe(0);
    } finally {
      await client.query('drop trigger if exists t478_skip on atlas.signals');
      await client.query('drop function if exists public.t478_skip()');
      client.release();
    }
  });

  it('service_role can claim, finish and fail through the granted surface; anon gets nothing', async () => {
    const svc = new Pool({ connectionString: db.url, max: 2, options: '-c role=service_role' });
    try {
      const deciders = { primary: scripted('jev', [YES]), fallback: scripted('clef', [YES]), shadow: scripted('clef', [YES]) };
      expect(await processNext(svc, opts(deciders))).not.toBeNull();
      const c = await claimNext(svc, { leaseMs: 60_000, worker: 'svc' });
      expect(await failClaim(svc, c!, { error: 'x', backoffMs: 1000, maxAttempts: 3 })).toBe('retry');
      const c2 = await claimNext(svc, { leaseMs: 60_000, worker: 'svc' });
      expect(await finishClaim(svc, c2!, { status: 'parked', parkedReason: 'no_match' })).toBe(true);
    } finally {
      await svc.end();
    }
    expect(await statusCounts()).toMatchObject({ analysed: 1, parked: 1 });
    const anon = new Pool({ connectionString: db.url, max: 1, options: '-c role=anon' });
    try {
      await expect(claimNext(anon, { leaseMs: 1000, worker: 'anon' })).rejects.toThrow(/permission denied/);
    } finally {
      await anon.end();
    }
  });
});

describe.skipIf(ADMIN_URL === '')('#478 migration on the pre-migration shape (local Postgres)', () => {
  let db: ThrowawayDatabase;
  beforeAll(async () => { db = await createThrowawayDatabase(ADMIN_URL, { before: MIGRATION }); });
  afterAll(async () => { await db?.drop(); });

  const schemaSnapshot = async (pool: Pool) => (await pool.query(`
    select 'col' k, table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') v
      from information_schema.columns where table_schema = 'atlas'
    union all select 'con', conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid)
      from pg_constraint where connamespace = 'atlas'::regnamespace
    union all select 'idx', indexname || ':' || indexdef from pg_indexes where schemaname = 'atlas'
    union all select 'fn', p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid))
      from pg_proc p where pronamespace = 'atlas'::regnamespace
    union all select 'tbl', c.relname || ':' || coalesce(array_to_string(c.relacl, ','), '') || ':' || c.relrowsecurity
      from pg_class c where relnamespace = 'atlas'::regnamespace and relkind in ('r','p')
    union all select 'colacl', table_name || '.' || column_name || ':' || grantee || ':' || privilege_type
      from information_schema.column_privileges where table_schema = 'atlas' and grantee in ('service_role','anon','authenticated')
    union all select 'pol', tablename || '.' || policyname || ':' || array_to_string(roles, ',') from pg_policies where schemaname = 'atlas'
    order by 1, 2`)).rows.map((r) => `${r.k} ${r.v}`);

  it('existing signals with ready signal_queue rows stay claimable after the migration, count unchanged; rollback restores the schema exactly', async () => {
    const pool = new Pool({ connectionString: db.url, max: 2 });
    try {
      for (const s of newsSampleSignals) {
        await pool.query(
          `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, enqueued_at) values ($1,$2,$3,$4,$5,$6, now())`,
          [s.signal_id, s.schema_version, s.source, s.source_id, s.type, s.text]);
        await pool.query('insert into atlas.signal_queue (signal_id, max_attempts) values ($1, 3)', [s.signal_id]);
      }
      const before = await schemaSnapshot(pool);
      await applySqlFile(db.url, join(MIGRATIONS_DIR, MIGRATION));
      expect(Number((await pool.query('select count(*) n from atlas.signals')).rows[0].n)).toBe(newsSampleSignals.length);
      const claimed = [];
      for (;;) {
        const c = await claimNext(pool, { leaseMs: 60_000, worker: 'post-migration' });
        if (c === null) break;
        claimed.push(c.signalId);
      }
      expect(claimed.sort()).toEqual(newsSampleSignals.map((s) => s.signal_id).sort());

      await pool.query('update atlas.signals set claim_token = null, claim_expires_at = null');
      await pool.query('truncate atlas.signals cascade');
      await applySqlFile(db.url, join(ROLLBACKS_DIR, ROLLBACK));
      expect(await schemaSnapshot(pool)).toEqual(before.filter(() => true));
      await applySqlFile(db.url, join(MIGRATIONS_DIR, MIGRATION));
    } finally {
      await pool.end();
    }
  });

  it('DB Guy blocker 1: rollback re-seeds signal_queue from received, unclaimed signals', async () => {
    const pool = new Pool({ connectionString: db.url, max: 2 });
    try {
      for (const s of newsSampleSignals) {
        await pool.query(`insert into atlas.signals (signal_id, schema_version, source, source_id, type, text) values ($1,$2,$3,$4,$5,$6)`,
          [s.signal_id, s.schema_version, s.source, s.source_id, s.type, s.text]);
      }
      const [a, b] = newsSampleSignals.map((s) => s.signal_id);
      await pool.query(`update atlas.signals set status = 'analysed' where signal_id = $1`, [a]);
      await pool.query(`update atlas.signals set claim_token = gen_random_uuid(), claim_expires_at = now() + interval '1 minute' where signal_id = $1`, [b]);
      const received = Number((await pool.query(`select count(*) n from atlas.signals where status = 'received' and claim_token is null`)).rows[0].n);
      expect(received).toBe(newsSampleSignals.length - 2);
      await applySqlFile(db.url, join(ROLLBACKS_DIR, ROLLBACK));
      const queued = (await pool.query(`select signal_id, status, attempts::int attempts from atlas.signal_queue order by signal_id`)).rows;
      expect(queued).toHaveLength(received);
      expect(queued.every((q) => q.status === 'ready' && q.attempts === 0)).toBe(true);
      await pool.query('truncate atlas.signals cascade');
      await applySqlFile(db.url, join(MIGRATIONS_DIR, MIGRATION));
    } finally {
      await pool.end();
    }
  });

  it('DB Guy blocker 2: the rollback is one transaction with set local timeouts', async () => {
    const { readFile } = await import('node:fs/promises');
    const sql = (await readFile(join(ROLLBACKS_DIR, ROLLBACK), 'utf8'))
      .split('\n').filter((l) => !/^\s*--/.test(l) && l.trim() !== '').join('\n');
    expect(sql.trimStart().toLowerCase().startsWith('begin;')).toBe(true);
    expect(sql.trimEnd().toLowerCase().endsWith('commit;')).toBe(true);
    expect(sql).toMatch(/set local lock_timeout/i);
    expect(sql).toMatch(/set local statement_timeout/i);
    expect(sql).not.toMatch(/^set (lock|statement)_timeout/im);
  });
});
