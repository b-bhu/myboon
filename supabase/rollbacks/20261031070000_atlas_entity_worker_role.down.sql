-- Rollback of 20261031070000 (#480): drop the entity_worker policies, revoke its grants, drop the
-- role. Idempotent: safe to rerun, and safe if the up never ran. No data is touched.
-- If the role has LOGIN on prod, stop the entity manager first: drop role fails while connected.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop policy if exists entity_worker_select on atlas.shelves;
drop policy if exists entity_worker_update on atlas.shelves;
drop policy if exists entity_worker_select on atlas.items;
drop policy if exists entity_worker_update on atlas.items;
drop policy if exists entity_worker_select on atlas.decisions;
drop policy if exists entity_worker_select on atlas.entity_reviews;
drop policy if exists entity_worker_insert on atlas.entity_reviews;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'entity_worker') then
    execute 'revoke all on all tables in schema atlas from entity_worker';
    execute 'revoke all on all sequences in schema atlas from entity_worker';
    execute 'revoke all on all functions in schema atlas from entity_worker';
    execute 'revoke all on schema atlas from entity_worker';
    execute 'drop role entity_worker';
  end if;
end $$;

commit;
