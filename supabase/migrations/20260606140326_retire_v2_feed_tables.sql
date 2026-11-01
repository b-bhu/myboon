-- Feed V3 reset: retire V2 feed storage.
-- These tables belonged to the old signals -> narratives -> X broadcast path.
-- V3 keeps source-specific pipeline tables and publishes through published_narratives.

ALTER TABLE IF EXISTS public.published_narratives
  DROP CONSTRAINT IF EXISTS published_narratives_narrative_id_fkey;

DROP TABLE IF EXISTS public.x_posts;
DROP TABLE IF EXISTS public.signals;
DROP TABLE IF EXISTS public.narratives;
DROP TABLE IF EXISTS public.polymarket_tracked;
DROP TABLE IF EXISTS public.polymarket_wallets;
DROP TABLE IF EXISTS public.pacific_tracked;
