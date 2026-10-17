-- Not applied. Rollback for 20261017093000_article_uncertain_memberships.sql;
-- run manually only with Bucket's yes. Kept outside supabase/migrations so
-- `supabase db push` never runs it as a forward migration.
-- Restores the previous function bodies first (they reference the columns),
-- then drops the columns. Dropping discards saved confidence/uncertain values.
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
    WHERE membership.removed_operation IS NULL AND source.source = input->>'source'
      AND source.source_refs ?| ARRAY(SELECT jsonb_array_elements_text(input->'sourceRefs'))
    UNION SELECT value::uuid FROM jsonb_array_elements_text(input->'entityIds') value
    UNION SELECT membership.entity_id FROM managed_knowledge_private.memberships membership
      WHERE membership.item_id::text IN (SELECT jsonb_array_elements_text(input->'itemIds')) AND membership.removed_operation IS NULL
  ), candidates AS (
    SELECT entity.id, entity.binding
      || CASE WHEN catalog.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('slug',catalog.slug,'name',catalog.name,'type',catalog.type,'aliases',catalog.aliases,'summary',catalog.summary,'metadata',catalog.metadata,'status',catalog.status,'updated_at',catalog.updated_at) END
      || jsonb_build_object('revision',managed_knowledge_private.entity_revision_v1(entity.id)) AS binding
      FROM managed_knowledge_private.entities entity LEFT JOIN public.entities catalog ON catalog.id = entity.catalog_entity_id
      WHERE managed_knowledge_private.entity_revision_v1(entity.id) <> 'unavailable'
      AND (entity.id IN (SELECT id FROM subject_entities) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(input->'labels') label WHERE lower(btrim(label)) = lower(btrim(coalesce(catalog.name,entity.binding->>'name')))
          OR lower(btrim(label)) = lower(btrim(coalesce(catalog.slug,entity.binding->>'slug')))
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(to_jsonb(catalog.aliases),entity.binding->'aliases')) alias WHERE lower(btrim(alias)) = lower(btrim(label)))
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
      SELECT 1 FROM managed_knowledge_private.memberships membership WHERE membership.item_id = item.id AND membership.entity_id = ANY(ids) AND membership.removed_operation IS NULL);
  SELECT coalesce(jsonb_agg(snapshot ORDER BY observed_at DESC,id),'[]'::jsonb) INTO items_json FROM (
    SELECT item.id,item.observed_at,jsonb_build_object(
      'itemId',item.id,'note',item.note,'status',head.status,'revision','item:' || head.revision::text,'observedAt',item.observed_at,
      'entityIds',coalesce((SELECT jsonb_agg(entity_id ORDER BY entity_id) FROM managed_knowledge_private.memberships WHERE item_id = item.id AND removed_operation IS NULL),'[]'::jsonb),
      'packetRefs',coalesce((SELECT jsonb_agg(packet_id ORDER BY work_id) FROM (SELECT source.work_id,source.packet->>'packetId' AS packet_id FROM managed_knowledge_private.item_sources linkage JOIN managed_knowledge_private.sources source USING(work_id) WHERE linkage.item_id = item.id ORDER BY source.created_at DESC,source.work_id LIMIT 64) refs),'[]'::jsonb),
      'evidenceRefs',coalesce((SELECT jsonb_agg(jsonb_build_object('claimId',claim_id,'evidenceId',evidence_id,'sourceRef',source_ref) ORDER BY work_id,claim_id,evidence_id) FROM (SELECT work_id,claim_id,evidence_id,source_ref FROM managed_knowledge_private.evidence WHERE item_id = item.id ORDER BY work_id,claim_id,evidence_id LIMIT 128) refs),'[]'::jsonb),
      'successorItemIds',coalesce((SELECT jsonb_agg(to_item ORDER BY to_item) FROM managed_knowledge_private.developments WHERE from_item = item.id AND kind IN ('correct','supersede')),'[]'::jsonb)
    ) AS snapshot FROM managed_knowledge_private.items item JOIN managed_knowledge_private.item_heads head ON head.item_id = item.id
    WHERE item.id::text IN (SELECT jsonb_array_elements_text(input->'itemIds')) OR EXISTS(
      SELECT 1 FROM managed_knowledge_private.memberships membership WHERE membership.item_id = item.id AND membership.entity_id = ANY(ids) AND membership.removed_operation IS NULL)
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

CREATE OR REPLACE FUNCTION managed_knowledge_private.article_writer_v1(action text, input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE operation text := input->>'operationId'; work text := input->>'workId'; lease managed_knowledge_private.leases;
  source_row managed_knowledge_private.sources; saved managed_knowledge_private.plans; receipt jsonb; result jsonb;
  revision integer; new_revision integer; effect jsonb; proposal jsonb; prepared_binding jsonb; item uuid; entity uuid; target uuid; target_origin text; entry record; actual text;
BEGIN
  IF NOT pg_has_role(session_user,'myboon_knowledge_executor','member') OR pg_has_role(session_user,'myboon_knowledge_owner','member')
    OR pg_has_role(session_user,'service_role','member') OR session_user IN ('authenticator','anon','authenticated','service_role') THEN
    RAISE EXCEPTION 'dedicated managed writer login required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(input) <> 'object' OR octet_length(input::text) > 10485760 THEN RAISE EXCEPTION 'bounded article writer input required' USING ERRCODE = '22023'; END IF;
  IF action = 'source' THEN
    IF (input->'packet'->>'schemaVersion' IS DISTINCT FROM 'myboon.research_packet.article.v1'
      AND input->'packet'->>'schemaVersion' IS DISTINCT FROM 'myboon.research_packet.article.v2') OR input->'packet'->>'packetKind' IS DISTINCT FROM 'article'
      OR input->'packet'->>'workId' IS DISTINCT FROM work OR input->'packet'->>'sourceType' IS DISTINCT FROM input->>'source'
      OR input->>'source' NOT IN ('news','polymarket') OR input->'packet'->'article'->>'sourceUrl' !~ '^https?://'
      OR length(btrim(coalesce(input->'packet'->'article'->>'capturedText',''))) = 0
      OR input->'packet'->'article'->>'contentHash' !~ '^[0-9a-f]{32,128}$'
      OR input->'readiness'->>'packetKind' IS DISTINCT FROM 'article' OR input->'readiness'->>'workId' IS DISTINCT FROM work
      OR input->'readiness'->>'signalId' IS DISTINCT FROM input->'packet'->>'signalId' OR input->'readiness'->>'sourceType' IS DISTINCT FROM input->>'source'
      OR input->'readiness'->>'packetId' IS DISTINCT FROM input->'packet'->>'packetId'
      OR input->'readiness'->'sourceCoverage'->>'sourceUrl' IS DISTINCT FROM input->'packet'->'article'->>'sourceUrl'
      OR input->'readiness'->'sourceCoverage'->>'capturedAt' IS DISTINCT FROM input->'packet'->'article'->>'capturedAt'
      OR input->'readiness'->'sourceCoverage'->>'contentHash' IS DISTINCT FROM input->'packet'->'article'->>'contentHash'
      OR coalesce((input->'readiness'->'sourceCoverage'->>'placementCount')::integer,-1) IS DISTINCT FROM jsonb_array_length(input->'packet'->'memberships')
      OR coalesce(input->'readiness'->>'outcome','') NOT IN ('ready_for_entity','resolved_without_new_item')
      OR (input->>'packetCanonical')::jsonb IS DISTINCT FROM input->'packet' OR (input->>'readinessCanonical')::jsonb IS DISTINCT FROM input->'readiness'
      OR encode(sha256(convert_to(input->>'packetCanonical','UTF8')),'hex') IS DISTINCT FROM input->>'packetDigest'
      OR encode(sha256(convert_to(input->>'readinessCanonical','UTF8')),'hex') IS DISTINCT FROM input->>'readinessDigest' THEN
      RAISE EXCEPTION 'immutable article source proof mismatch' USING ERRCODE = 'MK001';
    END IF;
    INSERT INTO managed_knowledge_private.sources(work_id,packet_digest,packet,readiness,readiness_digest,source,source_refs,retrieved_evidence)
      VALUES(work,input->>'packetDigest',input->'packet',input->'readiness',input->>'readinessDigest',input->>'source',input->'sourceRefs','[]'::jsonb) ON CONFLICT DO NOTHING;
    SELECT * INTO source_row FROM managed_knowledge_private.sources WHERE work_id=work;
    IF source_row.packet_digest IS DISTINCT FROM input->>'packetDigest' OR source_row.readiness_digest IS DISTINCT FROM input->>'readinessDigest' THEN RAISE EXCEPTION 'saved article source cannot be rewritten' USING ERRCODE='MK001'; END IF;
    RETURN 'true'::jsonb;
  END IF;
  IF action NOT IN ('commit','hold') OR operation !~ '^progression-v2:[0-9a-f]{64}$' THEN RAISE EXCEPTION 'unknown article writer action' USING ERRCODE='22023'; END IF;
  SELECT r.receipt INTO receipt FROM managed_knowledge_private.receipts r WHERE r.operation_id=operation;
  IF receipt IS NOT NULL THEN
    IF receipt->>'workId' IS DISTINCT FROM work OR receipt->>'planDigest' IS DISTINCT FROM input->>'planDigest' OR receipt->>'contentDigest' IS DISTINCT FROM input->>'contentDigest' THEN RAISE EXCEPTION 'terminal receipt is immutable' USING ERRCODE='MK001'; END IF;
    RETURN jsonb_build_object('receipt',receipt,'alreadyAccepted',true);
  END IF;
  SELECT * INTO lease FROM managed_knowledge_private.leases WHERE operation_id=operation FOR UPDATE;
  IF lease.operation_id IS NULL OR lease.owner IS DISTINCT FROM input->>'owner' OR lease.epoch IS DISTINCT FROM (input->>'epoch')::bigint OR lease.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'stale managed writer lease' USING ERRCODE='MK002'; END IF;
  IF action='hold' THEN
    IF length(btrim(coalesce(input->>'reason',''))) NOT BETWEEN 1 AND 1000 OR length(btrim(coalesce(input->>'missingDependency',''))) NOT BETWEEN 1 AND 1000
      OR input->>'attemptDigest' !~ '^[0-9a-f]{64}$' OR input->>'contentDigest' !~ '^[0-9a-f]{64}$'
      OR (input->>'retainedCanonical')::jsonb IS DISTINCT FROM input->'retainedPayload'
      OR (input->>'contentCanonical')::jsonb IS DISTINCT FROM jsonb_build_object('schemaVersion','myboon.article_hold.v1','reason',input->>'reason','missingDependency',input->>'missingDependency','retainedPayload',input->'retainedPayload')
      OR encode(sha256(convert_to(input->>'contentCanonical','UTF8')),'hex') IS DISTINCT FROM input->>'contentDigest' THEN
      RAISE EXCEPTION 'article hold proof mismatch' USING ERRCODE='MK001';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM managed_knowledge_private.sources s WHERE s.work_id=work AND (s.packet->>'schemaVersion'='myboon.research_packet.article.v1' OR s.packet->>'schemaVersion'='myboon.research_packet.article.v2')) THEN
      RAISE EXCEPTION 'article hold requires immutable source' USING ERRCODE='MK001';
    END IF;
    result:=jsonb_build_object('schemaVersion','myboon.knowledge_operation_receipt.v2','status','held','operationId',operation,'workId',work,
      'attemptDigest',input->>'attemptDigest','planRevision',NULL,'planDigest',input->>'attemptDigest','owner',lease.owner,'ownerEpoch',lease.epoch,
      'contentDigest',input->>'contentDigest','committedAt',clock_timestamp(),'reason',input->>'reason','missingDependency',input->>'missingDependency',
      'retainedGroups',1,'retainedPayload',input->'retainedPayload');
    INSERT INTO managed_knowledge_private.holds(operation_id,owner_epoch,attempt_digest,plan_revision,plan_digest,content_digest,receipt)
      VALUES(operation,lease.epoch,input->>'attemptDigest',NULL,input->>'attemptDigest',input->>'contentDigest',result) ON CONFLICT DO NOTHING;
    SELECT h.receipt INTO result FROM managed_knowledge_private.holds h WHERE h.operation_id=operation AND h.owner_epoch=lease.epoch
      AND h.attempt_digest=input->>'attemptDigest' AND h.plan_revision IS NULL AND h.plan_digest=input->>'attemptDigest' AND h.content_digest=input->>'contentDigest';
    RETURN jsonb_build_object('receipt',result,'alreadyAccepted',false);
  END IF;
  IF input->'plan'->>'schemaVersion' IS DISTINCT FROM 'myboon.article_progression_plan.v1' OR input->'plan'->>'operationId' IS DISTINCT FROM operation OR input->'plan'->>'workId' IS DISTINCT FROM work
    OR (input->>'planCanonical')::jsonb IS DISTINCT FROM input->'plan' OR encode(sha256(convert_to(input->>'planCanonical','UTF8')),'hex') IS DISTINCT FROM input->>'planDigest'
    OR (input->>'effectsCanonical')::jsonb IS DISTINCT FROM input->'effects' OR encode(sha256(convert_to(input->>'effectsCanonical','UTF8')),'hex') IS DISTINCT FROM input->>'contentDigest'
    OR jsonb_typeof(input->'effects') <> 'array' OR jsonb_array_length(input->'effects') <> 1
    OR input->'effects' IS DISTINCT FROM jsonb_build_array(input->'plan'->'effect') THEN RAISE EXCEPTION 'article plan proof mismatch' USING ERRCODE='MK001'; END IF;
  SELECT * INTO source_row FROM managed_knowledge_private.sources WHERE work_id=work;
  IF source_row.work_id IS NULL OR source_row.packet_digest IS DISTINCT FROM input->'plan'->>'packetDigest'
    OR (source_row.packet->>'schemaVersion' IS DISTINCT FROM 'myboon.research_packet.article.v1' AND source_row.packet->>'schemaVersion' IS DISTINCT FROM 'myboon.research_packet.article.v2')
    OR source_row.packet->'article' IS DISTINCT FROM input->'plan'->'effect'->'article' OR source_row.packet->'memberships' IS DISTINCT FROM input->'plan'->'effect'->'memberships' THEN RAISE EXCEPTION 'saved article source/plan mismatch' USING ERRCODE='MK001'; END IF;
  SELECT * INTO saved FROM managed_knowledge_private.plans WHERE operation_id=operation AND plan_digest=input->>'planDigest';
  IF saved.operation_id IS NULL THEN
    SELECT coalesce(max(p.revision),0)+1 INTO new_revision FROM managed_knowledge_private.plans p WHERE p.operation_id=operation;
    INSERT INTO managed_knowledge_private.plans(operation_id,revision,attempt_digest,plan_digest,plan,effects,snapshot)
      VALUES(operation,new_revision,encode(sha256(convert_to(input->>'planDigest','UTF8')),'hex'),input->>'planDigest',input->'plan',input->'effects',jsonb_build_object('revision',new_revision,'plan',input->'plan','planDigest',input->>'planDigest','savedAt',clock_timestamp(),'owner',lease.owner,'ownerEpoch',lease.epoch));
    SELECT * INTO saved FROM managed_knowledge_private.plans p WHERE p.operation_id=operation AND p.revision=new_revision;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM managed_knowledge_private.planning_contexts WHERE work_id=work AND context_digest=input->'plan'->>'contextDigest') THEN RAISE EXCEPTION 'article context checkpoint missing' USING ERRCODE='MK003',DETAIL='context'; END IF;
  -- Serialize the same private write domain as the legacy writer. Revisions
  -- below fence only the identities/history actually read; an unrelated
  -- article must not permanently invalidate this packet's context watermark.
  PERFORM pg_advisory_xact_lock(299,4);
  FOR entry IN SELECT key,value FROM jsonb_each_text(input->'plan'->'targetRevisions') LOOP
    IF entry.value LIKE 'legacy:%' THEN
      SELECT 'legacy:' || managed_knowledge_private.digest_v1(jsonb_build_object('id',m.id,'updatedAt',m.updated_at,'entityId',m.entity_id)) INTO actual FROM public.entity_memories m WHERE m.id=entry.key::uuid;
    ELSIF entry.value LIKE 'item:%' THEN
      SELECT 'item:' || h.revision::text INTO actual FROM managed_knowledge_private.item_heads h WHERE h.item_id=entry.key::uuid;
    ELSE
      actual := managed_knowledge_private.entity_revision_v1(entry.key::uuid);
    END IF;
    IF actual IS DISTINCT FROM entry.value THEN RAISE EXCEPTION 'article target changed since context capture' USING ERRCODE='MK003',DETAIL=entry.key; END IF;
  END LOOP;
  effect := input->'plan'->'effect'; item := nullif(effect->>'itemId','')::uuid;
  IF effect->>'kind' NOT IN ('article_item','article_source_attachment') OR (effect->>'kind'='article_item' AND item IS NULL) OR (effect->>'kind'='article_source_attachment' AND item IS NOT NULL) THEN RAISE EXCEPTION 'invalid article effect' USING ERRCODE='MK001'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(source_row.packet->'memberships') p WHERE
    p->>'placementDisposition' NOT IN ('selected','no_match')
    OR (p->>'placementDisposition'='selected' AND p->>'entityId' IS NULL)
    OR (p->>'placementDisposition'='no_match' AND (jsonb_typeof(p->'creationProposal') IS DISTINCT FROM 'object' OR p->'creationDecision'->>'choice' IS DISTINCT FROM 'accept'))
  ) THEN RAISE EXCEPTION 'article membership placement is not durably resolved' USING ERRCODE='MK003',DETAIL='entity_resolution'; END IF;
  -- Bind selected catalogue/private IDs and create only explicit no-match proposals.
  FOR prepared_binding IN SELECT value FROM jsonb_array_elements(input->'plan'->'entities') value LOOP
    entity := (prepared_binding->>'id')::uuid;
    IF prepared_binding->>'catalogEntityId' IS NOT NULL THEN
      -- Catalogue bindings retain the old writer's same-ID mapping; never
      -- create a private alias for an arbitrary catalogue identity.
      IF entity IS DISTINCT FROM (prepared_binding->>'catalogEntityId')::uuid OR NOT EXISTS(SELECT 1 FROM public.entities e WHERE e.id=(prepared_binding->>'catalogEntityId')::uuid AND e.status='active') THEN RAISE EXCEPTION 'selected catalogue entity unavailable' USING ERRCODE='MK003',DETAIL=entity::text; END IF;
      INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation) VALUES(entity,prepared_binding->>'identityKey',(prepared_binding->>'catalogEntityId')::uuid,prepared_binding,operation) ON CONFLICT(id) DO NOTHING;
    ELSIF EXISTS(SELECT 1 FROM managed_knowledge_private.entities p WHERE p.id=entity) THEN
      -- A previous deterministic article creation is now a selected private
      -- binding, not another expected-absent creation collision.
      IF NOT EXISTS(SELECT 1 FROM managed_knowledge_private.entities p WHERE p.id=entity AND p.catalog_entity_id IS NULL AND p.identity_key=prepared_binding->>'identityKey') THEN
        RAISE EXCEPTION 'selected private entity binding changed' USING ERRCODE='MK003',DETAIL=entity::text;
      END IF;
    ELSE
      IF prepared_binding->>'revision' IS DISTINCT FROM 'absent' THEN RAISE EXCEPTION 'new article entity was not expected absent' USING ERRCODE='MK003',DETAIL=entity::text; END IF;
      IF EXISTS(SELECT 1 FROM public.entities e WHERE lower(btrim(e.name))=lower(btrim(prepared_binding->>'name')) OR lower(btrim(e.slug))=lower(btrim(prepared_binding->>'slug'))
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(e.aliases,'[]'::jsonb)) alias WHERE lower(btrim(alias))=lower(btrim(prepared_binding->>'name')))
        OR lower(btrim(e.name)) IN (SELECT lower(btrim(alias)) FROM jsonb_array_elements_text(coalesce(prepared_binding->'aliases','[]'::jsonb)) alias)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(e.aliases,'[]'::jsonb)) existing_alias WHERE lower(btrim(existing_alias)) IN (SELECT lower(btrim(alias)) FROM jsonb_array_elements_text(coalesce(prepared_binding->'aliases','[]'::jsonb)) alias)))
        OR EXISTS(SELECT 1 FROM managed_knowledge_private.entities p WHERE lower(btrim(coalesce(p.binding->>'name','')))=lower(btrim(prepared_binding->>'name'))
          OR lower(btrim(coalesce(p.binding->>'slug','')))=lower(btrim(prepared_binding->>'slug'))
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p.binding->'aliases','[]'::jsonb)) alias WHERE lower(btrim(alias))=lower(btrim(prepared_binding->>'name')))
          OR lower(btrim(coalesce(p.binding->>'name',''))) IN (SELECT lower(btrim(alias)) FROM jsonb_array_elements_text(coalesce(prepared_binding->'aliases','[]'::jsonb)) alias)
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p.binding->'aliases','[]'::jsonb)) existing_alias WHERE lower(btrim(existing_alias)) IN (SELECT lower(btrim(alias)) FROM jsonb_array_elements_text(coalesce(prepared_binding->'aliases','[]'::jsonb)) alias))) THEN
        RAISE EXCEPTION 'new article entity is equivalent to an existing identity' USING ERRCODE='MK003',DETAIL='entity_resolution';
      END IF;
      INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation) VALUES(entity,prepared_binding->>'identityKey',NULL,prepared_binding,operation) ON CONFLICT(id) DO NOTHING;
    END IF;
  END LOOP;
  IF effect->>'kind'='article_source_attachment' THEN
    IF jsonb_typeof(effect->'duplicateTarget') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'article reuse requires an exact duplicate target' USING ERRCODE='MK001'; END IF;
    target_origin := effect->'duplicateTarget'->>'source'; target := (effect->'duplicateTarget'->>'itemId')::uuid; entity := (effect->'duplicateTarget'->>'entityId')::uuid;
    IF target_origin='managed' AND NOT EXISTS(SELECT 1 FROM managed_knowledge_private.items i WHERE i.id=target) THEN RAISE EXCEPTION 'managed duplicate target is unavailable' USING ERRCODE='MK003',DETAIL='duplicate_target'; END IF;
    IF target_origin='legacy' AND NOT EXISTS(SELECT 1 FROM public.entity_memories m WHERE m.id=target AND m.entity_id=entity) THEN RAISE EXCEPTION 'legacy duplicate target is not a memory of selected entity' USING ERRCODE='MK003',DETAIL='duplicate_target'; END IF;
    IF target_origin NOT IN ('legacy','managed') THEN RAISE EXCEPTION 'invalid duplicate origin' USING ERRCODE='MK001'; END IF;
    -- One source can reuse one shared managed item across several prepared
    -- memberships. Add only missing memberships; never alter old prose/roles.
    FOR proposal IN SELECT value FROM jsonb_array_elements(source_row.packet->'memberships') value WHERE value->>'placementDisposition' IN ('selected','no_match') LOOP
      -- Only exact duplicate decisions constrain the shared reuse target. A
      -- primary/related membership without its own target still belongs on a
      -- managed reused item (for example Bitcoin on a BlackRock-only item).
      IF jsonb_typeof(proposal->'duplicateTarget')='object' AND (
        proposal->'duplicateTarget'->>'source' IS DISTINCT FROM effect->'duplicateTarget'->>'source'
        OR proposal->'duplicateTarget'->>'itemId' IS DISTINCT FROM effect->'duplicateTarget'->>'itemId'
      ) THEN RAISE EXCEPTION 'article duplicate targets disagree' USING ERRCODE='MK001'; END IF;
      SELECT value INTO prepared_binding FROM jsonb_array_elements(input->'plan'->'entities') value WHERE (proposal->>'entityId' IS NOT NULL AND value->>'id'=proposal->>'entityId') OR (proposal->>'entityId' IS NULL AND lower(btrim(value->>'name'))=lower(btrim(proposal->'creationProposal'->>'name')));
      IF prepared_binding IS NULL THEN RAISE EXCEPTION 'duplicate membership has no resolved entity binding' USING ERRCODE='MK003',DETAIL='entity_resolution'; END IF;
      target_origin:=effect->'duplicateTarget'->>'source'; target:=(effect->'duplicateTarget'->>'itemId')::uuid; entity:=(effect->'duplicateTarget'->>'entityId')::uuid;
      IF target_origin='legacy' AND entity IS DISTINCT FROM (prepared_binding->>'id')::uuid THEN RAISE EXCEPTION 'legacy duplicate target cannot gain a new membership' USING ERRCODE='MK003',DETAIL='duplicate_target'; END IF;
      IF target_origin='managed' THEN
        INSERT INTO managed_knowledge_private.item_sources(item_id,work_id,operation_id) VALUES(target,work,operation) ON CONFLICT DO NOTHING;
        IF FOUND THEN UPDATE managed_knowledge_private.item_heads SET revision=item_heads.revision+1 WHERE item_id=target; END IF;
        INSERT INTO managed_knowledge_private.memberships AS membership(item_id,entity_id,role,added_operation) VALUES(target,(prepared_binding->>'id')::uuid,proposal->>'role',operation)
          ON CONFLICT(item_id,entity_id) DO UPDATE SET removed_operation=NULL
          WHERE membership.removed_operation IS NOT NULL;
        IF FOUND THEN UPDATE managed_knowledge_private.item_heads SET revision=item_heads.revision+1 WHERE item_id=target; END IF;
      END IF;
      INSERT INTO managed_knowledge_private.article_source_attachments(work_id,target_origin,target_item_id,entity_id,operation_id) VALUES(work,target_origin,target,(prepared_binding->>'id')::uuid,operation) ON CONFLICT DO NOTHING;
    END LOOP;
    INSERT INTO managed_knowledge_private.history(operation_id,work_id,item_id,event_kind,payload) VALUES(operation,work,NULL,'article_source_reused',effect);
  ELSE
    IF EXISTS(SELECT 1 FROM managed_knowledge_private.items WHERE id=item) THEN RAISE EXCEPTION 'new article item already exists' USING ERRCODE='MK003',DETAIL='expected_absent'; END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(source_row.packet->'memberships') p WHERE p->>'placementDisposition' IN ('selected','no_match') AND p->>'role'='primary') <> 1 THEN RAISE EXCEPTION 'article requires exactly one resolvable primary placement' USING ERRCODE='MK001'; END IF;
    INSERT INTO managed_knowledge_private.items(id,note,payload,operation_id,work_id,observed_at) VALUES(item,source_row.packet->'article'->>'timelineSummary',effect,operation,work,(source_row.packet->>'observedAt')::timestamptz);
    INSERT INTO managed_knowledge_private.item_heads(item_id) VALUES(item);
    INSERT INTO managed_knowledge_private.article_items(item_id,title,timeline_summary,body,source_url,captured_text,captured_at,content_hash,captured_text_hash,published_at,event_at,observed_at)
      VALUES(item,source_row.packet->'article'->>'title',source_row.packet->'article'->>'timelineSummary',source_row.packet->'article'->>'body',source_row.packet->'article'->>'sourceUrl',source_row.packet->'article'->>'capturedText',(source_row.packet->'article'->>'capturedAt')::timestamptz,source_row.packet->'article'->>'contentHash',encode(sha256(convert_to(source_row.packet->'article'->>'capturedText','UTF8')),'hex'),nullif(source_row.packet->'sourceSignal'->>'publishedAt','')::timestamptz,nullif(source_row.packet->'article'->>'eventAt','')::timestamptz,(source_row.packet->>'observedAt')::timestamptz);
    INSERT INTO managed_knowledge_private.item_sources(item_id,work_id,operation_id) VALUES(item,work,operation);
    FOR proposal IN SELECT value FROM jsonb_array_elements(source_row.packet->'memberships') value WHERE value->>'placementDisposition' IN ('selected','no_match') LOOP
      SELECT value INTO prepared_binding FROM jsonb_array_elements(input->'plan'->'entities') value WHERE (proposal->>'entityId' IS NOT NULL AND value->>'id'=proposal->>'entityId') OR (proposal->>'entityId' IS NULL AND lower(btrim(value->>'name'))=lower(btrim(proposal->'creationProposal'->>'name')));
      IF prepared_binding IS NULL THEN RAISE EXCEPTION 'article membership has no resolved entity binding' USING ERRCODE='MK003',DETAIL='entity_resolution'; END IF;
      INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation) VALUES(item,(prepared_binding->>'id')::uuid,proposal->>'role',operation);
      -- A related exact duplicate can accompany a materially new primary
      -- article. Keep that valid durable historical relationship even though
      -- the new item is not itself reused.
      IF proposal->>'priorItemId' IS NOT NULL OR jsonb_typeof(proposal->'duplicateTarget')='object' THEN
        target_origin:=coalesce(proposal->>'priorItemSource',proposal->'duplicateTarget'->>'source');
        target:=coalesce(proposal->>'priorItemId',proposal->'duplicateTarget'->>'itemId')::uuid;
        IF target_origin='managed' AND NOT EXISTS(SELECT 1 FROM managed_knowledge_private.memberships m WHERE m.item_id=target AND m.entity_id=(prepared_binding->>'id')::uuid AND m.removed_operation IS NULL) THEN RAISE EXCEPTION 'managed article history target invalid' USING ERRCODE='MK003',DETAIL='history_reference'; END IF;
        IF target_origin='legacy' AND NOT EXISTS(SELECT 1 FROM public.entity_memories m WHERE m.id=target AND m.entity_id=(prepared_binding->>'id')::uuid) THEN RAISE EXCEPTION 'legacy article history target invalid' USING ERRCODE='MK003',DETAIL='history_reference'; END IF;
        INSERT INTO managed_knowledge_private.article_relationships(item_id,entity_id,target_origin,target_item_id,relationship,decision,operation_id) VALUES(item,(prepared_binding->>'id')::uuid,target_origin,target,proposal->>'relationship',proposal->'relationshipDecision',operation);
      END IF;
    END LOOP;
    INSERT INTO managed_knowledge_private.history(operation_id,work_id,item_id,event_kind,payload) VALUES(operation,work,item,'article_item_created',effect);
  END IF;
  result:=jsonb_build_object('schemaVersion','myboon.knowledge_operation_receipt.v2','status','accepted','operationId',operation,'workId',work,'attemptDigest',saved.attempt_digest,'planRevision',saved.revision,'planDigest',input->>'planDigest','owner',lease.owner,'ownerEpoch',lease.epoch,'contentDigest',input->>'contentDigest','committedAt',clock_timestamp(),'reason',NULL,'missingDependency',NULL,'retainedGroups',0,'retainedPayload',NULL);
  INSERT INTO managed_knowledge_private.receipts(operation_id,work_id,plan_revision,plan_digest,content_digest,receipt) VALUES(operation,work,saved.revision,input->>'planDigest',input->>'contentDigest',result);
  RETURN jsonb_build_object('receipt',result,'alreadyAccepted',false);
