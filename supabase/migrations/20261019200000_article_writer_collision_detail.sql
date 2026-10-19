-- #378: article_writer_v1's MK003 "new article entity is equivalent to an
-- existing identity" error names the colliding entity:
-- DETAIL = 'entity_resolution:<uuid>' (first match, managed store before
-- catalogue, each ordered by id). Match conditions are unchanged, so when the
-- error fires is unchanged.
-- NOT APPLIED. Needs Bucket's explicit yes (needs-bucket).
-- Depends on 20261017120000 (#368) and 20261017180000 (#341 Part B); apply
-- after both, in that order.
--
-- Rollback: supabase/rollbacks/20261019200000_article_writer_collision_detail.down.sql.
-- The body is the 20261017180000 article_writer_v1 verbatim except the marked
-- #378 edits (DECLARE + the duplicate check). Same owner wrapper.

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

CREATE OR REPLACE FUNCTION managed_knowledge_private.article_writer_v1(action text, input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE operation text := input->>'operationId'; work text := input->>'workId'; lease managed_knowledge_private.leases;
  source_row managed_knowledge_private.sources; saved managed_knowledge_private.plans; receipt jsonb; result jsonb;
  revision integer; new_revision integer; effect jsonb; proposal jsonb; prepared_binding jsonb; item uuid; entity uuid; target uuid; target_origin text; entry record; actual text;
  -- #341 Part B: scratch for the ride-along summary updates.
  summary_update jsonb; prior_entity managed_knowledge_private.entities; refresh_result jsonb;
  -- #378: the entity that blocks a new article entity as a duplicate.
  colliding_entity uuid;
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
  -- #341 Part B: validate the optional effect->'summaryUpdates' (absent means
  -- no summary updates, for plans built before #341). When present it must be
  -- a JSON array whose elements are objects with exactly the keys entityId and
  -- summary; entityId must be the entityId of a selected membership in the
  -- saved packet; no entityId may appear twice; summary must be a string with
  -- length(btrim(summary)) between 1 and 4000. A reused/duplicate source
  -- never rewrites a summary.
  IF effect ? 'summaryUpdates' THEN
    IF jsonb_typeof(effect->'summaryUpdates') IS DISTINCT FROM 'array'
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(effect->'summaryUpdates') u WHERE
        jsonb_typeof(u) IS DISTINCT FROM 'object'
        OR NOT (u ? 'entityId' AND u ? 'summary')
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(u) k WHERE k NOT IN ('entityId','summary'))
        OR jsonb_typeof(u->'summary') IS DISTINCT FROM 'string'
        OR length(btrim(u->>'summary')) NOT BETWEEN 1 AND 4000
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_row.packet->'memberships') m WHERE
          m->>'placementDisposition'='selected' AND m->>'entityId'=u->>'entityId'))
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(effect->'summaryUpdates') u
        GROUP BY u->>'entityId' HAVING count(*) > 1)
    THEN RAISE EXCEPTION 'article summary update proof mismatch' USING ERRCODE='MK001'; END IF;
    IF effect->>'kind'='article_source_attachment' AND jsonb_array_length(effect->'summaryUpdates') > 0 THEN
      RAISE EXCEPTION 'article summary update proof mismatch' USING ERRCODE='MK001';
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(source_row.packet->'memberships') p WHERE
    p->>'placementDisposition' NOT IN ('selected','no_match')
    OR (p->>'placementDisposition'='selected' AND p->>'entityId' IS NULL)
    OR (p->>'placementDisposition'='no_match' AND (jsonb_typeof(p->'creationProposal') IS DISTINCT FROM 'object' OR p->'creationDecision'->>'choice' IS DISTINCT FROM 'accept'))
  ) THEN RAISE EXCEPTION 'article membership placement is not durably resolved' USING ERRCODE='MK003',DETAIL='entity_resolution'; END IF;
  -- #343 PR-B: optional placement confidence/uncertain flag. Both are absent
  -- on older packets (saved as certain with no confidence) or present together.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(source_row.packet->'memberships') p WHERE
    (p ? 'placementUncertain') IS DISTINCT FROM (p ? 'placementConfidence')
    OR (p ? 'placementUncertain' AND jsonb_typeof(p->'placementUncertain') IS DISTINCT FROM 'boolean')
    OR (p ? 'placementConfidence' AND jsonb_typeof(p->'placementConfidence') NOT IN ('null','number'))
    OR CASE WHEN jsonb_typeof(p->'placementConfidence')='number' THEN (p->>'placementConfidence')::numeric NOT BETWEEN 0 AND 1 ELSE false END
  ) THEN RAISE EXCEPTION 'article membership confidence proof mismatch' USING ERRCODE='MK001'; END IF;
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
      -- #378: name the colliding entity in DETAIL ('entity_resolution:<uuid>').
      -- Same match conditions as before; first match only, managed store
      -- before catalogue, each ordered by id.
      colliding_entity := NULL;
      SELECT p.id INTO colliding_entity FROM managed_knowledge_private.entities p WHERE lower(btrim(coalesce(p.name,'')))=lower(btrim(prepared_binding->>'name')) OR lower(btrim(coalesce(p.slug,'')))=lower(btrim(prepared_binding->>'slug')) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p.aliases,'[]'::jsonb)) alias WHERE lower(btrim(alias))=lower(btrim(prepared_binding->>'name'))) OR lower(btrim(coalesce(p.name,''))) IN (SELECT lower(btrim(alias)) FROM jsonb_array_elements_text(coalesce(prepared_binding->'aliases','[]'::jsonb)) alias) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p.aliases,'[]'::jsonb)) existing_alias WHERE lower(btrim(existing_alias)) IN (SELECT lower(btrim(alias)) FROM jsonb_array_elements_text(coalesce(prepared_binding->'aliases','[]'::jsonb)) alias)) ORDER BY p.id LIMIT 1;
      IF colliding_entity IS NULL THEN
        SELECT e.id INTO colliding_entity FROM public.entities e WHERE lower(btrim(e.name))=lower(btrim(prepared_binding->>'name')) OR lower(btrim(e.slug))=lower(btrim(prepared_binding->>'slug')) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(e.aliases,'[]'::jsonb)) alias WHERE lower(btrim(alias))=lower(btrim(prepared_binding->>'name'))) OR lower(btrim(e.name)) IN (SELECT lower(btrim(alias)) FROM jsonb_array_elements_text(coalesce(prepared_binding->'aliases','[]'::jsonb)) alias) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(e.aliases,'[]'::jsonb)) existing_alias WHERE lower(btrim(existing_alias)) IN (SELECT lower(btrim(alias)) FROM jsonb_array_elements_text(coalesce(prepared_binding->'aliases','[]'::jsonb)) alias)) ORDER BY e.id LIMIT 1;
      END IF;
      IF colliding_entity IS NOT NULL THEN
        RAISE EXCEPTION 'new article entity is equivalent to an existing identity' USING ERRCODE='MK003',DETAIL='entity_resolution:' || colliding_entity::text;
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
        INSERT INTO managed_knowledge_private.memberships AS membership(item_id,entity_id,role,added_operation,placement_confidence,uncertain)
          VALUES(target,(prepared_binding->>'id')::uuid,proposal->>'role',operation,(proposal->>'placementConfidence')::numeric,coalesce((proposal->>'placementUncertain')::boolean,false))
          ON CONFLICT(item_id,entity_id) DO UPDATE SET removed_operation=NULL,placement_confidence=EXCLUDED.placement_confidence,uncertain=EXCLUDED.uncertain
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
      INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation,placement_confidence,uncertain)
        VALUES(item,(prepared_binding->>'id')::uuid,proposal->>'role',operation,(proposal->>'placementConfidence')::numeric,coalesce((proposal->>'placementUncertain')::boolean,false));
      -- A related exact duplicate can accompany a materially new primary
      -- article. Keep that valid durable historical relationship even though
      -- the new item is not itself reused.
      IF proposal->>'priorItemId' IS NOT NULL OR jsonb_typeof(proposal->'duplicateTarget')='object' THEN
        target_origin:=coalesce(proposal->>'priorItemSource',proposal->'duplicateTarget'->>'source');
        target:=coalesce(proposal->>'priorItemId',proposal->'duplicateTarget'->>'itemId')::uuid;
        IF target_origin='managed' AND NOT EXISTS(SELECT 1 FROM managed_knowledge_private.memberships m WHERE m.item_id=target AND m.entity_id=(prepared_binding->>'id')::uuid AND m.removed_operation IS NULL AND NOT m.uncertain) THEN RAISE EXCEPTION 'managed article history target invalid' USING ERRCODE='MK003',DETAIL='history_reference'; END IF;
        IF target_origin='legacy' AND NOT EXISTS(SELECT 1 FROM public.entity_memories m WHERE m.id=target AND m.entity_id=(prepared_binding->>'id')::uuid) THEN RAISE EXCEPTION 'legacy article history target invalid' USING ERRCODE='MK003',DETAIL='history_reference'; END IF;
        INSERT INTO managed_knowledge_private.article_relationships(item_id,entity_id,target_origin,target_item_id,relationship,decision,operation_id) VALUES(item,(prepared_binding->>'id')::uuid,target_origin,target,proposal->>'relationship',proposal->'relationshipDecision',operation);
      END IF;
    END LOOP;
    -- #341 Part B: apply the summary updates in this same writer transaction,
    -- after the memberships are placed and before the history row. The
    -- previous summary goes to entity_summary_history at its summary_revision,
    -- the new one at +1, and the entity revision is bumped, all under the
    -- pg_advisory_xact_lock(299,4) the targetRevisions fence already holds.
    FOR summary_update IN SELECT value FROM jsonb_array_elements(coalesce(effect->'summaryUpdates','[]'::jsonb)) value LOOP
      SELECT * INTO prior_entity FROM managed_knowledge_private.entities WHERE id=(summary_update->>'entityId')::uuid FOR UPDATE;
      IF prior_entity.id IS NULL THEN RAISE EXCEPTION 'summary update entity is not a managed entity' USING ERRCODE='MK003',DETAIL='summary_update'; END IF;
      IF prior_entity.summary IS NOT DISTINCT FROM summary_update->>'summary' THEN RAISE EXCEPTION 'summary update does not change the summary' USING ERRCODE='MK001'; END IF;
      refresh_result := managed_knowledge_private.entity_summary_refresh_v1(jsonb_build_object('entityId',prior_entity.id,'expectedSummaryRevision',prior_entity.summary_revision,'summary',summary_update->>'summary','sourceItemIds',jsonb_build_array(item),'model',NULL));
      IF refresh_result->>'status' IS DISTINCT FROM 'refreshed' THEN RAISE EXCEPTION 'summary refresh lost its compare-and-set' USING ERRCODE='MK003',DETAIL='summary_update'; END IF;
      -- Qualified: `revision` is also a PL/pgSQL variable in this function.
      UPDATE managed_knowledge_private.entities AS bumped SET revision=bumped.revision+1 WHERE bumped.id=prior_entity.id;
    END LOOP;
    INSERT INTO managed_knowledge_private.history(operation_id,work_id,item_id,event_kind,payload) VALUES(operation,work,item,'article_item_created',effect);
  END IF;
  result:=jsonb_build_object('schemaVersion','myboon.knowledge_operation_receipt.v2','status','accepted','operationId',operation,'workId',work,'attemptDigest',saved.attempt_digest,'planRevision',saved.revision,'planDigest',input->>'planDigest','owner',lease.owner,'ownerEpoch',lease.epoch,'contentDigest',input->>'contentDigest','committedAt',clock_timestamp(),'reason',NULL,'missingDependency',NULL,'retainedGroups',0,'retainedPayload',NULL);
  INSERT INTO managed_knowledge_private.receipts(operation_id,work_id,plan_revision,plan_digest,content_digest,receipt) VALUES(operation,work,saved.revision,input->>'planDigest',input->>'contentDigest',result);
  RETURN jsonb_build_object('receipt',result,'alreadyAccepted',false);
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
