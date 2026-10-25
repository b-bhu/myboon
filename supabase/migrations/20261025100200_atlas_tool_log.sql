-- squawk-ignore-file require-concurrent-index-creation, prefer-robust-stmts
-- Why: every index here is on a table created in this same migration (empty, no readers),
-- and CONCURRENTLY cannot run inside the migration transaction. The file runs as one
-- transaction, so a failure rolls back fully; IF NOT EXISTS would only hide drift.
-- #441 V4 Atlas, part 3: tool log partitioned by day (UTC), kept 30 days, maintained by pg_cron.
-- Rollback: 20261025100200_atlas_tool_log.down.sql
set lock_timeout = '5s';
set statement_timeout = '60s';

create extension if not exists pg_cron with schema pg_catalog;

create table atlas.tool_log (
  id          bigint generated always as identity,
  logged_at   timestamptz not null default now(),
  run_id      text,
  tool        text not null,
  input       jsonb,
  output      jsonb,
  duration_ms bigint,
  error       text,
  primary key (logged_at, id)
) partition by range (logged_at);
alter table atlas.tool_log enable row level security;
create policy analyst_read on atlas.tool_log for select to atlas_analyst using (true);

-- Creates today's partition plus p_ahead days, drops partitions older than p_keep_days.
create function atlas.tool_log_maintain(p_ahead integer default 3, p_keep_days integer default 30)
returns void language plpgsql set search_path = '' as $$
declare
  v_day date;
  v_name text;
  r record;
begin
  for i in 0..p_ahead loop
    v_day := (pg_catalog.now() at time zone 'UTC')::date + i;
    v_name := 'tool_log_p' || pg_catalog.to_char(v_day, 'YYYYMMDD');
    if pg_catalog.to_regclass('atlas.' || v_name) is null then
      execute format('create table atlas.%I partition of atlas.tool_log for values from (%L) to (%L)',
        v_name, (v_day::text || ' 00:00:00+00'), ((v_day + 1)::text || ' 00:00:00+00'));
      execute format('alter table atlas.%I enable row level security', v_name);
      execute format('create policy analyst_read on atlas.%I for select to atlas_analyst using (true)', v_name);
    end if;
  end loop;
  for r in
    select c.relname from pg_catalog.pg_inherits i
    join pg_catalog.pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'atlas.tool_log'::regclass
      and c.relname ~ '^tool_log_p[0-9]{8}$'
      and pg_catalog.to_date(pg_catalog.substr(c.relname, 11), 'YYYYMMDD') < (pg_catalog.now() at time zone 'UTC')::date - p_keep_days
  loop
    execute format('drop table atlas.%I', r.relname);
  end loop;
end $$;
revoke all on function atlas.tool_log_maintain(integer, integer) from public;

select atlas.tool_log_maintain();

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on atlas.tool_log from %I', r);
    end if;
  end loop;
end $$;

-- 00:05 UTC daily. cron.schedule with a job name is idempotent (pg_cron >= 1.4).
select cron.schedule('atlas-tool-log-maintain', '5 0 * * *', 'select atlas.tool_log_maintain()');
