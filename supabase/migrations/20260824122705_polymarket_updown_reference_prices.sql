-- Never applied to prod (#397 audit, Oct 25 2026): the table is absent and the
-- version has no history row. Made rerunnable (IF NOT EXISTS) with timeouts
-- before its first apply. Rollback:
-- supabase/rollbacks/20260824122705_polymarket_updown_reference_prices.down.sql
SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.polymarket_updown_reference_prices (
  round_slug text PRIMARY KEY,
  asset text NOT NULL CHECK (asset IN ('btc', 'eth')),
  duration text NOT NULL CHECK (duration IN ('hourly', 'daily')),
  boundary_time timestamptz NOT NULL,
  price numeric(38, 18) NOT NULL CHECK (price > 0),
  source text NOT NULL CHECK (source = 'binance'),
  source_symbol text NOT NULL CHECK (source_symbol IN ('BTCUSDT', 'ETHUSDT')),
  source_interval text NOT NULL CHECK (source_interval IN ('1m', '1h')),
  source_value_type text NOT NULL CHECK (source_value_type IN ('open', 'close')),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.polymarket_updown_reference_prices IS
  'Server-owned Binance candle values used as the price-to-beat for mapped Polymarket Up/Down rounds.';
COMMENT ON COLUMN public.polymarket_updown_reference_prices.boundary_time IS
  'Gamma market.eventStartTime; the actual round boundary rather than the event publication timestamp.';

ALTER TABLE public.polymarket_updown_reference_prices ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.polymarket_updown_reference_prices FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.polymarket_updown_reference_prices
  TO service_role;
