-- Daily Entity catalogue maintenance.
--
-- The VPS worker scans the complete catalogue, builds compact profiles, and
-- asks Hermes to judge only bounded duplicate candidates. These tables retain
-- the run report, reviewable findings, and eventual reversible operations.
-- No migration-time data rewrite or automatic merge occurs here.

CREATE TABLE public.entity_catalog_maintenance_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('manual', 'scheduled')),
  mode text NOT NULL DEFAULT 'dry_run' CHECK (mode IN ('dry_run', 'apply')),
  scope text NOT NULL DEFAULT 'full_catalog' CHECK (scope IN ('full_catalog', 'incremental')),
  status text NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'completed', 'partial', 'failed')
  ),
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  catalog_count integer NOT NULL DEFAULT 0 CHECK (catalog_count >= 0),
  candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  reviewed_count integer NOT NULL DEFAULT 0 CHECK (reviewed_count >= 0),
  merge_proposal_count integer NOT NULL DEFAULT 0 CHECK (merge_proposal_count >= 0),
  alias_quarantine_count integer NOT NULL DEFAULT 0 CHECK (alias_quarantine_count >= 0),
  uncertain_count integer NOT NULL DEFAULT 0 CHECK (uncertain_count >= 0),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entity_catalog_maintenance_runs_started_idx
  ON public.entity_catalog_maintenance_runs (started_at DESC);

CREATE UNIQUE INDEX entity_catalog_maintenance_one_running_scope_idx
  ON public.entity_catalog_maintenance_runs (scope)
  WHERE status = 'running';

CREATE TABLE public.entity_catalog_maintenance_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.entity_catalog_maintenance_runs(id) ON DELETE CASCADE,
  pair_key text NOT NULL,
  left_entity_id uuid NOT NULL REFERENCES public.entities(id) ON DELETE RESTRICT,
  right_entity_id uuid NOT NULL REFERENCES public.entities(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (
    decision IN ('same_entity', 'different_entities', 'unsure', 'polluted_alias')
  ),
  recommended_action text NOT NULL CHECK (
    recommended_action IN ('merge', 'keep_separate', 'review', 'quarantine_alias')
  ),
  confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  canonical_entity_id uuid REFERENCES public.entities(id) ON DELETE RESTRICT,
  polluted_entity_id uuid REFERENCES public.entities(id) ON DELETE RESTRICT,
  polluted_alias text,
  reason text NOT NULL,
  candidate_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  profile_snapshot jsonb NOT NULL,
  auto_apply_eligible boolean NOT NULL DEFAULT false,
  review_status text NOT NULL DEFAULT 'pending' CHECK (
    review_status IN ('pending', 'approved', 'rejected', 'applied', 'rolled_back')
  ),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (left_entity_id <> right_entity_id),
  CHECK (canonical_entity_id IS NULL OR canonical_entity_id IN (left_entity_id, right_entity_id)),
  CHECK (polluted_entity_id IS NULL OR polluted_entity_id IN (left_entity_id, right_entity_id)),
  CHECK (
    (decision = 'same_entity' AND canonical_entity_id IS NOT NULL)
    OR (decision <> 'same_entity' AND canonical_entity_id IS NULL)
  ),
  CHECK (
    (decision = 'polluted_alias' AND polluted_entity_id IS NOT NULL AND polluted_alias IS NOT NULL)
    OR (decision <> 'polluted_alias' AND polluted_entity_id IS NULL AND polluted_alias IS NULL)
  ),
  UNIQUE (run_id, pair_key)
);

CREATE INDEX entity_catalog_maintenance_findings_review_idx
  ON public.entity_catalog_maintenance_findings (review_status, recommended_action, confidence DESC);

CREATE INDEX entity_catalog_maintenance_findings_entities_idx
  ON public.entity_catalog_maintenance_findings (left_entity_id, right_entity_id, created_at DESC);

CREATE INDEX entity_catalog_maintenance_findings_right_entity_idx
  ON public.entity_catalog_maintenance_findings (right_entity_id, created_at DESC);

CREATE INDEX entity_catalog_maintenance_findings_canonical_entity_idx
  ON public.entity_catalog_maintenance_findings (canonical_entity_id)
  WHERE canonical_entity_id IS NOT NULL;

CREATE INDEX entity_catalog_maintenance_findings_polluted_entity_idx
  ON public.entity_catalog_maintenance_findings (polluted_entity_id)
  WHERE polluted_entity_id IS NOT NULL;

