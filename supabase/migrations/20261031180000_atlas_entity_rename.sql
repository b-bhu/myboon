-- squawk-ignore-file ban-drop-table, prefer-robust-stmts, renaming-table, renaming-column
-- #541: drop the unused links table, then rename the entity tables and everything named after them.
--   atlas.item_shelves -> DROPPED (1,205 rows on prod 2026-10-31; no live code reads or writes it).
--                         Copied first to atlas.item_shelves_bak_541 (no grants); the rollback restores it.
--   atlas.shelves      -> atlas.entities
--   atlas.items        -> atlas.entity_items
--   columns: entity_items.main_shelf_id -> main_entity_id, stories.shelf_id -> entity_id.
--            item_id / item_key / decisions.shelves are kept (see PR).
-- Renames are catalog-only (no rewrite, no data copy). Grants, column grants, RLS policies, FKs
-- and triggers are bound to the table OID, so atlas_analyst / analyst_worker / entity_worker /
-- service_role keep exactly the same privileges.
-- atlas.history.table_name: old rows keep 'shelves'/'items'/'item_shelves'; new rows log the new
-- names (tg_table_name). History rows are not rewritten. public.ai_explanations is out of scope.
-- Deploy order: stop analyst + entity manager, apply, deploy code, restart both.
-- Every step is rerunnable. Rollback: supabase/rollbacks/20261031180000_atlas_entity_rename.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- links table: back up, then drop (its FKs, indexes, policy, grant and history trigger go with it)
do $d$ begin
  if to_regclass('atlas.item_shelves') is not null and to_regclass('atlas.item_shelves_bak_541') is null then
    create table atlas.item_shelves_bak_541 as table atlas.item_shelves;
  end if;
end $d$;
revoke all on atlas.item_shelves_bak_541 from public, anon, authenticated, service_role, atlas_analyst;
alter table atlas.item_shelves_bak_541 enable row level security;
drop table if exists atlas.item_shelves;

create or replace function pg_temp.ren(p_kind text, p_sql_old text, p_sql_new text, p_stmt text) returns void language plpgsql as $f$
begin
  -- run p_stmt only when the old object exists and the new one does not (rerunnable)
  if pg_temp.has(p_kind, p_sql_old) and not pg_temp.has(p_kind, p_sql_new) then execute p_stmt; end if;
end $f$;
create or replace function pg_temp.has(p_kind text, p_ref text) returns boolean language plpgsql as $f$
declare t text := split_part(p_ref, '.', 1); n text := split_part(p_ref, '.', 2);
begin
  return case p_kind
    when 'rel' then exists (select 1 from pg_class where relnamespace = 'atlas'::regnamespace and relname = n)
    when 'col' then exists (select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid
                            where c.relnamespace = 'atlas'::regnamespace and c.relname = t and a.attname = n and not a.attisdropped)
    when 'con' then exists (select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid
                            where c.relnamespace = 'atlas'::regnamespace and c.relname = t and k.conname = n)
    when 'trg' then exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid
                            where c.relnamespace = 'atlas'::regnamespace and c.relname = t and g.tgname = n)
  end;
