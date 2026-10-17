-- Rollback for 20261017180000_entity_summary_article_refresh.sql (#341 Part B).
-- MANUAL ONLY: never applied by a deploy, a job or CI. Run by hand as the
-- migration role, after a backup taken by the systems manager.
--
-- Recreates, empty, only the schema pieces the forward migration dropped:
-- the Part A living-state entity columns, the history snapshot columns, and
-- the Part A due queue (table, index, RLS, policy, grants) with its claim
-- function. Rows are not restored: the due queue comes back empty, the
-- history rows lose their dropped snapshot values permanently, and entity
-- summaries/summary_revision survive untouched.
--
-- article_writer_v1 is NOT recreated here: after this file has run, re-run
-- the CREATE OR REPLACE FUNCTION managed_knowledge_private.article_writer_v1
-- block (the $body$ statement, inside the owner wrapper) from
-- supabase/migrations/20261017120000_managed_entity_columns.sql to restore the
-- pre-#341-Part-B writer body. Its 200-line body is not copied into this file.

-- 1. Living-state entity columns, as Part A defined them.
ALTER TABLE managed_knowledge_private.entities
  ADD COLUMN current_state text CHECK (current_state IS NULL OR length(current_state) <= 4000),
  ADD COLUMN key_timeline jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(key_timeline)='array'),
  ADD COLUMN open_questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(open_questions)='array'),
  ADD COLUMN items_since_summary integer NOT NULL DEFAULT 0 CHECK (items_since_summary >= 0);

-- 2. History snapshot columns as nullable jsonb/text; the NOT NULL DEFAULT
--    '[]' fills existing rows because Part A's columns had no defaults.
ALTER TABLE managed_knowledge_private.entity_summary_history
  ADD COLUMN current_state text,
  ADD COLUMN key_timeline jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN open_questions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 3. Due queue: table + index + RLS + policy + grants, exactly as Part A.
CREATE TABLE managed_knowledge_private.entity_summary_due (
  entity_id uuid PRIMARY KEY REFERENCES managed_knowledge_private.entities(id),
  reason text NOT NULL CHECK (reason IN ('item_threshold','continuation','backfill','manual')),
  due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX entity_summary_due_ready ON managed_knowledge_private.entity_summary_due(due_at);
ALTER TABLE managed_knowledge_private.entity_summary_due ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_knowledge_private.entity_summary_due FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON managed_knowledge_private.entity_summary_due TO myboon_knowledge_owner USING (true) WITH CHECK (true);
REVOKE ALL ON managed_knowledge_private.entity_summary_due FROM PUBLIC, anon, authenticated, service_role, myboon_knowledge_executor, myboon_knowledge_context_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON managed_knowledge_private.entity_summary_due TO myboon_knowledge_owner;

-- 4. Column grants as Part A; undo the revision grant Part B added.
GRANT UPDATE (summary,current_state,key_timeline,open_questions,summary_revision,items_since_summary,summary_refreshed_at)
  ON managed_knowledge_private.entities TO myboon_knowledge_owner;
REVOKE UPDATE (revision) ON managed_knowledge_private.entities FROM myboon_knowledge_owner;

-- 5. Functions as myboon_knowledge_owner, same wrapper as 20261017120000; the
--    rollback file also runs inside one transaction (psql --single-transaction),
--    which is why SET LOCAL works.
DO $access$
BEGIN
  PERFORM set_config('myboon.migration_had_owner_set',pg_has_role(current_user,'myboon_knowledge_owner','SET')::text,true);
  PERFORM set_config('myboon.migration_had_owner_create',has_schema_privilege('myboon_knowledge_owner','managed_knowledge_private','CREATE')::text,true);
  IF NOT pg_has_role(current_user,'myboon_knowledge_owner','SET') THEN
    EXECUTE format('GRANT myboon_knowledge_owner TO %I WITH INHERIT FALSE, SET TRUE',current_user);
  END IF;
END
$access$;
GRANT CREATE ON SCHEMA managed_knowledge_private TO myboon_knowledge_owner;
SET LOCAL ROLE myboon_knowledge_owner;

-- Part A compare-and-set refresh, verbatim (it writes
-- currentState/keyTimeline/openQuestions again and drains the due queue).
CREATE OR REPLACE FUNCTION managed_knowledge_private.entity_summary_refresh_v1(input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE target uuid := (input->>'entityId')::uuid; expected bigint := (input->>'expectedSummaryRevision')::bigint;
  prior managed_knowledge_private.entities; next_revision bigint;
BEGIN
  IF target IS NULL OR expected IS NULL THEN RAISE EXCEPTION 'entityId and expectedSummaryRevision required' USING ERRCODE='MK011'; END IF;
  IF coalesce(btrim(input->>'summary'),'') = '' THEN RAISE EXCEPTION 'summary required' USING ERRCODE='MK011'; END IF;
  SELECT * INTO prior FROM managed_knowledge_private.entities WHERE id = target FOR UPDATE;
  IF prior.id IS NULL THEN RAISE EXCEPTION 'entity not found' USING ERRCODE='MK011'; END IF;
  IF prior.summary_revision <> expected THEN
    RETURN jsonb_build_object('status','conflict','entityId',target,'summaryRevision',prior.summary_revision);
  END IF;
  -- Preserve the pre-refresh state (revision 0 may have no history row yet).
  INSERT INTO managed_knowledge_private.entity_summary_history(entity_id,summary_revision,summary,current_state,key_timeline,open_questions)
    VALUES(target,prior.summary_revision,prior.summary,prior.current_state,prior.key_timeline,prior.open_questions)
    ON CONFLICT DO NOTHING;
  next_revision := prior.summary_revision + 1;
  UPDATE managed_knowledge_private.entities SET
    summary = input->>'summary', current_state = input->>'currentState',
    key_timeline = coalesce(input->'keyTimeline','[]'::jsonb), open_questions = coalesce(input->'openQuestions','[]'::jsonb),
    summary_revision = next_revision, items_since_summary = 0, summary_refreshed_at = clock_timestamp()
    WHERE id = target;
  INSERT INTO managed_knowledge_private.entity_summary_history(entity_id,summary_revision,summary,current_state,key_timeline,open_questions,source_item_ids,model)
    VALUES(target,next_revision,input->>'summary',input->>'currentState',coalesce(input->'keyTimeline','[]'::jsonb),coalesce(input->'openQuestions','[]'::jsonb),
      coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(input->'sourceItemIds','[]'::jsonb))::uuid),'{}'),input->>'model');
  DELETE FROM managed_knowledge_private.entity_summary_due WHERE entity_id = target;
  RETURN jsonb_build_object('status','refreshed','entityId',target,'summaryRevision',next_revision);
