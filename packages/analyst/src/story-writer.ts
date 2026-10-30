/**
 * #505 story writer: groups an entity's new analyst items (angles new_story / existing_story) into
 * atlas.stories. Runs as analyst_worker, which may only insert stories/story_items and update a
 * story's title, summary and updated_at — never the items themselves; plain_update items are never
 * touched and never sent to the LLM. Per shelf the linking happens in one transaction behind the
 * `story:` advisory lock, and it commits BEFORE the LLM runs: for every story that just gained an
 * item or is still waiting for its text (summary null), GLM is called once with the notes of all
 * its linked items, oldest first, and must answer a JSON {"title","text"} from those notes only. A
 * GLM failure leaves summary null (pending) for the next run to retry; nothing here closes a story
 * or forces an entity to keep only one open story.
 */
import type { Pool, PoolClient } from 'pg';

import type { ChatMessage, Llm } from './session.js';
import type { Db } from './states.js';

/** Options for writeStories: the LLM session and where story_text_failed lines go. */
export type WriteStoriesOptions = {
  llm: Llm;
  /** Where failed story texts are logged; the default keeps them on the worker's stdout. */
  log?: (e: Record<string, unknown>) => void;
};

/** One run's outcome: items linked, stories whose text was written, stories still without text. */
export type WriteStoriesResult = { linked: number; written: number; pending: number };

/** A story candidate item: the title is never null, the note can be. */
type CandidateItem = { id: string; title: string; note: string | null; angle: string; main_shelf_id: string };

const asMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Link the new items into stories, then write the texts. linked = items linked this run,
 * written = stories whose text was written this run, pending = stories still with a null summary
 * after the run.
 */
export async function writeStories(db: Pool, o: WriteStoriesOptions): Promise<WriteStoriesResult> {
  const log = o.log ?? ((e: Record<string, unknown>) => console.log(JSON.stringify(e)));
  const touched: string[] = [];
  const client = await db.connect();
  try {
    const items = (await client.query<CandidateItem>(
      `select id, title, note, angle, main_shelf_id
         from atlas.items
        where status = 'active'
          and angle in ('new_story', 'existing_story')
          and not exists (select 1 from atlas.story_items si where si.item_id = atlas.items.id)
        order by occurred_at asc nulls last, created_at asc, id asc`,
    )).rows;
    const byShelf = new Map<string, CandidateItem[]>();
    for (const item of items) {
      const onShelf = byShelf.get(item.main_shelf_id) ?? [];
      onShelf.push(item);
      byShelf.set(item.main_shelf_id, onShelf);
    }
    for (const [shelfId, onShelf] of byShelf) {
      await linkShelfItems(client, shelfId, onShelf, touched);
    }
  } finally {
    client.release();
  }
  const written = await writeStoryTexts(db, o.llm, log, touched);
  const pending = Number((await db.query<{ pending: number }>(
    'select count(*)::int as pending from atlas.stories where summary is null',
  )).rows[0].pending);
  return { linked: touched.length, written, pending };
}

/**
 * One shelf, one transaction: the advisory lock serialises story writers on this shelf, so a writer
 * that raced ahead of us commits its links first and our re-read then finds the items already
 * linked. The commit lands before any GLM call.
 */
async function linkShelfItems(client: PoolClient, shelfId: string, candidates: CandidateItem[], touched: string[]): Promise<void> {
  await client.query('begin');
  try {
    await client.query("select pg_advisory_xact_lock(hashtext('story:' || $1))", [shelfId]);
    const shelf = (await client.query<{ slug: string }>('select slug from atlas.shelves where id = $1', [shelfId])).rows[0];
    if (!shelf) throw new Error(`shelf ${shelfId} missing`);
    const items = (await client.query<CandidateItem>(
      `select id, title, note, angle
         from atlas.items
        where id = any($1)
          and status = 'active'
          and angle in ('new_story', 'existing_story')
          and not exists (select 1 from atlas.story_items si where si.item_id = atlas.items.id)
        order by occurred_at asc nulls last, created_at asc, id asc`,
      [candidates.map((item) => item.id)],
    )).rows;
    for (const item of items) {
      const open = item.angle === 'existing_story' ? await latestOpenStory(client, shelfId) : null;
      const storyId = open ?? (await insertStory(client, shelfId, shelf.slug, item));
      await client.query(
        'insert into atlas.story_items (story_id, item_id, position) values ($1, $2, $3)',
        [storyId, item.id, await nextPosition(client, storyId)],
      );
      touched.push(storyId);
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  }
}

/** The shelf's latest open story (created_at desc, id desc), or null when none is open. */
async function latestOpenStory(client: PoolClient, shelfId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `select id from atlas.stories
      where shelf_id = $1 and status = 'open'
      order by created_at desc, id desc
      limit 1`,
    [shelfId],
  );
  return rows[0]?.id ?? null;
}

