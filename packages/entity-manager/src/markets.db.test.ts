/**
 * #690 the entity markets pass on a throwaway LOCAL Postgres (EM_TEST_ADMIN_URL; skipped when
 * unset). Same harness as claim-scoped.db.test.ts: createThrowawayDatabase applies every atlas
 * migration (including #683's atlas.entity_markets + entities.markets_checked_at) and the pass
 * runs on a pool connecting as entity_worker, so the #683 grants are proven on every statement.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';

import { createThrowawayDatabase, type ThrowawayDatabase } from '../../atlas-schema/src/index.js';
import type { Llm } from './clients.js';
import { loadMarketCandidates, runMarketsPass, writeMarkets, type MarketsPassSummary } from './markets-worker.js';

const ADMIN_URL = process.env.EM_TEST_ADMIN_URL?.trim() ?? '';
const LIVE = async () => new Set(['BTC', 'ETH', 'SOL', 'XRP', 'xyz:CL', 'xyz:GOLD', 'xyz:BRENTOIL']);

describe.skipIf(ADMIN_URL === '')('#690 entity markets (local Postgres)', () => {
  let db: ThrowawayDatabase;
  let admin: pg.Pool;
  let worker: pg.Pool;

  async function seedEntity(slug: string, o: { summary?: string } = {}): Promise<string> {
    const r = await admin.query<{ id: string }>(
      "insert into atlas.entities (slug, name, type, summary, status) values ($1, $1, 'organization', $2, 'active') returning id",
      [slug, o.summary ?? `A ${slug} test entity`],
    );
    return r.rows[0]!.id;
  }

  /** One active item minutesAgo old, with its own signal (entity_items.signal_id references it).
   * Signal/item ids use a file-wide counter: uuidv7 ids created in the same millisecond share
   * their first 8 characters, so a prefix-based id would collide between seeds. */
  let seq = 0;
  async function seedItem(entityId: string, minutesAgo: number, n = ++seq): Promise<void> {
    const sid = `sig-${n}`;
    await admin.query(
      `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link)
       values ($1, 1, 'tokens_xyz', $1, 'news', 'text', 'https://ex.com/' || $1)`,
      [sid],
    );
    await admin.query(
      `insert into atlas.entity_items (item_key, title, summary, main_entity_id, occurred_at, signal_id)
       values ($1, $2, 'summary', $3, now() - make_interval(mins => $4), $5)`,
      [`it-${n}`, `Item ${n}`, entityId, minutesAgo, sid],
    );
  }

  async function setChecked(entityId: string): Promise<void> {
    await admin.query('update atlas.entities set markets_checked_at = now() where id = $1', [entityId]);
  }

  const replyFor = (bySlug: Record<string, string | Error>): Llm => async (messages) => {
    const name = (/^name: (.*)$/m.exec(messages[1]!.content)?.[1] ?? '').trim();
    const r = bySlug[name];
    if (r instanceof Error) throw r;
    return r ?? '{"markets":[]}';
  };

  async function pass(llm: Llm, o: { limit?: number; list?: () => Promise<Set<string>> } = {}): Promise<{ sum: MarketsPassSummary; log: Record<string, unknown>[] }> {
    const log: Record<string, unknown>[] = [];
    const sum = await runMarketsPass({ pool: worker, llm, limit: o.limit ?? 10, list: o.list ?? LIVE, log: (e) => log.push(e) });
    return { sum, log: log.filter((e) => e.event !== 'em_markets_pick') };
  }

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
    await admin.query('truncate atlas.entity_markets, atlas.entity_items, atlas.entities, atlas.signals cascade');
  });

  it('the pass runs as entity_worker, so every statement proves the #683 grants', async () => {
    expect((await worker.query<{ u: string }>('select current_user as u')).rows[0]!.u).toBe('entity_worker');
  });

  it('picks are written with ranks 1..n, set_by model, and markets_checked_at is set', async () => {
    const id = await seedEntity('oil');
    await seedItem(id, 60);
    const { sum, log } = await pass(replyFor({ oil: '{"markets":[{"symbol":"xyz:CL","reason":"US–Iran conflict moves crude"},{"symbol":"BTC","reason":"risk off"}]}' }));
    expect(sum).toMatchObject({ checked: 1, linked: 1, none: 0, retry: 0 });
    expect(log).toContainEqual({ event: 'em_markets', checked: 1, linked: 1, none: 0, retry: 0, skipped: null });
    const rows = (await worker.query<{ rank: number; symbol: string; set_by: string; pinned: boolean }>('select rank, symbol, set_by, pinned from atlas.entity_markets where entity_id = $1 order by rank', [id])).rows;
    expect(rows).toEqual([
      { rank: 1, symbol: 'xyz:CL', set_by: 'model', pinned: false },
      { rank: 2, symbol: 'BTC', set_by: 'model', pinned: false },
    ]);
    const checked = (await admin.query<{ c: string | null }>('select markets_checked_at is not null as c from atlas.entities where id = $1', [id])).rows[0];
    expect(checked.c).toBe(true);
  });

  it('zero picks is a valid none: no rows, timestamp set', async () => {
    const id = await seedEntity('boring');
    await seedItem(id, 30);
    const { sum } = await pass(replyFor({}));
    expect(sum).toMatchObject({ checked: 1, linked: 0, none: 1, retry: 0 });
    expect((await admin.query<{ n: number }>('select count(*)::int n from atlas.entity_markets where entity_id = $1', [id])).rows[0].n).toBe(0);
    expect((await admin.query<{ c: boolean }>('select markets_checked_at is not null c from atlas.entities where id = $1', [id])).rows[0].c).toBe(true);
  });

  it('every pick dropped as unknown also saves none, with the dropped symbols logged', async () => {
    const id = await seedEntity('loopy');
    await seedItem(id, 45);
    const lines: Record<string, unknown>[] = [];
    const sum = await runMarketsPass({
      pool: worker,
      llm: replyFor({ loopy: '{"markets":[{"symbol":"FOO"},{"symbol":"BAR"}]}' }),
      limit: 10,
      list: LIVE,
      log: (e) => lines.push(e),
    });
    expect(sum).toMatchObject({ checked: 1, linked: 0, none: 1, retry: 0 });
    expect(lines.find((e) => e.event === 'em_markets_pick')).toMatchObject({ entity: 'loopy', symbols: [], dropped: ['FOO', 'BAR'] });
    expect((await admin.query<{ n: number }>('select count(*)::int n from atlas.entity_markets where entity_id = $1', [id])).rows[0].n).toBe(0);
    expect((await admin.query<{ c: boolean }>('select markets_checked_at is not null c from atlas.entities where id = $1', [id])).rows[0].c).toBe(true);
  });

  it('a model failure leaves markets_checked_at null (the next run retries and succeeds)', async () => {
    const id = await seedEntity('flaky');
    await seedItem(id, 120);
    const id2 = await seedEntity('garbled');
    await seedItem(id2, 125);
    // one model error, one unparseable reply: both entities stay unchecked
    const { sum, log } = await pass(replyFor({ flaky: new Error('model timed out'), garbled: '{"markets":"BTC"}' }));
    expect(sum).toMatchObject({ checked: 2, linked: 0, none: 0, retry: 2 });
    expect(log).toContainEqual({ event: 'em_markets', checked: 2, linked: 0, none: 0, retry: 2, skipped: null });
    for (const k of [id, id2]) {
      expect((await admin.query<{ c: boolean }>('select markets_checked_at is null c from atlas.entities where id = $1', [k])).rows[0].c).toBe(true);
      expect((await admin.query<{ n: number }>('select count(*)::int n from atlas.entity_markets where entity_id = $1', [k])).rows[0].n).toBe(0);
    }
    // and the next run retries both with a working model: one link, one zero
    const { sum: again } = await pass(replyFor({ flaky: '{"markets":[{"symbol":"BTC"}]}', garbled: '{"markets":[]}' }));
    expect(again).toMatchObject({ checked: 2, linked: 1, none: 1, retry: 0 });
    expect((await admin.query<{ syms: string[] }>("select coalesce(array_agg(symbol order by rank), '{}') syms from atlas.entity_markets where entity_id = $1", [id])).rows[0].syms).toEqual(['BTC']);
  });

  it('an entity already checked is not a candidate, and writeMarkets into a checked entity skips', async () => {
    const id = await seedEntity('once');
    await seedItem(id, 240);
    const w = async (rows: { symbol: string; reason: string | null }[]) =>
      writeMarkets(worker, id, rows.map((p) => ({ ...p, setBy: 'model' as const, pinned: false })));
    expect(await w([{ symbol: 'BTC', reason: 'r' }])).toEqual({ outcome: 'written', rows: 1 });
    expect(await w([{ symbol: 'ETH', reason: 'r' }])).toEqual({ outcome: 'skip' });
    expect((await admin.query<{ syms: string[] }>('select array_agg(symbol order by rank) syms from atlas.entity_markets where entity_id = $1', [id])).rows[0].syms).toEqual(['BTC']);
    // not a candidate any more: a second pass finds nothing to check
    const { sum, log } = await pass(replyFor({}));
    expect(sum).toMatchObject({ checked: 0, linked: 0, none: 0, retry: 0 });
    expect(log).toEqual([{ event: 'em_markets', checked: 0, linked: 0, none: 0, retry: 0, skipped: null }]);
  });

  it('a pinned xyz:GOLD at rank 1 survives, the stale unpinned row is replaced, new picks take ranks 2-3', async () => {
    await seedEntity('gold');
    const eid = (await worker.query<{ id: string }>("select id from atlas.entities where slug = 'gold' and type = 'organization'")).rows[0]!.id;
    await seedItem(eid, 90);
    await admin.query("insert into atlas.entity_markets (entity_id, rank, symbol, set_by, pinned, reason) values ($1, 1, 'xyz:GOLD', 'manual', true, 'pinned by Bibhu')", [eid]);
    await admin.query("insert into atlas.entity_markets (entity_id, rank, symbol, set_by, pinned) values ($1, 2, 'SOL', 'model', false)", [eid]);
    const { sum } = await pass(replyFor({ gold: '{"markets":[{"symbol":"SOL","reason":"stale"},{"symbol":"BTC","reason":"btc"},{"symbol":"ETH","reason":"eth"},{"symbol":"XRP","reason":"cut"}]}' }));
    expect(sum).toMatchObject({ checked: 1, linked: 1 });
    const rows = (await admin.query<{ rank: number; symbol: string; set_by: string; pinned: boolean }>('select rank, symbol, set_by, pinned from atlas.entity_markets where entity_id = $1 order by rank', [eid])).rows;
    expect(rows).toEqual([
      { rank: 1, symbol: 'xyz:GOLD', set_by: 'manual', pinned: true },
      { rank: 2, symbol: 'SOL', set_by: 'model', pinned: false },
      { rank: 3, symbol: 'BTC', set_by: 'model', pinned: false },
    ]);
    expect((await admin.query<{ c: boolean }>('select markets_checked_at is not null c from atlas.entities where id = $1', [eid])).rows[0].c).toBe(true);
  });

  it('an entity whose item is older than 7 days is not a candidate', async () => {
    const id = await seedEntity('staleitem');
    await seedItem(id, 8 * 24 * 60);
    const { sum } = await pass(replyFor({}));
    expect(sum).toMatchObject({ checked: 0, linked: 0, none: 0, retry: 0 });
    expect((await admin.query<{ c: boolean }>('select markets_checked_at is null c from atlas.entities where id = $1', [id])).rows[0].c).toBe(true);
  });

  it('candidates are ordered by the newest item first and honour the limit', async () => {
    const old = await seedEntity('old-entity');
    const newer = await seedEntity('newer-entity');
    const newerStill = await seedEntity('newest-entity');
    await seedItem(old, 20 * 60);
    await seedItem(newer, 300);
    await seedItem(newerStill, 10);
    expect((await loadMarketCandidates(worker, 10)).map((c) => c.slug)).toEqual(['newest-entity', 'newer-entity', 'old-entity']);
    expect((await loadMarketCandidates(worker, 1)).map((c) => c.slug)).toEqual(['newest-entity']);
  });

  it('the retired-symbol guard: only live symbols from the injected list are kept, case-sensitively', async () => {
    const id = await seedEntity('casing');
    await seedItem(id, 70);
    const { sum } = await pass(replyFor({ casing: '{"markets":[{"symbol":"xyz:cl"},{"symbol":"BTC"}]}' }));
    expect(sum).toMatchObject({ checked: 1, linked: 1 });
    expect((await admin.query<{ syms: string[] }>('select array_agg(symbol order by rank) syms from atlas.entity_markets where entity_id = $1', [id])).rows[0].syms).toEqual(['BTC']);
  });

  it('hyperliquid down skips the whole pass, writes nothing, logs it', async () => {
    const id = await seedEntity('downstream');
    await seedItem(id, 15);
    const failing = () => Promise.reject(new Error('hyperliquid down'));
    const sum: MarketsPassSummary = await runMarketsPass({ pool: worker, llm: replyFor({}), limit: 10, list: failing, log: () => {} });
    expect(sum).toEqual({ checked: 0, linked: 0, none: 0, retry: 0 });
    expect((await admin.query<{ c: boolean }>('select markets_checked_at is null c from atlas.entities where id = $1', [id])).rows[0].c).toBe(true);
  });
});
