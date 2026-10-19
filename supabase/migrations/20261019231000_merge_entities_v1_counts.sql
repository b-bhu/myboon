-- #342 PR-4 B: CREATE OR REPLACE of merge_entities_v1 (20261019220000 body
-- verbatim) with exactly the two CTO review amendments:
--   (i)  after each re-point UPDATE - the memberships move,
--        public.published_narratives and public.entity_published_history -
--        GET DIAGNOSTICS ROW_COUNT is compared with the pre-count taken
--        earlier; a mismatch raises '40001' naming the table and both counts,
--        so a silently suppressed or duplicated repoint (concurrent writer,
--        RLS surprise) can never end the transaction half-applied.
--   (ii) on a live/live membership collision the certain row wins: when the
--        survivor row is uncertain and the merged row is not, the survivor
--        row takes the merged row's certainty (uncertain=false and its
--        placement_confidence) before the merged row is tombstoned. The dry
--        run reports how many collisions resolve to certain
--        (counts.collisionsResolvedToCertain).
-- Everything else - ownership wrapper, grants, lock order, refusals, the
-- report shape - is byte-identical to 20261019220000. NOT APPLIED. Depends on
-- 20261017120000, 20261018090000/20261019190000 (publication guard) and the
-- kind migration (20261019230000) for the stored types.
--
-- Rollback: supabase/rollbacks/20261019231000_merge_entities_v1_counts.down.sql
-- (restores the 20261019220000 function body, grants and COMMENT verbatim).
-- Check: supabase/tests/20261019231000_merge_entities_v1_counts.check.sql
-- Behaviour: supabase/tests/20261019231000_merge_entities_v1_counts.behaviour.sql
-- pg-test:   supabase/tests/20261019231000_merge_entities_v1_counts.pg-test.sh

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

