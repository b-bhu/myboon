-- Read-only post-migration check for 20261019200000_article_writer_collision_detail.sql (#378).
-- Only SELECTs on pg_catalog. Every row should be pass = true.
WITH w AS (SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('managed_knowledge_private.article_writer_v1(text,jsonb)'))
SELECT check_name, pass FROM (VALUES
  ('01 article_writer_v1 names the colliding entity in DETAIL', 1, EXISTS (SELECT 1 FROM w WHERE prosrc LIKE '%DETAIL=''entity_resolution:'' || colliding_entity::text%')),
  ('02 no bare entity_resolution DETAIL left on the duplicate raise', 2, EXISTS (SELECT 1 FROM w
     WHERE prosrc NOT LIKE '%equivalent to an existing identity'' USING ERRCODE=''MK003'',DETAIL=''entity_resolution'';%')),
  ('03 #341 Part B summary hooks kept', 3, EXISTS (SELECT 1 FROM w WHERE prosrc LIKE '%summaryUpdates%' AND prosrc LIKE '%entity_summary_refresh_v1%')),
  ('04 #343 uncertain-membership handling kept', 4, EXISTS (SELECT 1 FROM w WHERE prosrc LIKE '%placementUncertain%' AND prosrc LIKE '%NOT m.uncertain%')),
  ('05 SECURITY DEFINER owned by myboon_knowledge_owner, search_path pg_catalog', 5, EXISTS (SELECT 1 FROM w
     WHERE prosecdef AND pg_get_userbyid(proowner) = 'myboon_knowledge_owner' AND proconfig @> ARRAY['search_path=pg_catalog'])),
  ('06 EXECUTE: executor yes; PUBLIC/anon/authenticated/service_role no', 6, EXISTS (SELECT 1 FROM w
     WHERE has_function_privilege('myboon_knowledge_executor', oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
       AND NOT has_function_privilege('service_role', oid, 'EXECUTE'))
     AND NOT EXISTS (SELECT 1 FROM w, aclexplode(w.proacl) a WHERE a.grantee = 0))
) AS checks(check_name, ord, pass) ORDER BY ord;
