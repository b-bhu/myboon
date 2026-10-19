-- #342 PR-4 behaviour check for 20261019231000_merge_entities_v1_counts.sql.
-- Disposable DB only, run as a superuser, inside BEGIN..ROLLBACK. Seeds three
-- merge scenarios, calls merge_entities_v1 as a disposable executor LOGIN (the
-- 20261019220000 pattern) and prints check|pass rows:
--   pair A d01 <- d02: the PR-3 flow still applies cleanly under the new
--     count guards, with a both-live collision the certain-row rule resolves
--     (uncertain survivor, certain merged), the reverse collision the rule
--     must NOT touch, and the survivor-removed reactivation; two narratives +
--     one history row are re-pointed so all three count guards hold.
--   pair B d16 <- d17: a trigger suppresses the one membership row that must
--     move; the merge refuses with ERRCODE 40001 naming the table and both
--     counts, and the caller's state is left untouched.
-- Expects the 20261019180000/20261019220000 grant/policy state.
-- psql -X -q -v ON_ERROR_STOP=1 -f supabase/tests/20261019231000_merge_entities_v1_counts.behaviour.sql

\set ON_ERROR_STOP on
BEGIN;

-- Seed: leases (audit + reactivation ops), one source row, four managed
-- entities (typed with kinds - the 20261019230000 CHECK is active), six items
-- and eight membership rows, two narratives (+1 history) for merged A.
INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
  VALUES('progression-v2:' || repeat('0',64),'behaviour-342b-seed',1,clock_timestamp() + interval '1 hour'),
        ('progression-v2:' || repeat('f',64),'behaviour-342b-seed',1,clock_timestamp() + interval '1 hour');
INSERT INTO managed_knowledge_private.sources(work_id,packet_digest,packet,readiness,readiness_digest,source,source_refs,retrieved_evidence)
  VALUES('work-merge-342b',repeat('a',64),'{"schemaVersion":"myboon.research_packet.v1","packetId":"p-342b"}'::jsonb,
         '{"schemaVersion":"myboon.research_readiness.v1"}'::jsonb,repeat('b',64),'news','[{"ref":"merge-342b"}]'::jsonb,'{}'::jsonb);

INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation,name,slug,type,aliases,status,metadata)
SELECT id::uuid,'behaviour342b:' || slug,jsonb_build_object('id',id,'name',name,'slug',slug,'aliases','[]'::jsonb),
       'progression-v2:' || repeat('0',64),name,slug,type,aliases::jsonb,status,'{}'::jsonb
FROM (VALUES
  ('00000000-0000-4000-8000-000000000d01','Kestrel Group','kestrel-group','organization','active','["Kestrel Sentinel"]'),
  ('00000000-0000-4000-8000-000000000d02','Marlow Collective','marlow-collective','organization','active','["Marlow Co"]'),
  ('00000000-0000-4000-8000-000000000d16','Rye Standard','rye-standard','event','active','[]'),
  ('00000000-0000-4000-8000-000000000d17','Fenwick Meeting','fenwick-meeting','event','active','[]')
) AS t(id,name,slug,type,status,aliases);

INSERT INTO managed_knowledge_private.items(id,note,payload,operation_id,work_id,observed_at)
SELECT id::uuid,note,'{}'::jsonb,'progression-v2:' || repeat('0',64),'work-merge-342b',now()
FROM (VALUES
  ('00000000-0000-4000-8000-000000000b01','survivor only'),
  ('00000000-0000-4000-8000-000000000b02','merged only one'),
  ('00000000-0000-4000-8000-000000000b03','merged only two'),
  ('00000000-0000-4000-8000-000000000b04','collision: survivor uncertain, merged certain'),
  ('00000000-0000-4000-8000-000000000b05','collision: survivor removed, merged live'),
  ('00000000-0000-4000-8000-000000000b06','collision: survivor certain, merged uncertain'),
  ('00000000-0000-4000-8000-000000000b11','pair B merged-only (suppressed in the test)')
) AS t(id,note);
INSERT INTO managed_knowledge_private.item_heads(item_id)
  SELECT id::uuid FROM (VALUES
    ('00000000-0000-4000-8000-000000000b01'),('00000000-0000-4000-8000-000000000b02'),('00000000-0000-4000-8000-000000000b03'),
    ('00000000-0000-4000-8000-000000000b04'),('00000000-0000-4000-8000-000000000b05'),('00000000-0000-4000-8000-000000000b06'),
    ('00000000-0000-4000-8000-000000000b11')) t(id);
