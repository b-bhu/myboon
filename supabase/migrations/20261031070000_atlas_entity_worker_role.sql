-- #480: dedicated login role for the timed entity manager (direct pg Pool through the session
-- pooler). 20261030230000 granted the job's privileges to service_role, which cannot log in with
-- a password on Supabase, so the entity manager had no usable ENTITY_MANAGER_DATABASE_URL.
-- Same pattern as analyst_worker (20261030120000): ships NOLOGIN NOINHERIT with a 5-connection
-- limit and role-level timeouts; LOGIN and the password are set on prod after CTO approval, never
-- in git. Safe to rerun: the role is created if missing and each policy is dropped before create.
-- Grants are exactly what packages/analyst/src/entity-manager.ts runs:
--   shelves: proposed/active lookups, FOR UPDATE locks, aliases append, retire
--   items:   per-shelf reads (signal_id, title, note, created_at), the alias move of main_shelf_id
--   decisions: latest decision id per signal for the review row
--   entity_reviews: the token-rule read and the review inserts (id default calls uuidv7)
-- Nothing on signals, stories or tool_log. RLS is on for every atlas table, so each grant gets a
-- matching policy scoped to this role. History/touch triggers are SECURITY DEFINER or write only
-- NEW, so no grant on atlas.history is needed.
-- Rollback: supabase/rollbacks/20261031070000_atlas_entity_worker_role.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'entity_worker') then
    create role entity_worker nologin noinherit;
  end if;
end $$;

-- Role-level limits (CTO review): every entity_worker session gets these, no manual prod step.
alter role entity_worker connection limit 5;
alter role entity_worker set statement_timeout = '60s';
alter role entity_worker set lock_timeout = '5s';

grant usage on schema atlas to entity_worker;

grant select (id, slug, name, type, aliases, status) on atlas.shelves to entity_worker;
grant update (status, aliases) on atlas.shelves to entity_worker;

grant select (id, main_shelf_id, signal_id, title, note, created_at) on atlas.items to entity_worker;
grant update (main_shelf_id) on atlas.items to entity_worker;

grant select (id, signal_id) on atlas.decisions to entity_worker;

grant select (id, shelf_id, outcome, reviewed_at) on atlas.entity_reviews to entity_worker;
grant insert (shelf_id, signal_id, decision_id, outcome, alias_target_id, applied, decided_by,
              model_name, reason)
  on atlas.entity_reviews to entity_worker;

grant execute on function atlas.uuidv7() to entity_worker;

drop policy if exists entity_worker_select on atlas.shelves;
create policy entity_worker_select on atlas.shelves for select to entity_worker using (true);
drop policy if exists entity_worker_update on atlas.shelves;
create policy entity_worker_update on atlas.shelves for update to entity_worker using (true) with check (true);
drop policy if exists entity_worker_select on atlas.items;
create policy entity_worker_select on atlas.items for select to entity_worker using (true);
drop policy if exists entity_worker_update on atlas.items;
create policy entity_worker_update on atlas.items for update to entity_worker using (true) with check (true);
drop policy if exists entity_worker_select on atlas.decisions;
create policy entity_worker_select on atlas.decisions for select to entity_worker using (true);
drop policy if exists entity_worker_select on atlas.entity_reviews;
create policy entity_worker_select on atlas.entity_reviews for select to entity_worker using (true);
drop policy if exists entity_worker_insert on atlas.entity_reviews;
create policy entity_worker_insert on atlas.entity_reviews for insert to entity_worker with check (true);

commit;
