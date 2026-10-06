-- Rank article candidates before the existing bound and separate exact identity
-- coverage from broad story/history truncation. Existing history and permissions
-- stay intact; only the internal named context function is replaced.
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

CREATE OR REPLACE FUNCTION managed_knowledge_private.article_context_v1(input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE base jsonb; items jsonb; candidate_entities jsonb; limit_count integer; candidate_truncated boolean;
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
    SELECT p.binding || jsonb_build_object('id',p.id,'revision',managed_knowledge_private.entity_revision_v1(p.id),
      'catalogEntityId',p.catalog_entity_id,'identityKey',p.identity_key) value
    FROM managed_knowledge_private.entities p WHERE managed_knowledge_private.entity_revision_v1(p.id) <> 'unavailable' AND EXISTS (
      SELECT 1 FROM labels l WHERE lower(btrim(coalesce(p.binding->>'name','')))=l.label
        OR lower(btrim(coalesce(p.binding->>'slug','')))=l.label
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p.binding->'aliases','[]'::jsonb)) alias WHERE lower(btrim(alias))=l.label)
        OR (NOT coalesce((input->>'identityOnly')::boolean,false) AND (position(l.label in lower(coalesce(p.binding->>'name',''))) > 0 OR position(l.label in lower(coalesce(p.binding->>'summary',''))) > 0))
      OR (NOT coalesce((input->>'identityOnly')::boolean,false) AND position(l.label in lower(coalesce(p.binding->'metadata','{}'::jsonb)::text)) > 0)
    )
  ), requested_private AS (
    SELECT p.binding || jsonb_build_object('id',p.id,'revision',managed_knowledge_private.entity_revision_v1(p.id),
      'catalogEntityId',p.catalog_entity_id,'identityKey',p.identity_key) value
    FROM managed_knowledge_private.entities p
    WHERE managed_knowledge_private.entity_revision_v1(p.id) <> 'unavailable'
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
  limit_count := greatest(1,least(coalesce((input->>'limit')::integer,24),32));
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
      'catalogEntityId',e.catalog_entity_id,'aliases',e.binding->'aliases','metadata',e.binding->'metadata','revision','item:' || h.revision::text) value
    FROM managed_knowledge_private.memberships m JOIN managed_knowledge_private.items i ON i.id=m.item_id
    JOIN managed_knowledge_private.item_heads h ON h.item_id=i.id JOIN managed_knowledge_private.entities e ON e.id=m.entity_id LEFT JOIN managed_knowledge_private.article_items a ON a.item_id=i.id
    WHERE m.removed_operation IS NULL AND h.status='active' AND m.entity_id IN (SELECT id FROM entity_ids) AND (
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
  ), all_items AS (SELECT value FROM managed UNION ALL SELECT value FROM legacy)
  SELECT coalesce(jsonb_agg(value ORDER BY coalesce((value->>'eventAt')::timestamptz,(value->>'publishedAt')::timestamptz,(value->>'observedAt')::timestamptz) DESC,(value->>'itemId')),'[]'::jsonb) INTO items
  FROM (SELECT value FROM all_items ORDER BY (value->>'itemId') IN (SELECT jsonb_array_elements_text(input->'itemIds')) DESC,
    coalesce((value->>'eventAt')::timestamptz,(value->>'publishedAt')::timestamptz,(value->>'observedAt')::timestamptz) DESC,value->>'itemId' LIMIT limit_count) bounded;
  RETURN base || jsonb_build_object('articleItems',items);
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
