-- squawk-ignore-file prefer-robust-stmts, renaming-table, renaming-column, require-concurrent-index-creation
-- Rollback for 20261031180000_atlas_entity_rename. Idempotent. One transaction.
-- Restores the old table, column, index, constraint and trigger names (grants and policies move
-- with the tables), then recreates atlas.item_shelves exactly as read on prod 2026-10-31
-- (columns, pkey, shelf_id index, FKs, role check, RLS + analyst_read policy, atlas_analyst select,
-- history trigger) and reloads its rows from atlas.item_shelves_bak_541. The backup is kept.
-- Rows written to atlas.history after the up keep the new table names.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
select pg_temp.ren('rel', '.entity_items', '.items', 'alter table atlas.entity_items rename to items');
select pg_temp.ren('rel', '.entities', '.shelves', 'alter table atlas.entities rename to shelves');
-- columns
select pg_temp.ren('col', 'items.main_entity_id', 'items.main_shelf_id', 'alter table atlas.items rename column main_entity_id to main_shelf_id');
select pg_temp.ren('col', 'stories.entity_id', 'stories.shelf_id', 'alter table atlas.stories rename column entity_id to shelf_id');
-- indexes (pkey / unique constraints are renamed with their index)
select pg_temp.ren('rel', '.entities_pkey', '.shelves_pkey', 'alter index atlas.entities_pkey rename to shelves_pkey');
select pg_temp.ren('rel', '.entities_slug_key', '.shelves_slug_key', 'alter index atlas.entities_slug_key rename to shelves_slug_key');
select pg_temp.ren('rel', '.entities_legacy_entity_id_key', '.shelves_legacy_entity_id_key', 'alter index atlas.entities_legacy_entity_id_key rename to shelves_legacy_entity_id_key');
select pg_temp.ren('rel', '.entity_items_pkey', '.items_pkey', 'alter index atlas.entity_items_pkey rename to items_pkey');
select pg_temp.ren('rel', '.entity_items_item_key_key', '.items_item_key_key', 'alter index atlas.entity_items_item_key_key rename to items_item_key_key');
select pg_temp.ren('rel', '.entity_items_main_entity_id_idx', '.items_main_shelf_id_idx', 'alter index atlas.entity_items_main_entity_id_idx rename to items_main_shelf_id_idx');
select pg_temp.ren('rel', '.entity_items_merged_into_id_idx', '.items_merged_into_id_idx', 'alter index atlas.entity_items_merged_into_id_idx rename to items_merged_into_id_idx');
select pg_temp.ren('rel', '.entity_items_signal_id_main_entity_id_key', '.items_signal_id_main_shelf_id_key', 'alter index atlas.entity_items_signal_id_main_entity_id_key rename to items_signal_id_main_shelf_id_key');
select pg_temp.ren('rel', '.entity_items_main_entity_timeline_occurred_idx', '.items_main_shelf_timeline_occurred_idx', 'alter index atlas.entity_items_main_entity_timeline_occurred_idx rename to items_main_shelf_timeline_occurred_idx');
select pg_temp.ren('rel', '.stories_entity_open_idx', '.stories_shelf_open_idx', 'alter index atlas.stories_entity_open_idx rename to stories_shelf_open_idx');
-- check and foreign key constraints
select pg_temp.ren('con', 'shelves.entities_card_image_url_https', 'shelves.shelves_card_image_url_https', 'alter table atlas.shelves rename constraint entities_card_image_url_https to shelves_card_image_url_https');
select pg_temp.ren('con', 'shelves.entities_status_check', 'shelves.shelves_status_check', 'alter table atlas.shelves rename constraint entities_status_check to shelves_status_check');
select pg_temp.ren('con', 'shelves.entities_type_check', 'shelves.shelves_type_check', 'alter table atlas.shelves rename constraint entities_type_check to shelves_type_check');
select pg_temp.ren('con', 'items.entity_items_angle_check', 'items.items_angle_check', 'alter table atlas.items rename constraint entity_items_angle_check to items_angle_check');
select pg_temp.ren('con', 'items.entity_items_main_entity_id_fkey', 'items.items_main_shelf_id_fkey', 'alter table atlas.items rename constraint entity_items_main_entity_id_fkey to items_main_shelf_id_fkey');
select pg_temp.ren('con', 'items.entity_items_merge_tombstone', 'items.items_merge_tombstone', 'alter table atlas.items rename constraint entity_items_merge_tombstone to items_merge_tombstone');
select pg_temp.ren('con', 'items.entity_items_merged_into_id_fkey', 'items.items_merged_into_id_fkey', 'alter table atlas.items rename constraint entity_items_merged_into_id_fkey to items_merged_into_id_fkey');
select pg_temp.ren('con', 'items.entity_items_merged_into_not_self', 'items.items_merged_into_not_self', 'alter table atlas.items rename constraint entity_items_merged_into_not_self to items_merged_into_not_self');
select pg_temp.ren('con', 'items.entity_items_signal_id_fkey', 'items.items_signal_id_fkey', 'alter table atlas.items rename constraint entity_items_signal_id_fkey to items_signal_id_fkey');
select pg_temp.ren('con', 'items.entity_items_status_check', 'items.items_status_check', 'alter table atlas.items rename constraint entity_items_status_check to items_status_check');
select pg_temp.ren('con', 'stories.stories_entity_id_fkey', 'stories.stories_shelf_id_fkey', 'alter table atlas.stories rename constraint stories_entity_id_fkey to stories_shelf_id_fkey');
-- triggers
select pg_temp.ren('trg', 'shelves.entities_touch', 'shelves.shelves_touch', 'alter trigger entities_touch on atlas.shelves rename to shelves_touch');
select pg_temp.ren('trg', 'items.entity_items_history', 'items.items_history', 'alter trigger entity_items_history on atlas.items rename to items_history');
select pg_temp.ren('trg', 'items.entity_items_touch', 'items.items_touch', 'alter trigger entity_items_touch on atlas.items rename to items_touch');
select pg_temp.ren('trg', 'shelves.entities_history', 'shelves.shelves_history', 'alter trigger entities_history on atlas.shelves rename to shelves_history');
-- links table
create table if not exists atlas.item_shelves (
  item_id    uuid not null,
  shelf_id   uuid not null,
  role       text not null default 'also_affects',
  created_at timestamptz not null default now(),
  constraint item_shelves_pkey primary key (item_id, shelf_id, role),
  constraint item_shelves_item_id_fkey foreign key (item_id) references atlas.items (id) on delete cascade,
  constraint item_shelves_shelf_id_fkey foreign key (shelf_id) references atlas.shelves (id),
  constraint item_shelves_role_check check (role = 'also_affects')
);
create index if not exists item_shelves_shelf_id_idx on atlas.item_shelves (shelf_id);
alter table atlas.item_shelves enable row level security;
revoke all on atlas.item_shelves from public, anon, authenticated, service_role;
grant select on atlas.item_shelves to atlas_analyst;
drop policy if exists analyst_read on atlas.item_shelves;
create policy analyst_read on atlas.item_shelves for select to atlas_analyst using (true);
drop trigger if exists item_shelves_history on atlas.item_shelves;
do $d$ begin
  if to_regclass('atlas.item_shelves_bak_541') is not null then
    -- reload without logging history rows for the restore
    alter table atlas.item_shelves disable trigger user;
    insert into atlas.item_shelves (item_id, shelf_id, role, created_at)
      select item_id, shelf_id, role, created_at from atlas.item_shelves_bak_541
      on conflict do nothing;
    alter table atlas.item_shelves enable trigger user;
  end if;
end $d$;
create trigger item_shelves_history after insert or update or delete on atlas.item_shelves
  for each row execute function atlas.write_history('item_id', 'shelf_id', 'role');
commit;
