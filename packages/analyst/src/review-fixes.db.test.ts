/**
 * PR #485 review fixes (CTO + DB Guy), as behaviour tests on a throwaway LOCAL Postgres.
 * Same harness and skip rule as signal-states.db.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { newsSampleSignals } from '@myboon/contracts/test-fixtures';
import { createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';

import { admitSignals, callJev, claimSignals, completeClaim, failClaim, sweepExpiredClaims, type JevAnswer, type JevPort } from './index.js';

const ADMIN_URL = process.env.ANALYST_TEST_ADMIN_URL?.trim() ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok: JevAnswer = { answer: { pick: 'a' }, probability: 0.9, runnerUp: null, modelVersion: 'scripted' };

describe.skipIf(ADMIN_URL === '')('#485 review fixes (local Postgres)', () => {
  let db: ThrowawayDatabase;
  let pool: Pool;
  const id = newsSampleSignals[0].signal_id;
  const row = async () => (await pool.query(
    `select state, previous_state, attempts::int as attempts, available_at <= now() as available, last_error, claim_token
       from atlas.signal_states where signal_id = $1`, [id])).rows[0];

  beforeAll(async () => {
    db = await createThrowawayDatabase(ADMIN_URL);
    pool = new Pool({ connectionString: db.url, max: 4 });
  });
  afterAll(async () => { await pool?.end(); await db?.drop(); });
  beforeEach(async () => {
    await pool.query('truncate atlas.jev_decisions, atlas.signal_states, atlas.dead_letter, atlas.signals cascade');
    for (const s of newsSampleSignals) {
      await pool.query(
        `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text) values ($1,$2,$3,$4,$5,$6)`,
        [s.signal_id, s.schema_version, s.source, s.source_id, s.type, s.text]);
    }
    await admitSignals(pool);
  });

  it('fix 1: a signal retried in stage A starts stage B with a full retry budget', async () => {
    await pool.query(`delete from atlas.signal_states where signal_id <> $1`, [id]);
    let [c] = await claimSignals(pool, { state: 'received', limit: 1, leaseMs: 60_000, worker: 'a' });
    expect(c.signalId).toBe(id);
    expect(await failClaim(pool, c, { error: 'flaky', backoffMs: 0 })).toBe('retry');
    [c] = await claimSignals(pool, { state: 'received', limit: 1, leaseMs: 60_000, worker: 'a' });
    expect(c.attempts).toBe(2);
    expect(await completeClaim(pool, c, { to: 'analysed' })).toBe(true);
    expect(await row()).toMatchObject({ state: 'analysed', attempts: 0, available: true });
    const [b] = await claimSignals(pool, { state: 'analysed', limit: 1, leaseMs: 60_000, worker: 'b' });
    expect(b.attempts).toBe(1);
  });

  it('fix 2: a signal that keeps crashing its worker is dead-lettered by the sweeper at the cap, signal kept', async () => {
    await pool.query(`delete from atlas.signal_states where signal_id <> $1`, [id]);
    await pool.query('update atlas.signal_states set max_attempts = 2 where signal_id = $1', [id]);
    for (let i = 0; i < 2; i++) {
      const claims = await claimSignals(pool, { state: 'received', limit: 1, leaseMs: 30, worker: 'crashy' });
      expect(claims).toHaveLength(1);
      await sleep(80);
      await sweepExpiredClaims(pool);
    }
    expect(await row()).toMatchObject({ state: 'dead_lettered', previous_state: 'received', attempts: 2, last_error: 'claim expired', claim_token: null });
    const dl = (await pool.query(`select queue_name, ref_id, attempts::int as attempts, last_error, row_data from atlas.dead_letter`)).rows;
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ queue_name: 'signal_states', ref_id: id, attempts: 2, last_error: 'claim expired' });
    expect(dl[0].row_data.state).toBe('received');
    expect(Number((await pool.query('select count(*) n from atlas.signals where signal_id = $1', [id])).rows[0].n)).toBe(1);
    expect(await claimSignals(pool, { state: 'received', limit: 10, leaseMs: 1000, worker: 'x' })).toHaveLength(0);
  });

  it('fix 2b: signal_fail at the cap also writes one atlas.dead_letter row', async () => {
    await pool.query('update atlas.signal_states set max_attempts = 1 where signal_id = $1', [id]);
    const [c] = (await claimSignals(pool, { state: 'received', limit: 10, leaseMs: 60_000, worker: 'w' })).filter((x) => x.signalId === id);
    expect(await failClaim(pool, c, { error: 'jev down', backoffMs: 0 })).toBe('dead_lettered');
    const dl = (await pool.query(`select queue_name, ref_id, last_error from atlas.dead_letter`)).rows;
    expect(dl).toEqual([{ queue_name: 'signal_states', ref_id: id, last_error: 'jev down' }]);
  });

  it('fix 4: signal_advance enforces the allowed transitions in SQL', async () => {
    await pool.query(`update atlas.signal_states set available_at = now() + interval '1 hour' where signal_id <> $1`, [id]);
    let [c] = await claimSignals(pool, { state: 'received', limit: 1, leaseMs: 60_000, worker: 'w' });
    await expect(completeClaim(pool, c, { to: 'written' })).rejects.toThrow(/transition/);
    await expect(completeClaim(pool, c, { to: 'dead_lettered' })).rejects.toThrow(/transition/);
    expect(await completeClaim(pool, c, { to: 'analysed' })).toBe(true);
    [c] = await claimSignals(pool, { state: 'analysed', limit: 1, leaseMs: 60_000, worker: 'w' });
    await expect(completeClaim(pool, c, { to: 'received' })).rejects.toThrow(/transition/);
    expect(await completeClaim(pool, c, { to: 'written' })).toBe(true);
    // terminal states are never claimable
    await pool.query(`update atlas.signal_states set state = 'dead_lettered', previous_state = 'received' where signal_id <> $1`, [id]);
    await expect(claimSignals(pool, { state: 'dead_lettered', limit: 10, leaseMs: 1000, worker: 'w' })).rejects.toThrow(/not claimable/);
  });

  it('fix 5: a Jev timeout aborts the in-flight call', async () => {
    let seen: AbortSignal | undefined;
    const port: JevPort = {
      modelVersion: 'scripted',
      decide: (_input, signal) => { seen = signal; return new Promise<JevAnswer>(() => {}); },
    };
    const res = await callJev(pool, port, { signalId: id, stage: 'linker', inputCase: {}, timeoutMs: 30 });
    expect(res.status).toBe('timeout');
    expect(seen?.aborted).toBe(true);
  });

  it('DB Guy blocker: service_role can admit, claim, advance, fail, sweep and log Jev calls', async () => {
    const client = await pool.connect();
    try {
      await client.query('truncate atlas.signal_states');
      await client.query('set role service_role');
      const p = client as unknown as Pool;
      expect(await admitSignals(p)).toBe(newsSampleSignals.length);
      const claims = await claimSignals(p, { state: 'received', limit: 2, leaseMs: 60_000, worker: 'svc' });
      expect(await completeClaim(p, claims[0], { to: 'analysed' })).toBe(true);
      expect(await failClaim(p, claims[1], { error: 'x', backoffMs: 0 })).toBe('retry');
      expect(await sweepExpiredClaims(p)).toBe(0);
      expect((await callJev(p, { modelVersion: 'scripted', decide: async () => ok }, { signalId: id, stage: 'linker', inputCase: {}, timeoutMs: 500 })).status).toBe('success');
      expect(Number((await client.query('select count(*) n from atlas.jev_decisions')).rows[0].n)).toBe(1);
      // anon still gets nothing
      await client.query('reset role; set role anon');
      await expect(client.query('select 1 from atlas.signal_states limit 1')).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('reset role');
      client.release();
    }
  });
});
