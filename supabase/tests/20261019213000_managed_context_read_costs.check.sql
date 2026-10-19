-- Read-only check for 20261019213000_managed_context_read_costs.sql (#336 item 1, PR A).
-- pg_catalog / information_schema SELECTs only. Every row must be pass = true.
WITH fn AS (
  SELECT p.oid, p.proname, ns.nspname AS schema, p.prosecdef, p.provolatile, p.proconfig, p.prorettype,
    pg_get_userbyid(p.proowner) AS owner, p.prosrc
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE p.proname IN ('read_managed_entity_knowledge_v1','context_v1','article_context_v1')
    AND ns.nspname IN ('public','managed_knowledge_private')
)
SELECT check_name, pass FROM (VALUES
  ('01 three functions exist exactly once each', 1, (SELECT count(*) = 3 FROM fn)),
  ('02 reader signature unchanged', 2, (SELECT count(*) = 1 FROM fn WHERE schema = 'public' AND proname = 'read_managed_entity_knowledge_v1'
     AND oid = to_regprocedure('public.read_managed_entity_knowledge_v1(text,uuid,uuid[],timestamptz,text[],text[],timestamptz,uuid,integer)') AND prorettype = 'jsonb'::regtype)),
  ('03 context_v1 signature unchanged', 3, (SELECT count(*) = 1 FROM fn WHERE schema = 'managed_knowledge_private' AND proname = 'context_v1'
     AND oid = to_regprocedure('managed_knowledge_private.context_v1(jsonb)') AND prorettype = 'jsonb'::regtype)),
  ('04 article_context_v1 signature unchanged', 4, (SELECT count(*) = 1 FROM fn WHERE schema = 'managed_knowledge_private' AND proname = 'article_context_v1'
     AND oid = to_regprocedure('managed_knowledge_private.article_context_v1(jsonb)') AND prorettype = 'jsonb'::regtype)),
  ('05 all owned by myboon_knowledge_owner', 5, (SELECT count(*) = 3 FROM fn WHERE owner = 'myboon_knowledge_owner')),
  ('06 all SECURITY DEFINER', 6, (SELECT count(*) = 3 FROM fn WHERE prosecdef)),
  ('07 reader still STABLE with empty search_path', 7, (SELECT count(*) = 1 FROM fn
     WHERE schema = 'public' AND proname = 'read_managed_entity_knowledge_v1' AND provolatile = 's' AND proconfig @> ARRAY['search_path=""'])),
  ('08 reader executes for service_role', 8, (SELECT has_function_privilege('service_role', oid, 'EXECUTE') FROM fn WHERE schema = 'public')),
  ('09 reader denied to anon/authenticated', 9, (SELECT NOT has_function_privilege('anon', oid, 'EXECUTE')
     AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM fn WHERE schema = 'public')),
  ('10 reader has no PUBLIC EXECUTE grant', 10, NOT EXISTS (SELECT 1 FROM fn, aclexplode((SELECT proacl FROM pg_proc WHERE oid = fn.oid)) a
     WHERE schema = 'public' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')),
  ('11 context_v1 no longer digests revisions for the candidates filter', 11, (SELECT position($p$entity_revision_v1(entity.id) <> 'unavailable'$p$ in prosrc) = 0
     FROM fn WHERE schema = 'managed_knowledge_private' AND proname = 'context_v1')),
  ('12 article_context_v1 no longer digests revisions for its candidate filters', 12, (SELECT position($p$entity_revision_v1(p.id) <> 'unavailable'$p$ in prosrc) = 0
     FROM fn WHERE schema = 'managed_knowledge_private' AND proname = 'article_context_v1')),
  ('13 article_context_v1 reads the perEntityLimit input', 13, (SELECT position($p$perEntityLimit$p$ in prosrc) > 0
     FROM fn WHERE schema = 'managed_knowledge_private' AND proname = 'article_context_v1')),
  ('14 context_v1 still projects entity_revision_v1', 14, (SELECT position($p$entity_revision_v1(entity.id)$p$ in prosrc) > 0
     FROM fn WHERE schema = 'managed_knowledge_private' AND proname = 'context_v1')),
  ('15 article_context_v1 still projects entity_revision_v1', 15, (SELECT position($p$entity_revision_v1(p.id)$p$ in prosrc) > 0
     FROM fn WHERE schema = 'managed_knowledge_private' AND proname = 'article_context_v1')),
  ('16 owner is NOLOGIN, not superuser, no BYPASSRLS', 16, EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'myboon_knowledge_owner'
     AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls)),
  ('17 private schema still closed to service_role/anon/authenticated', 17, NOT has_schema_privilege('service_role','managed_knowledge_private','USAGE')
     AND NOT has_schema_privilege('anon','managed_knowledge_private','USAGE') AND NOT has_schema_privilege('authenticated','managed_knowledge_private','USAGE'))
) AS c(check_name, ord, pass)
ORDER BY ord;