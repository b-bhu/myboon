SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.published_narratives ENABLE ROW LEVEL SECURITY;

ALTER FUNCTION public.exec_sql(text) SET search_path = pg_catalog, public;
ALTER FUNCTION public.touch_ai_explanations_updated_at() SET search_path = '';
ALTER FUNCTION public.token_source_rank(text) SET search_path = '';
