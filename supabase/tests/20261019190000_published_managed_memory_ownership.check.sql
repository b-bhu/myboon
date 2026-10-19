-- Read-only post-migration check for 20261019190000_published_managed_memory_ownership.sql (#390).
-- Only SELECTs on pg_catalog. Every row should be pass = true.
WITH h AS (SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.managed_owned_memory_ids_v1(uuid[], uuid, boolean)')),
g AS (SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.entity_publication_relationship_guard_v1()'))
SELECT check_name, pass FROM (VALUES
  ('01 helper exists, returns uuid[], VOLATILE, SECURITY DEFINER', 1, EXISTS (SELECT 1 FROM h WHERE prorettype = 'uuid[]'::regtype AND provolatile = 'v' AND prosecdef)),
  ('02 helper pins search_path to pg_catalog, pg_temp', 2, EXISTS (SELECT 1 FROM h WHERE proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])),
  ('03 helper owned by myboon_knowledge_owner', 3, EXISTS (SELECT 1 FROM h WHERE pg_get_userbyid(proowner) = 'myboon_knowledge_owner')),
  ('04 helper: service_role EXECUTE; anon/authenticated none', 4, EXISTS (SELECT 1 FROM h
     WHERE has_function_privilege('service_role', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', oid, 'EXECUTE'))),
  ('05 helper ACL has no PUBLIC and only owner/service_role grantees', 5, NOT EXISTS (SELECT 1 FROM h, aclexplode(h.proacl) a
     WHERE a.privilege_type = 'EXECUTE' AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT IN ('myboon_knowledge_owner','service_role')))),
  ('06 guard calls the ownership helper', 6, EXISTS (SELECT 1 FROM g WHERE prosrc LIKE '%managed_owned_memory_ids_v1%')),
  ('07 guard keeps #389 helpers and is SECURITY INVOKER with empty search_path', 7, EXISTS (SELECT 1 FROM g
     WHERE prosrc LIKE '%managed_active_memory_ids_v1%' AND prosrc LIKE '%managed_entity_lock_status_v1%' AND NOT prosecdef AND proconfig @> ARRAY['search_path=""'])),
  ('08 guard stays service_role only', 8, EXISTS (SELECT 1 FROM g WHERE has_function_privilege('service_role', oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE'))),
  ('09 both relationship-guard triggers still fire the guard', 9, (SELECT count(*) = 2 FROM pg_trigger t
     WHERE NOT t.tgisinternal AND t.tgname IN ('published_narratives_relationship_guard','entity_published_history_relationship_guard')
       AND t.tgfoid = to_regprocedure('public.entity_publication_relationship_guard_v1()')))
) AS checks(check_name, ord, pass) ORDER BY ord;
