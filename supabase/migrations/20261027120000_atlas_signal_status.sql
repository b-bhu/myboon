-- squawk-ignore-file adding-field-with-default, require-concurrent-index-creation, disallowed-unique-constraint, constraint-missing-not-valid, prefer-bigint-over-int, ban-drop-table, ban-drop-column, prefer-robust-stmts
-- Why each ignored rule is safe here: prod has 51 signals, empty decisions and
-- item_signals, and the 51 signal_queue rows are all ready with 0 attempts, so
-- every default makes an existing row exactly what its queue row said (ready =
-- received and unclaimed). CONCURRENTLY cannot run inside this transaction and
-- each new index is partial over a 51-row table. The unique constraints land on
-- empty tables, and their check-consistency constraint companions are validated
-- against at most 51 rows, so NOT VALID + a second validate pass would only add
-- scans without benefit. attempts, latency_ms and shadow_latency_ms are integer
-- on purpose (attempt caps are 3-5; a 24-day latency is a bug, not an int32
-- overflow risk). No IF [NOT] EXISTS because the file runs as one transaction
-- and a failure rolls back fully - conditionals would only hide a half-applied
-- state; dropping signal_queue/enqueued_at is the point of #478.
-- #478 V4: signal states and the Jev/Clef decision log.
--   atlas.signals    gets status + claim columns; the scout insert is the
--                    handoff (status defaults to received, next_attempt_at to
--                    now(), so every existing row stays claimable). enqueued_at
--                    goes away: the scout no longer stamps it.
--   atlas.decisions  gets the decision provenance columns, unique per signal;
--                    atlas.item_signals unique per signal (one entity_item).
--   atlas.signal_queue is dropped; its 51 ready rows carry nothing (status
--                    default covers them). atlas.queue_* now accept only
--                    decision_queue (create-or-replace keeps their grants) and
--                    dead_letter/decision_queue stay untouched.
--   New claim surface: atlas.signal_claim / signal_finish / signal_fail, one
--   short UPDATE ... FOR UPDATE SKIP LOCKED each, no lock held across any
--   external call.
-- Prod numbers when written (2026-10-27): signals 51, decisions 0, item_signals
-- 0, signal_queue 51 ready rows with 0 attempts.
-- service_role grants: column grants on signals/decisions are the ones a stage
-- needs to claim, finish, fail and read a signal. Earlier grants (INSERT on
-- signals and SELECT on signal_id/source/source_id from 20261026011119, SELECT
-- on created_at from 20261026011428) are NOT repeated here. The queue_* EXECUTE
-- grant from 20261026011119 survives create-or-replace untouched.
-- Rollback: supabase/rollbacks/20261027120000_atlas_signal_status.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 1. Status + claim columns on atlas.signals (received + unclaimed + due = claimable).
alter table atlas.signals add column status text not null default 'received';
alter table atlas.signals add column parked_reason text null;
alter table atlas.signals add column claim_token uuid null;
alter table atlas.signals add column claim_expires_at timestamptz null;
alter table atlas.signals add column claimed_by text null;
alter table atlas.signals add column attempts integer not null default 0;
alter table atlas.signals add column last_error text null;
alter table atlas.signals add column next_attempt_at timestamptz not null default now();

alter table atlas.signals add constraint signals_status_check
  check (status in ('received','analysed','written','parked','dead','deleted'));
alter table atlas.signals add constraint signals_parked_reason_check
  check (status <> 'parked' or (parked_reason is not null and parked_reason <> ''));
alter table atlas.signals add constraint signals_claim_pair_check
  check ((claim_token is null) = (claim_expires_at is null));

create index signals_received_claimable_idx on atlas.signals (next_attempt_at, signal_id) where status = 'received';
create index signals_claim_expiry_idx on atlas.signals (claim_expires_at) where claim_token is not null;

-- 2. Decision provenance.
alter table atlas.decisions add column shortlist jsonb null;
alter table atlas.decisions add column item_ids jsonb null;
alter table atlas.decisions add column prompt_version text null;
alter table atlas.decisions add column model_name text null;
alter table atlas.decisions add column model_version text null;
alter table atlas.decisions add column decided_by text null;
alter table atlas.decisions add column answer jsonb null;
alter table atlas.decisions add column probabilities jsonb null;
alter table atlas.decisions add column runner_up_margin numeric null;
alter table atlas.decisions add column latency_ms integer null;
alter table atlas.decisions add column outcome text null;
alter table atlas.decisions add column primary_error text null;
alter table atlas.decisions add column shadow_answer jsonb null;
alter table atlas.decisions add column shadow_probabilities jsonb null;
alter table atlas.decisions add column shadow_latency_ms integer null;
alter table atlas.decisions add column shadow_outcome text null;
alter table atlas.decisions add column shadow_model_version text null;

