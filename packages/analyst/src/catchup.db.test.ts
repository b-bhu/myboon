/**
 * #391 the one-off catch-up script, on a throwaway LOCAL Postgres (ANALYST_TEST_ADMIN_URL) with the
 * worker pool acting as the analyst_worker role, exactly like runner.db.test.ts. The LLM, Jev and
 * Clef are scripted and the quota guard is injected, so catchupMain runs end-to-end through its
 * injectable createPool/createLlm/createDeciders/quota: three fresh signals are analysed through
 * the LLM, the one older than 24h is parked backlog_skip_24h without an LLM call, counters and
 * log lines come out, no shelf is created, and a low quota stops before any claim.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';

import { DeciderError, type Decider, type DecisionCase } from './deciders.js';
import { catchupMain, parseCatchupArgs } from './catchup.js';
import { createQuotaGuard, type QuotaCheck } from './ollama-quota.js';
import type { ChatMessage, Llm } from './session.js';
import { spikeCases, spikeShelves } from './test-fixtures/d36-spike.js';

const ADMIN_URL = process.env.ANALYST_TEST_ADMIN_URL?.trim() ?? '';
const KALSHI = spikeCases[5].signal;

type Rule = (c: DecisionCase) => string;
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

/** Scripted LLM with a turn counter; the replies match runner.db.test.ts (dissect, reasoning, note per signal). */
function kalshiLlm(): Llm & { turns: number } {
  const llm = (async (messages: ChatMessage[]) => {
    const turn = messages.filter((m) => m.role === 'assistant').length;
    llm.turns += 1;
    const replies = [
      { summary: 'Kalshi raised $1B at a $40B valuation, per Cointelegraph.', mentions: [{ name: 'Kalshi', type: 'organization', search_terms: [] }] },
      { reasoning: [{ mention: 'Kalshi', reasoning: 'Continues its growth story.' }], reason: 'Not interesting.' },
      { targets: [{ mention: 'Kalshi', type: 'organization', note: 'Cointelegraph reports the raise.' }], reason: 'Routed.' },
    ];
    return JSON.stringify(replies[Math.min(turn, replies.length - 1)]);
  }) as Llm & { turns: number };
  llm.turns = 0;
  return llm;
}

const CONFIRM = 'ANALYST_CATCHUP_CONFIRM';
const MAIN_ENV = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  ANALYST_DATABASE_URL: 'postgres://u:p@localhost:5432/postgres',
  OLLAMA_API_KEY: 'k',
  JEV_API_TOKEN: 't',
  ANALYST_WORKER: 'w391',
  ANALYST_LLM_MODEL: 'glm-5.3-flash',
  [CONFIRM]: 'yes',
  ANALYST_TIMEOUT_MS: '1000',
  ...overrides,
});

/** The full quota type for injection; reading is optional so a stopped check may omit it. */
type FakeQuota = { check(): Promise<QuotaCheck> };

