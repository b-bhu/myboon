-- Rollback of 20261030120000 (#512): drop the analyst_worker policies, revoke its grants,
-- drop the role. Idempotent: safe to rerun, and safe if the up never ran. No data is touched.
-- If the role has LOGIN on prod, stop the analyst first: drop role fails while it is connected.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop policy if exists analyst_worker_select on atlas.signals;
drop policy if exists analyst_worker_update on atlas.signals;
drop policy if exists analyst_worker_select on atlas.decisions;
drop policy if exists analyst_worker_insert on atlas.decisions;
drop policy if exists analyst_worker_select on atlas.items;
drop policy if exists analyst_worker_insert on atlas.items;
drop policy if exists analyst_worker_select on atlas.shelves;
drop policy if exists analyst_worker_insert on atlas.shelves;
drop policy if exists analyst_worker_insert on atlas.tool_log;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'analyst_worker') then
    -- Table-level REVOKE ALL also removes the column grants.
    execute 'revoke all on all tables in schema atlas from analyst_worker';
    execute 'revoke all on all sequences in schema atlas from analyst_worker';
    execute 'revoke all on all functions in schema atlas from analyst_worker';
    execute 'revoke all on schema atlas from analyst_worker';
    execute 'drop role analyst_worker';
  end if;
end $$;

commit;
