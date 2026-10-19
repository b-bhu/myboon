-- #342 PR-4 A behaviour check. Disposable DB only, run as a superuser, and
-- EXPECTS the state the pg-test script builds: every repo migration applied,
-- .preseed.sql committed (legacy rows 1a1..1a7), 20261019230000 applied.
-- Seeds its own probe rows inside the transaction, calls merge_entities_v1 as
-- a disposable executor LOGIN (the 20261019220000 pattern), prints
-- check|pass rows and ROLLBACKs everything - the committed preseed rows are
-- exercised in-transaction only.
\set ON_ERROR_STOP on
BEGIN;

-- Disposable executor LOGIN (pattern of the dedicated logins migration).
DO $roles$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kind342_executor') THEN
    EXECUTE 'CREATE ROLE kind342_executor LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION';
    EXECUTE 'GRANT myboon_knowledge_executor TO kind342_executor';
  END IF;
END
$roles$;

-- Catalogue row with a legacy type for the linked-copy fill probe.
INSERT INTO public.entities(id,slug,name,type,status,aliases,metadata)
  VALUES('00000000-0000-4000-8000-0000000002c1','bound-conflict-2c1','Bound Conflict Legacy','conflict','active','[]'::jsonb,'{}'::jsonb);

SET SESSION AUTHORIZATION kind342_executor;
CREATE TEMP TABLE res342(key text PRIMARY KEY, state text, note text);
INSERT INTO res342 SELECT 'dry_pair', NULL,
  managed_knowledge_private.merge_entities_v1('00000000-0000-4000-8000-0000000001a1'::uuid,'00000000-0000-4000-8000-0000000001a3'::uuid)::text;
INSERT INTO res342 SELECT 'apply_pair', NULL,
  managed_knowledge_private.merge_entities_v1('00000000-0000-4000-8000-0000000001a1'::uuid,'00000000-0000-4000-8000-0000000001a3'::uuid,false)::text;
RESET SESSION AUTHORIZATION;

-- Fill-path and CHECK probes (postgres superuser; nothing grants UPDATE(type)
-- to any runtime role, intentionally).
DO $probe$ DECLARE st text; msg text;
BEGIN
  BEGIN
    INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation,name,slug,type)
      VALUES('00000000-0000-4000-8000-0000000002c9','probe342:raw-project',jsonb_build_object('name','Raw Project','slug','raw-project'),'progression-v2:' || repeat('0',64),'Raw Project','raw-project','project');
    st := 'NOERROR'; msg := 'legacy-type insert unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE; msg := SQLERRM; END;
  INSERT INTO res342(key,state,note) VALUES('ins_legacy_raw',st,msg);
  BEGIN
    INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation,name,slug,type)
      VALUES('00000000-0000-4000-8000-0000000002c8','probe342:raw-wallet-or-trader',jsonb_build_object('name','Raw WOT','slug','raw-wot'),'progression-v2:' || repeat('0',64),'Raw WOT','raw-wot','wallet_or_trader');
    st := 'NOERROR'; msg := 'raw wallet_or_trader insert unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE; msg := SQLERRM; END;
  INSERT INTO res342(key,state,note) VALUES('ins_mappable_raw',st,msg);
END
$probe$;

-- UPDATE probes on a formerly-legacy row: kinds are accepted, raw strings are not.
DO $probe$ DECLARE st text; msg text;
BEGIN
  BEGIN
    UPDATE managed_knowledge_private.entities SET type = 'product' WHERE id = '00000000-0000-4000-8000-0000000001a1'::uuid;
    st := 'OK'; msg := '';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE; msg := SQLERRM; END;
  INSERT INTO res342(key,state,note) VALUES('upd_kind_ok',st,msg);
  BEGIN
    UPDATE managed_knowledge_private.entities SET type = 'company' WHERE id = '00000000-0000-4000-8000-0000000001a1'::uuid;
    st := 'NOERROR'; msg := 'legacy-type update unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE; msg := SQLERRM; END;
  INSERT INTO res342(key,state,note) VALUES('upd_legacy_raw',st,msg);
END
$probe$;

-- Fill-path probes: a writer-shaped INSERT (binding only) stores the kind.
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
  VALUES('00000000-0000-4000-8000-0000000002c2','probe342:fill-project',NULL,
    jsonb_build_object('name','Fill Project','slug','fill-project','type','project','aliases','[]'::jsonb),'progression-v2:' || repeat('0',64));
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
  VALUES('00000000-0000-4000-8000-0000000002c3','probe342:fill-ai-coding-tool',NULL,
    jsonb_build_object('name','Fill Coder','slug','fill-coder','type','ai coding tool','aliases','[]'::jsonb),'progression-v2:' || repeat('0',64));
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
  VALUES('00000000-0000-4000-8000-0000000002c4','probe342:fill-wallet',NULL,
    jsonb_build_object('name','Fill Wallet','slug','fill-wallet','type','wallet','aliases','[]'::jsonb),'progression-v2:' || repeat('0',64));
