-- Read-only post-rollback check for 20261019190000_published_managed_memory_ownership.down.sql (#390).
SELECT check_name, pass FROM (VALUES
  ('01 ownership helper dropped', 1, to_regprocedure('public.managed_owned_memory_ids_v1(uuid[], uuid, boolean)') IS NULL),
  ('02 guard back to the #389 body (no ownership helper, #389 helpers kept)', 2, EXISTS (SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.entity_publication_relationship_guard_v1()')
       AND prosrc !~ 'managed_owned_memory_ids_v1' AND prosrc ~ 'managed_active_memory_ids_v1' AND prosrc ~ 'managed_entity_lock_status_v1')),
  ('03 #389 helpers still present', 3, to_regprocedure('public.managed_active_memory_ids_v1(uuid[], boolean)') IS NOT NULL
     AND to_regprocedure('public.managed_entity_lock_status_v1(uuid)') IS NOT NULL),
  ('04 guard triggers still fire the guard', 4, (SELECT count(*) = 2 FROM pg_trigger t
     WHERE NOT t.tgisinternal AND t.tgname IN ('published_narratives_relationship_guard','entity_published_history_relationship_guard')
       AND t.tgfoid = to_regprocedure('public.entity_publication_relationship_guard_v1()')))
) AS checks(check_name, ord, pass) ORDER BY ord;
