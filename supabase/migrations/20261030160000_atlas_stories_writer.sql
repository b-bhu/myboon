-- squawk-ignore-file adding-required-field, require-concurrent-index-creation, constraint-missing-not-valid, adding-foreign-key-constraint, prefer-robust-stmts
-- #505: schema for the story writer, rows 1-5 of the CTO-approved column list
-- (https://github.com/b-bhu/myboon/issues/505#issuecomment-6520349410):
--   1. stories.shelf_id uuid not null -> atlas.shelves(id)
--   2. stories.status text not null default 'open', check in ('open','closed')
--   3. partial index for "latest open story per entity"
--   4. analyst_worker: select, insert (shelf_id, slug, title, summary, status),
--      update (title, summary, updated_at) on stories, with RLS policies
--   5. analyst_worker: select, insert (story_id, item_id, position) on story_items, with RLS
-- Deliberately NOT here: a unique one-open-per-entity index (row 6) and update (status) (row 7).
-- squawk ignores: atlas.stories and atlas.story_items are empty on prod (0 rows, checked
-- 2026-10-30), and the guard below aborts if that ever changes, so the not-null column, the
-- validated FK/check and the plain (non-CONCURRENTLY) index lock an empty table for
-- milliseconds. CONCURRENTLY cannot run inside this one-transaction migration (same as #503).
-- Rollback: supabase/rollbacks/20261030160000_atlas_stories_writer.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if exists (select 1 from atlas.stories) then
    raise exception '#505: atlas.stories is not empty; add shelf_id nullable, backfill, then validate';
  end if;
end $$;

alter table atlas.stories
  add column shelf_id uuid not null references atlas.shelves (id),
  add column status text not null default 'open' constraint stories_status_check check (status in ('open', 'closed'));

create index stories_shelf_open_idx on atlas.stories (shelf_id, created_at desc) where status = 'open';

-- Column grants only (analyst_worker is created by 20261030120000).
grant select (id, shelf_id, slug, title, summary, status, created_at, updated_at)
  on atlas.stories to analyst_worker;
grant insert (shelf_id, slug, title, summary, status) on atlas.stories to analyst_worker;
grant update (title, summary, updated_at) on atlas.stories to analyst_worker;
grant select (story_id, item_id, position, created_at) on atlas.story_items to analyst_worker;
grant insert (story_id, item_id, position) on atlas.story_items to analyst_worker;

create policy analyst_worker_select on atlas.stories for select to analyst_worker using (true);
create policy analyst_worker_insert on atlas.stories for insert to analyst_worker with check (true);
create policy analyst_worker_update on atlas.stories for update to analyst_worker using (true) with check (true);
create policy analyst_worker_select on atlas.story_items for select to analyst_worker using (true);
create policy analyst_worker_insert on atlas.story_items for insert to analyst_worker with check (true);

commit;
