-- #342 PR-3 behaviour check. Disposable DB only, run as a superuser. Seeds the
-- managed knowledge store and the published tables, calls
-- merge_entities_v1 as a disposable executor LOGIN (the research context
-- executor and anon are also proven unable to run it), prints check|pass rows
-- plus the prod-like dry-run report, and rolls everything back.
-- psql -X -q -v ON_ERROR_STOP=1 -f supabase/tests/20261019220000_merge_entities_v1.behaviour.sql
--
-- Trigram bands (measured on throwaway PostgreSQL 17 / pg_trgm with the real
-- entity_name_key_v1 keys; scores are asserted directly below and printed):
--   attach [0.85,1):    'Marathon Digital Holdings' vs 'Marathon Digital Holding' = 0.8800
--   hold   [0.6,0.85):  'Token2049 Singapore' vs 'TOKEN2049 Singapore 2026'      = 0.7500
--                       'DogecoinVM' vs 'Dogecoin'                              = 0.6667
--   none   <0.6:        'Bitcoin ETF' vs 'Bitcoin Spot ETF'                     = 0.5294
--   DIFFERS FROM CTO SAMPLE rows are asserted at their REAL measured band:
--     'Metaplanet Inc' vs 'Metaplanet' = 0.6667 (CTO sample said ~0.90 attach;
--        on entity_name_key_v1 keys it lands in the hold band; 'Metaplanet Inc'
--        vs 'Metaplanet Inc.' collapses to one key, which fuzzy_entity_candidates_v1
--        excludes); 'Bitcoin Cash' vs 'Bitcoin' = 0.5385; 'USDGO' vs 'USDG' =
--        0.5714; 'Solana DvP' vs 'Solana' = 0.5455; 'Government of Israel' vs
--        'Government of Iran' = 0.5652 (CTO sample said hold [0.6,0.85) for all four).
\set ON_ERROR_STOP on
BEGIN;

-- Seed: leases (the merge's own audit lease is written by the function), one
-- source row for the items, nine managed entities (+1 catalogue-linked pair),
-- five items and seven membership rows (never deleted by the merge), one
-- article_relationships row and one entity_summary_history row for merged,
-- and two published narratives (+1 history row) that the merge must re-point.
INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
  VALUES('progression-v2:' || repeat('0',64),'behaviour-342-seed',1,clock_timestamp() + interval '1 hour'),
        ('progression-v2:' || repeat('f',64),'behaviour-342-seed',1,clock_timestamp() + interval '1 hour');
INSERT INTO managed_knowledge_private.sources(work_id,packet_digest,packet,readiness,readiness_digest,source,source_refs,retrieved_evidence)
  VALUES('work-merge-342',repeat('a',64),'{"schemaVersion":"myboon.research_packet.v1","packetId":"p-342"}'::jsonb,
         '{"schemaVersion":"myboon.research_readiness.v1"}'::jsonb,repeat('b',64),'news','[{"ref":"merge-342"}]'::jsonb,'{}'::jsonb);

-- Managed entities: S survivor, M merged (type mismatch reported, not refused),
-- R1 survivor already redirected away, R2 merged already a redirect target,
-- E2 the archived source of that redirect, MC a catalogue-linked identity
-- (public row + managed row share the id).
INSERT INTO public.entities(id,slug,name,type,status,aliases,metadata)
  VALUES('00000000-0000-4000-8000-000000000c04','halcyon-systems','Halcyon Systems','organization','active','[]'::jsonb,'{}'::jsonb);
INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation,name,slug,type,aliases,status,metadata)
SELECT id::uuid,'behaviour:' || slug,jsonb_build_object('id',id,'name',name,'slug',slug,'aliases','[]'::jsonb),
       'progression-v2:' || repeat('0',64),name,slug,type,aliases::jsonb,status,COALESCE(metadata::jsonb,'{}'::jsonb)
FROM (VALUES
  ('00000000-0000-4000-8000-000000000d01','Kestrel Group','kestrel-group','organization','active','["Kestrel Labs"]',NULL),
  ('00000000-0000-4000-8000-000000000d02','Marlow Collective','marlow-collective','company','active','["Marlow Co","Kestrel Group","Marlow Collective"]',NULL),
  ('00000000-0000-4000-8000-000000000d03','Wren Collective','wren-collective','company','active','[]','{"mergedInto":"00000000-0000-4000-8000-000000000d01"}'),
  ('00000000-0000-4000-8000-000000000d04','Osier Collective','osier-collective','company','active','[]',NULL),
  ('00000000-0000-4000-8000-000000000d05','Osier Group','osier-group','organization','archived','[]','{"mergedInto":"00000000-0000-4000-8000-000000000d04"}'),
  ('00000000-0000-4000-8000-000000000c04','Halcyon Systems','halcyon-systems','organization','active','[]',NULL)
) AS t(id,name,slug,type,status,aliases,metadata);
UPDATE managed_knowledge_private.entities
  SET metadata = jsonb_build_object('mergedInto','00000000-0000-4000-8000-000000000d01')
  WHERE id = '00000000-0000-4000-8000-000000000d03';
