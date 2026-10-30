-- squawk-ignore-file require-concurrent-index-creation
-- #391: the shelf timeline orders by signal time, not write time. Every item filed since #482
-- copies its signal's occurred_at, and the reader (packages/analyst/src/linker-story.ts, loadItems)
-- walks each shelf's timeline over (occurred_at DESC, id) with created_at as the older-row tiebreak,
-- but items_main_shelf_timeline_idx (20261029180000_atlas_analyst_targets.sql) was built on write
-- time: (main_shelf_id, created_at DESC, id DESC). Swapped in one transaction, new index first so a
-- timeline query always has an index; the created_at index is dropped inside the same commit.
-- atlas.prod: items 1982 rows, shelves 558 (2026-10-29), so both index builds take milliseconds and
-- the plain (non-CONCURRENTLY) builds lock the table harmlessly; CONCURRENTLY cannot run inside
-- this one-transaction migration file (same as #503/#505).
-- Rollback: supabase/rollbacks/20261030210000_atlas_items_timeline_occurred_at.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create index if not exists items_main_shelf_timeline_occurred_idx
  on atlas.items (main_shelf_id, occurred_at desc nulls last, created_at desc, id desc);
drop index if exists atlas.items_main_shelf_timeline_idx;

commit;