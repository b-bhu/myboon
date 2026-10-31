-- Rollback for 20261031090000_atlas_drop_decision_queue_dead_letter.
-- Recreates prod DDL, grants and policies as read on 2026-10-31. DATA IS NOT RESTORED
-- (both tables were empty). Idempotent.
set lock_timeout = '5s';

create table if not exists atlas.decision_queue (
  id bigint generated always as identity primary key,
  decision_id uuid not null unique references atlas.decisions(id),
  priority bigint not null default 0,
  status text not null default 'ready' check (status in ('ready','leased')),
  attempts bigint not null default 0,
  max_attempts bigint not null default 5 check (max_attempts > 0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  constraint decision_queue_lease_shape check ((status = 'leased') = (lease_token is not null and lease_expires_at is not null))
);
create index if not exists decision_queue_ready_idx on atlas.decision_queue (priority desc, available_at, id) where status = 'ready';
create index if not exists decision_queue_lease_expiry_idx on atlas.decision_queue (lease_expires_at) where status = 'leased';

create table if not exists atlas.dead_letter (
  id bigint generated always as identity primary key,
  queue_name text not null check (queue_name in ('signal_queue','decision_queue')),
  ref_id text not null,
  attempts bigint not null,
  last_error text,
  row_data jsonb not null,
  failed_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index if not exists dead_letter_unreviewed_idx on atlas.dead_letter (failed_at) where reviewed_at is null;

alter table atlas.decision_queue enable row level security;
alter table atlas.dead_letter enable row level security;
revoke all on atlas.decision_queue, atlas.dead_letter from public, anon, authenticated, service_role;
grant select on atlas.decision_queue, atlas.dead_letter to atlas_analyst;
grant insert on atlas.dead_letter to service_role;
drop policy if exists analyst_read on atlas.decision_queue;
create policy analyst_read on atlas.decision_queue for select to atlas_analyst using (true);
drop policy if exists analyst_read on atlas.dead_letter;
create policy analyst_read on atlas.dead_letter for select to atlas_analyst using (true);

CREATE OR REPLACE FUNCTION atlas.queue_claim(p_queue text, p_limit integer DEFAULT 10, p_lease interval DEFAULT '00:05:00'::interval)
 RETURNS TABLE(id bigint, ref_id text, attempts bigint, lease_token uuid, lease_expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION atlas.queue_complete(p_queue text, p_id bigint, p_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_n integer;
begin
  if p_queue <> 'decision_queue' then raise exception 'unknown queue %', p_queue; end if;
  delete from atlas.decision_queue where id = p_id and lease_token = p_token;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $function$;

CREATE OR REPLACE FUNCTION atlas.queue_fail(p_queue text, p_id bigint, p_token uuid, p_error text, p_backoff interval DEFAULT '00:00:30'::interval)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION atlas.queue_heartbeat(p_queue text, p_id bigint, p_token uuid, p_lease interval DEFAULT '00:05:00'::interval)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_n integer;
begin
  if p_queue <> 'decision_queue' then raise exception 'unknown queue %', p_queue; end if;
  update atlas.decision_queue
     set lease_expires_at = pg_catalog.now() + p_lease
   where id = p_id and lease_token = p_token and status = 'leased';
  get diagnostics v_n = row_count;
  return v_n = 1;
end $function$;

revoke all on function atlas.queue_claim(text, integer, interval), atlas.queue_heartbeat(text, bigint, uuid, interval),
  atlas.queue_complete(text, bigint, uuid), atlas.queue_fail(text, bigint, uuid, text, interval) from public, anon, authenticated;
grant execute on function atlas.queue_claim(text, integer, interval), atlas.queue_heartbeat(text, bigint, uuid, interval),
  atlas.queue_complete(text, bigint, uuid), atlas.queue_fail(text, bigint, uuid, text, interval) to service_role;