UPDATE managed_knowledge_private.entities
  SET metadata = jsonb_build_object('mergedInto','00000000-0000-4000-8000-000000000d04')
  WHERE id = '00000000-0000-4000-8000-000000000d05';
UPDATE managed_knowledge_private.entities
  SET catalog_entity_id = id
  WHERE id = '00000000-0000-4000-8000-000000000c04';

-- Items and memberships:
--   f01 survivor-only, f02/f03 merged-only (moved), f04 collides (survivor live
--   + merged live), f05 collides with the survivor row already removed (the
--   reactivation case). The merge touches {f02, f03, f04, f05}.
INSERT INTO managed_knowledge_private.items(id,note,payload,operation_id,work_id,observed_at)
SELECT id::uuid,note,'{}'::jsonb,'progression-v2:' || repeat('0',64),'work-merge-342',now()
FROM (VALUES
  ('00000000-0000-4000-8000-000000000f01','survivor only'),
  ('00000000-0000-4000-8000-000000000f02','merged only one'),
  ('00000000-0000-4000-8000-000000000f03','merged only two'),
  ('00000000-0000-4000-8000-000000000f04','collision both live'),
  ('00000000-0000-4000-8000-000000000f05','survivor removed + merged live')
) AS t(id,note);
INSERT INTO managed_knowledge_private.item_heads(item_id)
  SELECT id::uuid FROM (VALUES ('00000000-0000-4000-8000-000000000f01'),('00000000-0000-4000-8000-000000000f02'),
    ('00000000-0000-4000-8000-000000000f03'),('00000000-0000-4000-8000-000000000f04'),('00000000-0000-4000-8000-000000000f05')) t(id);
INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation,removed_operation)
VALUES
  ('00000000-0000-4000-8000-000000000f01','00000000-0000-4000-8000-000000000d01','primary','progression-v2:' || repeat('0',64),NULL),
  ('00000000-0000-4000-8000-000000000f04','00000000-0000-4000-8000-000000000d01','primary','progression-v2:' || repeat('0',64),NULL),
  ('00000000-0000-4000-8000-000000000f05','00000000-0000-4000-8000-000000000d01','primary','progression-v2:' || repeat('0',64),'progression-v2:' || repeat('f',64)),
  ('00000000-0000-4000-8000-000000000f02','00000000-0000-4000-8000-000000000d02','primary','progression-v2:' || repeat('0',64),NULL),
  ('00000000-0000-4000-8000-000000000f03','00000000-0000-4000-8000-000000000d02','primary','progression-v2:' || repeat('0',64),NULL),
  ('00000000-0000-4000-8000-000000000f04','00000000-0000-4000-8000-000000000d02','related','progression-v2:' || repeat('0',64),NULL),
  ('00000000-0000-4000-8000-000000000f05','00000000-0000-4000-8000-000000000d02','related','progression-v2:' || repeat('0',64),NULL);
INSERT INTO managed_knowledge_private.article_relationships(item_id,entity_id,target_origin,target_item_id,relationship,decision,operation_id)
  VALUES('00000000-0000-4000-8000-000000000f02','00000000-0000-4000-8000-000000000d02','managed','00000000-0000-4000-8000-000000000f01','duplicate','{"reason":"behaviour-342"}','progression-v2:' || repeat('0',64));
INSERT INTO managed_knowledge_private.entity_summary_history(entity_id,summary_revision,summary)
  VALUES('00000000-0000-4000-8000-000000000d02',0,'seed summary for merged');

-- Two narratives and one history row reference the merged entity; the merge
-- re-points them (relationship guard fires on both re-point statements).
INSERT INTO public.published_narratives(id,content_small,title,entity_id,entity_slug,entity_name)
  VALUES('00000000-0000-4000-8000-000000000a01','seed pn one','PN one','00000000-0000-4000-8000-000000000d02','marlow-collective','Marlow Collective'),
        ('00000000-0000-4000-8000-000000000a02','seed pn two','PN two','00000000-0000-4000-8000-000000000d02','marlow-collective','Marlow Collective');
INSERT INTO public.entity_published_history(published_narrative_id,entity_id,entity_slug)
  VALUES('00000000-0000-4000-8000-000000000a01','00000000-0000-4000-8000-000000000d02','marlow-collective');

-- Trigram seeds: one managed entity per left name (fuzzy_entity_candidates_v1
-- from PR-2 excludes archived rows and identical name_keys).
INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation,name,slug,type,aliases,status,metadata)
SELECT id::uuid,'behaviour-trgm:' || slug,jsonb_build_object('id',id,'name',name,'slug',slug,'aliases','[]'::jsonb),
       'progression-v2:' || repeat('0',64),name,slug,'organization','[]'::jsonb,'active','{}'::jsonb
