-- Read-only post-rollback check for 20261019200000_article_writer_collision_detail.down.sql (#378).
WITH w AS (SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('managed_knowledge_private.article_writer_v1(text,jsonb)'))
SELECT check_name, pass FROM (VALUES
  ('01 duplicate raise back to the bare entity_resolution DETAIL', 1, EXISTS (SELECT 1 FROM w
     WHERE prosrc LIKE '%equivalent to an existing identity'' USING ERRCODE=''MK003'',DETAIL=''entity_resolution'';%' AND prosrc NOT LIKE '%colliding_entity%')),
  ('02 #341 Part B summary hooks still present', 2, EXISTS (SELECT 1 FROM w WHERE prosrc LIKE '%summaryUpdates%')),
  ('03 still SECURITY DEFINER owned by myboon_knowledge_owner; executor keeps EXECUTE', 3, EXISTS (SELECT 1 FROM w
     WHERE prosecdef AND pg_get_userbyid(proowner) = 'myboon_knowledge_owner' AND has_function_privilege('myboon_knowledge_executor', oid, 'EXECUTE')))
) AS checks(check_name, ord, pass) ORDER BY ord;
