-- squawk-ignore-file require-concurrent-index-creation, disallowed-unique-constraint, prefer-robust-stmts, adding-field-with-default, ban-drop-not-null, ban-drop-constraint, constraint-missing-not-valid
-- Why each ignored rule is safe here: prod (2026-10-29) has atlas.items 1982 rows,
-- atlas.decisions 0 rows, atlas.shelves 558 rows. The two new item indexes build in
-- milliseconds on 1982 rows, and CONCURRENTLY cannot run inside this one-transaction
-- file. The targets default is a constant jsonb (metadata-only on PG 11+). No IF
-- [NOT] EXISTS: the file is one transaction, a failure rolls back fully.
-- action loses NOT NULL because new D36 writers set decision instead; shelves_status_check
-- is dropped only to be re-added wider. Validating in the same transaction scans at
-- most 1982 rows (milliseconds), so a separate validate file would add nothing.
-- #503 (D36): store the analyst output contract, several targets per signal, one
-- entity item per target.
--   atlas.decisions  + summary, decision (keep/ignore/unclear), targets (jsonb array,
--                    max 3, unique entity slugs, kind/angle/type enums). action is
--                    legacy: now nullable, backfilled into decision (skip -> ignore).
--                    Existing one-target rows get a 1-element targets.
--   atlas.items      + signal_id, angle, note; one item per (signal, shelf);
--                    timeline index (main_shelf_id, created_at desc, id desc).
--   atlas.item_signals drops unique (signal_id) (D20 one-item rule, superseded).
--   atlas.shelves    status gains 'proposed' (kind: new entities).
--   atlas.signal_finish also stores summary/decision/targets, defaults an omitted
--                    decision_type to file (populate_record nulled it), and enforces
--                    keep|ignore -> analysed, unclear -> parked.
--   Grants: service_role insert on items/shelves (entity manager #482 writes
--                    items.signal_id only; item_signals gets no new grant), insert on atlas.tool_log (analyst tool calls, #504).
-- Rollback: supabase/rollbacks/20261029180000_atlas_analyst_targets.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 1. Target validator (immutable, used by a CHECK).
create function atlas.analyst_targets_valid(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p) = 'array'
     and pg_catalog.jsonb_array_length(p) <= 3
     and not exists (
           select 1 from pg_catalog.jsonb_array_elements(p) t
            where pg_catalog.jsonb_typeof(t) <> 'object'
               or pg_catalog.jsonb_typeof(t -> 'entity') <> 'string'
               or coalesce(t ->> 'entity', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
               or coalesce(t ->> 'kind', '') not in ('existing', 'new')
               or coalesce(t ->> 'angle', '') not in ('new_story', 'existing_story', 'plain_update')
               or coalesce(t ->> 'type', '') not in ('organization','asset','protocol','person','topic','place','event','product','regulation')
               or pg_catalog.jsonb_typeof(t -> 'note') is distinct from 'string')
     and (select pg_catalog.count(distinct t ->> 'entity') from pg_catalog.jsonb_array_elements(p) t)
         = pg_catalog.jsonb_array_length(p)
$$;
revoke all on function atlas.analyst_targets_valid(jsonb) from public;
grant execute on function atlas.analyst_targets_valid(jsonb) to service_role;

-- 2. atlas.decisions: the D36 contract.
alter table atlas.decisions add column summary text null;
alter table atlas.decisions add column decision text null;
alter table atlas.decisions add column targets jsonb not null default '[]'::jsonb;
alter table atlas.decisions alter column action drop not null;

-- The backfill copies shelves.type into targets[].type; stop with a clear message if a
-- referenced shelf type is outside the validator's 9-value enum (prod: 0 decisions).
do $$
begin
  if exists (
       select 1 from atlas.decisions d
         join atlas.shelves s on s.slug = coalesce(d.shelves -> 0 ->> 'slug', d.shelves ->> 0)
        where d.action = 'keep'
          and s.type not in ('organization','asset','protocol','person','topic','place','event','product','regulation')) then
    raise exception 'backfill blocked: a kept decision points at a shelf whose type is outside the target type enum';
  end if;
end $$;

update atlas.decisions d
   set decision = case d.action when 'keep' then 'keep' else 'ignore' end,
       targets = case
         when d.action = 'keep' and pg_catalog.jsonb_array_length(d.shelves) > 0 then
           coalesce((
             select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'entity', s.slug, 'kind', 'existing', 'type', s.type,
                      'angle', 'plain_update', 'note', coalesce(d.reason, '')))
               from atlas.shelves s
              where s.slug = coalesce(d.shelves -> 0 ->> 'slug', d.shelves ->> 0)), '[]'::jsonb)
         else '[]'::jsonb end
 where d.decision is null;

alter table atlas.decisions add constraint decisions_decision_check
  check (decision in ('keep', 'ignore', 'unclear')) not valid;
