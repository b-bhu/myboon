-- squawk-ignore-file ban-drop-function
-- Rollback for supabase/migrations/20261113190000_atlas_em_claim_scoped.sql (#621). Drops the new function only; atlas.em_claim is untouched.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
drop function if exists atlas.em_claim_scoped(text, text, interval, integer);
commit;
