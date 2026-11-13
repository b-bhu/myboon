/** #621 worker claim behaviour with a scripted pool (no database): which claim SQL runs, how many claims, what a no-entity claim does. */
import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import type { Llm } from './clients.js';
import { claimQuery, runOnce, type WorkerDeps } from './worker.js';

type Call = { sql: string; params: unknown[] };

const NO_ENTITY_HANDOFF = {
  schema_version: 1, analyst_version: 'analyst-567-v1', signal_id: 'sig-1', decision: 'keep', reason: 'kept', entity: null,
  signal: {
    signal_id: 'sig-1', schema_version: 1, source: 'scout-news', source_id: 'x1', type: 'news', priority: 0,
    occurred_at: '2026-11-06T08:00:00Z', fetched_at: '2026-11-06T08:01:00Z', text: 'Some growth item',
    numbers: {}, link: 'https://ex.com/a', raw_ids: {}, unusual_score: null, excerpt: 'Some growth item', raw_hash: null, created_at: '2026-11-06T08:01:00Z',
  },
};

/** A pool that always has `available` claims to give and records every query. */
function fakePool(available: number) {
  const calls: Call[] = [];
  let given = 0;
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes('atlas.em_claim')) {
        if (given >= available) return { rows: [] };
        given += 1;
        return { rows: [{ decision_id: `d${given}`, signal_id: `sig-${given}`, claim_token: `t${given}`, attempts: 1 }] };
      }
      if (sql.includes('select handoff from atlas.decisions')) return { rows: [{ handoff: NO_ENTITY_HANDOFF }] };
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as pg.Pool, calls };
}

const llm: Llm = async () => { throw new Error('the model must not be called for a no-entity handoff'); };
const deps = (pool: pg.Pool, o: Partial<WorkerDeps>): WorkerDeps => ({ pool, llm, worker: 'w', limit: 20, log: () => {}, ...o });
const claims = (calls: Call[]) => calls.filter((c) => c.sql.includes('atlas.em_claim'));
const defers = (calls: Call[]) => calls.filter((c) => c.sql.includes("em_next_attempt_at = now() + interval '1 day'"));

describe('#621 claimQuery', () => {
  it('no scope is the original atlas.em_claim call', () => {
    expect(claimQuery(undefined)).toBe('select * from atlas.em_claim($1, make_interval(secs => $2), 3)');
  });
  it('a scope calls atlas.em_claim_scoped with the scope as $3', () => {
    expect(claimQuery('entity')).toBe('select * from atlas.em_claim_scoped($1, $3, make_interval(secs => $2), 3)');
  });
});

describe('#621 runOnce claim scope', () => {
  it('flag off (no scope): uses atlas.em_claim with the original two parameters', async () => {
    const { pool, calls } = fakePool(1);
    await runOnce(deps(pool, {}));
    const c = claims(calls);
    expect(c[0]!.sql).toBe(claimQuery(undefined));
    expect(c[0]!.params).toEqual(['w', 300]);
    expect(calls.some((x) => x.sql.includes('em_claim_scoped'))).toBe(false);
  });

  it("scope 'entity': uses atlas.em_claim_scoped with the scope", async () => {
    const { pool, calls } = fakePool(1);
    await runOnce(deps(pool, { scope: 'entity' }));
    expect(claims(calls)[0]!.params).toEqual(['w', 300, 'entity']);
    expect(claims(calls)[0]!.sql).toContain('em_claim_scoped');
  });
});

describe('#621 batch size', () => {
  it('claims at most `limit` rows per run: 60 when 100 are waiting', async () => {
    const { pool, calls } = fakePool(100);
    const sum = await runOnce(deps(pool, { scope: 'no_entity', limit: 60 }));
    expect(sum.claimed).toBe(60);
    expect(claims(calls)).toHaveLength(60);
  });

  it('stops early when the queue is empty: 7 waiting, limit 60 -> 7 claims plus the one empty claim', async () => {
    const { pool, calls } = fakePool(7);
    const sum = await runOnce(deps(pool, { scope: 'entity', limit: 60 }));
    expect(sum.claimed).toBe(7);
    expect(claims(calls)).toHaveLength(8);
  });
});

describe('#621 daily retry of no-entity handoffs', () => {
  it('each claimed no-entity row is put back pending for a day and never reaches the model', async () => {
    const { pool, calls } = fakePool(5);
    const sum = await runOnce(deps(pool, { scope: 'no_entity', limit: 2000 }));
    expect(sum).toMatchObject({ claimed: 5, deferred_no_entity: 5, story: 0, parked: 0, duplicate: 0, failed: 0 });
    expect(defers(calls)).toHaveLength(5);
  });
});
