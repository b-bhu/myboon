-- squawk-ignore-file require-concurrent-index-creation, prefer-robust-stmts
-- (plain index + checks inside one short transaction, same as recent atlas migrations; new columns are all NULL)
-- #582 (Part of): web reader article body on atlas.signals, plus a dedicated web_reader_worker role.
-- New nullable columns, no backfill: body_status NULL = not fetched yet, eligible for the worker's
--   select ... where body_status is null and link is not null order by fetched_at desc
--   for update skip locked
-- body_status: pending | ok | unavailable | failed (paywalled hosts are marked unavailable).
-- body is capped at 4000 chars. No claim RPC; the partial index below backs the pick.
-- web_reader_worker follows entity_worker (20261031070000): NOLOGIN NOINHERIT, 5 connections,
-- role-level timeouts. LOGIN and the password are set on prod after CTO approval, never in git.
-- Grants: SELECT on the pick/write columns, UPDATE on body columns only. Nothing else in atlas.
-- analyst_worker is unchanged; service_role has table-level SELECT on signals already.
-- Safe to rerun. Rollback: supabase/rollbacks/20261105180000_atlas_web_reader_body.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table atlas.signals add column if not exists body text null;
alter table atlas.signals add column if not exists body_status text null;
alter table atlas.signals add column if not exists body_fetched_at timestamptz null;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'atlas.signals'::regclass and conname = 'signals_body_length_check') then
    alter table atlas.signals add constraint signals_body_length_check
      check (char_length(body) <= 4000);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'atlas.signals'::regclass and conname = 'signals_body_status_check') then
    alter table atlas.signals add constraint signals_body_status_check
      check (body_status in ('pending', 'ok', 'unavailable', 'failed'));
  end if;
end $$;

-- Backs the newest-first pick of unfetched rows that have a link.
create index if not exists signals_body_pick_idx
  on atlas.signals (fetched_at desc, signal_id)
  where body_status is null and link is not null;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'web_reader_worker') then
    create role web_reader_worker nologin noinherit;
  end if;
end $$;

alter role web_reader_worker connection limit 5;
alter role web_reader_worker set statement_timeout = '60s';
alter role web_reader_worker set lock_timeout = '5s';

grant usage on schema atlas to web_reader_worker;

grant select (signal_id, type, source, link, text, excerpt, fetched_at, body, body_status, body_fetched_at)
  on atlas.signals to web_reader_worker;
grant update (body, body_status, body_fetched_at) on atlas.signals to web_reader_worker;

drop policy if exists web_reader_worker_select on atlas.signals;
create policy web_reader_worker_select on atlas.signals for select to web_reader_worker using (true);
drop policy if exists web_reader_worker_update on atlas.signals;
create policy web_reader_worker_update on atlas.signals for update to web_reader_worker using (true) with check (true);

commit;
