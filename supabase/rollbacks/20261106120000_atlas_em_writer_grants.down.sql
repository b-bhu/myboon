begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
drop policy if exists entity_worker_insert on atlas.entity_items;
revoke insert (item_key, title, summary, main_entity_id, occurred_at, signal_id, angle, note, image_url) on atlas.entity_items from entity_worker;
revoke select (summary, occurred_at, status, item_key) on atlas.entity_items from entity_worker;
revoke select (summary) on atlas.entities from entity_worker;
commit;
