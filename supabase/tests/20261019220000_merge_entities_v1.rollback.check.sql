-- Read-only post-rollback check for 20261019220000_merge_entities_v1.down.sql (#342 PR-3).
SELECT check_name, pass FROM (VALUES
  ('01 merge function is gone', 1, to_regprocedure('managed_knowledge_private.merge_entities_v1(uuid, uuid, boolean)') IS NULL),
  ('02 owner RLS policies are gone', 2,
     NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND policyname IN ('merge_entities_owner_read','merge_entities_owner_repoint','merge_entities_owner_memory_lock'))),
  ('03 entities: aliases/status/metadata UPDATE revoked, revision/updated_at kept', 3,
     NOT has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities'::regclass,'aliases','UPDATE')
     AND NOT has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities'::regclass,'status','UPDATE')
     AND NOT has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities'::regclass,'metadata','UPDATE')
     AND has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities'::regclass,'revision','UPDATE')
     AND has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities'::regclass,'updated_at','UPDATE')),
  ('04 published_narratives columns revoked', 4,
     NOT has_column_privilege('myboon_knowledge_owner','public.published_narratives'::regclass,'entity_id','UPDATE')
     AND NOT has_column_privilege('myboon_knowledge_owner','public.published_narratives'::regclass,'entity_slug','UPDATE')
     AND NOT has_column_privilege('myboon_knowledge_owner','public.published_narratives'::regclass,'entity_name','UPDATE')
     AND NOT has_column_privilege('myboon_knowledge_owner','public.published_narratives'::regclass,'source_memory_ids','SELECT')),
  ('05 entity_published_history columns revoked', 5,
     NOT has_column_privilege('myboon_knowledge_owner','public.entity_published_history'::regclass,'entity_id','UPDATE')
     AND NOT has_column_privilege('myboon_knowledge_owner','public.entity_published_history'::regclass,'entity_slug','UPDATE')
     AND NOT has_column_privilege('myboon_knowledge_owner','public.entity_published_history'::regclass,'published_narrative_id','SELECT')),
  ('06 guard-helper EXECUTE revoked from the owner', 6, (
     SELECT coalesce(bool_and(
        CASE WHEN to_regprocedure(sig) IS NULL THEN true
             ELSE NOT has_function_privilege('myboon_knowledge_owner', to_regprocedure(sig), 'EXECUTE') END), true)
     FROM (VALUES
       ('public.managed_active_memory_ids_v1(uuid[],boolean)'),
       ('public.managed_entity_lock_status_v1(uuid)'),
       ('public.managed_owned_memory_ids_v1(uuid[],uuid,boolean)'),
       ('public.entity_publication_relationship_guard_v1()')
     ) AS t(sig))),
  ('07 service_role EXECUTE on the guard helpers is untouched', 7, (
     SELECT coalesce(bool_and(
        CASE WHEN to_regprocedure(sig) IS NULL THEN true
             ELSE has_function_privilege('service_role', to_regprocedure(sig), 'EXECUTE') END), true)
     FROM (VALUES
       ('public.managed_active_memory_ids_v1(uuid[],boolean)'),
       ('public.managed_entity_lock_status_v1(uuid)'),
       ('public.managed_owned_memory_ids_v1(uuid[],uuid,boolean)')
     ) AS t(sig))),
  ('08 owner still reads entity_memories (granted by 20261004103000, not ours); row-lock aid revoked', 8,
     has_column_privilege('myboon_knowledge_owner','public.entity_memories'::regclass,'id','SELECT')
     AND has_column_privilege('myboon_knowledge_owner','public.entity_memories'::regclass,'entity_id','SELECT')
     AND NOT has_column_privilege('myboon_knowledge_owner','public.entity_memories'::regclass,'updated_at','UPDATE'))
) AS checks(check_name, ord, pass) ORDER BY ord;