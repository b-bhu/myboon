-- Local throwaway-Postgres check for #341 Part B. Run after the full
-- migration chain (including 20261017180000_entity_summary_article_refresh.sql)
-- as superuser; it switches to a non-superuser executor login for the RPCs.
-- Not part of any deploy. Wrapped in BEGIN/ROLLBACK so it leaves nothing behind.
\set ON_ERROR_STOP 1
BEGIN;

-- 1. The unused Part A auto-refresh pieces are gone.
DO $t$
BEGIN
  ASSERT to_regclass('managed_knowledge_private.entity_summary_due') IS NULL, 'entity_summary_due still exists';
  ASSERT to_regprocedure('managed_knowledge_private.entity_summary_claim_due_v1(text,integer,integer)') IS NULL, 'entity_summary_claim_due_v1 still exists';
  ASSERT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace ns ON ns.oid=c.relnamespace
    WHERE ns.nspname='managed_knowledge_private' AND c.relkind='i' AND c.relname='entity_summary_due_ready'), 'entity_summary_due_ready still exists';
  ASSERT NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='managed_knowledge_private' AND table_name='entities'
    AND column_name IN ('items_since_summary','current_state','key_timeline','open_questions')), 'entities still has a dropped living-state column';
  ASSERT NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='managed_knowledge_private' AND table_name='entity_summary_history'
    AND column_name IN ('current_state','key_timeline','open_questions')), 'entity_summary_history still has a dropped snapshot column';
  ASSERT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid=p.pronamespace
    WHERE ns.nspname='managed_knowledge_private' AND (p.prosrc ILIKE '%entity_summary_due%' OR p.prosrc ILIKE '%items_since_summary%'
      OR p.prosrc ILIKE '%current_state%' OR p.prosrc ILIKE '%key_timeline%' OR p.prosrc ILIKE '%open_questions%')),
    'a managed_knowledge_private function still references a removed auto-refresh piece';
END $t$;

-- 2. The owner keeps column UPDATE on the summary columns and the revision.
DO $t$
BEGIN
  ASSERT has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities','summary','UPDATE'), 'owner lacks UPDATE on entities.summary';
  ASSERT has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities','summary_revision','UPDATE'), 'owner lacks UPDATE on entities.summary_revision';
  ASSERT has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities','summary_refreshed_at','UPDATE'), 'owner lacks UPDATE on entities.summary_refreshed_at';
  ASSERT has_column_privilege('myboon_knowledge_owner','managed_knowledge_private.entities','revision','UPDATE'), 'owner lacks UPDATE on entities.revision';
END $t$;

-- 3. Refresh/restore still work through a non-superuser executor login.
CREATE ROLE cs_writer LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT myboon_knowledge_executor TO cs_writer;
INSERT INTO managed_knowledge_private.leases VALUES('progression-v2:'||repeat('b',64),'fixture',1,now()+interval '1h');
INSERT INTO public.entities(id,slug,name,type,aliases,summary)
  VALUES('33333333-3333-3333-3333-333333333333','acme-341','Acme 341','organization','[]','S0');
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
  VALUES('33333333-3333-3333-3333-333333333333','catalog:acme-341','33333333-3333-3333-3333-333333333333','{}','progression-v2:'||repeat('b',64));
SET ROLE cs_writer;
DO $t$
DECLARE r jsonb; e constant uuid := '33333333-3333-3333-3333-333333333333';
BEGIN
  r := managed_knowledge_private.entity_summary_refresh_v1(jsonb_build_object('entityId',e,'expectedSummaryRevision',0,'summary','S1'));
  ASSERT r->>'status'='refreshed' AND (r->>'summaryRevision')::bigint=1, 'first refresh wins: '||r;
  r := managed_knowledge_private.entity_summary_refresh_v1(jsonb_build_object('entityId',e,'expectedSummaryRevision',0,'summary','S1b'));
  ASSERT r->>'status'='conflict', 'stale compare-and-set returns conflict, not a write';
  r := managed_knowledge_private.entity_summary_refresh_v1(jsonb_build_object('entityId',e,'expectedSummaryRevision',1,'summary','S2'));
  ASSERT r->>'status'='refreshed' AND (r->>'summaryRevision')::bigint=2, 'second refresh wins: '||r;
  r := managed_knowledge_private.entity_summary_restore_v1(jsonb_build_object('entityId',e,'expectedSummaryRevision',2,'restoreRevision',1));
  ASSERT r->>'status'='restored' AND (r->>'summaryRevision')::bigint=3 AND r->>'restoredFrom'='1', 'undo restores revision 1 as 3: '||r;
  BEGIN
    PERFORM managed_knowledge_private.entity_summary_refresh_v1(jsonb_build_object('entityId',e,'expectedSummaryRevision',3,'summary',repeat('x',4001)));
    ASSERT false, '4001-char summary must fail';
  EXCEPTION WHEN SQLSTATE 'MK011' THEN NULL; END;
