-- Guarded automatic Entity catalogue cleanup.
--
-- The model may propose a cleanup, but it cannot mutate the catalogue on its
-- own.  These functions re-check current Entity identity, the persisted
-- profile snapshot, deterministic eligibility, and all affected rows while
-- holding row locks.  Merged Entities are archived (never deleted), every
-- operation carries an exact rollback manifest, and old IDs receive a durable
-- redirect.

CREATE OR REPLACE FUNCTION public.resolve_entity_redirect_v1(p_entity_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (
      SELECT redirect.target_entity_id
      FROM public.entity_redirects AS redirect
      JOIN public.entities AS target ON target.id = redirect.target_entity_id
      WHERE redirect.source_entity_id = p_entity_id
        AND target.status = 'active'
    ),
    p_entity_id
  );
$$;

-- Canonical identity lookup resolves every archived source label through its
-- redirect.  Writers therefore see only the active target even when a stale
-- packet still carries the old UUID, slug, name, or alias.
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
  WITH matching_entities AS (
    SELECT entity.id
    FROM public.entities AS entity
    WHERE entity.status = 'active'
      AND (
        lower(entity.slug) IN (
          SELECT lower(label) FROM unnest(COALESCE(p_slugs, ARRAY[]::text[])) AS label
        )
        OR lower(entity.name) IN (
          SELECT lower(label)
          FROM unnest(COALESCE(p_names, ARRAY[]::text[]) || COALESCE(p_aliases, ARRAY[]::text[])) AS label
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(entity.aliases) AS entity_alias(label)
          WHERE lower(entity_alias.label) IN (
            SELECT lower(input_label)
            FROM unnest(COALESCE(p_names, ARRAY[]::text[]) || COALESCE(p_aliases, ARRAY[]::text[])) AS input_label
          )
        )
      )
    UNION
    SELECT redirect.target_entity_id
    FROM public.entities AS source
    JOIN public.entity_redirects AS redirect ON redirect.source_entity_id = source.id
    JOIN public.entities AS target ON target.id = redirect.target_entity_id AND target.status = 'active'
    WHERE
      lower(source.slug) IN (
        SELECT lower(label) FROM unnest(COALESCE(p_slugs, ARRAY[]::text[])) AS label
      )
      OR lower(source.name) IN (
        SELECT lower(label)
        FROM unnest(COALESCE(p_names, ARRAY[]::text[]) || COALESCE(p_aliases, ARRAY[]::text[])) AS label
      )
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(source.aliases) AS source_alias(label)
        WHERE lower(source_alias.label) IN (
          SELECT lower(input_label)
          FROM unnest(COALESCE(p_names, ARRAY[]::text[]) || COALESCE(p_aliases, ARRAY[]::text[])) AS input_label
        )
      )
  ), matches AS (
    SELECT entity.*
    FROM public.entities AS entity
    JOIN matching_entities AS matched ON matched.id = entity.id
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

CREATE OR REPLACE FUNCTION public.entity_catalog_apply_eligible_alias_v1(
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
  polluted_snapshot jsonb;
  counterpart_snapshot jsonb;
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
  IF finding.decision <> 'polluted_alias'
     OR finding.recommended_action <> 'quarantine_alias'
     OR finding.review_status <> 'pending'
     OR NOT finding.auto_apply_eligible
     OR finding.confidence < 0.90 THEN
    RAISE EXCEPTION 'finding is not eligible for automatic alias quarantine';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(finding.candidate_signals) AS signal(value)
    WHERE signal.value->>'kind' = 'name_alias'
      AND lower(regexp_replace(btrim(signal.value->>'label'), '[^a-zA-Z0-9]+', ' ', 'g'))
          = lower(regexp_replace(btrim(finding.polluted_alias), '[^a-zA-Z0-9]+', ' ', 'g'))
  ) THEN
    RAISE EXCEPTION 'automatic alias quarantine requires a canonical-name-to-alias signal';
  END IF;

  -- Lock both Entities in stable ID order before validating the snapshots.
  PERFORM id
  FROM public.entities
  WHERE id IN (finding.left_entity_id, finding.right_entity_id)
  ORDER BY id
  FOR UPDATE;

  SELECT * INTO polluted
  FROM public.entities
  WHERE id = finding.polluted_entity_id;
  SELECT * INTO counterpart
  FROM public.entities
  WHERE id = CASE
    WHEN finding.left_entity_id = finding.polluted_entity_id THEN finding.right_entity_id
    ELSE finding.left_entity_id
  END;
  IF polluted.id IS NULL OR counterpart.id IS NULL THEN
    RAISE EXCEPTION 'alias finding Entity is missing';
  END IF;

  polluted_snapshot := CASE
    WHEN finding.left_entity_id = polluted.id THEN finding.profile_snapshot->'left'
    ELSE finding.profile_snapshot->'right'
  END;
  counterpart_snapshot := CASE
    WHEN finding.left_entity_id = counterpart.id THEN finding.profile_snapshot->'left'
    ELSE finding.profile_snapshot->'right'
  END;
  IF jsonb_typeof(polluted_snapshot) IS DISTINCT FROM 'object'
     OR jsonb_typeof(counterpart_snapshot) IS DISTINCT FROM 'object'
     OR jsonb_typeof(polluted_snapshot->'aliases') IS DISTINCT FROM 'array'
     OR jsonb_typeof(counterpart_snapshot->'aliases') IS DISTINCT FROM 'array'
     OR polluted.name IS DISTINCT FROM (polluted_snapshot->>'name')
     OR polluted.slug IS DISTINCT FROM (polluted_snapshot->>'slug')
     OR polluted.type IS DISTINCT FROM (polluted_snapshot->>'type')
     OR polluted.status IS DISTINCT FROM (polluted_snapshot->>'status')
     OR polluted.aliases IS DISTINCT FROM (polluted_snapshot->'aliases')
     OR counterpart.name IS DISTINCT FROM (counterpart_snapshot->>'name')
     OR counterpart.slug IS DISTINCT FROM (counterpart_snapshot->>'slug')
     OR counterpart.type IS DISTINCT FROM (counterpart_snapshot->>'type')
     OR counterpart.status IS DISTINCT FROM (counterpart_snapshot->>'status')
     OR counterpart.aliases IS DISTINCT FROM (counterpart_snapshot->'aliases') THEN
    RAISE EXCEPTION 'Entity identity changed after the finding; rerun maintenance';
  END IF;
  IF polluted.status <> 'active' OR counterpart.status <> 'active'
     OR polluted.show_in_carousel OR counterpart.show_in_carousel THEN
    RAISE EXCEPTION 'automatic alias quarantine requires two non-carousel active Entities';
  END IF;
  IF lower(btrim(polluted.type)) = lower(btrim(counterpart.type)) THEN
    RAISE EXCEPTION 'automatic alias quarantine requires distinct Entity types';
  END IF;
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
    finding_id, operation_type, status, source_entity_id, target_entity_id,
    manifest, before_state, created_by
  ) VALUES (
    finding.id, 'quarantine_alias', 'applying', polluted.id, counterpart.id,
    jsonb_build_object(
      'schemaVersion', 'myboon.entity_catalog_alias_quarantine.v1',
      'alias', finding.polluted_alias,
      'findingId', finding.id,
      'automatic', true
    ),
    jsonb_build_object('aliases', polluted.aliases, 'updatedAt', polluted.updated_at),
    btrim(p_actor)
  )
  RETURNING id INTO operation_id;

  UPDATE public.entities
  SET aliases = next_aliases, updated_at = now()
  WHERE id = polluted.id;

  UPDATE public.entity_catalog_maintenance_operations
  SET status = 'applied',
      after_state = jsonb_build_object('aliases', next_aliases),
      applied_at = now(), updated_at = now()
  WHERE id = operation_id;

  UPDATE public.entity_catalog_maintenance_findings
  SET review_status = 'applied', reviewed_by = btrim(p_actor),
      reviewed_at = now(), updated_at = now()
  WHERE id = finding.id;

  RETURN operation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.entity_catalog_apply_merge_v1(
  p_finding_id uuid,
  p_actor text,
  p_aliases_to_add jsonb DEFAULT '[]'::jsonb
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
  source_snapshot jsonb;
  target_snapshot jsonb;
  requested_aliases jsonb;
  next_target_aliases jsonb;
  memory_manifest jsonb;
  narrative_manifest jsonb;
  history_manifest jsonb;
  merge_manifest jsonb;
  merge_before_state jsonb;
  operation_id uuid;
  memory_count integer;
  narrative_count integer;
  history_count integer;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'actor is required';
  END IF;
  IF p_aliases_to_add IS NULL OR jsonb_typeof(p_aliases_to_add) <> 'array' THEN
    RAISE EXCEPTION 'aliases_to_add must be a JSON array';
  END IF;
  IF jsonb_array_length(p_aliases_to_add) > 50 THEN
    RAISE EXCEPTION 'aliases_to_add exceeds the 50-alias limit';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_aliases_to_add) AS alias(value)
    WHERE jsonb_typeof(alias.value) <> 'string'
       OR length(btrim(alias.value #>> '{}')) NOT BETWEEN 1 AND 500
  ) THEN
    RAISE EXCEPTION 'aliases_to_add contains an invalid alias';
  END IF;

  SELECT * INTO finding
  FROM public.entity_catalog_maintenance_findings
  WHERE id = p_finding_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finding not found'; END IF;
  IF finding.decision <> 'same_entity' OR finding.recommended_action <> 'merge' THEN
    RAISE EXCEPTION 'finding is not an Entity merge';
  END IF;
  IF finding.review_status NOT IN ('pending', 'approved') THEN
    RAISE EXCEPTION 'Entity merge finding is no longer actionable';
  END IF;
  IF finding.review_status <> 'approved' AND NOT (
    finding.auto_apply_eligible
    AND finding.confidence >= 0.995
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(finding.candidate_signals) AS signal(value)
      WHERE signal.value->>'kind' = 'exact_name'
    )
  ) THEN
    RAISE EXCEPTION 'Entity merge requires approval or deterministic automatic eligibility';
  END IF;

  source_entity_id := CASE
    WHEN finding.left_entity_id = finding.canonical_entity_id THEN finding.right_entity_id
    ELSE finding.left_entity_id
  END;

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
  source_snapshot := CASE
    WHEN finding.left_entity_id = source_entity.id THEN finding.profile_snapshot->'left'
    ELSE finding.profile_snapshot->'right'
  END;
  target_snapshot := CASE
    WHEN finding.left_entity_id = target_entity.id THEN finding.profile_snapshot->'left'
    ELSE finding.profile_snapshot->'right'
  END;
  IF jsonb_typeof(source_snapshot) IS DISTINCT FROM 'object'
     OR jsonb_typeof(target_snapshot) IS DISTINCT FROM 'object'
     OR jsonb_typeof(source_snapshot->'aliases') IS DISTINCT FROM 'array'
     OR jsonb_typeof(target_snapshot->'aliases') IS DISTINCT FROM 'array'
     OR source_entity.name IS DISTINCT FROM (source_snapshot->>'name')
     OR source_entity.slug IS DISTINCT FROM (source_snapshot->>'slug')
     OR source_entity.type IS DISTINCT FROM (source_snapshot->>'type')
     OR source_entity.status IS DISTINCT FROM (source_snapshot->>'status')
     OR source_entity.aliases IS DISTINCT FROM (source_snapshot->'aliases')
     OR target_entity.name IS DISTINCT FROM (target_snapshot->>'name')
     OR target_entity.slug IS DISTINCT FROM (target_snapshot->>'slug')
     OR target_entity.type IS DISTINCT FROM (target_snapshot->>'type')
     OR target_entity.status IS DISTINCT FROM (target_snapshot->>'status')
     -- Another already-applied duplicate may have added lookup aliases to the
     -- same canonical target after this finding. Additions are safe; removals
     -- still make the snapshot stale and fail closed.
     OR (target_entity.aliases @> (target_snapshot->'aliases')) IS NOT TRUE THEN
    RAISE EXCEPTION 'Entity identity changed after the finding; rerun maintenance';
  END IF;
  IF source_entity.status <> 'active' OR target_entity.status <> 'active' THEN
    RAISE EXCEPTION 'Entity merge requires two active Entities';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.entity_redirects AS redirect
    WHERE redirect.source_entity_id IN (source_entity.id, target_entity.id)
       OR redirect.target_entity_id = source_entity.id
  ) THEN
    RAISE EXCEPTION 'Entity merge does not permit redirect chains';
  END IF;
  IF finding.review_status <> 'approved' AND (
    lower(btrim(source_entity.type)) <> lower(btrim(target_entity.type))
    OR source_entity.show_in_carousel OR target_entity.show_in_carousel
  ) THEN
    RAISE EXCEPTION 'automatic merge requires matching types and non-carousel Entities';
  END IF;

  -- Canonical memory identity is one source item/packet plus Entity. If both
  -- Entities already hold the same scope, moving the source would preserve
  -- two old identity keys under one target. Fail closed instead of silently
  -- creating a duplicate or deleting either memory.
  IF EXISTS (
    SELECT 1
    FROM public.entity_memories AS source_memory
    JOIN public.entity_memories AS target_memory
      ON target_memory.entity_id = target_entity.id
     AND target_memory.source = source_memory.source
     AND target_memory.source_area = source_memory.source_area
     AND CASE
       WHEN source_memory.source = 'news' THEN COALESCE(
         NULLIF(target_memory.context->>'canonical_source_item_id', ''),
         'packet:' || target_memory.source_research_id
       )
       ELSE 'packet:' || target_memory.source_research_id
     END = CASE
       WHEN source_memory.source = 'news' THEN COALESCE(
         NULLIF(source_memory.context->>'canonical_source_item_id', ''),
         'packet:' || source_memory.source_research_id
       )
       ELSE 'packet:' || source_memory.source_research_id
     END
    WHERE source_memory.entity_id = source_entity.id
  ) THEN
    RAISE EXCEPTION 'Entity merge has a canonical memory-scope conflict; consolidation is required';
  END IF;

  -- Every durable reference moved by this operation must be wholly owned by
  -- the source Entity. Cross-Entity references need a bespoke consolidation,
  -- otherwise an exact rollback could split a narrative from its memories.
  IF EXISTS (
    SELECT 1
    FROM public.published_narratives AS narrative
    WHERE narrative.entity_id IS DISTINCT FROM source_entity.id
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(narrative.source_memory_ids) AS source_memory(memory_id)
        JOIN public.entity_memories AS memory ON memory.id::text = source_memory.memory_id
        WHERE memory.entity_id = source_entity.id
      )
  ) THEN
    RAISE EXCEPTION 'Entity merge has an external narrative dependency; consolidation is required';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.entity_published_history AS history
    JOIN public.published_narratives AS narrative
      ON narrative.id = history.published_narrative_id
    WHERE narrative.entity_id = source_entity.id
      AND history.entity_id IS DISTINCT FROM source_entity.id
  ) THEN
    RAISE EXCEPTION 'Entity merge has an external published-history dependency; consolidation is required';
  END IF;

  -- Preserve every label that resolved to the source before the merge. This
  -- keeps stale packets groundable after redirect resolution; dropping an
  -- alias here would make the redirect discoverable but unusable downstream.
  -- Alias removal remains a separate, explicitly approved operation.
  requested_aliases := jsonb_build_array(source_entity.name, source_entity.slug)
    || source_entity.aliases
    || p_aliases_to_add;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(p_aliases_to_add) AS requested(value)
    WHERE lower(btrim(requested.value)) NOT IN (lower(btrim(source_entity.name)), lower(btrim(source_entity.slug)))
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(source_entity.aliases) AS existing(value)
        WHERE lower(btrim(existing.value)) = lower(btrim(requested.value))
      )
  ) THEN
    RAISE EXCEPTION 'aliases_to_add must come from the source Entity snapshot';
  END IF;

  WITH ordered_aliases AS (
    SELECT value, ordinality
    FROM jsonb_array_elements_text(target_entity.aliases || requested_aliases)
      WITH ORDINALITY AS alias(value, ordinality)
    WHERE btrim(value) <> ''
  ), unique_aliases AS (
    SELECT DISTINCT ON (lower(btrim(value))) value, ordinality
    FROM ordered_aliases
    ORDER BY lower(btrim(value)), ordinality
  )
  SELECT COALESCE(jsonb_agg(value ORDER BY ordinality), '[]'::jsonb)
  INTO next_target_aliases
  FROM unique_aliases;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', memory.id,
    'entityId', memory.entity_id,
    'memoryIdentityKey', memory.memory_identity_key,
    'source', memory.source,
    'sourceArea', memory.source_area,
    'sourceResearchId', memory.source_research_id,
    'canonicalSourceItemId', memory.context->>'canonical_source_item_id'
  ) ORDER BY memory.id), '[]'::jsonb), count(*)
  INTO memory_manifest, memory_count
  FROM public.entity_memories AS memory
  WHERE memory.entity_id = source_entity.id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', narrative.id,
    'entityId', narrative.entity_id,
    'entitySlug', narrative.entity_slug,
    'entityName', narrative.entity_name,
    'entityType', narrative.entity_type
  ) ORDER BY narrative.id), '[]'::jsonb), count(*)
  INTO narrative_manifest, narrative_count
  FROM public.published_narratives AS narrative
  WHERE narrative.entity_id = source_entity.id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', history.id,
    'entityId', history.entity_id,
    'entitySlug', history.entity_slug
  ) ORDER BY history.id), '[]'::jsonb), count(*)
  INTO history_manifest, history_count
  FROM public.entity_published_history AS history
  WHERE history.entity_id = source_entity.id;

  merge_manifest := jsonb_build_object(
    'schemaVersion', 'myboon.entity_catalog_merge_manifest.v2',
    'findingId', finding.id,
    'automatic', finding.review_status <> 'approved',
    'memories', memory_manifest,
    'publishedNarratives', narrative_manifest,
    'publishedHistory', history_manifest,
    'counts', jsonb_build_object(
      'memories', memory_count,
      'publishedNarratives', narrative_count,
      'publishedHistory', history_count
    )
  );
  merge_before_state := jsonb_build_object(
    'sourceEntity', to_jsonb(source_entity),
    'targetEntity', to_jsonb(target_entity)
  );

  -- Promote an existing reviewed plan when present. This keeps the normal
  -- approve -> prepare -> apply workflow compatible with the one-active-
  -- operation-per-finding constraint.
  SELECT id INTO operation_id
  FROM public.entity_catalog_maintenance_operations
  WHERE finding_id = finding.id
    AND operation_type = 'merge_entities'
    AND status = 'planned'
  FOR UPDATE;

  IF operation_id IS NULL THEN
    INSERT INTO public.entity_catalog_maintenance_operations (
      finding_id, operation_type, status, source_entity_id, target_entity_id,
      manifest, before_state, created_by
    ) VALUES (
      finding.id, 'merge_entities', 'applying', source_entity.id, target_entity.id,
      merge_manifest, merge_before_state, btrim(p_actor)
    )
    RETURNING id INTO operation_id;
  ELSE
    UPDATE public.entity_catalog_maintenance_operations
    SET status = 'applying',
        source_entity_id = source_entity.id,
        target_entity_id = target_entity.id,
        manifest = merge_manifest,
        before_state = merge_before_state,
        after_state = NULL,
        error = NULL,
        created_by = btrim(p_actor),
        updated_at = now()
    WHERE id = operation_id;
  END IF;

  UPDATE public.entity_memories
  SET entity_id = target_entity.id, updated_at = now()
  WHERE entity_id = source_entity.id;

  UPDATE public.published_narratives
  SET entity_id = target_entity.id,
      entity_slug = target_entity.slug,
      entity_name = target_entity.name,
      entity_type = target_entity.type
  WHERE entity_id = source_entity.id;

  UPDATE public.entity_published_history
  SET entity_id = target_entity.id, entity_slug = target_entity.slug
  WHERE entity_id = source_entity.id;

  UPDATE public.entities
  SET aliases = next_target_aliases, updated_at = now()
  WHERE id = target_entity.id;

  UPDATE public.entities
  SET status = 'archived', show_in_carousel = false,
      metadata = metadata || jsonb_build_object(
        'merged_into_entity_id', target_entity.id,
        'entity_catalog_merge_operation_id', operation_id,
        'entity_catalog_merged_at', now()
      ),
      updated_at = now()
  WHERE id = source_entity.id;

  INSERT INTO public.entity_redirects (source_entity_id, target_entity_id, operation_id)
  VALUES (source_entity.id, target_entity.id, operation_id);

  UPDATE public.entity_catalog_maintenance_operations
  SET status = 'applied',
      after_state = jsonb_build_object(
        'sourceStatus', 'archived',
        'targetAliases', next_target_aliases,
        'memoryCount', memory_count,
        'publishedNarrativeCount', narrative_count,
        'publishedHistoryCount', history_count
      ),
      applied_at = now(), updated_at = now()
  WHERE id = operation_id;

  UPDATE public.entity_catalog_maintenance_findings
  SET review_status = 'applied', reviewed_by = btrim(p_actor),
      reviewed_at = now(), updated_at = now()
  WHERE id = finding.id;

  RETURN operation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.entity_catalog_rollback_merge_v1(
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
  source_entity public.entities%ROWTYPE;
  target_entity public.entities%ROWTYPE;
  source_before jsonb;
  target_before jsonb;
  memory_manifest jsonb;
  narrative_manifest jsonb;
  history_manifest jsonb;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'actor is required';
  END IF;
  SELECT * INTO operation
  FROM public.entity_catalog_maintenance_operations
  WHERE id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation not found'; END IF;
  IF operation.operation_type <> 'merge_entities' OR operation.status <> 'applied' THEN
    RAISE EXCEPTION 'operation is not an applied Entity merge';
  END IF;

  PERFORM id
  FROM public.entities
  WHERE id IN (operation.source_entity_id, operation.target_entity_id)
  ORDER BY id
  FOR UPDATE;
  SELECT * INTO source_entity FROM public.entities WHERE id = operation.source_entity_id;
  SELECT * INTO target_entity FROM public.entities WHERE id = operation.target_entity_id;
  IF source_entity.id IS NULL OR target_entity.id IS NULL THEN
    RAISE EXCEPTION 'merge Entity is missing';
  END IF;

  source_before := operation.before_state->'sourceEntity';
  target_before := operation.before_state->'targetEntity';
  memory_manifest := operation.manifest->'memories';
  narrative_manifest := operation.manifest->'publishedNarratives';
  history_manifest := operation.manifest->'publishedHistory';
  IF jsonb_typeof(source_before) IS DISTINCT FROM 'object'
     OR jsonb_typeof(target_before) IS DISTINCT FROM 'object'
     OR jsonb_typeof(memory_manifest) IS DISTINCT FROM 'array'
     OR jsonb_typeof(narrative_manifest) IS DISTINCT FROM 'array'
     OR jsonb_typeof(history_manifest) IS DISTINCT FROM 'array'
     OR jsonb_typeof(operation.after_state) IS DISTINCT FROM 'object'
     OR jsonb_typeof(operation.after_state->'targetAliases') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'merge rollback manifest is incomplete';
  END IF;
  IF source_entity.status <> 'archived'
     OR source_entity.metadata->>'entity_catalog_merge_operation_id' IS DISTINCT FROM operation.id::text
     OR target_entity.aliases IS DISTINCT FROM (operation.after_state->'targetAliases') THEN
    RAISE EXCEPTION 'Entity state changed after this merge; rollback requires review';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.entity_redirects
    WHERE source_entity_id = source_entity.id
      AND target_entity_id = target_entity.id
      AND operation_id = operation.id
  ) THEN
    RAISE EXCEPTION 'merge redirect is missing or changed';
  END IF;

  -- Lock every dependency named by the manifest before validating it. No
  -- concurrent publisher or memory writer can change these rows between the
  -- strict checks and the reversal updates below.
  PERFORM memory.id
  FROM public.entity_memories AS memory
  JOIN jsonb_array_elements(memory_manifest) AS item(value)
    ON memory.id = (item.value->>'id')::uuid
  ORDER BY memory.id
  FOR UPDATE;
  PERFORM narrative.id
  FROM public.published_narratives AS narrative
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(narrative_manifest) AS item(value)
    WHERE narrative.id = (item.value->>'id')::uuid
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(narrative.source_memory_ids) AS source_memory(memory_id)
    JOIN jsonb_array_elements(memory_manifest) AS item(value)
      ON source_memory.memory_id = item.value->>'id'
  )
  ORDER BY narrative.id
  FOR UPDATE;
  PERFORM history.id
  FROM public.entity_published_history AS history
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(history_manifest) AS item(value)
    WHERE history.id = (item.value->>'id')::uuid
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(narrative_manifest) AS item(value)
    WHERE history.published_narrative_id = (item.value->>'id')::uuid
  )
  ORDER BY history.id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(memory_manifest) AS item(value)
    LEFT JOIN public.entity_memories AS memory ON memory.id = (item.value->>'id')::uuid
    WHERE memory.id IS NULL OR memory.entity_id IS DISTINCT FROM target_entity.id
  ) THEN
    RAISE EXCEPTION 'a moved memory changed after this merge; rollback requires review';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.published_narratives AS narrative
    WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(narrative_manifest) AS item(value)
        WHERE narrative.id = (item.value->>'id')::uuid
      )
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(narrative.source_memory_ids) AS source_memory(memory_id)
        JOIN jsonb_array_elements(memory_manifest) AS item(value)
          ON source_memory.memory_id = item.value->>'id'
      )
  ) THEN
    RAISE EXCEPTION 'a new narrative depends on a moved memory; rollback requires review';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(narrative_manifest) AS item(value)
    LEFT JOIN public.published_narratives AS narrative ON narrative.id = (item.value->>'id')::uuid
    WHERE narrative.id IS NULL
       OR narrative.entity_id IS DISTINCT FROM target_entity.id
       OR narrative.entity_slug IS DISTINCT FROM target_entity.slug
       OR narrative.entity_name IS DISTINCT FROM target_entity.name
       OR narrative.entity_type IS DISTINCT FROM target_entity.type
  ) THEN
    RAISE EXCEPTION 'a moved published narrative changed after this merge; rollback requires review';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(history_manifest) AS item(value)
    LEFT JOIN public.entity_published_history AS history ON history.id = (item.value->>'id')::uuid
    WHERE history.id IS NULL
       OR history.entity_id IS DISTINCT FROM target_entity.id
       OR history.entity_slug IS DISTINCT FROM target_entity.slug
  ) THEN
    RAISE EXCEPTION 'a moved published-history row changed after this merge; rollback requires review';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.entity_published_history AS history
    WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(history_manifest) AS item(value)
        WHERE history.id = (item.value->>'id')::uuid
      )
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(narrative_manifest) AS item(value)
        WHERE history.published_narrative_id = (item.value->>'id')::uuid
      )
  ) THEN
    RAISE EXCEPTION 'a new published-history row depends on a moved narrative; rollback requires review';
  END IF;

  UPDATE public.entity_catalog_maintenance_operations
  SET status = 'rolling_back', updated_at = now()
  WHERE id = operation.id;

  DELETE FROM public.entity_redirects WHERE operation_id = operation.id;

  -- Restore the source first so the active-Entity write fence below permits
  -- the dependency moves. Any later failure still rolls back this transaction.
  UPDATE public.entities
  SET status = source_before->>'status',
      show_in_carousel = COALESCE((source_before->>'show_in_carousel')::boolean, false),
      metadata = source_before->'metadata',
      aliases = source_before->'aliases',
      updated_at = now()
  WHERE id = source_entity.id;

  UPDATE public.entity_memories AS memory
  SET entity_id = source_entity.id, updated_at = now()
  FROM jsonb_array_elements(memory_manifest) AS item(value)
  WHERE memory.id = (item.value->>'id')::uuid;

  UPDATE public.published_narratives AS narrative
  SET entity_id = NULLIF(item.value->>'entityId', '')::uuid,
      entity_slug = item.value->>'entitySlug',
      entity_name = item.value->>'entityName',
      entity_type = item.value->>'entityType'
  FROM jsonb_array_elements(narrative_manifest) AS item(value)
  WHERE narrative.id = (item.value->>'id')::uuid;

  UPDATE public.entity_published_history AS history
  SET entity_id = NULLIF(item.value->>'entityId', '')::uuid,
      entity_slug = item.value->>'entitySlug'
  FROM jsonb_array_elements(history_manifest) AS item(value)
  WHERE history.id = (item.value->>'id')::uuid;

  UPDATE public.entities
  SET aliases = target_before->'aliases', updated_at = now()
  WHERE id = target_entity.id;

  UPDATE public.entity_catalog_maintenance_operations
  SET status = 'rolled_back',
      manifest = manifest || jsonb_build_object('rolledBackBy', btrim(p_actor)),
      rolled_back_at = now(), updated_at = now()
  WHERE id = operation.id;

  UPDATE public.entity_catalog_maintenance_findings
  SET review_status = 'rolled_back', updated_at = now()
  WHERE id = operation.finding_id;

  RETURN operation.id;
