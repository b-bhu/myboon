-- Rollback for supabase/migrations/20261020100000_published_narratives_feed_idx.sql
-- (#336 item 8, Linglong, Oct 20). The index was originally owned by
-- supabase/migrations/20260605_polymarket_market_publisher.sql:89; this
-- rollback drops the index and leaves the table untouched.
-- Idempotent: DROP IF EXISTS.

DROP INDEX IF EXISTS public.published_narratives_feed_idx;