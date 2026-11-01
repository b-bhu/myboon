-- squawk-ignore-file require-concurrent-index-creation, adding-foreign-key-constraint, prefer-robust-stmts
-- #480: the timed entity manager's audit table. Every review of a proposed shelf writes ONE ROW
-- PER SIGNAL (each distinct atlas.items.signal_id on that shelf), mirroring the Jev decision for
-- that signal where one exists (decision_id nullable when the signal has no decision row). The
-- shelf-level verdict (alias/reject/new) is the same on every row of the review; label ('right' /
-- 'wrong') is reserved for a later human right/wrong check.
-- Why each ignored rule is safe here: atlas.entity_reviews is created in this same migration
-- (0 rows, no readers), so the two plain (non-CONCURRENTLY) indexes and the FK constraints lock
-- it invisibly, and CONCURRENTLY cannot run inside this one-transaction migration file (same as
-- #503/#505). No IF [NOT] EXISTS: the file is one transaction, a failure rolls back fully.
-- Grants: service_role ONLY (the role the PM2 entry runs as): select + insert on entity_reviews,
-- update (label) reserved for the human check, update (status, aliases) on atlas.shelves and
-- update (main_shelf_id) on atlas.items for the one alias transaction, and select (id) on
-- atlas.decisions to link the review to the Jev decision (signal_id was already granted in
-- 20261027120000; items/shelves SELECT are table-level from 20261025114823). Nothing is granted
-- to analyst_worker: its pg-test refuses shelf updates and must keep passing. atlas.analyst
-- (Bucket's read-only role, core migration) keeps its schema-wide default SELECT, like every
-- other atlas table. RLS is enabled; service_role bypasses it (bypassrls, as on Supabase).
-- Item titles/notes/signals read for the prompt run over already-granted columns.
-- Rollback: supabase/rollbacks/20261030230000_atlas_entity_reviews.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table atlas.entity_reviews (
  id              uuid primary key default atlas.uuidv7(),
  shelf_id        uuid not null references atlas.shelves (id),
  signal_id       text not null references atlas.signals (signal_id),
  decision_id     uuid null references atlas.decisions (id),
  outcome         text not null,
  alias_target_id uuid null references atlas.shelves (id),
  applied         boolean not null,
  label           text null,
  decided_by      text not null,
  model_name      text null,
  reason          text null,
  reviewed_at     timestamptz not null default now(),
  constraint entity_reviews_outcome_check check (outcome in ('alias', 'reject', 'new')),
  constraint entity_reviews_alias_target_check check ((outcome = 'alias') = (alias_target_id is not null)),
  constraint entity_reviews_label_check check (label in ('right', 'wrong'))
);

create index entity_reviews_shelf_reviewed_idx
  on atlas.entity_reviews (shelf_id, reviewed_at desc);
create index entity_reviews_decision_id_idx
  on atlas.entity_reviews (decision_id) where decision_id is not null;

alter table atlas.entity_reviews enable row level security;

grant select, insert on atlas.entity_reviews to service_role;
grant update (label) on atlas.entity_reviews to service_role;

grant update (status, aliases) on atlas.shelves to service_role;
grant update (main_shelf_id) on atlas.items to service_role;
grant select (id) on atlas.decisions to service_role;

commit;