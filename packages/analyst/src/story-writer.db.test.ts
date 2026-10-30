/**
 * #505 story writer (D36), tests first. Throwaway LOCAL Postgres (ANALYST_TEST_ADMIN_URL) seeded with a
 * real scout signal; the writer runs as analyst_worker. GLM is a scripted Llm (answers and errors).
 *
 * Written against the schema proposed on #505 (spec-covered rows #1-#5 only): atlas.stories.shelf_id,
 * atlas.stories.status ('open'), and analyst_worker grants on stories/story_items. A null stories.summary
 * means the text is pending. CTO answers: existing_story with no open story starts one; merged items are skipped; no
 * one-open-story index and no closing of stories.
 *
 * Expected API (not built yet): `writeStories(db, { llm, log }) => { linked, written, pending }` from
 * './story-writer.js'. The module is imported lazily so each scenario fails on its own until it exists.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';
import type { ChatMessage, Llm } from './session.js';
import { spikeCases } from './test-fixtures/d36-spike.js';
import { applyStoriesSchema505 } from './test-fixtures/stories-schema-505.js'; // TEMPORARY until DB Guy's migration

const ADMIN_URL = process.env.ANALYST_TEST_ADMIN_URL?.trim() ?? '';
const SIGNAL = spikeCases[5].signal; // a real scout signal (Cointelegraph via tokens_xyz)

type WriteStories = (db: Pool, o: { llm: Llm; log?: (e: Record<string, unknown>) => void }) =>
  Promise<{ linked: number; written: number; pending: number }>;
const load = async (): Promise<WriteStories> => {
  const path = './story-writer.js';
  return ((await import(/* @vite-ignore */ path)) as { writeStories: WriteStories }).writeStories;
};

/** Scripted GLM: returns a title + text built only from the notes it is shown, or fails. */
function glm(o: { fail?: boolean } = {}): Llm & { calls: number; seen: ChatMessage[][] } {
  const llm = (async (m: ChatMessage[]) => {
    llm.calls += 1; llm.seen.push(m);
    if (o.fail) throw new Error('GLM HTTP 503');
    return JSON.stringify({ title: 'Kalshi raises $1B', text: 'Cointelegraph reports Kalshi raised $1B.' });
  }) as Llm & { calls: number; seen: ChatMessage[][] };
  llm.calls = 0; llm.seen = [];
  return llm;
}

