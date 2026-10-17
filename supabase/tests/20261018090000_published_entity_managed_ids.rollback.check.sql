-- Read-only post-rollback check for supabase/rollbacks/20261018090000_published_entity_managed_ids.down.sql (#337 PR-D).
-- Only SELECTs on pg_catalog. Every row should be pass = true. Seeding lives in the pg-test fixture.
SELECT check_name, pass FROM (VALUES
  ('01 PR-D functions and helpers dropped', 1, to_regprocedure('public.read_managed_entities_v1(uuid[])') IS NULL
     AND to_regprocedure('public.published_entity_reference_requires_active_v1()') IS NULL
     AND to_regprocedure('public.managed_active_memory_ids_v1(uuid[])') IS NULL
     AND to_regprocedure('public.managed_entity_lock_status_v1(uuid)') IS NULL),
  ('02 relationship guard restored without managed references', 2, EXISTS (SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.entity_publication_relationship_guard_v1()') AND prosrc !~ 'managed_')),
  ('03 no *_active_entity_guard on the published tables (pre-PR state)', 3, NOT EXISTS (SELECT 1 FROM pg_trigger t
     WHERE t.tgname IN ('published_narratives_active_entity_guard','entity_published_history_active_entity_guard'))),
  ('04 relationship guard triggers still fire the restored guard', 4, (SELECT count(*) = 2 FROM pg_trigger t
     WHERE NOT t.tgisinternal AND t.tgname IN ('published_narratives_relationship_guard','entity_published_history_relationship_guard')
       AND t.tgfoid = to_regprocedure('public.entity_publication_relationship_guard_v1()'))),
  ('05 entity_memories guard still on the shared function', 5, EXISTS (SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'entity_memories_active_entity_guard' AND t.tgfoid = to_regprocedure('public.entity_reference_requires_active_v1()'))),
  ('06 both entity_id FKs to public.entities restored ON DELETE SET NULL', 6, (SELECT count(*) = 2 FROM pg_constraint c
     WHERE c.contype = 'f' AND c.confrelid = 'public.entities'::regclass AND c.confdeltype = 'n'
       AND c.conname IN ('published_narratives_entity_id_fkey','entity_published_history_entity_id_fkey'))),
  ('07 owner no longer holds UPDATE(updated_at) on managed entities', 7,
     NOT has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities','updated_at','UPDATE'))
) AS checks(check_name, ord, pass) ORDER BY ord;
