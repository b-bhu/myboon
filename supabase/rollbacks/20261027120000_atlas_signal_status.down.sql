-- squawk-ignore-file ban-drop-function, ban-drop-column, ban-drop-constraint, require-concurrent-index-deletion, require-concurrent-index-creation, prefer-robust-stmts
-- Why: exact inverse of 20261027120000_atlas_signal_status.sql. Dropping the
-- objects the migration created and rebuilding the ones it removed (signal_queue,
-- enqueued_at, the original queue_* bodies) is the requirement, not a hazard:
-- atlas schema objects are still internal (#441), every statement runs in one
-- transaction, and IF EXISTS would hide a half-applied state. The recreated
-- signal_queue indexes are over an empty table built three statements earlier,
-- and the dropped signal indexes are partial over 51 prod rows, so CONCURRENTLY
-- (which cannot run inside this transaction) adds moving parts without benefit.
-- Restores the pre-migration schema exactly: the same table options, indexes,
-- constraints, RLS policy, revokes and service_role grants the earlier migrations
-- created (20261025100100_atlas_queues, 20261026011119_atlas_scout_service_role_grants,
-- 20261026011428_atlas_signals_enqueued_at), and the original atlas.queue_* bodies
-- copied verbatim from 20261025100100 (create-or-replace keeps the EXECUTE grants).
set lock_timeout = '5s';
set statement_timeout = '60s';

-- 1. The new claim surface.
drop function atlas.signal_fail(text, uuid, text, interval, integer);
drop function atlas.signal_finish(text, uuid, text, text, jsonb);
drop function atlas.signal_claim(interval, text);

-- 2. Column grants the migration added (signals/decisions).
revoke select (status, parked_reason, claim_token, claim_expires_at, claimed_by, attempts,
               last_error, next_attempt_at, text, excerpt, link, occurred_at)
  on atlas.signals from service_role;
revoke update (status, parked_reason, claim_token, claim_expires_at, claimed_by, attempts,
               last_error, next_attempt_at)
  on atlas.signals from service_role;
revoke insert on atlas.decisions from service_role;
revoke select (signal_id) on atlas.decisions from service_role;

-- 3. Signals: indexes, then the status/claim columns (their check constraints go with them).
drop index atlas.signals_received_claimable_idx, atlas.signals_claim_expiry_idx;
alter table atlas.signals
  drop column status,
  drop column parked_reason,
  drop column claim_token,
  drop column claim_expires_at,
  drop column claimed_by,
  drop column attempts,
  drop column last_error,
  drop column next_attempt_at;

-- 4. Decision provenance and the one-per-signal uniques.
alter table atlas.decisions drop constraint decisions_signal_id_key;
alter table atlas.item_signals drop constraint item_signals_signal_id_key;
alter table atlas.decisions
  drop column shortlist,
  drop column item_ids,
  drop column prompt_version,
  drop column model_name,
  drop column model_version,
  drop column decided_by,
  drop column answer,
  drop column probabilities,
  drop column runner_up_margin,
  drop column latency_ms,
  drop column outcome,
  drop column primary_error,
  drop column shadow_answer,
  drop column shadow_probabilities,
  drop column shadow_latency_ms,
  drop column shadow_outcome,
  drop column shadow_model_version;

-- 5. enqueued_at back exactly as 20261026011428 left it (column, comment, grants).
-- created_at's column grant is still in place, so this grant is a no-op for it.
alter table atlas.signals add column enqueued_at timestamptz null;

comment on column atlas.signals.enqueued_at is
  'Set by the news scout right after its signal_queue upsert succeeds. NULL = never enqueued; the sweep re-enqueues only NULL rows created in the last 24h.';

grant select (created_at, enqueued_at), update (enqueued_at) on atlas.signals to service_role;

-- 6. atlas.queue_* bodies restored byte-identical from 20261025100100.
create or replace function atlas.queue_claim(p_queue text, p_limit integer default 10, p_lease interval default '5 minutes')
returns table (id bigint, ref_id text, attempts bigint, lease_token uuid, lease_expires_at timestamptz)
language plpgsql set search_path = '' as $$
declare v_ref text;
begin
  v_ref := case p_queue when 'signal_queue' then 'signal_id' when 'decision_queue' then 'decision_id' end;
  if v_ref is null then raise exception 'unknown queue %', p_queue; end if;
  return query execute format($q$
    with expired as (
      select q.id from atlas.%1$I q
       where q.status = 'leased' and q.lease_expires_at < pg_catalog.now()
       order by q.lease_expires_at
       limit $1 for update skip locked
    ), ready as (
      select q.id from atlas.%1$I q
       where q.status = 'ready' and q.available_at <= pg_catalog.now()
       order by q.priority desc, q.available_at, q.id
       limit $1 for update skip locked
    ), picked as (
      select id from expired union all select id from ready limit $1
    )
    update atlas.%1$I q
       set status = 'leased', attempts = q.attempts + 1,
           lease_token = atlas.uuidv7(), lease_expires_at = pg_catalog.now() + $2
      from picked p where q.id = p.id
    returning q.id, q.%2$I::text, q.attempts, q.lease_token, q.lease_expires_at
  $q$, p_queue, v_ref) using p_limit, p_lease;
end $$;

create or replace function atlas.queue_heartbeat(p_queue text, p_id bigint, p_token uuid, p_lease interval default '5 minutes')
returns boolean language plpgsql set search_path = '' as $$
declare v_n integer;
begin
  if p_queue not in ('signal_queue','decision_queue') then raise exception 'unknown queue %', p_queue; end if;
  execute format('update atlas.%I set lease_expires_at = pg_catalog.now() + $3 where id = $1 and lease_token = $2 and status = ''leased''', p_queue)
    using p_id, p_token, p_lease;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

create or replace function atlas.queue_complete(p_queue text, p_id bigint, p_token uuid)
returns boolean language plpgsql set search_path = '' as $$
declare v_n integer;
begin
  if p_queue not in ('signal_queue','decision_queue') then raise exception 'unknown queue %', p_queue; end if;
  execute format('delete from atlas.%I where id = $1 and lease_token = $2', p_queue) using p_id, p_token;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

create or replace function atlas.queue_fail(p_queue text, p_id bigint, p_token uuid, p_error text, p_backoff interval default '30 seconds')
returns text language plpgsql set search_path = '' as $$
declare v_row jsonb; v_ref text;
begin
  v_ref := case p_queue when 'signal_queue' then 'signal_id' when 'decision_queue' then 'decision_id' end;
  if v_ref is null then raise exception 'unknown queue %', p_queue; end if;
  execute format('delete from atlas.%I q where q.id = $1 and q.lease_token = $2 and q.attempts >= q.max_attempts returning pg_catalog.to_jsonb(q)', p_queue)
    into v_row using p_id, p_token;
  if v_row is not null then
    insert into atlas.dead_letter (queue_name, ref_id, attempts, last_error, row_data)
    values (p_queue, v_row ->> v_ref, (v_row ->> 'attempts')::bigint, p_error, v_row);
    return 'dead_letter';
  end if;
  execute format('update atlas.%I set status = ''ready'', lease_token = null, lease_expires_at = null, last_error = $3, available_at = pg_catalog.now() + $4 * attempts where id = $1 and lease_token = $2 returning id', p_queue)
    into v_row using p_id, p_token, p_error, p_backoff;
  return case when v_row is null then 'lost_lease' else 'retry' end;
end $$;

-- 7. atlas.signal_queue recreated exactly as 20261025100100 defined it
-- (table options, indexes, RLS policy, revokes) + the 20261026011119 grants.
create table atlas.signal_queue (
  id               bigint generated always as identity primary key,
  signal_id        text not null unique references atlas.signals (signal_id),
  priority         bigint not null default 0,
  status           text not null default 'ready' check (status in ('ready','leased')),
  attempts         bigint not null default 0,
  max_attempts     bigint not null default 5 check (max_attempts > 0),
  available_at     timestamptz not null default now(),
  lease_token      uuid,
  lease_expires_at timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  constraint signal_queue_lease_shape check ((status = 'leased') = (lease_token is not null and lease_expires_at is not null))
) with (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 50, autovacuum_analyze_scale_factor = 0.02);
create index signal_queue_ready_idx on atlas.signal_queue (priority desc, available_at, id) where status = 'ready';
create index signal_queue_lease_expiry_idx on atlas.signal_queue (lease_expires_at) where status = 'leased';

do $$
declare r text;
begin
  execute 'alter table atlas.signal_queue enable row level security';
  execute 'create policy analyst_read on atlas.signal_queue for select to atlas_analyst using (true)';
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on atlas.signal_queue from %I', r);
    end if;
  end loop;
end $$;

grant select, insert, update, delete on table atlas.signal_queue to service_role;