describe.skipIf(ADMIN_URL === '')('#505 story writer (local Postgres)', () => {
  let db: ThrowawayDatabase;
  let pool: Pool;    // admin: setup and assertion reads only
  let worker: Pool;  // every connection runs as analyst_worker
  let shelfId: string;

  beforeAll(async () => {
    db = await createThrowawayDatabase(ADMIN_URL);
    await applyStoriesSchema505(db.url); // TEMPORARY until DB Guy's migration
    pool = new Pool({ connectionString: db.url, max: 4 });
    worker = new Pool({ connectionString: db.url, max: 4 });
    worker.on('connect', (c) => c.query('set role analyst_worker'));
  });
  afterAll(async () => { await worker?.end(); await pool?.end(); await db?.drop(); });
  beforeEach(async () => {
    await pool.query('truncate atlas.story_items, atlas.stories, atlas.item_signals, atlas.decisions, atlas.signals cascade');
    await pool.query('delete from atlas.items');
    await pool.query('delete from atlas.shelves');
    shelfId = (await pool.query<{ id: string }>(
      `insert into atlas.shelves (slug, name, type, status) values ('kalshi', 'Kalshi', 'organization', 'active') returning id`)).rows[0].id;
    await pool.query(
      `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
       values ($1, 1, $2, 'src-kalshi', 'news', $3, $4, now())`,
      [SIGNAL.signal_id, SIGNAL.source ?? 'tokens_xyz', SIGNAL.text, SIGNAL.link]);
  });

  const item = async (key: string, angle: string, note: string, at = 'now()') => (await pool.query<{ id: string }>(
    `insert into atlas.items (item_key, title, summary, main_shelf_id, signal_id, angle, note, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $3, ${at}) returning id`,
    [key, note, note, shelfId, SIGNAL.signal_id, angle])).rows[0].id;
  const stories = async () => (await pool.query(
    'select id, shelf_id, status, title, summary from atlas.stories order by created_at')).rows;
  const links = async () => (await pool.query('select story_id, item_id from atlas.story_items')).rows;

  it('new_story: one new open story linked to that entity and item', async () => {
    const writeStories = await load();
    const id = await item('k1', 'new_story', 'Cointelegraph reports the raise.');
    await writeStories(worker, { llm: glm() });
    const s = await stories();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ shelf_id: shelfId, status: 'open', title: 'Kalshi raises $1B' });
    expect(s[0].summary).toContain('Cointelegraph reports');
    expect(await links()).toEqual([{ story_id: s[0].id, item_id: id }]);
  });

  it('existing_story: the latest open story on that entity gains the item and updated text', async () => {
    const writeStories = await load();
    const old = await item('k0', 'new_story', 'Kalshi files to raise.', "now() - interval '2 days'");
    await writeStories(worker, { llm: glm() });
    const [before] = await stories();
    const next = await item('k1', 'existing_story', 'Cointelegraph reports the raise.');
    const llm = glm();
    await writeStories(worker, { llm });
    const after = await stories();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect((await links()).map((l) => l.item_id).sort()).toEqual([old, next].sort());
    expect(llm.calls).toBe(1);
    // GLM is shown both notes (no new facts beyond them).
    const prompt = JSON.stringify(llm.seen[0]);
    expect(prompt).toContain('Kalshi files to raise.');
    expect(prompt).toContain('Cointelegraph reports the raise.');
  });

  it('plain_update: no story changes, no GLM call, and the item stays on the entity', async () => {
    const writeStories = await load();
    const id = await item('k1', 'plain_update', 'Kalshi posts volume stats.');
    const llm = glm();
    await writeStories(worker, { llm });
    expect(await stories()).toHaveLength(0);
    expect(await links()).toHaveLength(0);
    expect(llm.calls).toBe(0);
    const { rows } = await pool.query('select angle, note, main_shelf_id from atlas.items where id = $1', [id]);
    expect(rows[0]).toEqual({ angle: 'plain_update', note: 'Kalshi posts volume stats.', main_shelf_id: shelfId });
  });

  it('GLM down: the item stays linked with pending text, and a retry fills the text', async () => {
    const writeStories = await load();
    const id = await item('k1', 'new_story', 'Cointelegraph reports the raise.');
    const r1 = await writeStories(worker, { llm: glm({ fail: true }), log: () => {} });
    expect(r1).toMatchObject({ linked: 1, written: 0, pending: 1 });
    const [s1] = await stories();
    expect(s1.summary).toBeNull();
    expect(await links()).toEqual([{ story_id: s1.id, item_id: id }]);
    const r2 = await writeStories(worker, { llm: glm() });
    expect(r2).toMatchObject({ linked: 0, written: 1, pending: 0 });
    const s2 = await stories();
    expect(s2).toHaveLength(1);
    expect(s2[0].summary).toContain('Cointelegraph reports');
  });

  it('never changes an item angle or note, and a rerun is a no-op', async () => {
    const writeStories = await load();
    await item('k1', 'new_story', 'Cointelegraph reports the raise.');
    const before = (await pool.query('select id, angle, note, updated_at from atlas.items order by id')).rows;
    await writeStories(worker, { llm: glm() });
    const llm = glm();
    expect(await writeStories(worker, { llm })).toMatchObject({ linked: 0, written: 0, pending: 0 });
    expect(llm.calls).toBe(0);
    expect((await pool.query('select id, angle, note, updated_at from atlas.items order by id')).rows).toEqual(before);
    expect(await stories()).toHaveLength(1);
  });

  it('existing_story with no open story on the entity starts a new story (CTO, #505)', async () => {
    const writeStories = await load();
    const id = await item('k1', 'existing_story', 'Cointelegraph reports the raise.');
    await writeStories(worker, { llm: glm() });
    const s = await stories();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ shelf_id: shelfId, status: 'open' });
    expect(await links()).toEqual([{ story_id: s[0].id, item_id: id }]);
  });

  it('merged items are skipped (CTO, #505)', async () => {
    const writeStories = await load();
    const live = await item('k1', 'new_story', 'Cointelegraph reports the raise.');
    const dup = await item('k2', 'new_story', 'Duplicate of the raise.');
    await pool.query(`update atlas.items set status = 'merged', merged_into_id = $1 where id = $2`, [live, dup]);
    const llm = glm();
    await writeStories(worker, { llm });
    expect((await links()).map((l) => l.item_id)).toEqual([live]);
    expect(JSON.stringify(llm.seen)).not.toContain('Duplicate of the raise.');
  });
});