alter table atlas.decisions validate constraint decisions_decision_check;
-- Every row says what was decided: D36 rows by decision, legacy rows by action.
alter table atlas.decisions add constraint decisions_decision_or_action
  check (decision is not null or action is not null) not valid;
alter table atlas.decisions validate constraint decisions_decision_or_action;
alter table atlas.decisions add constraint decisions_targets_valid
  check (atlas.analyst_targets_valid(targets)) not valid;
alter table atlas.decisions validate constraint decisions_targets_valid;
alter table atlas.decisions add constraint decisions_targets_only_on_keep
  check (decision = 'keep' or targets = '[]'::jsonb) not valid;
alter table atlas.decisions validate constraint decisions_targets_only_on_keep;

-- 3. atlas.items: one item per (signal, shelf) with angle and note.
-- Nothing in the database ties items.angle/note to the matching decisions.targets
-- entry; the entity manager (#482) copies them when it files the item.
alter table atlas.items add column signal_id text null;
alter table atlas.items add column angle text null;
alter table atlas.items add column note text null;
alter table atlas.items add constraint items_signal_id_fkey
  foreign key (signal_id) references atlas.signals (signal_id) not valid;
alter table atlas.items validate constraint items_signal_id_fkey;
alter table atlas.items add constraint items_angle_check
  check (angle in ('new_story', 'existing_story', 'plain_update')) not valid;
alter table atlas.items validate constraint items_angle_check;
create unique index items_signal_id_main_shelf_id_key
  on atlas.items (signal_id, main_shelf_id) where signal_id is not null;
create index items_main_shelf_timeline_idx
  on atlas.items (main_shelf_id, created_at desc, id desc);

-- 3b. atlas.item_signals: #478 made it unique per signal (D20, one entity item per
-- signal). D35/D36 supersede that: a signal feeds up to 3 items. The (item_id,
-- signal_id) primary key still stops duplicate links. Prod item_signals: 0 rows.
alter table atlas.item_signals drop constraint item_signals_signal_id_key;

-- 4. atlas.shelves: proposed entities.
alter table atlas.shelves drop constraint shelves_status_check;
alter table atlas.shelves add constraint shelves_status_check
  check (status in ('active', 'retired', 'proposed')) not valid;
alter table atlas.shelves validate constraint shelves_status_check;

-- 5. signal_finish stores the contract and ties decision to status.
-- decision_type falls back to 'file' (the column default, the only non-merge value);
-- analyst-v1 D36 rows are filings, merges still send decision_type = 'merge'.
create or replace function atlas.signal_finish(p_signal_id text, p_token uuid, p_status text, p_parked_reason text, p_decision jsonb)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_valid_claim boolean;
  v_n integer;
  -- Only D36 writers send decision; the legacy Linker + Story writer (action
  -- keep/skip, may park) is mapped into decision below but not status-checked.
  v_decision text := p_decision ->> 'decision';
begin
  if p_status not in ('analysed', 'parked', 'written', 'deleted') then
    raise exception 'invalid finish status %', p_status;
  end if;
  if v_decision in ('keep', 'ignore') and p_status <> 'analysed' then
    raise exception 'decision % needs status analysed, got %', v_decision, p_status;
  elsif v_decision = 'unclear' and p_status <> 'parked' then
    raise exception 'decision unclear needs status parked, got %', p_status;
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
       shadow_outcome, shadow_model_version, target_item_id, shelves, item_key,
       summary, decision, targets)
    select d.schema_version, d.signal_id, d.analyst_version, coalesce(d.decision_type, 'file'), d.action, d.confidence,
           d.reason, d.shortlist, d.item_ids, d.prompt_version, d.model_name, d.model_version,
           d.decided_by, d.answer, d.probabilities, d.runner_up_margin, d.latency_ms, d.outcome,
           d.primary_error, d.shadow_answer, d.shadow_probabilities, d.shadow_latency_ms,
           d.shadow_outcome, d.shadow_model_version, d.target_item_id, coalesce(d.shelves, '[]'::jsonb), d.item_key,
           d.summary,
           coalesce(d.decision, case d.action when 'keep' then 'keep' when 'skip' then 'ignore' end),
           coalesce(d.targets, '[]'::jsonb)
      from jsonb_populate_record(null::atlas.decisions, p_decision) d
     on conflict (signal_id) do nothing;
  end if;
  return true;
end $$;

-- 6. Grants (service_role only; nothing for anon/authenticated).
grant select (summary, decision, targets) on atlas.decisions to service_role;
grant insert (item_key, title, summary, main_shelf_id, occurred_at, signal_id, angle, note)
  on atlas.items to service_role;
grant insert (slug, name, type, aliases, summary, status) on atlas.shelves to service_role;
-- atlas.tool_log needs pg_cron and is skipped on plain local Postgres, hence the guard.
do $$
begin
  if pg_catalog.to_regclass('atlas.tool_log') is not null then
    execute 'grant insert on atlas.tool_log to service_role';
  end if;
end $$;

commit;
