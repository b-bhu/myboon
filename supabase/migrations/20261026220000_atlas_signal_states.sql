-- squawk-ignore-file require-concurrent-index-creation, prefer-robust-stmts, ban-drop-constraint
-- Why: every index here is on a table created in this same migration (empty, no readers),
-- and CONCURRENTLY cannot run inside the migration transaction. The file runs as one
-- transaction, so a failure rolls back fully; IF NOT EXISTS would only hide drift. The
-- dead_letter constraint swap is DROP + ADD ... NOT VALID + VALIDATE (ban-drop-constraint
-- ignored): an inline CHECK cannot be widened in place, the swap is same-named and the
-- table is tiny, and a same-file swap cannot be made robust anyway (prefer-robust-stmts
-- ignored above).
-- #478: per-signal state machine. The forward path is received -> analysed -> written;
-- parked, dead_lettered, discarded and deleted are exits, and signal_advance enforces
-- exactly the allowed transitions in SQL. dead_lettered deliberately stays a terminal
-- state on atlas.signal_states itself (PR #485 review, CTO): the claim filter and the
-- per-state counts the stage tooling reports need the state on the row. What leaves the
-- table is the diagnosis payload: every dead-lettering -- sweeper expiry and signal_fail
-- at the attempt cap -- also inserts one row into the existing atlas.dead_letter table
-- (queue_name 'signal_states', ref_id = signal_id, attempts, last_error, and the
-- pre-dead-letter row as row_data), so the reason and the payload live in one store for
-- engineering review, exactly like atlas.queue_fail has done since #441.
-- A claim is a uuid token with a lease: only the token holder may advance or fail the
-- row, and the sweeper returns expired claims to their untouched state -- or dead-letters
-- them (row + dead_letter row) once the attempt cap is reached. Failures retry with
-- exponential backoff until the cap. Advancing starts the next stage with a full retry
-- budget: attempts = 0 and available_at = now(). atlas.jev_decisions logs exactly one row
-- per Jev call (success, error or timeout) with the measured latency.
-- #474 grants service_role insert on atlas.dead_letter; these signal_* functions are
-- SECURITY INVOKER, so their dead-letter inserts ride on that grant, not on new ones.
-- #485 review (DB Guy): the analyst client connects as service_role (one shared team
-- login, per CTO). After the revoke loop it gets EXECUTE on the five signal_* functions,
-- select/insert/update on atlas.signal_states and select/insert on atlas.jev_decisions.
-- Nothing for anon/authenticated. The #441 dead_letter queue_name check allowed only the
-- two work queues; it is swapped for the same-named constraint that also allows
-- 'signal_states' (NOT VALID then VALIDATE: existing rows are re-checked without a long
-- exclusive scan of a table that is empty today).
-- Rollback: 20261026220000_atlas_signal_states.down.sql
set lock_timeout = '5s';
set statement_timeout = '60s';

-- Shared dead-letter store: mirror the inline check the #441 migration gave
-- atlas.dead_letter.queue_name (constraint name dead_letter_queue_name_check),
-- now also allowing the signal_states queue.
alter table atlas.dead_letter drop constraint dead_letter_queue_name_check;
alter table atlas.dead_letter
  add constraint dead_letter_queue_name_check
    check (queue_name in ('signal_queue','decision_queue','signal_states')) not valid;
alter table atlas.dead_letter validate constraint dead_letter_queue_name_check;

-- Small, hot table: vacuum early, leave room for HOT updates (claims update rows often).
create table atlas.signal_states (
  signal_id        text primary key references atlas.signals (signal_id),
  state            text not null default 'received'
                   check (state in ('received','analysed','written','parked','dead_lettered','discarded','deleted')),
  previous_state   text
                   check (previous_state in ('received','analysed','written','parked','dead_lettered','discarded','deleted')),
  park_reason      text,
  attempts         bigint not null default 0,
  max_attempts     bigint not null default 5 check (max_attempts > 0),
  available_at     timestamptz not null default now(),
  claimed_by       text,
  claim_token      uuid,
  claim_expires_at timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint signal_states_parked_reason check (state <> 'parked' or (park_reason is not null and park_reason <> '')),
  constraint signal_states_claim_shape check ((claim_token is null) = (claim_expires_at is null))
) with (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 50, autovacuum_analyze_scale_factor = 0.02);
create index signal_states_claimable_idx on atlas.signal_states (state, available_at) where claim_token is null;
create index signal_states_claim_expiry_idx on atlas.signal_states (claim_expires_at) where claim_token is not null;
create trigger signal_states_touch before update on atlas.signal_states
  for each row execute function atlas.touch_updated_at();