CREATE TABLE public.entity_catalog_maintenance_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES public.entity_catalog_maintenance_findings(id) ON DELETE RESTRICT,
  operation_type text NOT NULL CHECK (operation_type IN ('merge_entities', 'quarantine_alias')),
  status text NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned', 'applying', 'applied', 'failed', 'rolling_back', 'rolled_back')
  ),
  source_entity_id uuid NOT NULL REFERENCES public.entities(id) ON DELETE RESTRICT,
  target_entity_id uuid REFERENCES public.entities(id) ON DELETE RESTRICT,
  manifest jsonb NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb,
  error text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  rolled_back_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (target_entity_id IS NULL OR source_entity_id <> target_entity_id)
);

CREATE UNIQUE INDEX entity_catalog_maintenance_active_operation_idx
  ON public.entity_catalog_maintenance_operations (finding_id)
  WHERE status IN ('planned', 'applying', 'applied', 'rolling_back');

CREATE INDEX entity_catalog_maintenance_operations_finding_idx
  ON public.entity_catalog_maintenance_operations (finding_id);

CREATE INDEX entity_catalog_maintenance_operations_source_entity_idx
  ON public.entity_catalog_maintenance_operations (source_entity_id, created_at DESC);

CREATE INDEX entity_catalog_maintenance_operations_target_entity_idx
  ON public.entity_catalog_maintenance_operations (target_entity_id, created_at DESC)
  WHERE target_entity_id IS NOT NULL;

CREATE TABLE public.entity_redirects (
  source_entity_id uuid PRIMARY KEY REFERENCES public.entities(id) ON DELETE RESTRICT,
  target_entity_id uuid NOT NULL REFERENCES public.entities(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL UNIQUE REFERENCES public.entity_catalog_maintenance_operations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_entity_id <> target_entity_id)
);

CREATE INDEX entity_redirects_target_idx
  ON public.entity_redirects (target_entity_id);

