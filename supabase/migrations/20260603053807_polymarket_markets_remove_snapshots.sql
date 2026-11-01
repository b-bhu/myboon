-- Feed V3 reset: keep latest Data Engineer state, not append-only market snapshots.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'polymarket_market_watchlist'
      AND column_name = 'latest_snapshot_at'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'polymarket_market_watchlist'
      AND column_name = 'latest_observed_at'
  ) THEN
    ALTER TABLE public.polymarket_market_watchlist
      RENAME COLUMN latest_snapshot_at TO latest_observed_at;
  END IF;
END $$;

DROP TABLE IF EXISTS public.polymarket_market_snapshots;
