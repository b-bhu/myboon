-- Read-only post-apply checks for 20261019231000_merge_entities_v1_counts.sql
-- (#342 PR-4). Every structural property of the PR-3 function must survive the
-- two CTO amendments; counts of prosrc markers pin exactly which edits landed.
WITH f AS (SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('managed_knowledge_private.merge_entities_v1(uuid, uuid, boolean)'))
SELECT check_name, pass FROM (VALUES
  ('01 still VOLATILE SECURITY DEFINER owned by myboon_knowledge_owner with the pinned search_path', 1, EXISTS (
     SELECT 1 FROM f WHERE prosecdef AND provolatile = 'v'
       AND pg_get_userbyid(proowner) = 'myboon_knowledge_owner'
       AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])),
  ('02 p_dry_run defaults to true', 2, EXISTS (SELECT 1 FROM f WHERE pg_get_function_arguments(oid) LIKE '%p_dry_run boolean DEFAULT true%')),
  ('03 EXECUTE only for the executor role (context_executor/anon/authenticated/service_role/PUBLIC all rejected)', 3, EXISTS (
     SELECT 1 FROM f WHERE
       has_function_privilege('myboon_knowledge_executor', oid, 'EXECUTE')
       AND NOT has_function_privilege('myboon_knowledge_context_executor', oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
       AND NOT has_function_privilege('service_role', oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl, acldefault('f', proowner))) a WHERE a.grantee = 0))),
  ('04 three GET DIAGNOSTICS guards: memberships move + narratives + history', 4, EXISTS (
     SELECT 1 FROM f WHERE regexp_count(prosrc, 'GET DIAGNOSTICS') = 3)),
  ('05 four 40001 ERRCODEs: PR-3 recheck plus the three new count guards', 5, EXISTS (
     SELECT 1 FROM f WHERE regexp_count(prosrc, '40001') = 4
       AND prosrc LIKE '%merged entity memberships changed while waiting; retry%')),
  ('06 the count-guard messages name the repointed tables and both counts', 6, EXISTS (
     SELECT 1 FROM f WHERE
       prosrc LIKE '%membership move on managed_knowledge_private.memberships updated % of % expected rows%'
       AND prosrc LIKE '%re-point of public.published_narratives updated % of % expected rows%'
       AND prosrc LIKE '%re-point of public.entity_published_history updated % of % expected rows%')),
  ('07 the certain-row preference updates the survivor row before the tombstone', 7, EXISTS (
     SELECT 1 FROM f WHERE
       prosrc LIKE '%uncertain = false, placement_confidence = collision.merged_confidence%'
       AND position('placement_confidence = collision.merged_confidence' in prosrc)
         < position('SET removed_operation = merge_operation' in prosrc))),
  ('08 dry-run counts gained collisionsResolvedToCertain next to the collision count', 8, EXISTS (
     SELECT 1 FROM f WHERE
       regexp_count(prosrc, 'collisionsResolvedToCertain') = 1
       AND position('membershipsCollidingWithSurvivor' in prosrc) < position('collisionsResolvedToCertain' in prosrc))),
  ('09 the pre-counts are taken in the locked split state next to the PR-3 counts', 9, EXISTS (
     SELECT 1 FROM f WHERE
       prosrc LIKE '%SELECT count(*) INTO memberships_to_move%'
       AND prosrc LIKE '%SELECT count(*) INTO certainty_resolutions%'
       AND position('SELECT count(*) INTO memberships_to_move' in prosrc) < position('GET DIAGNOSTICS' in prosrc))),
  ('10 the owner may execute the PR-4 certainty copy (table-level UPDATE on memberships)', 10,
     has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.memberships'::regclass,'uncertain','UPDATE')
     AND has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.memberships'::regclass,'placement_confidence','UPDATE')
     AND has_column_privilege('myboon_knowledge_owner','public.published_narratives'::regclass,'entity_id','UPDATE')
     AND has_column_privilege('myboon_knowledge_owner','public.entity_published_history'::regclass,'entity_id','UPDATE')),
  ('11 the PR-3 dry-run report shape is untouched', 11, EXISTS (
     SELECT 1 FROM f WHERE
       prosrc LIKE '%membershipsToMove%' AND prosrc LIKE '%membershipsCollidingWithSurvivor%'
       AND prosrc LIKE '%aliasesMoved%' AND prosrc LIKE '%publicationsToRepoint%'
       AND prosrc LIKE '%canApply%' AND prosrc LIKE '%typeMismatch%')),
  ('12 the comment documents the PR-4 amendments', 12, EXISTS (
     SELECT 1 FROM pg_catalog.pg_description d
     JOIN pg_catalog.pg_proc p ON p.oid = d.objoid
     WHERE p.oid = to_regprocedure('managed_knowledge_private.merge_entities_v1(uuid, uuid, boolean)')
       AND d.description LIKE '%collisionsResolvedToCertain%'
       AND d.description LIKE '%40001%'))
) AS checks(check_name, ord, pass) ORDER BY ord;