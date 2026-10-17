-- #341 PR-A: entity living state (summary/state), summary_revision counter,
-- entity_revision_v2 (excludes summary), append-only summary history and
-- the due queue. Refs #341.
--
-- NOT APPLIED. Apply only after Bucket's explicit yes on #341 (needs-bucket),
-- with a backup taken by the systems manager first.
--
-- #337 has no migration on main or on an open PR yet, so this ships
-- standalone. If #337 PR1 lands first, this file can be folded into it so
-- Bucket gives one yes and one backup covers both.
--
-- entity_revision_v1 is NOT changed or dropped. Every current writer and
-- reader (targets_current_v1, context_v1, article_context_v1,
-- article_writer_v1) keeps pinning v1. v1's digest includes
-- public.entities.summary, so nothing may rewrite summaries in a way that
-- touches v1's inputs until writers have moved to v2 (later PR). The
-- living-state columns added here are not v1 inputs, so a refresh through
-- entity_summary_refresh_v1 does not change v1 either.
-- Rollback: supabase/rollbacks/20261016180000_entity_living_state.down.sql.
-- It drops only the objects added here; v1 and existing data are untouched.

ALTER TABLE managed_knowledge_private.entities
  ADD COLUMN summary text CHECK (summary IS NULL OR length(summary) <= 4000),
  ADD COLUMN current_state text CHECK (current_state IS NULL OR length(current_state) <= 4000),
  ADD COLUMN key_timeline jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(key_timeline)='array'),
  ADD COLUMN open_questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(open_questions)='array'),
  ADD COLUMN summary_revision bigint NOT NULL DEFAULT 0 CHECK (summary_revision >= 0),
  ADD COLUMN items_since_summary integer NOT NULL DEFAULT 0 CHECK (items_since_summary >= 0),
  ADD COLUMN summary_refreshed_at timestamptz;

-- Append-only. One row per summary_revision, holding the state as of that
-- revision. Never updated or deleted; undo writes a new revision.
CREATE TABLE managed_knowledge_private.entity_summary_history (
  entity_id uuid NOT NULL REFERENCES managed_knowledge_private.entities(id),
  summary_revision bigint NOT NULL CHECK (summary_revision >= 0),
  summary text,
  current_state text,
  key_timeline jsonb NOT NULL,
  open_questions jsonb NOT NULL,
  source_item_ids uuid[] NOT NULL DEFAULT '{}',
  model text,
  restored_from bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (entity_id, summary_revision)
);
CREATE FUNCTION managed_knowledge_private.entity_summary_history_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  RAISE EXCEPTION 'entity_summary_history is append-only' USING ERRCODE='MK010';
END
$guard$;
CREATE TRIGGER entity_summary_history_no_mutation
  BEFORE UPDATE OR DELETE ON managed_knowledge_private.entity_summary_history
  FOR EACH ROW EXECUTE FUNCTION managed_knowledge_private.entity_summary_history_append_only();
CREATE TRIGGER entity_summary_history_no_truncate
  BEFORE TRUNCATE ON managed_knowledge_private.entity_summary_history
  FOR EACH STATEMENT EXECUTE FUNCTION managed_knowledge_private.entity_summary_history_append_only();

-- Due queue: one row per entity (self-deduping), drained under a lease.
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

ALTER TABLE managed_knowledge_private.entity_summary_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_knowledge_private.entity_summary_history FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_knowledge_private.entity_summary_due ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_knowledge_private.entity_summary_due FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON managed_knowledge_private.entity_summary_history TO myboon_knowledge_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_only ON managed_knowledge_private.entity_summary_due TO myboon_knowledge_owner USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON managed_knowledge_private.entity_summary_history TO myboon_knowledge_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON managed_knowledge_private.entity_summary_due TO myboon_knowledge_owner;
GRANT UPDATE (summary,current_state,key_timeline,open_questions,summary_revision,items_since_summary,summary_refreshed_at)
  ON managed_knowledge_private.entities TO myboon_knowledge_owner;

