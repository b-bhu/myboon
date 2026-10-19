-- Read-only post-rollback checks for 20261019231000_merge_entities_v1_counts.down.sql
-- (#342 PR-4). The down file restores the 20261019220000 (PR-3) function body
-- byte-for-byte, which the pg-test proves with an md5 comparison of prosrc
-- against the pre-PR-4 body; this file asserts the restored shape and the
-- PR-4 markers being gone.
WITH f AS (SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('managed_knowledge_private.merge_entities_v1(uuid, uuid, boolean)'))
SELECT check_name, pass FROM (VALUES
  ('01 still VOLATILE SECURITY DEFINER owned by myboon_knowledge_owner, executor keeps EXECUTE', 1, EXISTS (
     SELECT 1 FROM f WHERE prosecdef AND provolatile = 'v'
       AND pg_get_userbyid(proowner) = 'myboon_knowledge_owner'
       AND has_function_privilege('myboon_knowledge_executor', oid, 'EXECUTE')
       AND NOT has_function_privilege('myboon_knowledge_context_executor', oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', oid, 'EXECUTE')
       AND NOT has_function_privilege('service_role', oid, 'EXECUTE'))),
  ('02 the PR-4 count guards are gone', 2, EXISTS (
     SELECT 1 FROM f WHERE regexp_count(prosrc, 'GET DIAGNOSTICS') = 0
       AND regexp_count(prosrc, 'collisionsResolvedToCertain') = 0
       AND prosrc NOT LIKE '%merged_confidence%')),
  ('03 exactly one 40001 remains (the PR-3 locked-state recheck)', 3, EXISTS (
     SELECT 1 FROM f WHERE regexp_count(prosrc, '40001') = 1
       AND prosrc LIKE '%merged entity memberships changed while waiting; retry%')),
  ('04 the PR-3 behaviour markers are intact', 4, EXISTS (
     SELECT 1 FROM f WHERE
       prosrc LIKE '%removed_operation = merge_operation%'
       AND prosrc LIKE '%mergeAudit%'
       AND prosrc LIKE '%publicationsToRepoint%'
       AND prosrc LIKE '%merge requires two existing managed entities%'
       AND pg_get_function_arguments(oid) LIKE '%p_dry_run boolean DEFAULT true%'))
) AS checks(check_name, ord, pass) ORDER BY ord;