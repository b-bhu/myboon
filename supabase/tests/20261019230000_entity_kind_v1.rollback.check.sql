-- Read-only post-rollback checks for 20261019230000_entity_kind_v1.down.sql
-- (#342 PR-4 A). Checks 02/03 need the pg-test preseed rows (1a1..1a7);
-- the structural checks 01/04 hold on any rolled-back database.
SELECT check_name, pass FROM (VALUES
  ('01 kind function is gone and the constraint is gone', 1,
     to_regprocedure('managed_knowledge_private.entity_kind_v1(text)') IS NULL
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conname = 'managed_entities_type_kind_v1'
         AND conrelid = 'managed_knowledge_private.entities'::regclass)),
  ('02 preseeded legacy rows restored to their original types with the legacyType key removed', 2, (
     SELECT coalesce(bool_and(restored), true) FROM (
       SELECT e.id, e.type = s.legacy_value AND NOT e.metadata ? 'legacyType' AS restored
       FROM (VALUES
         ('00000000-0000-4000-8000-0000000001a1'::uuid,'project'),
         ('00000000-0000-4000-8000-0000000001a2'::uuid,'conflict'),
         ('00000000-0000-4000-8000-0000000001a3'::uuid,'company'),
         ('00000000-0000-4000-8000-0000000001a4'::uuid,'ai coding tool'),
         ('00000000-0000-4000-8000-0000000001a5'::uuid,'exchange-traded fund'),
         ('00000000-0000-4000-8000-0000000001a6'::uuid,'trader')
       ) AS s(id, legacy_value)
       JOIN managed_knowledge_private.entities e ON e.id = s.id) t)),
  ('03 the unchanged preseeded row still has no legacyType and its organization type', 3,
     (SELECT type = 'organization' AND NOT metadata ? 'legacyType'
      FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-0000000001a7'::uuid)),
  ('04 fill trigger function is back to the verbatim 20261017120000 body (no kind call)', 4, EXISTS (
     SELECT 1 FROM pg_catalog.pg_proc
     WHERE oid = to_regprocedure('managed_knowledge_private.entity_fill_columns_v1()')
       AND position('entity_kind_v1(' in prosrc) = 0
       AND position('coalesce(catalog.type,NEW.binding->>''type'',''unclassified'')' in prosrc) > 0))
) AS checks(check_name, ord, pass) ORDER BY ord;