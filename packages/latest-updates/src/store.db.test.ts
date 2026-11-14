/**
 * The store and the runner on a throwaway LOCAL Postgres (LU_TEST_ADMIN_URL; skipped when unset), with every atlas
 * migration applied, #639 included. The job's pool connects as latest_update_worker, so the grants are proven too:
 * what it reads, what it inserts, and that UPDATE, DELETE and any other table are refused.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createThrowawayDatabase, type ThrowawayDatabase } from '../../atlas-schema/src/index.js';
import { loadRunConfig } from './config.js';
import { freezeSql } from './freeze.js';
import { runOnce } from './runner.js';
import { createPgStore, record } from './store.js';

const ADMIN_URL = process.env.LU_TEST_ADMIN_URL?.trim() ?? '';
const NOW = new Date('2026-11-14T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe.skipIf(ADMIN_URL === '')('latest-updates store and runner (local Postgres, role latest_update_worker)', () => {
  let db: ThrowawayDatabase;
  let admin: pg.Pool;
  let worker: pg.Pool;
  let n = 0;
  const cfg = (over: Record<string, string> = {}) => loadRunConfig(over);

  const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const count = async (table: string) => Number((await q<{ n: string }>(`select count(*) as n from atlas.${table}`))[0]!.n);

  async function entity(slug: string, status = 'active'): Promise<string> {
    return (await q<{ id: string }>('insert into atlas.entities (slug, name, type, status) values ($1, $2, $3, $4) returning id', [slug, slug, 'asset', status]))[0]!.id;
  }
  async function signal(text: string, link: string | null = 'https://example.com/a'): Promise<string> {
    n += 1;
    const id = n.toString(16).padStart(64, '0');
    await q("insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at) values ($1, 1, 'rss', $1, 'news', $2, $3, now())", [id, text, link]);
    return id;
  }
  async function entityItem(entityId: string, title: string, occurredAt: string | null, over: { status?: string; summary?: string; signalId?: string | null; createdAt?: string } = {}): Promise<string> {
    n += 1;
    const id = (await q<{ id: string }>(
      `insert into atlas.entity_items (item_key, title, summary, main_entity_id, occurred_at, signal_id, status, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now())) returning id`,
      [`k${n}`, title, over.summary ?? null, entityId, occurredAt, over.signalId ?? null, over.status ?? 'active', over.createdAt ?? null]))[0]!.id;
    if (over.signalId) await q("insert into atlas.item_signals (item_id, signal_id, role) values ($1, $2, 'origin')", [id, over.signalId]);
    return id;
  }

  beforeAll(async () => {
    db = await createThrowawayDatabase(ADMIN_URL);
    admin = new pg.Pool({ connectionString: db.url, max: 2 });
    worker = new pg.Pool({ connectionString: db.url, max: 3, options: '-c role=latest_update_worker' });
  });
  afterAll(async () => {
    await worker?.end();
    await admin?.end();
    await db?.drop();
  });
  beforeEach(async () => {
    await q('truncate atlas.latest_update_items, atlas.latest_updates, atlas.latest_update_runs, atlas.item_signals, atlas.entity_items, atlas.signals, atlas.entities cascade');
  });

  // The model: writes a good draft citing the entity's newest item, or whatever `reply` says.
  const goodWrite = (itemId: string) => JSON.stringify({
    decision: 'write', reason: 'new number', title: 'Bitcoin slips on ETF outflows',
    what_happened: 'Bitcoin fell below $75,000 as ETF outflows reached $2.1 billion, with IBIT driving 78% of the exit.',
    how_we_got_here: 'Spot funds have seen steady selling through the week.',
    what_to_watch: 'Watch the Dec 10 Fed decision.',
    claims: [{ text: 'ETF outflow of $2.1 billion', source_item_id: itemId, source_signal_id: null }],
  });
  const BTC_SUMMARY = 'BTC lost $75,000 as ETF outflows swelled to $2.1 billion, with IBIT alone 78% of the withdrawals, ahead of the Dec 10 Fed decision.';

  describe('eligibility (window on occurred_at only)', () => {
    it('picks entities whose newest item occurred inside the window; null, future, old and inactive are not eligible even when created a minute ago', async () => {
      const ok = await entity('ok');
      const old = await entity('old');
      const nul = await entity('nul');
      const fut = await entity('fut');
      const inactive = await entity('inactive', 'retired');
      const mergedItem = await entity('merged-item');
      const justCreated = hoursAgo(0.01);
      const okItem = await entityItem(ok, 'ok item', hoursAgo(3), { createdAt: justCreated });
      await entityItem(old, 'old item', hoursAgo(30), { createdAt: justCreated });
      await entityItem(nul, 'null item', null, { createdAt: justCreated });
      await entityItem(fut, 'future item', new Date(NOW.getTime() + 3_600_000).toISOString(), { createdAt: justCreated });
      await entityItem(inactive, 'inactive entity item', hoursAgo(2), { createdAt: justCreated });
      const survivor = await entityItem(mergedItem, 'survivor, outside the window', hoursAgo(30));
      const merged = await entityItem(mergedItem, 'merged item', hoursAgo(2), { createdAt: justCreated });
      await q("update atlas.entity_items set status = 'merged', merged_into_id = $1 where id = $2", [survivor, merged]);

      const c = await createPgStore(worker).listCandidates({ now: NOW, windowHours: 24, limit: 25 });
      expect(c.map((x) => [x.slug, x.newestItemId])).toEqual([['ok', okItem]]);
    });

    it('LATEST_UPDATES_WINDOW_HOURS changes only the length', async () => {
      const e = await entity('e');
      await entityItem(e, 'thirty hours old', hoursAgo(30));
      const store = createPgStore(worker);
      expect(await store.listCandidates({ now: NOW, windowHours: 24, limit: 25 })).toHaveLength(0);
      expect(await store.listCandidates({ now: NOW, windowHours: 48, limit: 25 })).toHaveLength(1);
    });

    it('the newest item is the candidate key; oldest candidate first; the cap applies', async () => {
      const a = await entity('a');
      const b = await entity('b');
      const c = await entity('c');
      await entityItem(a, 'a old', hoursAgo(20));
      const aNew = await entityItem(a, 'a new', hoursAgo(10));
      const bNew = await entityItem(b, 'b', hoursAgo(15));
      const cNew = await entityItem(c, 'c', hoursAgo(5));
      const store = createPgStore(worker);
      const all = await store.listCandidates({ now: NOW, windowHours: 24, limit: 25 });
      expect(all.map((x) => x.newestItemId)).toEqual([bNew, aNew, cNew]);
      const capped = await store.listCandidates({ now: NOW, windowHours: 24, limit: 2 });
      expect(capped.map((x) => x.newestItemId)).toEqual([bNew, aNew]);
    });
  });

  describe('decisions are final per (entity, newest item)', () => {
    it('published: a dark row with its items linked and a published run row; the second tick asks the model nothing and writes nothing', async () => {
      const e = await entity('bitcoin');
      const sig = await signal('Bitcoin slips below $75,000 as ETF outflows hit $2.1 billion; IBIT 78%');
      const newest = await entityItem(e, 'Bitcoin slips below $75,000 as IBIT drives 78% of a $2.1 billion ETF outflow wave', hoursAgo(2), { summary: BTC_SUMMARY, signalId: sig });
      const prior = await entityItem(e, 'Bitcoin ranges quietly', hoursAgo(40), { summary: 'A range of $78,000 to $87,000.' });
      let calls = 0;
      const llm = async () => { calls += 1; return goodWrite(newest); };

      const first = await runOnce({ store: createPgStore(worker), llm, config: cfg(), now: () => NOW });
      expect(first).toMatchObject({ candidates: 1, published: 1, failed: 0 });
      const updates = await q<{ visibility: string; newest_entity_item_id: string; model: string; editor_version: string; run_id: string; claims: unknown[] }>('select * from atlas.latest_updates');
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ visibility: 'dark', newest_entity_item_id: newest, model: 'glm-5.3-flash', editor_version: 'latest-updates-v1' });
      expect(updates[0]!.claims).toHaveLength(1);
      expect((await q('select entity_item_id from atlas.latest_update_items')).map((r) => r.entity_item_id)).toEqual([newest]);
      const runs = await q<{ decision: string; attempt: number; id: string }>('select * from atlas.latest_update_runs');
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ decision: 'published', attempt: 1, id: updates[0]!.run_id });
      void prior;

      const second = await runOnce({ store: createPgStore(worker), llm, config: cfg(), now: () => NOW });
      expect(second.candidates).toBe(0);
      expect(calls).toBe(1);
      expect(await count('latest_updates')).toBe(1);
      expect(await count('latest_update_runs')).toBe(1);
    });

    it.each([['hold'], ['skip']] as const)('%s is terminal: no second model call and no new run row until a newer item arrives', async (decision) => {
      const e = await entity('bitcoin');
      await entityItem(e, 'item one', hoursAgo(5));
      let calls = 0;
      const llm = async () => { calls += 1; return JSON.stringify({ decision, reason: 'r' }); };
      const store = createPgStore(worker);

      await runOnce({ store, llm, config: cfg(), now: () => NOW });
      await runOnce({ store, llm, config: cfg(), now: () => NOW });
      await runOnce({ store, llm, config: cfg(), now: () => NOW });
      expect(calls).toBe(1);
      expect(await count('latest_update_runs')).toBe(1);
      expect(await count('latest_updates')).toBe(0);

      await entityItem(e, 'item two, newer', hoursAgo(1));
      await runOnce({ store, llm, config: cfg(), now: () => NOW });
      expect(calls).toBe(2);
      expect(await count('latest_update_runs')).toBe(2);
    });

    it('a write that fails the bar is a hold row listing the failed checks, and writes no update', async () => {
      const e = await entity('bitcoin');
      const newest = await entityItem(e, 'Bitcoin news', hoursAgo(2), { summary: BTC_SUMMARY });
      const llm = async () => JSON.stringify({
        decision: 'write', reason: 'r', title: 'T', what_happened: 'Bitcoin fell below $75,000 with a $2.1 billion ETF outflow.', how_we_got_here: 'x',
        what_to_watch: 'Watch how the market reacts.', claims: [{ text: 'c', source_item_id: newest, source_signal_id: null }],
      });
      await runOnce({ store: createPgStore(worker), llm, config: cfg(), now: () => NOW });
      const runs = await q<{ decision: string; reason: string; check_failures: Array<{ check: string }> }>('select * from atlas.latest_update_runs');
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ decision: 'hold', reason: 'write bar failed: watch' });
      expect(runs[0]!.check_failures.map((f) => f.check)).toEqual(['watch']);
      expect(await count('latest_updates')).toBe(0);
    });

    it('a repeat of the same pair is refused by the database and reported as already_decided with nothing written', async () => {
      const e = await entity('bitcoin');
      const newest = await entityItem(e, 'item', hoursAgo(2));
      const w = { entityId: e, newestItemId: newest, decision: 'hold' as const, reason: 'thin', checkFailures: [] };
      expect(await record(worker, w)).toEqual({ outcome: 'written', decision: 'hold', attempt: 1 });
      expect(await record(worker, w)).toEqual({ outcome: 'already_decided' });
      expect(await record(worker, { ...w, decision: 'skip' })).toEqual({ outcome: 'already_decided' });
      expect(await count('latest_update_runs')).toBe(1);
    });

    it('two runs racing on the same entity publish one update', async () => {
      const e = await entity('bitcoin');
      const newest = await entityItem(e, 'item', hoursAgo(2));
      const publish = { draft: { title: 't', what_happened: 'w', how_we_got_here: 'h', what_to_watch: 'x', claims: [] }, itemIds: [newest], model: 'm', visibility: 'dark' as const };
      const w = { entityId: e, newestItemId: newest, decision: 'published' as const, reason: 'r', checkFailures: [], publish };
      const results = await Promise.all([record(worker, w), record(worker, w), record(worker, w)]);
      expect(results.filter((r) => r.outcome === 'written')).toHaveLength(1);
      expect(await count('latest_updates')).toBe(1);
      expect(await count('latest_update_runs')).toBe(1);
      expect(await count('latest_update_items')).toBe(1);
    });
  });

  describe('errors retry, then hold', () => {
    it('two error rows, then a hold with reason retries_exhausted; the attempt is the count of error rows; a newer item starts at 1', async () => {
      const e = await entity('bitcoin');
      await entityItem(e, 'item one', hoursAgo(5));
      let calls = 0;
      const llm = async () => { calls += 1; throw Object.assign(new Error('slow'), { name: 'TimeoutError' }); };
      const store = createPgStore(worker);
      const tick = () => runOnce({ store, llm, config: cfg(), now: () => NOW });

      expect(await tick()).toMatchObject({ error: 1, hold: 0 });
      expect((await store.listCandidates({ now: NOW, windowHours: 24, limit: 25 }))[0]!.errorCount).toBe(1);
      expect(await tick()).toMatchObject({ error: 1, hold: 0 });
      expect(await tick()).toMatchObject({ error: 0, hold: 1, retries_exhausted: 1 });
      expect(await tick()).toMatchObject({ candidates: 0 });
      expect(calls).toBe(3);

      const runs = await q<{ decision: string; attempt: number; reason: string }>('select decision, attempt, reason from atlas.latest_update_runs order by created_at, id');
      expect(runs.map((r) => [r.decision, r.attempt])).toEqual([['error', 1], ['error', 2], ['hold', 3]]);
      expect(runs[2]!.reason).toBe('retries_exhausted');
      expect(runs[0]!.reason).toBe('timeout: model timed out');
      expect(await count('latest_updates')).toBe(0);

      await entityItem(e, 'item two, newer', hoursAgo(1));
      expect(await tick()).toMatchObject({ error: 1 });
      const last = await q<{ decision: string; attempt: number }>('select decision, attempt from atlas.latest_update_runs order by created_at desc, id desc limit 1');
      expect(last[0]).toEqual({ decision: 'error', attempt: 1 });
    });

    it('bad JSON writes an error row and nothing else', async () => {
      const e = await entity('bitcoin');
      await entityItem(e, 'item', hoursAgo(5));
      await runOnce({ store: createPgStore(worker), llm: async () => 'not json', config: cfg(), now: () => NOW });
      const runs = await q<{ decision: string; reason: string }>('select decision, reason from atlas.latest_update_runs');
      expect(runs).toHaveLength(1);
      expect(runs[0]!.decision).toBe('error');
      expect(runs[0]!.reason).toMatch(/^bad_json:/);
      expect(await count('latest_updates')).toBe(0);
      expect(await count('latest_update_items')).toBe(0);
    });
  });

  describe('visibility comes from env at insert', () => {
    it.each([[{}, 'dark'], [{ LATEST_UPDATES_VISIBILITY: 'dark' }, 'dark'], [{ LATEST_UPDATES_VISIBILITY: 'live' }, 'live']] as const)('%j writes %s', async (env, expected) => {
      const e = await entity('bitcoin');
      const newest = await entityItem(e, 'Bitcoin news', hoursAgo(2), { summary: BTC_SUMMARY });
      await runOnce({ store: createPgStore(worker), llm: async () => goodWrite(newest), config: cfg(env), now: () => NOW });
      expect((await q<{ visibility: string }>('select visibility from atlas.latest_updates'))[0]!.visibility).toBe(expected);
    });
  });

  describe('cap and order across a run', () => {
    it('handles MAX_PER_RUN entities, oldest first, and the rest wait for the next tick', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const e = await entity(`e${i}`);
        ids.push(await entityItem(e, `item ${i}`, hoursAgo(20 - i * 2)));
      }
      const handled: string[] = [];
      const llm = async (m: Array<{ content: string }>) => { handled.push(/slug: (\S+)/.exec(m[1]!.content)![1]!); return '{"decision":"skip","reason":"r"}'; };
      const store = createPgStore(worker);
      const one = await runOnce({ store, llm, config: cfg({ LATEST_UPDATES_MAX_PER_RUN: '2', LATEST_UPDATES_CONCURRENCY: '1' }), now: () => NOW });
      expect(one.candidates).toBe(2);
      expect(handled).toEqual(['e0', 'e1']);
      await runOnce({ store, llm, config: cfg({ LATEST_UPDATES_MAX_PER_RUN: '2', LATEST_UPDATES_CONCURRENCY: '1' }), now: () => NOW });
      expect(handled).toEqual(['e0', 'e1', 'e2', 'e3']);
      expect(await count('latest_update_runs')).toBe(4);
    });
  });

  describe('what we last published feeds the next run', () => {
    it('the newest latest_updates row becomes the last update, and its items are not new again', async () => {
      const e = await entity('bitcoin');
      const sig = await signal('Bitcoin slips below $75,000 as ETF outflows hit $2.1 billion; IBIT 78%');
      const first = await entityItem(e, 'Bitcoin slips below $75,000 as IBIT drives 78% of a $2.1 billion ETF outflow wave', hoursAgo(6), { summary: BTC_SUMMARY, signalId: sig });
      await runOnce({ store: createPgStore(worker), llm: async () => goodWrite(first), config: cfg(), now: () => NOW });

      const second = await entityItem(e, 'Strategy buys 5,000 BTC', hoursAgo(1), { summary: 'Strategy bought 5,000 BTC.' });
      const store = createPgStore(worker);
      const [cand] = await store.listCandidates({ now: NOW, windowHours: 24, limit: 25 });
      expect(cand!.newestItemId).toBe(second);
      const bundle = await store.loadBundle(cand!, { now: NOW, windowHours: 24 });
      expect(bundle!.last_update).toMatchObject({ kind: 'published', title: 'Bitcoin slips on ETF outflows' });
      expect(bundle!.new_items.map((i) => i.id)).toEqual([second]);
      expect(bundle!.prior_items.map((i) => i.id)).toContain(first);
    });

    it('with no update yet, the newest earlier item is the last update; signals come from item_signals origin and the item itself', async () => {
      const e = await entity('bitcoin');
      const sigA = await signal('origin text A', 'https://example.com/a');
      const sigB = await signal('own signal B', 'https://example.com/b');
      const earlier = await entityItem(e, 'earlier', hoursAgo(40), { signalId: sigA });
      const fresh = await entityItem(e, 'fresh', hoursAgo(2), { signalId: null });
      await q('update atlas.entity_items set signal_id = $1 where id = $2', [sigB, fresh]);
      const store = createPgStore(worker);
      const [cand] = await store.listCandidates({ now: NOW, windowHours: 24, limit: 25 });
      const bundle = await store.loadBundle(cand!, { now: NOW, windowHours: 24 });
      expect(bundle!.last_update).toMatchObject({ kind: 'earlier_item', id: earlier });
      expect(bundle!.new_items.map((i) => i.id)).toEqual([fresh]);
      expect(bundle!.origin_signals.map((s) => s.signal_id).sort()).toEqual([sigA, sigB].sort());
      expect(bundle!.origin_signals[0]).toHaveProperty('numbers');
    });
  });

  describe('a kill mid-entity leaves no half-written rows', () => {
    const publish = (newest: string, extraItem?: string) => ({
      draft: { title: 't', what_happened: 'w', how_we_got_here: 'h', what_to_watch: 'x', claims: [] }, itemIds: extraItem ? [newest, extraItem] : [newest], model: 'm', visibility: 'dark' as const,
    });

    it('a failure after the run and update rows are inserted rolls everything back', async () => {
      const e = await entity('bitcoin');
      const newest = await entityItem(e, 'item', hoursAgo(2));
      const bogus = '01a1d000-0000-7000-8000-00000000dead';
      await expect(record(worker, { entityId: e, newestItemId: newest, decision: 'published', reason: 'r', checkFailures: [], publish: publish(newest, bogus) })).rejects.toThrow(/foreign key/);
      expect(await count('latest_update_runs')).toBe(0);
      expect(await count('latest_updates')).toBe(0);
      expect(await count('latest_update_items')).toBe(0);
    });

    it('a connection killed before commit (as cron_restart would) leaves nothing, and the next tick starts clean', async () => {
      const e = await entity('bitcoin');
      const newest = await entityItem(e, 'item', hoursAgo(2));
      const victim = new pg.Client({ connectionString: db.url, options: '-c role=latest_update_worker' });
      await victim.connect();
      victim.on('error', () => {});
      const pid = (await victim.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      await victim.query('begin');
      const run = await victim.query<{ id: string }>("insert into atlas.latest_update_runs (entity_id, newest_entity_item_id, decision, attempt) values ($1, $2, 'published', 1) returning id", [e, newest]);
      await victim.query(
        "insert into atlas.latest_updates (entity_id, headline, what_happened, how_we_got_here, what_to_watch, newest_entity_item_id, editor_version, model, run_id) values ($1, 'h', 'w', 'h', 'x', $2, 'v', 'm', $3)",
        [e, newest, run.rows[0]!.id]);
      await q('select pg_terminate_backend($1)', [pid]);
      await victim.end().catch(() => {});

      expect(await count('latest_update_runs')).toBe(0);
      expect(await count('latest_updates')).toBe(0);
      const c = await createPgStore(worker).listCandidates({ now: NOW, windowHours: 24, limit: 25 });
      expect(c).toHaveLength(1);
    });
  });

  describe('grants: the worker is insert-only, on three tables', () => {
    const asWorker = async (sql: string, params: unknown[] = []) => worker.query(sql, params);

    it('can insert and select on the three new tables', async () => {
      const e = await entity('bitcoin');
      const i = await entityItem(e, 'item', hoursAgo(2));
      const run = (await asWorker("insert into atlas.latest_update_runs (entity_id, newest_entity_item_id, decision, attempt) values ($1, $2, 'skip', 1) returning id", [e, i])).rows[0]!.id as string;
      expect((await asWorker('select count(*)::int as n from atlas.latest_update_runs')).rows[0]!.n).toBe(1);
      expect(run).toBeTruthy();
    });

    it.each([
      ['UPDATE latest_update_runs', "update atlas.latest_update_runs set reason = 'x'"],
      ['UPDATE latest_updates', "update atlas.latest_updates set visibility = 'live'"],
      ['UPDATE latest_update_items', 'update atlas.latest_update_items set entity_item_id = entity_item_id'],
      ['DELETE latest_update_runs', 'delete from atlas.latest_update_runs'],
      ['DELETE latest_updates', 'delete from atlas.latest_updates'],
      ['DELETE latest_update_items', 'delete from atlas.latest_update_items'],
      ['INSERT stories', 'insert into atlas.stories default values'],
      ['SELECT story_items', 'select * from atlas.story_items limit 1'],
      ['SELECT decisions', 'select * from atlas.decisions limit 1'],
      ['INSERT entities', "insert into atlas.entities (slug, name, type) values ('x', 'x', 'asset')"],
      ['INSERT entity_items', "insert into atlas.entity_items (item_key, title, main_entity_id) values ('x', 'x', gen_random_uuid())"],
      ['UPDATE entity_items', "update atlas.entity_items set title = 'x'"],
      ['DELETE signals', 'delete from atlas.signals'],
      ['INSERT item_signals', "insert into atlas.item_signals (item_id, signal_id, role) values (gen_random_uuid(), 'x', 'origin')"],
    ])('%s is refused by Postgres', async (_name, sql) => {
      await expect(asWorker(sql)).rejects.toMatchObject({ code: '42501' });
    });

    it('the runner never needs more than that: a whole publish run succeeds as the worker', async () => {
      const e = await entity('bitcoin');
      const newest = await entityItem(e, 'Bitcoin news', hoursAgo(2), { summary: BTC_SUMMARY });
      const s = await runOnce({ store: createPgStore(worker), llm: async () => goodWrite(newest), config: cfg(), now: () => NOW });
      expect(s.failed).toBe(0);
      expect(s.published).toBe(1);
    });
  });

  describe('the eval-only freeze query', () => {
    it('is a valid read-only SELECT on the real schema (empty result on an empty set)', async () => {
      const res = await admin.query<{ ents: unknown }>(freezeSql({ basis: 'created_at', hours: 72, until: '2026-11-14T01:00:00Z' }));
      expect(res.rows).toEqual([{ ents: null }]);
    });

    it('returns entities in the eval shape when there is data', async () => {
      const e = await entity('bitcoin');
      const sig = await signal('text', 'https://example.com/a');
      await entityItem(e, 'old', '2026-11-01T00:00:00Z', { createdAt: '2026-11-01T00:00:00Z' });
      await entityItem(e, 'new', '2026-11-09T00:00:00Z', { createdAt: '2026-11-13T00:00:00Z', signalId: sig });
      const res = await admin.query<{ ents: Array<{ slug: string; new_items: unknown[]; prior_items: unknown[]; last_update: { title: string }; origin_signals: unknown[] }> }>(
        freezeSql({ basis: 'created_at', hours: 72, until: '2026-11-14T01:00:00Z' }));
      const ent = res.rows[0]!.ents[0]!;
      expect(ent.slug).toBe('bitcoin');
      expect(ent.new_items).toHaveLength(1);
      expect(ent.last_update.title).toBe('old');
      expect(ent.origin_signals).toHaveLength(1);
    });
  });
});