END
$body$;

-- Part A restore, verbatim.
CREATE OR REPLACE FUNCTION managed_knowledge_private.entity_summary_restore_v1(input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE target uuid := (input->>'entityId')::uuid; expected bigint := (input->>'expectedSummaryRevision')::bigint;
  source_revision bigint := (input->>'restoreRevision')::bigint; current_row managed_knowledge_private.entities;
  snapshot managed_knowledge_private.entity_summary_history; next_revision bigint;
BEGIN
  IF target IS NULL OR expected IS NULL OR source_revision IS NULL THEN
    RAISE EXCEPTION 'entityId, expectedSummaryRevision and restoreRevision required' USING ERRCODE='MK011';
  END IF;
  SELECT * INTO current_row FROM managed_knowledge_private.entities WHERE id = target FOR UPDATE;
  IF current_row.id IS NULL THEN RAISE EXCEPTION 'entity not found' USING ERRCODE='MK011'; END IF;
  IF current_row.summary_revision <> expected THEN
    RETURN jsonb_build_object('status','conflict','entityId',target,'summaryRevision',current_row.summary_revision);
  END IF;
  SELECT * INTO snapshot FROM managed_knowledge_private.entity_summary_history WHERE entity_id = target AND summary_revision = source_revision;
  IF snapshot.entity_id IS NULL THEN RAISE EXCEPTION 'summary revision not found' USING ERRCODE='MK011'; END IF;
  next_revision := current_row.summary_revision + 1;
  UPDATE managed_knowledge_private.entities SET summary = snapshot.summary, current_state = snapshot.current_state,
    key_timeline = snapshot.key_timeline, open_questions = snapshot.open_questions, summary_revision = next_revision,
    summary_refreshed_at = clock_timestamp() WHERE id = target;
  INSERT INTO managed_knowledge_private.entity_summary_history(entity_id,summary_revision,summary,current_state,key_timeline,open_questions,source_item_ids,model,restored_from)
    VALUES(target,next_revision,snapshot.summary,snapshot.current_state,snapshot.key_timeline,snapshot.open_questions,snapshot.source_item_ids,snapshot.model,source_revision);
  RETURN jsonb_build_object('status','restored','entityId',target,'summaryRevision',next_revision,'restoredFrom',source_revision);
END
$body$;

-- Part A claim function, verbatim; REVOKE/GRANT/ownership as Part A. Created
-- under SET ROLE the function is already owned by myboon_knowledge_owner; the
-- ALTER below keeps that ownership explicit.
CREATE FUNCTION managed_knowledge_private.entity_summary_claim_due_v1(owner text, claim_limit integer, lease_ms integer)
RETURNS SETOF managed_knowledge_private.entity_summary_due LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
BEGIN
  IF coalesce(btrim(owner),'') = '' OR claim_limit IS NULL OR lease_ms IS NULL OR claim_limit NOT BETWEEN 1 AND 200 OR lease_ms NOT BETWEEN 1000 AND 3600000 THEN
    RAISE EXCEPTION 'invalid claim' USING ERRCODE='MK011';
  END IF;
  RETURN QUERY
  UPDATE managed_knowledge_private.entity_summary_due d SET lease_owner = owner,
    lease_expires_at = clock_timestamp() + make_interval(secs => lease_ms / 1000.0), attempts = d.attempts + 1
  WHERE d.entity_id IN (
    SELECT q.entity_id FROM managed_knowledge_private.entity_summary_due q
    WHERE q.due_at <= clock_timestamp() AND (q.lease_expires_at IS NULL OR q.lease_expires_at < clock_timestamp())
    ORDER BY q.due_at, q.entity_id LIMIT claim_limit FOR UPDATE SKIP LOCKED)
  RETURNING d.*;
END
$body$;

REVOKE ALL ON FUNCTION managed_knowledge_private.entity_summary_claim_due_v1(text,integer,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION managed_knowledge_private.entity_summary_claim_due_v1(text,integer,integer) TO myboon_knowledge_executor;
ALTER FUNCTION managed_knowledge_private.entity_summary_claim_due_v1(text,integer,integer) OWNER TO myboon_knowledge_owner;

RESET ROLE;
DO $restore$
BEGIN
  IF current_setting('myboon.migration_had_owner_create')='false' THEN
    REVOKE CREATE ON SCHEMA managed_knowledge_private FROM myboon_knowledge_owner;
  END IF;
  IF current_setting('myboon.migration_had_owner_set')='false' THEN
    EXECUTE format('REVOKE SET OPTION FOR myboon_knowledge_owner FROM %I',current_user);
  END IF;
END
$restore$;