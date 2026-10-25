-- squawk-ignore-file ban-drop-constraint
-- Why: rollback of the constraint added by the paired migration.
-- Rollback of 20261025141526_atlas_shelves_card_image_check.sql (#462).
-- Data rollback first (optional, batched): supabase/backfills/462_shelf_card_image.down.sql
set lock_timeout = '3s';
set statement_timeout = '60s';

alter table atlas.shelves drop constraint if exists shelves_card_image_url_https;
