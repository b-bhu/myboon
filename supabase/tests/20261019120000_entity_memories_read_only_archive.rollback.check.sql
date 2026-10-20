-- Read-only post-rollback check for supabase/rollbacks/20261019120000_entity_memories_read_only_archive.down.sql (#337 final step).
-- Only SELECTs on pg_catalog. Every row should be pass = true. Seeding lives in the pg-test fixture.
SELECT check_name, pass FROM (VALUES
  ('01 both archive triggers dropped', 1, NOT EXISTS (SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.entity_memories'::regclass AND NOT t.tgisinternal
       AND t.tgname IN ('entity_memories_archive_read_only','entity_memories_archive_no_truncate'))),
  ('02 archive function dropped', 2, to_regprocedure('public.entity_memories_archive_read_only_v1()') IS NULL),
  ('03 service_role holds INSERT, UPDATE, DELETE, TRUNCATE, SELECT again', 3,
     has_table_privilege('service_role','public.entity_memories','INSERT')
     AND has_table_privilege('service_role','public.entity_memories','UPDATE')
     AND has_table_privilege('service_role','public.entity_memories','DELETE')
     AND has_table_privilege('service_role','public.entity_memories','TRUNCATE')
     AND has_table_privilege('service_role','public.entity_memories','SELECT')),
  ('04 anon holds INSERT, UPDATE, DELETE, TRUNCATE, SELECT again', 4,
     has_table_privilege('anon','public.entity_memories','INSERT')
     AND has_table_privilege('anon','public.entity_memories','UPDATE')
     AND has_table_privilege('anon','public.entity_memories','DELETE')
     AND has_table_privilege('anon','public.entity_memories','TRUNCATE')
     AND has_table_privilege('anon','public.entity_memories','SELECT')),
  ('05 authenticated holds INSERT, UPDATE, DELETE, TRUNCATE, SELECT again', 5,
     has_table_privilege('authenticated','public.entity_memories','INSERT')
     AND has_table_privilege('authenticated','public.entity_memories','UPDATE')
     AND has_table_privilege('authenticated','public.entity_memories','DELETE')
     AND has_table_privilege('authenticated','public.entity_memories','TRUNCATE')
     AND has_table_privilege('authenticated','public.entity_memories','SELECT')),
  ('06 the three pre-existing entity_memories triggers still fire', 6, (SELECT count(*) = 3
     FROM pg_trigger t
     WHERE t.tgrelid = 'public.entity_memories'::regclass AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
       AND t.tgname IN ('entity_memories_compat_identity_v1','entity_memories_active_entity_guard',
                        'entity_memories_canonical_scope_guard')))
) AS checks(check_name, ord, pass) ORDER BY ord;