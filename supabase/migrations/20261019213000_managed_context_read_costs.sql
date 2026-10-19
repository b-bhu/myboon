-- #336 item 1 (PR A): cut the repeated managed-context read costs (Linglong, Oct 19).
-- Measured in production (read-only): public.read_managed_entity_knowledge_v1
-- projected every column (packet JSON detoast, evidence agg, context) for all
-- 2,409 items before sorting and paging: 4,368 ms for 61 rows. Paging on the
-- narrow order columns first and projecting only the page returns
-- byte-identical rows in 423 ms. The context readers filtered managed entities
-- with a revision digest that returns 'unavailable' only for non-active rows
-- (status is NOT NULL), so digesting 1,107 entity revisions per call is
-- avoidable: probe 286 ms -> 20 ms, one-entity recent history 408 ms -> 13 ms.
-- article_context_v1 gains an optional perEntityLimit (1..10), which requires
-- a non-empty entityIds, so history for several entities loads in one call
-- with per-entity top-5 rows matching the per-entity calls; without the key
-- its output stays byte-identical.
--
-- NOT APPLIED. Needs Bucket's explicit yes (needs-bucket).
-- Rollback: supabase/rollbacks/20261019213000_managed_context_read_costs.down.sql
-- Idempotent: CREATE OR REPLACE only, unchanged signatures, no new grants
-- beyond re-stating the reader's REVOKE/GRANT.
--
-- A. managed_knowledge_private.context_v1 / article_context_v1, owner wrapper
--    as in 20261017120000; bodies are the latest definitions from that
--    migration verbatim, except the marked #336 edits (the WHERE swaps and the
--    optional perEntityLimit batching input described in the header).

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
SET LOCAL ROLE myboon_knowledge_owner;