CREATE OR REPLACE FUNCTION managed_knowledge_private.merge_entities_v1(p_survivor uuid, p_merged uuid, p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
-- #342 PR-3: pinned like the other managed definitions; every reference in the
-- body is schema-qualified.
SET search_path = pg_catalog, pg_temp
AS $merge$
DECLARE
  survivor managed_knowledge_private.entities;
  merged managed_knowledge_private.entities;
  affected_item_ids uuid[];
  moved_item_ids uuid[];
  collided_item_ids uuid[];
  recheck_item_ids uuid[];
  merge_operation text;
  new_aliases jsonb := '[]'::jsonb;
  alias_candidate text;
  aliases_moved integer := 0;
  bumped_count integer;
  relationships_left integer;
  summary_rows_left integer;
  narratives_to_repoint integer;
  history_to_repoint integer;
  memberships_to_move integer;
  moved_membership_rows integer;
  narratives_repointed integer;
  history_repointed integer;
  certainty_resolutions integer := 0;
  type_mismatch boolean;
  refusals jsonb := '[]'::jsonb;
  report jsonb;
  collision record;
BEGIN
  -- Executor-only gate before anything else. The research context executor
  -- (read-only) gets no EXECUTE at all; anon/authenticated/service_role/
  -- PUBLIC get none either, and dedicated logins are the intended callers.
  IF NOT pg_has_role(session_user, 'myboon_knowledge_executor', 'member') THEN
    RAISE EXCEPTION 'merge_entities_v1 requires a dedicated managed knowledge executor login' USING ERRCODE = '42501';
  END IF;

  -- Validation (22023): ids required and distinct; both rows must exist in
  -- the managed store; neither side may be archived. The caller names the
  -- survivor explicitly and a type difference is only reported.
  IF p_survivor IS NULL OR p_merged IS NULL THEN
    RAISE EXCEPTION 'survivor and merged entity ids are required' USING ERRCODE = '22023';
  END IF;
  IF p_survivor = p_merged THEN
    RAISE EXCEPTION 'survivor and merged must be different entities' USING ERRCODE = '22023';
  END IF;

  -- Lock order #403: entities first, then item_heads, then memberships -
  -- never memberships before item_heads - and the publication tables only in
  -- the apply (after the memberships have moved). This matches the
  -- publication relationship guard. Entities lock in a deterministic id
  -- order.
  PERFORM locked.id
    FROM managed_knowledge_private.entities AS locked
    WHERE locked.id IN (p_survivor, p_merged)
    ORDER BY locked.id
    FOR UPDATE;

  SELECT * INTO survivor FROM managed_knowledge_private.entities WHERE id = p_survivor;
  SELECT * INTO merged FROM managed_knowledge_private.entities WHERE id = p_merged;
  IF survivor.id IS NULL OR merged.id IS NULL THEN
    RAISE EXCEPTION 'merge requires two existing managed entities' USING ERRCODE = '22023',
      DETAIL = 'missing=' || CASE WHEN survivor.id IS NULL THEN p_survivor::text ELSE p_merged::text END;
  END IF;
  IF survivor.status = 'archived' THEN
    RAISE EXCEPTION 'survivor entity is archived' USING ERRCODE = '22023', DETAIL = p_survivor::text;
  END IF;
  IF merged.status = 'archived' THEN
    RAISE EXCEPTION 'merged entity is archived' USING ERRCODE = '22023', DETAIL = p_merged::text;
  END IF;

  -- Read (no lock yet) ALL membership rows of merged - removed or not: the
  -- move preserves audit history instead of deleting.
  SELECT coalesce(array_agg(membership.item_id ORDER BY membership.item_id), '{}'::uuid[])
    INTO affected_item_ids
    FROM managed_knowledge_private.memberships AS membership
    WHERE membership.entity_id = p_merged;

  -- Lock the item heads for those items, in a deterministic item_id order.
  PERFORM head.item_id
    FROM managed_knowledge_private.item_heads AS head
    WHERE head.item_id = ANY(affected_item_ids)
    ORDER BY head.item_id
    FOR UPDATE;

  -- Then lock the memberships of merged AND survivor for those items, also
  -- deterministic (item_id, entity_id).
  PERFORM membership.item_id
    FROM managed_knowledge_private.memberships AS membership
    WHERE membership.item_id = ANY(affected_item_ids)
      AND membership.entity_id IN (p_merged, p_survivor)
    ORDER BY membership.item_id, membership.entity_id
    FOR UPDATE;

  -- The merged entity's membership item set must not have changed while
  -- waiting for the locks; otherwise the report below would mix states.
  SELECT coalesce(array_agg(recheck.item_id ORDER BY recheck.item_id), '{}'::uuid[])
    INTO recheck_item_ids
    FROM managed_knowledge_private.memberships AS recheck
    WHERE recheck.entity_id = p_merged;
  IF recheck_item_ids IS DISTINCT FROM affected_item_ids THEN
    RAISE EXCEPTION 'merged entity memberships changed while waiting; retry' USING ERRCODE = '40001';
  END IF;

  -- Reported only: the caller decides whether the type difference matters.
  type_mismatch := survivor.type IS DISTINCT FROM merged.type;

  -- Refusals (55000): merged must never be a catalogue identity, and a
  -- redirect stays ONE hop both ways.
  IF merged.catalog_entity_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.entities AS catalog WHERE catalog.id = p_merged) THEN
    refusals := refusals || jsonb_build_array(jsonb_build_object(
      'reason', 'merged is catalogue-linked; catalogue entities are never merge sources in this PR',
      'count', 1));
  END IF;
  IF survivor.metadata IS NOT NULL AND (survivor.metadata ? 'mergedInto') THEN
    refusals := refusals || jsonb_build_array(jsonb_build_object(
      'reason', 'survivor is already redirected away (metadata.mergedInto is set)',
      'count', 1));
  END IF;
  IF EXISTS (SELECT 1 FROM managed_knowledge_private.entities AS other
             WHERE jsonb_typeof(other.metadata) = 'object'
               AND other.metadata->>'mergedInto' = p_merged::text) THEN
    refusals := refusals || jsonb_build_array(jsonb_build_object(
      'reason', 'merged is already the target of a redirect; redirects stay one hop',
      'count', 1));
  END IF;

  -- Membership split (rows are never deleted).
  SELECT coalesce(array_agg(membership.item_id ORDER BY membership.item_id), '{}'::uuid[])
    INTO moved_item_ids
    FROM managed_knowledge_private.memberships AS membership
    WHERE membership.entity_id = p_merged
      AND NOT EXISTS (SELECT 1 FROM managed_knowledge_private.memberships AS own
        WHERE own.item_id = membership.item_id AND own.entity_id = p_survivor);
  SELECT coalesce(array_agg(membership.item_id ORDER BY membership.item_id), '{}'::uuid[])
    INTO collided_item_ids
    FROM managed_knowledge_private.memberships AS membership
    WHERE membership.entity_id = p_merged
      AND EXISTS (SELECT 1 FROM managed_knowledge_private.memberships AS own
        WHERE own.item_id = membership.item_id AND own.entity_id = p_survivor);

  -- CTO review (PR-4): count, up front, how many live/live collisions resolve
  -- to the certain row; the count is reported in both modes and executed in
  -- the apply branch below.
  SELECT count(*) INTO certainty_resolutions
    FROM managed_knowledge_private.memberships AS membership
    JOIN managed_knowledge_private.memberships AS own
      ON own.item_id = membership.item_id AND own.entity_id = p_survivor
    WHERE membership.entity_id = p_merged
      AND membership.removed_operation IS NULL AND own.removed_operation IS NULL
      AND own.uncertain AND NOT membership.uncertain;

  SELECT count(*) INTO bumped_count
    FROM managed_knowledge_private.item_heads AS head
    WHERE head.item_id = ANY(affected_item_ids);
  relationships_left := (SELECT count(*) FROM managed_knowledge_private.article_relationships WHERE entity_id = p_merged);
  summary_rows_left := (SELECT count(*) FROM managed_knowledge_private.entity_summary_history WHERE entity_id = p_merged);
  narratives_to_repoint := (SELECT count(*) FROM public.published_narratives WHERE entity_id = p_merged);
  history_to_repoint := (SELECT count(*) FROM public.entity_published_history WHERE entity_id = p_merged);

  -- Aliases the survivor will absorb: merged's name first, then merged's
  -- stored alias order; candidate strings whose name_key equals the
  -- survivor's own key are dropped, duplicates collapsed. The survivor's
  -- pre-existing list keeps its order and is never rewritten by the drop
  -- rule (only the absorbed candidates are filtered). Dry run computes the
  -- same result without writing it.
  IF jsonb_typeof(survivor.aliases) = 'array' THEN
    FOR alias_candidate IN SELECT value FROM jsonb_array_elements_text(coalesce(survivor.aliases, '[]'::jsonb)) LOOP
      IF NOT (new_aliases ? alias_candidate) THEN
        new_aliases := new_aliases || to_jsonb(alias_candidate);
      END IF;
    END LOOP;
  END IF;
  FOR alias_candidate IN
    SELECT merged.name AS value
    UNION ALL
    SELECT value::text
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(merged.aliases) = 'array' THEN merged.aliases ELSE '[]'::jsonb END)
  LOOP
    IF alias_candidate IS DISTINCT FROM NULL
       AND managed_knowledge_private.entity_name_key_v1(alias_candidate) IS DISTINCT FROM survivor.name_key
       AND NOT (new_aliases ? alias_candidate) THEN
      new_aliases := new_aliases || to_jsonb(alias_candidate);
      aliases_moved := aliases_moved + 1;
    END IF;
  END LOOP;

  -- Report: the same shape in both modes; in apply mode everything you read
  -- here was computed from the locked, re-read state and executed as-is.
  report := jsonb_build_object(
    'dryRun', coalesce(p_dry_run, true),
    'survivor', jsonb_build_object('id', survivor.id, 'name', survivor.name, 'type', survivor.type, 'status', survivor.status),
    'merged', jsonb_build_object('id', merged.id, 'name', merged.name, 'type', merged.type, 'status', merged.status),
    'typeMismatch', type_mismatch,
    'refusals', refusals,
    'canApply', refusals = '[]'::jsonb,
    'counts', jsonb_build_object(
      'membershipsToMove', coalesce(array_length(moved_item_ids, 1), 0),
      'membershipsCollidingWithSurvivor', coalesce(array_length(collided_item_ids, 1), 0),
      'collisionsResolvedToCertain', coalesce(certainty_resolutions, 0),
      'itemHeadsRevisionBumped', coalesce(bumped_count, 0),
      'aliasesMoved', aliases_moved,
      'articleRelationshipsLeftInPlace', coalesce(relationships_left, 0),
      'summaryRowsLeftInPlace', coalesce(summary_rows_left, 0),
      'publicationsToRepoint', jsonb_build_object(
        'narratives', coalesce(narratives_to_repoint, 0),
        'history', coalesce(history_to_repoint, 0))),
    'applied', false);

  IF coalesce(p_dry_run, true) THEN
    RETURN report;
  END IF;

  -- Real mode refuses the same findings the dry run reports; the caller's
  -- transaction is left untouched.
  IF refusals <> '[]'::jsonb THEN
    RAISE EXCEPTION 'merge refused: the merged or survivor entity state prevents the merge'
      USING ERRCODE = '55000', DETAIL = refusals::text;
  END IF;

  -- Deterministic audit lease; the same pair always hashes to the same
  -- operation id, so a repeat insert is a no-op.
  merge_operation := 'progression-v2:' || encode(sha256(convert_to('merge_entities_v1:' || p_survivor::text || ':' || p_merged::text, 'UTF8')), 'hex');
  INSERT INTO managed_knowledge_private.leases(operation_id, owner, epoch, expires_at)
    VALUES (merge_operation, 'merge_entities_v1', 1, clock_timestamp())
    ON CONFLICT (operation_id) DO NOTHING;

  -- Memberships. Never DELETE: rows without a survivor counterpart move to
  -- the survivor; on collisions a removed survivor row is reactivated when
  -- merged's row is live, and every merged row for an affected item is then
  -- tombstoned with the merge operation id.
  -- CTO review (PR-4): pre-count the rows the move will carry; the ROW_COUNT
  -- is compared against it right after the UPDATE.
  SELECT count(*) INTO memberships_to_move
    FROM managed_knowledge_private.memberships AS membership
    WHERE membership.entity_id = p_merged
      AND NOT EXISTS (SELECT 1 FROM managed_knowledge_private.memberships AS own
        WHERE own.item_id = membership.item_id AND own.entity_id = p_survivor);
  UPDATE managed_knowledge_private.memberships AS membership
    SET entity_id = p_survivor
    WHERE membership.entity_id = p_merged
      AND NOT EXISTS (SELECT 1 FROM managed_knowledge_private.memberships AS own
        WHERE own.item_id = membership.item_id AND own.entity_id = p_survivor);
  GET DIAGNOSTICS moved_membership_rows = ROW_COUNT;
  IF moved_membership_rows IS DISTINCT FROM memberships_to_move THEN
    RAISE EXCEPTION 'merge_entities_v1: membership move on managed_knowledge_private.memberships updated % of % expected rows',
      moved_membership_rows, memberships_to_move USING ERRCODE = '40001';
  END IF;
  FOR collision IN
    SELECT membership.item_id,
           membership.removed_operation AS merged_removed,
           own.removed_operation AS survivor_removed,
           own.uncertain AS survivor_uncertain,
           membership.uncertain AS merged_uncertain,
           membership.placement_confidence AS merged_confidence
      FROM managed_knowledge_private.memberships AS membership
      JOIN managed_knowledge_private.memberships AS own
        ON own.item_id = membership.item_id AND own.entity_id = p_survivor
      WHERE membership.entity_id = p_merged
  LOOP
    IF collision.survivor_removed IS NOT NULL AND collision.merged_removed IS NULL THEN
      UPDATE managed_knowledge_private.memberships
        SET removed_operation = NULL
        WHERE item_id = collision.item_id AND entity_id = p_survivor;
    ELSIF collision.survivor_removed IS NULL AND collision.merged_removed IS NULL
         AND collision.survivor_uncertain AND NOT collision.merged_uncertain THEN
      -- CTO review (PR-4): prefer the certain row. Both rows are live; when
      -- only the survivor row is uncertain, it takes the merged row's
      -- certainty (and its placement confidence) before merged is tombstoned.
      UPDATE managed_knowledge_private.memberships
        SET uncertain = false, placement_confidence = collision.merged_confidence
        WHERE item_id = collision.item_id AND entity_id = p_survivor;
    END IF;
  END LOOP;
  UPDATE managed_knowledge_private.memberships
    SET removed_operation = merge_operation
    WHERE entity_id = p_merged AND removed_operation IS NULL;

  -- Every affected item head is bumped once.
  UPDATE managed_knowledge_private.item_heads
    SET revision = item_heads.revision + 1
    WHERE item_id = ANY(affected_item_ids);

  -- Aliases: survivor keeps its list (deduplicated, order preserved) and
  -- absorbs merged's name and aliases as computed above; merged's alias list
  -- is emptied.
  UPDATE managed_knowledge_private.entities AS entity
    SET aliases = new_aliases, revision = entity.revision + 1, updated_at = clock_timestamp()
    WHERE entity.id = p_survivor;

  -- Publications are re-pointed, not refused. This runs AFTER the
  -- memberships have moved (the guard's #390 live-membership check then
  -- passes) and BEFORE merged is archived (the guard requires every
  -- referenced entity to be non-archived). The relationship guard triggers
  -- fire as the owner and enforce their own invariants.
  UPDATE public.published_narratives
    SET entity_id = p_survivor, entity_slug = survivor.slug, entity_name = survivor.name
    WHERE entity_id = p_merged;
  GET DIAGNOSTICS narratives_repointed = ROW_COUNT;
  IF narratives_repointed IS DISTINCT FROM narratives_to_repoint THEN
    RAISE EXCEPTION 'merge_entities_v1: re-point of public.published_narratives updated % of % expected rows',
      narratives_repointed, narratives_to_repoint USING ERRCODE = '40001';
  END IF;
  UPDATE public.entity_published_history
    SET entity_id = p_survivor, entity_slug = survivor.slug
    WHERE entity_id = p_merged;
  GET DIAGNOSTICS history_repointed = ROW_COUNT;
  IF history_repointed IS DISTINCT FROM history_to_repoint THEN
    RAISE EXCEPTION 'merge_entities_v1: re-point of public.entity_published_history updated % of % expected rows',
      history_repointed, history_to_repoint USING ERRCODE = '40001';
  END IF;

  -- Archive merged behind the ONE-HOP redirect and keep the audit trail.
  UPDATE managed_knowledge_private.entities AS entity
    SET status = 'archived',
        aliases = '[]'::jsonb,
        metadata = entity.metadata || jsonb_build_object(
          'mergedInto', p_survivor,
          'mergeAudit', jsonb_build_object(
            'at', clock_timestamp(),
            'movedItemIds', to_jsonb(moved_item_ids),
            'collidedItemIds', to_jsonb(collided_item_ids),
            'originalAliases', to_jsonb(merged.aliases),
            'originalStatus', merged.status)),
        revision = merged.revision + 1,
        updated_at = clock_timestamp()
    WHERE entity.id = p_merged;

  report := jsonb_set(report, '{applied}', 'true'::jsonb);
  RETURN report;
END
$merge$;

REVOKE ALL ON FUNCTION managed_knowledge_private.merge_entities_v1(uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role, myboon_knowledge_context_executor;
GRANT EXECUTE ON FUNCTION managed_knowledge_private.merge_entities_v1(uuid, uuid, boolean)
  TO myboon_knowledge_executor;

COMMENT ON FUNCTION managed_knowledge_private.merge_entities_v1(uuid, uuid, boolean) IS
  '#342 PR-4 B: merge two managed entities - moves memberships, bumps affected item heads, absorbs aliases, re-points publications to the survivor and archives merged behind metadata.mergedInto (one hop). Row-count guards (40001) compare each re-point with its pre-count, and a live/live membership collision with an uncertain survivor adopts the certain merged row before it is tombstoned. Dry run (default) reports counts - including collisionsResolvedToCertain - and refusals without touching data. Executor role only; the caller names the survivor.';

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