describe('catchup gates (no database needed)', () => {
  async function refusalOf(p: Promise<unknown>): Promise<Error> {
    try {
      await p;
    } catch (e) {
      return e as Error;
    }
    throw new Error('expected catchupMain to refuse');
  }

  it('without ANALYST_CATCHUP_CONFIRM=yes it refuses before any pool exists', async () => {
    let poolsOpened = 0;
    const e = await refusalOf(catchupMain({
      env: MAIN_ENV({ [CONFIRM]: undefined }),
      createPool: () => { poolsOpened += 1; throw new Error('pool must not be created'); },
      log: () => {},
    }));
    expect(e.message).toContain('ANALYST_CATCHUP_CONFIRM');
    expect(e.message).toContain('yes');
    expect(poolsOpened).toBe(0);
  });

  it('--dry-run is refused against a non-local ANALYST_DATABASE_URL before any pool exists', async () => {
    let poolsOpened = 0;
    const e = await refusalOf(catchupMain({
      env: MAIN_ENV({ ANALYST_DATABASE_URL: 'postgres://u:p@db.supabase.co:5432/postgres' }),
      argv: ['--dry-run'],
      createPool: () => { poolsOpened += 1; throw new Error('pool must not be created'); },
      log: () => {},
    }));
    expect(e.message).toContain('--dry-run');
    expect(e.message).toContain('localhost');
    expect(poolsOpened).toBe(0);
  });

  it('parseCatchupArgs: --max N / --max=N parse, defaults are unlimited, junk is refused', () => {
    expect(parseCatchupArgs([])).toEqual({ dryRun: false, max: null });
    expect(parseCatchupArgs(['--max', '3'])).toEqual({ dryRun: false, max: 3 });
    expect(parseCatchupArgs(['--max=3', '--dry-run'])).toEqual({ dryRun: true, max: 3 });
    expect(() => parseCatchupArgs(['--max', '-1'])).toThrow(/--max/);
    expect(() => parseCatchupArgs(['--max', 'x'])).toThrow(/--max/);
    expect(() => parseCatchupArgs(['--bogus'])).toThrow(/--bogus/);
  });
});