CREATE OR REPLACE FUNCTION managed_knowledge_private.context_v1(input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $context$
DECLARE entities_json jsonb; items_json jsonb; result jsonb; ids uuid[]; limit_count integer; item_count integer;
BEGIN
  IF NOT (pg_has_role(session_user,'myboon_knowledge_executor','member') OR pg_has_role(session_user,'myboon_knowledge_context_executor','member'))
    OR pg_has_role(session_user,'myboon_knowledge_owner','member') OR pg_has_role(session_user,'service_role','member') OR pg_has_role(session_user,'authenticator','member')
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND (rolsuper OR rolbypassrls))
    OR session_user IN ('authenticator','anon','authenticated','service_role') THEN
    RAISE EXCEPTION 'dedicated managed context login required' USING ERRCODE = '42501';
  END IF;
  IF octet_length(input::text) > 131072 OR jsonb_typeof(input) <> 'object' THEN RAISE EXCEPTION 'bounded context input required' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(input->'labels') <> 'array' OR jsonb_array_length(input->'labels') > 100
    OR jsonb_typeof(input->'sourceRefs') <> 'array' OR jsonb_array_length(input->'sourceRefs') > 32
    OR jsonb_typeof(input->'entityIds') <> 'array' OR jsonb_array_length(input->'entityIds') > 32
    OR jsonb_typeof(input->'itemIds') <> 'array' OR jsonb_array_length(input->'itemIds') > 32 THEN
    RAISE EXCEPTION 'bounded context identities required' USING ERRCODE = '22023';
  END IF;
  limit_count := greatest(1,least(coalesce((input->>'limit')::integer,24),32));
  -- Serializes context capture against accepted writes; snapshots never mix
  -- item state, provenance and revision watermarks from different commits.
  PERFORM pg_advisory_xact_lock(299,4);
  WITH subject_entities AS (
    SELECT DISTINCT membership.entity_id AS id FROM managed_knowledge_private.memberships membership
    JOIN managed_knowledge_private.item_sources item_source ON item_source.item_id = membership.item_id
    JOIN managed_knowledge_private.sources source ON source.work_id = item_source.work_id
    WHERE membership.removed_operation IS NULL AND NOT membership.uncertain AND source.source = input->>'source'
      AND source.source_refs ?| ARRAY(SELECT jsonb_array_elements_text(input->'sourceRefs'))
    UNION SELECT value::uuid FROM jsonb_array_elements_text(input->'entityIds') value
    UNION SELECT membership.entity_id FROM managed_knowledge_private.memberships membership
      WHERE membership.item_id::text IN (SELECT jsonb_array_elements_text(input->'itemIds')) AND membership.removed_operation IS NULL AND NOT membership.uncertain
  ), candidates AS (
    -- #337 PR-A: managed identity comes from the private columns; the catalogue
    -- overlay (and the stale binding) is no longer read back for owned rows.
    SELECT entity.id, jsonb_build_object('id',entity.id,'slug',entity.slug,'name',entity.name,'type',entity.type,'aliases',entity.aliases,
      'summary',entity.summary,'status',entity.status,'show_in_carousel',entity.show_in_carousel,'metadata',entity.metadata,
      'updated_at',entity.updated_at,'catalogEntityId',entity.catalog_entity_id,'identityKey',entity.identity_key,
      'revision',managed_knowledge_private.entity_revision_v1(entity.id)) AS binding
      FROM managed_knowledge_private.entities entity
      -- #336: a revision here reads 'unavailable' only when the row is not active
      -- (status NOT NULL), so the column itself is the same predicate without
      -- the per-row SHA-256 digest.
      WHERE entity.status = 'active'
      AND (entity.id IN (SELECT id FROM subject_entities) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(input->'labels') label WHERE lower(btrim(label)) = lower(btrim(entity.name))
          OR lower(btrim(label)) = lower(btrim(entity.slug))
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(entity.aliases) alias WHERE lower(btrim(alias)) = lower(btrim(label)))
      ))
    UNION ALL
    SELECT entity.id,jsonb_build_object('id',entity.id,'slug',entity.slug,'name',entity.name,'type',entity.type,'aliases',entity.aliases,
      'summary',entity.summary,'status',entity.status,'show_in_carousel',false,'metadata',entity.metadata,
      'created_at',entity.created_at,'updated_at',entity.updated_at,'revision',managed_knowledge_private.entity_revision_v1(entity.id),
      'catalogEntityId',entity.id,'identityKey','catalog:' || entity.id::text)
      FROM public.entities entity WHERE entity.status = 'active' AND NOT EXISTS(SELECT 1 FROM managed_knowledge_private.entities own WHERE own.id = entity.id)
      AND (entity.id IN (SELECT id FROM subject_entities) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(input->'labels') label WHERE lower(btrim(label)) = lower(btrim(entity.name))
          OR lower(btrim(label)) = lower(btrim(entity.slug))
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(entity.aliases) alias WHERE lower(btrim(alias)) = lower(btrim(label)))
      ))
  ) SELECT coalesce(jsonb_agg(binding ORDER BY id),'[]'::jsonb) INTO entities_json FROM (SELECT * FROM candidates ORDER BY id LIMIT 101) bounded;
  ids := ARRAY(SELECT (value->>'id')::uuid FROM jsonb_array_elements(entities_json) value);
  SELECT count(*) INTO item_count FROM managed_knowledge_private.items item
    WHERE item.id::text IN (SELECT jsonb_array_elements_text(input->'itemIds')) OR EXISTS(
      SELECT 1 FROM managed_knowledge_private.memberships membership WHERE membership.item_id = item.id AND membership.entity_id = ANY(ids) AND membership.removed_operation IS NULL AND NOT membership.uncertain);
  SELECT coalesce(jsonb_agg(snapshot ORDER BY observed_at DESC,id),'[]'::jsonb) INTO items_json FROM (
    SELECT item.id,item.observed_at,jsonb_build_object(
      'itemId',item.id,'note',item.note,'status',head.status,'revision','item:' || head.revision::text,'observedAt',item.observed_at,
      'entityIds',coalesce((SELECT jsonb_agg(entity_id ORDER BY entity_id) FROM managed_knowledge_private.memberships WHERE item_id = item.id AND removed_operation IS NULL AND NOT uncertain),'[]'::jsonb),
      'packetRefs',coalesce((SELECT jsonb_agg(packet_id ORDER BY work_id) FROM (SELECT source.work_id,source.packet->>'packetId' AS packet_id FROM managed_knowledge_private.item_sources linkage JOIN managed_knowledge_private.sources source USING(work_id) WHERE linkage.item_id = item.id ORDER BY source.created_at DESC,source.work_id LIMIT 64) refs),'[]'::jsonb),
      'evidenceRefs',coalesce((SELECT jsonb_agg(jsonb_build_object('claimId',claim_id,'evidenceId',evidence_id,'sourceRef',source_ref) ORDER BY work_id,claim_id,evidence_id) FROM (SELECT work_id,claim_id,evidence_id,source_ref FROM managed_knowledge_private.evidence WHERE item_id = item.id ORDER BY work_id,claim_id,evidence_id LIMIT 128) refs),'[]'::jsonb),
      'successorItemIds',coalesce((SELECT jsonb_agg(to_item ORDER BY to_item) FROM managed_knowledge_private.developments WHERE from_item = item.id AND kind IN ('correct','supersede')),'[]'::jsonb)
    ) AS snapshot FROM managed_knowledge_private.items item JOIN managed_knowledge_private.item_heads head ON head.item_id = item.id
    WHERE item.id::text IN (SELECT jsonb_array_elements_text(input->'itemIds')) OR EXISTS(
      SELECT 1 FROM managed_knowledge_private.memberships membership WHERE membership.item_id = item.id AND membership.entity_id = ANY(ids) AND membership.removed_operation IS NULL AND NOT membership.uncertain)
    ORDER BY item.observed_at DESC,item.id LIMIT limit_count
  ) bounded;
  result := jsonb_build_object('entities',entities_json,'items',items_json,'watermark',(SELECT coalesce(max(sequence),0)::text FROM managed_knowledge_private.history),
    'truncated',jsonb_array_length(entities_json) > 32 OR item_count > limit_count OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(items_json) selected WHERE
        (SELECT count(*) FROM managed_knowledge_private.item_sources WHERE item_id = (selected->>'itemId')::uuid) > 64
        OR (SELECT count(*) FROM managed_knowledge_private.evidence WHERE item_id = (selected->>'itemId')::uuid) > 128));
  RETURN result || jsonb_build_object('digest',managed_knowledge_private.digest_v1(result));
