-- #343 PR-B rollback check for supabase/rollbacks/20261017093000_article_uncertain_memberships.down.sql.
-- Run ONLY against a disposable database with every migration applied
-- (including 20261017093000), as a superuser, from the repo root:
--   psql ... -f supabase/tests/20261017093000_article_uncertain_memberships.rollback.check.sql
-- It seeds a certain and an uncertain membership, runs the rollback inside the
-- same transaction, and proves the uncertain row stays hidden from context_v1
-- and article_context_v1 afterwards (retired via removed_operation) while the
-- certain row is untouched. Everything is rolled back at the end.
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
INSERT INTO c343 SELECT 'before_revision',to_jsonb(revision) FROM managed_knowledge_private.item_heads WHERE item_id='00000000-0000-4000-8000-0000000001a2';
SET SESSION AUTHORIZATION myboon_v4_research;
INSERT INTO c343 VALUES
  ('pre_by_entity',managed_knowledge_private.context_v1('{"source":"news","labels":[],"sourceRefs":[],"entityIds":["00000000-0000-4000-8000-000000000e02"],"itemIds":[]}')),
  ('pre_by_item',managed_knowledge_private.context_v1('{"source":"news","labels":[],"sourceRefs":[],"entityIds":[],"itemIds":["00000000-0000-4000-8000-0000000001a2"]}')),
  ('pre_by_source',managed_knowledge_private.context_v1('{"source":"news","labels":[],"sourceRefs":["ref-343"],"entityIds":[],"itemIds":[]}')),
  ('pre_article_recent',managed_knowledge_private.article_context_v1('{"source":"news","labels":[],"sourceRefs":[],"entityIds":["00000000-0000-4000-8000-000000000e02"],"itemIds":[],"historyMode":"recent"}'));
RESET SESSION AUTHORIZATION;

\ir ../rollbacks/20261017093000_article_uncertain_memberships.down.sql

SET SESSION AUTHORIZATION myboon_v4_research;
INSERT INTO c343 VALUES
  ('post_by_entity',managed_knowledge_private.context_v1('{"source":"news","labels":[],"sourceRefs":[],"entityIds":["00000000-0000-4000-8000-000000000e02"],"itemIds":[]}')),
  ('post_by_item',managed_knowledge_private.context_v1('{"source":"news","labels":[],"sourceRefs":[],"entityIds":[],"itemIds":["00000000-0000-4000-8000-0000000001a2"]}')),
  ('post_by_source',managed_knowledge_private.context_v1('{"source":"news","labels":[],"sourceRefs":["ref-343"],"entityIds":[],"itemIds":[]}')),
  ('post_article_recent',managed_knowledge_private.article_context_v1('{"source":"news","labels":[],"sourceRefs":[],"entityIds":["00000000-0000-4000-8000-000000000e02"],"itemIds":[],"historyMode":"recent"}'));
RESET SESSION AUTHORIZATION;

DO $check$
DECLARE r jsonb; tag text; rollback_operation text := 'progression-v2:' || encode(sha256(convert_to('myboon.rollback.20261017093000_article_uncertain_memberships','UTF8')),'hex');
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid='managed_knowledge_private.memberships'::regclass AND attname IN ('uncertain','placement_confidence') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'rollback left the uncertainty columns in place';
  END IF;
  FOREACH tag IN ARRAY ARRAY['pre','post'] LOOP
    SELECT v INTO r FROM c343 WHERE k=tag || '_by_entity';
    IF jsonb_array_length(r->'items') <> 0 THEN RAISE EXCEPTION '% context_v1 by entity read the uncertain item: %',tag,r->'items'; END IF;
    SELECT v INTO r FROM c343 WHERE k=tag || '_by_item';
    IF jsonb_array_length(r->'items') <> 1 OR r->'items'->0->'entityIds' <> '[]'::jsonb THEN RAISE EXCEPTION '% context_v1 by item listed the uncertain membership: %',tag,r->'items'; END IF;
    SELECT v INTO r FROM c343 WHERE k=tag || '_by_source';
    IF ARRAY(SELECT x->>'itemId' FROM jsonb_array_elements(r->'items') x) <> ARRAY['00000000-0000-4000-8000-0000000001a1'] THEN RAISE EXCEPTION '% context_v1 by source: expected only the certain item: %',tag,r->'items'; END IF;
    SELECT v INTO r FROM c343 WHERE k=tag || '_article_recent';
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'articleItems') x WHERE x->>'itemId'='00000000-0000-4000-8000-0000000001a2') THEN RAISE EXCEPTION '% article_context_v1 read the uncertain item',tag; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM managed_knowledge_private.memberships WHERE item_id='00000000-0000-4000-8000-0000000001a2' AND removed_operation=rollback_operation) THEN
    RAISE EXCEPTION 'uncertain membership was not retired by the rollback lease';
  END IF;
  IF EXISTS(SELECT 1 FROM managed_knowledge_private.memberships WHERE item_id='00000000-0000-4000-8000-0000000001a1' AND removed_operation IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback retired a certain membership';
  END IF;
  IF (SELECT revision FROM managed_knowledge_private.item_heads WHERE item_id='00000000-0000-4000-8000-0000000001a2') <> (SELECT (v#>>'{}')::bigint FROM c343 WHERE k='before_revision') + 1 THEN
    RAISE EXCEPTION 'uncertain item head revision was not bumped exactly once';
  END IF;
  IF (SELECT expires_at > clock_timestamp() FROM managed_knowledge_private.leases WHERE operation_id=rollback_operation) THEN
    RAISE EXCEPTION 'rollback lease must already be expired';
  END IF;
  RAISE NOTICE 'rollback check 343 ok: uncertain row hidden before and after rollback (removed_operation=%), certain row untouched, revision bumped once',rollback_operation;
END
$check$;
ROLLBACK;