end $f$;
-- tables (grants, column grants, RLS policies, triggers and FKs follow the table OID)
select pg_temp.ren('rel', '.shelves', '.entities', 'alter table atlas.shelves rename to entities');
select pg_temp.ren('rel', '.items', '.entity_items', 'alter table atlas.items rename to entity_items');
-- columns
select pg_temp.ren('col', 'entity_items.main_shelf_id', 'entity_items.main_entity_id', 'alter table atlas.entity_items rename column main_shelf_id to main_entity_id');
select pg_temp.ren('col', 'stories.shelf_id', 'stories.entity_id', 'alter table atlas.stories rename column shelf_id to entity_id');
-- indexes (pkey / unique constraints are renamed with their index)
select pg_temp.ren('rel', '.shelves_pkey', '.entities_pkey', 'alter index atlas.shelves_pkey rename to entities_pkey');
select pg_temp.ren('rel', '.shelves_slug_key', '.entities_slug_key', 'alter index atlas.shelves_slug_key rename to entities_slug_key');
select pg_temp.ren('rel', '.shelves_legacy_entity_id_key', '.entities_legacy_entity_id_key', 'alter index atlas.shelves_legacy_entity_id_key rename to entities_legacy_entity_id_key');
select pg_temp.ren('rel', '.items_pkey', '.entity_items_pkey', 'alter index atlas.items_pkey rename to entity_items_pkey');
select pg_temp.ren('rel', '.items_item_key_key', '.entity_items_item_key_key', 'alter index atlas.items_item_key_key rename to entity_items_item_key_key');
select pg_temp.ren('rel', '.items_main_shelf_id_idx', '.entity_items_main_entity_id_idx', 'alter index atlas.items_main_shelf_id_idx rename to entity_items_main_entity_id_idx');
select pg_temp.ren('rel', '.items_merged_into_id_idx', '.entity_items_merged_into_id_idx', 'alter index atlas.items_merged_into_id_idx rename to entity_items_merged_into_id_idx');
select pg_temp.ren('rel', '.items_signal_id_main_shelf_id_key', '.entity_items_signal_id_main_entity_id_key', 'alter index atlas.items_signal_id_main_shelf_id_key rename to entity_items_signal_id_main_entity_id_key');
select pg_temp.ren('rel', '.items_main_shelf_timeline_occurred_idx', '.entity_items_main_entity_timeline_occurred_idx', 'alter index atlas.items_main_shelf_timeline_occurred_idx rename to entity_items_main_entity_timeline_occurred_idx');
select pg_temp.ren('rel', '.stories_shelf_open_idx', '.stories_entity_open_idx', 'alter index atlas.stories_shelf_open_idx rename to stories_entity_open_idx');
-- check and foreign key constraints
select pg_temp.ren('con', 'entities.shelves_card_image_url_https', 'entities.entities_card_image_url_https', 'alter table atlas.entities rename constraint shelves_card_image_url_https to entities_card_image_url_https');
select pg_temp.ren('con', 'entities.shelves_status_check', 'entities.entities_status_check', 'alter table atlas.entities rename constraint shelves_status_check to entities_status_check');
select pg_temp.ren('con', 'entities.shelves_type_check', 'entities.entities_type_check', 'alter table atlas.entities rename constraint shelves_type_check to entities_type_check');
select pg_temp.ren('con', 'entity_items.items_angle_check', 'entity_items.entity_items_angle_check', 'alter table atlas.entity_items rename constraint items_angle_check to entity_items_angle_check');
select pg_temp.ren('con', 'entity_items.items_main_shelf_id_fkey', 'entity_items.entity_items_main_entity_id_fkey', 'alter table atlas.entity_items rename constraint items_main_shelf_id_fkey to entity_items_main_entity_id_fkey');
select pg_temp.ren('con', 'entity_items.items_merge_tombstone', 'entity_items.entity_items_merge_tombstone', 'alter table atlas.entity_items rename constraint items_merge_tombstone to entity_items_merge_tombstone');
select pg_temp.ren('con', 'entity_items.items_merged_into_id_fkey', 'entity_items.entity_items_merged_into_id_fkey', 'alter table atlas.entity_items rename constraint items_merged_into_id_fkey to entity_items_merged_into_id_fkey');
select pg_temp.ren('con', 'entity_items.items_merged_into_not_self', 'entity_items.entity_items_merged_into_not_self', 'alter table atlas.entity_items rename constraint items_merged_into_not_self to entity_items_merged_into_not_self');
select pg_temp.ren('con', 'entity_items.items_signal_id_fkey', 'entity_items.entity_items_signal_id_fkey', 'alter table atlas.entity_items rename constraint items_signal_id_fkey to entity_items_signal_id_fkey');
select pg_temp.ren('con', 'entity_items.items_status_check', 'entity_items.entity_items_status_check', 'alter table atlas.entity_items rename constraint items_status_check to entity_items_status_check');
select pg_temp.ren('con', 'stories.stories_shelf_id_fkey', 'stories.stories_entity_id_fkey', 'alter table atlas.stories rename constraint stories_shelf_id_fkey to stories_entity_id_fkey');
-- triggers
select pg_temp.ren('trg', 'entities.shelves_touch', 'entities.entities_touch', 'alter trigger shelves_touch on atlas.entities rename to entities_touch');
select pg_temp.ren('trg', 'entity_items.items_history', 'entity_items.entity_items_history', 'alter trigger items_history on atlas.entity_items rename to entity_items_history');
select pg_temp.ren('trg', 'entity_items.items_touch', 'entity_items.entity_items_touch', 'alter trigger items_touch on atlas.entity_items rename to entity_items_touch');
select pg_temp.ren('trg', 'entities.shelves_history', 'entities.entities_history', 'alter trigger shelves_history on atlas.entities rename to entities_history');
commit;
