-- squawk-ignore-file disallowed-unique-constraint, ban-drop-column, prefer-robust-stmts, constraint-missing-not-valid, ban-drop-constraint, adding-not-nullable-field, ban-drop-function, require-concurrent-index-deletion
-- Why: dropping the #503 columns is the point of the rollback; the file is one
-- transaction. Old rows keep their data (action is refilled from decision first).
-- decisions/items are tiny (0 and ~2k rows), so plain DROP INDEX and SET NOT NULL hold
-- their locks for milliseconds.
-- Rollback of 20261029180000 (#503). Refuses to run while proposed shelves exist,
-- because the old status check cannot hold them; retire or delete them first.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if pg_catalog.to_regclass('atlas.tool_log') is not null then
    execute 'revoke insert on atlas.tool_log from service_role';
  end if;
end $$;
revoke select, insert on atlas.item_signals from service_role;
revoke insert (slug, name, type, aliases, summary, status) on atlas.shelves from service_role;
revoke insert (item_key, title, summary, main_shelf_id, occurred_at, signal_id, angle, note)
  on atlas.items from service_role;
revoke select (summary, decision, targets) on atlas.decisions from service_role;

do $$
begin
  if exists (select 1 from atlas.shelves where status = 'proposed') then
    raise exception 'rollback blocked: atlas.shelves has proposed rows';
  end if;
end $$;
alter table atlas.shelves drop constraint shelves_status_check;
alter table atlas.shelves add constraint shelves_status_check
  check (status in ('active', 'retired'));

do $$
begin
  if exists (select 1 from atlas.item_signals group by signal_id having count(*) > 1) then
    raise exception 'rollback blocked: a signal links to several items; the old unique (signal_id) cannot hold';
  end if;
end $$;
alter table atlas.item_signals add constraint item_signals_signal_id_key unique (signal_id);

drop index atlas.items_main_shelf_timeline_idx;
drop index atlas.items_signal_id_main_shelf_id_key;
alter table atlas.items drop constraint items_angle_check;
alter table atlas.items drop constraint items_signal_id_fkey;
alter table atlas.items drop column note;
alter table atlas.items drop column angle;
alter table atlas.items drop column signal_id;

alter table atlas.decisions drop constraint decisions_targets_only_on_keep;
alter table atlas.decisions drop constraint decisions_targets_valid;
alter table atlas.decisions drop constraint decisions_decision_or_action;
alter table atlas.decisions drop constraint decisions_decision_check;
update atlas.decisions set action = case decision when 'keep' then 'keep' else 'skip' end
 where action is null;
alter table atlas.decisions alter column action set not null;
alter table atlas.decisions drop column targets;
alter table atlas.decisions drop column decision;
alter table atlas.decisions drop column summary;
drop function atlas.analyst_targets_valid(jsonb);

-- Restore the 20261027180000 signal_finish body.
create or replace function atlas.signal_finish(p_signal_id text, p_token uuid, p_status text, p_parked_reason text, p_decision jsonb)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_valid_claim boolean;
  v_n integer;
begin
  if p_status not in ('analysed', 'parked', 'written', 'deleted') then
    raise exception 'invalid finish status %', p_status;
  end if;
  select exists (
           select 1 from atlas.signals s
            where s.signal_id = p_signal_id
              and s.claim_token = p_token
              and s.claim_expires_at >= pg_catalog.now())
    into v_valid_claim;
  if not v_valid_claim then
    return false;
  end if;
  update atlas.signals s
     set status = p_status,
         parked_reason = case when p_status = 'parked' then p_parked_reason else null end,
         claim_token = null,
         claim_expires_at = null,
         claimed_by = null
   where s.signal_id = p_signal_id
     and s.claim_token = p_token
     and s.claim_expires_at >= pg_catalog.now();
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    return false;
  end if;
  if p_decision is not null then
    insert into atlas.decisions
      (schema_version, signal_id, analyst_version, decision_type, action, confidence,
       reason, shortlist, item_ids, prompt_version, model_name, model_version,
       decided_by, answer, probabilities, runner_up_margin, latency_ms, outcome,
       primary_error, shadow_answer, shadow_probabilities, shadow_latency_ms,
       shadow_outcome, shadow_model_version, target_item_id, shelves, item_key)
    select d.schema_version, d.signal_id, d.analyst_version, d.decision_type, d.action, d.confidence,
           d.reason, d.shortlist, d.item_ids, d.prompt_version, d.model_name, d.model_version,
           d.decided_by, d.answer, d.probabilities, d.runner_up_margin, d.latency_ms, d.outcome,
           d.primary_error, d.shadow_answer, d.shadow_probabilities, d.shadow_latency_ms,
           d.shadow_outcome, d.shadow_model_version, d.target_item_id, coalesce(d.shelves, '[]'::jsonb), d.item_key
      from jsonb_populate_record(null::atlas.decisions, p_decision) d
     on conflict (signal_id) do nothing;
  end if;
  return true;
end $$;

commit;
