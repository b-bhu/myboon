-- #512: dedicated login role for the analyst entrypoint (direct pg Pool through the
-- session pooler), instead of service_role. Ships NOLOGIN; the password and LOGIN are set
-- separately on prod after CTO approval (alter role ... login password ... connection limit 5).
-- Grants are the subset of service_role's atlas grants that packages/analyst uses:
-- signal_claim/finish/fail, PgDecisionSink (decisions, items, shelves), signal reads,
-- tool_log. RLS is on for every atlas table, so each grant gets a matching policy.
-- Rollback: supabase/rollbacks/20261030120000_atlas_analyst_worker_role.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'analyst_worker') then
    create role analyst_worker nologin noinherit;
  end if;
end $$;

grant usage on schema atlas to analyst_worker;

-- signals: claim/finish/fail are SECURITY INVOKER, so the role needs the columns they touch.
grant select (signal_id, source, source_id, status, text, excerpt, link, occurred_at, created_at,
              attempts, claim_token, claim_expires_at, claimed_by, last_error, next_attempt_at,
              parked_reason)
  on atlas.signals to analyst_worker;
grant update (status, attempts, claim_token, claim_expires_at, claimed_by, last_error,
              next_attempt_at, parked_reason)
  on atlas.signals to analyst_worker;

-- decisions: PgDecisionSink insert ... returning signal_id, and signal_finish's insert.
grant insert (action, analyst_version, answer, confidence, created_at, decided_by, decision,
              decision_type, id, item_ids, item_key, latency_ms, merged_into_id, model_name,
              model_version, outcome, primary_error, probabilities, prompt_version, reason,
              runner_up_margin, schema_version, shadow_answer, shadow_latency_ms,
              shadow_model_version, shadow_outcome, shadow_probabilities, shelves, shortlist,
              signal_id, summary, target_item_id, targets)
  on atlas.decisions to analyst_worker;
grant select (decision, signal_id, summary, targets) on atlas.decisions to analyst_worker;

-- items: one entity item per keep target.
grant insert (angle, item_key, main_shelf_id, note, occurred_at, signal_id, summary, title)
  on atlas.items to analyst_worker;
grant select (angle, created_at, id, item_key, main_shelf_id, merged_into_id, note, occurred_at,
              signal_id, status, summary, title, updated_at)
  on atlas.items to analyst_worker;

-- shelves: entity search, active/proposed lookups, proposing a new shelf (returning id).
grant insert (aliases, name, slug, status, summary, type) on atlas.shelves to analyst_worker;
grant select (aliases, card, created_at, id, legacy_entity_id, name, show_in_carousel, slug,
              status, summary, type, updated_at)
  on atlas.shelves to analyst_worker;

-- tool_log (partitioned; RLS and privileges are checked on the parent for inserts through it).
grant insert (duration_ms, error, id, input, logged_at, output, run_id, tool)
  on atlas.tool_log to analyst_worker;
grant usage on sequence atlas.tool_log_id_seq to analyst_worker;

-- Functions (full signatures). uuidv7 is the id default on decisions/items/shelves and is
-- called by signal_claim; analyst_targets_valid backs the decisions targets CHECK.
grant execute on function atlas.signal_claim(interval, text, integer) to analyst_worker;
grant execute on function atlas.signal_finish(text, uuid, text, text, jsonb) to analyst_worker;
grant execute on function atlas.signal_fail(text, uuid, text, interval, integer) to analyst_worker;
grant execute on function atlas.analyst_targets_valid(jsonb) to analyst_worker;
grant execute on function atlas.uuidv7() to analyst_worker;

-- RLS policies, scoped to this role only.
create policy analyst_worker_select on atlas.signals for select to analyst_worker using (true);
create policy analyst_worker_update on atlas.signals for update to analyst_worker using (true) with check (true);
create policy analyst_worker_select on atlas.decisions for select to analyst_worker using (true);
create policy analyst_worker_insert on atlas.decisions for insert to analyst_worker with check (true);
create policy analyst_worker_select on atlas.items for select to analyst_worker using (true);
create policy analyst_worker_insert on atlas.items for insert to analyst_worker with check (true);
create policy analyst_worker_select on atlas.shelves for select to analyst_worker using (true);
create policy analyst_worker_insert on atlas.shelves for insert to analyst_worker with check (true);
create policy analyst_worker_insert on atlas.tool_log for insert to analyst_worker with check (true);

commit;