END $t$;
RESET ROLE;
DO $t$
DECLARE e constant uuid := '33333333-3333-3333-3333-333333333333'; rec record;
BEGIN
  SELECT * INTO rec FROM managed_knowledge_private.entities WHERE id=e;
  ASSERT rec.summary='S1' AND rec.summary_revision=3, 'entity carries the restored summary at revision 3';
  ASSERT rec.summary_refreshed_at IS NOT NULL, 'summary_refreshed_at set';
  ASSERT (SELECT array_agg(summary_revision ORDER BY 1) FROM managed_knowledge_private.entity_summary_history WHERE entity_id=e) = '{0,1,2,3}', 'history has every revision';
  ASSERT (SELECT restored_from FROM managed_knowledge_private.entity_summary_history WHERE entity_id=e AND summary_revision=3)=1, 'restored_from=1 on revision 3';
  BEGIN UPDATE managed_knowledge_private.entity_summary_history SET summary='x' WHERE entity_id=e; ASSERT false;
  EXCEPTION WHEN SQLSTATE 'MK010' THEN NULL; END;
  BEGIN DELETE FROM managed_knowledge_private.entity_summary_history WHERE entity_id=e; ASSERT false;
  EXCEPTION WHEN SQLSTATE 'MK010' THEN NULL; END;
END $t$;

-- 4. article_writer_v1 carries the summary refresh hooks; the definer
--    functions stay SECURITY DEFINER and owned by myboon_knowledge_owner.
DO $t$
DECLARE src text; secdef boolean; fn_owner text;
BEGIN
  ASSERT to_regprocedure('managed_knowledge_private.article_writer_v1(text,jsonb)') IS NOT NULL, 'article_writer_v1 missing';
  SELECT prosrc, prosecdef, pg_catalog.pg_get_userbyid(proowner) INTO src, secdef, fn_owner
    FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('managed_knowledge_private.article_writer_v1(text,jsonb)');
  ASSERT src LIKE '%summaryUpdates%' AND src LIKE '%entity_summary_refresh_v1%', 'article_writer_v1 lacks the summaryUpdates hooks';
  ASSERT secdef AND fn_owner='myboon_knowledge_owner', 'article_writer_v1 must be SECURITY DEFINER owned by myboon_knowledge_owner';
  SELECT prosrc, prosecdef, pg_catalog.pg_get_userbyid(proowner) INTO src, secdef, fn_owner
    FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('managed_knowledge_private.entity_summary_refresh_v1(jsonb)');
  ASSERT src IS NOT NULL AND secdef AND fn_owner='myboon_knowledge_owner', 'entity_summary_refresh_v1 must be SECURITY DEFINER owned by myboon_knowledge_owner';
  SELECT prosrc, prosecdef, pg_catalog.pg_get_userbyid(proowner) INTO src, secdef, fn_owner
    FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('managed_knowledge_private.entity_summary_restore_v1(jsonb)');
  ASSERT src IS NOT NULL AND secdef AND fn_owner='myboon_knowledge_owner', 'entity_summary_restore_v1 must be SECURITY DEFINER owned by myboon_knowledge_owner';
END $t$;

DO $t$ BEGIN RAISE NOTICE 'entity summary article refresh checks: all passed'; END $t$;
ROLLBACK;