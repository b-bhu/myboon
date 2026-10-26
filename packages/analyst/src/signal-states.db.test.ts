/**
 * Issue #478 acceptance scenarios as behaviour tests.
 *
 * Isolated only: each run creates a THROWAWAY database on a LOCAL Postgres
 * (ANALYST_TEST_ADMIN_URL, host must be localhost/127.0.0.1), applies the atlas
 * migrations, seeds the real #440 news samples as scout signals, and drops the
 * database afterwards. Jev is replaced by scripted answers (success, error,
 * timeout). Assertions read DB state (states, row counts), not function calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { newsSampleSignals } from '@myboon/contracts/test-fixtures';
import { createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';

import {
  admitSignals,
  callJev,
  claimSignals,
  completeClaim,
  failClaim,
  runStageOnce,
  sweepExpiredClaims,
  type JevAnswer,
  type JevPort,
} from './index.js';

const ADMIN_URL = process.env.ANALYST_TEST_ADMIN_URL?.trim() ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Step = { answer: JevAnswer } | { error: string } | 'timeout';

/** Scripted Jev: replays steps in order; 'timeout' never resolves. */
function scriptedJev(steps: Step[]): JevPort & { calls: number } {
  const port = {
    calls: 0,
    modelVersion: 'scripted-jev-1',
    async decide() {
      const step = steps[Math.min(port.calls, steps.length - 1)];
      port.calls += 1;
      if (step === 'timeout') return new Promise<JevAnswer>(() => {});
      if ('error' in step) throw new Error(step.error);
      return step.answer;
    },
  };
  return port;
}

const okAnswer: JevAnswer = {
  answer: { link: 'new_item' },
  probability: 0.82,
  runnerUp: { link: 'existing_item', probability: 0.11 },
  modelVersion: 'scripted-jev-1',
};

