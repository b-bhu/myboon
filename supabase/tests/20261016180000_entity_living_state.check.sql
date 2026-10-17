-- Local throwaway-Postgres check for #341 PR-A. Run after the migration chain
-- as superuser; it switches to a non-superuser executor login for the RPCs.
-- Not part of any deploy.
\set ON_ERROR_STOP 1
CREATE ROLE ls_writer LOGIN NOSUPERUSER NOBYPASSRLS; GRANT myboon_knowledge_executor TO ls_writer;
INSERT INTO managed_knowledge_private.leases VALUES('progression-v2:'||repeat('a',64),'fixture',1,now()+interval '1h');
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
  VALUES('11111111-1111-1111-1111-111111111111','catalog:acme','11111111-1111-1111-1111-111111111111','{}','progression-v2:'||repeat('a',64));
CREATE TEMP TABLE pins AS SELECT managed_knowledge_private.entity_revision_v1('11111111-1111-1111-1111-111111111111') v1,
  managed_knowledge_private.entity_revision_v2('11111111-1111-1111-1111-111111111111') v2;
GRANT SELECT ON pins TO ls_writer;
INSERT INTO managed_knowledge_private.entity_summary_due(entity_id,reason) VALUES('11111111-1111-1111-1111-111111111111','item_threshold');
SET ROLE ls_writer;
DO $t$
DECLARE r jsonb; e constant uuid := '11111111-1111-1111-1111-111111111111'; n int;
BEGIN
  SELECT count(*) INTO n FROM managed_knowledge_private.entity_summary_claim_due_v1('w1',10,60000);
  ASSERT n = 1, 'claim takes the due entity';
  SELECT count(*) INTO n FROM managed_knowledge_private.entity_summary_claim_due_v1('w2',10,60000);
  ASSERT n = 0, 'leased entity is not claimed twice';
  r := managed_knowledge_private.entity_summary_refresh_v1(jsonb_build_object('entityId',e,'expectedSummaryRevision',0,'summary','S1','currentState','C1','keyTimeline','[]'::jsonb,'openQuestions','[]'::jsonb,'sourceItemIds','[]'::jsonb,'model','m'));
  ASSERT r->>'status'='refreshed' AND (r->>'summaryRevision')::int=1, 'first refresh wins: '||r;
  r := managed_knowledge_private.entity_summary_refresh_v1(jsonb_build_object('entityId',e,'expectedSummaryRevision',0,'summary','S1b'));
  ASSERT r->>'status'='conflict', 'racing refresh on stale revision is a no-op';
  BEGIN
    PERFORM managed_knowledge_private.entity_summary_refresh_v1(jsonb_build_object('entityId',e,'expectedSummaryRevision',1,'summary',''));
    ASSERT false, 'empty summary must fail';
  EXCEPTION WHEN SQLSTATE 'MK011' THEN NULL; END;
  r := managed_knowledge_private.entity_summary_refresh_v1(jsonb_build_object('entityId',e,'expectedSummaryRevision',1,'summary','S2'));
  r := managed_knowledge_private.entity_summary_restore_v1(jsonb_build_object('entityId',e,'expectedSummaryRevision',2,'restoreRevision',1));
  ASSERT r->>'status'='restored' AND (r->>'summaryRevision')::int=3, 'undo restores N as N+1: '||r;