END;
$$;

-- Redirects are deliberately one hop. Serialize graph writes so concurrent or
-- direct service-role mutations cannot create A -> B -> C chains that the
-- runtime resolver would be unable to follow.
CREATE OR REPLACE FUNCTION public.entity_redirect_single_hop_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(61301, 1);

  IF EXISTS (
    SELECT 1 FROM public.entity_redirects AS redirect
    WHERE redirect.target_entity_id = NEW.source_entity_id
  ) THEN
    RAISE EXCEPTION 'redirect source already has an incoming redirect';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.entity_redirects AS redirect
    WHERE redirect.source_entity_id = NEW.target_entity_id
  ) THEN
    RAISE EXCEPTION 'redirect target already has an outgoing redirect';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_redirect_single_hop_guard
  ON public.entity_redirects;
CREATE TRIGGER entity_redirect_single_hop_guard
BEFORE INSERT OR UPDATE OF source_entity_id, target_entity_id
ON public.entity_redirects
FOR EACH ROW
EXECUTE FUNCTION public.entity_redirect_single_hop_guard_v1();

-- A writer and a merge synchronize on the same Entity row. If the writer gets
-- the key-share lock first, the merge waits and includes the new dependency in
-- its manifest. If the merge wins, the writer wakes after archival and gets a
-- retryable failure instead of attaching fresh data to an archived Entity.
CREATE OR REPLACE FUNCTION public.entity_reference_requires_active_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  entity_status text;
BEGIN
  IF NEW.entity_id IS NULL THEN RETURN NEW; END IF;

  SELECT entity.status INTO entity_status
  FROM public.entities AS entity
  WHERE entity.id = NEW.entity_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'referenced Entity does not exist'
      USING ERRCODE = '23503';
  END IF;
  IF entity_status <> 'active' THEN
    RAISE EXCEPTION 'referenced Entity is no longer active; resolve its redirect and retry'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_memories_active_entity_guard
  ON public.entity_memories;