alter table atlas.decisions add constraint decisions_decided_by_check
  check (decided_by in ('jev','clef'));
alter table atlas.decisions add constraint decisions_runner_up_margin_check
  check (runner_up_margin between 0 and 1);
alter table atlas.decisions add constraint decisions_signal_id_key unique (signal_id);

alter table atlas.item_signals add constraint item_signals_signal_id_key unique (signal_id);

-- 3. The signal queue is replaced by the status columns.
drop table atlas.signal_queue;

-- queue_* handle only decision_queue now; signatures, defaults and grants are
-- unchanged (create-or-replace preserves the 20261026011119 EXECUTE grant).
create or replace function atlas.queue_claim(p_queue text, p_limit integer default 10, p_lease interval default '5 minutes')
returns table (id bigint, ref_id text, attempts bigint, lease_token uuid, lease_expires_at timestamptz)
language plpgsql set search_path = '' as $$
begin
  if p_queue <> 'decision_queue' then raise exception 'unknown queue %', p_queue; end if;
  return query execute format($q$
    with expired as (
      select q.id from atlas.decision_queue q
       where q.status = 'leased' and q.lease_expires_at < pg_catalog.now()
       order by q.lease_expires_at
       limit $1 for update skip locked
    ), ready as (
      select q.id from atlas.decision_queue q
       where q.status = 'ready' and q.available_at <= pg_catalog.now()
       order by q.priority desc, q.available_at, q.id
       limit $1 for update skip locked
    ), picked as (
      select id from expired union all select id from ready limit $1
    )
    update atlas.decision_queue q
       set status = 'leased', attempts = q.attempts + 1,
           lease_token = atlas.uuidv7(), lease_expires_at = pg_catalog.now() + $2
      from picked p where q.id = p.id
    returning q.id, q.decision_id::text, q.attempts, q.lease_token, q.lease_expires_at
  $q$) using p_limit, p_lease;
end $$;

create or replace function atlas.queue_heartbeat(p_queue text, p_id bigint, p_token uuid, p_lease interval default '5 minutes')
returns boolean language plpgsql set search_path = '' as $$
declare v_n integer;
begin
  if p_queue <> 'decision_queue' then raise exception 'unknown queue %', p_queue; end if;
  update atlas.decision_queue
     set lease_expires_at = pg_catalog.now() + p_lease
   where id = p_id and lease_token = p_token and status = 'leased';
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

create or replace function atlas.queue_complete(p_queue text, p_id bigint, p_token uuid)
returns boolean language plpgsql set search_path = '' as $$
declare v_n integer;
begin
  if p_queue <> 'decision_queue' then raise exception 'unknown queue %', p_queue; end if;
  delete from atlas.decision_queue where id = p_id and lease_token = p_token;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

create or replace function atlas.queue_fail(p_queue text, p_id bigint, p_token uuid, p_error text, p_backoff interval default '30 seconds')
returns text language plpgsql set search_path = '' as $$
declare v_row jsonb;
begin
  if p_queue <> 'decision_queue' then raise exception 'unknown queue %', p_queue; end if;
  execute $f$
    delete from atlas.decision_queue q
     where q.id = $1 and q.lease_token = $2 and q.attempts >= q.max_attempts
    returning to_jsonb(q)
  $f$ into v_row using p_id, p_token;
  if v_row is not null then
    insert into atlas.dead_letter (queue_name, ref_id, attempts, last_error, row_data)
    values (p_queue, v_row ->> 'decision_id', (v_row ->> 'attempts')::bigint, p_error, v_row);
    return 'dead_letter';
  end if;
  execute $f$
    update atlas.decision_queue
       set status = 'ready', lease_token = null, lease_expires_at = null, last_error = $3,
           available_at = pg_catalog.now() + $4 * attempts
     where id = $1 and lease_token = $2
    returning id
  $f$ into v_row using p_id, p_token, p_error, p_backoff;
  return case when v_row is null then 'lost_lease' else 'retry' end;
end $$;

-- 4. The scout no longer stamps enqueued_at.
alter table atlas.signals drop column enqueued_at;