END
$body$;

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

-- Before the columns go, retire every uncertain membership with the same
-- mechanism writer_v1 uses for remove_membership: set removed_operation (and
-- bump the item head revision), so the restored readers, which only filter
-- removed_operation IS NULL, never count them as certain. The removal is
-- attributed to one deterministic rollback lease that is already expired, so
-- no writer can ever act under it. Skipped when the column is already gone,
-- so the rollback is safe to re-run; the lease is only created when there is
-- something to retire.
DO $retire_uncertain$
DECLARE rollback_operation text := 'progression-v2:' || encode(sha256(convert_to('myboon.rollback.20261017093000_article_uncertain_memberships','UTF8')),'hex');
  has_uncertain boolean := false;
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='managed_knowledge_private.memberships'::regclass AND attname='uncertain' AND NOT attisdropped) THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM managed_knowledge_private.memberships WHERE uncertain AND removed_operation IS NULL)' INTO has_uncertain;
  END IF;
  IF has_uncertain THEN
    INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
      VALUES(rollback_operation,'rollback:20261017093000',1,clock_timestamp()) ON CONFLICT(operation_id) DO NOTHING;
    EXECUTE $retire$
      WITH retired AS (
        UPDATE managed_knowledge_private.memberships SET removed_operation=$1
        WHERE uncertain AND removed_operation IS NULL RETURNING item_id
      )
      UPDATE managed_knowledge_private.item_heads SET revision=item_heads.revision+1
      WHERE item_id IN (SELECT DISTINCT item_id FROM retired)
    $retire$ USING rollback_operation;
  END IF;
END
$retire_uncertain$;

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

ALTER TABLE managed_knowledge_private.memberships DROP CONSTRAINT IF EXISTS managed_memberships_placement_confidence_range;
ALTER TABLE managed_knowledge_private.memberships DROP COLUMN IF EXISTS uncertain, DROP COLUMN IF EXISTS placement_confidence;
