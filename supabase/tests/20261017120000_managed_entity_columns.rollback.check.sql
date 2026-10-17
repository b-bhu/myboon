-- #337 PR-A rollback check for supabase/rollbacks/20261017120000_managed_entity_columns.down.sql.
-- Run ONLY against a disposable database with every migration applied
-- (including 20261017120000), as a superuser, from the repo root:
--   psql ... -f supabase/tests/20261017120000_managed_entity_columns.rollback.check.sql
-- It runs the rollback inside one transaction, proves the columns/trigger/
-- helper functions are gone, and proves the restored readers still answer the
-- old way (binding JSON + catalogue overlay). Everything is rolled back.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE c337r(k text PRIMARY KEY, v jsonb);
GRANT ALL ON c337r TO myboon_v4_research;
INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
  VALUES('progression-v2:' || repeat('c',64),'rollback-check-337',1,clock_timestamp() + interval '1 hour');

\ir ../rollbacks/20261017120000_managed_entity_columns.down.sql

-- A legacy-shaped managed row is writable again with no fill trigger.
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
  VALUES('00000000-0000-4000-8000-00000000b337','article:topic:rollback 337',NULL,
    '{"id":"00000000-0000-4000-8000-00000000b337","name":"Rollback 337 (RB337)","slug":"rollback-337","type":"topic","aliases":["RB337"],"summary":"rollback binding"}'::jsonb,
    'progression-v2:' || repeat('c',64));

SET SESSION AUTHORIZATION myboon_v4_research;
INSERT INTO c337r VALUES
  ('post_new_row',managed_knowledge_private.context_v1('{"source":"news","labels":["Rollback 337 (RB337)"],"sourceRefs":[],"entityIds":[],"itemIds":[]}')),
  ('post_preseed_alias',managed_knowledge_private.context_v1('{"source":"news","labels":["P337"],"sourceRefs":[],"entityIds":[],"itemIds":[]}')),
  ('post_ethereum',managed_knowledge_private.context_v1('{"source":"news","labels":["Ethereum"],"sourceRefs":[],"entityIds":[],"itemIds":[]}'));
RESET SESSION AUTHORIZATION;

DO $check$
DECLARE r jsonb; entity jsonb;
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='managed_knowledge_private.entities'::regclass
    AND attnum > 0 AND NOT attisdropped
    AND attname IN ('name','name_key','slug','type','aliases','summary','status','show_in_carousel','metadata','updated_at')) THEN
    RAISE EXCEPTION 'rollback left #337 columns in place';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='managed_knowledge_private.entities'::regclass
    AND tgname='managed_entities_fill_columns' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'rollback left the fill trigger in place';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='managed_knowledge_private' AND p.proname IN ('entity_fill_columns_v1','entity_name_key_v1')) THEN
    RAISE EXCEPTION 'rollback left the #337 helper functions in place';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conname IN ('managed_entities_name_present','managed_entities_aliases_array','managed_entities_metadata_object')
    AND conrelid='managed_knowledge_private.entities'::regclass) THEN
    RAISE EXCEPTION 'rollback left the #337 constraints in place';
  END IF;

  -- Old context_v1 answers from the stored binding again.
  SELECT v INTO r FROM c337r WHERE k='post_new_row';
  SELECT value INTO entity FROM jsonb_array_elements(r->'entities') WHERE value->>'id'='00000000-0000-4000-8000-00000000b337';
  IF entity IS NULL OR entity->>'name' IS DISTINCT FROM 'Rollback 337 (RB337)' OR entity->>'summary' IS DISTINCT FROM 'rollback binding' THEN
    RAISE EXCEPTION 'restored context_v1 must answer from the stored binding: %',entity;
  END IF;
  -- Old private rows carry the empty catalogue suffix when not linked.
  IF entity->>'revision' IS DISTINCT FROM 'managed:1:' THEN
    RAISE EXCEPTION 'restored entity_revision_v1 must return the unlinked private revision: %',entity->>'revision';
  END IF;

  -- The preseeded article-only row is still matched through its binding aliases.
  SELECT v INTO r FROM c337r WHERE k='post_preseed_alias';
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'entities') x WHERE x->>'id'='00000000-0000-4000-8000-00000000a337'
    AND x->>'name'='Preseed 337 (P337)' AND x->>'summary'='binding summary') THEN
    RAISE EXCEPTION 'restored context_v1 lost the binding identity of the preseeded row: %',r->'entities';
  END IF;

  -- The linked row overlays the catalogue identity again, old revision string.
  SELECT v INTO r FROM c337r WHERE k='post_ethereum';
  SELECT value INTO entity FROM jsonb_array_elements(r->'entities') WHERE value->>'id'='00000000-0000-4000-8000-00000000e337';
  IF entity IS NULL OR entity->>'name' IS DISTINCT FROM 'Ethereum' OR entity->>'summary' IS DISTINCT FROM 'catalog summary' THEN
    RAISE EXCEPTION 'restored context_v1 must overlay the catalogue for the linked row: %',entity;
  END IF;
  IF entity->>'revision' !~ '^managed:1:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'restored entity_revision_v1 must digest the catalogue overlay: %',entity->>'revision';
  END IF;
  RAISE NOTICE 'rollback check 337 ok: columns/trigger/helper functions gone; context_v1 answers from binding and catalogue overlay again';
END
$check$;
ROLLBACK;