-- 5. Claim surface. SECURITY INVOKER, so every caller needs the table grants
-- below. No lock and no transaction is held by these functions; the caller
-- runs one statement per step and the Jev/Clef work happens in between.
-- Expired claims at the attempt cap become dead here (a worker that crashes on a
-- signal never reaches signal_fail); below the cap they are handed out again.
create function atlas.signal_claim(p_lease interval, p_worker text, p_max_attempts integer)
returns table (signal_id text, claim_token uuid, attempts integer)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update atlas.signals s
     set status = 'dead',
         last_error = 'claim expired after max attempts',
         claim_token = null,
         claim_expires_at = null,
         claimed_by = null
   where s.status = 'received'
     and s.claim_expires_at < pg_catalog.now()
     and s.attempts >= p_max_attempts;
  return query
    update atlas.signals s
       set claim_token = atlas.uuidv7(),
           claim_expires_at = pg_catalog.now() + p_lease,
           claimed_by = p_worker,
           attempts = s.attempts + 1
     where s.signal_id = (
             select c.signal_id
               from atlas.signals c
              where (c.status = 'received' and c.claim_token is null
                     and c.next_attempt_at <= pg_catalog.now())
                 or (c.status = 'received' and c.claim_expires_at < pg_catalog.now())
              order by c.next_attempt_at, c.signal_id
              for update skip locked
              limit 1)
    returning s.signal_id, s.claim_token, s.attempts;
end $$;

create function atlas.signal_finish(p_signal_id text, p_token uuid, p_status text, p_parked_reason text, p_decision jsonb)
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
       shadow_outcome, shadow_model_version)
    select d.schema_version, d.signal_id, d.analyst_version, d.decision_type, d.action, d.confidence,
           d.reason, d.shortlist, d.item_ids, d.prompt_version, d.model_name, d.model_version,
           d.decided_by, d.answer, d.probabilities, d.runner_up_margin, d.latency_ms, d.outcome,
           d.primary_error, d.shadow_answer, d.shadow_probabilities, d.shadow_latency_ms,
           d.shadow_outcome, d.shadow_model_version
      from jsonb_populate_record(null::atlas.decisions, p_decision) d
     on conflict (signal_id) do nothing;
  end if;
  return true;
end $$;

create function atlas.signal_fail(p_signal_id text, p_token uuid, p_error text, p_backoff interval, p_max_attempts integer)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_attempts integer;
  v_updated integer;
begin
  select s.attempts into v_attempts
    from atlas.signals s
   where s.signal_id = p_signal_id
     and s.claim_token = p_token
     and s.claim_expires_at >= pg_catalog.now();
  if v_attempts is null then
    return 'lost_claim';
  end if;
  if v_attempts >= p_max_attempts then
    update atlas.signals s
       set status = 'dead',
           last_error = p_error,
           claim_token = null,
           claim_expires_at = null,
           claimed_by = null
     where s.signal_id = p_signal_id and s.claim_token = p_token;
    return 'dead';
  end if;
  update atlas.signals s
     set last_error = p_error,
         next_attempt_at = pg_catalog.now() + p_backoff * pg_catalog.power(2, s.attempts - 1),
         claim_token = null,
         claim_expires_at = null,
         claimed_by = null
   where s.signal_id = p_signal_id and s.claim_token = p_token;
  get diagnostics v_updated = row_count;
  return case when v_updated = 1 then 'retry' else 'lost_claim' end;
end $$;

-- 6. Grants. The three functions: service_role only. On the tables: the columns
-- the claim/finish/fail statements actually touch (SELECT on the columns read in
-- WHERE or RETURNING, UPDATE on the ones they set, INSERT on decisions plus the
-- ON CONFLICT arbiter column). Nothing for anon or authenticated.
revoke all on function
  atlas.signal_claim(interval, text, integer),
  atlas.signal_finish(text, uuid, text, text, jsonb),
  atlas.signal_fail(text, uuid, text, interval, integer)
  from public;
grant execute on function
  atlas.signal_claim(interval, text, integer),
  atlas.signal_finish(text, uuid, text, text, jsonb),
  atlas.signal_fail(text, uuid, text, interval, integer)
  to service_role;

grant select (status, parked_reason, claim_token, claim_expires_at, claimed_by, attempts,
              last_error, next_attempt_at, text, excerpt, link, occurred_at)
  on atlas.signals to service_role;
grant update (status, parked_reason, claim_token, claim_expires_at, claimed_by, attempts,
              last_error, next_attempt_at)
  on atlas.signals to service_role;
grant insert on atlas.decisions to service_role;
grant select (signal_id) on atlas.decisions to service_role;

commit;