-- Write-path revision without summary/living state. Same shape as v1 but a
-- distinct 'managed2:'/'catalog2:' prefix so a v1 pin can never be mistaken
-- for a v2 pin. Catalog digest covers identity only: id, slug, name, type,
-- aliases, status (no summary, metadata or updated_at).
CREATE FUNCTION managed_knowledge_private.entity_revision_v2(target uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $revision$
DECLARE private_row managed_knowledge_private.entities; catalog_json jsonb; suffix text := '';
BEGIN
  SELECT * INTO private_row FROM managed_knowledge_private.entities WHERE id = target;
  SELECT jsonb_build_object('id',id,'slug',slug,'name',name,'type',type,'aliases',aliases,'status',status)
    INTO catalog_json FROM public.entities WHERE id = coalesce(private_row.catalog_entity_id,target);
  IF catalog_json IS NOT NULL THEN
    IF catalog_json->>'status' <> 'active' THEN RETURN 'unavailable'; END IF;
    suffix := managed_knowledge_private.digest_v1(catalog_json);
  END IF;
  IF private_row.id IS NOT NULL THEN RETURN 'managed2:' || private_row.revision::text || ':' || suffix; END IF;
  IF catalog_json IS NOT NULL THEN RETURN 'catalog2:' || suffix; END IF;
  RETURN 'absent';
END
$revision$;

-- Compare-and-set refresh. Writes the new state to the entity and to history
-- in one transaction. Returns status 'refreshed' or 'conflict' (another
-- refresh won; nothing changed).
CREATE FUNCTION managed_knowledge_private.entity_summary_refresh_v1(input jsonb)
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

-- Undo: restore revision N as a new revision (CAS on the current revision).
CREATE FUNCTION managed_knowledge_private.entity_summary_restore_v1(input jsonb)
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

-- Claim up to `limit` due entities under a lease (SKIP LOCKED, so parallel
-- workers never take the same entity).
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

REVOKE ALL ON managed_knowledge_private.entity_summary_history, managed_knowledge_private.entity_summary_due FROM PUBLIC, anon, authenticated, service_role, myboon_knowledge_executor, myboon_knowledge_context_executor;
REVOKE ALL ON FUNCTION managed_knowledge_private.entity_revision_v2(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION managed_knowledge_private.entity_summary_refresh_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION managed_knowledge_private.entity_summary_restore_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION managed_knowledge_private.entity_summary_claim_due_v1(text,integer,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION managed_knowledge_private.entity_summary_history_append_only() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION managed_knowledge_private.entity_summary_refresh_v1(jsonb) TO myboon_knowledge_executor;
GRANT EXECUTE ON FUNCTION managed_knowledge_private.entity_summary_restore_v1(jsonb) TO myboon_knowledge_executor;
GRANT EXECUTE ON FUNCTION managed_knowledge_private.entity_summary_claim_due_v1(text,integer,integer) TO myboon_knowledge_executor;
GRANT CREATE ON SCHEMA managed_knowledge_private TO myboon_knowledge_owner;
DO $function_ownership$
DECLARE already_can_set boolean := pg_catalog.pg_has_role(current_user,'myboon_knowledge_owner','SET');
BEGIN
  IF NOT already_can_set THEN
    EXECUTE format('GRANT myboon_knowledge_owner TO %I WITH INHERIT FALSE, SET TRUE',current_user);
  END IF;
  ALTER FUNCTION managed_knowledge_private.entity_revision_v2(uuid) OWNER TO myboon_knowledge_owner;
  ALTER FUNCTION managed_knowledge_private.entity_summary_refresh_v1(jsonb) OWNER TO myboon_knowledge_owner;
  ALTER FUNCTION managed_knowledge_private.entity_summary_restore_v1(jsonb) OWNER TO myboon_knowledge_owner;
  ALTER FUNCTION managed_knowledge_private.entity_summary_claim_due_v1(text,integer,integer) OWNER TO myboon_knowledge_owner;
  IF NOT already_can_set THEN
    EXECUTE format('REVOKE SET OPTION FOR myboon_knowledge_owner FROM %I',current_user);
  END IF;
END
$function_ownership$;
REVOKE CREATE ON SCHEMA managed_knowledge_private FROM myboon_knowledge_owner;
