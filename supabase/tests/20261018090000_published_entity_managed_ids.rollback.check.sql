-- #337 PR-D rollback check for supabase/rollbacks/20261018090000_published_entity_managed_ids.down.sql.
-- Run ONLY against a disposable database with every migration applied
-- (including 20261018090000), as a superuser, from the repo root:
--   psql ... -f supabase/tests/20261018090000_published_entity_managed_ids.rollback.check.sql
-- It seeds a published narrative and a published-history row whose entity_id
-- exists only in the managed store (the exact stranded-row case), then runs
-- the rollback inside one transaction with myboon.rollback_null_managed_entity_ids
-- = 'on': the stranded ids are NULLed (text columns kept), the FKs and the old
-- public-store gate are back, the restored relationship guard body has no
-- managed references, and the updated_at lease is revoked. Everything rolls
-- back at the end.
\set ON_ERROR_STOP on
BEGIN;

-- An article-only managed Entity the published rows can legally reference
-- while PR-D is applied; public.entities has no such id.
INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
  VALUES('progression-v2:' || repeat('d',64),'rollback-check-337d',1,clock_timestamp() + interval '1 hour');
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
  VALUES('00000000-0000-4000-8000-00000000d337','check:rollback 337d',NULL,
    '{"id":"00000000-0000-4000-8000-00000000d337","name":"Rollback 337D (RB337D)","slug":"rollback-337d","type":"topic","aliases":["RB337D"],"summary":"rollback binding"}'::jsonb,
    'progression-v2:' || repeat('d',64));
INSERT INTO public.published_narratives(id,content_small,title,entity_id,entity_slug)
  VALUES('00000000-0000-4000-8000-00000000d338','rollback seed for the #337 PR-D rollback check','Rollback 337D (RB337D)',
    '00000000-0000-4000-8000-00000000d337','rollback-337d');
INSERT INTO public.entity_published_history(id,published_narrative_id,entity_id,entity_slug,title)
  VALUES('00000000-0000-4000-8000-00000000d339','00000000-0000-4000-8000-00000000d338',
    '00000000-0000-4000-8000-00000000d337','rollback-337d','Rollback 337D (RB337D)');

-- Sanity: PR-D applied, both stranded rows landed, and the nulling guard is
-- unset, so the rollback would refuse without it.
DO $pre$
BEGIN
  IF to_regprocedure('public.published_entity_reference_requires_active_v1()') IS NULL
    OR to_regprocedure('public.read_managed_entities_v1(uuid[])') IS NULL
    OR to_regprocedure('public.managed_entity_lock_status_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION '20261018090000 is not applied; run this check on a fully migrated database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.published_narratives
    WHERE id = '00000000-0000-4000-8000-00000000d338'
      AND entity_id = '00000000-0000-4000-8000-00000000d337')
    OR NOT EXISTS (SELECT 1 FROM public.entity_published_history
    WHERE id = '00000000-0000-4000-8000-00000000d339'
      AND entity_id = '00000000-0000-4000-8000-00000000d337') THEN
    RAISE EXCEPTION 'the seeded published rows must carry the managed-only entity_id';
  END IF;
  IF current_setting('myboon.rollback_null_managed_entity_ids', true) IS NOT DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'myboon.rollback_null_managed_entity_ids must be unset for this check';
  END IF;
END
$pre$;

SET LOCAL myboon.rollback_null_managed_entity_ids = 'on';
\ir ../rollbacks/20261018090000_published_entity_managed_ids.down.sql

DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN
      ('published_entity_reference_requires_active_v1','read_managed_entities_v1',
       'managed_active_memory_ids_v1','managed_entity_lock_status_v1')) THEN
    RAISE EXCEPTION 'rollback left a #337 PR-D function or managed helper behind';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND p.proname = 'entity_reference_requires_active_v1' AND (
      (t.tgrelid = 'public.published_narratives'::regclass AND t.tgname = 'published_narratives_active_entity_guard')
      OR (t.tgrelid = 'public.entity_published_history'::regclass AND t.tgname = 'entity_published_history_active_entity_guard')
      OR (t.tgrelid = 'public.entity_memories'::regclass AND t.tgname = 'entity_memories_active_entity_guard'))) <> 3 THEN
    RAISE EXCEPTION 'rollback must restore the *_active_entity_guard triggers on the shared public-store function';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_constraint
    WHERE contype = 'f' AND confdeltype = 'n' AND convalidated
      AND confrelid = 'public.entities'::regclass AND (
        (conrelid = 'public.published_narratives'::regclass AND conname = 'published_narratives_entity_id_fkey')
        OR (conrelid = 'public.entity_published_history'::regclass AND conname = 'entity_published_history_entity_id_fkey'))) <> 2 THEN
    RAISE EXCEPTION 'rollback did not restore the entity_id FKs with ON DELETE SET NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM public.published_narratives
    WHERE id = '00000000-0000-4000-8000-00000000d338'
      AND (entity_id IS NOT NULL OR entity_slug IS DISTINCT FROM 'rollback-337d')) THEN
    RAISE EXCEPTION 'rollback did not NULL the stranded published_narratives entity_id (entity_slug kept)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.entity_published_history
    WHERE id = '00000000-0000-4000-8000-00000000d339'
      AND (entity_id IS NOT NULL OR entity_slug IS DISTINCT FROM 'rollback-337d')) THEN
    RAISE EXCEPTION 'rollback did not NULL the stranded entity_published_history entity_id (entity_slug kept)';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'entity_publication_relationship_guard_v1'
      AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
      AND p.prosrc NOT ILIKE '%managed\_%') <> 1 THEN
    RAISE EXCEPTION 'restored relationship guard must be the public-only SECURITY INVOKER with search_path pinned empty';
  END IF;
  IF has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities','updated_at','UPDATE') THEN
    RAISE EXCEPTION 'rollback left the owner''s UPDATE(updated_at) lease on managed_knowledge_private.entities';
  END IF;
  RAISE NOTICE 'rollback check 337d ok: stranded ids NULLed, entity_id FKs and old gate back, PR-D functions and helpers gone, guard public-only again';
END
$check$;

-- The restored public-store gate rejects the article-only id again.
DO $old_gate$
BEGIN
  BEGIN
    INSERT INTO public.published_narratives(id,content_small,entity_id)
      VALUES('00000000-0000-4000-8000-00000000d340','rollback gate probe','00000000-0000-4000-8000-00000000d337');
    RAISE EXCEPTION 'restored gate accepted a managed-only entity_id';
  EXCEPTION
    WHEN SQLSTATE '23503' THEN
      IF SQLERRM <> 'referenced Entity does not exist' THEN
        RAISE EXCEPTION 'restored gate failure message changed: %',SQLERRM;
      END IF;
  END;
END
$old_gate$;

ROLLBACK;