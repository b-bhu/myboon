-- squawk-ignore-file ban-drop-table, prefer-robust-stmts
-- #827: drop two dormant tables that nothing in the repo or on the database still uses.
--   atlas.entity_alias_merge_source  65-row staging table from the Nov 3 #566 alias backfill
--   public.manual_command_log        1 row (applied_at 2026-09-10); only link is an FK to public.entities
-- Catalog check on prod (read-only, Nov 24): no inbound foreign keys, no views, no functions, no
-- user triggers, no policies, no publications. DROP is RESTRICT, not CASCADE, so it will fail
-- rather than take anything else with it if a dependency appears before apply.
-- The rollback recreates the schema only. Row data is not in git; restore it from
-- /workspace/backups/827-drop-pre-20261124-174752/ after the rollback, if needed.
-- Rollback: supabase/rollbacks/20261124180000_atlas_drop_dormant_tables.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop table if exists atlas.entity_alias_merge_source restrict;
drop table if exists public.manual_command_log restrict;

commit;