-- Append-only Jev decision log.
create table atlas.jev_decisions (
  id            uuid primary key default atlas.uuidv7(),
  signal_id     text not null references atlas.signals (signal_id),
  stage         text not null,
  outcome       text not null check (outcome in ('success','error','timeout')),
  input_case    jsonb not null,
  answer        jsonb,
  probability   double precision check (probability between 0 and 1),
  runner_up     jsonb,
  model_version text not null,
  error         text,
  latency_ms    bigint,
  created_at    timestamptz not null default now(),
  constraint jev_decisions_success_has_answer check ((outcome = 'success') = (answer is not null))
);
create index jev_decisions_signal_created_idx on atlas.jev_decisions (signal_id, created_at);

-- Admit up to p_limit signals that have no state row yet, as 'received'. Idempotent.
create function atlas.signal_admit(p_limit integer default 1000)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_n integer;
begin
  with picked as (
    select s.signal_id
      from atlas.signals s
      left join atlas.signal_states ss on ss.signal_id = s.signal_id
     where ss.signal_id is null
     order by s.signal_id
     limit p_limit
  )
  insert into atlas.signal_states (signal_id)
  select p.signal_id from picked p
  on conflict (signal_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Claim up to p_limit signals in p_state for p_worker. The claim token is the only thing
-- that may later advance or fail the row, and it expires after p_lease. Skips rows
-- currently locked by other workers, so concurrent claims never overlap. Terminal states
-- are never claimable: dead_lettered and deleted are exits, not stages.
create function atlas.signal_claim(p_state text, p_limit integer, p_lease interval, p_worker text)
returns table (signal_id text, claim_token uuid, state text, attempts bigint)
language plpgsql
set search_path = ''
as $$
begin
  if p_state in ('dead_lettered', 'deleted') then
    raise exception 'state % is not claimable', p_state;
  end if;
  return query
  update atlas.signal_states ss
     set claim_token      = atlas.uuidv7(),
         claim_expires_at = pg_catalog.now() + p_lease,
         claimed_by       = p_worker,
         attempts         = ss.attempts + 1
    from (
      select c.signal_id
        from atlas.signal_states c
       where c.state = p_state
         and c.claim_token is null
         and c.available_at <= pg_catalog.now()
       order by c.available_at, c.signal_id
       limit p_limit
       for update skip locked
    ) picked
   where ss.signal_id = picked.signal_id
  returning ss.signal_id, ss.claim_token, ss.state, ss.attempts;
end $$;

-- Clear expired claims so their signals become claimable again -- or dead-letter them
-- once the attempt cap is reached: the row flips to the terminal dead_lettered state
-- (its signal row is kept) and one atlas.dead_letter row carries the reason and the
-- pre-dead-letter payload. Returns how many expired claims were handled.
create function atlas.signal_sweep()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_dead integer;
  v_cleared integer;
begin
  with expired as (
    select ss.signal_id, ss.attempts, to_jsonb(ss) as row_before
      from atlas.signal_states ss
     where ss.claim_token is not null
       and ss.claim_expires_at < pg_catalog.now()
       and ss.attempts >= ss.max_attempts
     order by ss.signal_id
     for update skip locked
  ), dead as (
    update atlas.signal_states ss
       set previous_state  = e.row_before ->> 'state',
           state           = 'dead_lettered',
           last_error      = 'claim expired',
           claimed_by      = null,
           claim_token     = null,
           claim_expires_at = null
      from expired e
     where ss.signal_id = e.signal_id
    returning ss.signal_id, e.attempts, e.row_before
  ), letters as (
    insert into atlas.dead_letter (queue_name, ref_id, attempts, last_error, row_data)
    select 'signal_states', d.signal_id, d.attempts, 'claim expired', d.row_before
      from dead d
  )
  select count(*) from dead into v_dead;

  update atlas.signal_states ss
     set claimed_by       = null,
         claim_token      = null,
         claim_expires_at = null
   where ss.claim_token is not null
     and ss.claim_expires_at < pg_catalog.now();
  get diagnostics v_cleared = row_count;
  return v_dead + v_cleared;
end $$;

-- Move a claimed signal to p_to. False when the token no longer matches a live claim, so
-- a drifted or crashed worker can never finish work it no longer owns. Raises
-- 'illegal transition <from> -> <to>' unless p_to is allowed from the row's current
-- state: received/analysed/parked may park, discard or delete (received and parked may
-- also resume/return), analysed finishes to written, written and discarded may only be
-- deleted. dead_lettered and deleted are terminal and never advance. Advancing starts
-- the next stage with a full retry budget: attempts reset to 0, available_at to now().
create function atlas.signal_advance(p_signal_id text, p_token uuid, p_to text, p_park_reason text default null)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_from text;
  v_n integer;
begin
  select ss.state into v_from
    from atlas.signal_states ss
   where ss.signal_id = p_signal_id
     and ss.claim_token = p_token
     and ss.claim_expires_at >= pg_catalog.now()
   for update;
  if v_from is null then
    return false;
  end if;
  if not (
       (v_from = 'received'  and p_to in ('analysed','parked','discarded','deleted')) or
       (v_from = 'analysed'  and p_to in ('written','parked','discarded','deleted')) or
       (v_from = 'parked'    and p_to in ('received','discarded','deleted')) or
       (v_from = 'written'   and p_to = 'deleted') or
       (v_from = 'discarded' and p_to = 'deleted')
     ) then
    raise exception 'illegal transition % -> %', v_from, p_to;
  end if;
  update atlas.signal_states ss
     set previous_state  = ss.state,
         state           = p_to,
         park_reason     = p_park_reason,
         attempts        = 0,
         available_at    = pg_catalog.now(),
         claim_token     = null,
         claim_expires_at = null,
         claimed_by      = null,
         last_error      = null
   where ss.signal_id = p_signal_id
     and ss.claim_token = p_token
     and ss.claim_expires_at >= pg_catalog.now();
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- Handle a failed stage run for a claimed signal: retry with exponential backoff
-- (now() + p_backoff * 2^(attempts-1)), or at the attempt cap dead-letter: the row
-- flips to the terminal dead_lettered state (its signal row is kept) and one
-- atlas.dead_letter row carries the reason and the pre-dead-letter payload.
-- Returns 'retry', 'dead_lettered' or 'lost_claim' (the claim did not match or had
-- expired, so nothing was changed).
create function atlas.signal_fail(p_signal_id text, p_token uuid, p_error text, p_backoff interval default '30 seconds')
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_row atlas.signal_states;
begin
  select ss.* into v_row
    from atlas.signal_states ss
   where ss.signal_id = p_signal_id
     and ss.claim_token = p_token
     and ss.claim_expires_at >= pg_catalog.now()
   for update;
  if not found then
    return 'lost_claim';
  end if;
  if v_row.attempts >= v_row.max_attempts then
    update atlas.signal_states ss
       set previous_state  = v_row.state,
           state           = 'dead_lettered',
           claim_token     = null,
           claim_expires_at = null,
           claimed_by      = null,
           last_error      = p_error
     where ss.signal_id = v_row.signal_id;
    insert into atlas.dead_letter (queue_name, ref_id, attempts, last_error, row_data)
    values ('signal_states', v_row.signal_id, v_row.attempts, p_error, to_jsonb(v_row));
    return 'dead_lettered';
  end if;
  update atlas.signal_states ss
     set claim_token     = null,
         claim_expires_at = null,
         claimed_by      = null,
         last_error      = p_error,
         available_at    = pg_catalog.now() + p_backoff * power(2::float8, v_row.attempts::float8 - 1)
   where ss.signal_id = v_row.signal_id;
  return 'retry';
end $$;

revoke all on function atlas.signal_admit(integer) from public;
revoke all on function atlas.signal_claim(text, integer, interval, text) from public;
revoke all on function atlas.signal_sweep() from public;
revoke all on function atlas.signal_advance(text, uuid, text, text) from public;
revoke all on function atlas.signal_fail(text, uuid, text, interval) from public;

-- RLS on, read-only policy for the analyst; the revoke loop clears the Supabase API
-- roles before service_role is given exactly its #485 surface below.
do $$
declare t text; r text;
begin
  foreach t in array array['signal_states','jev_decisions'] loop
    execute format('alter table atlas.%I enable row level security', t);
    execute format('create policy analyst_read on atlas.%I for select to atlas_analyst using (true)', t);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
        execute format('revoke all on atlas.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;

-- #485 review (DB Guy): the analyst stages run as service_role (one shared team login,
-- per CTO). EXECUTE because the signal_* functions are SECURITY INVOKER and keep relying
-- on #474's insert on atlas.dead_letter for their dead-letter inserts.
grant execute on function
  atlas.signal_admit(integer),
  atlas.signal_claim(text, integer, interval, text),
  atlas.signal_sweep(),
  atlas.signal_advance(text, uuid, text, text),
  atlas.signal_fail(text, uuid, text, interval)
  to service_role;
grant select, insert, update on table atlas.signal_states to service_role;
grant select, insert on table atlas.jev_decisions to service_role;