describe.skipIf(ADMIN_URL === '')('#391 catchup run (local Postgres, analyst_worker role)', () => {
  let db: ThrowawayDatabase;
  let pool: Pool;
  let workerPool: Pool;
  const workerPoolFor = (url: string) => {
    const p = new Pool({ connectionString: url, max: 2 });
    p.on('connect', (c) => c.query('set role analyst_worker'));
    return p;
  };
  const logOf = () => {
    const lines: string[] = [];
    return { lines, events: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
  };
  const injectables = (o: { quota: FakeQuota; llm?: Llm; argv?: string[]; lines: string[]; ended: { v: boolean } }) => ({
    env: MAIN_ENV({ ANALYST_DATABASE_URL: db.url }),
    argv: o.argv ?? [],
    createPool: (url: string) => {
      const p = workerPoolFor(url);
      const end = p.end.bind(p);
      p.end = (async () => { o.ended.v = true; await end(); }) as Pool['end'];
      return p;
    },
    createLlm: () => o.llm ?? kalshiLlm(),
    createDeciders: () => ({ primary: scripted('jev', keepAll), fallback: scripted('clef', keepAll), shadow: null }),
    quota: o.quota,
    log: (l: string) => { o.lines.push(l); },
  });
  /** 3 fresh signals (-1h, -2h, -3h) and 1 stale one (-30h), all received and due. */
  const seedCatchup = async () => {
    for (const hours of [1, 2, 3, 30]) {
      await pool.query(
        `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
         values ($1, 1, $2, $3, 'news', $4, $5, now() - ($6 || ' hours')::interval)`,
        [`${KALSHI.signal_id}-${hours}h`, KALSHI.source ?? 'tokens_xyz', `src-kalshi-${hours}h`, KALSHI.text, KALSHI.link, String(hours)],
      );
    }
  };
  const statuses = async () =>
    (await pool.query<{ status: string; n: number }>(
      'select status, count(*)::int n from atlas.signals group by status order by status',
    )).rows;

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

  it('3 fresh signals are analysed, the 30h one is parked backlog_skip_24h, the pool ends, stop_reason idle', async () => {
    await seedCatchup();
    const ended = { v: false };
    const { lines } = logOf();
    const summary = await catchupMain(injectables({
      quota: { check: async () => ({ ok: true, reading: { source: 'weekly', remainingPercent: 50 } }) },
      lines, ended,
    }));
    expect(ended.v).toBe(true);
    expect(summary).toEqual({
      stop_reason: 'idle',
      processed: 4, analysed: 3, parked: 1, failed: 0, lost_claim: 0,
      llm_calls: 9, jev_calls: 9, clef_calls: 0,
      quota_checks: 5,
      run_ms: expect.any(Number),
      last_quota: { source: 'weekly', remainingPercent: 50 },
    });
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events[0]).toEqual({ event: 'catchup_start', backlog_24h: 3, older_than_24h: 1 });
    expect(events[events.length - 1]).toEqual({ event: 'catchup_done', stop_reason: 'idle', processed: 4, analysed: 3,
      parked: 1, failed: 0, lost_claim: 0, llm_calls: 9, jev_calls: 9, clef_calls: 0, quota_checks: 5, run_ms: expect.any(Number),
      last_quota: { source: 'weekly', remainingPercent: 50 } });
    // The stale signal is parked with the standing rule's reason; the rest are analysed with a cleared claim.
    await expect(pool.query("select count(*)::int n from atlas.signals where status = 'parked' and parked_reason = 'backlog_skip_24h'"))
      .resolves.toMatchObject({ rows: [{ n: 1 }] });
    expect(await statuses()).toEqual([{ status: 'analysed', n: 3 }, { status: 'parked', n: 1 }]);
    // Items keep the signal's occurred_at, and only the pre-existing shelves exist.
    const items = (await pool.query<{ occurred_at: Date; signal_occurred_at: Date; shelf_slug: string }>(
      `select i.occurred_at, (select occurred_at from atlas.signals where signal_id = i.signal_id) as signal_occurred_at,
              s.slug as shelf_slug
         from atlas.items i join atlas.shelves s on s.id = i.main_shelf_id order by i.occurred_at`,
    )).rows;
    expect(items).toHaveLength(3);
    for (const i of items) expect(i.occurred_at?.getTime()).toBe(i.signal_occurred_at?.getTime());
    expect(items.every((i) => i.shelf_slug === 'kalshi')).toBe(true);
    expect((await pool.query('select count(*)::int n from atlas.shelves')).rows[0].n).toBe(spikeShelves.length);
  });

  it('a weekly remaining of 10% stops after the first check with nothing claimed', async () => {
    await seedCatchup();
    const ended = { v: false };
    const lines: string[] = [];
    const summary = await catchupMain(injectables({
      // A real guard over a fake reading: the same shape catchup.ts would wire in production.
      quota: createQuotaGuard({ read: async () => ({ source: 'weekly', remainingPercent: 10 }) }),
      lines, ended,
    }));
    expect(ended.v).toBe(true);
    expect(summary).toEqual({
      stop_reason: 'quota',
      processed: 0, analysed: 0, parked: 0, failed: 0, lost_claim: 0,
      llm_calls: 0, jev_calls: 0, clef_calls: 0,
      quota_checks: 1,
      run_ms: expect.any(Number),
      last_quota: { source: 'weekly', remainingPercent: 10 },
    });
    expect(await statuses()).toEqual([{ status: 'received', n: 4 }]);
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events[events.length - 2]).toMatchObject({ event: 'catchup_quota_stop', source: 'weekly', remainingPercent: 10 });
    expect(String(events[events.length - 2].reason)).toContain('below');
    expect(events[events.length - 1]).toEqual({ event: 'catchup_done', stop_reason: 'quota', processed: 0, analysed: 0,
      parked: 0, failed: 0, lost_claim: 0, llm_calls: 0, jev_calls: 0, clef_calls: 0, quota_checks: 1, run_ms: expect.any(Number),
      last_quota: { source: 'weekly', remainingPercent: 10 } });
  });

  it('--max 2 stops after two signals with stop_reason max', async () => {
    await seedCatchup();
    const ended = { v: false };
    const lines: string[] = [];
    const summary = await catchupMain(injectables({
      quota: { check: async () => ({ ok: true, reading: { source: 'weekly', remainingPercent: 100 } }) },
      argv: ['--max', '2'],
      lines, ended,
    }));
    expect(ended.v).toBe(true);
    expect(summary).toMatchObject({ stop_reason: 'max', processed: 2, analysed: 2, llm_calls: 6, jev_calls: 6, quota_checks: 2 });
    expect(await statuses()).toEqual([{ status: 'analysed', n: 2 }, { status: 'received', n: 2 }]);
  });
});