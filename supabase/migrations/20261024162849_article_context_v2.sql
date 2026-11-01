-- #420/#418 follow-up: article_context_v1, current version v3 (dedup on narrow keys; v2 = key-only join-back). The #420 rewrite (v1, 20261020130000,
-- never merged, applied to prod then rolled back) ranked history candidates on
-- narrow keys first, but its history CTE joined the picked rows back AND
-- re-applied every filter predicate (entity_ids IN, historyMode/itemIds/labels
-- position() on title/summary/body, sourceRefs EXISTS). With hash/seq plans the
-- planner then ran a SECOND full scan of public.entity_memories (and the managed
-- membership/items chain) evaluating the label position() predicates all over
-- again during the join-back, doubling the scan cost. Measured locally with
-- enable_nestloop=off: entity_memories seq-scanned twice (~2.3s each). v2 keeps
-- the narrow-key ranking and picks exactly as v1 and joins the picked rows back
-- by key only (memberships (item_id,entity_id) PK, items/item_heads/article_items
-- item_id PK, entities/entity_memories id PK), so the duplicate full scan is gone
-- and the returned rows are identical.
-- #418 v3: candidate branches narrow to (id, source_rank, ord); ranking reads a slim jsonb, and the wide jsonb + revision are rebuilt only for the 32 returned entities; returned entities unchanged.
--
-- NOT APPLIED. Needs Bucket's explicit yes (needs-bucket). Supersedes the
-- unmerged 20261020130000_article_context_spill.sql (v1); only the candidate dedup, the history CTE
-- and the picked materialization differ from v1.
-- Rollback: supabase/rollbacks/20261020200000_article_context_v2.down.sql
--   (restores the 20261019213000 article_context_v1 body that is live on prod).
-- Idempotent: CREATE OR REPLACE only, unchanged signature, no new grants.
-- Only managed_knowledge_private.article_context_v1 changes here; context_v1
-- and every other function keep their 20261019213000 definitions.

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

