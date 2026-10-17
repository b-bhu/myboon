-- #343 PR-B check for 20261017093000_article_uncertain_memberships.sql.
-- Run ONLY against a disposable database that has every migration applied,
-- as a superuser (it uses SET SESSION AUTHORIZATION to call the readers as the
-- dedicated research login). Everything runs in one transaction and is rolled
-- back. Any failed expectation raises and aborts.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE c343(k text PRIMARY KEY, v jsonb);
GRANT ALL ON c343 TO myboon_v4_research;
INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
  VALUES('progression-v2:' || repeat('a',64),'check-343',1,clock_timestamp() + interval '1 hour');
INSERT INTO managed_knowledge_private.sources(work_id,packet_digest,packet,readiness,readiness_digest,source,source_refs,retrieved_evidence)
  VALUES('work-343',repeat('b',64),'{}','{}',repeat('c',64),'news','["ref-343"]','[]');
INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation) VALUES
  ('00000000-0000-4000-8000-000000000e01','check:certain','{"id":"00000000-0000-4000-8000-000000000e01","name":"Certain Co","slug":"certain-co","aliases":[]}','progression-v2:' || repeat('a',64)),
  ('00000000-0000-4000-8000-000000000e02','check:uncertain','{"id":"00000000-0000-4000-8000-000000000e02","name":"Unsure Co","slug":"unsure-co","aliases":[]}','progression-v2:' || repeat('a',64));
INSERT INTO managed_knowledge_private.items(id,note,payload,operation_id,work_id,observed_at) VALUES
  ('00000000-0000-4000-8000-0000000001a1','Certain item','{}','progression-v2:' || repeat('a',64),'work-343',clock_timestamp()),
  ('00000000-0000-4000-8000-0000000001a2','Uncertain item','{}','progression-v2:' || repeat('a',64),'work-343',clock_timestamp());
INSERT INTO managed_knowledge_private.item_heads(item_id) VALUES('00000000-0000-4000-8000-0000000001a1'),('00000000-0000-4000-8000-0000000001a2');
INSERT INTO managed_knowledge_private.item_sources(item_id,work_id,operation_id) VALUES
  ('00000000-0000-4000-8000-0000000001a1','work-343','progression-v2:' || repeat('a',64)),
  ('00000000-0000-4000-8000-0000000001a2','work-343','progression-v2:' || repeat('a',64));
INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation,placement_confidence,uncertain) VALUES
  ('00000000-0000-4000-8000-0000000001a1','00000000-0000-4000-8000-000000000e01','primary','progression-v2:' || repeat('a',64),0.95,false),
  ('00000000-0000-4000-8000-0000000001a2','00000000-0000-4000-8000-000000000e02','primary','progression-v2:' || repeat('a',64),0.44,true);
INSERT INTO c343 VALUES('revision_flagged',to_jsonb(managed_knowledge_private.entity_revision_v1('00000000-0000-4000-8000-000000000e02')));

SET SESSION AUTHORIZATION myboon_v4_research;
INSERT INTO c343 VALUES
  ('by_source',managed_knowledge_private.context_v1('{"source":"news","labels":[],"sourceRefs":["ref-343"],"entityIds":[],"itemIds":[]}')),
  ('by_entity',managed_knowledge_private.context_v1('{"source":"news","labels":[],"sourceRefs":[],"entityIds":["00000000-0000-4000-8000-000000000e02"],"itemIds":[]}')),
  ('by_item',managed_knowledge_private.context_v1('{"source":"news","labels":[],"sourceRefs":[],"entityIds":[],"itemIds":["00000000-0000-4000-8000-0000000001a2"]}')),
  ('article_recent',managed_knowledge_private.article_context_v1('{"source":"news","labels":[],"sourceRefs":[],"entityIds":["00000000-0000-4000-8000-000000000e02"],"itemIds":[],"historyMode":"recent"}'));
RESET SESSION AUTHORIZATION;

-- Control: the same rows marked certain are read back, so the filter is the cause.
UPDATE managed_knowledge_private.memberships SET uncertain=false WHERE item_id='00000000-0000-4000-8000-0000000001a2';
INSERT INTO c343 VALUES('revision_certain',to_jsonb(managed_knowledge_private.entity_revision_v1('00000000-0000-4000-8000-000000000e02')));
SET SESSION AUTHORIZATION myboon_v4_research;
INSERT INTO c343 VALUES
  ('control_by_entity',managed_knowledge_private.context_v1('{"source":"news","labels":[],"sourceRefs":[],"entityIds":["00000000-0000-4000-8000-000000000e02"],"itemIds":[]}')),
  ('control_article_recent',managed_knowledge_private.article_context_v1('{"source":"news","labels":[],"sourceRefs":[],"entityIds":["00000000-0000-4000-8000-000000000e02"],"itemIds":[],"historyMode":"recent"}'));
RESET SESSION AUTHORIZATION;

DO $check$
DECLARE r jsonb; ids text[];
BEGIN
  SELECT v INTO r FROM c343 WHERE k='by_source';
  ids := ARRAY(SELECT x->>'itemId' FROM jsonb_array_elements(r->'items') x);
  IF ids <> ARRAY['00000000-0000-4000-8000-0000000001a1'] THEN RAISE EXCEPTION 'context_v1 by source: expected only the certain item, got %',ids; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'entities') x WHERE x->>'id'='00000000-0000-4000-8000-000000000e02') THEN RAISE EXCEPTION 'context_v1 by source: uncertain membership made its entity a subject'; END IF;
  SELECT v INTO r FROM c343 WHERE k='by_entity';
  IF jsonb_array_length(r->'items') <> 0 THEN RAISE EXCEPTION 'context_v1 by entity: uncertain item read back: %',r->'items'; END IF;
  SELECT v INTO r FROM c343 WHERE k='by_item';
  IF jsonb_array_length(r->'items') <> 1 OR r->'items'->0->'entityIds' <> '[]'::jsonb THEN RAISE EXCEPTION 'context_v1 by item: uncertain membership listed in entityIds: %',r->'items'; END IF;
  SELECT v INTO r FROM c343 WHERE k='article_recent';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'articleItems') x WHERE x->>'itemId'='00000000-0000-4000-8000-0000000001a2') THEN RAISE EXCEPTION 'article_context_v1: uncertain item in story history'; END IF;
  SELECT v INTO r FROM c343 WHERE k='control_by_entity';
  IF jsonb_array_length(r->'items') <> 1 THEN RAISE EXCEPTION 'control: certain item not read back by context_v1: %',r->'items'; END IF;
  SELECT v INTO r FROM c343 WHERE k='control_article_recent';
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'articleItems') x WHERE x->>'itemId'='00000000-0000-4000-8000-0000000001a2') THEN RAISE EXCEPTION 'control: certain item not in article_context_v1 history'; END IF;
  IF (SELECT v FROM c343 WHERE k='revision_flagged') IS DISTINCT FROM (SELECT v FROM c343 WHERE k='revision_certain') THEN
    RAISE EXCEPTION 'entity_revision_v1 changed with the uncertain flag';
  END IF;
  RAISE NOTICE 'check 343 ok: context_v1 (source/entity/item) and article_context_v1 skip uncertain; control reads it when certain; entity_revision_v1 % unchanged',(SELECT v FROM c343 WHERE k='revision_flagged');
END
$check$;
ROLLBACK;