-- Collision matrix on pair A (survivor d01 / merged d02):
--   b04 both live,   survivor uncertain (NULL confidence), merged certain 0.85 -> survivor becomes certain
--   b05 survivor removed, merged live -> survivor reactivated (PR-3 rule kept)
--   b06 both live,   survivor certain 0.30, merged uncertain 0.42 -> survivor untouched
INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation,removed_operation,placement_confidence,uncertain)
VALUES
  ('00000000-0000-4000-8000-000000000b01','00000000-0000-4000-8000-000000000d01','primary','progression-v2:' || repeat('0',64),NULL,NULL,false),
  ('00000000-0000-4000-8000-000000000b02','00000000-0000-4000-8000-000000000d02','primary','progression-v2:' || repeat('0',64),NULL,NULL,false),
  ('00000000-0000-4000-8000-000000000b03','00000000-0000-4000-8000-000000000d02','related','progression-v2:' || repeat('0',64),NULL,NULL,false),
  ('00000000-0000-4000-8000-000000000b04','00000000-0000-4000-8000-000000000d01','related','progression-v2:' || repeat('0',64),NULL,NULL,true),
  ('00000000-0000-4000-8000-000000000b04','00000000-0000-4000-8000-000000000d02','related','progression-v2:' || repeat('0',64),NULL,0.85,false),
  ('00000000-0000-4000-8000-000000000b05','00000000-0000-4000-8000-000000000d01','related','progression-v2:' || repeat('0',64),'progression-v2:' || repeat('f',64),NULL,false),
  ('00000000-0000-4000-8000-000000000b05','00000000-0000-4000-8000-000000000d02','related','progression-v2:' || repeat('0',64),NULL,NULL,false),
  ('00000000-0000-4000-8000-000000000b06','00000000-0000-4000-8000-000000000d01','related','progression-v2:' || repeat('0',64),NULL,0.30,false),
  ('00000000-0000-4000-8000-000000000b06','00000000-0000-4000-8000-000000000d02','related','progression-v2:' || repeat('0',64),NULL,0.42,true),
  ('00000000-0000-4000-8000-000000000b11','00000000-0000-4000-8000-000000000d17','primary','progression-v2:' || repeat('0',64),NULL,NULL,false);
INSERT INTO public.published_narratives(id,content_small,title,entity_id,entity_slug,entity_name)
  VALUES('00000000-0000-4000-8000-000000000a01','seed pn one','PN one','00000000-0000-4000-8000-000000000d02','marlow-collective','Marlow Collective'),
        ('00000000-0000-4000-8000-000000000a02','seed pn two','PN two','00000000-0000-4000-8000-000000000d02','marlow-collective','Marlow Collective');
INSERT INTO public.entity_published_history(published_narrative_id,entity_id,entity_slug)
  VALUES('00000000-0000-4000-8000-000000000a01','00000000-0000-4000-8000-000000000d02','marlow-collective');

-- Disposable executor LOGIN (no password; sessions are authorized from here).
DO $roles$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'merge_counts_test_executor') THEN
    EXECUTE 'CREATE ROLE merge_counts_test_executor LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION';
    EXECUTE 'GRANT myboon_knowledge_executor TO merge_counts_test_executor';
  END IF;
END
$roles$;

-- ===== executor session: dry + real apply of pair A =====
SET SESSION AUTHORIZATION merge_counts_test_executor;
CREATE TEMP TABLE res342b(key text PRIMARY KEY, state text, note text);
INSERT INTO res342b SELECT 'dry_pair_a', NULL,
  managed_knowledge_private.merge_entities_v1('00000000-0000-4000-8000-000000000d01'::uuid,'00000000-0000-4000-8000-000000000d02'::uuid)::text;
INSERT INTO res342b SELECT 'dry_pair_b', NULL,
  managed_knowledge_private.merge_entities_v1('00000000-0000-4000-8000-000000000d16'::uuid,'00000000-0000-4000-8000-000000000d17'::uuid)::text;
