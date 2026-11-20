/** #621 worker claim behaviour with a scripted pool (no database): which claim SQL runs, how many claims, what a no-entity claim does. */
import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import type { Llm } from './clients.js';
import { retryRunConfig } from './config.js';
import { runEntityManager } from './entry.js';
import { claimQuery, lagWarning, MISSING_SCOPED_CLAIM_MSG, NO_ENTITY_PARK_REASON, oldestReadyEntityAgeMinutes, runOnce, type WorkerDeps } from './worker.js';

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
function fakePool(available: number, staleParks = false) {
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
      if (sql.includes("set em_status = 'parked'")) return { rows: [], rowCount: staleParks ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
    end: async () => {},
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

describe('#621 stale no-entity handoffs are parked for good', () => {
  const parks = (calls: Call[]) => calls.filter((c) => c.sql.includes("set em_status = 'parked'"));

  it('retry run: a row the DB says is older than 7 days is parked with the reason and is not put back', async () => {
    const { pool, calls } = fakePool(3, true);
    const sum = await runOnce(deps(pool, { scope: 'no_entity', limit: 2000 }));
    expect(sum).toMatchObject({ claimed: 3, parked_stale_no_entity: 3, deferred_no_entity: 0, failed: 0 });
    expect(defers(calls)).toHaveLength(0);
    expect(parks(calls)[0]!.params).toEqual(['d1', 't1', NO_ENTITY_PARK_REASON, 7]);
    expect(NO_ENTITY_PARK_REASON).toMatch(/no entity after 7 days: parked, not retried/);
  });

  it('retry run: a row not older than 7 days is put back for a day as before', async () => {
    const { pool, calls } = fakePool(2, false);
    const sum = await runOnce(deps(pool, { scope: 'no_entity', limit: 2000 }));
    expect(sum).toMatchObject({ claimed: 2, parked_stale_no_entity: 0, deferred_no_entity: 2 });
    expect(defers(calls)).toHaveLength(2);
  });

  it('flag off (no scope): never parks, every no-entity row is put back for a day exactly as before', async () => {
    const { pool, calls } = fakePool(2, true);
    const sum = await runOnce(deps(pool, {}));
    expect(sum).toMatchObject({ claimed: 2, deferred_no_entity: 2, parked_stale_no_entity: 0 });
    expect(parks(calls)).toHaveLength(0);
  });
});

describe('#621 missing migration with the flag on', () => {
  const missingFn = { async query() { throw Object.assign(new Error('function atlas.em_claim_scoped(unknown, unknown, interval, integer) does not exist'), { code: '42883' }); } } as unknown as pg.Pool;

  it('a scoped run stops once with a clear error naming the migration, instead of failing each claim', async () => {
    await expect(runOnce(deps(missingFn, { scope: 'entity' }))).rejects.toThrow(MISSING_SCOPED_CLAIM_MSG);
    expect(MISSING_SCOPED_CLAIM_MSG).toContain('20261113190000_atlas_em_claim_scoped.sql');
  });

  it('other claim errors are passed through unchanged', async () => {
    const boom = { async query() { throw Object.assign(new Error('connection reset'), { code: '08006' }); } } as unknown as pg.Pool;
    await expect(runOnce(deps(boom, { scope: 'entity' }))).rejects.toThrow('connection reset');
  });

  it('flag off never calls em_claim_scoped, even when the function is missing', async () => {
    const { pool, calls } = fakePool(3);
    await runOnce(deps(pool, {}));
    expect(calls.some((c) => c.sql.includes('em_claim_scoped'))).toBe(false);
  });
});

describe('#621 lag signal', () => {
  it('lagWarning: silent at or under the threshold and when nothing is ready, a WARN line over it', () => {
    expect(lagWarning(null, 120)).toBeNull();
    expect(lagWarning(120, 120)).toBeNull();
    expect(lagWarning(45, 120)).toBeNull();
    expect(lagWarning(121, 120)).toMatchObject({ level: 'warn', event: 'em_lag_warn', oldest_ready_entity_age_min: 121, threshold_min: 120 });
    expect(lagWarning(121, 120)!.msg).toMatch(/121 min behind.*120 min threshold/);
    expect(lagWarning(121, 180)).toBeNull();
  });

  it('oldestReadyEntityAgeMinutes: rounds the database age, null when no row is ready', async () => {
    const db = (age: string | null) => ({ async query() { return { rows: [{ age }] }; } }) as never;
    expect(await oldestReadyEntityAgeMinutes(db('125.4'))).toBe(125);
    expect(await oldestReadyEntityAgeMinutes(db(null))).toBeNull();
  });
});

describe('#690 markets pass wiring', () => {
  /** console capture for the run lines. */
  function captureStdout() {
    const lines: string[] = [];
    const orig = console.log;
    const origErr = console.error;
    console.log = (l: unknown) => lines.push(String(l));
    console.error = (l: unknown) => lines.push(`ERR ${String(l)}`);
    return {
      lines,
      restore: () => {
        console.log = orig;
        console.error = origErr;
      },
    };
  }
  it('flag off (default): the markets pass is never called and the run output is unchanged', async () => {
    const { pool, calls } = fakePool(0);
    let marketsCalls = 0;
    const runOnceSummary = { claimed: 1, story: 1, parked: 0, duplicate: 0, deferred_no_entity: 0, parked_stale_no_entity: 0, failed: 0, retry: 0, lost: 0 };
    const c = captureStdout();
    try {
      await runEntityManager({ scope: undefined, limit: 3 }, 'em_run', '', {
        pool,
        llm: async () => '',
        runOnceImpl: async () => runOnceSummary,
        runMarketsPassImpl: async () => {
          marketsCalls++;
          return { checked: 0, linked: 0, none: 0, retry: 0 };
        },
      });
    } finally {
      c.restore();
    }
    expect(marketsCalls).toBe(0);
    expect(calls.filter((x) => x.sql.includes('entity_markets') || x.sql.includes('markets_checked_at'))).toEqual([]);
    const json = JSON.parse(c.lines[0]!) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      'event', 'scope', 'limit', 'claimed', 'story', 'parked', 'duplicate', 'deferred_no_entity',
      'parked_stale_no_entity', 'failed', 'retry', 'lost', 'oldest_ready_entity_age_min',
    ]);
    expect(json).toMatchObject({ event: 'em_run', scope: 'all', limit: 3, claimed: 1, oldest_ready_entity_age_min: null });
  });

  it('flag on: the main run calls the markets pass once, after runOnce, with the batch and the same llm', async () => {
    const { pool } = fakePool(0);
    const seen: unknown[] = [];
    const c = captureStdout();
    try {
      await runEntityManager({ scope: undefined, limit: 1 }, 'em_run', '', {
        pool,
        llm: async () => '',
        runOnceImpl: async () => ({ claimed: 0, story: 0, parked: 0, duplicate: 0, deferred_no_entity: 0, parked_stale_no_entity: 0, failed: 0, retry: 0, lost: 0 }),
        runMarketsPassImpl: async (d: unknown) => {
          seen.push(d);
          return { checked: 1, linked: 0, none: 1, retry: 0 };
        },
        markets: { enabled: true, limit: 7 },
      });
    } finally {
      c.restore();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ pool, limit: 7 });
    expect((seen[0] as { llm?: unknown }).llm).toBeTypeOf('function');
  });

  it('the retry entrypoint (workerSuffix :retry) never runs the markets pass, even with the flag on', async () => {
    const { pool } = fakePool(0);
    let marketsCalls = 0;
    await runEntityManager(retryRunConfig(), 'em_retry_run', ':retry', {
      pool,
      llm: async () => '',
      runOnceImpl: async () => ({ claimed: 1, story: 0, parked: 0, duplicate: 0, deferred_no_entity: 1, parked_stale_no_entity: 0, failed: 0, retry: 0, lost: 0 }),
      runMarketsPassImpl: async () => {
        marketsCalls++;
        return { checked: 0, linked: 0, none: 0, retry: 0 };
      },
      markets: { enabled: true, limit: 5 },
    });
    expect(marketsCalls).toBe(0);
  });

  it('a throwing markets pass is logged once and the run still succeeds with the same summary line', async () => {
    const { pool } = fakePool(0);
    const c = captureStdout();
    try {
      await runEntityManager({ scope: undefined, limit: 2 }, 'em_run', '', {
        pool,
        llm: async () => '',
        runOnceImpl: async () => ({ claimed: 0, story: 0, parked: 0, duplicate: 0, deferred_no_entity: 0, parked_stale_no_entity: 0, failed: 0, retry: 0, lost: 0 }),
        runMarketsPassImpl: async () => {
          throw new Error('hyperliquid down');
        },
        markets: { enabled: true, limit: 5 },
      });
    } finally {
      c.restore();
    }
    expect(c.lines).toHaveLength(2);
    expect(JSON.parse(c.lines[0]!)).toMatchObject({ event: 'em_run', claimed: 0 });
    expect(c.lines[1]).toBe('ERR entity-manager: markets pass failed: hyperliquid down');
  });
});