SET LOCAL lock_timeout = '5s';

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
    SELECT e.id::text AS id, 0::bigint AS ord
    FROM public.entities e WHERE e.status='active' AND e.id::text IN (SELECT jsonb_array_elements_text(input->'entityIds'))
  ), additional AS (
    SELECT e.id::text AS id, 0::bigint AS ord
    FROM public.entities e WHERE e.status='active' AND EXISTS (
      SELECT 1 FROM labels l WHERE lower(btrim(e.name))=l.label OR lower(btrim(e.slug))=l.label
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(e.aliases) alias WHERE lower(btrim(alias))=l.label)
        OR (NOT coalesce((input->>'identityOnly')::boolean,false) AND (position(l.label in lower(e.name)) > 0 OR position(l.label in lower(coalesce(e.summary,''))) > 0))
        OR (NOT coalesce((input->>'identityOnly')::boolean,false) AND position(l.label in lower(coalesce(e.metadata::text,''))) > 0)
    )
  ), private_additional AS (
    SELECT p.id::text AS id, 0::bigint AS ord
    FROM managed_knowledge_private.entities p WHERE p.status = 'active' AND EXISTS (
      SELECT 1 FROM labels l WHERE lower(btrim(p.name))=l.label
        OR lower(btrim(p.slug))=l.label
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p.aliases) alias WHERE lower(btrim(alias))=l.label)
        OR (NOT coalesce((input->>'identityOnly')::boolean,false) AND (position(l.label in lower(p.name)) > 0 OR position(l.label in lower(coalesce(p.summary,''))) > 0))
      OR (NOT coalesce((input->>'identityOnly')::boolean,false) AND position(l.label in lower(p.metadata::text)) > 0)
    )
  ), requested_private AS (
    SELECT p.id::text AS id, 0::bigint AS ord
    FROM managed_knowledge_private.entities p
    WHERE p.status = 'active'
      AND p.id::text IN (SELECT jsonb_array_elements_text(input->'entityIds'))
  ), candidates AS (
    -- #418 v3: the branches above are narrowed to (id, source_rank, ord) so the
    -- dedup below sorts narrow keys only, and rank_source keeps the winners
    -- slim (only the keys the ranking reads). Before, every branch built the
    -- full wide jsonb row (metadata, aliases, summary and the per-row revision
    -- digest) for every match and DISTINCT ON sorted those wide rows; the
    -- doubly referenced eligible (bounded + truncation count) materialized
    -- them, so short labels like "us" match thousands of rows by substring
    -- and spilled at work_mem=4MB. bounded_values rebuilds the wide jsonb row
    -- and revision only for the 32 returned entities; results are
    -- byte-identical.
    -- `context_v1` is authoritative for the refreshed public binding. Keep it
    -- ahead of supplementary public/private matches when IDs overlap.
    SELECT id, 0 AS source_rank, ord FROM requested_public
    UNION ALL SELECT value->>'id', 1, ordinality FROM jsonb_array_elements(base->'entities') WITH ORDINALITY AS t(value, ordinality)
    UNION ALL SELECT id, 2, ord FROM additional
    UNION ALL SELECT id, 3, ord FROM requested_private
    UNION ALL SELECT id, 4, ord FROM private_additional
  ), deduplicated AS (
    SELECT DISTINCT ON (id) id, source_rank, ord FROM candidates
    ORDER BY id, source_rank, ord
  ), rank_source AS (
    -- Ranks 0 and 2 built identical public rows today and ranks 3 and 4
    -- identical private rows, so each key-joined rebuild below covers both
    -- ranks; the base branch copies its picked element back by ordinality.
    -- Slim ranking rows: only the keys ranked_entities reads; the full wide
    -- row and the revision digest are rebuilt in bounded_values for the 32
    -- returned entities.
    SELECT d.id, d.source_rank, d.ord,
      jsonb_build_object('id',e.id,'name',e.name,'slug',e.slug,'aliases',e.aliases,'summary',e.summary,'metadata',e.metadata) value
    FROM deduplicated d JOIN public.entities e ON e.id::text = d.id
    WHERE d.source_rank IN (0,2)
    UNION ALL
    SELECT d.id, d.source_rank, d.ord, (base->'entities')->(d.ord - 1)::integer value
    FROM deduplicated d
    WHERE d.source_rank = 1
    UNION ALL
    SELECT d.id, d.source_rank, d.ord,
      jsonb_build_object('id',p.id,'name',p.name,'slug',p.slug,'aliases',p.aliases,'summary',p.summary,'metadata',p.metadata) value
    FROM deduplicated d JOIN managed_knowledge_private.entities p ON p.id::text = d.id
    WHERE d.source_rank IN (3,4)
  ), ranked_entities AS (
    SELECT id, source_rank, ord, ((value->>'id') IN (SELECT jsonb_array_elements_text(input->'entityIds'))) requested,
      EXISTS(SELECT 1 FROM labels l WHERE l.label = lower(btrim(value->>'name'))
        OR l.label = lower(btrim(value->>'slug'))
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(value->'aliases','[]'::jsonb)) alias WHERE lower(btrim(alias))=l.label)) exact_match,
      (SELECT count(*) FROM labels l WHERE position(l.label in lower(coalesce(value->>'name',''))) > 0
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(value->'aliases','[]'::jsonb)) alias WHERE position(l.label in lower(alias)) > 0)) name_hits,
      (SELECT count(*) FROM labels l WHERE position(l.label in lower(coalesce(value->>'summary',''))) > 0
        OR position(l.label in lower(coalesce(value->'metadata','{}'::jsonb)::text)) > 0) context_hits
    FROM rank_source
  ), eligible AS (
    SELECT * FROM ranked_entities WHERE NOT coalesce((input->>'identityOnly')::boolean,false) OR requested OR exact_match
  ), bounded AS (
    SELECT * FROM eligible ORDER BY requested DESC,exact_match DESC,name_hits DESC,context_hits DESC,id LIMIT 32
  ), bounded_values AS (
    -- Same three branches as rank_source, but the full wide jsonb row and the
    -- per-row revision digest are built only for the 32 returned entities.
    SELECT jsonb_build_object('id',e.id,'slug',e.slug,'name',e.name,'type',e.type,'aliases',e.aliases,'summary',e.summary,
      'status',e.status,'show_in_carousel',false,'metadata',e.metadata,'created_at',e.created_at,'updated_at',e.updated_at,
      'revision',managed_knowledge_private.entity_revision_v1(e.id),'catalogEntityId',e.id,'identityKey','catalog:' || e.id::text) value,
      b.requested, b.exact_match, b.name_hits, b.context_hits, b.id
    FROM bounded b JOIN public.entities e ON e.id::text = b.id
    WHERE b.source_rank IN (0,2)
    UNION ALL
    SELECT (base->'entities')->(b.ord - 1)::integer value,
      b.requested, b.exact_match, b.name_hits, b.context_hits, b.id
    FROM bounded b
    WHERE b.source_rank = 1
    UNION ALL
    -- #337 PR-A: managed identity comes from the private columns, not binding.
    SELECT jsonb_build_object('id',p.id,'slug',p.slug,'name',p.name,'type',p.type,'aliases',p.aliases,'summary',p.summary,
      'status',p.status,'show_in_carousel',p.show_in_carousel,'metadata',p.metadata,'updated_at',p.updated_at,
      'catalogEntityId',p.catalog_entity_id,'identityKey',p.identity_key,'revision',managed_knowledge_private.entity_revision_v1(p.id)) value,
      b.requested, b.exact_match, b.name_hits, b.context_hits, b.id
    -- #336: a revision here reads 'unavailable' only when the row is not active
    -- (status NOT NULL), so the column itself is the same predicate without
    -- the per-row SHA-256 digest.
    FROM bounded b JOIN managed_knowledge_private.entities p ON p.id::text = b.id
    WHERE b.source_rank IN (3,4)
  )
  SELECT coalesce((SELECT jsonb_agg(value ORDER BY requested DESC,exact_match DESC,name_hits DESC,context_hits DESC,id) FROM bounded_values),'[]'::jsonb),
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
  -- #418: the history block ranks candidates on the narrow keys only
  -- (origin, item id, entity id, sort_at from the raw timestamptz columns)
  -- and projects the full jsonb row -- including the digest_v1 legacy
  -- revision -- for the picked rows alone, with the same per-entity rank,
  -- pick order and final aggregate order as before. v2: the history CTE
  -- joins the picked rows back by key only (every filter predicate was
  -- already applied when ranking), so the planner scans the base tables
  -- once per branch instead of also running the label/sourceRef predicates
  -- over a second full scan during the join-back.
  WITH labels AS (
    SELECT lower(btrim(value)) AS label FROM jsonb_array_elements_text(input->'labels') value
  ), source_refs AS (
    SELECT value AS ref FROM jsonb_array_elements_text(input->'sourceRefs') value
  ), entity_ids AS (
    SELECT (value->>'id')::uuid AS id FROM jsonb_array_elements(base->'entities') value
    WHERE jsonb_array_length(input->'entityIds')=0
      OR value->>'id' IN (SELECT jsonb_array_elements_text(input->'entityIds'))
  ), narrow AS (
    SELECT 'managed'::text AS origin, m.item_id, m.entity_id,
      coalesce(a.event_at, a.published_at, i.observed_at) AS sort_at
    FROM managed_knowledge_private.memberships m JOIN managed_knowledge_private.items i ON i.id=m.item_id
    JOIN managed_knowledge_private.item_heads h ON h.item_id=i.id
    LEFT JOIN managed_knowledge_private.article_items a ON a.item_id=i.id
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
    UNION ALL
    SELECT 'legacy'::text, m.id, m.entity_id, coalesce(m.event_at, NULL::timestamptz, m.observed_at)
    FROM public.entity_memories m WHERE m.entity_id IN (SELECT id FROM entity_ids) AND (
      coalesce(input->>'historyMode','targeted')='recent'
      OR m.id::text IN (SELECT jsonb_array_elements_text(input->'itemIds'))
      OR EXISTS(SELECT 1 FROM labels l WHERE position(l.label in lower(m.title))>0 OR position(l.label in lower(m.summary))>0 OR position(l.label in lower(coalesce(m.body,'')))>0)
      OR m.source_ref_id IN (SELECT ref FROM source_refs)
    )
  ), ranked AS (
    SELECT item_id, entity_id, origin, sort_at, row_number() OVER (PARTITION BY entity_id::text
      ORDER BY sort_at DESC, item_id::text) AS entity_rank
    FROM narrow
  ), picked AS MATERIALIZED (
    SELECT origin, item_id, entity_id, sort_at FROM ranked WHERE per_entity IS NULL OR entity_rank <= per_entity
    ORDER BY (item_id::text) IN (SELECT jsonb_array_elements_text(input->'itemIds')) DESC,
    sort_at DESC, item_id::text, entity_id::text LIMIT limit_count
  ), history AS (
    -- v2 join-back by key only: picked rows already satisfy every predicate,
    -- and each join is a PK match, so the projected rows are the v1 rows.
    SELECT picked.sort_at, picked.item_id, picked.entity_id,
      jsonb_build_object('itemId',i.id,'entityId',m.entity_id,'origin','managed','title',coalesce(a.title,i.note),
        'summary',coalesce(a.timeline_summary,i.note),'publishedAt',a.published_at,'eventAt',a.event_at,'observedAt',i.observed_at,
        'catalogEntityId',e.catalog_entity_id,'aliases',e.aliases,'metadata',e.metadata,'revision','item:' || h.revision::text) value
    FROM picked
    JOIN managed_knowledge_private.memberships m ON m.item_id=picked.item_id AND m.entity_id=picked.entity_id
    JOIN managed_knowledge_private.items i ON i.id=picked.item_id
    JOIN managed_knowledge_private.item_heads h ON h.item_id=i.id
    JOIN managed_knowledge_private.entities e ON e.id=picked.entity_id
    LEFT JOIN managed_knowledge_private.article_items a ON a.item_id=i.id
    WHERE picked.origin='managed'
    UNION ALL
    SELECT picked.sort_at, picked.item_id, picked.entity_id,
      jsonb_build_object('itemId',m.id,'entityId',m.entity_id,'origin','legacy','title',m.title,'summary',m.summary,
        'publishedAt',NULL,'eventAt',m.event_at,'observedAt',m.observed_at,'catalogEntityId',m.entity_id,'aliases',e.aliases,'metadata',e.metadata,
        'revision','legacy:' || managed_knowledge_private.digest_v1(jsonb_build_object('id',m.id,'updatedAt',m.updated_at,'entityId',m.entity_id))) value
    FROM picked
    JOIN public.entity_memories m ON m.id=picked.item_id
    JOIN public.entities e ON e.id=m.entity_id
    WHERE picked.origin='legacy'
  )
  SELECT coalesce(jsonb_agg(value ORDER BY sort_at DESC, item_id::text, entity_id::text),'[]'::jsonb) INTO items FROM history;
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