describe.skipIf(ADMIN_URL === '')('#478 signal states and Jev decision log (local Postgres)', () => {
  let db: ThrowawayDatabase;
  let pool: Pool;

  async function stateCounts(): Promise<Record<string, number>> {
    const { rows } = await pool.query<{ state: string; n: string }>(
      'select state, count(*) n from atlas.signal_states group by state order by state',
    );
    return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
  }
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await pool.query<{ n: string }>(sql, params)).rows[0].n);

  beforeAll(async () => {
    db = await createThrowawayDatabase(ADMIN_URL);
    pool = new Pool({ connectionString: db.url, max: 8 });
  });
  afterAll(async () => {
    await pool?.end();
    await db?.drop();
  });
  beforeEach(async () => {
    await pool.query('truncate atlas.jev_decisions, atlas.signal_states, atlas.signal_queue, atlas.dead_letter, atlas.signals cascade');
    for (const s of newsSampleSignals) {
      await pool.query(
        `insert into atlas.signals (signal_id, schema_version, source, source_id, type, priority, occurred_at, fetched_at, text, link)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [s.signal_id, s.schema_version, s.source, s.source_id, s.type, s.priority, s.occurred_at, s.fetched_at, s.text, s.link],
      );
      await pool.query('insert into atlas.signal_queue (signal_id) values ($1)', [s.signal_id]);
    }
    expect(await admitSignals(pool)).toBe(newsSampleSignals.length);
  });

  it('admits every scout signal as received exactly once and leaves the scout tables untouched', async () => {
    expect(await admitSignals(pool)).toBe(0);
    expect(await stateCounts()).toEqual({ received: newsSampleSignals.length });
    expect(await count('select count(*) n from atlas.signals')).toBe(newsSampleSignals.length);
    expect(await count('select count(*) n from atlas.signal_queue')).toBe(newsSampleSignals.length);
  });

  it('rejects unknown states and a parked signal without a reason', async () => {
    const id = newsSampleSignals[0].signal_id;
    await expect(pool.query(`update atlas.signal_states set state = 'bogus' where signal_id = $1`, [id])).rejects.toThrow();
    await expect(pool.query(`update atlas.signal_states set state = 'parked', park_reason = null where signal_id = $1`, [id])).rejects.toThrow();
  });

  it('crash before finishing: after the claim expires the sweeper returns it to its previous state and it is processed once', async () => {
    const [claim] = await claimSignals(pool, { state: 'received', limit: 1, leaseMs: 100, worker: 'crashy' });
    expect(claim).toBeDefined();
    // worker "crashes": never completes. While the claim is live nobody else gets it.
    expect((await claimSignals(pool, { state: 'received', limit: 100, leaseMs: 60_000, worker: 'peek' })).map((c) => c.signalId)).not.toContain(claim.signalId);
    await pool.query('update atlas.signal_states set claimed_by = null, claim_token = null, claim_expires_at = null where claimed_by = $1', ['peek']);
    await sleep(200);
    expect(await sweepExpiredClaims(pool)).toBe(1);
    const row = (await pool.query('select state, claim_token from atlas.signal_states where signal_id = $1', [claim.signalId])).rows[0];
    expect(row).toEqual({ state: 'received', claim_token: null });
    // the crashed worker's stale token can no longer finish it
    expect(await completeClaim(pool, claim, { to: 'analysed' })).toBe(false);

    const jev = scriptedJev([{ answer: okAnswer }]);
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await runStageOnce(pool, { stage: 'linker', from: 'received', to: 'analysed', jev, limit: 100, leaseMs: 60_000, backoffMs: 1000, timeoutMs: 500 }));
    expect(await stateCounts()).toEqual({ analysed: newsSampleSignals.length });
    expect(await count('select count(*) n from atlas.jev_decisions where signal_id = $1', [claim.signalId])).toBe(1);
    expect(jev.calls).toBe(newsSampleSignals.length);
  });

  it('two workers at once: no signal is ever claimed by both', async () => {
    const workers = Array.from({ length: 6 }, (_, i) =>
      claimSignals(pool, { state: 'received', limit: 3, leaseMs: 60_000, worker: `w${i}` }),
    );
    const claimed = (await Promise.all(workers)).flat().map((c) => c.signalId);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed.length).toBe(Math.min(18, newsSampleSignals.length));
    const holders = await count('select count(*) n from atlas.signal_states where claim_token is not null');
    expect(holders).toBe(claimed.length);
  });

  it('every Jev call (success, error or timeout) writes exactly one jev_decisions row', async () => {
    const [a, b, c] = newsSampleSignals.map((s) => s.signal_id);
    const ok = await callJev(pool, scriptedJev([{ answer: okAnswer }]), { signalId: a, stage: 'linker', inputCase: { title: 'a' }, timeoutMs: 200 });
    const err = await callJev(pool, scriptedJev([{ error: 'upstream 502' }]), { signalId: b, stage: 'linker', inputCase: { title: 'b' }, timeoutMs: 200 });
    const slow = await callJev(pool, scriptedJev(['timeout']), { signalId: c, stage: 'linker', inputCase: { title: 'c' }, timeoutMs: 50 });
    expect([ok.status, err.status, slow.status]).toEqual(['success', 'error', 'timeout']);
    const { rows } = await pool.query(
      'select signal_id, outcome, input_case, answer, probability, runner_up, model_version, error from atlas.jev_decisions order by created_at, id',
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.signal_id, r.outcome])).toEqual([[a, 'success'], [b, 'error'], [c, 'timeout']]);
    expect(rows[0]).toMatchObject({ input_case: { title: 'a' }, answer: { link: 'new_item' }, probability: 0.82, runner_up: { link: 'existing_item', probability: 0.11 }, model_version: 'scripted-jev-1' });
    expect(rows[1].error).toContain('upstream 502');
    expect(rows[1].model_version).toBe('scripted-jev-1');
  });

  it('Jev down: the signal stays waiting, is retried with backoff, and after the cap is dead_lettered, never lost', async () => {
    const target = newsSampleSignals[0].signal_id;
    await pool.query(`delete from atlas.signal_states where signal_id <> $1`, [target]);
    await pool.query('update atlas.signal_states set max_attempts = 3 where signal_id = $1', [target]);
    const jev = scriptedJev([{ error: 'connect ECONNREFUSED' }]);
    const opts = { stage: 'linker', from: 'received', to: 'analysed', jev, limit: 10, leaseMs: 60_000, timeoutMs: 100 } as const;

    await runStageOnce(pool, { ...opts, backoffMs: 60_000 });
    let row = (await pool.query('select state, attempts::int as attempts, available_at > now() as backing_off, last_error from atlas.signal_states where signal_id = $1', [target])).rows[0];
    expect(row).toMatchObject({ state: 'received', attempts: 1, backing_off: true });
    expect(row.last_error).toContain('ECONNREFUSED');
    // while backing off it is not picked up again
    await runStageOnce(pool, { ...opts, backoffMs: 60_000 });
    expect(jev.calls).toBe(1);

    // backoff grows with attempts
    await pool.query('update atlas.signal_states set available_at = now() where signal_id = $1', [target]);
    await runStageOnce(pool, { ...opts, backoffMs: 60_000 });
    row = (await pool.query(`select state, attempts::int as attempts, available_at - now() > interval '90 seconds' as doubled from atlas.signal_states where signal_id = $1`, [target])).rows[0];
    expect(row).toMatchObject({ state: 'received', attempts: 2, doubled: true });

    await pool.query('update atlas.signal_states set available_at = now() where signal_id = $1', [target]);
    await runStageOnce(pool, { ...opts, backoffMs: 60_000 });
    row = (await pool.query('select state, attempts::int as attempts, previous_state, claim_token from atlas.signal_states where signal_id = $1', [target])).rows[0];
    expect(row).toMatchObject({ state: 'dead_lettered', attempts: 3, previous_state: 'received', claim_token: null });
    expect(await count('select count(*) n from atlas.jev_decisions where signal_id = $1', [target])).toBe(3);
    expect(await count('select count(*) n from atlas.signals where signal_id = $1', [target])).toBe(1);
    // dead-lettered signals are never claimed again
    await runStageOnce(pool, { ...opts, backoffMs: 0 });
    expect(jev.calls).toBe(3);
  });

  it('failClaim / completeClaim with park reason report outcomes and keep final per-state counts', async () => {
    const claims = await claimSignals(pool, { state: 'received', limit: 3, leaseMs: 60_000, worker: 'w' });
    expect(await completeClaim(pool, claims[0], { to: 'parked', parkReason: 'no matching shelf' })).toBe(true);
    expect(await completeClaim(pool, claims[1], { to: 'discarded' })).toBe(true);
    expect(await failClaim(pool, claims[2], { error: 'boom', backoffMs: 0 })).toBe('retry');
    expect(await failClaim(pool, claims[2], { error: 'again', backoffMs: 0 })).toBe('lost_claim');
    const counts = await stateCounts();
    console.log('#478 final row counts per state:', JSON.stringify(counts));
    expect(counts).toEqual({ parked: 1, discarded: 1, received: newsSampleSignals.length - 2 });
  });
});
