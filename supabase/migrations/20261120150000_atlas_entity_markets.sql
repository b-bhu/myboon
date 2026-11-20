-- squawk-ignore-file require-concurrent-index-creation, prefer-robust-stmts, prefer-bigint-over-smallint
-- (the index is built on a table created in this same short transaction, so it is empty;
-- the entities column is added with IF NOT EXISTS and the policies are dropped before create;
-- rank is 1 to 3 by check, so smallint as #683 specifies)
-- #683: atlas.entity_markets links each entity to 0 to 3 Hyperliquid markets, plus
-- atlas.entities.markets_checked_at. Part 1 of the entity-linked markets chain; #690 (entity
-- manager picks markets) and #691 (price cache + API) build on it once merged and applied.
--   atlas.entity_markets      one NEW, EMPTY table, one row per link. rank 1..3 (1 = lead) with
--                             unique (entity_id, rank), so at most 3 links per entity; unique
--                             (entity_id, symbol). symbol is the Hyperliquid name as the API returns
--                             it (BTC, kPEPE, xyz:CL), format-checked only; the live-list check is
--                             app-side (#690). pinned rows are never overwritten by the model (#690).
--                             Links cascade away with their entity. No history trigger.
--   atlas.entities            + markets_checked_at timestamptz, nullable, no default (metadata-only,
--                             no table rewrite). null = never checked; set with zero links = checked,
--                             the entity moves no market. No backfill here (guided step in #690).
-- Updating markets_checked_at fires the existing entities_touch and entities_history triggers
-- (bumps updated_at, writes a history row): accepted in #683.
-- Grants: entity_worker select/insert/update/delete on entity_markets and column-level
-- select/update (markets_checked_at) on entities (its existing entity_worker_select/_update
-- policies on entities cover the rows); service_role and atlas_analyst select only; nothing for
-- anon or authenticated. RLS is on (not forced) and each grant has a matching policy.
-- Safe to rerun: IF NOT EXISTS on table, index and column; policies are dropped before create.
-- Rollback: supabase/rollbacks/20261120150000_atlas_entity_markets.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists atlas.entity_markets (
  id        uuid primary key default atlas.uuidv7(),
  entity_id uuid not null references atlas.entities (id) on delete cascade,
  rank      smallint not null,
  symbol    text not null,
  set_by    text not null,
  pinned    boolean not null default false,
  reason    text,
  set_at    timestamptz not null default now(),
  constraint entity_markets_rank_check check (rank between 1 and 3),
  constraint entity_markets_symbol_check check (symbol ~ '^(xyz:)?[A-Za-z0-9]{1,24}$'),
  constraint entity_markets_set_by_check check (set_by in ('model', 'manual')),
  constraint entity_markets_reason_check
    check (reason is null or (length(reason) between 1 and 200 and position(E'\n' in reason) = 0)),
  constraint entity_markets_entity_rank_key unique (entity_id, rank),
  constraint entity_markets_entity_symbol_key unique (entity_id, symbol)
);
-- "Which entities use oil": lookups by symbol. entity_id lookups use the two unique keys.
create index if not exists entity_markets_symbol_idx on atlas.entity_markets (symbol);

alter table atlas.entities add column if not exists markets_checked_at timestamptz;

alter table atlas.entity_markets enable row level security;

-- Nothing for the Supabase API roles beyond what is granted below (the atlas schema is not exposed).
revoke all on atlas.entity_markets from public, anon, authenticated, service_role;

grant select, insert, update, delete on atlas.entity_markets to entity_worker;
grant select (markets_checked_at), update (markets_checked_at) on atlas.entities to entity_worker;
grant select on atlas.entity_markets to service_role;
grant select on atlas.entity_markets to atlas_analyst;

drop policy if exists entity_worker_select on atlas.entity_markets;
create policy entity_worker_select on atlas.entity_markets for select to entity_worker using (true);
drop policy if exists entity_worker_insert on atlas.entity_markets;
create policy entity_worker_insert on atlas.entity_markets for insert to entity_worker with check (true);
drop policy if exists entity_worker_update on atlas.entity_markets;
create policy entity_worker_update on atlas.entity_markets for update to entity_worker using (true) with check (true);
drop policy if exists entity_worker_delete on atlas.entity_markets;
create policy entity_worker_delete on atlas.entity_markets for delete to entity_worker using (true);

-- service_role bypasses RLS on Supabase; the policy keeps the intent explicit (as entity_aliases does).
drop policy if exists service_role_select on atlas.entity_markets;
create policy service_role_select on atlas.entity_markets for select to service_role using (true);
drop policy if exists analyst_read on atlas.entity_markets;
create policy analyst_read on atlas.entity_markets for select to atlas_analyst using (true);

commit;
