-- #701: atlas.event_releases stores every dated release of a recurring US macro event (CPI, PPI,
-- jobs, FOMC, GDP, retail sales) for the Feed calendar's "Last 3 times", plus the calendar_worker
-- role the Backpack ingest job (#702) connects as. Part 1 of the chain #701 -> #702 -> #703 -> #704.
--   atlas.event_releases   one NEW, EMPTY table, one row per release, linked to its atlas.entities
--                          row (on delete cascade: rows can be re-fetched from Backpack).
--                          Upsert key event_releases_entity_date_title_key unique (entity_id,
--                          release_date, source_title): per title, not per day, because Backpack can
--                          send two prints of one series on one day. Its index also serves "this
--                          entity's releases before date D, newest first, limit 3", so no other index.
--                          source_event_id is informational and NOT unique (it hashes the time).
--                          The writer sets updated_at; no trigger, no history trigger.
-- No seed and no change to atlas.entities: the six event entities (us-cpi, us-ppi,
-- us-jobs-report-nfp, fomc-rate-decision, us-gdp, us-retail-sales) already exist on prod as
-- type 'event', status 'active'.
-- calendar_worker follows latest_update_worker (20261114063000): NOLOGIN NOINHERIT, 2 connections,
-- role-level timeouts. LOGIN and the password are set on prod by Bibhu after approval, never in git.
-- Grants: calendar_worker select/insert/update on event_releases (no delete) and column-level
-- select (id, slug, status) on atlas.entities with a calendar_worker_select policy there;
-- service_role and atlas_analyst select only; nothing for anon or authenticated. RLS is on (not
-- forced) for the new table and each grant has a matching policy.
-- Safe to rerun: the table uses IF NOT EXISTS, the role is created only if missing and every policy
-- is dropped before create.
-- Rollback: supabase/rollbacks/20261121100000_atlas_event_releases.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists atlas.event_releases (
  id              uuid primary key default atlas.uuidv7(),
  entity_id       uuid not null references atlas.entities (id) on delete cascade,
  source          text not null default 'backpack',
  source_event_id text not null,
  source_title    text not null,
  country         text not null,
  period          text,
  release_date    date not null,
  starts_at       timestamptz,
  unit            text,
  actual          double precision,
  estimate        double precision,
  previous        double precision,
  fetched_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint event_releases_source_check check (source = 'backpack'),
  constraint event_releases_source_event_id_check
    check (source_event_id ~ '^backpack:economic:[0-9a-f]{24}$'),
  constraint event_releases_source_title_check check (length(source_title) between 1 and 200),
  constraint event_releases_country_check check (country ~ '^[A-Z]{2}$'),
  constraint event_releases_period_check
    check (period is null or period ~ '^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Q[1-4])$'),
  constraint event_releases_starts_at_date_check
    check (starts_at is null or (starts_at at time zone 'UTC')::date = release_date),
  constraint event_releases_entity_date_title_key unique (entity_id, release_date, source_title)
);

alter table atlas.event_releases enable row level security;

-- Nothing for the Supabase API roles beyond what is granted below (the atlas schema is not exposed).
revoke all on atlas.event_releases from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'calendar_worker') then
    create role calendar_worker nologin noinherit;
  end if;
end $$;

alter role calendar_worker connection limit 2;
alter role calendar_worker set statement_timeout = '60s';
alter role calendar_worker set lock_timeout = '5s';

grant usage on schema atlas to calendar_worker;
grant execute on function atlas.uuidv7() to calendar_worker;

-- Input: map a release to its entity by slug (and skip inactive ones).
grant select (id, slug, status) on atlas.entities to calendar_worker;
-- Output: upsert only, no delete.
grant select, insert, update on atlas.event_releases to calendar_worker;

grant select on atlas.event_releases to service_role;
grant select on atlas.event_releases to atlas_analyst;

drop policy if exists calendar_worker_select on atlas.entities;
create policy calendar_worker_select on atlas.entities for select to calendar_worker using (true);

drop policy if exists calendar_worker_select on atlas.event_releases;
create policy calendar_worker_select on atlas.event_releases for select to calendar_worker using (true);
drop policy if exists calendar_worker_insert on atlas.event_releases;
create policy calendar_worker_insert on atlas.event_releases for insert to calendar_worker with check (true);
drop policy if exists calendar_worker_update on atlas.event_releases;
create policy calendar_worker_update on atlas.event_releases for update to calendar_worker using (true) with check (true);

-- service_role bypasses RLS on Supabase; the policy keeps the intent explicit (as entity_aliases does).
drop policy if exists service_role_select on atlas.event_releases;
create policy service_role_select on atlas.event_releases for select to service_role using (true);
drop policy if exists analyst_read on atlas.event_releases;
create policy analyst_read on atlas.event_releases for select to atlas_analyst using (true);

commit;
