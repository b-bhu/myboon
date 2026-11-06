-- #571 entity manager writer grants. NOT APPLIED: needs DB Guy review + CTO approval before prod.
-- The new packages/entity-manager (connects as entity_worker) reads entity summary and item
-- summary/occurred_at/status for the LLM context, and inserts story items. 20261105150000 granted
-- the queue, item_signals and entity_context, but not these. Grants + one policy only; rerunnable.
-- Rollback: supabase/rollbacks/20261106120000_atlas_em_writer_grants.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
grant select (summary) on atlas.entities to entity_worker;
grant select (summary, occurred_at, status, item_key) on atlas.entity_items to entity_worker;
grant insert (item_key, title, summary, main_entity_id, occurred_at, signal_id, angle, note, image_url)
  on atlas.entity_items to entity_worker;
drop policy if exists entity_worker_insert on atlas.entity_items;
create policy entity_worker_insert on atlas.entity_items for insert to entity_worker with check (true);
commit;
