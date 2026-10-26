-- squawk-ignore-file require-concurrent-index-creation, prefer-robust-stmts
-- Why: every index here is on a table created in this same migration (empty, no readers),
-- and CONCURRENTLY cannot run inside the migration transaction. The file runs as one
-- transaction, so a failure rolls back fully; IF NOT EXISTS would only hide drift.
-- #478: per-signal state machine. The forward path is received -> analysed -> written;
-- parked, dead_lettered, discarded and deleted are exits. A claim is a uuid token with a
-- lease: only the token holder may advance or fail the row, and the sweeper returns
-- expired claims to their untouched state. Failures retry with exponential backoff until
-- the attempt cap dead-letters them. atlas.jev_decisions logs exactly one row per Jev
-- call (success, error or timeout) with the measured latency.
-- No grants to service_role or other logins on these tables: that is a separate
-- production access decision.
-- Rollback: 20261026220000_atlas_signal_states.down.sql
set lock_timeout = '5s';
set statement_timeout = '60s';

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
-- currently locked by other workers, so concurrent claims never overlap.
create function atlas.signal_claim(p_state text, p_limit integer, p_lease interval, p_worker text)
returns table (signal_id text, claim_token uuid, state text, attempts bigint)
language plpgsql
set search_path = ''
as $$
begin
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

-- Clear expired claims so their signals become claimable again. The state never changed
-- during a claim, so leaving it untouched puts the signal back where it was.
create function atlas.signal_sweep()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_n integer;
begin
  update atlas.signal_states ss
     set claimed_by       = null,
         claim_token      = null,
         claim_expires_at = null
   where ss.claim_token is not null
     and ss.claim_expires_at < pg_catalog.now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Move a claimed signal to p_to. False when the token no longer matches a live claim, so
-- a drifted or crashed worker can never finish work it no longer owns.
create function atlas.signal_advance(p_signal_id text, p_token uuid, p_to text, p_park_reason text default null)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_n integer;
begin
  update atlas.signal_states ss
     set previous_state  = ss.state,
         state           = p_to,
         park_reason     = p_park_reason,
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
-- (now() + p_backoff * 2^(attempts-1)), or dead-letter once attempts >= max_attempts.
-- Returns 'retry', 'dead_lettered' or 'lost_claim' (the claim did not match or had
-- expired, so nothing was changed).
create function atlas.signal_fail(p_signal_id text, p_token uuid, p_error text, p_backoff interval default '30 seconds')
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_dead boolean;
begin
  update atlas.signal_states ss
     set previous_state  = case when ss.attempts >= ss.max_attempts then ss.state else ss.previous_state end,
         state           = case when ss.attempts >= ss.max_attempts then 'dead_lettered' else ss.state end,
         claim_token     = null,
         claim_expires_at = null,
         claimed_by      = null,
         last_error      = p_error,
         available_at    = case
                             when ss.attempts >= ss.max_attempts then ss.available_at
                             else pg_catalog.now() + p_backoff * power(2::float8, ss.attempts::float8 - 1)
                           end
   where ss.signal_id = p_signal_id
     and ss.claim_token = p_token
     and ss.claim_expires_at >= pg_catalog.now()
  returning (ss.attempts >= ss.max_attempts) into v_dead;
  if not found then
    return 'lost_claim';
  end if;
  return case when v_dead then 'dead_lettered' else 'retry' end;
end $$;

revoke all on function atlas.signal_admit(integer) from public;
revoke all on function atlas.signal_claim(text, integer, interval, text) from public;
revoke all on function atlas.signal_sweep() from public;
revoke all on function atlas.signal_advance(text, uuid, text, text) from public;
revoke all on function atlas.signal_fail(text, uuid, text, interval) from public;

-- RLS on, read-only policy for the analyst; nothing for the Supabase API roles.
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