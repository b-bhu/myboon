-- #397 follow-up (CTO-approved Oct 25 2026): clear advisor findings.
-- 1) RLS on published_narratives. No policy: only service_role (BYPASSRLS) reads it,
--    and anon/authenticated grants were revoked in 20261025140056.
-- 2) Pin search_path on 3 functions (advisor 0011).
--    exec_sql runs caller-supplied SQL that uses unqualified table names, so it
--    keeps public on the path. The other two only use pg_catalog (now(), case).
-- Rollback: supabase/rollbacks/20261025140436_rls_published_narratives_pin_search_path.down.sql

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.published_narratives ENABLE ROW LEVEL SECURITY;

ALTER FUNCTION public.exec_sql(text) SET search_path = pg_catalog, public;
ALTER FUNCTION public.touch_ai_explanations_updated_at() SET search_path = '';
ALTER FUNCTION public.token_source_rank(text) SET search_path = '';

COMMIT;
