-- #342 PR-2: fuzzy entity candidates for article creation dedupe.
-- NOT APPLIED. Needs Bucket's explicit yes (needs-bucket). Depends on
-- 20261017120000 (#368: name/aliases/type/status columns and the generated
-- name_key). Reads only real columns (name_key, aliases), never binding.
--
-- Rollback: supabase/rollbacks/20261019210000_managed_entity_fuzzy_candidates.down.sql.
-- Check: supabase/tests/20261019210000_managed_entity_fuzzy_candidates.check.sql.
--
-- Adds:
--   * pg_trgm in the extensions schema (additive; IF NOT EXISTS);
--   * a trigram GIN index on managed_knowledge_private.entities(name_key);
--   * managed_knowledge_private.fuzzy_entity_candidates_v1(input jsonb):
--     read-only, SECURITY DEFINER owned by myboon_knowledge_owner, EXECUTE
--     for the two executor roles only. Returns managed entities whose
--     name_key differs from the proposal's key and has trigram similarity
--     >= minSimilarity (bounded to [0.5, 1]), highest first, at most 10.
--     Similarity is computed on name_key (no spaces), per the CTO (#342).
--     The attach/hold decision (0.85 / 0.6 bands, type compatibility, short
--     keys) lives in TypeScript (research-engine/fuzzy-entity-match.ts).
-- Writers are unchanged.

CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA extensions;
CREATE INDEX IF NOT EXISTS managed_entities_name_key_trgm
  ON managed_knowledge_private.entities USING gin (name_key extensions.gin_trgm_ops);

DO $access$
BEGIN
  PERFORM set_config('myboon.migration_had_owner_set',pg_has_role(current_user,'myboon_knowledge_owner','SET')::text,true);
  PERFORM set_config('myboon.migration_had_owner_create',has_schema_privilege('myboon_knowledge_owner','managed_knowledge_private','CREATE')::text,true);
  IF NOT pg_has_role(current_user,'myboon_knowledge_owner','SET') THEN
    EXECUTE format('GRANT myboon_knowledge_owner TO %I WITH INHERIT FALSE, SET TRUE',current_user);
  END IF;
END
$access$;
GRANT CREATE ON SCHEMA managed_knowledge_private TO myboon_knowledge_owner;
-- The definer calls extensions.similarity / the % operator.
GRANT USAGE ON SCHEMA extensions TO myboon_knowledge_owner;
SET LOCAL ROLE myboon_knowledge_owner;

CREATE OR REPLACE FUNCTION managed_knowledge_private.fuzzy_entity_candidates_v1(input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fuzzy$
DECLARE
  proposal_key text;
  min_similarity real;
  result_rows jsonb;
BEGIN
  IF jsonb_typeof(input) IS DISTINCT FROM 'object' OR jsonb_typeof(input->'name') IS DISTINCT FROM 'string'
     OR length(input->>'name') NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'fuzzy entity lookup requires a name of 1-500 characters' USING ERRCODE = '22023';
  END IF;
  min_similarity := greatest(0.5, least(1, coalesce((input->>'minSimilarity')::real, 0.6)));
  proposal_key := managed_knowledge_private.entity_name_key_v1(input->>'name');
  IF proposal_key = '' THEN RETURN jsonb_build_object('nameKey', proposal_key, 'candidates', '[]'::jsonb); END IF;
  SELECT coalesce(jsonb_agg(row_value ORDER BY sim DESC, id), '[]'::jsonb) INTO result_rows
  FROM (
    SELECT entity.id, extensions.similarity(entity.name_key, proposal_key) AS sim,
      jsonb_build_object('id', entity.id, 'name', entity.name, 'slug', entity.slug, 'type', entity.type,
        'aliases', coalesce(entity.aliases, '[]'::jsonb), 'summary', entity.summary, 'status', entity.status,
        'catalogEntityId', entity.catalog_entity_id, 'nameKey', entity.name_key,
        'similarity', round(extensions.similarity(entity.name_key, proposal_key)::numeric, 4)) AS row_value
    FROM managed_knowledge_private.entities AS entity
    -- % uses the GIN index with the session's pg_trgm.similarity_threshold
    -- (default 0.3, below our 0.5 floor); the exact floor is applied below.
    -- No function-level SET: a non-superuser cannot set the placeholder GUC
    -- before pg_trgm is loaded in the session.
    WHERE entity.name_key OPERATOR(extensions.%) proposal_key
      AND entity.name_key <> proposal_key
      AND entity.status IS DISTINCT FROM 'archived'
      AND extensions.similarity(entity.name_key, proposal_key) >= min_similarity
    ORDER BY sim DESC, entity.id
    LIMIT 10
  ) ranked;
  RETURN jsonb_build_object('nameKey', proposal_key, 'candidates', result_rows);
END
$fuzzy$;

REVOKE ALL ON FUNCTION managed_knowledge_private.fuzzy_entity_candidates_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION managed_knowledge_private.fuzzy_entity_candidates_v1(jsonb)
  TO myboon_knowledge_executor, myboon_knowledge_context_executor;
COMMENT ON FUNCTION managed_knowledge_private.fuzzy_entity_candidates_v1(jsonb) IS
  '#342 PR-2: read-only trigram candidates on name_key for article creation dedupe; decision bands live in TypeScript.';

RESET ROLE;
DO $restore$
BEGIN
  IF current_setting('myboon.migration_had_owner_create')='false' THEN
    REVOKE CREATE ON SCHEMA managed_knowledge_private FROM myboon_knowledge_owner;
  END IF;
  IF current_setting('myboon.migration_had_owner_set')='false' THEN
    EXECUTE format('REVOKE SET OPTION FOR myboon_knowledge_owner FROM %I',current_user);
  END IF;
END
$restore$;
