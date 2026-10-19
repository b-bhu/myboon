-- #390: the publication relationship guard checks managed-memory ownership
-- through managed_knowledge_private.memberships (follow-up to #389).
-- NOT APPLIED. Needs Bucket's explicit yes (needs-bucket). Apply only after
-- 20261018090000 is applied.
--
-- Rollback: supabase/rollbacks/20261019190000_published_managed_memory_ownership.down.sql.
-- Check: supabase/tests/20261019190000_published_managed_memory_ownership.check.sql.
-- Local proof: supabase/tests/20261019190000_published_managed_memory_ownership.pg-test.sh.
--
-- Rule (CTO, #390): a managed memory cited by a publication must have a live
-- membership (removed_operation IS NULL AND NOT uncertain, the filter every
-- reader uses since #343) whose entity_id is the publication's entity
-- (entity_published_history: the cited narrative's entity_id). Checked before
-- the lock waits (missing -> 23503) and again after them under FOR SHARE
-- (changed -> 40001). Only NEW source_memory_ids are checked. Public memories
-- are unchanged (a public owner check is a follow-up).
-- Lock order: Entity locks -> item_heads FOR SHARE -> memberships FOR SHARE
-- -> public memories.
--
-- Changes: one new helper managed_owned_memory_ids_v1, and the guard body
-- copied verbatim from 20261018090000 with two marked additions.

DO $access$
BEGIN
  PERFORM set_config('myboon.migration_had_owner_set',pg_has_role(current_user,'myboon_knowledge_owner','SET')::text,true);
  PERFORM set_config('myboon.migration_had_owner_public_create',has_schema_privilege('myboon_knowledge_owner','public','CREATE')::text,true);
  IF NOT pg_has_role(current_user,'myboon_knowledge_owner','SET') THEN
    EXECUTE format('GRANT myboon_knowledge_owner TO %I WITH INHERIT FALSE, SET TRUE',current_user);
  END IF;
END
$access$;
GRANT CREATE ON SCHEMA public TO myboon_knowledge_owner;
SET LOCAL ROLE myboon_knowledge_owner;

-- SECURITY DEFINER owned by myboon_knowledge_owner (same pattern as
-- managed_active_memory_ids_v1). VOLATILE: it takes row locks. The owner's
-- UPDATE on memberships (20261003090000) permits FOR SHARE.
CREATE OR REPLACE FUNCTION public.managed_owned_memory_ids_v1(p_memory_ids uuid[], p_entity_id uuid, p_lock boolean DEFAULT false)
RETURNS uuid[]
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $owned_ids$
DECLARE
  owned_ids uuid[];
BEGIN
  IF p_memory_ids IS NULL OR pg_catalog.cardinality(p_memory_ids) = 0 OR p_entity_id IS NULL THEN
    RETURN '{}'::uuid[];
  END IF;
  IF p_lock THEN
    PERFORM membership.item_id
    FROM managed_knowledge_private.memberships AS membership
    WHERE membership.item_id = ANY(p_memory_ids)
      AND membership.entity_id = p_entity_id
      AND membership.removed_operation IS NULL
      AND NOT membership.uncertain
    ORDER BY membership.item_id
    FOR SHARE;
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT membership.item_id ORDER BY membership.item_id)
  INTO owned_ids
  FROM managed_knowledge_private.memberships AS membership
  WHERE membership.item_id = ANY(p_memory_ids)
    AND membership.entity_id = p_entity_id
    AND membership.removed_operation IS NULL
    AND NOT membership.uncertain;
  RETURN COALESCE(owned_ids, '{}'::uuid[]);
END;
$owned_ids$;

REVOKE ALL ON FUNCTION public.managed_owned_memory_ids_v1(uuid[], uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.managed_owned_memory_ids_v1(uuid[], uuid, boolean) TO service_role;
COMMENT ON FUNCTION public.managed_owned_memory_ids_v1(uuid[], uuid, boolean) IS
  '#390: requested managed memory ids with a live (not removed, not uncertain) membership to the entity; those membership rows are locked FOR SHARE when p_lock.';

RESET ROLE;
DO $restore$
BEGIN
  IF current_setting('myboon.migration_had_owner_public_create')='false' THEN
    REVOKE CREATE ON SCHEMA public FROM myboon_knowledge_owner;
  END IF;
  IF current_setting('myboon.migration_had_owner_set')='false' THEN
    EXECUTE format('REVOKE SET OPTION FOR myboon_knowledge_owner FROM %I',current_user);
  END IF;
END
$restore$;

-- Runs as the migration role, which owns the guard; its REVOKE/GRANT from
-- 20260921153932 are preserved by CREATE OR REPLACE.
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
  -- #390: managed memories owned (live membership) by the publication's entity.
  owned_managed_memory_ids uuid[];
  locked_owned_memory_ids uuid[];
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

  -- #390: every NEW managed memory must have a live membership (not removed,
  -- not uncertain) to the publication's entity: the narrative's own entity_id
  -- (for entity_published_history, the cited narrative's). Prior ids keep
  -- today's handling. Re-checked under lock after the Entity locks below.
  IF pg_catalog.cardinality(managed_memory_ids) > 0 THEN
    owned_managed_memory_ids := public.managed_owned_memory_ids_v1(managed_memory_ids, narrative_entity_id, false);
    IF owned_managed_memory_ids IS DISTINCT FROM managed_memory_ids THEN
      RAISE EXCEPTION 'source_memory_ids contains a managed memory that does not belong to the publication entity'
        USING ERRCODE = '23503';
    END IF;
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
    -- #390: lock order entity -> item_heads -> memberships -> public memories.
    locked_owned_memory_ids := public.managed_owned_memory_ids_v1(managed_memory_ids, narrative_entity_id, true);
    IF locked_owned_memory_ids IS DISTINCT FROM managed_memory_ids THEN
      RAISE EXCEPTION 'publication managed memory membership changed while waiting; resolve and retry'
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
