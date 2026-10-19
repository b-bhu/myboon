-- #343 behavioural check: the stories/publisher reader
-- public.read_managed_entity_knowledge_v1 (20261017210000) never returns an
-- item through an uncertain membership.
-- Run ONLY against a disposable database that has every migration applied, as
-- a superuser (it seeds the private tables, then calls the reader as
-- service_role, the only role allowed to execute it). Everything runs in one
-- transaction and is rolled back. Any failed expectation raises and aborts.
-- Runner: supabase/tests/343_uncertain_readers.pg-test.sh
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE r343(k text PRIMARY KEY, v jsonb);
GRANT ALL ON r343 TO service_role;
INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
  VALUES('progression-v2:' || repeat('d',64),'check-343-reader',1,clock_timestamp() + interval '1 hour');
INSERT INTO managed_knowledge_private.sources(work_id,packet_digest,packet,readiness,readiness_digest,source,source_refs,retrieved_evidence)
  VALUES('work-343-reader',repeat('b',64),'{"packetId":"packet-343","signalId":"signal-343"}','{}',repeat('c',64),'news','["ref-343-reader"]','[]');
-- E1 is a certain entity, E2 only ever holds uncertain memberships.
INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation) VALUES
  ('00000000-0000-4000-8000-000000000f01','check:reader-certain','{"id":"00000000-0000-4000-8000-000000000f01","name":"Reader Certain Co","slug":"reader-certain-co","aliases":[]}','progression-v2:' || repeat('d',64)),
  ('00000000-0000-4000-8000-000000000f02','check:reader-uncertain','{"id":"00000000-0000-4000-8000-000000000f02","name":"Reader Unsure Co","slug":"reader-unsure-co","aliases":[]}','progression-v2:' || repeat('d',64));
-- A: E1 primary certain.            B: E2 primary uncertain only.
-- C: E1 primary certain + E2 related uncertain.
-- D: E2 primary uncertain + E1 related certain.
INSERT INTO managed_knowledge_private.items(id,note,payload,operation_id,work_id,observed_at) VALUES
  ('00000000-0000-4000-8000-0000000002a1','Item A','{}','progression-v2:' || repeat('d',64),'work-343-reader',clock_timestamp()),
  ('00000000-0000-4000-8000-0000000002b1','Item B','{}','progression-v2:' || repeat('d',64),'work-343-reader',clock_timestamp()),
  ('00000000-0000-4000-8000-0000000002c1','Item C','{}','progression-v2:' || repeat('d',64),'work-343-reader',clock_timestamp()),
  ('00000000-0000-4000-8000-0000000002d1','Item D','{}','progression-v2:' || repeat('d',64),'work-343-reader',clock_timestamp());
INSERT INTO managed_knowledge_private.item_heads(item_id) VALUES
  ('00000000-0000-4000-8000-0000000002a1'),('00000000-0000-4000-8000-0000000002b1'),
  ('00000000-0000-4000-8000-0000000002c1'),('00000000-0000-4000-8000-0000000002d1');
INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation,placement_confidence,uncertain) VALUES
  ('00000000-0000-4000-8000-0000000002a1','00000000-0000-4000-8000-000000000f01','primary','progression-v2:' || repeat('d',64),0.95,false),
  ('00000000-0000-4000-8000-0000000002b1','00000000-0000-4000-8000-000000000f02','primary','progression-v2:' || repeat('d',64),0.44,true),
  ('00000000-0000-4000-8000-0000000002c1','00000000-0000-4000-8000-000000000f01','primary','progression-v2:' || repeat('d',64),0.9,false),
  ('00000000-0000-4000-8000-0000000002c1','00000000-0000-4000-8000-000000000f02','related','progression-v2:' || repeat('d',64),0.3,true),
  ('00000000-0000-4000-8000-0000000002d1','00000000-0000-4000-8000-000000000f02','primary','progression-v2:' || repeat('d',64),0.37,true),
  ('00000000-0000-4000-8000-0000000002d1','00000000-0000-4000-8000-000000000f01','related','progression-v2:' || repeat('d',64),0.8,false);

