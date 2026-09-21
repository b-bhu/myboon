-- Close the remaining catalogue-maintenance review boundaries:
--   * serialize canonical memory-scope admission with Entity merges;
--   * make publication relationships participate in the Entity lock fence;
--   * persist and verify full-row rollback digests; and
--   * expose one fail-closed bulk redirect resolver for internal readers.

CREATE OR REPLACE FUNCTION public.entity_catalog_row_sha256_v1(p_row jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_row::text, 'UTF8'), 'sha256'),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION public.entity_memory_canonical_scope_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  scope_identity text;
BEGIN
  IF NEW.entity_id IS NULL THEN RETURN NEW; END IF;

  scope_identity := CASE
    WHEN NEW.source = 'news' THEN COALESCE(
      NULLIF(NEW.context->>'canonical_source_item_id', ''),
      'packet:' || NEW.source_research_id
    )
    ELSE 'packet:' || NEW.source_research_id
  END;

  -- The advisory lock covers both ordinary concurrent writers and the point
  -- where a merge has moved a source memory underneath a writer that was
  -- waiting on the target Entity row.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    NEW.source || chr(31) || NEW.source_area || chr(31)
      || scope_identity || chr(31) || NEW.entity_id::text,
    0
  ));

  IF EXISTS (
    SELECT 1
    FROM public.entity_memories AS existing
    WHERE existing.entity_id = NEW.entity_id
      AND existing.id IS DISTINCT FROM NEW.id
      AND existing.source = NEW.source
      AND existing.source_area = NEW.source_area
      AND CASE
        WHEN existing.source = 'news' THEN COALESCE(
          NULLIF(existing.context->>'canonical_source_item_id', ''),
          'packet:' || existing.source_research_id
        )
        ELSE 'packet:' || existing.source_research_id
      END = scope_identity
  ) THEN
    RAISE EXCEPTION 'canonical memory scope already exists for this Entity; resolve and retry'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_memories_canonical_scope_guard
  ON public.entity_memories;
CREATE TRIGGER entity_memories_canonical_scope_guard
BEFORE INSERT OR UPDATE OF entity_id, source, source_area, source_research_id, context
ON public.entity_memories
FOR EACH ROW
EXECUTE FUNCTION public.entity_memory_canonical_scope_guard_v1();

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

DROP TRIGGER IF EXISTS published_narratives_active_entity_guard
  ON public.published_narratives;
DROP TRIGGER IF EXISTS published_narratives_relationship_guard
  ON public.published_narratives;
CREATE TRIGGER published_narratives_relationship_guard
BEFORE INSERT OR UPDATE OF entity_id, source_memory_ids
ON public.published_narratives
FOR EACH ROW
EXECUTE FUNCTION public.entity_publication_relationship_guard_v1();

DROP TRIGGER IF EXISTS entity_published_history_active_entity_guard
  ON public.entity_published_history;
DROP TRIGGER IF EXISTS entity_published_history_relationship_guard
  ON public.entity_published_history;
CREATE TRIGGER entity_published_history_relationship_guard
BEFORE INSERT OR UPDATE OF entity_id, published_narrative_id
ON public.entity_published_history
FOR EACH ROW
EXECUTE FUNCTION public.entity_publication_relationship_guard_v1();

CREATE OR REPLACE FUNCTION public.entity_catalog_operation_strict_state_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  memory_manifest jsonb;
  narrative_manifest jsonb;
  history_manifest jsonb;
  strict_state jsonb;
  expected_state jsonb;
