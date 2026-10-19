-- Read-only post-apply check for 20261019210000_managed_entity_fuzzy_candidates.sql (#342 PR-2).
WITH f AS (SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('managed_knowledge_private.fuzzy_entity_candidates_v1(jsonb)'))
SELECT check_name, pass FROM (VALUES
  ('01 pg_trgm installed in schema extensions', 1, EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm' AND n.nspname='extensions')),
  ('02 trigram GIN index on entities(name_key)', 2, EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='managed_knowledge_private' AND indexname='managed_entities_name_key_trgm' AND indexdef LIKE '%gin%name_key%gin_trgm_ops%')),
  ('03 function is STABLE SECURITY DEFINER owned by myboon_knowledge_owner', 3, EXISTS (SELECT 1 FROM f WHERE prosecdef AND provolatile='s' AND pg_get_userbyid(proowner)='myboon_knowledge_owner')),
  ('04 search_path pinned', 4, EXISTS (SELECT 1 FROM f WHERE proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])),
  ('05 EXECUTE for both executor roles', 5, EXISTS (SELECT 1 FROM f WHERE has_function_privilege('myboon_knowledge_executor',oid,'EXECUTE') AND has_function_privilege('myboon_knowledge_context_executor',oid,'EXECUTE'))),
  ('06 no EXECUTE for PUBLIC/anon/authenticated', 6, EXISTS (SELECT 1 FROM f WHERE NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee=0))),
  ('07 owner has USAGE on schema extensions', 7, has_schema_privilege('myboon_knowledge_owner','extensions','USAGE'))
) AS checks(check_name, ord, pass) ORDER BY ord;
