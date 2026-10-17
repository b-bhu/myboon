-- #337 PR-D: published rows may reference managed-only entity ids.
-- NOT APPLIED. Needs Bucket's explicit yes (needs-bucket).
--
-- Rollback: supabase/rollbacks/20261018090000_published_entity_managed_ids.down.sql.
-- Depends on 20261017120000 (managed entity columns) and 20261017210000
-- (managed knowledge reader + owner/access pattern copied below).
--
-- One entity id space: catalogue-linked managed entities have
-- id = catalog_entity_id = public.entities.id, article-only managed entities
-- an id absent from public.entities; an entity_id is valid iff it exists in either store.
--
-- Changes in this migration:
--   * published_entity_reference_requires_active_v1 (SECURITY DEFINER, owned
--     by myboon_knowledge_owner): same existence/status gate and messages as
--     the shared entity_reference_requires_active_v1, plus a managed-store
--     fallback when the id is absent from the catalogue. The two published
--     tables' active_entity_guard triggers fire it; the shared function and
--     the entity_memories guard are untouched.
--   * read_managed_entities_v1 pins search_path to pg_catalog, pg_temp.
--   * myboon_knowledge_owner gains UPDATE(updated_at) on
--     managed_knowledge_private.entities, needed only for FOR KEY SHARE row
--     locks (the owner_only policy already covers the rows).
--   * managed_active_memory_ids_v1 and managed_entity_lock_status_v1 helpers
--     (SECURITY DEFINER, owner-only, EXECUTE for service_role) and a
--     CREATE OR REPLACE of the publication relationship guard that counts
--     active managed item_heads and falls back to the managed store for
--     article-only entity ids.
--   * The entity_id FKs to public.entities are still dropped below.

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
-- FOR KEY SHARE on managed_knowledge_private.entities (the published-entity
-- trigger below and managed_entity_lock_status_v1) requires UPDATE privilege
-- on at least one column; the owner_only RLS policy already covers the row
-- access, so this grant exists only for the row lock. The owner's existing
-- full-table UPDATE on item_heads (20261003090000) already covers
-- managed_active_memory_ids_v1. Additive only: catalog maintenance keeps
-- working because its writer functions are owned by (or run as) the
-- migration role, which owns the managed tables; nothing is revoked here.
GRANT UPDATE (updated_at) ON managed_knowledge_private.entities TO myboon_knowledge_owner;
SET LOCAL ROLE myboon_knowledge_owner;

CREATE OR REPLACE FUNCTION public.read_managed_entities_v1(p_entity_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
-- #337 PR-D: pinned like the other PR-D functions; every reference in the
-- body is schema-qualified.
SET search_path = pg_catalog, pg_temp
AS $entities$
DECLARE
  result_rows jsonb;
BEGIN
  IF p_entity_ids IS NULL OR pg_catalog.cardinality(p_entity_ids) = 0 OR pg_catalog.cardinality(p_entity_ids) > 100 THEN
    RAISE EXCEPTION 'managed entity lookup requires between 1 and 100 entity ids' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',entity.id,'slug',entity.slug,'name',entity.name,'type',entity.type,'aliases',entity.aliases,
    'summary',entity.summary,'status',entity.status,'show_in_carousel',entity.show_in_carousel,
    'metadata',entity.metadata,'created_at',entity.created_at,'updated_at',entity.updated_at,
    'catalog_entity_id',entity.catalog_entity_id
  ) ORDER BY entity.id), '[]'::jsonb)
  INTO result_rows
  FROM managed_knowledge_private.entities AS entity
  WHERE entity.id = ANY(p_entity_ids);
  RETURN result_rows;
END
$entities$;

COMMENT ON FUNCTION public.read_managed_entities_v1(uuid[])
  IS '#337 PR-D: read-only managed entity rows in the single id space for the editor-draft/publisher entity existence checks. service_role only.';