/** One open story on the shelf: item title first, GLM text later; slug is <shelf slug>-<8 hex chars of a fresh id>. */
async function insertStory(client: PoolClient, shelfId: string, shelfSlug: string, item: CandidateItem): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into atlas.stories (shelf_id, slug, title, summary, status)
     values ($1, $2 || '-' || substring(gen_random_uuid()::text from 1 for 8), $3, null, 'open')
     returning id`,
    [shelfId, shelfSlug, item.title],
  );
  return rows[0].id;
}

/** The story's next item position: max + 1, so 1 for a fresh story. */
async function nextPosition(client: PoolClient, storyId: string): Promise<number> {
  const { rows } = await client.query<{ next: number }>(
    'select coalesce(max(position), 0)::int + 1 as next from atlas.story_items where story_id = $1',
    [storyId],
  );
  return rows[0].next;
}

/** GLM once per story that just gained an item or has no text yet; a failure stays pending. */
async function writeStoryTexts(db: Pool, llm: Llm, log: (e: Record<string, unknown>) => void, touched: string[]): Promise<number> {
  const targets = new Set<string>(touched);
  for (const row of (await db.query<{ id: string }>('select id from atlas.stories where summary is null')).rows) {
    targets.add(row.id);
  }
  let written = 0;
  for (const storyId of targets) {
    try {
      const reply = parseStoryReply(await llm(storyMessages(await storyNotes(db, storyId))));
      await db.query(
        'update atlas.stories set title = $1, summary = $2, updated_at = now() where id = $3',
        [reply.title, reply.text, storyId],
      );
      written += 1;
    } catch (e) {
      log({ event: 'story_text_failed', story_id: storyId, error: asMessage(e) });
    }
  }
  return written;
}

/** All of the story's linked item notes, oldest first — the only facts the writer sees. */
async function storyNotes(db: Db, storyId: string): Promise<string[]> {
  const { rows } = await db.query<{ title: string; note: string | null }>(
    `select i.title, i.note
       from atlas.story_items si
       join atlas.items i on i.id = si.item_id
      where si.story_id = $1
      order by i.occurred_at asc nulls last, i.created_at asc, i.id asc`,
    [storyId],
  );
  return rows.map((row) => (row.note !== null && row.note.trim() !== '' ? row.note : row.title));
}

/** One GLM turn: the notes, then the instruction — the reply must be JSON {"title","text"}. */
function storyMessages(notes: string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'You are the story writer. You write one story for one entity out of the analyst notes about it, and nothing else.',
    },
    {
      role: 'user',
      content:
        `Notes, oldest first:\n${notes.map((note) => `- ${note}`).join('\n')}\n\n` +
        'Write a short title and a short text for this story from these notes only: no new facts, keep the who-said-it wording. ' +
        'Reply with JSON only: {"title": string, "text": string}.',
    },
  ];
}

/** Strip ``` fences, take the first {...}, parse; both title and text must be non-empty strings. */
function parseStoryReply(raw: string): { title: string; text: string } {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`story reply has no JSON object: ${text.slice(0, 300)}`);
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  const reply = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const title = typeof reply.title === 'string' ? reply.title.trim() : '';
  const body = typeof reply.text === 'string' ? reply.text.trim() : '';
  if (title === '' || body === '') throw new Error('story reply has no title/text');
  return { title, text: body };
}