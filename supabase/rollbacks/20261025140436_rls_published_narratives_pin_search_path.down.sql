-- Rollback for 20261025140436_rls_published_narratives_pin_search_path.sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.published_narratives DISABLE ROW LEVEL SECURITY;

ALTER FUNCTION public.exec_sql(text) RESET search_path;
ALTER FUNCTION public.touch_ai_explanations_updated_at() RESET search_path;
ALTER FUNCTION public.token_source_rank(text) RESET search_path;

COMMIT;