RESET SESSION AUTHORIZATION;
-- Snapshot of the pre-apply state, taken as the superuser while only the dry
-- runs have executed (the 20261019220000 dry_no_change pattern).
INSERT INTO res342b SELECT 'dry_state_a', NULL, jsonb_build_object(
  'mergedLive', (SELECT count(*) FROM managed_knowledge_private.memberships WHERE entity_id = '00000000-0000-4000-8000-000000000d02'::uuid AND removed_operation IS NULL),
  'mergedStatus', (SELECT status FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid),
  'mergedRedirect', EXISTS (SELECT 1 FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d02'::uuid AND metadata ? 'mergedInto'),
  'narrativesForMerged', (SELECT count(*) FROM public.published_narratives WHERE entity_id = '00000000-0000-4000-8000-000000000d02'::uuid)
  )::text;
-- Resume the executor session for the real apply of pair A.
SET SESSION AUTHORIZATION merge_counts_test_executor;
INSERT INTO res342b SELECT 'apply_pair_a', NULL,
  managed_knowledge_private.merge_entities_v1('00000000-0000-4000-8000-000000000d01'::uuid,'00000000-0000-4000-8000-000000000d02'::uuid,false)::text;
RESET SESSION AUTHORIZATION;

-- Pair B: a rogue BEFORE UPDATE trigger silently suppresses the one membership
-- move; the PR-4 count guard must refuse the merge with ERRCODE 40001.
CREATE FUNCTION test342b_skip_move() RETURNS trigger LANGUAGE plpgsql AS $skip$ BEGIN RETURN NULL; END $skip$;
CREATE TRIGGER merge_counts_skip_move BEFORE UPDATE ON managed_knowledge_private.memberships
  FOR EACH ROW WHEN (OLD.item_id = '00000000-0000-4000-8000-000000000b11'::uuid
    AND OLD.entity_id = '00000000-0000-4000-8000-000000000d17'::uuid)
  EXECUTE FUNCTION test342b_skip_move();
DO $mismatch$
DECLARE survivor uuid := '00000000-0000-4000-8000-000000000d16'::uuid; merged uuid := '00000000-0000-4000-8000-000000000d17'::uuid;
BEGIN
  BEGIN
    PERFORM managed_knowledge_private.merge_entities_v1(survivor, merged, false);
    INSERT INTO res342b VALUES('apply_pair_b','NOERROR','merge unexpectedly succeeded');
  EXCEPTION WHEN OTHERS THEN INSERT INTO res342b VALUES('apply_pair_b',SQLSTATE,SQLERRM); END;
END
$mismatch$;
DROP TRIGGER merge_counts_skip_move ON managed_knowledge_private.memberships;
DROP FUNCTION test342b_skip_move();

-- The PR-3 ACL contract survives the CREATE OR REPLACE (anon still rejected).
DO $denial$
DECLARE st text; msg text; survivor uuid := '00000000-0000-4000-8000-000000000d01'::uuid; merged uuid := '00000000-0000-4000-8000-000000000d02'::uuid;
BEGIN
  BEGIN
    SET SESSION AUTHORIZATION anon;
    PERFORM managed_knowledge_private.merge_entities_v1(survivor, merged);
    st := 'NOERROR'; msg := 'merge unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE; msg := SQLERRM; END;
  RESET SESSION AUTHORIZATION;
  INSERT INTO res342b VALUES('deny_anon', st, msg);
END
$denial$;

SELECT check_name || '|' || pass FROM (
  SELECT
  '01 pair A dry run counts: two moved, three collisions, one resolves to certain' AS check_name,
    ((SELECT note::jsonb FROM res342b WHERE key='dry_pair_a')->'counts')->>'membershipsToMove' = '2'
    AND ((SELECT note::jsonb FROM res342b WHERE key='dry_pair_a')->'counts')->>'membershipsCollidingWithSurvivor' = '3'
    AND ((SELECT note::jsonb FROM res342b WHERE key='dry_pair_a')->'counts')->>'collisionsResolvedToCertain' = '1'
    AND ((SELECT note::jsonb FROM res342b WHERE key='dry_pair_a')->'counts'->'publicationsToRepoint')->>'narratives' = '2'
    AND ((SELECT note::jsonb FROM res342b WHERE key='dry_pair_a')->'counts'->'publicationsToRepoint')->>'history' = '1'
    AND ((SELECT note::jsonb FROM res342b WHERE key='dry_pair_a')->>'canApply') = 'true'
  UNION ALL SELECT '02 pair A dry run changed nothing and pair B is clean before the rogue trigger',
    ((SELECT note::jsonb FROM res342b WHERE key='dry_pair_a')->>'applied') = 'false'
    AND ((SELECT note::jsonb FROM res342b WHERE key='dry_pair_b')->>'canApply') = 'true'
    AND ((SELECT note::jsonb FROM res342b WHERE key='dry_pair_b')->'counts')->>'collisionsResolvedToCertain' = '0'
    AND ((SELECT note::jsonb FROM res342b WHERE key='dry_state_a')->>'mergedLive') = '5'
    AND ((SELECT note::jsonb FROM res342b WHERE key='dry_state_a')->>'mergedStatus') = 'active'
    AND ((SELECT note::jsonb FROM res342b WHERE key='dry_state_a')->>'mergedRedirect') = 'false'
    AND ((SELECT note::jsonb FROM res342b WHERE key='dry_state_a')->>'narrativesForMerged') = '2'
  UNION ALL SELECT '03 pair A still applies under the count guards (same counts dry vs real)',
    ((SELECT note::jsonb FROM res342b WHERE key='apply_pair_a')->>'applied') = 'true'
    AND ((SELECT note::jsonb FROM res342b WHERE key='apply_pair_a')->'counts') = ((SELECT note::jsonb FROM res342b WHERE key='dry_pair_a')->'counts')
  UNION ALL SELECT '04 certain-row rule: the uncertain survivor row adopted the certain merged row',
    (SELECT uncertain FROM managed_knowledge_private.memberships
      WHERE item_id = '00000000-0000-4000-8000-000000000b04'::uuid AND entity_id = '00000000-0000-4000-8000-000000000d01'::uuid) = false
    AND (SELECT placement_confidence FROM managed_knowledge_private.memberships
      WHERE item_id = '00000000-0000-4000-8000-000000000b04'::uuid AND entity_id = '00000000-0000-4000-8000-000000000d01'::uuid) = 0.85::numeric
  UNION ALL SELECT '05 the reverse collision is untouched (certain survivor keeps its own confidence)',
    (SELECT uncertain FROM managed_knowledge_private.memberships
      WHERE item_id = '00000000-0000-4000-8000-000000000b06'::uuid AND entity_id = '00000000-0000-4000-8000-000000000d01'::uuid) = false
    AND (SELECT placement_confidence FROM managed_knowledge_private.memberships
      WHERE item_id = '00000000-0000-4000-8000-000000000b06'::uuid AND entity_id = '00000000-0000-4000-8000-000000000d01'::uuid) = 0.30::numeric
  UNION ALL SELECT '06 reactivation kept the PR-3 rule and the certain merged row of the collision is tombstoned',
    EXISTS (SELECT 1 FROM managed_knowledge_private.memberships
      WHERE item_id = '00000000-0000-4000-8000-000000000b05'::uuid AND entity_id = '00000000-0000-4000-8000-000000000d01'::uuid AND removed_operation IS NULL)
    AND (SELECT count(*) FROM managed_knowledge_private.memberships
      WHERE entity_id = '00000000-0000-4000-8000-000000000d02'::uuid
        AND removed_operation = 'progression-v2:' || encode(sha256(convert_to('merge_entities_v1:00000000-0000-4000-8000-000000000d01:00000000-0000-4000-8000-000000000d02','UTF8')),'hex')) = 3
  UNION ALL SELECT '07 publications re-pointed with matching counts, rows kept',
    (SELECT count(*) FROM public.published_narratives WHERE entity_id = '00000000-0000-4000-8000-000000000d01'::uuid
      AND entity_slug = 'kestrel-group' AND entity_name = 'Kestrel Group') = 2
    AND (SELECT count(*) FROM public.entity_published_history WHERE entity_id = '00000000-0000-4000-8000-000000000d01'::uuid AND entity_slug = 'kestrel-group') = 1
    AND (SELECT count(*) FROM public.published_narratives WHERE entity_id = '00000000-0000-4000-8000-000000000d02'::uuid) = 0
  UNION ALL SELECT '08 pair B refuses with 40001 naming the table and both counts',
    (SELECT state FROM res342b WHERE key='apply_pair_b') = '40001'
    AND (SELECT note FROM res342b WHERE key='apply_pair_b') LIKE '%membership move on managed_knowledge_private.memberships updated 0 of 1 expected rows%'
  UNION ALL SELECT '09 the refused merge left pair B untouched',
    (SELECT status FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d17'::uuid) = 'active'
    AND NOT EXISTS (SELECT 1 FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-000000000d17'::uuid AND metadata ? 'mergedInto')
    AND EXISTS (SELECT 1 FROM managed_knowledge_private.memberships
      WHERE item_id = '00000000-0000-4000-8000-000000000b11'::uuid AND entity_id = '00000000-0000-4000-8000-000000000d17'::uuid AND removed_operation IS NULL)
    AND (SELECT count(*) FROM managed_knowledge_private.memberships WHERE entity_id = '00000000-0000-4000-8000-000000000d16'::uuid) = 0
    AND (SELECT count(*) FROM managed_knowledge_private.item_heads WHERE item_id = '00000000-0000-4000-8000-000000000b11'::uuid AND revision = 1) = 1
  UNION ALL SELECT '10 anon still cannot execute the replaced function (42501)',
    (SELECT state FROM res342b WHERE key='deny_anon') = '42501'
) AS t(check_name, pass);

ROLLBACK;