CREATE TRIGGER entity_memories_active_entity_guard
BEFORE INSERT OR UPDATE OF entity_id ON public.entity_memories
FOR EACH ROW EXECUTE FUNCTION public.entity_reference_requires_active_v1();

DROP TRIGGER IF EXISTS published_narratives_active_entity_guard
  ON public.published_narratives;
CREATE TRIGGER published_narratives_active_entity_guard
BEFORE INSERT OR UPDATE OF entity_id ON public.published_narratives
FOR EACH ROW EXECUTE FUNCTION public.entity_reference_requires_active_v1();

DROP TRIGGER IF EXISTS entity_published_history_active_entity_guard
  ON public.entity_published_history;
CREATE TRIGGER entity_published_history_active_entity_guard
BEFORE INSERT OR UPDATE OF entity_id ON public.entity_published_history
FOR EACH ROW EXECUTE FUNCTION public.entity_reference_requires_active_v1();

REVOKE ALL ON FUNCTION public.entity_catalog_apply_eligible_alias_v1(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entity_catalog_apply_merge_v1(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entity_catalog_rollback_merge_v1(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_entity_redirect_v1(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entity_manager_lookup_entities_v1(text[], text[], text[], integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entity_redirect_single_hop_guard_v1()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.entity_reference_requires_active_v1()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.entity_catalog_apply_merge_v1(uuid, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.entity_catalog_rollback_merge_v1(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_entity_redirect_v1(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.entity_manager_lookup_entities_v1(text[], text[], text[], integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.entity_redirect_single_hop_guard_v1()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.entity_reference_requires_active_v1()
  TO service_role;
GRANT DELETE ON TABLE public.entity_redirects TO service_role;

COMMENT ON FUNCTION public.entity_catalog_apply_eligible_alias_v1(uuid, text) IS
  'Disabled for application roles: alias meaning is contextual and requires explicit operator review.';
COMMENT ON FUNCTION public.entity_catalog_apply_merge_v1(uuid, text, jsonb) IS
  'Atomically archives a duplicate Entity, moves its durable references, and records a redirect plus rollback manifest.';
COMMENT ON FUNCTION public.entity_catalog_rollback_merge_v1(uuid, text) IS
  'Strict rollback for an unchanged applied Entity merge; refuses rollback after dependent state diverges.';
COMMENT ON FUNCTION public.entity_redirect_single_hop_guard_v1() IS
  'Serializes redirect writes and rejects chains so runtime resolution stays one hop.';
COMMENT ON FUNCTION public.entity_reference_requires_active_v1() IS
  'Synchronizes dependency writes with Entity merges and rejects stale archived Entity references.';
