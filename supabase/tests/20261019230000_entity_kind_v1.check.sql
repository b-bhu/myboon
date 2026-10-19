-- Read-only post-apply checks for 20261019230000_entity_kind_v1.sql (#342 PR-4 A).
-- Checks 07/08 need the pg-test preseed (legacy rows committed before the
-- migration applied); the structural checks 01-06, 09 hold on any database
-- that has applied the migration, so the re-apply step can re-run this file.
WITH f AS (SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('managed_knowledge_private.entity_kind_v1(text)')),
fill AS (SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('managed_knowledge_private.entity_fill_columns_v1()')),
con AS (SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_catalog.pg_constraint
        WHERE conname = 'managed_entities_type_kind_v1'
          AND conrelid = 'managed_knowledge_private.entities'::regclass),
kinds AS (SELECT unnest(ARRAY['person','organization','network','protocol','product','asset','place','event','topic','regulation','unclassified']) AS kind)
SELECT check_name, pass FROM (VALUES
  ('01 kind function is IMMUTABLE SQL with a pinned search_path', 1, EXISTS (
     SELECT 1 FROM f WHERE provolatile = 'i'
       AND prolang = (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'sql')
       AND proconfig = ARRAY['search_path=pg_catalog'] AND NOT prosecdef)),
  ('02 grants mirror entity_name_key_v1: owner/v4 roles (when present) may execute, PUBLIC may not', 2, EXISTS (
     SELECT 1 FROM f WHERE
       (SELECT coalesce(bool_and(has_function_privilege(r, to_regprocedure('managed_knowledge_private.entity_kind_v1(text)'), 'EXECUTE')), true)
          FROM unnest(ARRAY['myboon_knowledge_owner','myboon_v4_worker','myboon_v4_research']) r
          WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r))
       AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a WHERE a.grantee = 0))),
  ('03 kind CHECK exists on managed entities, fully validated, all eleven values present, not NOT VALID', 3, EXISTS (
     SELECT 1 FROM con WHERE con.convalidated
       AND (SELECT bool_and(position('''' || kind || '''' in con.def) > 0) FROM kinds))),
  ('04 fill trigger function routes ONLY the type assignment through entity_kind_v1', 4, EXISTS (
     SELECT 1 FROM fill
     WHERE position('entity_kind_v1(coalesce(catalog.type,NEW.binding->>''type'',''unclassified''))' in prosrc) > 0
       AND regexp_count(prosrc, 'entity_kind_v1\(') = 1)),
  ('05 exactly one non-internal trigger remains on managed entities (BEFORE INSERT fill, no new trigger)', 5, (
     SELECT count(*) = 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = 'managed_knowledge_private.entities'::regclass AND NOT tgisinternal)),
  ('06 every stored managed type is one of the eleven kinds', 6, (
     SELECT count(*) FILTER (WHERE type NOT IN ('person','organization','network','protocol','product','asset','place','event','topic','regulation','unclassified')) = 0
     FROM managed_knowledge_private.entities)),
  ('07 preseeded legacy rows mapped to the kind map with the original string kept in metadata.legacyType', 7, (
     SELECT coalesce(bool_and(mapped), true) FROM (
       SELECT e.id, e.type, (e.metadata->>'legacyType') = s.legacy_value
           AND e.type = s.mapped_value AND (e.metadata ? 'legacyType') AS mapped
       FROM (VALUES
         ('00000000-0000-4000-8000-0000000001a1'::uuid,'project','protocol'),
         ('00000000-0000-4000-8000-0000000001a2'::uuid,'conflict','event'),
         ('00000000-0000-4000-8000-0000000001a3'::uuid,'company','organization'),
         ('00000000-0000-4000-8000-0000000001a4'::uuid,'ai coding tool','product'),
         ('00000000-0000-4000-8000-0000000001a5'::uuid,'exchange-traded fund','asset'),
         ('00000000-0000-4000-8000-0000000001a6'::uuid,'trader','unclassified')
       ) AS s(id, legacy_value, mapped_value)
       JOIN managed_knowledge_private.entities e ON e.id = s.id) t)),
  ('08 the unchanged preseeded row kept its type and gained NO legacyType', 8,
     (SELECT type = 'organization' AND NOT metadata ? 'legacyType'
      FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-0000000001a7'::uuid)),
  ('09 no new index on the type column', 9, NOT EXISTS (
     SELECT 1
     FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_attribute a
       ON a.attrelid = i.indrelid AND a.attname = 'type' AND a.attnum = ANY (i.indkey::smallint[])
     WHERE i.indrelid = 'managed_knowledge_private.entities'::regclass))
) AS checks(check_name, ord, pass) ORDER BY ord;