FROM (VALUES
  ('00000000-0000-4000-8000-000000000e01','Marathon Digital Holdings','marathon-digital-holdings'),
  ('00000000-0000-4000-8000-000000000e02','Token2049 Singapore','token2049-singapore'),
  ('00000000-0000-4000-8000-000000000e03','DogecoinVM','dogecoinvm'),
  ('00000000-0000-4000-8000-000000000e04','Metaplanet Inc','metaplanet-inc'),
  ('00000000-0000-4000-8000-000000000e05','Bitcoin ETF','bitcoin-etf'),
  ('00000000-0000-4000-8000-000000000e06','Bitcoin Cash','bitcoin-cash'),
  ('00000000-0000-4000-8000-000000000e07','USDGO','usdgo'),
  ('00000000-0000-4000-8000-000000000e08','Solana DvP','solana-dvp'),
  ('00000000-0000-4000-8000-000000000e09','Government of Israel','government-of-israel')
) AS t(id,name,slug);

-- Disposable executor/research LOGINs (the pattern of the dedicated logins
-- migration, without passwords - sessions are only ever authorized from here).
DO $roles$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'merge_entities_test_executor') THEN
    EXECUTE 'CREATE ROLE merge_entities_test_executor LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION';
    EXECUTE 'GRANT myboon_knowledge_executor TO merge_entities_test_executor';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'merge_entities_test_research') THEN
    EXECUTE 'CREATE ROLE merge_entities_test_research LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION';
    EXECUTE 'GRANT myboon_knowledge_context_executor TO merge_entities_test_research';
  END IF;
END
$roles$;

-- ===== executor session: dry runs, refusals, validation =====
SET SESSION AUTHORIZATION merge_entities_test_executor;
CREATE TEMP TABLE res342(key text PRIMARY KEY, state text, note text);

INSERT INTO res342 SELECT 'dry_main', NULL, managed_knowledge_private.merge_entities_v1('00000000-0000-4000-8000-000000000d01'::uuid,'00000000-0000-4000-8000-000000000d02'::uuid)::text;
INSERT INTO res342 SELECT 'dry_catalog', NULL, managed_knowledge_private.merge_entities_v1('00000000-0000-4000-8000-000000000d01'::uuid,'00000000-0000-4000-8000-000000000c04'::uuid)::text;
INSERT INTO res342 SELECT 'dry_survivor_redirected', NULL, managed_knowledge_private.merge_entities_v1('00000000-0000-4000-8000-000000000d03'::uuid,'00000000-0000-4000-8000-000000000d02'::uuid)::text;
INSERT INTO res342 SELECT 'dry_redirect_target', NULL, managed_knowledge_private.merge_entities_v1('00000000-0000-4000-8000-000000000d01'::uuid,'00000000-0000-4000-8000-000000000d04'::uuid)::text;

DO $refusals$
DECLARE target uuid := '00000000-0000-4000-8000-000000000d01'::uuid;
BEGIN
  BEGIN PERFORM managed_knowledge_private.merge_entities_v1(target,'00000000-0000-4000-8000-000000000c04'::uuid,false);
    INSERT INTO res342 VALUES('apply_catalog','NOERROR','merge unexpectedly succeeded');
  EXCEPTION WHEN OTHERS THEN INSERT INTO res342 VALUES('apply_catalog',SQLSTATE,SQLERRM); END;
  BEGIN PERFORM managed_knowledge_private.merge_entities_v1('00000000-0000-4000-8000-000000000d03'::uuid,'00000000-0000-4000-8000-000000000d02'::uuid,false);
    INSERT INTO res342 VALUES('apply_survivor_redirected','NOERROR','merge unexpectedly succeeded');
  EXCEPTION WHEN OTHERS THEN INSERT INTO res342 VALUES('apply_survivor_redirected',SQLSTATE,SQLERRM); END;
  BEGIN PERFORM managed_knowledge_private.merge_entities_v1(target,'00000000-0000-4000-8000-000000000d04'::uuid,false);
    INSERT INTO res342 VALUES('apply_redirect_target','NOERROR','merge unexpectedly succeeded');
  EXCEPTION WHEN OTHERS THEN INSERT INTO res342 VALUES('apply_redirect_target',SQLSTATE,SQLERRM); END;
END
$refusals$;
DO $validation$
DECLARE target uuid := '00000000-0000-4000-8000-000000000d01'::uuid;
BEGIN
  BEGIN PERFORM managed_knowledge_private.merge_entities_v1(target,target,false);
    INSERT INTO res342 VALUES('apply_same_id','NOERROR','merge unexpectedly succeeded');
  EXCEPTION WHEN OTHERS THEN INSERT INTO res342 VALUES('apply_same_id',SQLSTATE,SQLERRM); END;
  BEGIN PERFORM managed_knowledge_private.merge_entities_v1(NULL,target);
    INSERT INTO res342 VALUES('apply_null_survivor','NOERROR','merge unexpectedly succeeded');
  EXCEPTION WHEN OTHERS THEN INSERT INTO res342 VALUES('apply_null_survivor',SQLSTATE,SQLERRM); END;
  BEGIN PERFORM managed_knowledge_private.merge_entities_v1(target,'00000000-0000-4000-8000-000000000d99'::uuid);
    INSERT INTO res342 VALUES('apply_missing','NOERROR','merge unexpectedly succeeded');
  EXCEPTION WHEN OTHERS THEN INSERT INTO res342 VALUES('apply_missing',SQLSTATE,SQLERRM); END;
END
$validation$;

