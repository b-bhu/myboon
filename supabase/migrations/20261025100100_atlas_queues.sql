-- squawk-ignore-file require-concurrent-index-creation, prefer-robust-stmts
-- Why: every index here is on a table created in this same migration (empty, no readers),
-- and CONCURRENTLY cannot run inside the migration transaction. The file runs as one
-- transaction, so a failure rolls back fully; IF NOT EXISTS would only hide drift.
-- #441 V4 Atlas, part 2: work queues (SKIP LOCKED, leases) and dead-letter.
-- Rollback: 20261025100100_atlas_queues.down.sql
set lock_timeout = '5s';
set statement_timeout = '60s';

-- Small, hot tables: vacuum early, leave room for HOT updates.
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

create table atlas.decision_queue (
  id               bigint generated always as identity primary key,
  decision_id      uuid not null unique references atlas.decisions (id),
  priority         bigint not null default 0,
  status           text not null default 'ready' check (status in ('ready','leased')),
  attempts         bigint not null default 0,
  max_attempts     bigint not null default 5 check (max_attempts > 0),
  available_at     timestamptz not null default now(),
  lease_token      uuid,
  lease_expires_at timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  constraint decision_queue_lease_shape check ((status = 'leased') = (lease_token is not null and lease_expires_at is not null))
) with (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 50, autovacuum_analyze_scale_factor = 0.02);
create index decision_queue_ready_idx on atlas.decision_queue (priority desc, available_at, id) where status = 'ready';
create index decision_queue_lease_expiry_idx on atlas.decision_queue (lease_expires_at) where status = 'leased';

create table atlas.dead_letter (
  id          bigint generated always as identity primary key,
  queue_name  text not null check (queue_name in ('signal_queue','decision_queue')),
  ref_id      text not null,
  attempts    bigint not null,
  last_error  text,
  row_data    jsonb not null,
  failed_at   timestamptz not null default now(),
  reviewed_at timestamptz
);
create index dead_letter_unreviewed_idx on atlas.dead_letter (failed_at) where reviewed_at is null;

-- Claim up to p_limit rows: ready ones, plus leases that expired. Returns the new lease token.
create function atlas.queue_claim(p_queue text, p_limit integer default 10, p_lease interval default '5 minutes')
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

-- Extend a lease (heartbeat). False if the token no longer owns the row.
create function atlas.queue_heartbeat(p_queue text, p_id bigint, p_token uuid, p_lease interval default '5 minutes')
returns boolean language plpgsql set search_path = '' as $$
declare v_n integer;
begin
  if p_queue not in ('signal_queue','decision_queue') then raise exception 'unknown queue %', p_queue; end if;
  execute format('update atlas.%I set lease_expires_at = pg_catalog.now() + $3 where id = $1 and lease_token = $2 and status = ''leased''', p_queue)
    using p_id, p_token, p_lease;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- Done: remove the row. False if the token no longer owns it.
create function atlas.queue_complete(p_queue text, p_id bigint, p_token uuid)
returns boolean language plpgsql set search_path = '' as $$
declare v_n integer;
begin
  if p_queue not in ('signal_queue','decision_queue') then raise exception 'unknown queue %', p_queue; end if;
  execute format('delete from atlas.%I where id = $1 and lease_token = $2', p_queue) using p_id, p_token;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- Failed: retry with backoff, or move to dead_letter once attempts >= max_attempts.
-- Returns 'retry', 'dead_letter' or 'lost_lease'.
create function atlas.queue_fail(p_queue text, p_id bigint, p_token uuid, p_error text, p_backoff interval default '30 seconds')
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

revoke all on function atlas.queue_claim(text, integer, interval) from public;
revoke all on function atlas.queue_heartbeat(text, bigint, uuid, interval) from public;
revoke all on function atlas.queue_complete(text, bigint, uuid) from public;
revoke all on function atlas.queue_fail(text, bigint, uuid, text, interval) from public;

do $$
declare t text; r text;
begin
  foreach t in array array['signal_queue','decision_queue','dead_letter'] loop
    execute format('alter table atlas.%I enable row level security', t);
    execute format('create policy analyst_read on atlas.%I for select to atlas_analyst using (true)', t);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
        execute format('revoke all on atlas.%I from %I', t, r);
      end if;
    end loop;
  end loop;
end $$;
