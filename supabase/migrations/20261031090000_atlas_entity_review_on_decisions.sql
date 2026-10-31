-- squawk-ignore-file ban-drop-table, ban-drop-function, prefer-robust-stmts, require-concurrent-index-creation
-- #480 / #537: the entity manager records its verdict on atlas.decisions instead of a separate
-- audit table. entity_worker gets NO insert on decisions (CTO), only column select/update.
--   1. Add nullable entity_* columns to atlas.decisions (FK added NOT VALID, then validated).
--   2. entity_worker on decisions: select (id, signal_id, entity_outcome, entity_reviewed_at),
--      update of the five entity_* columns, one RLS update policy. shelves: new nullable entity_reviewed_at,
--      entity_worker gets select + update on that one column (existing shelves RLS policies cover it).
--   3. Drop entity_worker's grants/policies on atlas.entity_reviews, then the table (0 rows on
--      prod, 2026-10-31).
--   4. Drop atlas.decision_queue, atlas.dead_letter (0 rows each) and the 4 queue_* functions.
-- History: decisions_history (AFTER INSERT/UPDATE/DELETE, atlas.write_history uses to_jsonb(new))
-- records the new columns on UPDATE with no change.
-- Steps: columns + FK NOT VALID, VALIDATE, two plain indexes (decisions is ~2k rows, the SHARE lock
-- is brief; lock_timeout 5s / statement_timeout 60s), then grants/policy/drops. Every step is rerunnable.
-- Deploy order (Backend Dev + CTO): deploy #539 with the entity manager STOPPED, apply this
-- migration, then start the entity manager. Do not apply before #539 is merged and deployed.
-- Rollback: supabase/rollbacks/20261031090000_atlas_entity_review_on_decisions.down.sql

-- 1. columns (catalog-only: nullable, no defaults) + FK NOT VALID
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table atlas.decisions
  add column if not exists entity_outcome text
    constraint decisions_entity_outcome_check check (entity_outcome in ('alias', 'reject', 'new')),
  add column if not exists entity_alias_target_id uuid,
  add column if not exists entity_reviewed_at timestamptz,
  add column if not exists entity_model_name text,
  add column if not exists entity_reason text;
-- per-shelf review stamp (CTO): the entity manager picks proposed shelves not yet reviewed
alter table atlas.shelves add column if not exists entity_reviewed_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'atlas.decisions'::regclass
                    and conname = 'decisions_entity_alias_target_id_fkey') then
    alter table atlas.decisions
      add constraint decisions_entity_alias_target_id_fkey
      foreign key (entity_alias_target_id) references atlas.shelves (id) not valid;
  end if;
end $$;
commit;

-- validate separately (SHARE UPDATE EXCLUSIVE; no-op if already valid)
set lock_timeout = '5s';
set statement_timeout = '60s';
alter table atlas.decisions validate constraint decisions_entity_alias_target_id_fkey;

-- index for the FK (shelf deletes / alias lookups); plain create index, table is ~2k rows
create index if not exists decisions_entity_alias_target_id_idx
  on atlas.decisions (entity_alias_target_id) where entity_alias_target_id is not null;
-- Partial index for the "not yet reviewed" lookup. Local EXPLAIN ANALYZE, 2,000 rows (prod has
-- ~2,000), oldest 90% reviewed: 0.44 ms (seq scan + sort) without it, 0.034 ms with it.
create index if not exists decisions_entity_unreviewed_idx
  on atlas.decisions (id) where entity_reviewed_at is null;

-- 2-4. grants, policy, drops
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

revoke select (id, signal_id) on atlas.decisions from entity_worker;
grant select (id, signal_id, entity_outcome, entity_reviewed_at) on atlas.decisions to entity_worker;
grant update (entity_outcome, entity_alias_target_id, entity_reviewed_at, entity_model_name, entity_reason)
  on atlas.decisions to entity_worker;
-- decisions_targets_valid calls this with the caller's rights on UPDATE (Backend Dev, #539)
grant execute on function atlas.analyst_targets_valid(jsonb) to entity_worker;
-- shelves: the existing entity_worker_select / entity_worker_update policies (20261031070000) cover it
grant select (entity_reviewed_at), update (entity_reviewed_at) on atlas.shelves to entity_worker;
drop policy if exists entity_worker_update on atlas.decisions;
create policy entity_worker_update on atlas.decisions for update to entity_worker
  using (true) with check (true);

do $$
begin
  if to_regclass('atlas.entity_reviews') is not null then
    drop policy if exists entity_worker_select on atlas.entity_reviews;
    drop policy if exists entity_worker_insert on atlas.entity_reviews;
    revoke all on atlas.entity_reviews from entity_worker;
    revoke select (id, shelf_id, outcome, reviewed_at) on atlas.entity_reviews from entity_worker;
    revoke insert (shelf_id, signal_id, decision_id, outcome, alias_target_id, applied, decided_by,
                   model_name, reason) on atlas.entity_reviews from entity_worker;
  end if;
end $$;
drop table if exists atlas.entity_reviews restrict;

drop function if exists atlas.queue_claim(text, integer, interval);
drop function if exists atlas.queue_heartbeat(text, bigint, uuid, interval);
drop function if exists atlas.queue_complete(text, bigint, uuid);
drop function if exists atlas.queue_fail(text, bigint, uuid, text, interval);
drop table if exists atlas.decision_queue restrict;
drop table if exists atlas.dead_letter restrict;

commit;