BEGIN
  IF NEW.operation_type <> 'merge_entities' THEN RETURN NEW; END IF;
  IF NOT (
    (NEW.status = 'applied' AND OLD.status = 'applying')
    OR (NEW.status = 'rolling_back' AND OLD.status = 'applied')
  ) THEN
    RETURN NEW;
  END IF;

  memory_manifest := NEW.manifest->'memories';
  narrative_manifest := NEW.manifest->'publishedNarratives';
  history_manifest := NEW.manifest->'publishedHistory';
  IF jsonb_typeof(memory_manifest) IS DISTINCT FROM 'array'
     OR jsonb_typeof(narrative_manifest) IS DISTINCT FROM 'array'
     OR jsonb_typeof(history_manifest) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'strict Entity merge state requires complete manifests';
  END IF;

  strict_state := jsonb_build_object(
    'schemaVersion', 'myboon.entity_catalog_strict_state.v1',
    'sourceEntitySha256', (
      SELECT public.entity_catalog_row_sha256_v1(to_jsonb(entity))
      FROM public.entities AS entity WHERE entity.id = NEW.source_entity_id
    ),
    'targetEntitySha256', (
      SELECT public.entity_catalog_row_sha256_v1(to_jsonb(entity))
      FROM public.entities AS entity WHERE entity.id = NEW.target_entity_id
    ),
    'memoryRows', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', memory.id,
        'sha256', public.entity_catalog_row_sha256_v1(to_jsonb(memory))
      ) ORDER BY memory.id), '[]'::jsonb)
      FROM public.entity_memories AS memory
      JOIN jsonb_array_elements(memory_manifest) AS item(value)
        ON memory.id = (item.value->>'id')::uuid
    ),
    'publishedNarrativeRows', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', narrative.id,
        'sha256', public.entity_catalog_row_sha256_v1(to_jsonb(narrative))
      ) ORDER BY narrative.id), '[]'::jsonb)
      FROM public.published_narratives AS narrative
      JOIN jsonb_array_elements(narrative_manifest) AS item(value)
        ON narrative.id = (item.value->>'id')::uuid
    ),
    'publishedHistoryRows', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', history.id,
        'sha256', public.entity_catalog_row_sha256_v1(to_jsonb(history))
      ) ORDER BY history.id), '[]'::jsonb)
      FROM public.entity_published_history AS history
      JOIN jsonb_array_elements(history_manifest) AS item(value)
        ON history.id = (item.value->>'id')::uuid
    )
  );

  IF NEW.status = 'applied' THEN
    NEW.after_state := COALESCE(NEW.after_state, '{}'::jsonb)
      || jsonb_build_object('strictRowDigests', strict_state);
    RETURN NEW;
  END IF;

  expected_state := OLD.after_state->'strictRowDigests';
  IF jsonb_typeof(expected_state) IS DISTINCT FROM 'object'
     OR expected_state IS DISTINCT FROM strict_state THEN
    RAISE EXCEPTION 'Entity merge rows changed after apply; strict rollback requires review';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_catalog_operation_strict_state
  ON public.entity_catalog_maintenance_operations;
CREATE TRIGGER entity_catalog_operation_strict_state
BEFORE UPDATE OF status
ON public.entity_catalog_maintenance_operations
FOR EACH ROW
EXECUTE FUNCTION public.entity_catalog_operation_strict_state_v1();

CREATE OR REPLACE FUNCTION public.resolve_entity_redirect_v1(p_entity_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN source.status = 'active' THEN source.id
    WHEN target.status = 'active' THEN target.id
    ELSE NULL
  END
  FROM public.entities AS source
  LEFT JOIN public.entity_redirects AS redirect
    ON redirect.source_entity_id = source.id
  LEFT JOIN public.entities AS target
    ON target.id = redirect.target_entity_id
  WHERE source.id = p_entity_id
$$;

CREATE OR REPLACE FUNCTION public.resolve_entity_redirects_v1(p_entity_ids uuid[])
RETURNS TABLE(input_entity_id uuid, resolved_entity_id uuid)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT requested.entity_id,
    CASE
      WHEN source.status = 'active' THEN source.id
      WHEN target.status = 'active' THEN target.id
      ELSE NULL
    END
  FROM unnest(COALESCE(p_entity_ids, ARRAY[]::uuid[])) AS requested(entity_id)
  JOIN public.entities AS source ON source.id = requested.entity_id
  LEFT JOIN public.entity_redirects AS redirect
    ON redirect.source_entity_id = source.id
  LEFT JOIN public.entities AS target
    ON target.id = redirect.target_entity_id
$$;

REVOKE ALL ON FUNCTION public.entity_catalog_row_sha256_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entity_memory_canonical_scope_guard_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entity_publication_relationship_guard_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entity_catalog_operation_strict_state_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_entity_redirect_v1(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_entity_redirects_v1(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.entity_catalog_row_sha256_v1(jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.entity_memory_canonical_scope_guard_v1()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.entity_publication_relationship_guard_v1()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.entity_catalog_operation_strict_state_v1()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_entity_redirect_v1(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_entity_redirects_v1(uuid[])
  TO service_role;

COMMENT ON FUNCTION public.entity_memory_canonical_scope_guard_v1() IS
  'Serializes canonical memory admission and rechecks scope after Entity-merge waits.';
COMMENT ON FUNCTION public.entity_publication_relationship_guard_v1() IS
  'Locks every Entity reached through publication relationships before writes.';
COMMENT ON FUNCTION public.entity_catalog_operation_strict_state_v1() IS
  'Persists full-row SHA-256 state at merge apply and requires an exact match before rollback.';
COMMENT ON FUNCTION public.resolve_entity_redirects_v1(uuid[]) IS
  'Bulk resolves active Entities and one-hop archived redirects; unresolved inputs return NULL.';
