-- squawk-ignore-file prefer-robust-stmts
-- Why: runs as one transaction; IF NOT EXISTS would hide drift.
-- #462: shelf image lives in atlas.shelves.card.image = {"url": text, "source": text}.
-- No new column; this only guards that card.image.url, when present, is https.
-- Backfill: supabase/backfills/462_shelf_card_image.sql
-- Rollback: supabase/rollbacks/20261025141526_atlas_shelves_card_image_check.down.sql
set lock_timeout = '3s';
set statement_timeout = '60s';

alter table atlas.shelves
  add constraint shelves_card_image_url_https
  check ((card->'image'->>'url') is null or (card->'image'->>'url') ~ '^https://')
  not valid;

alter table atlas.shelves validate constraint shelves_card_image_url_https;
