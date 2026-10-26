-- squawk-ignore-file require-concurrent-index-creation, prefer-robust-stmts
-- Why: this is a single new table with no readers, the file runs as one
-- transaction so a failure rolls back fully, and IF NOT EXISTS would only hide
-- drift (same reasoning as 20261025100000_atlas_core.sql).
-- #479 (D26): atlas.routing_rules -- the Story linker's shelf routing table.
-- One row says: when the code shortlist contains BOTH the token shelf and the
-- project shelf of a pair (the classic '$UNI' token vs Uniswap protocol case),
-- keep only route_to_shelf_id and drop the other. Applied after alias ranking
-- and before Jev runs (D23): route_to is always one of the two.
-- Same shape family as the other atlas tables: identity pk, uuid FKs into
-- atlas.shelves, created_at, a free-form note, RLS with the shared
-- analyst_read policy for atlas_analyst, and nothing for the Supabase API
-- roles (the revoke loop, belt and braces as in #441/#485).
-- service_role: the Story analyst connects as service_role (one shared team
-- login, per CTO, #485 review). New grants only what is missing: select on
-- this table, insert on atlas.decisions plus select on only its conflict-target columns
-- (signal_id, analyst_version), and select (text, excerpt, occurred_at) on atlas.signals for the
-- analyst signal read (#486 DB Guy review) -- #449 (20261025114823)
-- already granted USAGE on schema atlas plus select on atlas.shelves and
-- atlas.items, and #474 (20261026011119) the scout's queue surface. Nothing
-- is needed on atlas.uuidv7(): #441's default function privileges left it
-- PUBLIC-executable (verified: service_role ran it and hit only the missing
-- table privilege before this migration).
-- Rollback: 20261026230000_atlas_routing_rules.down.sql
set lock_timeout = '5s';
set statement_timeout = '60s';

create table atlas.routing_rules (
  id                bigint generated always as identity primary key,
  token_shelf_id    uuid not null references atlas.shelves (id),
  project_shelf_id  uuid not null references atlas.shelves (id),
  route_to_shelf_id uuid not null references atlas.shelves (id),
  created_at        timestamptz not null default now(),
  note              text,
  constraint routing_rules_route_to_pair check (route_to_shelf_id in (token_shelf_id, project_shelf_id)),
  constraint routing_rules_distinct_pair check (token_shelf_id <> project_shelf_id),
  constraint routing_rules_token_project_key unique (token_shelf_id, project_shelf_id)
);

alter table atlas.routing_rules enable row level security;
create policy analyst_read on atlas.routing_rules for select to atlas_analyst using (true);

-- The API roles get nothing in atlas (the schema is not exposed; as in #441).
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on atlas.routing_rules from %I', r);
    end if;
  end loop;
end $$;

-- #486 (CTO): the Story decision's probabilities as real columns, not packed into
-- reason. atlas.decisions is empty in prod; nullable, so no rewrite and no default.
-- Checks go in NOT VALID then VALIDATE to keep the lock short.
alter table atlas.decisions
  add column entity_p      numeric,
  add column entity_margin numeric,
  add column item_p        numeric,
  add column item_margin   numeric;
alter table atlas.decisions add constraint decisions_entity_p_range      check (entity_p between 0 and 1) not valid;
alter table atlas.decisions add constraint decisions_entity_margin_range check (entity_margin between 0 and 1) not valid;
alter table atlas.decisions add constraint decisions_item_p_range        check (item_p between 0 and 1) not valid;
alter table atlas.decisions add constraint decisions_item_margin_range   check (item_margin between 0 and 1) not valid;
alter table atlas.decisions validate constraint decisions_entity_p_range;
alter table atlas.decisions validate constraint decisions_entity_margin_range;
alter table atlas.decisions validate constraint decisions_item_p_range;
alter table atlas.decisions validate constraint decisions_item_margin_range;

grant select on table atlas.routing_rules to service_role;
grant insert on table atlas.decisions to service_role;
-- ON CONFLICT (signal_id, analyst_version) needs SELECT on the conflict-target columns.
grant select (signal_id, analyst_version) on table atlas.decisions to service_role;
grant select (text, excerpt, occurred_at) on table atlas.signals to service_role;