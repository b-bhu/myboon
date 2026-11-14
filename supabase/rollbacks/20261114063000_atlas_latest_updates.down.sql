-- squawk-ignore-file ban-drop-table, require-concurrent-index-deletion
-- (rollback: drops only the objects 20261114063000 added, inside one short transaction)
-- Rollback of 20261114063000 (#630): drop the latest_update_worker policies on the four input
-- tables, the three latest-updates tables (their policies, indexes and constraints go with them),
-- then the role and its grants. Idempotent: safe to rerun, and safe if the up never ran.
-- Drops latest-update rows and run decisions: take a backup first if the tables hold data.
-- If the role has LOGIN on prod, stop the latest updates job first: drop role fails while connected.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop policy if exists latest_update_worker_select on atlas.entities;
drop policy if exists latest_update_worker_select on atlas.entity_items;
drop policy if exists latest_update_worker_select on atlas.item_signals;
drop policy if exists latest_update_worker_select on atlas.signals;

drop table if exists atlas.latest_update_items;
drop table if exists atlas.latest_updates;
drop table if exists atlas.latest_update_runs;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'latest_update_worker') then
    execute 'revoke all on all tables in schema atlas from latest_update_worker';
    execute 'revoke all on all sequences in schema atlas from latest_update_worker';
    execute 'revoke all on all functions in schema atlas from latest_update_worker';
    execute 'revoke all on schema atlas from latest_update_worker';
    execute 'drop role latest_update_worker';
  end if;
end $$;

commit;
