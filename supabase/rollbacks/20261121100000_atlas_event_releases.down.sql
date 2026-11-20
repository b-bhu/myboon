-- squawk-ignore-file ban-drop-table
-- (rollback: drops only the objects 20261121100000 added, inside one short transaction)
-- Rollback of 20261121100000 (#701): drop the calendar_worker policy on atlas.entities, drop
-- atlas.event_releases (its policies, indexes and constraints go with it), then revoke
-- calendar_worker's grants and drop the role.
-- WARNING: deletes every stored event release. Take a backup first if the table holds data; the
-- rows can be re-fetched from Backpack by the #702 backfill.
-- If the role has LOGIN on prod, stop the calendar ingest job first: drop role fails while connected.
-- Idempotent: safe to rerun, and safe if the up never ran.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop policy if exists calendar_worker_select on atlas.entities;

drop table if exists atlas.event_releases;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'calendar_worker') then
    execute 'revoke all on all tables in schema atlas from calendar_worker';
    execute 'revoke all on all sequences in schema atlas from calendar_worker';
    execute 'revoke all on all functions in schema atlas from calendar_worker';
    execute 'revoke all on schema atlas from calendar_worker';
    execute 'drop role calendar_worker';
  end if;
end $$;

commit;