-- One compact row per Entity. Only allowlisted identity fields, aggregate
-- counts, and five recent titles cross the inference boundary. Memory summary,
-- body, evidence, metrics, and arbitrary context are deliberately excluded.
CREATE OR REPLACE FUNCTION public.internal_entity_catalog_profiles_v1(
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
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
  tags text[],
  created_at timestamptz,
  updated_at timestamptz,
  changed_at timestamptz,
  memory_count bigint,
  source_count bigint,
  first_memory_at timestamptz,
  last_memory_at timestamptz,
  recent_memories jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH scoped_entities AS (
    SELECT entity.*
    FROM public.entities AS entity
    WHERE p_after_id IS NULL OR entity.id > p_after_id
    ORDER BY entity.id
    LIMIT least(greatest(COALESCE(p_limit, 500), 1), 1000)
  ),
  ranked_memories AS (
    SELECT
      memory.entity_id,
      memory.title,
      memory.memory_type,
      memory.source,
      memory.observed_at,
      row_number() OVER (
        PARTITION BY memory.entity_id
        ORDER BY memory.observed_at DESC, memory.id DESC
      ) AS recent_rank
    FROM public.entity_memories AS memory
    JOIN scoped_entities AS entity ON entity.id = memory.entity_id
    WHERE memory.entity_id IS NOT NULL
  ),
  memory_stats AS (
    SELECT
      memory.entity_id,
      count(*) AS memory_count,
      count(DISTINCT memory.source) AS source_count,
      min(memory.observed_at) AS first_memory_at,
      max(memory.observed_at) AS last_memory_at,
      max(memory.updated_at) AS last_memory_updated_at
    FROM public.entity_memories AS memory
    JOIN scoped_entities AS entity ON entity.id = memory.entity_id
    WHERE memory.entity_id IS NOT NULL
    GROUP BY memory.entity_id
  ),
  recent AS (
    SELECT
      ranked.entity_id,
      jsonb_agg(
        jsonb_build_object(
          'title', left(ranked.title, 240),
          'memoryType', ranked.memory_type,
          'source', ranked.source,
          'observedAt', ranked.observed_at
        )
        ORDER BY ranked.observed_at DESC
      ) AS recent_memories
    FROM ranked_memories AS ranked
    WHERE ranked.recent_rank <= 5
    GROUP BY ranked.entity_id
  )
  SELECT
    entity.id,
    entity.slug,
    entity.name,
    entity.type,
    entity.aliases,
    left(entity.summary, 600) AS summary,
    entity.status,
    entity.show_in_carousel,
    entity.tags,
    entity.created_at,
    entity.updated_at,
    greatest(entity.updated_at, COALESCE(stats.last_memory_updated_at, entity.updated_at)),
    COALESCE(stats.memory_count, 0),
    COALESCE(stats.source_count, 0),
    stats.first_memory_at,
    stats.last_memory_at,
    COALESCE(recent.recent_memories, '[]'::jsonb)
  FROM scoped_entities AS entity
  LEFT JOIN memory_stats AS stats ON stats.entity_id = entity.id
  LEFT JOIN recent ON recent.entity_id = entity.id
  ORDER BY entity.id;
$$;

-- An approved polluted-alias finding is the only mutation supported in the
-- first release. It is small, atomic, and exactly reversible. Entity merges
-- remain plan-only until memory identities and local draft inventory have
-- both been supplied and reviewed.
CREATE OR REPLACE FUNCTION public.entity_catalog_quarantine_alias_v1(
  p_finding_id uuid,
  p_actor text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  finding public.entity_catalog_maintenance_findings%ROWTYPE;
  polluted public.entities%ROWTYPE;
  counterpart public.entities%ROWTYPE;
  next_aliases jsonb;
  operation_id uuid;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'actor is required';
  END IF;

  SELECT * INTO finding
  FROM public.entity_catalog_maintenance_findings
  WHERE id = p_finding_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finding not found'; END IF;
  IF finding.decision <> 'polluted_alias' OR finding.recommended_action <> 'quarantine_alias' THEN
    RAISE EXCEPTION 'finding is not a polluted-alias quarantine';
  END IF;
  IF finding.review_status <> 'approved' THEN
    RAISE EXCEPTION 'polluted-alias quarantine requires explicit approval';
  END IF;

  SELECT * INTO polluted
  FROM public.entities
  WHERE id = finding.polluted_entity_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'polluted entity not found'; END IF;

  SELECT * INTO counterpart
  FROM public.entities
  WHERE id = CASE
    WHEN finding.left_entity_id = finding.polluted_entity_id THEN finding.right_entity_id
    ELSE finding.left_entity_id
  END;
  IF NOT FOUND THEN RAISE EXCEPTION 'counterpart entity not found'; END IF;

  IF lower(btrim(finding.polluted_alias)) IN (lower(btrim(polluted.name)), lower(btrim(polluted.slug))) THEN
    RAISE EXCEPTION 'cannot quarantine an Entity canonical identity';
  END IF;
  IF NOT (
    lower(btrim(finding.polluted_alias)) = lower(btrim(counterpart.name))
    OR lower(regexp_replace(btrim(finding.polluted_alias), '[^a-zA-Z0-9]+', '-', 'g')) = lower(btrim(counterpart.slug))
  ) THEN
    RAISE EXCEPTION 'polluted alias is not anchored to the counterpart canonical identity';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(polluted.aliases) AS alias(value)
    WHERE lower(btrim(alias.value)) = lower(btrim(finding.polluted_alias))
  ) THEN
    RAISE EXCEPTION 'polluted alias is no longer present';
  END IF;

  SELECT COALESCE(jsonb_agg(alias.value ORDER BY alias.ordinality), '[]'::jsonb)
  INTO next_aliases
  FROM jsonb_array_elements_text(polluted.aliases) WITH ORDINALITY AS alias(value, ordinality)
  WHERE lower(btrim(alias.value)) <> lower(btrim(finding.polluted_alias));

  INSERT INTO public.entity_catalog_maintenance_operations (
    finding_id,
    operation_type,
    status,
    source_entity_id,
    target_entity_id,
    manifest,
    before_state,
    created_by
  ) VALUES (
    finding.id,
    'quarantine_alias',
    'applying',
    polluted.id,
    counterpart.id,
    jsonb_build_object(
      'schemaVersion', 'myboon.entity_catalog_alias_quarantine.v1',
      'alias', finding.polluted_alias,
      'findingId', finding.id
    ),
    jsonb_build_object('aliases', polluted.aliases, 'updatedAt', polluted.updated_at),
    btrim(p_actor)
  )
  RETURNING id INTO operation_id;

  UPDATE public.entities
  SET aliases = next_aliases, updated_at = now()
  WHERE id = polluted.id;

  UPDATE public.entity_catalog_maintenance_operations
  SET
    status = 'applied',
    after_state = jsonb_build_object('aliases', next_aliases),
    applied_at = now(),
    updated_at = now()
  WHERE id = operation_id;

  UPDATE public.entity_catalog_maintenance_findings
  SET review_status = 'applied', updated_at = now()
  WHERE id = finding.id;

  RETURN operation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.entity_catalog_rollback_alias_quarantine_v1(
  p_operation_id uuid,
  p_actor text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  operation public.entity_catalog_maintenance_operations%ROWTYPE;
  entity public.entities%ROWTYPE;
  before_aliases jsonb;
  expected_aliases jsonb;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'actor is required';
  END IF;

  SELECT * INTO operation
  FROM public.entity_catalog_maintenance_operations
  WHERE id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation not found'; END IF;
  IF operation.operation_type <> 'quarantine_alias' OR operation.status <> 'applied' THEN
    RAISE EXCEPTION 'operation is not an applied alias quarantine';
  END IF;

  SELECT * INTO entity
  FROM public.entities
  WHERE id = operation.source_entity_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation Entity not found'; END IF;

  before_aliases := operation.before_state->'aliases';
  expected_aliases := operation.after_state->'aliases';
  IF before_aliases IS NULL OR expected_aliases IS NULL THEN
    RAISE EXCEPTION 'operation alias snapshots are incomplete';
  END IF;
  IF entity.aliases <> expected_aliases THEN
    RAISE EXCEPTION 'Entity aliases changed after this operation; rollback requires review';
  END IF;

  UPDATE public.entity_catalog_maintenance_operations
  SET status = 'rolling_back', updated_at = now()
  WHERE id = operation.id;

  UPDATE public.entities
  SET aliases = before_aliases, updated_at = now()
  WHERE id = entity.id;

  UPDATE public.entity_catalog_maintenance_operations
  SET
    status = 'rolled_back',
    manifest = manifest || jsonb_build_object('rolledBackBy', btrim(p_actor)),
    rolled_back_at = now(),
    updated_at = now()
  WHERE id = operation.id;

  UPDATE public.entity_catalog_maintenance_findings
  SET review_status = 'rolled_back', updated_at = now()
  WHERE id = operation.finding_id;

  RETURN operation.id;
END;
$$;

-- Produces the exact database-side inventory required for a future merge,
-- but deliberately marks the plan ineligible to apply. The missing pieces are
-- explicit: local unpublished-draft inventory and per-memory replacement
-- identity keys. A model decision cannot bypass either requirement.
CREATE OR REPLACE FUNCTION public.entity_catalog_prepare_merge_v1(
  p_finding_id uuid,
  p_actor text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  finding public.entity_catalog_maintenance_findings%ROWTYPE;
  source_entity public.entities%ROWTYPE;
  target_entity public.entities%ROWTYPE;
  source_entity_id uuid;
  memory_manifest jsonb;
  narrative_manifest jsonb;
  history_manifest jsonb;
  operation_id uuid;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'actor is required';
  END IF;

  SELECT * INTO finding
  FROM public.entity_catalog_maintenance_findings
  WHERE id = p_finding_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finding not found'; END IF;
  IF finding.decision <> 'same_entity' OR finding.recommended_action <> 'merge' THEN
    RAISE EXCEPTION 'finding is not an Entity merge';
  END IF;
  IF finding.review_status <> 'approved' THEN
    RAISE EXCEPTION 'Entity merge planning requires explicit approval';
  END IF;

  source_entity_id := CASE
    WHEN finding.left_entity_id = finding.canonical_entity_id THEN finding.right_entity_id
    ELSE finding.left_entity_id
  END;

  -- Lock in stable ID order before taking the snapshots.
  PERFORM id
  FROM public.entities
  WHERE id IN (source_entity_id, finding.canonical_entity_id)
  ORDER BY id
  FOR UPDATE;

  SELECT * INTO source_entity FROM public.entities WHERE id = source_entity_id;
  SELECT * INTO target_entity FROM public.entities WHERE id = finding.canonical_entity_id;
  IF source_entity.id IS NULL OR target_entity.id IS NULL THEN
    RAISE EXCEPTION 'merge Entity is missing';
  END IF;
  IF source_entity.status <> 'active' OR target_entity.status <> 'active' THEN
    RAISE EXCEPTION 'merge planning requires two active Entities';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', memory.id,
      'memoryIdentityKey', memory.memory_identity_key,
      'source', memory.source,
      'sourceArea', memory.source_area,
      'sourceResearchId', memory.source_research_id,
      'canonicalSourceItemId', memory.context->>'canonical_source_item_id'
    ) ORDER BY memory.id
  ), '[]'::jsonb)
  INTO memory_manifest
  FROM public.entity_memories AS memory
  WHERE memory.entity_id = source_entity.id;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', narrative.id,
      'entityId', narrative.entity_id,
      'sourceMemoryIds', narrative.source_memory_ids
    ) ORDER BY narrative.id
  ), '[]'::jsonb)
  INTO narrative_manifest
  FROM public.published_narratives AS narrative
  WHERE narrative.entity_id = source_entity.id
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements_text(narrative.source_memory_ids) AS source_memory(memory_id)
       JOIN public.entity_memories AS memory ON memory.id::text = source_memory.memory_id
       WHERE memory.entity_id = source_entity.id
     );

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', history.id,
      'entityId', history.entity_id,
      'publishedNarrativeId', history.published_narrative_id
    ) ORDER BY history.id
  ), '[]'::jsonb)
  INTO history_manifest
  FROM public.entity_published_history AS history
  WHERE history.entity_id = source_entity.id
     OR history.published_narrative_id IN (
       SELECT (narrative->>'id')::uuid
       FROM jsonb_array_elements(narrative_manifest) AS narrative
     );

  INSERT INTO public.entity_catalog_maintenance_operations (
    finding_id,
    operation_type,
    status,
    source_entity_id,
    target_entity_id,
    manifest,
    before_state,
    created_by
  ) VALUES (
    finding.id,
    'merge_entities',
    'planned',
    source_entity.id,
    target_entity.id,
    jsonb_build_object(
      'schemaVersion', 'myboon.entity_catalog_merge_manifest.v1',
      'memories', memory_manifest,
      'publishedNarratives', narrative_manifest,
      'publishedHistory', history_manifest,
      'draftInventoryComplete', false,
      'memoryIdentityKeysRewritten', false,
      'applyEligible', false
    ),
    jsonb_build_object(
      'sourceEntity', jsonb_build_object(
        'id', source_entity.id,
        'slug', source_entity.slug,
        'name', source_entity.name,
        'type', source_entity.type,
        'aliases', source_entity.aliases,
        'status', source_entity.status,
        'updatedAt', source_entity.updated_at
      ),
      'targetEntity', jsonb_build_object(
        'id', target_entity.id,
        'slug', target_entity.slug,
        'name', target_entity.name,
        'type', target_entity.type,
        'aliases', target_entity.aliases,
        'status', target_entity.status,
        'updatedAt', target_entity.updated_at
      )
    ),
    btrim(p_actor)
  )
  RETURNING id INTO operation_id;

  RETURN operation_id;
