-- Read-only check after the 20261020090000_article_context_label_match rollback (#336 item 1, PR B).
-- pg_catalog SELECTs only. Every row must be pass = true; the PR B edits must be undone.
WITH fn AS (
  SELECT p.oid, p.proname, ns.nspname AS schema, p.prosecdef, p.provolatile, p.proconfig, p.prorettype,
    pg_get_userbyid(p.proowner) AS owner, p.prosrc
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE p.proname IN ('read_managed_entity_knowledge_v1','context_v1','article_context_v1')
    AND ns.nspname IN ('public','managed_knowledge_private')
), art AS (SELECT * FROM fn WHERE schema='managed_knowledge_private' AND proname='article_context_v1')
SELECT check_name, pass FROM (VALUES
  ('01 three functions exist exactly once each', 1, (SELECT count(*) = 3 FROM fn)),
  ('02 article_context_v1 signature unchanged', 2, (SELECT count(*) = 1 FROM art
     WHERE oid = to_regprocedure('managed_knowledge_private.article_context_v1(jsonb)') AND prorettype = 'jsonb'::regtype)),
  ('03 article_context_v1 SECURITY DEFINER owned by myboon_knowledge_owner with search_path=pg_catalog', 3,
     (SELECT count(*) = 1 FROM art WHERE prosecdef AND owner = 'myboon_knowledge_owner' AND proconfig @> ARRAY['search_path=pg_catalog'])),
  ('04 trigram label matching is gone', 4, (SELECT position($x$OPERATOR(extensions.%)$x$ in prosrc) = 0 FROM art)),
  ('05 the per-entity substring scans are back', 5,
     (SELECT position($x$position(l.label in lower(p.name)) > 0$x$ in prosrc) > 0
        AND position($x$position(l.label in lower(e.name)) > 0$x$ in prosrc) > 0
        AND position($x$metadata::text$x$ in prosrc) > 0 FROM art)),
  ('06 perEntityLimit still present (20261019213000 body)', 6, (SELECT position($x$perEntityLimit$x$ in prosrc) > 0 FROM art)),
  ('07 context_v1 untouched', 7, (SELECT count(*) = 1 FROM fn WHERE schema='managed_knowledge_private' AND proname='context_v1'
     AND oid = to_regprocedure('managed_knowledge_private.context_v1(jsonb)') AND prorettype = 'jsonb'::regtype)),
  ('08 trigram index left in place (only callers stopped using it)', 8, EXISTS (
     SELECT 1 FROM pg_indexes WHERE schemaname='managed_knowledge_private' AND indexname='managed_entities_name_key_trgm')),
  ('09 grants unchanged: executor roles execute, anon/authenticated do not, no PUBLIC grant', 9,
     (SELECT has_function_privilege('myboon_knowledge_executor', oid, 'EXECUTE')
        AND has_function_privilege('myboon_knowledge_context_executor', oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM art)
     AND NOT EXISTS (SELECT 1 FROM art, aclexplode((SELECT proacl FROM pg_proc WHERE oid = art.oid)) a
       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')),
  ('10 owner is NOLOGIN, not superuser, no BYPASSRLS', 10, EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'myboon_knowledge_owner'
     AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls)),
  ('11 private schema still closed to service_role/anon/authenticated', 11, NOT has_schema_privilege('service_role','managed_knowledge_private','USAGE')
     AND NOT has_schema_privilege('anon','managed_knowledge_private','USAGE') AND NOT has_schema_privilege('authenticated','managed_knowledge_private','USAGE'))
) AS c(check_name, ord, pass)
ORDER BY ord;