-- #337 PR-C: one read-only REST path into the V4 managed store for the
-- EntityKnowledgeReader port (stories API, editor-draft, publisher, x-desk).
-- NOT APPLIED. Needs Bucket's explicit yes (needs-bucket).
--
-- Rollback: supabase/rollbacks/20261017210000_managed_entity_knowledge_reader.down.sql.
-- Depends on 20261017093000 (memberships.uncertain) and 20261017120000
-- (managed entities.status).
--
-- The function lives in public so PostgREST can reach it; the private schema
-- stays unexposed. It is owned by myboon_knowledge_owner, the only role the
-- private tables' FORCE RLS policies admit, and only service_role may execute
-- it. It returns rows in the legacy entity_memories column shape the reader
-- port already consumes:
--   - only active items, active entities, and certain, unremoved memberships;
--   - one row per item: the requested entity's membership when p_entity_id
--     is set, otherwise the primary membership (then lowest entity id);
--   - news -> feed/article/news_event, polymarket -> markets/market_event/
--     market_signal, matching the canonical packet adapter;
--   - updated_at is the item's created_at (V4 item prose is immutable);
--   - V4 items carry no priority_class, so a priority filter matches nothing.
-- Idempotent: CREATE OR REPLACE plus explicit grants.

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

  WITH projected AS (
    SELECT
      item.id,
      membership.entity_id,
      source.source,
      CASE source.source WHEN 'news' THEN 'feed' ELSE 'markets' END AS source_area,
      CASE source.source WHEN 'news' THEN 'article' ELSE 'market_event' END AS source_type,
      source.packet->>'signalId' AS source_ref_id,
      source.packet->>'packetId' AS source_research_id,
      CASE source.source WHEN 'news' THEN 'news_event' ELSE 'market_signal' END AS memory_type,
      coalesce(article.title, nullif(pg_catalog.btrim(source.packet->'sourceSignal'->>'title'),''), item.note) AS title,
      coalesce(article.timeline_summary, item.note) AS summary,
      CASE WHEN article.item_id IS NULL THEN item.note ELSE coalesce(article.body, article.timeline_summary) END AS body,
      coalesce(article.event_at, article.published_at, item.observed_at) AS event_at,
      item.observed_at,
      item.created_at,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'store','managed_v4',
        'url',coalesce(article.source_url, source.packet->'sourceSignal'->>'canonicalUrl'),
        'source_url',article.source_url,
        'work_id',item.work_id,
        'packet_id',source.packet->>'packetId',
        'signal_id',source.packet->>'signalId',
        'published_at',article.published_at,
        'event_at',article.event_at,
        'membership_role',membership.role,
        'item_revision',head.revision
      )) AS context,
      coalesce((
        SELECT pg_catalog.jsonb_agg(evidence.evidence ORDER BY evidence.work_id, evidence.claim_id, evidence.evidence_id)
        FROM managed_knowledge_private.evidence AS evidence
        WHERE evidence.item_id = item.id
      ), '[]'::jsonb) AS evidence
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
  ), filtered AS (
    SELECT * FROM projected
    WHERE (p_since IS NULL OR observed_at >= p_since)
      AND (p_memory_types IS NULL OR memory_type = ANY(p_memory_types))
      AND (p_priority_classes IS NULL OR context->>'priority_class' = ANY(p_priority_classes))
  ), page AS (
    SELECT * FROM filtered
    WHERE p_after_at IS NULL
      OR p_order = 'id-asc'
      OR (p_order = 'observed-desc' AND (observed_at, id) < (p_after_at, p_after_id))
      OR (p_order = 'updated-asc' AND (created_at, id) > (p_after_at, p_after_id))
      OR (p_order = 'event-desc' AND (event_at, id) < (p_after_at, p_after_id))
  ), limited AS (
    SELECT page.*, pg_catalog.row_number() OVER (ORDER BY
      CASE WHEN p_order = 'observed-desc' THEN observed_at END DESC,
      CASE WHEN p_order = 'event-desc' THEN event_at END DESC,
      CASE WHEN p_order = 'updated-asc' THEN created_at END ASC,
      CASE WHEN p_order IN ('observed-desc','event-desc') THEN id END DESC,
      CASE WHEN p_order IN ('updated-asc','id-asc') THEN id END ASC
    ) AS position
    FROM page
    ORDER BY position
    LIMIT p_limit
  )
  SELECT
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id',id,'entity_id',entity_id,'source',source,'source_area',source_area,'source_type',source_type,
      'source_ref_id',source_ref_id,'source_research_id',source_research_id,'memory_type',memory_type,
      'title',title,'summary',summary,'body',body,'event_at',event_at,'observed_at',observed_at,
      'confidence',NULL,'evidence',evidence,'mentions','[]'::jsonb,'metrics','{}'::jsonb,'context',context,
      'created_at',created_at,'updated_at',created_at
    ) ORDER BY position), '[]'::jsonb),
    CASE WHEN p_order = 'event-desc' THEN (SELECT pg_catalog.count(*) FROM filtered) END
  INTO result_rows, total_count
  FROM limited;

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