SET LOCAL ROLE service_role;
INSERT INTO r343 VALUES
  ('all',public.read_managed_entity_knowledge_v1('observed-desc')),
  ('e1',public.read_managed_entity_knowledge_v1('event-desc',p_entity_id=>'00000000-0000-4000-8000-000000000f01')),
  ('e2',public.read_managed_entity_knowledge_v1('event-desc',p_entity_id=>'00000000-0000-4000-8000-000000000f02')),
  ('by_id_b',public.read_managed_entity_knowledge_v1('id-asc',p_memory_ids=>ARRAY['00000000-0000-4000-8000-0000000002b1']::uuid[]));
RESET ROLE;

-- Control: the same uncertain rows marked certain are read back, so the filter is the cause.
UPDATE managed_knowledge_private.memberships SET uncertain=false WHERE entity_id='00000000-0000-4000-8000-000000000f02';
SET LOCAL ROLE service_role;
INSERT INTO r343 VALUES
  ('e2_certain',public.read_managed_entity_knowledge_v1('event-desc',p_entity_id=>'00000000-0000-4000-8000-000000000f02')),
  ('by_id_b_certain',public.read_managed_entity_knowledge_v1('id-asc',p_memory_ids=>ARRAY['00000000-0000-4000-8000-0000000002b1']::uuid[]));
RESET ROLE;

DO $check$
DECLARE r jsonb; pairs text;
BEGIN
  SELECT v INTO r FROM r343 WHERE k='all';
  SELECT string_agg(x->>'id' || '>' || (x->>'entity_id'), ',' ORDER BY x->>'id') INTO pairs FROM jsonb_array_elements(r->'rows') x
    WHERE x->>'id' LIKE '00000000-0000-4000-8000-0000000002%';
  -- B is gone; C and D are read only through their certain E1 membership.
  IF pairs IS DISTINCT FROM '00000000-0000-4000-8000-0000000002a1>00000000-0000-4000-8000-000000000f01,'
    || '00000000-0000-4000-8000-0000000002c1>00000000-0000-4000-8000-000000000f01,'
    || '00000000-0000-4000-8000-0000000002d1>00000000-0000-4000-8000-000000000f01' THEN
    RAISE EXCEPTION 'unscoped read exposed an uncertain membership: %', pairs;
  END IF;
  SELECT v INTO r FROM r343 WHERE k='e1';
  IF jsonb_array_length(r->'rows') <> 3 OR (r->>'totalCount')::int <> 3 THEN RAISE EXCEPTION 'E1 should read A, C and D: %', r; END IF;
  SELECT v INTO r FROM r343 WHERE k='e2';
  IF jsonb_array_length(r->'rows') <> 0 OR (r->>'totalCount')::int <> 0 THEN RAISE EXCEPTION 'E2 story read exposed uncertain items: %', r; END IF;
  SELECT v INTO r FROM r343 WHERE k='by_id_b';
  IF jsonb_array_length(r->'rows') <> 0 THEN RAISE EXCEPTION 'id read exposed an uncertain-only item: %', r; END IF;
  SELECT v INTO r FROM r343 WHERE k='e2_certain';
  IF jsonb_array_length(r->'rows') <> 3 THEN RAISE EXCEPTION 'control: certain E2 should read B, C and D: %', r; END IF;
  SELECT v INTO r FROM r343 WHERE k='by_id_b_certain';
  IF jsonb_array_length(r->'rows') <> 1 THEN RAISE EXCEPTION 'control: certain B should be read by id: %', r; END IF;
  RAISE NOTICE 'check 343 reader ok: read_managed_entity_knowledge_v1 skips uncertain memberships (unscoped, entity-scoped, by id); control reads them when certain';
END
$check$;
ROLLBACK;
