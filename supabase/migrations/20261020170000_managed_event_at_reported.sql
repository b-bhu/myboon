-- #388 (option A, context only): make the managed reader's event_at the REPORTED
-- time, coalesce(article.published_at, item.observed_at), so a scheduled future
-- date that the research step extracted from article text can no longer win the
-- event-desc sort, the keyset cursor, a story's updatedAt or its timeline spot.
-- The article's own event_at stays in context.event_at unchanged, and
-- context.scheduled_at carries it when it sits later than the reported time
-- (jsonb_strip_nulls drops scheduled_at when the CASE yields NULL). The ordering
-- and cursor code is untouched; it follows the projected event_at. No data
-- writes, no new columns, no indexes.
-- Body: section B of 20261019213000_managed_context_read_costs.sql, re-applied
-- verbatim with only these two edits. NOT APPLIED anywhere: needs Bucket's yes
-- (needs-bucket). Rollback path:
-- supabase/rollbacks/20261020170000_managed_event_at_reported.down.sql restores
-- the prior body exactly.

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
      coalesce(article.published_at, item.observed_at) AS event_at
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
        'scheduled_at',CASE WHEN article.event_at > coalesce(article.published_at, item.observed_at) THEN article.event_at END,
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