END
$context$;

CREATE OR REPLACE FUNCTION managed_knowledge_private.article_context_v1(input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE base jsonb; items jsonb; candidate_entities jsonb; limit_count integer; candidate_truncated boolean; per_entity integer;
BEGIN
  IF NOT (pg_has_role(session_user,'myboon_knowledge_executor','member') OR pg_has_role(session_user,'myboon_knowledge_context_executor','member'))
    OR pg_has_role(session_user,'myboon_knowledge_owner','member') OR pg_has_role(session_user,'service_role','member')
    OR session_user IN ('authenticator','anon','authenticated','service_role') THEN
    RAISE EXCEPTION 'dedicated managed context login required' USING ERRCODE = '42501';
  END IF;
  base := managed_knowledge_private.context_v1(input);
  IF coalesce(input->>'historyMode','targeted') NOT IN ('recent','targeted') THEN
    RAISE EXCEPTION 'invalid article history mode' USING ERRCODE='22023';
  END IF;
  per_entity := (input->>'perEntityLimit')::integer;
  IF per_entity IS NOT NULL AND (per_entity < 1 OR per_entity > 10) THEN
    RAISE EXCEPTION 'invalid per-entity history limit' USING ERRCODE='22023';
  END IF;
  IF per_entity IS NOT NULL AND jsonb_array_length(coalesce(input->'entityIds','[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'per-entity history limit requires entity ids' USING ERRCODE='22023';
  END IF;
  -- The legacy context function intentionally uses exact labels. Article
  -- placement also needs bounded narrative/scope candidates, while still
  -- returning the same complete profile shape for code-owned resolution.
  WITH labels AS (
    SELECT lower(btrim(value)) AS label FROM jsonb_array_elements_text(input->'labels') value
  ), requested_public AS (
    SELECT jsonb_build_object('id',e.id,'slug',e.slug,'name',e.name,'type',e.type,'aliases',e.aliases,'summary',e.summary,
      'status',e.status,'show_in_carousel',false,'metadata',e.metadata,'created_at',e.created_at,'updated_at',e.updated_at,
      'revision',managed_knowledge_private.entity_revision_v1(e.id),'catalogEntityId',e.id,'identityKey','catalog:' || e.id::text) value
    FROM public.entities e WHERE e.status='active' AND e.id::text IN (SELECT jsonb_array_elements_text(input->'entityIds'))
  ), additional AS (
    SELECT jsonb_build_object('id',e.id,'slug',e.slug,'name',e.name,'type',e.type,'aliases',e.aliases,'summary',e.summary,
      'status',e.status,'show_in_carousel',false,'metadata',e.metadata,'created_at',e.created_at,'updated_at',e.updated_at,
      'revision',managed_knowledge_private.entity_revision_v1(e.id),'catalogEntityId',e.id,'identityKey','catalog:' || e.id::text) value
    FROM public.entities e WHERE e.status='active' AND EXISTS (
      SELECT 1 FROM labels l WHERE lower(btrim(e.name))=l.label OR lower(btrim(e.slug))=l.label
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(e.aliases) alias WHERE lower(btrim(alias))=l.label)
        OR (NOT coalesce((input->>'identityOnly')::boolean,false) AND (position(l.label in lower(e.name)) > 0 OR position(l.label in lower(coalesce(e.summary,''))) > 0))
        OR (NOT coalesce((input->>'identityOnly')::boolean,false) AND position(l.label in lower(coalesce(e.metadata::text,''))) > 0)
    )
  ), private_additional AS (
    -- #337 PR-A: managed identity comes from the private columns, not binding.
    SELECT jsonb_build_object('id',p.id,'slug',p.slug,'name',p.name,'type',p.type,'aliases',p.aliases,'summary',p.summary,
      'status',p.status,'show_in_carousel',p.show_in_carousel,'metadata',p.metadata,'updated_at',p.updated_at,
      'catalogEntityId',p.catalog_entity_id,'identityKey',p.identity_key,'revision',managed_knowledge_private.entity_revision_v1(p.id)) value
    -- #336: a revision here reads 'unavailable' only when the row is not active
    -- (status NOT NULL), so the column itself is the same predicate without
    -- the per-row SHA-256 digest.
    FROM managed_knowledge_private.entities p WHERE p.status = 'active' AND EXISTS (
      SELECT 1 FROM labels l WHERE lower(btrim(p.name))=l.label
        OR lower(btrim(p.slug))=l.label
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p.aliases) alias WHERE lower(btrim(alias))=l.label)
        OR (NOT coalesce((input->>'identityOnly')::boolean,false) AND (position(l.label in lower(p.name)) > 0 OR position(l.label in lower(coalesce(p.summary,''))) > 0))
      OR (NOT coalesce((input->>'identityOnly')::boolean,false) AND position(l.label in lower(p.metadata::text)) > 0)
    )
  ), requested_private AS (
    SELECT jsonb_build_object('id',p.id,'slug',p.slug,'name',p.name,'type',p.type,'aliases',p.aliases,'summary',p.summary,
      'status',p.status,'show_in_carousel',p.show_in_carousel,'metadata',p.metadata,'updated_at',p.updated_at,
      'catalogEntityId',p.catalog_entity_id,'identityKey',p.identity_key,'revision',managed_knowledge_private.entity_revision_v1(p.id)) value
    -- #336: a revision here reads 'unavailable' only when the row is not active
    -- (status NOT NULL), so the column itself is the same predicate without
    -- the per-row SHA-256 digest.
    FROM managed_knowledge_private.entities p
    WHERE p.status = 'active'
      AND p.id::text IN (SELECT jsonb_array_elements_text(input->'entityIds'))
  ), candidates AS (
    -- `context_v1` is authoritative for the refreshed public binding. Keep it
    -- ahead of supplementary public/private matches when IDs overlap.
    SELECT value, 0 AS source_rank FROM requested_public
    UNION ALL SELECT value, 1 FROM jsonb_array_elements(base->'entities') value
    UNION ALL SELECT value, 2 FROM additional
    UNION ALL SELECT value, 3 FROM requested_private
    UNION ALL SELECT value, 4 FROM private_additional
  ), deduplicated AS (
    SELECT DISTINCT ON (value->>'id') value
    FROM candidates
    ORDER BY value->>'id', source_rank
  ), ranked_entities AS (
    SELECT value, ((value->>'id') IN (SELECT jsonb_array_elements_text(input->'entityIds'))) requested,
      EXISTS(SELECT 1 FROM labels l WHERE l.label = lower(btrim(value->>'name'))
        OR l.label = lower(btrim(value->>'slug'))
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(value->'aliases','[]'::jsonb)) alias WHERE lower(btrim(alias))=l.label)) exact_match,
      (SELECT count(*) FROM labels l WHERE position(l.label in lower(coalesce(value->>'name',''))) > 0
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(value->'aliases','[]'::jsonb)) alias WHERE position(l.label in lower(alias)) > 0)) name_hits,
      (SELECT count(*) FROM labels l WHERE position(l.label in lower(coalesce(value->>'summary',''))) > 0
        OR position(l.label in lower(coalesce(value->'metadata','{}'::jsonb)::text)) > 0) context_hits
    FROM deduplicated
  ), eligible AS (
    SELECT * FROM ranked_entities WHERE NOT coalesce((input->>'identityOnly')::boolean,false) OR requested OR exact_match
  ), bounded AS (
    SELECT * FROM eligible ORDER BY requested DESC,exact_match DESC,name_hits DESC,context_hits DESC,value->>'id' LIMIT 32
  )
  SELECT coalesce((SELECT jsonb_agg(value ORDER BY requested DESC,exact_match DESC,name_hits DESC,context_hits DESC,value->>'id') FROM bounded),'[]'::jsonb),
    (SELECT count(*) > 32 FROM eligible)
    INTO candidate_entities, candidate_truncated;
  -- The aggregate above intentionally sees every durable-ID-deduplicated
  -- candidate; it cannot reference a CTE from a later PL/pgSQL statement.
  base := base || jsonb_build_object('entities',candidate_entities,
    'candidateTruncated',candidate_truncated,'truncated',(base->>'truncated')::boolean OR candidate_truncated);
  -- Batching: with perEntityLimit the budget is per requested entity instead
  -- of global; context_v1 already bounds entityIds to 32, so at most 320.
  limit_count := CASE WHEN per_entity IS NULL THEN greatest(1,least(coalesce((input->>'limit')::integer,24),32))
    ELSE per_entity * greatest(1, jsonb_array_length(input->'entityIds')) END;
  WITH labels AS (
    SELECT lower(btrim(value)) AS label FROM jsonb_array_elements_text(input->'labels') value
  ), source_refs AS (
    SELECT value AS ref FROM jsonb_array_elements_text(input->'sourceRefs') value
  ), entity_ids AS (
    SELECT (value->>'id')::uuid AS id FROM jsonb_array_elements(base->'entities') value
    WHERE jsonb_array_length(input->'entityIds')=0
      OR value->>'id' IN (SELECT jsonb_array_elements_text(input->'entityIds'))
  ), managed AS (
    SELECT jsonb_build_object('itemId',i.id,'entityId',m.entity_id,'origin','managed','title',coalesce(a.title,i.note),
      'summary',coalesce(a.timeline_summary,i.note),'publishedAt',a.published_at,'eventAt',a.event_at,'observedAt',i.observed_at,
      'catalogEntityId',e.catalog_entity_id,'aliases',e.aliases,'metadata',e.metadata,'revision','item:' || h.revision::text) value
    FROM managed_knowledge_private.memberships m JOIN managed_knowledge_private.items i ON i.id=m.item_id
    JOIN managed_knowledge_private.item_heads h ON h.item_id=i.id JOIN managed_knowledge_private.entities e ON e.id=m.entity_id LEFT JOIN managed_knowledge_private.article_items a ON a.item_id=i.id
    -- #343 PR-B: uncertain memberships are saved but never read back as story history.
    WHERE m.removed_operation IS NULL AND NOT m.uncertain AND h.status='active' AND m.entity_id IN (SELECT id FROM entity_ids) AND (
      coalesce(input->>'historyMode','targeted')='recent'
      OR i.id::text IN (SELECT jsonb_array_elements_text(input->'itemIds'))
      OR EXISTS(SELECT 1 FROM labels l WHERE position(l.label in lower(coalesce(a.title,i.note)))>0 OR position(l.label in lower(coalesce(a.timeline_summary,i.note)))>0)
      OR EXISTS(SELECT 1 FROM managed_knowledge_private.item_sources s JOIN managed_knowledge_private.sources src ON src.work_id=s.work_id WHERE s.item_id=i.id AND (
        src.source_refs ?| ARRAY(SELECT ref FROM source_refs)
        OR src.packet->'article'->>'sourceUrl' IN (SELECT ref FROM source_refs)
        OR src.packet->'sourceSignal'->>'canonicalUrl' IN (SELECT ref FROM source_refs)
      ))
    )
  ), legacy AS (
    SELECT jsonb_build_object('itemId',m.id,'entityId',m.entity_id,'origin','legacy','title',m.title,'summary',m.summary,
      'publishedAt',NULL,'eventAt',m.event_at,'observedAt',m.observed_at,'catalogEntityId',m.entity_id,'aliases',e.aliases,'metadata',e.metadata,
      'revision','legacy:' || managed_knowledge_private.digest_v1(jsonb_build_object('id',m.id,'updatedAt',m.updated_at,'entityId',m.entity_id))) value
    FROM public.entity_memories m JOIN public.entities e ON e.id=m.entity_id WHERE m.entity_id IN (SELECT id FROM entity_ids) AND (
      coalesce(input->>'historyMode','targeted')='recent'
      OR m.id::text IN (SELECT jsonb_array_elements_text(input->'itemIds'))
      OR EXISTS(SELECT 1 FROM labels l WHERE position(l.label in lower(m.title))>0 OR position(l.label in lower(m.summary))>0 OR position(l.label in lower(coalesce(m.body,'')))>0)
      OR m.source_ref_id IN (SELECT ref FROM source_refs)
    )
  ), all_items AS (SELECT value FROM managed UNION ALL SELECT value FROM legacy), ranked AS (
    SELECT value, row_number() OVER (PARTITION BY value->>'entityId'
      ORDER BY coalesce((value->>'eventAt')::timestamptz,(value->>'publishedAt')::timestamptz,(value->>'observedAt')::timestamptz) DESC, value->>'itemId') AS entity_rank
    FROM all_items
  )
  SELECT coalesce(jsonb_agg(value ORDER BY coalesce((value->>'eventAt')::timestamptz,(value->>'publishedAt')::timestamptz,(value->>'observedAt')::timestamptz) DESC,(value->>'itemId')),'[]'::jsonb) INTO items
  FROM (SELECT value FROM ranked WHERE per_entity IS NULL OR entity_rank <= per_entity
    ORDER BY (value->>'itemId') IN (SELECT jsonb_array_elements_text(input->'itemIds')) DESC,
    coalesce((value->>'eventAt')::timestamptz,(value->>'publishedAt')::timestamptz,(value->>'observedAt')::timestamptz) DESC,value->>'itemId' LIMIT limit_count) bounded;
  RETURN base || jsonb_build_object('articleItems',items) || CASE WHEN per_entity IS NOT NULL THEN jsonb_build_object('perEntityLimit',per_entity) ELSE '{}'::jsonb END;
