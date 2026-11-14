-- squawk-ignore-file require-concurrent-index-creation, prefer-robust-stmts, prefer-bigint-over-int
-- (indexes are built on tables created in this same short transaction, so they are empty;
-- attempt is a retry counter of 0 to 2, so int as in the #623 schema)
-- #630 (Part of #623): latest updates tables and the latest_update_worker role.
-- Three NEW, EMPTY tables (no backfill, no lock on existing data):
--   atlas.latest_update_runs   append-only record of every editor decision (published/hold/skip/error).
--                              A partial unique index on (entity_id, newest_entity_item_id) where
--                              decision <> 'error' makes a non-error decision final per newest item;
--                              error rows may repeat so the job can retry.
--   atlas.latest_updates       the published text. visibility defaults to 'dark' and is set at insert
--                              (the worker is insert-only; going live is an env setting, not an UPDATE).
--                              unique (entity_id, newest_entity_item_id): a retry cannot publish twice.
--   atlas.latest_update_items  source items per update: pk (latest_update_id, entity_item_id),
--                              cascade with the update, restrict on the item.
-- Foreign keys to entities / entity_items are ON DELETE RESTRICT, so an entity or item that a latest
-- update or run points at cannot be deleted. There is no entity_item_links table on prod (checked).
-- latest_update_worker follows entity_worker (20261031070000): NOLOGIN NOINHERIT, 5 connections,
-- role-level timeouts. LOGIN and the password are set on prod after CTO approval, never in git.
-- Grants: SELECT on the four tables the job reads (entities, entity_items, item_signals, signals);
-- INSERT + SELECT on the three new tables; no UPDATE, no DELETE, nothing else. RLS is on (not forced)
-- for every new table and each grant has a matching policy named <role>_<cmd>. atlas_analyst gets
-- analyst_read; service_role gets SELECT on latest_updates and latest_update_items for the API.
-- Safe to rerun: tables and indexes use IF NOT EXISTS, policies are dropped before create.
-- Rollback: supabase/rollbacks/20261114063000_atlas_latest_updates.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists atlas.latest_update_runs (
  id                    uuid primary key default atlas.uuidv7(),
  entity_id             uuid not null references atlas.entities (id) on delete restrict,
  newest_entity_item_id uuid not null references atlas.entity_items (id) on delete restrict,
  decision              text not null,
  reason                text,
  check_failures        jsonb not null default '[]'::jsonb,
  attempt               integer not null,
  created_at            timestamptz not null default now(),
  constraint latest_update_runs_decision_check
    check (decision in ('published', 'hold', 'skip', 'error'))
);
create index if not exists latest_update_runs_entity_created_idx
  on atlas.latest_update_runs (entity_id, created_at desc);
create unique index if not exists latest_update_runs_final_decision_uidx
  on atlas.latest_update_runs (entity_id, newest_entity_item_id)
  where decision <> 'error';

create table if not exists atlas.latest_updates (
  id                    uuid primary key default atlas.uuidv7(),
  entity_id             uuid not null references atlas.entities (id) on delete restrict,
  headline              text not null,
  what_happened         text not null,
  how_we_got_here       text not null,
  what_to_watch         text not null,
  claims                jsonb not null default '[]'::jsonb,
  newest_entity_item_id uuid not null references atlas.entity_items (id) on delete restrict,
  editor_version        text not null,
  model                 text not null,
  run_id                uuid not null references atlas.latest_update_runs (id),
  visibility            text not null default 'dark',
  published_at          timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  constraint latest_updates_claims_array_check check (jsonb_typeof(claims) = 'array'),
  constraint latest_updates_visibility_check check (visibility in ('dark', 'live')),
  constraint latest_updates_entity_newest_key unique (entity_id, newest_entity_item_id)
);
create index if not exists latest_updates_entity_published_idx
  on atlas.latest_updates (entity_id, published_at desc);

create table if not exists atlas.latest_update_items (
  latest_update_id uuid not null references atlas.latest_updates (id) on delete cascade,
  entity_item_id   uuid not null references atlas.entity_items (id) on delete restrict,
  primary key (latest_update_id, entity_item_id)
);
create index if not exists latest_update_items_entity_item_idx
  on atlas.latest_update_items (entity_item_id);

alter table atlas.latest_update_runs enable row level security;
alter table atlas.latest_updates enable row level security;
alter table atlas.latest_update_items enable row level security;

-- Nothing for the Supabase API roles beyond what is granted below (the atlas schema is not exposed).
revoke all on atlas.latest_update_runs, atlas.latest_updates, atlas.latest_update_items
  from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'latest_update_worker') then
    create role latest_update_worker nologin noinherit;
  end if;
