-- Read-only post-migration check for 20261019120000_entity_memories_read_only_archive.sql (#337 final step).
-- Only SELECTs on pg_catalog / has_table_privilege. Every row should be pass = true.
WITH trg AS (
  SELECT t.tgname, t.tgenabled, t.tgtype
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = 'public.entity_memories'::regclass AND NOT t.tgisinternal
    AND t.tgfoid = to_regprocedure('public.entity_memories_archive_read_only_v1()')
)
SELECT check_name, pass FROM (VALUES
  ('01 archive function exists and returns trigger', 1, EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.entity_memories_archive_read_only_v1()')
       AND p.prorettype = 'trigger'::regtype)),
  ('02 function pins search_path (empty)', 2, EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.entity_memories_archive_read_only_v1()')
       AND (p.proconfig @> ARRAY['search_path=""'] OR p.proconfig @> ARRAY['search_path=']))),  -- PG stores the empty value quoted
  ('03 row trigger exists, enabled, BEFORE INSERT/UPDATE/DELETE', 3, EXISTS (SELECT 1 FROM trg
     WHERE trg.tgname = 'entity_memories_archive_read_only' AND trg.tgenabled IN ('O','A')
       AND trg.tgtype = 31)),  -- 31 = ROW|BEFORE|INSERT|DELETE|UPDATE bits
  ('04 truncate trigger exists, enabled, BEFORE TRUNCATE', 4, EXISTS (SELECT 1 FROM trg
     WHERE trg.tgname = 'entity_memories_archive_no_truncate' AND trg.tgenabled IN ('O','A')
       AND trg.tgtype = 34)), -- 34 = BEFORE|TRUNCATE bits, statement-level
  ('05 exactly the two archive triggers fire the function', 5, (SELECT count(*) = 2 FROM trg)),
  ('06 service_role keeps SELECT + UPDATE (FOR SHARE needs UPDATE)', 6,
     has_table_privilege('service_role','public.entity_memories','SELECT')
     AND has_table_privilege('service_role','public.entity_memories','UPDATE')),
  ('07 service_role lost INSERT, DELETE, TRUNCATE', 7,
     NOT has_table_privilege('service_role','public.entity_memories','INSERT')
     AND NOT has_table_privilege('service_role','public.entity_memories','DELETE')
     AND NOT has_table_privilege('service_role','public.entity_memories','TRUNCATE')),
  ('08 anon lost INSERT, UPDATE, DELETE, TRUNCATE', 8,
     NOT has_table_privilege('anon','public.entity_memories','INSERT')
     AND NOT has_table_privilege('anon','public.entity_memories','UPDATE')
     AND NOT has_table_privilege('anon','public.entity_memories','DELETE')
     AND NOT has_table_privilege('anon','public.entity_memories','TRUNCATE')),
  ('09 authenticated lost INSERT, UPDATE, DELETE, TRUNCATE', 9,
     NOT has_table_privilege('authenticated','public.entity_memories','INSERT')
     AND NOT has_table_privilege('authenticated','public.entity_memories','UPDATE')
     AND NOT has_table_privilege('authenticated','public.entity_memories','DELETE')
     AND NOT has_table_privilege('authenticated','public.entity_memories','TRUNCATE')),
  ('10 the three pre-existing entity_memories triggers still fire', 10, (SELECT count(*) = 3
     FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = 'public.entity_memories'::regclass AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
       AND t.tgname IN ('entity_memories_compat_identity_v1','entity_memories_active_entity_guard',
                        'entity_memories_canonical_scope_guard')))
) AS c(check_name, ord, pass)
ORDER BY ord;