/**
 * TEMPORARY (#505): the CTO-approved stories schema rows 1-5, applied to a throwaway test DB until
 * DB Guy's stories migration lands. Delete this file (and its one call in story-writer.db.test.ts)
 * once that migration is on the branch. Never a migration; never run against a non-local DB.
 */
import pg from 'pg';
import { assertLocalUrl } from '@myboon/atlas-schema';

export const STORIES_SCHEMA_505 = `
alter table atlas.stories add column shelf_id uuid not null references atlas.shelves (id);
alter table atlas.stories add column status text not null default 'open' check (status in ('open', 'closed'));
create index stories_shelf_open_idx on atlas.stories (shelf_id, created_at desc) where status = 'open';
grant select (id, shelf_id, slug, title, summary, status, created_at, updated_at) on atlas.stories to analyst_worker;
grant insert (shelf_id, slug, title, summary, status) on atlas.stories to analyst_worker;
grant update (title, summary, updated_at) on atlas.stories to analyst_worker;
grant select (story_id, item_id, position, created_at) on atlas.story_items to analyst_worker;
grant insert (story_id, item_id, position) on atlas.story_items to analyst_worker;
alter table atlas.stories enable row level security;
alter table atlas.story_items enable row level security;
create policy analyst_worker_select on atlas.stories for select to analyst_worker using (true);
create policy analyst_worker_insert on atlas.stories for insert to analyst_worker with check (true);
create policy analyst_worker_update on atlas.stories for update to analyst_worker using (true) with check (true);
create policy analyst_worker_select on atlas.story_items for select to analyst_worker using (true);
create policy analyst_worker_insert on atlas.story_items for insert to analyst_worker with check (true);
`;

export async function applyStoriesSchema505(url: string): Promise<void> {
  assertLocalUrl(url);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { await c.query(STORIES_SCHEMA_505); } finally { await c.end(); }
}