REVOKE ALL ON FUNCTION public.read_managed_entities_v1(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_managed_entities_v1(uuid[]) TO service_role;

-- #337 PR-D: existence/status gate for entity_id writes on the two published
-- tables, spanning both stores of the single id space. Messages and codes
-- match entity_reference_requires_active_v1 exactly; only the managed-store
-- fallback is new. SECURITY DEFINER because the publisher has no USAGE on
-- managed_knowledge_private: the definer owner's owner_only policy and the
-- UPDATE(updated_at) lease granted above cover the FOR KEY SHARE locks.
CREATE OR REPLACE FUNCTION public.published_entity_reference_requires_active_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $entity_guard$
DECLARE
  entity_status text;
BEGIN
  IF NEW.entity_id IS NULL THEN RETURN NEW; END IF;

  SELECT entity.status INTO entity_status
  FROM public.entities AS entity
  WHERE entity.id = NEW.entity_id
  FOR KEY SHARE;

  IF FOUND THEN
    IF entity_status <> 'active' THEN
      RAISE EXCEPTION 'referenced Entity is no longer active; resolve its redirect and retry'
        USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
  END IF;

  SELECT entity.status INTO entity_status
  FROM managed_knowledge_private.entities AS entity
  WHERE entity.id = NEW.entity_id
  FOR KEY SHARE;

  IF FOUND THEN
    IF entity_status <> 'active' THEN
      RAISE EXCEPTION 'referenced Entity is no longer active; resolve its redirect and retry'
        USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'referenced Entity does not exist'
    USING ERRCODE = '23503';
END;
$entity_guard$;
-- Trigger functions are invoked only through their trigger bindings, so no
-- EXECUTE grant exists.
REVOKE ALL ON FUNCTION public.published_entity_reference_requires_active_v1()
  FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.published_entity_reference_requires_active_v1() IS
  '#337 PR-D: same gate as entity_reference_requires_active_v1 plus a managed-store fallback for entity_id writes on the two published tables.';

-- #337 PR-D: managed-store pieces of the publication relationship guards.
-- SECURITY DEFINER owned by myboon_knowledge_owner so the publisher never
-- gains USAGE on managed_knowledge_private. VOLATILE: STABLE functions may
-- not take row locks. They only read and row-lock; other writers of these
-- tables (catalog maintenance definer functions owned by the migration role,
-- which is also this owner's grantor) are unaffected, and the grants below
-- only ADD EXECUTE for the publisher and leave every other privilege alone.
CREATE OR REPLACE FUNCTION public.managed_active_memory_ids_v1(p_memory_ids uuid[])
RETURNS uuid[]
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $active_ids$
DECLARE
  active_ids uuid[];
BEGIN
  IF p_memory_ids IS NULL OR pg_catalog.cardinality(p_memory_ids) = 0 THEN
    RETURN '{}'::uuid[];
  END IF;
  -- Lock the active item_heads rows FOR SHARE, ordered by item_id, so a
  -- correction or retraction cannot land underneath the publication write
  -- while it waits. The owner's full-table UPDATE on item_heads
  -- (20261003090000) already permits FOR SHARE.
  PERFORM head.item_id
  FROM managed_knowledge_private.item_heads AS head
  WHERE head.item_id = ANY(p_memory_ids)
    AND head.status = 'active'
  ORDER BY head.item_id
  FOR SHARE;

  SELECT pg_catalog.array_agg(head.item_id ORDER BY head.item_id)
  INTO active_ids
  FROM managed_knowledge_private.items AS item
  JOIN managed_knowledge_private.item_heads AS head
    ON head.item_id = item.id
  WHERE item.id = ANY(p_memory_ids)
    AND head.status = 'active';
  RETURN COALESCE(active_ids, '{}'::uuid[]);
END;
$active_ids$;

CREATE OR REPLACE FUNCTION public.managed_entity_lock_status_v1(p_entity_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $entity_status$
DECLARE
  entity_status text;
BEGIN
  SELECT entity.status INTO entity_status
  FROM managed_knowledge_private.entities AS entity
  WHERE entity.id = p_entity_id
  FOR KEY SHARE;
  RETURN entity_status;
END;
$entity_status$;

REVOKE ALL ON FUNCTION public.managed_active_memory_ids_v1(uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.managed_entity_lock_status_v1(uuid)
  FROM PUBLIC, anon, authenticated;
-- The relationship guards run as their invoker (the publisher), so
-- service_role is the only grantee added here besides the owner.
GRANT EXECUTE ON FUNCTION public.managed_active_memory_ids_v1(uuid[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.managed_entity_lock_status_v1(uuid)
  TO service_role;
COMMENT ON FUNCTION public.managed_active_memory_ids_v1(uuid[]) IS
  '#337 PR-D: requested memory ids that are active in the managed item heads, each locked FOR SHARE.';
COMMENT ON FUNCTION public.managed_entity_lock_status_v1(uuid) IS
  '#337 PR-D: managed entity status with its row locked FOR KEY SHARE, NULL when the id is absent.';

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

-- Drop every single-column FK from the two published tables to public.entities
-- on entity_id, whatever its name, so the article-only managed ids below are
-- kept. Existence is checked by the publisher across both stores instead.
DO $drop_fks$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT c.conrelid, c.conname
    FROM pg_catalog.pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid = 'public.entities'::regclass
      AND c.conrelid IN ('public.published_narratives'::regclass, 'public.entity_published_history'::regclass)
      AND c.conkey = ARRAY[(
        SELECT a.attnum::smallint
        FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attname = 'entity_id'
      )]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.conrelid::regclass, fk.conname);
  END LOOP;
END
$drop_fks$;

COMMENT ON COLUMN public.published_narratives.entity_id
  IS 'Entity id in the single catalogue/managed id space; existence is checked by the publisher (no FK since #337 PR-D).';
COMMENT ON COLUMN public.entity_published_history.entity_id
  IS 'Entity id in the single catalogue/managed id space; existence is checked by the publisher (no FK since #337 PR-D).';

-- #337 PR-D: the two published tables' entity_id existence/status guards move
-- from the shared public-only function to the definer function above.
-- 20260921153932 had folded these trigger names into the relationship guards;
-- the names return here so a missing or archived referenced Entity fails the
-- cheap existence check first (alphabetical trigger order puts
-- *_active_entity_guard ahead of *_relationship_guard). Runs as the
-- migration role because that role owns the published tables; the shared
-- entity_reference_requires_active_v1 and the entity_memories guard are
-- untouched.
DROP TRIGGER IF EXISTS published_narratives_active_entity_guard
  ON public.published_narratives;
CREATE TRIGGER published_narratives_active_entity_guard
BEFORE INSERT OR UPDATE OF entity_id
ON public.published_narratives
FOR EACH ROW
EXECUTE FUNCTION public.published_entity_reference_requires_active_v1();

DROP TRIGGER IF EXISTS entity_published_history_active_entity_guard
  ON public.entity_published_history;
CREATE TRIGGER entity_published_history_active_entity_guard
BEFORE INSERT OR UPDATE OF entity_id
ON public.entity_published_history
FOR EACH ROW
EXECUTE FUNCTION public.published_entity_reference_requires_active_v1();

-- #337 PR-D: the publication relationship guard learns the single id space.
-- This runs as the migration role because that role owns the function (and
-- CREATE OR REPLACE requires ownership); its REVOKE/GRANT from 20260921153932
-- still apply and are preserved. The body is the current one copied verbatim
-- from 20260921153932 with only two changes, marked below:
--   * found_memory_count also counts requested ids reported active by
--     managed_active_memory_ids_v1 once they are missing from the public
--     store; the helper locks those item_heads rows FOR SHARE, so managed
--     memories need no public ownership row (the public snapshots below stay
--     as they are);
--   * an Entity id absent from the catalogue is status-checked and row-locked
--     through managed_entity_lock_status_v1 instead of rejected as missing.
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

  -- #337 PR-D: source memories may live in either store. Count the requested
  -- ids found in public.entity_memories UNION the ids
  -- managed_active_memory_ids_v1 returns for the requested ids missing from
  -- public.entity_memories; the helper row-locks those active item_heads
  -- rows FOR SHARE. Managed memories produce no row in either
  -- memory_ownership snapshot below and are covered by the helper's lock.
  SELECT count(DISTINCT found.memory_id)
  INTO found_memory_count
  FROM (
    SELECT item.memory_id::uuid AS memory_id
    FROM jsonb_array_elements_text(source_memory_ids) AS item(memory_id)
    JOIN public.entity_memories AS memory
      ON memory.id = item.memory_id::uuid
    UNION
    SELECT pg_catalog.unnest(public.managed_active_memory_ids_v1(
      (SELECT pg_catalog.array_agg(DISTINCT item.memory_id::uuid)
       FROM jsonb_array_elements_text(source_memory_ids) AS item(memory_id)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.entity_memories AS memory
         WHERE memory.id = item.memory_id::uuid
       ))
    ))
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