end $$;

alter role latest_update_worker connection limit 5;
alter role latest_update_worker set statement_timeout = '60s';
alter role latest_update_worker set lock_timeout = '5s';

grant usage on schema atlas to latest_update_worker;
grant execute on function atlas.uuidv7() to latest_update_worker;

-- Inputs the editor job reads (SNAPSHOT_SQL in the #612 proof of concept).
grant select on atlas.entities, atlas.entity_items, atlas.item_signals, atlas.signals
  to latest_update_worker;
-- Outputs: insert-only.
grant insert, select on atlas.latest_update_runs, atlas.latest_updates, atlas.latest_update_items
  to latest_update_worker;

grant select on atlas.latest_update_runs, atlas.latest_updates, atlas.latest_update_items
  to atlas_analyst;
grant select on atlas.latest_updates, atlas.latest_update_items to service_role;

drop policy if exists latest_update_worker_select on atlas.entities;
create policy latest_update_worker_select on atlas.entities for select to latest_update_worker using (true);
drop policy if exists latest_update_worker_select on atlas.entity_items;
create policy latest_update_worker_select on atlas.entity_items for select to latest_update_worker using (true);
drop policy if exists latest_update_worker_select on atlas.item_signals;
create policy latest_update_worker_select on atlas.item_signals for select to latest_update_worker using (true);
drop policy if exists latest_update_worker_select on atlas.signals;
create policy latest_update_worker_select on atlas.signals for select to latest_update_worker using (true);

drop policy if exists latest_update_worker_select on atlas.latest_update_runs;
create policy latest_update_worker_select on atlas.latest_update_runs for select to latest_update_worker using (true);
drop policy if exists latest_update_worker_insert on atlas.latest_update_runs;
create policy latest_update_worker_insert on atlas.latest_update_runs for insert to latest_update_worker with check (true);
drop policy if exists latest_update_worker_select on atlas.latest_updates;
create policy latest_update_worker_select on atlas.latest_updates for select to latest_update_worker using (true);
drop policy if exists latest_update_worker_insert on atlas.latest_updates;
create policy latest_update_worker_insert on atlas.latest_updates for insert to latest_update_worker with check (true);
drop policy if exists latest_update_worker_select on atlas.latest_update_items;
create policy latest_update_worker_select on atlas.latest_update_items for select to latest_update_worker using (true);
drop policy if exists latest_update_worker_insert on atlas.latest_update_items;
create policy latest_update_worker_insert on atlas.latest_update_items for insert to latest_update_worker with check (true);

drop policy if exists analyst_read on atlas.latest_update_runs;
create policy analyst_read on atlas.latest_update_runs for select to atlas_analyst using (true);
drop policy if exists analyst_read on atlas.latest_updates;
create policy analyst_read on atlas.latest_updates for select to atlas_analyst using (true);
drop policy if exists analyst_read on atlas.latest_update_items;
create policy analyst_read on atlas.latest_update_items for select to atlas_analyst using (true);

-- service_role bypasses RLS on Supabase; the policies keep the intent explicit (as entity_aliases does).
drop policy if exists service_role_select on atlas.latest_updates;
create policy service_role_select on atlas.latest_updates for select to service_role using (true);
drop policy if exists service_role_select on atlas.latest_update_items;
create policy service_role_select on atlas.latest_update_items for select to service_role using (true);

commit;
