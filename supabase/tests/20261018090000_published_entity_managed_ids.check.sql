-- Read-only post-migration check for 20261018090000_published_entity_managed_ids.sql (#337 PR-D).
-- Only SELECTs on pg_catalog / information_schema. Every row should be pass = true.
WITH fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proconfig, p.prorettype, p.proowner
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.oid IN (
      to_regprocedure('public.read_managed_entities_v1(uuid[])'),
      to_regprocedure('public.published_entity_reference_requires_active_v1()'),
      to_regprocedure('public.managed_active_memory_ids_v1(uuid[])'),
      to_regprocedure('public.managed_entity_lock_status_v1(uuid)'))
)
SELECT check_name, pass FROM (VALUES
  ('01 the four #337 PR-D public functions exist exactly once', 1, (SELECT count(*) = 4 AND count(DISTINCT proname) = 4 FROM fn)),
  ('02 read_managed_entities_v1(uuid[]) returns jsonb and is STABLE', 2, EXISTS (SELECT 1 FROM fn
     WHERE fn.proname = 'read_managed_entities_v1' AND fn.prorettype = 'jsonb'::regtype AND fn.provolatile = 's')),
  ('03 published_entity_reference_requires_active_v1() returns trigger', 3, EXISTS (SELECT 1 FROM fn
     WHERE fn.proname = 'published_entity_reference_requires_active_v1' AND fn.prorettype = 'trigger'::regtype)),
  ('04 managed helpers return uuid[] and text', 4, EXISTS (SELECT 1 FROM fn
     WHERE fn.proname = 'managed_active_memory_ids_v1' AND fn.prorettype = 'uuid[]'::regtype)
     AND EXISTS (SELECT 1 FROM fn
       WHERE fn.proname = 'managed_entity_lock_status_v1' AND fn.prorettype = 'text'::regtype)),
  ('05 all four SECURITY DEFINER', 5, (SELECT count(*) = 4 FROM fn WHERE fn.prosecdef)),
  ('06 all four pin search_path to pg_catalog, pg_temp', 6, (SELECT count(*) = 4 FROM fn
     WHERE fn.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])),
  ('07 all four owned by myboon_knowledge_owner', 7, (SELECT count(*) = 4 FROM fn
     WHERE pg_get_userbyid(fn.proowner) = 'myboon_knowledge_owner')),
  ('08 reader: service_role EXECUTE, anon/authenticated none', 8, EXISTS (SELECT 1 FROM fn
     WHERE fn.proname = 'read_managed_entities_v1' AND has_function_privilege('service_role', fn.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', fn.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', fn.oid, 'EXECUTE'))),
  ('09 reader ACL: only owner and service_role, no PUBLIC', 9, NOT EXISTS (SELECT 1 FROM fn, aclexplode(
       coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid = fn.oid), acldefault('f', fn.proowner))) a
     WHERE fn.proname = 'read_managed_entities_v1' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM fn, aclexplode((SELECT proacl FROM pg_catalog.pg_proc WHERE oid = fn.oid)) a
       WHERE fn.proname = 'read_managed_entities_v1' AND a.privilege_type = 'EXECUTE'
       AND pg_get_userbyid(a.grantee) NOT IN ('myboon_knowledge_owner','service_role'))),
  ('10 helpers: service_role holds EXECUTE on both', 10, EXISTS (SELECT 1 FROM fn
     WHERE fn.proname = 'managed_active_memory_ids_v1' AND has_function_privilege('service_role', fn.oid, 'EXECUTE'))
     AND EXISTS (SELECT 1 FROM fn
       WHERE fn.proname = 'managed_entity_lock_status_v1' AND has_function_privilege('service_role', fn.oid, 'EXECUTE'))),
  ('11 helper ACLs: only owner and service_role, no PUBLIC', 11, NOT EXISTS (SELECT 1 FROM fn, aclexplode(
       coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid = fn.oid), acldefault('f', fn.proowner))) a
     WHERE fn.proname IN ('managed_active_memory_ids_v1','managed_entity_lock_status_v1')
       AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM fn, aclexplode((SELECT proacl FROM pg_catalog.pg_proc WHERE oid = fn.oid)) a
       WHERE fn.proname IN ('managed_active_memory_ids_v1','managed_entity_lock_status_v1')
       AND a.privilege_type = 'EXECUTE'
       AND pg_get_userbyid(a.grantee) NOT IN ('myboon_knowledge_owner','service_role'))),
  ('12 PR-D trigger function: no EXECUTE for PUBLIC/anon/authenticated', 12, NOT EXISTS (SELECT 1 FROM fn, aclexplode(
       coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid = fn.oid), acldefault('f', fn.proowner))) a
     WHERE fn.proname = 'published_entity_reference_requires_active_v1' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
     AND EXISTS (SELECT 1 FROM fn WHERE fn.proname = 'published_entity_reference_requires_active_v1'
       AND NOT has_function_privilege('anon', fn.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', fn.oid, 'EXECUTE'))),
  ('13 both published *_active_entity_guard triggers fire the PR-D function', 13, (SELECT count(*) = 2
     FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
     WHERE ((t.tgrelid = 'public.published_narratives'::regclass AND t.tgname = 'published_narratives_active_entity_guard')
        OR (t.tgrelid = 'public.entity_published_history'::regclass AND t.tgname = 'entity_published_history_active_entity_guard'))
       AND p.proname = 'published_entity_reference_requires_active_v1')),
  ('14 entity_memories_active_entity_guard still fires the shared function', 14, EXISTS (SELECT 1
     FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.entity_memories'::regclass AND t.tgname = 'entity_memories_active_entity_guard'
       AND p.proname = 'entity_reference_requires_active_v1')),
  ('15 no FK from either entity_id column to public.entities', 15, NOT EXISTS (SELECT 1
     FROM pg_catalog.pg_constraint c
     WHERE c.contype = 'f' AND c.confrelid = 'public.entities'::regclass
       AND c.conrelid IN ('public.published_narratives'::regclass, 'public.entity_published_history'::regclass)
       AND c.conkey = ARRAY[(SELECT a.attnum::smallint FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = c.conrelid AND a.attname = 'entity_id')]::smallint[])),
  ('16 relationship guard body calls both managed helpers', 16, EXISTS (SELECT 1
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = 'entity_publication_relationship_guard_v1'
       AND p.prosrc LIKE '%managed_active_memory_ids_v1%' AND p.prosrc LIKE '%managed_entity_lock_status_v1%')),
  ('17 owner holds UPDATE(updated_at) on managed entities for row locks', 17, has_column_privilege(
     'myboon_knowledge_owner','managed_knowledge_private.entities','updated_at','UPDATE')),
  ('18 owner holds no CREATE on public after migration', 18, NOT has_schema_privilege('myboon_knowledge_owner','public','CREATE'))
) AS c(check_name, ord, pass)
ORDER BY ord;