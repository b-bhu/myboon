-- squawk-ignore-file ban-drop-column, prefer-robust-stmts
-- Rollback of 20261030160000 (#505): drop the analyst_worker policies and grants on
-- stories/story_items, the open-story index, and the shelf_id/status columns.
-- Idempotent: safe to rerun, and safe if the up never ran. Drops story data in those two
-- columns, so only run it before the story writer has written anything.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop policy if exists analyst_worker_select on atlas.stories;
drop policy if exists analyst_worker_insert on atlas.stories;
drop policy if exists analyst_worker_update on atlas.stories;
drop policy if exists analyst_worker_select on atlas.story_items;
drop policy if exists analyst_worker_insert on atlas.story_items;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'analyst_worker') then
    -- Table-level REVOKE ALL also removes the column grants.
    execute 'revoke all on atlas.stories from analyst_worker';
    execute 'revoke all on atlas.story_items from analyst_worker';
  end if;
end $$;

-- stories_shelf_open_idx is on shelf_id/status, so dropping the columns drops it too.
alter table atlas.stories drop column if exists status;
alter table atlas.stories drop column if exists shelf_id;

commit;
