-- #480: dedicated login role for the timed entity manager (direct pg Pool through the session
-- pooler). 20261030230000 granted the job's privileges to service_role, which cannot log in with
-- a password on Supabase, so the entity manager had no usable ENTITY_MANAGER_DATABASE_URL.
-- Same pattern as analyst_worker (20261030120000): ships NOLOGIN NOINHERIT; LOGIN, the password
-- and a connection limit are set separately on prod after CTO approval, never in git.
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

create policy entity_worker_select on atlas.shelves for select to entity_worker using (true);
create policy entity_worker_update on atlas.shelves for update to entity_worker using (true) with check (true);
create policy entity_worker_select on atlas.items for select to entity_worker using (true);
create policy entity_worker_update on atlas.items for update to entity_worker using (true) with check (true);
create policy entity_worker_select on atlas.decisions for select to entity_worker using (true);
create policy entity_worker_select on atlas.entity_reviews for select to entity_worker using (true);
create policy entity_worker_insert on atlas.entity_reviews for insert to entity_worker with check (true);

commit;