END
$body$;

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

-- B. public.read_managed_entity_knowledge_v1, same signature, attributes,
--    validation, COMMENT and REVOKE/GRANT as in 20261017210000; owner wrapper
--    copied verbatim from that migration. Only the row query changes: it
--    pages on the narrow order columns first (eligible -> filtered -> limited
--    with a row number over the order keys) and projects the legacy
--    entity_memories shape only for the paged rows, which produced
--    byte-identical rows in the measured 423 ms vs 4,368 ms shape.
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

CREATE OR REPLACE FUNCTION public.read_managed_entity_knowledge_v1(
  p_order text,
  p_entity_id uuid DEFAULT NULL,
  p_memory_ids uuid[] DEFAULT NULL,
  p_since timestamptz DEFAULT NULL,
  p_memory_types text[] DEFAULT NULL,
  p_priority_classes text[] DEFAULT NULL,
  p_after_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 101
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $reader$
DECLARE
  result_rows jsonb;
  total_count bigint;
BEGIN
  IF p_order IS NULL OR p_order NOT IN ('observed-desc','updated-asc','id-asc','event-desc') THEN
    RAISE EXCEPTION 'unsupported managed knowledge order' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 101 THEN
    RAISE EXCEPTION 'managed knowledge limit must be between 1 and 101' USING ERRCODE = '22023';
  END IF;
  IF p_order = 'id-asc' AND (p_memory_ids IS NULL OR pg_catalog.cardinality(p_memory_ids) = 0) THEN
    RAISE EXCEPTION 'id-asc requires memory ids' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.cardinality(p_memory_ids) > 100 THEN
    RAISE EXCEPTION 'at most 100 memory ids' USING ERRCODE = '22023';
  END IF;
  IF p_order = 'event-desc' AND p_entity_id IS NULL THEN
    RAISE EXCEPTION 'event-desc requires an entity id' USING ERRCODE = '22023';
  END IF;
  IF (p_after_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'cursor needs both at and id' USING ERRCODE = '22023';
  END IF;

  WITH eligible AS (
    SELECT
      item.id,
      item.work_id,
      item.observed_at,
      item.created_at,
      head.revision,
      source.source,
      membership.entity_id,
      membership.role,
      CASE source.source WHEN 'news' THEN 'news_event' ELSE 'market_signal' END AS memory_type,
      coalesce(article.event_at, article.published_at, item.observed_at) AS event_at
    FROM managed_knowledge_private.items AS item
    JOIN managed_knowledge_private.item_heads AS head ON head.item_id = item.id AND head.status = 'active'
    JOIN managed_knowledge_private.sources AS source ON source.work_id = item.work_id
    JOIN LATERAL (
      SELECT candidate.entity_id, candidate.role
      FROM managed_knowledge_private.memberships AS candidate
      JOIN managed_knowledge_private.entities AS entity ON entity.id = candidate.entity_id AND entity.status = 'active'
      WHERE candidate.item_id = item.id
        AND candidate.removed_operation IS NULL
        AND NOT candidate.uncertain
        AND (p_entity_id IS NULL OR candidate.entity_id = p_entity_id)
      ORDER BY (candidate.role = 'primary') DESC, candidate.entity_id
      LIMIT 1
    ) AS membership ON true
    LEFT JOIN managed_knowledge_private.article_items AS article ON article.item_id = item.id
    WHERE (p_memory_ids IS NULL OR item.id = ANY(p_memory_ids))
      AND (p_entity_id IS NULL OR item.id IN (
        SELECT scoped.item_id FROM managed_knowledge_private.memberships AS scoped WHERE scoped.entity_id = p_entity_id))
      AND (p_since IS NULL OR item.observed_at >= p_since)
      AND p_priority_classes IS NULL
  ), filtered AS (
    SELECT * FROM eligible WHERE p_memory_types IS NULL OR memory_type = ANY(p_memory_types)
  ), limited AS (
    SELECT filtered.*, pg_catalog.row_number() OVER (ORDER BY
      CASE WHEN p_order = 'observed-desc' THEN observed_at END DESC,
      CASE WHEN p_order = 'event-desc' THEN event_at END DESC,
      CASE WHEN p_order = 'updated-asc' THEN created_at END ASC,
      CASE WHEN p_order IN ('observed-desc','event-desc') THEN id END DESC,
      CASE WHEN p_order IN ('updated-asc','id-asc') THEN id END ASC
    ) AS position
    FROM filtered
    WHERE p_after_at IS NULL
      OR p_order = 'id-asc'
      OR (p_order = 'observed-desc' AND (observed_at, id) < (p_after_at, p_after_id))
      OR (p_order = 'updated-asc' AND (created_at, id) > (p_after_at, p_after_id))
      OR (p_order = 'event-desc' AND (event_at, id) < (p_after_at, p_after_id))
    ORDER BY position
    LIMIT p_limit
  )
  SELECT
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id',limited.id,'entity_id',limited.entity_id,'source',limited.source,
      'source_area',CASE limited.source WHEN 'news' THEN 'feed' ELSE 'markets' END,
      'source_type',CASE limited.source WHEN 'news' THEN 'article' ELSE 'market_event' END,
      'source_ref_id',source.packet->>'signalId','source_research_id',source.packet->>'packetId',
      'memory_type',limited.memory_type,
      'title',coalesce(article.title, nullif(pg_catalog.btrim(source.packet->'sourceSignal'->>'title'),''), item.note),
      'summary',coalesce(article.timeline_summary, item.note),
      'body',CASE WHEN article.item_id IS NULL THEN item.note ELSE coalesce(article.body, article.timeline_summary) END,
      'event_at',limited.event_at,'observed_at',limited.observed_at,
      'confidence',NULL,
      'evidence',coalesce((
        SELECT pg_catalog.jsonb_agg(evidence.evidence ORDER BY evidence.work_id, evidence.claim_id, evidence.evidence_id)
        FROM managed_knowledge_private.evidence AS evidence
        WHERE evidence.item_id = limited.id
      ), '[]'::jsonb),
      'mentions','[]'::jsonb,'metrics','{}'::jsonb,
      'context',pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'store','managed_v4',
        'url',coalesce(article.source_url, source.packet->'sourceSignal'->>'canonicalUrl'),
        'source_url',article.source_url,
        'work_id',limited.work_id,
        'packet_id',source.packet->>'packetId',
        'signal_id',source.packet->>'signalId',
        'published_at',article.published_at,
        'event_at',article.event_at,
        'membership_role',limited.role,
        'item_revision',limited.revision
      )),
      'created_at',limited.created_at,'updated_at',limited.created_at
    ) ORDER BY limited.position), '[]'::jsonb),
    CASE WHEN p_order = 'event-desc' THEN (SELECT pg_catalog.count(*) FROM filtered) END
  INTO result_rows, total_count
  FROM limited
  JOIN managed_knowledge_private.items AS item ON item.id = limited.id
  JOIN managed_knowledge_private.sources AS source ON source.work_id = limited.work_id
  LEFT JOIN managed_knowledge_private.article_items AS article ON article.item_id = limited.id;
  RETURN pg_catalog.jsonb_build_object('rows', result_rows, 'totalCount', total_count);
END
$reader$;

COMMENT ON FUNCTION public.read_managed_entity_knowledge_v1(text,uuid,uuid[],timestamptz,text[],text[],timestamptz,uuid,integer)
  IS '#337 PR-C: read-only V4 managed knowledge rows in the entity_memories shape for EntityKnowledgeReader. service_role only.';
REVOKE ALL ON FUNCTION public.read_managed_entity_knowledge_v1(text,uuid,uuid[],timestamptz,text[],text[],timestamptz,uuid,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_managed_entity_knowledge_v1(text,uuid,uuid[],timestamptz,text[],text[],timestamptz,uuid,integer)
  TO service_role;

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
