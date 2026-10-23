-- #336 item 1 (PR B): fixed article_writer_v1 call set for measurement and
-- output comparison. THROWAWAY CLUSTER ONLY; run as a superuser. Builds ten
-- rows into temp table w2_inputs(k, kind, input): a 'source' call plus one
-- commit/hold call per case below, each with its own operationId/workId (rows
-- seeded here), so the file is repeatable inside one transaction that
-- ROLLBACKs afterwards. Measurement driver (single psql session):
--   psql ... -c "SET auto_explain.log_min_duration = 0;" \
--     -f w2-begin.sql(BEGIN) -f 20261020091000_article_writer_latency.inputs.sql \
--     -f 20261020091000_article_writer_latency.calls.sql -f w2-end.sql(ROLLBACK)
-- Entity ids: 00000000-...0001/0002 exist in
-- public.entities and 11111111-...0001 / item 22222222-...0001 are managed
-- rows (from the 20261019213000 prod-scale seed). Cases:
--   cat     'commit', two catalogue-bound selected memberships
--   create  'commit', one expected-absent creation (the #378 collision scan runs)
--   reuse   'commit', article_source_attachment onto a managed item
--   dup     'commit' that must fail MK003 with the #378 entity_resolution detail
--   hold    'hold' path over the same article source
\set ON_ERROR_STOP on
DROP TABLE IF EXISTS w2_inputs;
CREATE TEMP TABLE w2_inputs(k text PRIMARY KEY, kind text, input jsonb);
DO $seed$
DECLARE
  op text; work text; ctx text := repeat('e',64);
  packet jsonb; readiness jsonb; pdigest text; rdigest text;
  effect jsonb; plan jsonb; input jsonb; article jsonb; members jsonb;
  public_a uuid := '00000000-0000-4000-8000-000000000001';
  public_b uuid := '00000000-0000-4000-8000-000000000002';
  managed_e uuid := '11111111-0000-4000-8000-000000000001';
  managed_i uuid := '22222222-0000-4000-8000-000000000001';
  item uuid; new_entity uuid; binding jsonb;
  captured_text text := repeat('article body text for the latency harness ',250);
  c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('cat',         'commit'),
    ('create',      'commit'),
    ('reuse',       'commit'),
    ('dup',         'commit'),
    ('hold',        'hold')
  ) AS t(k, kind) LOOP
    op := 'progression-v2:' || md5('w2-op-' || c.k) || md5('w2-op2-' || c.k);
    work := 'work-w2-' || c.k;
    item := gen_random_uuid();
    new_entity := gen_random_uuid();
    article := jsonb_build_object('title','Harness article ' || c.k,
      'timelineSummary','Harness timeline ' || c.k || ' ' || repeat('summary text ',60),
      'body',captured_text,'sourceUrl','https://example.test/harness/' || c.k,
      'capturedText',captured_text,'capturedAt','2026-10-19T00:00:00Z',
      'publishedAt','2026-10-19T01:00:00Z','eventAt','',
      'contentHash',repeat('9',64));
    members := CASE c.k
      WHEN 'cat' THEN jsonb_build_array(
        jsonb_build_object('role','primary','placementDisposition','selected','entityId',public_a::text),
        jsonb_build_object('role','related','placementDisposition','selected','entityId',public_b::text))
      WHEN 'create' THEN jsonb_build_array(
        jsonb_build_object('role','primary','placementDisposition','no_match','entityId',NULL,
          'name','Brand New Entity 900',
          'creationProposal',jsonb_build_object('name','Brand New Entity 900','type','asset','aliases','[]'::jsonb),
          'creationDecision',jsonb_build_object('choice','accept')))
      WHEN 'reuse' THEN jsonb_build_array(
        jsonb_build_object('role','primary','placementDisposition','selected','entityId',managed_e::text))
      WHEN 'dup' THEN jsonb_build_array(
        jsonb_build_object('role','primary','placementDisposition','no_match','entityId',NULL,
          'name','Managed Entity 1',
          'creationProposal',jsonb_build_object('name','Managed Entity 1','type','topic','aliases','[]'::jsonb),
          'creationDecision',jsonb_build_object('choice','accept')))
      ELSE jsonb_build_array(
        jsonb_build_object('role','primary','placementDisposition','selected','entityId',public_a::text))
    END;
    packet := jsonb_build_object('schemaVersion','myboon.research_packet.article.v1','packetKind','article',
      'workId',work,'packetId','packet-w2-' || c.k,'signalId','signal-w2-' || c.k,'sourceType','news',
      'observedAt','2026-10-19T02:00:00Z','article',article,'memberships',members);
    pdigest := encode(sha256(convert_to(packet::text,'UTF8')),'hex');
    readiness := jsonb_build_object('packetKind','article','workId',work,'signalId',packet->>'signalId',
      'sourceType','news','packetId',packet->>'packetId',
      'sourceCoverage',jsonb_build_object('sourceUrl',article->>'sourceUrl','capturedAt',article->>'capturedAt',
        'contentHash',article->>'contentHash','placementCount',jsonb_array_length(packet->'memberships')),
      'outcome','ready_for_entity');
    rdigest := encode(sha256(convert_to(readiness::text,'UTF8')),'hex');
    INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
      VALUES(op,'w2-harness',1,clock_timestamp() + interval '6 hours')
      ON CONFLICT DO NOTHING;
    -- The commit path requires the source before its planning context (FK).
    INSERT INTO managed_knowledge_private.sources(work_id,packet_digest,packet,readiness,readiness_digest,source,source_refs,retrieved_evidence)
      VALUES(work,pdigest,packet,readiness,rdigest,'news',jsonb_build_array('signal-w2-' || c.k),'[]'::jsonb)
      ON CONFLICT (work_id) DO UPDATE SET packet_digest = EXCLUDED.packet_digest;
    INSERT INTO w2_inputs(k,kind,input) VALUES (c.k || '_1src','source',jsonb_build_object(
      'source','news','workId',work,'packet',packet,'packetDigest',pdigest,'readiness',readiness,
      'readinessDigest',rdigest,'sourceRefs',jsonb_build_array('signal-w2-' || c.k),
      'packetCanonical',packet::text,'readinessCanonical',readiness::text));
    IF c.k = 'hold' THEN
      input := jsonb_build_object('operationId',op,'workId',work,'owner','w2-harness','epoch',1,
        'reason','waiting on the migration window harness case',
        'missingDependency','entity summary review harness case',
        'attemptDigest',encode(sha256(convert_to('attempt-' || c.k,'UTF8')),'hex'),
        'contentDigest',encode(sha256(convert_to(jsonb_build_object(
          'schemaVersion','myboon.article_hold.v1',
          'reason','waiting on the migration window harness case',
          'missingDependency','entity summary review harness case',
          'retainedPayload',packet)::text,'UTF8')),'hex'),
        'retainedPayload',packet,
        'retainedCanonical',packet::text,
        'contentCanonical',jsonb_build_object('schemaVersion','myboon.article_hold.v1',
          'reason','waiting on the migration window harness case',
          'missingDependency','entity summary review harness case','retainedPayload',packet)::text);
      INSERT INTO w2_inputs(k,kind,input) VALUES (c.k || '_2act',c.kind,input);
    ELSE
      ctx := repeat('e',64);
      INSERT INTO managed_knowledge_private.planning_contexts(work_id,context_digest,watermark,entities,item_revisions,snapshot)
        VALUES(work,ctx,1,'[]'::jsonb,'{}'::jsonb,jsonb_build_object('harness',true))
        ON CONFLICT DO NOTHING;
      effect := CASE c.k
        WHEN 'reuse' THEN jsonb_build_object('kind','article_source_attachment','itemId',NULL,
          'article',article,'memberships',members,
          'duplicateTarget',jsonb_build_object('source','managed','itemId',managed_i::text,'entityId',managed_e::text))
        ELSE jsonb_build_object('kind','article_item','itemId',item::text,'article',article,'memberships',members)
      END;
      plan := jsonb_build_object('schemaVersion','myboon.article_progression_plan.v1','operationId',op,
        'workId',work,'packetDigest',pdigest,'contextDigest',ctx);
      plan := CASE c.k
        WHEN 'cat' THEN plan || jsonb_build_object('targetRevisions',
            jsonb_build_object(
              public_a::text, managed_knowledge_private.entity_revision_v1(public_a),
              public_b::text, managed_knowledge_private.entity_revision_v1(public_b)),
          'effect',effect,
          'entities',jsonb_build_array(
            jsonb_build_object('id',public_a::text,'name','Public Entity 1','slug','pub-1','aliases','[]'::jsonb,
              'catalogEntityId',public_a::text,'identityKey','article:entity-public-1',
              'revision',managed_knowledge_private.entity_revision_v1(public_a)),
            jsonb_build_object('id',public_b::text,'name','Public Entity 2','slug','pub-2','aliases','[]'::jsonb,
              'catalogEntityId',public_b::text,'identityKey','article:entity-public-2',
              'revision',managed_knowledge_private.entity_revision_v1(public_b))))
        WHEN 'create' THEN plan || jsonb_build_object('targetRevisions','{}'::jsonb,'effect',effect,
          'entities',jsonb_build_array(
            jsonb_build_object('id',new_entity::text,'name','Brand New Entity 900','slug','brand-new-entity-900',
              'aliases','[]'::jsonb,'catalogEntityId',NULL,'revision','absent',
              'identityKey','article:entity-new-900')))
        WHEN 'reuse' THEN plan || jsonb_build_object('targetRevisions',
            jsonb_build_object(managed_i::text,'item:1',managed_e::text,managed_knowledge_private.entity_revision_v1(managed_e)),
          'effect',effect,
          'entities',jsonb_build_array(
            jsonb_build_object('id',managed_e::text,'name','Managed Entity 1','slug','managed-1',
              'aliases','["ME1"]'::jsonb,'catalogEntityId',NULL,'identityKey','article:ent-1',
              'revision',managed_knowledge_private.entity_revision_v1(managed_e))))
        ELSE plan || jsonb_build_object('targetRevisions','{}'::jsonb,'effect',effect,
          'entities',jsonb_build_array(
            jsonb_build_object('id',new_entity::text,'name','Managed Entity 1','slug','dup-managed-1',
              'aliases','[]'::jsonb,'catalogEntityId',NULL,'revision','absent',
              'identityKey','article:entity-dup')))
      END;
      input := jsonb_build_object('operationId',op,'workId',work,'owner','w2-harness','epoch',1,
        'plan',plan,'planCanonical',plan::text,'planDigest',encode(sha256(convert_to(plan::text,'UTF8')),'hex'),
        'effects',jsonb_build_array(effect),'effectsCanonical',jsonb_build_array(effect)::text,
        'contentDigest',encode(sha256(convert_to(jsonb_build_array(effect)::text,'UTF8')),'hex'));
      INSERT INTO w2_inputs(k,kind,input) VALUES (c.k || '_2act',c.kind,input);
    END IF;
  END LOOP;
END
$seed$;
SELECT k, kind FROM w2_inputs ORDER BY k;