CREATE TEMP TABLE r_fuzzy(q text, out jsonb);
INSERT INTO r_fuzzy SELECT q, managed_knowledge_private.fuzzy_entity_candidates_v1(jsonb_build_object('name',name))
FROM (VALUES
  ('attach','Marathon Digital Holding'),
  ('hold_token2049','TOKEN2049 Singapore 2026'),
  ('hold_dogecoin','Dogecoin'),
  ('hold_metaplanet','Metaplanet'),
  ('none_spot_etf','Bitcoin Spot ETF'),
  ('none_bitcoin','Bitcoin'),
  ('none_usdg','USDG'),
  ('none_solana','Solana'),
  ('none_iran','Government of Iran')
) AS t(q,name);
RESET SESSION AUTHORIZATION;

-- Postgres confirms the dry runs did not touch any data (captured before the
-- apply below).
INSERT INTO res342 SELECT 'dry_no_change', NULL, jsonb_build_object(
  'survivorLiveMemberships', (SELECT count(*) FROM managed_knowledge_private.memberships WHERE entity_id = '00000000-0000-4000-8000-000000000d01'::uuid AND removed_operation IS NULL),
  'mergedLiveMemberships', (SELECT count(*) FROM managed_knowledge_private.memberships WHERE entity_id = '00000000-0000-4000-8000-000000000d02'::uuid AND removed_operation IS NULL),
  'mergedMembershipRows', (SELECT count(*) FROM managed_knowledge_private.memberships WHERE entity_id = '00000000-0000-4000-8000-000000000d02'::uuid),
  'maxItemHeadRevision', (SELECT coalesce(max(revision),0) FROM managed_knowledge_private.item_heads),
  'mergedStatus', (SELECT status FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid),
  'mergedHasRedirect', EXISTS (SELECT 1 FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid AND metadata ? 'mergedInto'),
  'survivorAliases', (SELECT aliases::text FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d01'::uuid),
  'mergedAliasCount', (SELECT jsonb_array_length(aliases) FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid),
  'narrativesForMerged', (SELECT count(*) FROM public.published_narratives WHERE entity_id = '00000000-0000-4000-8000-000000000d02'::uuid),
  'historyForMerged', (SELECT count(*) FROM public.entity_published_history WHERE entity_id = '00000000-0000-4000-8000-000000000d02'::uuid)
)::text;

-- Denials: each capture block briefly authorizes a disposable/non-executor
-- role, calls the merge, then restores the superuser session before writing
-- the captured SQLSTATE into res_deny (temp-schema privileges cannot be granted
-- across roles, so the result write must happen back under postgres).
CREATE TEMP TABLE res_deny(key text PRIMARY KEY, state text, note text);
DO $denials$
DECLARE
  st text; msg text; survivor uuid := '00000000-0000-4000-8000-000000000d01'::uuid; merged uuid := '00000000-0000-4000-8000-000000000d02'::uuid;
BEGIN
  BEGIN
    SET SESSION AUTHORIZATION anon;
    PERFORM managed_knowledge_private.merge_entities_v1(survivor, merged);
    st := 'NOERROR'; msg := 'merge unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE; msg := SQLERRM; END;
  RESET SESSION AUTHORIZATION;
  INSERT INTO res_deny VALUES('deny_anon', st, msg);

  BEGIN
    SET SESSION AUTHORIZATION merge_entities_test_research;
    PERFORM managed_knowledge_private.merge_entities_v1(survivor, merged);
    st := 'NOERROR'; msg := 'merge unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE; msg := SQLERRM; END;
  RESET SESSION AUTHORIZATION;
  INSERT INTO res_deny VALUES('deny_research', st, msg);

  BEGIN
    SET SESSION AUTHORIZATION myboon_knowledge_owner;
    PERFORM managed_knowledge_private.merge_entities_v1(survivor, merged);
    st := 'NOERROR'; msg := 'merge unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE; msg := SQLERRM; END;
  RESET SESSION AUTHORIZATION;
  INSERT INTO res_deny VALUES('deny_owner', st, msg);
END
$denials$;

-- ===== executor session: the real apply, then the archived re-apply =====
SET SESSION AUTHORIZATION merge_entities_test_executor;
INSERT INTO res342 SELECT 'apply_main', NULL, managed_knowledge_private.merge_entities_v1('00000000-0000-4000-8000-000000000d01'::uuid,'00000000-0000-4000-8000-000000000d02'::uuid,false)::text;
DO $reapply$ DECLARE target uuid := '00000000-0000-4000-8000-000000000d01'::uuid; BEGIN
  BEGIN PERFORM managed_knowledge_private.merge_entities_v1(target,'00000000-0000-4000-8000-000000000d02'::uuid);
    INSERT INTO res342 VALUES('reapply_archived','NOERROR','merge unexpectedly succeeded');
  EXCEPTION WHEN OTHERS THEN INSERT INTO res342 VALUES('reapply_archived',SQLSTATE,SQLERRM); END;
END $reapply$;
RESET SESSION AUTHORIZATION;

-- ===== prod-like dry run output =====
SELECT 'prod-like dry run report (jsonb_pretty):' AS info;
SELECT jsonb_pretty(note::jsonb) FROM res342 WHERE key = 'dry_main';
SELECT key || ': ' || COALESCE(state,'ok') || ' ' || note FROM res342 WHERE key LIKE 'dry_%' OR state IS NOT NULL ORDER BY key;
SELECT key || ': SQLSTATE=' || state || ' ' || note FROM res_deny ORDER BY key;
SELECT q || ' -> ' || (SELECT string_agg((c->>'name') || '@' || (c->>'similarity'), ', ' ORDER BY (c->>'similarity')::numeric DESC) FROM jsonb_array_elements(out->'candidates') c) FROM r_fuzzy ORDER BY q;
SELECT left_name || ' vs ' || right_name || ' (key ' || managed_knowledge_private.entity_name_key_v1(left_name) || '/' || managed_knowledge_private.entity_name_key_v1(right_name) || ') score=' || round(extensions.similarity(managed_knowledge_private.entity_name_key_v1(left_name), managed_knowledge_private.entity_name_key_v1(right_name))::numeric,4)
FROM (VALUES
  ('Marathon Digital Holdings','Marathon Digital Holding'),
  ('Token2049 Singapore','TOKEN2049 Singapore 2026'),
  ('DogecoinVM','Dogecoin'),
  ('Metaplanet Inc','Metaplanet'),
  ('Bitcoin ETF','Bitcoin Spot ETF'),
  ('Bitcoin Cash','Bitcoin'),
  ('USDGO','USDG'),
  ('Solana DvP','Solana'),
  ('Government of Israel','Government of Iran')
) AS p(left_name,right_name);

SELECT check_name || '|' || pass FROM (
  SELECT
  '01 dry run is the default and reports without applying' AS check_name,
  ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->>'dryRun') = 'true'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->>'applied') = 'false'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->>'canApply') = 'true'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->'refusals') = '[]'::jsonb
    AS pass
  UNION ALL SELECT '02 dry run counts are exact',
    ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->'counts')->>'membershipsToMove' = '2'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->'counts')->>'membershipsCollidingWithSurvivor' = '2'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->'counts')->>'itemHeadsRevisionBumped' = '4'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->'counts')->>'aliasesMoved' = '2'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->'counts')->>'articleRelationshipsLeftInPlace' = '1'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->'counts')->>'summaryRowsLeftInPlace' = '1'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->'counts'->'publicationsToRepoint')->>'narratives' = '2'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->'counts'->'publicationsToRepoint')->>'history' = '1'
  UNION ALL SELECT '03 dry run changed no data',
    ((SELECT note::jsonb FROM res342 WHERE key='dry_no_change')->>'survivorLiveMemberships') = '2'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_no_change')->>'mergedLiveMemberships') = '4'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_no_change')->>'mergedMembershipRows') = '4'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_no_change')->>'maxItemHeadRevision') = '1'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_no_change')->>'mergedStatus') = 'active'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_no_change')->>'mergedHasRedirect') = 'false'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_no_change')->>'survivorAliases') = '["Kestrel Labs"]'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_no_change')->>'mergedAliasCount') = '3'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_no_change')->>'narrativesForMerged') = '2'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_no_change')->>'historyForMerged') = '1'
  UNION ALL SELECT '04 catalogue-linked merged is refused (dry report + real 55000)',
    ((SELECT note::jsonb FROM res342 WHERE key='dry_catalog')->>'canApply') = 'false'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(((SELECT note::jsonb FROM res342 WHERE key='dry_catalog')->'refusals')) r WHERE r->>'reason' LIKE '%catalogue%')
    AND (SELECT state FROM res342 WHERE key='apply_catalog') = '55000'
  UNION ALL SELECT '05 survivor already redirected away is refused',
    ((SELECT note::jsonb FROM res342 WHERE key='dry_survivor_redirected')->>'canApply') = 'false'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(((SELECT note::jsonb FROM res342 WHERE key='dry_survivor_redirected')->'refusals')) r WHERE r->>'reason' LIKE '%redirected away%')
    AND (SELECT state FROM res342 WHERE key='apply_survivor_redirected') = '55000'
  UNION ALL SELECT '06 merged already a redirect target is refused (one hop)',
    ((SELECT note::jsonb FROM res342 WHERE key='dry_redirect_target')->>'canApply') = 'false'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(((SELECT note::jsonb FROM res342 WHERE key='dry_redirect_target')->'refusals')) r WHERE r->>'reason' LIKE '%one hop%')
    AND (SELECT state FROM res342 WHERE key='apply_redirect_target') = '55000'
  UNION ALL SELECT '07 type difference is only reported (apply still proceeded)',
    ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->>'typeMismatch') = 'true'
    AND ((SELECT note::jsonb FROM res342 WHERE key='apply_main')->>'applied') = 'true'
  UNION ALL SELECT '08 apply returns the same report shape with applied=true',
    ((SELECT note::jsonb FROM res342 WHERE key='dry_main')->'counts') = ((SELECT note::jsonb FROM res342 WHERE key='apply_main')->'counts')
    AND ((SELECT note::jsonb FROM res342 WHERE key='apply_main')->>'dryRun') = 'false'
    AND ((SELECT note::jsonb FROM res342 WHERE key='apply_main')->>'canApply') = 'true'
) AS t(check_name, pass);

