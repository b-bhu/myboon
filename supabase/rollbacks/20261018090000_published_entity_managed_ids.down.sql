-- Rollback for 20261018090000_published_entity_managed_ids.sql (#337 PR-D).
-- Restores the pre-PR-D state:
--   * entity_publication_relationship_guard_v1 returns to its exact pre-PR-D
--     body, copied verbatim from
--     20260921153932_harden_entity_catalog_review_boundaries.sql (public
--     stores only); afterwards the function body no longer references the
--     managed helpers and both managed helpers are dropped.
--   * read_managed_entities_v1 (the managed entity lookup) is dropped.
--   * the owner's UPDATE(updated_at) lease on
--     managed_knowledge_private.entities is revoked.
-- It also restores the entity_id FKs to public.entities with their default
-- names (only if absent).
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

-- entity_publication_relationship_guard_v1 returns to its exact pre-PR-D
-- body: copied verbatim from 20260921153932_harden_entity_catalog_review_boundaries.sql
-- (counts only public.entity_memories and status-checks Entity ids in the
-- catalogue only). Restored BEFORE the managed helpers are dropped: this
-- restored body no longer references them, and CREATE OR REPLACE keeps the
-- function's ACLs (REVOKE/GRANT from 20260921153932 still apply).
CREATE OR REPLACE FUNCTION public.entity_publication_relationship_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  source_memory_ids jsonb;
  prior_source_memory_ids jsonb := '[]'::jsonb;
  narrative_entity_id uuid;
  prior_narrative_entity_id uuid;
  prior_row_entity_id uuid;
  narrative_ids uuid[] := ARRAY[]::uuid[];
  referenced_entity_ids uuid[];
  referenced_entity_id uuid;
  referenced_status text;
  requested_memory_count integer;
  found_memory_count integer;
  memory_ownership_before jsonb;
  memory_ownership_after jsonb;
  narrative_relationship_before jsonb;
  narrative_relationship_after jsonb;
BEGIN
  IF TG_TABLE_NAME = 'published_narratives' THEN
    source_memory_ids := NEW.source_memory_ids;
    narrative_entity_id := NEW.entity_id;
    IF TG_OP = 'UPDATE' THEN
      prior_source_memory_ids := OLD.source_memory_ids;
      prior_narrative_entity_id := OLD.entity_id;
      prior_row_entity_id := OLD.entity_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'entity_published_history' THEN
    SELECT narrative.source_memory_ids, narrative.entity_id
    INTO source_memory_ids, narrative_entity_id
    FROM public.published_narratives AS narrative
    WHERE narrative.id = NEW.published_narrative_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'referenced published narrative does not exist'
        USING ERRCODE = '23503';
    END IF;
    narrative_ids := ARRAY[NEW.published_narrative_id];
    IF TG_OP = 'UPDATE' THEN
      prior_row_entity_id := OLD.entity_id;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.published_narrative_id IS DISTINCT FROM NEW.published_narrative_id THEN
      SELECT narrative.source_memory_ids, narrative.entity_id
      INTO prior_source_memory_ids, prior_narrative_entity_id
      FROM public.published_narratives AS narrative
      WHERE narrative.id = OLD.published_narrative_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'prior published narrative relationship is missing'
          USING ERRCODE = '40001';
      END IF;
      narrative_ids := ARRAY[OLD.published_narrative_id, NEW.published_narrative_id];
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported publication relationship table';
  END IF;

  IF jsonb_typeof(source_memory_ids) IS DISTINCT FROM 'array'
     OR jsonb_typeof(prior_source_memory_ids) IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(source_memory_ids || prior_source_memory_ids) AS item(value)
       WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'string'
          OR (item.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     ) THEN
    RAISE EXCEPTION 'source_memory_ids must contain UUID strings'
      USING ERRCODE = '23503';
  END IF;

  SELECT count(DISTINCT item.value #>> '{}')
  INTO requested_memory_count
  FROM jsonb_array_elements(source_memory_ids) AS item(value);

  SELECT count(DISTINCT memory.id)
  INTO found_memory_count
  FROM public.entity_memories AS memory
  JOIN jsonb_array_elements_text(source_memory_ids) AS item(memory_id)
    ON memory.id = item.memory_id::uuid;

  IF found_memory_count IS DISTINCT FROM requested_memory_count THEN
    RAISE EXCEPTION 'source_memory_ids contains a missing memory'
      USING ERRCODE = '23503';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', memory.id,
    'entityId', memory.entity_id
  ) ORDER BY memory.id), '[]'::jsonb)
  INTO memory_ownership_before
  FROM public.entity_memories AS memory
  WHERE memory.id IN (
    SELECT DISTINCT item.memory_id::uuid
    FROM jsonb_array_elements_text(source_memory_ids || prior_source_memory_ids) AS item(memory_id)
  );

  IF TG_TABLE_NAME = 'entity_published_history' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', narrative.id,
      'entityId', narrative.entity_id,
      'sourceMemoryIds', narrative.source_memory_ids
    ) ORDER BY narrative.id), '[]'::jsonb)
    INTO narrative_relationship_before
    FROM public.published_narratives AS narrative
    WHERE narrative.id = ANY(narrative_ids);
  END IF;

  SELECT array_agg(candidate.entity_id ORDER BY candidate.entity_id)
  INTO referenced_entity_ids
  FROM (
    SELECT NEW.entity_id AS entity_id
    UNION
    SELECT narrative_entity_id
    UNION
    SELECT prior_row_entity_id
    UNION
    SELECT prior_narrative_entity_id
    UNION
    SELECT memory.entity_id
    FROM public.entity_memories AS memory
    JOIN jsonb_array_elements_text(source_memory_ids || prior_source_memory_ids) AS item(memory_id)
      ON memory.id = item.memory_id::uuid
  ) AS candidate
  WHERE candidate.entity_id IS NOT NULL;

  FOREACH referenced_entity_id IN ARRAY COALESCE(referenced_entity_ids, ARRAY[]::uuid[])
  LOOP
    SELECT entity.status INTO referenced_status
    FROM public.entities AS entity
    WHERE entity.id = referenced_entity_id
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'publication relationship references a missing Entity'
        USING ERRCODE = '23503';
    END IF;
    IF referenced_status <> 'active' THEN
      RAISE EXCEPTION 'publication relationship references an archived Entity; resolve and retry'
        USING ERRCODE = '40001';
    END IF;
  END LOOP;

  -- Entity locks are acquired before dependency-row locks, matching merge and
  -- rollback ordering. Re-reading ownership after a wait prevents a writer
  -- that saw pre-merge state from committing a post-merge relationship.
  PERFORM memory.id
  FROM public.entity_memories AS memory
  WHERE memory.id IN (
    SELECT DISTINCT item.memory_id::uuid
    FROM jsonb_array_elements_text(source_memory_ids || prior_source_memory_ids) AS item(memory_id)
  )
  ORDER BY memory.id
  FOR SHARE;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', memory.id,
    'entityId', memory.entity_id
  ) ORDER BY memory.id), '[]'::jsonb)
  INTO memory_ownership_after
  FROM public.entity_memories AS memory
  WHERE memory.id IN (
    SELECT DISTINCT item.memory_id::uuid
    FROM jsonb_array_elements_text(source_memory_ids || prior_source_memory_ids) AS item(memory_id)
  );
  IF memory_ownership_after IS DISTINCT FROM memory_ownership_before THEN
    RAISE EXCEPTION 'publication memory ownership changed while waiting; resolve and retry'
      USING ERRCODE = '40001';
  END IF;

  IF TG_TABLE_NAME = 'entity_published_history' THEN
    -- Hold the complete relationship row after the Entity locks. FOR SHARE
    -- blocks ordinary non-key UPDATEs to entity_id/source_memory_ids too.
    PERFORM narrative.id
    FROM public.published_narratives AS narrative
    WHERE narrative.id = ANY(narrative_ids)
    ORDER BY narrative.id
    FOR SHARE;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', narrative.id,
      'entityId', narrative.entity_id,
      'sourceMemoryIds', narrative.source_memory_ids
    ) ORDER BY narrative.id), '[]'::jsonb)
    INTO narrative_relationship_after
    FROM public.published_narratives AS narrative
    WHERE narrative.id = ANY(narrative_ids);
    IF narrative_relationship_after IS DISTINCT FROM narrative_relationship_before THEN
      RAISE EXCEPTION 'published narrative relationship changed while waiting; resolve and retry'
        USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- The managed helpers go after the guard above is restored: its verbatim
-- body no longer references them, and the trigger function that could
-- otherwise call them was already dropped.
DROP FUNCTION IF EXISTS public.managed_active_memory_ids_v1(uuid[]);
DROP FUNCTION IF EXISTS public.managed_entity_lock_status_v1(uuid);

-- The row-lock lease added by the PR-D migration is revoked; no pre-PR-D
-- writer needed UPDATE on managed_knowledge_private.entities.
REVOKE UPDATE (updated_at) ON managed_knowledge_private.entities FROM myboon_knowledge_owner;