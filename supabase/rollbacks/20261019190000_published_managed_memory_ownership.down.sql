-- Rollback for 20261019190000_published_managed_memory_ownership.sql (#390).
-- Restores the guard body of 20261018090000 verbatim, then drops the helper.
-- No data is touched.

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
  managed_memory_ids uuid[];
  locked_managed_memory_ids uuid[];
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

  -- #337 PR-D: source memories may live in either store. Requested ids
  -- missing from public.entity_memories are checked against active managed
  -- item heads (unlocked here; they are locked after the Entity loop below).
  -- Managed memories produce no row in either memory_ownership snapshot.
  managed_memory_ids := public.managed_active_memory_ids_v1(
    (SELECT pg_catalog.array_agg(DISTINCT item.memory_id::uuid)
     FROM jsonb_array_elements_text(source_memory_ids) AS item(memory_id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.entity_memories AS memory
       WHERE memory.id = item.memory_id::uuid
     )), false);
  SELECT count(DISTINCT found.memory_id)
  INTO found_memory_count
  FROM (
    SELECT item.memory_id::uuid AS memory_id
    FROM jsonb_array_elements_text(source_memory_ids) AS item(memory_id)
    JOIN public.entity_memories AS memory
      ON memory.id = item.memory_id::uuid
    UNION
    SELECT pg_catalog.unnest(managed_memory_ids)
  ) AS found;

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
      -- #337 PR-D: article-only Entities exist only in the managed store. The
      -- helper locks the row FOR KEY SHARE and returns its status, or NULL
      -- when the id is absent from both stores.
      referenced_status := public.managed_entity_lock_status_v1(referenced_entity_id);
      IF referenced_status IS NULL THEN
        RAISE EXCEPTION 'publication relationship references a missing Entity'
          USING ERRCODE = '23503';
      END IF;
    END IF;
    IF referenced_status <> 'active' THEN
      RAISE EXCEPTION 'publication relationship references an archived Entity; resolve and retry'
        USING ERRCODE = '40001';
    END IF;
  END LOOP;

  -- #337 PR-D: managed memory heads are locked only now, after every Entity
  -- lock, then re-read; a head retracted or corrected while waiting fails.
  IF pg_catalog.cardinality(managed_memory_ids) > 0 THEN
    locked_managed_memory_ids := public.managed_active_memory_ids_v1(managed_memory_ids, true);
    IF locked_managed_memory_ids IS DISTINCT FROM managed_memory_ids THEN
      RAISE EXCEPTION 'publication managed memory changed while waiting; resolve and retry'
        USING ERRCODE = '40001';
    END IF;
  END IF;

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
DROP FUNCTION IF EXISTS public.managed_owned_memory_ids_v1(uuid[], uuid, boolean);
