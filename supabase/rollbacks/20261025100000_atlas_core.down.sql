-- squawk-ignore-file ban-drop-table, ban-drop-function, ban-drop-schema, prefer-robust-stmts
-- Why: rollback of objects created by the paired migration; no client uses atlas yet.
-- Runs as one transaction; IF EXISTS would hide a half-applied state.
-- Rollback for 20261025100000_atlas_core.sql. Drops only the new atlas schema and role.
set lock_timeout = '5s';
set statement_timeout = '60s';

alter default privileges in schema atlas revoke select on tables from atlas_analyst;
alter default privileges in schema atlas grant execute on functions to public;
drop schema atlas cascade;
do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'atlas_analyst') then
    drop role atlas_analyst;
  end if;
end $$;