-- Linked-copy probe: the catalogue's legacy type is mapped too.
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation)
  VALUES('00000000-0000-4000-8000-0000000002c5','probe342:catalog-conflict','00000000-0000-4000-8000-0000000002c1'::uuid,
    jsonb_build_object('id','00000000-0000-4000-8000-0000000002c1','name','Bound Conflict Legacy','slug','bound-conflict-2c1','aliases','[]'::jsonb),'progression-v2:' || repeat('0',64));

SELECT check_name || '|' || pass FROM (
  SELECT '01 dry run on the legacy pair reports without applying' AS check_name,
    ((SELECT note::jsonb FROM res342 WHERE key='dry_pair')->>'dryRun') = 'true'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_pair')->>'applied') = 'false'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_pair')->>'canApply') = 'true'
    AND ((SELECT note::jsonb FROM res342 WHERE key='dry_pair')->>'typeMismatch') = 'true'
  UNION ALL SELECT '02 executor merge of two formerly-legacy rows applied',
    ((SELECT note::jsonb FROM res342 WHERE key='apply_pair')->>'applied') = 'true'
    AND ((SELECT note::jsonb FROM res342 WHERE key='apply_pair')->>'canApply') = 'true'
  UNION ALL SELECT '03 merge moved the merged-side membership and archived merged behind the redirect',
    EXISTS (SELECT 1 FROM managed_knowledge_private.memberships
            WHERE item_id = '00000000-0000-4000-8000-0000000001b1'::uuid
              AND entity_id = '00000000-0000-4000-8000-0000000001a1'::uuid AND removed_operation IS NULL)
    AND (SELECT count(*) FROM managed_knowledge_private.memberships
         WHERE entity_id = '00000000-0000-4000-8000-0000000001a3'::uuid AND removed_operation IS NULL) = 0
    AND (SELECT status FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-0000000001a3'::uuid) = 'archived'
    AND (SELECT metadata->>'mergedInto' FROM managed_knowledge_private.entities
         WHERE id = '00000000-0000-4000-8000-0000000001a3'::uuid) = '00000000-0000-4000-8000-0000000001a1'
  UNION ALL SELECT '04 metadata.legacyType survives the merge on both sides',
    (SELECT metadata->>'legacyType' FROM managed_knowledge_private.entities
     WHERE id = '00000000-0000-4000-8000-0000000001a1'::uuid) = 'project'
    AND EXISTS (SELECT 1 FROM managed_knowledge_private.entities
     WHERE id = '00000000-0000-4000-8000-0000000001a3'::uuid AND metadata ? 'legacyType')
  UNION ALL SELECT '05 direct INSERT with legacy type project is rejected 23514',
    (SELECT state FROM res342 WHERE key='ins_legacy_raw') = '23514'
  UNION ALL SELECT '06 direct INSERT with raw mappable wallet_or_trader is rejected 23514',
    (SELECT state FROM res342 WHERE key='ins_mappable_raw') = '23514'
  UNION ALL SELECT '07 UPDATE of a formerly-legacy row to another kind value succeeds',
    (SELECT state FROM res342 WHERE key='upd_kind_ok') = 'OK'
  UNION ALL SELECT '08 UPDATE of a formerly-legacy row to raw company is rejected 23514',
    (SELECT state FROM res342 WHERE key='upd_legacy_raw') = '23514'
  UNION ALL SELECT '09 fill path maps binding project to protocol',
    (SELECT type FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-0000000002c2'::uuid) = 'protocol'
    AND NOT EXISTS (SELECT 1 FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-0000000002c2'::uuid AND metadata ? 'legacyType')
  UNION ALL SELECT '10 fill path normalises and maps ai coding tool to product',
    (SELECT type FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-0000000002c3'::uuid) = 'product'
  UNION ALL SELECT '11 fill path maps wallet to unclassified',
    (SELECT type FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-0000000002c4'::uuid) = 'unclassified'
  UNION ALL SELECT '12 linked fill path maps the catalogue legacy type conflict to event',
    (SELECT type FROM managed_knowledge_private.entities WHERE id = '00000000-0000-4000-8000-0000000002c5'::uuid) = 'event'
) AS t(check_name, pass);

ROLLBACK;