SELECT check_name || '|' || pass FROM (
  SELECT
  '09 memberships moved without deletes (7 rows before and after)' AS check_name,
  (SELECT count(*) FROM managed_knowledge_private.memberships) = 7
    AND (SELECT count(*) FROM managed_knowledge_private.memberships WHERE entity_id = '00000000-0000-4000-8000-000000000d01'::uuid AND removed_operation IS NULL) = 5
    AND (SELECT count(*) FROM managed_knowledge_private.memberships WHERE entity_id = '00000000-0000-4000-8000-000000000d02'::uuid AND removed_operation IS NULL) = 0
    AND (SELECT count(*) FROM managed_knowledge_private.memberships WHERE entity_id = '00000000-0000-4000-8000-000000000d02'::uuid AND removed_operation = 'progression-v2:' || encode(sha256(convert_to('merge_entities_v1:00000000-0000-4000-8000-000000000d01:00000000-0000-4000-8000-000000000d02','UTF8')),'hex')) = 2
    AND EXISTS (SELECT 1 FROM managed_knowledge_private.memberships WHERE item_id = '00000000-0000-4000-8000-000000000f02'::uuid AND entity_id = '00000000-0000-4000-8000-000000000d01'::uuid AND removed_operation IS NULL)
    AND EXISTS (SELECT 1 FROM managed_knowledge_private.memberships WHERE item_id = '00000000-0000-4000-8000-000000000f03'::uuid AND entity_id = '00000000-0000-4000-8000-000000000d01'::uuid AND removed_operation IS NULL)
    AS pass
  UNION ALL SELECT '10 collisions: survivor row kept/reactivated, merged row tombstoned',
    NOT EXISTS (SELECT 1 FROM managed_knowledge_private.memberships WHERE item_id = '00000000-0000-4000-8000-000000000f04'::uuid AND entity_id = '00000000-0000-4000-8000-000000000d01'::uuid AND removed_operation IS NOT NULL)
    AND EXISTS (SELECT 1 FROM managed_knowledge_private.memberships WHERE item_id = '00000000-0000-4000-8000-000000000f05'::uuid AND entity_id = '00000000-0000-4000-8000-000000000d01'::uuid AND removed_operation IS NULL)
    AND EXISTS (SELECT 1 FROM managed_knowledge_private.memberships WHERE item_id = '00000000-0000-4000-8000-000000000f04'::uuid AND entity_id = '00000000-0000-4000-8000-000000000d02'::uuid AND removed_operation = 'progression-v2:' || encode(sha256(convert_to('merge_entities_v1:00000000-0000-4000-8000-000000000d01:00000000-0000-4000-8000-000000000d02','UTF8')),'hex'))
    AND EXISTS (SELECT 1 FROM managed_knowledge_private.memberships WHERE item_id = '00000000-0000-4000-8000-000000000f05'::uuid AND entity_id = '00000000-0000-4000-8000-000000000d02'::uuid AND removed_operation = 'progression-v2:' || encode(sha256(convert_to('merge_entities_v1:00000000-0000-4000-8000-000000000d01:00000000-0000-4000-8000-000000000d02','UTF8')),'hex'))
  UNION ALL SELECT '11 affected item heads bumped once, survivor-only head untouched',
    (SELECT count(*) FROM managed_knowledge_private.item_heads WHERE item_id = '00000000-0000-4000-8000-000000000f01'::uuid AND revision = 1) = 1
    AND (SELECT count(*) FROM managed_knowledge_private.item_heads WHERE item_id IN ('00000000-0000-4000-8000-000000000f02'::uuid,'00000000-0000-4000-8000-000000000f03'::uuid,'00000000-0000-4000-8000-000000000f04'::uuid,'00000000-0000-4000-8000-000000000f05'::uuid) AND revision = 2) = 4
    AND (SELECT count(*) FROM managed_knowledge_private.item_heads WHERE status = 'active') = 5
  UNION ALL SELECT '12 aliases moved onto the survivor with the name_key drop rule',
    (SELECT aliases FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d01'::uuid) = '["Kestrel Labs","Marlow Collective","Marlow Co"]'::jsonb
    AND (SELECT aliases FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid) = '[]'::jsonb
  UNION ALL SELECT '13 merged archived behind the ONE-HOP redirect with the audit blob',
    (SELECT status FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid) = 'archived'
    AND (SELECT revision FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid) = 2
    AND (SELECT revision FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d01'::uuid) = 2
    AND (SELECT metadata->>'mergedInto' FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid) = '00000000-0000-4000-8000-000000000d01'
    AND (SELECT metadata->'mergeAudit'->>'originalStatus' FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid) = 'active'
    AND (SELECT jsonb_array_length(metadata->'mergeAudit'->'originalAliases') FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid) = 3
    AND (SELECT metadata->'mergeAudit'->'movedItemIds' FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid) = '["00000000-0000-4000-8000-000000000f02","00000000-0000-4000-8000-000000000f03"]'::jsonb
    AND (SELECT metadata->'mergeAudit'->'collidedItemIds' FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid) = '["00000000-0000-4000-8000-000000000f04","00000000-0000-4000-8000-000000000f05"]'::jsonb
    AND (SELECT metadata->'mergeAudit'->>'at' FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid) IS NOT NULL
  UNION ALL SELECT '14 publications re-pointed to the survivor, row counts kept',
    (SELECT count(*) FROM public.published_narratives WHERE entity_id = '00000000-0000-4000-8000-000000000d01'::uuid AND entity_slug = 'kestrel-group' AND entity_name = 'Kestrel Group') = 2
    AND (SELECT count(*) FROM public.published_narratives WHERE entity_id = '00000000-0000-4000-8000-000000000d02'::uuid) = 0
    AND (SELECT count(*) FROM public.entity_published_history WHERE entity_id = '00000000-0000-4000-8000-000000000d01'::uuid AND entity_slug = 'kestrel-group') = 1
    AND (SELECT count(*) FROM public.entity_published_history WHERE entity_id = '00000000-0000-4000-8000-000000000d02'::uuid) = 0
  UNION ALL SELECT '15 deterministic audit lease written once',
    EXISTS (SELECT 1 FROM managed_knowledge_private.leases WHERE operation_id = 'progression-v2:' || encode(sha256(convert_to('merge_entities_v1:00000000-0000-4000-8000-000000000d01:00000000-0000-4000-8000-000000000d02','UTF8')),'hex') AND owner = 'merge_entities_v1' AND epoch = 1)
  UNION ALL SELECT '16 re-apply after the merge fails validation with 22023',
    (SELECT state FROM res342 WHERE key='reapply_archived') = '22023'
    AND (SELECT note FROM res342 WHERE key='reapply_archived') LIKE '%archived%'
  UNION ALL SELECT '17 same id raises 22023',
    (SELECT state FROM res342 WHERE key='apply_same_id') = '22023'
    AND (SELECT note FROM res342 WHERE key='apply_same_id') LIKE '%different%'
  UNION ALL SELECT '18 null id raises 22023',
    (SELECT state FROM res342 WHERE key='apply_null_survivor') = '22023'
    AND (SELECT note FROM res342 WHERE key='apply_null_survivor') LIKE '%required%'
  UNION ALL SELECT '19 missing managed entity raises 22023',
    (SELECT state FROM res342 WHERE key='apply_missing') = '22023'
    AND (SELECT note FROM res342 WHERE key='apply_missing') LIKE '%existing managed entities%'
  UNION ALL SELECT '20 anon cannot execute (42501)',
    (SELECT state FROM res_deny WHERE key='deny_anon') = '42501'
  UNION ALL SELECT '21 research context executor cannot execute (42501)',
    (SELECT state FROM res_deny WHERE key='deny_research') = '42501'
  UNION ALL SELECT '22 executor-gate stops a non-executor caller that holds EXECUTE (owner)',
    (SELECT state FROM res_deny WHERE key='deny_owner') = '42501'
    AND (SELECT note FROM res_deny WHERE key='deny_owner') LIKE '%executor%'
  UNION ALL SELECT '23 lock order in the source: entities, then item_heads, then memberships',
    (WITH src AS (SELECT prosrc AS s FROM pg_catalog.pg_proc
                  WHERE oid = 'managed_knowledge_private.merge_entities_v1(uuid, uuid, boolean)'::regprocedure),
         m AS (SELECT position('FOR UPDATE' in s) AS p1,
                      position('FOR UPDATE' in s) + position('FOR UPDATE' in substr(s, position('FOR UPDATE' in s)+1)) AS p2,
                      position('FOR UPDATE' in s)
                      + position('FOR UPDATE' in substr(s, position('FOR UPDATE' in s)+1))
                      + position('FOR UPDATE' in substr(s,
                          position('FOR UPDATE' in s)
                          + position('FOR UPDATE' in substr(s, position('FOR UPDATE' in s)+1)) + 1)) AS p3,
                      s
               FROM src)
     SELECT p1 > 0 AND p1 < p2 AND p2 < p3
       AND position('entities' in substr(s, 1, p1)) > 0
       AND position('item_heads' in substr(s, p1, p2-p1)) > 0
       AND position('memberships' in substr(s, p2, p3-p2)) > 0
     FROM m)
  UNION ALL SELECT '24 trigram attach band [0.85,1): Marathon Digital Holdings vs Marathon Digital Holding',
    extensions.similarity(managed_knowledge_private.entity_name_key_v1('Marathon Digital Holdings'), managed_knowledge_private.entity_name_key_v1('Marathon Digital Holding')) >= 0.85
    AND extensions.similarity(managed_knowledge_private.entity_name_key_v1('Marathon Digital Holdings'), managed_knowledge_private.entity_name_key_v1('Marathon Digital Holding')) < 1
    AND EXISTS (SELECT 1 FROM r_fuzzy, jsonb_array_elements(out->'candidates') c WHERE q='attach' AND c->>'id'='00000000-0000-4000-8000-000000000e01' AND (c->>'similarity')::numeric >= 0.85 AND (c->>'similarity')::numeric < 1)
  UNION ALL SELECT '25 trigram hold band [0.6,0.85): Token2049 Singapore vs TOKEN2049 Singapore 2026',
    extensions.similarity(managed_knowledge_private.entity_name_key_v1('Token2049 Singapore'), managed_knowledge_private.entity_name_key_v1('TOKEN2049 Singapore 2026')) >= 0.6
    AND extensions.similarity(managed_knowledge_private.entity_name_key_v1('Token2049 Singapore'), managed_knowledge_private.entity_name_key_v1('TOKEN2049 Singapore 2026')) < 0.85
    AND EXISTS (SELECT 1 FROM r_fuzzy, jsonb_array_elements(out->'candidates') c WHERE q='hold_token2049' AND c->>'id'='00000000-0000-4000-8000-000000000e02' AND (c->>'similarity')::numeric >= 0.6 AND (c->>'similarity')::numeric < 0.85)
  UNION ALL SELECT '26 trigram hold band [0.6,0.85): DogecoinVM vs Dogecoin',
    extensions.similarity(managed_knowledge_private.entity_name_key_v1('DogecoinVM'), managed_knowledge_private.entity_name_key_v1('Dogecoin')) >= 0.6
    AND extensions.similarity(managed_knowledge_private.entity_name_key_v1('DogecoinVM'), managed_knowledge_private.entity_name_key_v1('Dogecoin')) < 0.85
    AND EXISTS (SELECT 1 FROM r_fuzzy, jsonb_array_elements(out->'candidates') c WHERE q='hold_dogecoin' AND c->>'id'='00000000-0000-4000-8000-000000000e03' AND (c->>'similarity')::numeric >= 0.6 AND (c->>'similarity')::numeric < 0.85)
  UNION ALL SELECT '27 trigram hold band (DIFFERS FROM CTO SAMPLE): Metaplanet Inc vs Metaplanet really scores 0.6667, not ~0.90',
    extensions.similarity(managed_knowledge_private.entity_name_key_v1('Metaplanet Inc'), managed_knowledge_private.entity_name_key_v1('Metaplanet')) >= 0.6
    AND extensions.similarity(managed_knowledge_private.entity_name_key_v1('Metaplanet Inc'), managed_knowledge_private.entity_name_key_v1('Metaplanet')) < 0.85
    AND EXISTS (SELECT 1 FROM r_fuzzy, jsonb_array_elements(out->'candidates') c WHERE q='hold_metaplanet' AND c->>'id'='00000000-0000-4000-8000-000000000e04' AND (c->>'similarity')::numeric >= 0.6 AND (c->>'similarity')::numeric < 0.85)
  UNION ALL SELECT '28 trigram none band <0.6: Bitcoin ETF vs Bitcoin Spot ETF',
    extensions.similarity(managed_knowledge_private.entity_name_key_v1('Bitcoin ETF'), managed_knowledge_private.entity_name_key_v1('Bitcoin Spot ETF')) < 0.6
    AND NOT EXISTS (SELECT 1 FROM r_fuzzy, jsonb_array_elements(out->'candidates') c WHERE q='none_spot_etf' AND c->>'id'='00000000-0000-4000-8000-000000000e05')
  UNION ALL SELECT '29 trigram none band (DIFFERS FROM CTO SAMPLE): Bitcoin Cash vs Bitcoin really scores 0.5385',
    extensions.similarity(managed_knowledge_private.entity_name_key_v1('Bitcoin Cash'), managed_knowledge_private.entity_name_key_v1('Bitcoin')) < 0.6
    AND NOT EXISTS (SELECT 1 FROM r_fuzzy, jsonb_array_elements(out->'candidates') c WHERE q='none_bitcoin' AND c->>'id'='00000000-0000-4000-8000-000000000e06')
  UNION ALL SELECT '30 trigram none band (DIFFERS FROM CTO SAMPLE): USDGO vs USDG really scores 0.5714',
    extensions.similarity(managed_knowledge_private.entity_name_key_v1('USDGO'), managed_knowledge_private.entity_name_key_v1('USDG')) < 0.6
    AND NOT EXISTS (SELECT 1 FROM r_fuzzy, jsonb_array_elements(out->'candidates') c WHERE q='none_usdg' AND c->>'id'='00000000-0000-4000-8000-000000000e07')
  UNION ALL SELECT '31 trigram none band (DIFFERS FROM CTO SAMPLE): Solana DvP vs Solana really scores 0.5455',
    extensions.similarity(managed_knowledge_private.entity_name_key_v1('Solana DvP'), managed_knowledge_private.entity_name_key_v1('Solana')) < 0.6
    AND NOT EXISTS (SELECT 1 FROM r_fuzzy, jsonb_array_elements(out->'candidates') c WHERE q='none_solana' AND c->>'id'='00000000-0000-4000-8000-000000000e08')
  UNION ALL SELECT '32 trigram none band (DIFFERS FROM CTO SAMPLE): Government of Israel vs Government of Iran really scores 0.5652',
    extensions.similarity(managed_knowledge_private.entity_name_key_v1('Government of Israel'), managed_knowledge_private.entity_name_key_v1('Government of Iran')) < 0.6
    AND NOT EXISTS (SELECT 1 FROM r_fuzzy, jsonb_array_elements(out->'candidates') c WHERE q='none_iran' AND c->>'id'='00000000-0000-4000-8000-000000000e09')
) AS t(check_name, pass);

ROLLBACK;