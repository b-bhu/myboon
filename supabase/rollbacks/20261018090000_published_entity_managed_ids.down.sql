-- Rollback for 20261018090000_published_entity_managed_ids.sql (#337 PR-D).
-- Drops the managed entity lookup function and restores the entity_id FKs to
-- public.entities with their default names (only if absent).
--
-- Rows whose entity_id points only at the managed store
-- (managed_knowledge_private.entities, absent from public.entities) would
-- break the re-added FK, so they are NULLed first, matching the
-- ON DELETE SET NULL semantics; entity_slug/entity_name text columns are kept.
-- That NULLing only runs with the explicit guard, otherwise the rollback
-- refuses and reports both counts:
--   SET LOCAL myboon.rollback_null_managed_entity_ids = 'on';

DROP FUNCTION IF EXISTS public.read_managed_entities_v1(uuid[]);

DO $null_managed$
DECLARE
  narratives_managed bigint;
  history_managed bigint;
BEGIN
  SELECT count(*) INTO narratives_managed
    FROM public.published_narratives n
    WHERE n.entity_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.entities e WHERE e.id = n.entity_id);
  SELECT count(*) INTO history_managed
    FROM public.entity_published_history h
    WHERE h.entity_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.entities e WHERE e.id = h.entity_id);
  IF narratives_managed = 0 AND history_managed = 0 THEN
    RETURN;
  END IF;
  IF current_setting('myboon.rollback_null_managed_entity_ids', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'rollback would strand % published_narratives and % entity_published_history rows with managed-only entity ids, refusing to re-add the entity_id FKs; run with SET LOCAL myboon.rollback_null_managed_entity_ids = ''on'' to NULL those entity_id values first',
      narratives_managed, history_managed;
  END IF;
  UPDATE public.published_narratives
    SET entity_id = NULL
    WHERE entity_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.entities e WHERE e.id = entity_id);
  UPDATE public.entity_published_history
    SET entity_id = NULL
    WHERE entity_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.entities e WHERE e.id = entity_id);
  RAISE NOTICE 'nulled managed-only entity_id on % published_narratives and % entity_published_history rows', narratives_managed, history_managed;
END
$null_managed$;

DO $restore_fks$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'published_narratives_entity_id_fkey'
    AND conrelid = 'public.published_narratives'::regclass) THEN
    ALTER TABLE public.published_narratives
      ADD CONSTRAINT published_narratives_entity_id_fkey
      FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'entity_published_history_entity_id_fkey'
    AND conrelid = 'public.entity_published_history'::regclass) THEN
    ALTER TABLE public.entity_published_history
      ADD CONSTRAINT entity_published_history_entity_id_fkey
      FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE SET NULL;
  END IF;
END
$restore_fks$;