-- squawk-ignore-file ban-drop-table, ban-drop-function, ban-drop-constraint, ban-drop-column, require-concurrent-index-deletion
-- Rollback for supabase/migrations/20261105150000_atlas_em_handoff.sql (#571 task 2).
-- Drops everything the up added. LOSES DATA once the analyst / entity manager use it:
-- decisions.handoff + em_* queue state, entity_items.image_url, item_signals.role (rows stay),
-- atlas.entity_context rows. Guard: refuses unless the session opts in first, e.g.
--   PGOPTIONS="-c myboon.allow_571_wipe=pre-cutover" psql ... -f 20261105150000_atlas_em_handoff.down.sql
-- Every step is IF EXISTS, so it reruns as a no-op.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $g$ begin
  if coalesce(current_setting('myboon.allow_571_wipe', true), '') <> 'pre-cutover' then
    raise exception 'refusing #571 rollback: set myboon.allow_571_wipe = ''pre-cutover'' (only before the analyst/entity manager write handoffs)';
  end if;
end $g$;

revoke select (schema_version, type, priority, fetched_at, numbers, raw_ids, unusual_score, raw_hash)
  on atlas.signals from analyst_worker;
drop policy if exists entity_worker_select on atlas.item_signals;
drop policy if exists entity_worker_insert on atlas.item_signals;
revoke select, insert on atlas.item_signals from entity_worker;
revoke select on atlas.item_signals from service_role;

drop function if exists atlas.em_claim(text, interval, integer);
drop function if exists atlas.em_finish(uuid, uuid, text, uuid);
drop function if exists atlas.em_fail(uuid, uuid, text, interval, integer);
drop table if exists atlas.entity_context;

alter table atlas.item_signals drop constraint if exists item_signals_role_check;
alter table atlas.item_signals drop column if exists role;
alter table atlas.entity_items drop constraint if exists entity_items_image_url_https;
alter table atlas.entity_items drop column if exists image_url;

drop trigger if exists decisions_em_status_insert_guard on atlas.decisions;
drop function if exists atlas.decisions_em_status_insert_guard();
drop index if exists atlas.decisions_em_pending_idx;
drop index if exists atlas.decisions_em_claimed_idx;
drop index if exists atlas.decisions_em_duplicate_of_idx;
alter table atlas.decisions
  drop constraint if exists decisions_handoff_object,
  drop constraint if exists decisions_handoff_version_pos,
  drop constraint if exists decisions_em_status_check,
  drop constraint if exists decisions_em_needs_handoff,
  drop constraint if exists decisions_em_claim_pair,
  drop constraint if exists decisions_em_claimed_has_token,
  drop constraint if exists decisions_em_duplicate_of,
  drop constraint if exists decisions_em_attempts_nonneg,
  drop constraint if exists decisions_em_duplicate_of_fkey,
  drop column if exists handoff,
  drop column if exists handoff_version,
  drop column if exists em_status,
  drop column if exists em_duplicate_of,
  drop column if exists em_claim_token,
  drop column if exists em_claim_expires_at,
  drop column if exists em_claimed_by,
  drop column if exists em_attempts,
  drop column if exists em_last_error,
  drop column if exists em_next_attempt_at,
  drop column if exists em_done_at;

commit;
