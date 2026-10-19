-- Read-only post-apply check for 20261019220000_merge_entities_v1.sql (#342 PR-3).
WITH f AS (SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('managed_knowledge_private.merge_entities_v1(uuid, uuid, boolean)'))
SELECT check_name, pass FROM (VALUES
  ('01 function is VOLATILE SECURITY DEFINER owned by myboon_knowledge_owner', 1, EXISTS (SELECT 1 FROM f WHERE prosecdef AND provolatile='v' AND pg_get_userbyid(proowner)='myboon_knowledge_owner')),
  ('02 search_path pinned', 2, EXISTS (SELECT 1 FROM f WHERE proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])),
  ('03 p_dry_run defaults to true', 3, EXISTS (SELECT 1 FROM f WHERE pg_get_function_arguments(oid) LIKE '%p_dry_run boolean DEFAULT true%')),
  ('04 EXECUTE for the executor role', 4, EXISTS (SELECT 1 FROM f WHERE has_function_privilege('myboon_knowledge_executor',oid,'EXECUTE'))),
  ('05 no EXECUTE for context_executor/anon/authenticated/service_role', 5, EXISTS (SELECT 1 FROM f WHERE
     NOT has_function_privilege('myboon_knowledge_context_executor',oid,'EXECUTE')
     AND NOT has_function_privilege('anon',oid,'EXECUTE')
     AND NOT has_function_privilege('authenticated',oid,'EXECUTE')
     AND NOT has_function_privilege('service_role',oid,'EXECUTE'))),
  ('06 no EXECUTE for PUBLIC', 6, EXISTS (SELECT 1 FROM f WHERE NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee=0))),
  ('07 owner may update the merged/survivor entity columns', 7,
     has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities'::regclass,'aliases','UPDATE')
     AND has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities'::regclass,'status','UPDATE')
     AND has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities'::regclass,'metadata','UPDATE')
     AND has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities'::regclass,'revision','UPDATE')
     AND has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities'::regclass,'updated_at','UPDATE')),
  ('08 owner reads the published rows it counts and repoints', 8,
     has_column_privilege('myboon_knowledge_owner','public.published_narratives'::regclass,'id','SELECT')
     AND has_column_privilege('myboon_knowledge_owner','public.published_narratives'::regclass,'entity_id','SELECT')
     AND has_column_privilege('myboon_knowledge_owner','public.published_narratives'::regclass,'source_memory_ids','SELECT')
     AND has_column_privilege('myboon_knowledge_owner','public.published_narratives'::regclass,'entity_id','UPDATE')
     AND has_column_privilege('myboon_knowledge_owner','public.published_narratives'::regclass,'entity_slug','UPDATE')
     AND has_column_privilege('myboon_knowledge_owner','public.published_narratives'::regclass,'entity_name','UPDATE')),
  ('09 owner reads and repoints entity_published_history', 9,
     has_column_privilege('myboon_knowledge_owner','public.entity_published_history'::regclass,'id','SELECT')
     AND has_column_privilege('myboon_knowledge_owner','public.entity_published_history'::regclass,'entity_id','SELECT')
     AND has_column_privilege('myboon_knowledge_owner','public.entity_published_history'::regclass,'published_narrative_id','SELECT')
     AND has_column_privilege('myboon_knowledge_owner','public.entity_published_history'::regclass,'entity_id','UPDATE')
     AND has_column_privilege('myboon_knowledge_owner','public.entity_published_history'::regclass,'entity_slug','UPDATE')),
  ('10 owner RLS policies exist where RLS is enabled', 10, (
     SELECT coalesce(bool_and(pass), true) FROM (
       SELECT CASE WHEN c.relrowsecurity
         THEN EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=t.tab AND p.policyname='merge_entities_owner_read')
              AND EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=t.tab AND p.policyname='merge_entities_owner_repoint')
         ELSE true END AS pass
       FROM (VALUES ('published_narratives'), ('entity_published_history')) AS t(tab)
       JOIN pg_class c ON c.oid = ('public.' || t.tab)::regclass) guarded)),
  ('11 owner may row-lock through the guard: helper EXECUTE + entity_memories lock aid', 11, (
     (SELECT coalesce(bool_and(
        has_function_privilege('myboon_knowledge_owner', to_regprocedure(sig), 'EXECUTE')
        AND to_regprocedure(sig) IS NOT NULL), true)
     FROM (VALUES
       ('public.managed_active_memory_ids_v1(uuid[],boolean)'),
       ('public.managed_entity_lock_status_v1(uuid)'),
       ('public.managed_owned_memory_ids_v1(uuid[],uuid,boolean)'),
       ('public.entity_publication_relationship_guard_v1()')
     ) AS t(sig))
     -- vacuously true when an optional helper of this chain is absent;
     -- entity_memories: the guard's FOR SHARE needs the inert column grant and,
     -- under RLS, an UPDATE policy whose USING passes (merge_entities_owner_memory_lock).
     AND has_column_privilege('myboon_knowledge_owner','public.entity_memories'::regclass,'updated_at','UPDATE')
     AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='entity_memories' AND policyname='merge_entities_owner_memory_lock')))
) AS checks(check_name, ord, pass) ORDER BY ord;