-- squawk-ignore-file ban-drop-table, ban-drop-column
-- (rollback: drops only the objects 20261120150000 added, inside one short transaction)
-- Rollback of 20261120150000 (#683): revoke entity_worker's column grants on
-- atlas.entities.markets_checked_at, drop atlas.entity_markets (its policies, index and
-- constraints go with it), then drop atlas.entities.markets_checked_at.
-- WARNING: deletes every entity -> market link and every markets_checked_at value. Take a backup
-- first if the table holds data, and stop the #690/#691 code that reads or writes it.
-- Idempotent: safe to rerun, and safe if the up never ran.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'atlas' and table_name = 'entities'
               and column_name = 'markets_checked_at')
     and exists (select 1 from pg_catalog.pg_roles where rolname = 'entity_worker') then
    execute 'revoke select (markets_checked_at), update (markets_checked_at) on atlas.entities from entity_worker';
  end if;
end $$;

drop table if exists atlas.entity_markets;

alter table atlas.entities drop column if exists markets_checked_at;

commit;
