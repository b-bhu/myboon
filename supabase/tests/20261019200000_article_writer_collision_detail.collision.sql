-- #378 forced-collision check for article_writer_v1's MK003 duplicate detail.
-- Run ONLY against a disposable database with every migration applied, as a
-- superuser. It seeds rows, calls article_writer_v1('commit') as the dedicated
-- writer login (SET SESSION AUTHORIZATION myboon_v4_worker) and records the
-- SQLSTATE + DETAIL for each case. Everything is rolled back.
-- psql variable :mode is 'forward' (expect 'entity_resolution:<uuid>') or
-- 'rollback' (expect the old bare 'entity_resolution').
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE c378(k text PRIMARY KEY, input jsonb, expected text, got_state text, got_detail text);
GRANT ALL ON c378 TO myboon_v4_worker;

-- Catalogue rows (public.entities) and managed rows. The catalogue Bitcoin id
-- sorts BEFORE the managed one, so a managed-first match is visible.
INSERT INTO public.entities(id,slug,name,type,aliases,status) VALUES
  ('00000000-0000-4000-8000-000000000a01','bitcoin-catalog','Bitcoin','asset','[]','active'),
  ('00000000-0000-4000-8000-000000000a02','solana','Solana','asset','["SOL"]','active');
INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
  VALUES('progression-v2:' || repeat('0',64),'check-378-seed',1,clock_timestamp() + interval '1 hour');
INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation,name,slug,type,aliases,status) VALUES
  ('00000000-0000-4000-8000-000000000b09','article:asset:bitcoin','{"id":"00000000-0000-4000-8000-000000000b09","name":"Bitcoin","slug":"bitcoin","aliases":[]}','progression-v2:' || repeat('0',64),'Bitcoin','bitcoin','asset','[]','review'),
  ('00000000-0000-4000-8000-000000000b02','article:asset:ether','{"id":"00000000-0000-4000-8000-000000000b02","name":"Ether","slug":"ether","aliases":["ETH"]}','progression-v2:' || repeat('0',64),'Ether','ether','asset','["ETH"]','review'),
  ('00000000-0000-4000-8000-000000000b01','article:asset:eth-token','{"id":"00000000-0000-4000-8000-000000000b01","name":"ETH Token","slug":"eth-token","aliases":["ETH"]}','progression-v2:' || repeat('0',64),'ETH Token','eth-token','asset','["ETH"]','review');

-- One commit input per case. k, proposal name, proposal aliases, expected colliding id.
DO $seed$
DECLARE c record; n int := 0; op text; work text; packet jsonb; pdigest text; plan jsonb; effect jsonb; ctx text := repeat('e',64);
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('managed_before_catalogue','Bitcoin','[]'::jsonb,'00000000-0000-4000-8000-000000000b09'),
    ('catalogue_only_by_alias','SOL','[]'::jsonb,'00000000-0000-4000-8000-000000000a02'),
    ('two_managed_lowest_id','ETH','[]'::jsonb,'00000000-0000-4000-8000-000000000b01')
  ) AS t(k,name,aliases,expected) LOOP
    n := n + 1;
    op := 'progression-v2:' || repeat(n::text,64); work := 'work-378-' || n;
    packet := jsonb_build_object('schemaVersion','myboon.research_packet.article.v1','packetKind','article','workId',work,
      'article',jsonb_build_object('title','t','timelineSummary','s','sourceUrl','https://example.test/' || n),
      'memberships',jsonb_build_array(jsonb_build_object('role','primary','placementDisposition','no_match','entityId',NULL,'name',c.name,
        'creationProposal',jsonb_build_object('name',c.name,'type','asset','aliases',c.aliases),'creationDecision',jsonb_build_object('choice','accept'))));
    pdigest := encode(sha256(convert_to(packet::text,'UTF8')),'hex');
    INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at) VALUES(op,'check-378',1,clock_timestamp() + interval '1 hour');
    INSERT INTO managed_knowledge_private.sources(work_id,packet_digest,packet,readiness,readiness_digest,source,source_refs,retrieved_evidence)
      VALUES(work,pdigest,packet,'{}',repeat('c',64),'news','[]','[]');
    INSERT INTO managed_knowledge_private.planning_contexts(work_id,context_digest,watermark,entities,item_revisions,snapshot)
      VALUES(work,ctx,0,'[]','{}','{}');
    effect := jsonb_build_object('kind','article_item','itemId',gen_random_uuid(),'article',packet->'article','memberships',packet->'memberships');
    plan := jsonb_build_object('schemaVersion','myboon.article_progression_plan.v1','operationId',op,'workId',work,'packetDigest',pdigest,
      'contextDigest',ctx,'targetRevisions','{}'::jsonb,'effect',effect,
      'entities',jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'name',c.name,'slug','new-' || n,'aliases',c.aliases,
        'revision','absent','identityKey','article:asset:new-' || n)));
    INSERT INTO c378(k,input,expected) VALUES(c.k, jsonb_build_object('operationId',op,'workId',work,'owner','check-378','epoch',1,
      'plan',plan,'planCanonical',plan::text,'planDigest',encode(sha256(convert_to(plan::text,'UTF8')),'hex'),
      'effects',jsonb_build_array(effect),'effectsCanonical',jsonb_build_array(effect)::text,
      'contentDigest',encode(sha256(convert_to(jsonb_build_array(effect)::text,'UTF8')),'hex')), c.expected);
  END LOOP;
END
$seed$;

SET SESSION AUTHORIZATION myboon_v4_worker;
DO $call$
DECLARE r record; st text; dt text;
BEGIN
  FOR r IN SELECT k,input FROM c378 ORDER BY k LOOP
    BEGIN
      PERFORM managed_knowledge_private.article_writer_v1('commit', r.input);
      st := 'OK'; dt := NULL;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, dt = PG_EXCEPTION_DETAIL;
    END;
    UPDATE c378 SET got_state=st, got_detail=dt WHERE k=r.k;
  END LOOP;
END
$call$;
RESET SESSION AUTHORIZATION;

SELECT set_config('c378.mode', :'mode', true) \gset
DO $check$
DECLARE r record; want text;
BEGIN
  FOR r IN SELECT * FROM c378 ORDER BY k LOOP
    want := CASE WHEN current_setting('c378.mode') = 'forward' THEN 'entity_resolution:' || r.expected ELSE 'entity_resolution' END;
    IF r.got_state IS DISTINCT FROM 'MK003' OR r.got_detail IS DISTINCT FROM want THEN
      RAISE EXCEPTION 'check 378 % (%): want MK003/% got %/%', r.k, current_setting('c378.mode'), want, r.got_state, r.got_detail;
    END IF;
    RAISE NOTICE 'check 378 ok % (%): MK003 DETAIL=%', r.k, current_setting('c378.mode'), r.got_detail;
  END LOOP;
  IF EXISTS(SELECT 1 FROM managed_knowledge_private.entities WHERE identity_key LIKE 'article:asset:new-%') THEN
    RAISE EXCEPTION 'check 378: a colliding entity was created';
  END IF;
END
$check$;
ROLLBACK;