END;
$$;

ALTER TABLE public.entity_catalog_maintenance_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_catalog_maintenance_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_catalog_maintenance_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_redirects ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.entity_catalog_maintenance_runs FROM anon, authenticated;
REVOKE ALL ON TABLE public.entity_catalog_maintenance_findings FROM anon, authenticated;
REVOKE ALL ON TABLE public.entity_catalog_maintenance_operations FROM anon, authenticated;
REVOKE ALL ON TABLE public.entity_redirects FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.internal_entity_catalog_profiles_v1(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entity_catalog_quarantine_alias_v1(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entity_catalog_rollback_alias_quarantine_v1(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entity_catalog_prepare_merge_v1(uuid, text) FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.entity_catalog_maintenance_runs TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.entity_catalog_maintenance_findings TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.entity_catalog_maintenance_operations TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.entity_redirects TO service_role;
GRANT EXECUTE ON FUNCTION public.internal_entity_catalog_profiles_v1(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.entity_catalog_quarantine_alias_v1(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.entity_catalog_rollback_alias_quarantine_v1(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.entity_catalog_prepare_merge_v1(uuid, text) TO service_role;

COMMENT ON TABLE public.entity_catalog_maintenance_runs IS
  'Auditable full or incremental Entity catalogue maintenance runs.';
COMMENT ON TABLE public.entity_catalog_maintenance_findings IS
  'Hermes identity judgments plus deterministic safety eligibility; findings are review state, not mutations.';
COMMENT ON TABLE public.entity_catalog_maintenance_operations IS
  'Reversible Entity mutation manifests. No operation is created by a dry run.';
COMMENT ON TABLE public.entity_redirects IS
  'Durable old Entity ID to canonical Entity ID redirects; source rows are never deleted.';
COMMENT ON FUNCTION public.internal_entity_catalog_profiles_v1(uuid, integer) IS
  'Service-role-only compact Entity identity profiles for catalogue maintenance; excludes memory bodies and arbitrary context.';
