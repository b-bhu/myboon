-- Read-only check for 20261020170000_managed_event_at_reported.sql (#388, option A).
-- Only SELECTs on pg_catalog. Every row must be pass = true.
WITH fn AS (
  SELECT p.oid, p.proname, ns.nspname AS schema, p.prosecdef, p.provolatile, p.proconfig, p.prorettype,
    pg_get_userbyid(p.proowner) AS owner, p.prosrc, pg_catalog.obj_description(p.oid) AS comment
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE p.proname = 'read_managed_entity_knowledge_v1' AND ns.nspname = 'public'
)
SELECT check_name, pass FROM (VALUES
  ('01 reader exists exactly once', 1, (SELECT count(*) = 1 FROM fn)),
  ('02 reader signature unchanged', 2, (SELECT count(*) = 1 FROM fn
     WHERE oid = to_regprocedure('public.read_managed_entity_knowledge_v1(text,uuid,uuid[],timestamptz,text[],text[],timestamptz,uuid,integer)') AND prorettype = 'jsonb'::regtype)),
  ('03 event_at projected from the reported time', 3, (SELECT position($p$coalesce(article.published_at, item.observed_at) AS event_at$p$ in prosrc) > 0 FROM fn)),
  ('04 event_at no longer prefers article.event_at', 4, (SELECT position($p$coalesce(article.event_at, article.published_at$p$ in prosrc) = 0 FROM fn)),
  ('05 context.scheduled_at added', 5, (SELECT position($p$'scheduled_at',CASE WHEN article.event_at > coalesce(article.published_at, item.observed_at) THEN article.event_at END$p$ in prosrc) > 0 FROM fn)),
  ('06 context still carries the article event_at', 6, (SELECT position($p$'event_at',article.event_at,$p$ in prosrc) > 0 FROM fn)),
  ('07 reader still STABLE with empty search_path', 7, (SELECT provolatile = 's' AND proconfig @> ARRAY['search_path=""'] FROM fn)),
  ('08 reader still SECURITY DEFINER owned by myboon_knowledge_owner', 8, (SELECT prosecdef AND owner = 'myboon_knowledge_owner' FROM fn)),
  ('09 reader executes for service_role', 9, (SELECT has_function_privilege('service_role', oid, 'EXECUTE') FROM fn)),
  ('10 reader denied to anon/authenticated', 10, (SELECT NOT has_function_privilege('anon', oid, 'EXECUTE')
     AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM fn)),
  ('11 reader has no PUBLIC EXECUTE grant', 11, NOT EXISTS (SELECT 1 FROM fn, aclexplode((SELECT proacl FROM pg_proc WHERE oid = fn.oid)) a
     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')),
  ('12 COMMENT still anchors the reader to EntityKnowledgeReader', 12, (SELECT comment LIKE '%read-only V4 managed knowledge rows in the entity_memories shape for EntityKnowledgeReader%' FROM fn)),
  ('13 owner is NOLOGIN, not superuser, no BYPASSRLS', 13, EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'myboon_knowledge_owner'
     AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls)),
  ('14 private schema still closed to service_role/anon/authenticated', 14, NOT has_schema_privilege('service_role','managed_knowledge_private','USAGE')
     AND NOT has_schema_privilege('anon','managed_knowledge_private','USAGE') AND NOT has_schema_privilege('authenticated','managed_knowledge_private','USAGE'))
) AS c(check_name, ord, pass)
ORDER BY ord;