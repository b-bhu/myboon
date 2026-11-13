/**
 * #621 atlas.em_claim_scoped and the worker, on a throwaway LOCAL Postgres (EM_TEST_ADMIN_URL; skipped when
 * unset). Connections of the worker pool run as entity_worker, so the migration's grant is proven too.
 * The migration is applied together with every other atlas migration by createThrowawayDatabase.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applySqlFile, createThrowawayDatabase, ROLLBACKS_DIR, type ThrowawayDatabase } from '../../atlas-schema/src/index.js';
import type { Llm } from './clients.js';
import { runOnce } from './worker.js';

const ADMIN_URL = process.env.EM_TEST_ADMIN_URL?.trim() ?? '';
const ROLLBACK = '20261113190000_atlas_em_claim_scoped.down.sql';
const MIGRATION = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'supabase', 'migrations', '20261113190000_atlas_em_claim_scoped.sql');

const base = (sid: string) => ({
  schema_version: 1, analyst_version: 'analyst-567-v1', signal_id: sid, decision: 'keep', reason: 'kept',
  signal: {
    signal_id: sid, schema_version: 1, source: 'tokens_xyz', source_id: sid, type: 'news', priority: 0,
    occurred_at: '2026-11-06T08:00:00Z', fetched_at: '2026-11-06T08:01:00Z', text: 'text', numbers: {}, link: `https://ex.com/${sid}`,
    raw_ids: {}, unusual_score: null, excerpt: 'text', raw_hash: null, created_at: '2026-11-06T08:01:00Z',
  },
});
const entityPick = { slug: 'hyperliquid', type: 'organization', angle: 'new_story', note: 'n' };

describe.skipIf(ADMIN_URL === '')('#621 em_claim_scoped (local Postgres)', () => {
  let db: ThrowawayDatabase;
  let admin: pg.Pool;
  let worker: pg.Pool;
  let n = 0;

  /** Seed one keep decision, oldest first by `ageMinutes`. kind: entity | null-entity | absent-entity. */
  async function seed(kind: 'entity' | 'null' | 'absent', ageMinutes: number, over: { nextAttemptInMinutes?: number } = {}): Promise<string> {
    n += 1;
    const sid = `sig-${n}`;
    await admin.query(
      `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
       values ($1, 1, 'tokens_xyz', $1, 'news', 'text', 'https://ex.com/' || $1, now())`, [sid]);
    // 'absent' has no entity key at all (never written by the analyst; SQL robustness only), the others are valid handoffs.
    const handoff = kind === 'absent' ? { other: 1 } : { ...base(sid), entity: kind === 'entity' ? entityPick : null };
    const r = await admin.query<{ id: string }>(
      `insert into atlas.decisions (schema_version, signal_id, analyst_version, decision_type, summary, decision, reason, targets, handoff, handoff_version, em_status, created_at, em_next_attempt_at)
       values (1, $1, 'a', 'file', null, 'keep', 'r', '[]', $2::jsonb, 1, 'pending', now() - make_interval(mins => $3), now() + make_interval(mins => $4)) returning id`,
      [sid, JSON.stringify(handoff), ageMinutes, over.nextAttemptInMinutes ?? -1]);
    return r.rows[0]!.id;
  }
  const claim = async (scope: string | null) => (await worker.query<{ decision_id: string }>('select * from atlas.em_claim_scoped($1, $2)', ['w', scope])).rows[0]?.decision_id;
  const status = async (id: string) => (await admin.query<{ em_status: string; em_next_attempt_at: Date }>('select em_status, em_next_attempt_at from atlas.decisions where id = $1', [id])).rows[0]!;

  beforeAll(async () => {
    db = await createThrowawayDatabase(ADMIN_URL);
    admin = new pg.Pool({ connectionString: db.url, max: 2 });
    worker = new pg.Pool({ connectionString: db.url, max: 2, options: '-c role=entity_worker' });
  });
  afterAll(async () => {
    await worker?.end();
    await admin?.end();
    await db?.drop();
  });
  beforeEach(async () => {
    await admin.query('truncate atlas.decisions, atlas.signals cascade');
  });

  it("scope 'entity' skips older no-entity rows and claims the oldest row that has an entity", async () => {
    const oldNull = await seed('null', 300);
    const oldAbsent = await seed('absent', 290);
    const withEntity = await seed('entity', 100);
    await seed('entity', 50);
    expect(await claim('entity')).toBe(withEntity);
    expect((await status(withEntity)).em_status).toBe('claimed');
    expect((await status(oldNull)).em_status).toBe('pending');
    expect((await status(oldAbsent)).em_status).toBe('pending');
  });

  it("scope 'entity' returns nothing when only no-entity rows are pending", async () => {
    await seed('null', 10);
    await seed('absent', 5);
    expect(await claim('entity')).toBeUndefined();
  });

  it("scope 'no_entity' claims only null or absent entity rows, oldest first", async () => {
    await seed('entity', 400);
    const a = await seed('null', 300);
    const b = await seed('absent', 200);
    expect(await claim('no_entity')).toBe(a);
    expect(await claim('no_entity')).toBe(b);
    expect(await claim('no_entity')).toBeUndefined();
  });

  it('rows deferred to a later time are not claimed in either scope', async () => {
    await seed('entity', 30, { nextAttemptInMinutes: 60 });
    await seed('null', 30, { nextAttemptInMinutes: 60 });
    expect(await claim('entity')).toBeUndefined();
    expect(await claim('no_entity')).toBeUndefined();
  });

  it('an expired claim on an entity row is re-claimed in scope entity, not in no_entity', async () => {
    const id = await seed('entity', 30);
    expect(await claim('entity')).toBe(id);
    await admin.query("update atlas.decisions set em_claim_expires_at = now() - interval '1 minute' where id = $1", [id]);
    expect(await claim('no_entity')).toBeUndefined();
    expect(await claim('entity')).toBe(id);
  });

  it('an invalid scope raises and claims nothing', async () => {
    await seed('entity', 30);
    await expect(claim('everything')).rejects.toThrow(/scope must be entity or no_entity/);
    await expect(claim(null)).rejects.toThrow(/scope must be entity or no_entity/);
    expect((await admin.query("select count(*)::int c from atlas.decisions where em_status = 'claimed'")).rows[0].c).toBe(0);
  });

  it('atlas.em_claim is unchanged: it still takes the oldest pending row, entity or not', async () => {
    const oldNull = await seed('null', 300);
    await seed('entity', 100);
    const r = await worker.query<{ decision_id: string }>('select * from atlas.em_claim($1)', ['w']);
    expect(r.rows[0]!.decision_id).toBe(oldNull);
  });

  it('runOnce no_entity (daily retry): every due no-entity row goes back pending for a day, entity rows are untouched', async () => {
    const ids = [await seed('null', 300), await seed('null', 200), await seed('null', 100)];
    const entityRow = await seed('entity', 400);
    const llm: Llm = async () => { throw new Error('model must not be called'); };
    const sum = await runOnce({ pool: worker, llm, worker: 'w:retry', limit: 2000, scope: 'no_entity', log: () => {} });
    expect(sum).toMatchObject({ claimed: 3, deferred_no_entity: 3, failed: 0 });
    for (const id of ids) {
      const s = await status(id);
      expect(s.em_status).toBe('pending');
      expect(s.em_next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    }
    expect((await status(entityRow)).em_status).toBe('pending');
    const again = await runOnce({ pool: worker, llm, worker: 'w:retry', limit: 2000, scope: 'no_entity', log: () => {} });
    expect(again.claimed).toBe(0);
  });

  it('the rollback removes the function and leaves atlas.em_claim working; the migration can be applied again', async () => {
    await applySqlFile(db.url, join(ROLLBACKS_DIR, ROLLBACK));
    await expect(claim('entity')).rejects.toThrow(/em_claim_scoped/);
    await seed('null', 10);
    expect((await worker.query('select * from atlas.em_claim($1)', ['w'])).rows).toHaveLength(1);
    await applySqlFile(db.url, MIGRATION);
    await applySqlFile(db.url, MIGRATION);
    await admin.query("update atlas.decisions set em_status = 'pending', em_claim_token = null, em_claim_expires_at = null, em_claimed_by = null");
    expect(await claim('no_entity')).toBeDefined();
  });
});
