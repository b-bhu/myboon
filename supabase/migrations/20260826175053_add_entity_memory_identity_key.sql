-- Stable Entity Memory replay identity.
--
-- Existing rows are retained one-for-one. Their compatibility identity hashes
-- the exact columns in the former unique tuple, including title, so the
-- backfill cannot merge or reinterpret legacy memories. Canonical Feed V3
-- writers provide a title-independent myboon.memory_identity.v1 key instead.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE public.entity_memories
  ADD COLUMN memory_identity_key text;

-- Rolling-deploy compatibility: binaries from before this migration omit the
-- new column. Derive exactly the same legacy identity as the backfill only
-- when no explicit code-owned identity was supplied. Canonical Feed V3 keys
-- therefore remain authoritative and are never rewritten by this trigger.
CREATE OR REPLACE FUNCTION public.entity_memory_compat_identity_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.memory_identity_key IS NULL THEN
    NEW.memory_identity_key :=
      'myboon.memory_identity.v1:legacy:' ||
      encode(
        extensions.digest(
          convert_to(
            concat_ws(
              chr(31),
              NEW.source,
              NEW.source_area,
              NEW.source_research_id,
              COALESCE(NEW.entity_id::text, ''),
              NEW.memory_type,
              NEW.title
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.entity_memory_compat_identity_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.entity_memory_compat_identity_v1() TO service_role;

CREATE TRIGGER entity_memories_compat_identity_v1
BEFORE INSERT OR UPDATE ON public.entity_memories
FOR EACH ROW
EXECUTE FUNCTION public.entity_memory_compat_identity_v1();

UPDATE public.entity_memories
SET memory_identity_key =
  'myboon.memory_identity.v1:legacy:' ||
  encode(
    extensions.digest(
      convert_to(
        concat_ws(
          chr(31),
          source,
          source_area,
          source_research_id,
          COALESCE(entity_id::text, ''),
          memory_type,
          title
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

ALTER TABLE public.entity_memories
  ALTER COLUMN memory_identity_key SET NOT NULL,
  ADD CONSTRAINT entity_memories_identity_key_format_check CHECK (
    memory_identity_key ~ '^myboon\.memory_identity\.v1:(legacy:)?[0-9a-f]{64}$'
  );

CREATE UNIQUE INDEX entity_memories_identity_key_unique_idx
  ON public.entity_memories (memory_identity_key);

-- Keep entity_memories_source_unique_idx during the rolling deploy because
-- pre-migration binaries name that exact legacy tuple as their ON CONFLICT
-- target. New writers use memory_identity_key; remove the compatibility index
-- only after those binaries have been fully retired.

-- Cursor readers use deterministic timestamp/id keysets. These indexes are
-- additive and retain the existing source/type indexes for legacy consumers.
CREATE INDEX entity_memories_observed_cursor_idx
  ON public.entity_memories (observed_at DESC, id DESC)
  WHERE entity_id IS NOT NULL;

CREATE INDEX entity_memories_updated_cursor_idx
  ON public.entity_memories (updated_at ASC, id ASC)
  WHERE entity_id IS NOT NULL;

CREATE INDEX entity_memories_priority_observed_cursor_idx
  ON public.entity_memories ((context->>'priority_class'), observed_at DESC, id DESC)
  WHERE entity_id IS NOT NULL;

COMMENT ON COLUMN public.entity_memories.memory_identity_key IS
  'Code-owned myboon.memory_identity.v1 replay identity; canonical keys do not depend on generated wording. Null legacy writes receive a deterministic compatibility identity.';

-- Bounded, case-insensitive canonical identity lookup. The extra row and
-- total_count let callers fail closed instead of treating a truncated result
-- as an authoritative duplicate check.
CREATE OR REPLACE FUNCTION public.entity_manager_lookup_entities_v1(
  p_slugs text[],
  p_names text[],
  p_aliases text[],
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  id uuid,
  slug text,
  name text,
  type text,
  aliases jsonb,
  summary text,
  status text,
  show_in_carousel boolean,
  metadata jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH matches AS (
    SELECT entity.*
    FROM public.entities AS entity
    WHERE (
        lower(entity.slug) IN (
          SELECT lower(label) FROM unnest(COALESCE(p_slugs, ARRAY[]::text[])) AS label
        )
        OR lower(entity.name) IN (
          SELECT lower(label)
          FROM unnest(COALESCE(p_names, ARRAY[]::text[]) || COALESCE(p_aliases, ARRAY[]::text[])) AS label
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(entity.aliases) AS entity_alias(label)
          WHERE lower(entity_alias.label) IN (
            SELECT lower(input_label)
            FROM unnest(COALESCE(p_names, ARRAY[]::text[]) || COALESCE(p_aliases, ARRAY[]::text[])) AS input_label
          )
        )
      )
  )
  SELECT
    matches.id,
    matches.slug,
    matches.name,
    matches.type,
    matches.aliases,
    matches.summary,
    matches.status,
    matches.show_in_carousel,
    matches.metadata,
    matches.created_at,
    matches.updated_at,
    count(*) OVER () AS total_count
  FROM matches
  ORDER BY matches.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100) + 1;
$$;

-- Canonical creation repeats the exact identity check while holding one
-- transaction-scoped advisory lock. This closes the lookup/create race across
-- worker processes without changing legacy createEntities behavior.
CREATE OR REPLACE FUNCTION public.entity_manager_create_entity_v1(
  p_slug text,
  p_name text,
  p_type text,
  p_aliases jsonb,
  p_summary text,
  p_status text,
  p_show_in_carousel boolean,
  p_metadata jsonb,
  p_identity_slugs text[],
  p_identity_names text[],
  p_identity_aliases text[]
)
RETURNS SETOF public.entities
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  collision public.entities%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('myboon.entity_manager.canonical_create.v1', 0)
  );

  SELECT entity.*
  INTO collision
  FROM public.entities AS entity
  WHERE
    lower(entity.slug) IN (
      SELECT lower(label)
      FROM unnest(COALESCE(p_identity_slugs, ARRAY[]::text[]) || ARRAY[p_slug]) AS label
    )
    OR lower(entity.name) IN (
      SELECT lower(label)
      FROM unnest(
        COALESCE(p_identity_names, ARRAY[]::text[])
        || COALESCE(p_identity_aliases, ARRAY[]::text[])
        || ARRAY[p_name]
      ) AS label
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(entity.aliases) AS entity_alias(label)
      WHERE lower(entity_alias.label) IN (
        SELECT lower(input_label)
        FROM unnest(
          COALESCE(p_identity_names, ARRAY[]::text[])
          || COALESCE(p_identity_aliases, ARRAY[]::text[])
          || ARRAY[p_name]
        ) AS input_label
      )
    )
  ORDER BY (lower(entity.slug) = lower(p_slug)) DESC, entity.id
  LIMIT 1;

  IF FOUND THEN
    IF lower(collision.slug) = lower(p_slug) AND collision.status = 'active' THEN
      RETURN NEXT collision;
      RETURN;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'canonical entity identity collision';
  END IF;

  RETURN QUERY
  INSERT INTO public.entities (
    slug, name, type, aliases, summary, status, show_in_carousel, metadata
  ) VALUES (
    p_slug,
    p_name,
    p_type,
    COALESCE(p_aliases, '[]'::jsonb),
    p_summary,
    p_status,
    COALESCE(p_show_in_carousel, false),
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.entity_manager_lookup_entities_v1(text[], text[], text[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.entity_manager_create_entity_v1(text, text, text, jsonb, text, text, boolean, jsonb, text[], text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.entity_manager_lookup_entities_v1(text[], text[], text[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.entity_manager_create_entity_v1(text, text, text, jsonb, text, text, boolean, jsonb, text[], text[], text[]) TO service_role;

-- Read-only deployment verification used by the active worker before its
-- first claim and by the non-mutating rehearsal command. It intentionally
-- reports catalog state instead of repairing or applying anything.
CREATE OR REPLACE FUNCTION public.entity_manager_verify_migration_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'schema_version', 'myboon.entity_memory_migration_verification.v1',
    'total_rows', (SELECT count(*) FROM public.entity_memories),
    'null_identity_keys', (
      SELECT count(*) FROM public.entity_memories WHERE memory_identity_key IS NULL
    ),
    'duplicate_identity_key_groups', (
      SELECT count(*) FROM (
        SELECT memory_identity_key
        FROM public.entity_memories
        WHERE memory_identity_key IS NOT NULL
        GROUP BY memory_identity_key
        HAVING count(*) > 1
      ) AS duplicate_keys
    ),
    'identity_column_exists', EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.entity_memories'::regclass
        AND attname = 'memory_identity_key'
        AND NOT attisdropped
    ),
    'identity_not_null', COALESCE((
      SELECT attnotnull FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.entity_memories'::regclass
        AND attname = 'memory_identity_key'
        AND NOT attisdropped
    ), false),
    'required_indexes', jsonb_build_object(
      'entity_memories_identity_key_unique_idx', EXISTS (
        SELECT 1 FROM pg_catalog.pg_index
        WHERE indexrelid = to_regclass('public.entity_memories_identity_key_unique_idx')
          AND indisunique
      ),
      'entity_memories_observed_cursor_idx',
        to_regclass('public.entity_memories_observed_cursor_idx') IS NOT NULL,
      'entity_memories_updated_cursor_idx',
        to_regclass('public.entity_memories_updated_cursor_idx') IS NOT NULL,
      'entity_memories_priority_observed_cursor_idx',
        to_regclass('public.entity_memories_priority_observed_cursor_idx') IS NOT NULL
    ),
    'required_functions', jsonb_build_object(
      'entity_manager_lookup_entities_v1',
        to_regprocedure('public.entity_manager_lookup_entities_v1(text[],text[],text[],integer)') IS NOT NULL,
      'entity_manager_create_entity_v1',
        to_regprocedure('public.entity_manager_create_entity_v1(text,text,text,jsonb,text,text,boolean,jsonb,text[],text[],text[])') IS NOT NULL
    ),
    'service_role_grants', jsonb_build_object(
      'entity_manager_lookup_entities_v1', CASE
        WHEN to_regprocedure('public.entity_manager_lookup_entities_v1(text[],text[],text[],integer)') IS NULL THEN false
        ELSE has_function_privilege(
          'service_role',
          to_regprocedure('public.entity_manager_lookup_entities_v1(text[],text[],text[],integer)'),
          'EXECUTE'
        )
      END,
      'entity_manager_create_entity_v1', CASE
        WHEN to_regprocedure('public.entity_manager_create_entity_v1(text,text,text,jsonb,text,text,boolean,jsonb,text[],text[],text[])') IS NULL THEN false
        ELSE has_function_privilege(
          'service_role',
          to_regprocedure('public.entity_manager_create_entity_v1(text,text,text,jsonb,text,text,boolean,jsonb,text[],text[],text[])'),
          'EXECUTE'
        )
      END
    ),
    'rolling_trigger_present', EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'public.entity_memories'::regclass
        AND tgname = 'entity_memories_compat_identity_v1'
        AND tgfoid = to_regprocedure('public.entity_memory_compat_identity_v1()')
        AND NOT tgisinternal
        AND tgenabled <> 'D'
    )
  );
$$;

REVOKE ALL ON FUNCTION public.entity_manager_verify_migration_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.entity_manager_verify_migration_v1() TO service_role;
