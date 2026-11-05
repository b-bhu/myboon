-- #571 backfill. Needs migration 20261105150000 applied.
-- Run with psql in autocommit mode (NOT inside BEGIN), from this directory:
--   psql ... -v ON_ERROR_STOP=1 -f 571_em_handoff.sql
-- 1. atlas.item_signals: one 'origin' row per entity_items.signal_id (prod Nov 5: 6,853 items).
-- 2. entity_items.image_url from signals.raw_ids->>'image' (#561), https only, only where null.
-- Safe to rerun: ON CONFLICT DO NOTHING / only-null updates; a rerun changes 0 rows.
-- Batches of 500 items by id, one commit per batch, short lock/statement timeouts.
-- Output (last line): item_signals_origin_rows|items_with_signal|items_with_image_url
set lock_timeout = '3s';
set statement_timeout = '30s';

do $b$
declare
  last_id uuid := '00000000-0000-0000-0000-000000000000';
  ids uuid[];
begin
  loop
    select array_agg(id order by id) into ids
      from (select id from atlas.entity_items where id > last_id order by id limit 500) s;
    exit when ids is null;
    last_id := ids[array_upper(ids, 1)];

    insert into atlas.item_signals (item_id, signal_id, role)
      select i.id, i.signal_id, 'origin' from atlas.entity_items i
       where i.id = any(ids) and i.signal_id is not null
    on conflict do nothing;

    update atlas.entity_items i
       set image_url = s.raw_ids->>'image'
      from atlas.signals s
     where i.id = any(ids) and i.image_url is null and s.signal_id = i.signal_id
       and s.raw_ids->>'image' ~ '^https://' and length(s.raw_ids->>'image') <= 2048;
    commit;
  end loop;
end $b$;

select (select count(*) from atlas.item_signals where role = 'origin')
    || '|' || (select count(*) from atlas.entity_items where signal_id is not null)
    || '|' || (select count(*) from atlas.entity_items where image_url is not null);
