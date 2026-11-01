-- squawk-ignore-file require-concurrent-index-creation, require-concurrent-index-deletion
-- Rollback for supabase/migrations/20261030210000_atlas_items_timeline_occurred_at.sql (#391):
-- rebuild the write-time timeline index (main_shelf_id, created_at DESC, id DESC) that
-- 20261029180000_atlas_analyst_targets.sql created, then drop the occurred_at one. Both steps are
-- IF [NOT] EXISTS, so either direction re-runs as a no-op. Same millisecond-lock argument as the
-- up: prod items 1982 rows (2026-10-29), CONCURRENTLY cannot run inside one transaction.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create index if not exists items_main_shelf_timeline_idx
  on atlas.items (main_shelf_id, created_at desc, id desc);
drop index if exists atlas.items_main_shelf_timeline_occurred_idx;

commit;