END $t$;
RESET ROLE;
DO $t$
DECLARE e constant uuid := '11111111-1111-1111-1111-111111111111'; rec record;
BEGIN
  SELECT * INTO rec FROM managed_knowledge_private.entities WHERE id=e;
  ASSERT rec.summary='S1' AND rec.summary_revision=3 AND rec.items_since_summary=0, 'entity state after undo';
  ASSERT (SELECT array_agg(summary_revision ORDER BY 1) FROM managed_knowledge_private.entity_summary_history WHERE entity_id=e) = '{0,1,2,3}', 'history has every revision';
  ASSERT (SELECT restored_from FROM managed_knowledge_private.entity_summary_history WHERE entity_id=e AND summary_revision=3)=1;
  ASSERT NOT EXISTS(SELECT 1 FROM managed_knowledge_private.entity_summary_due WHERE entity_id=e), 'refresh clears due row';
  ASSERT managed_knowledge_private.entity_revision_v2(e) = (SELECT v2 FROM pins), 'v2 pin survives summary refresh';
  ASSERT managed_knowledge_private.entity_revision_v1(e) = (SELECT v1 FROM pins), 'v1 pin unaffected by private living-state columns';
  ASSERT managed_knowledge_private.entity_revision_v2(e) LIKE 'managed2:%';
  UPDATE public.entities SET summary='catalog summary edit' WHERE id=e;
  ASSERT managed_knowledge_private.entity_revision_v2(e) = (SELECT v2 FROM pins), 'v2 ignores catalog summary';
  ASSERT managed_knowledge_private.entity_revision_v1(e) <> (SELECT v1 FROM pins), 'v1 still changes on catalog summary (expected; why writers must move to v2)';
  UPDATE public.entities SET name='Acme Corp' WHERE id=e;
  ASSERT managed_knowledge_private.entity_revision_v2(e) <> (SELECT v2 FROM pins), 'v2 still tracks identity';
  BEGIN UPDATE managed_knowledge_private.entity_summary_history SET summary='x' WHERE entity_id=e; ASSERT false;
  EXCEPTION WHEN SQLSTATE 'MK010' THEN NULL; END;
  BEGIN DELETE FROM managed_knowledge_private.entity_summary_history WHERE entity_id=e; ASSERT false;
  EXCEPTION WHEN SQLSTATE 'MK010' THEN NULL; END;
  RAISE NOTICE 'entity living state checks: all passed';
END $t$;
-- Executor role cannot read the private tables directly.
SET ROLE ls_writer;
DO $t$ BEGIN PERFORM 1 FROM managed_knowledge_private.entity_summary_history; ASSERT false, 'executor must not read history';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'executor direct read denied: ok'; END $t$;
RESET ROLE;
-- NULL inputs must raise MK011 (CAS / lease guards cannot be bypassed).
SET ROLE ls_writer;
DO $t$
DECLARE e text := '11111111-1111-1111-1111-111111111111'; cases jsonb[] := ARRAY[
  jsonb_build_object('expectedSummaryRevision',0,'restoreRevision',0),
  jsonb_build_object('entityId',e,'restoreRevision',0),
  jsonb_build_object('entityId',e,'expectedSummaryRevision',0)]; c jsonb;
BEGIN
  FOREACH c IN ARRAY cases LOOP
    BEGIN PERFORM managed_knowledge_private.entity_summary_restore_v1(c); ASSERT false, 'restore accepted NULL: '||c;
    EXCEPTION WHEN SQLSTATE 'MK011' THEN NULL; END;
  END LOOP;
  BEGIN PERFORM managed_knowledge_private.entity_summary_claim_due_v1('w',NULL,60000); ASSERT false, 'claim accepted NULL limit';
  EXCEPTION WHEN SQLSTATE 'MK011' THEN NULL; END;
  BEGIN PERFORM managed_knowledge_private.entity_summary_claim_due_v1('w',10,NULL); ASSERT false, 'claim accepted NULL lease';
  EXCEPTION WHEN SQLSTATE 'MK011' THEN NULL; END;
  BEGIN PERFORM managed_knowledge_private.entity_summary_claim_due_v1('w',0,60000); ASSERT false, 'claim accepted 0 limit';
  EXCEPTION WHEN SQLSTATE 'MK011' THEN NULL; END;
  BEGIN PERFORM managed_knowledge_private.entity_summary_claim_due_v1('w',10,0); ASSERT false, 'claim accepted 0 lease';
  EXCEPTION WHEN SQLSTATE 'MK011' THEN NULL; END;
  RAISE NOTICE 'null/non-positive input guards: all passed';
END $t$;
RESET ROLE;
