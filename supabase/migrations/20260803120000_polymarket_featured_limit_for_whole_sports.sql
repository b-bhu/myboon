-- Raise the featured collection ceiling for whole-sport tag sources.
--
-- default_limit is the hard cap hydrate applies across the entire collection,
-- and the featured collection was seeded at 20 back when every source was a
-- single pinned market or one league. A sports_tag expands to every league
-- beneath it — cricket alone runs ~55 fixtures in a two-week window — so the
-- old ceiling would silently truncate the feed regardless of the per-source
-- limit an operator configures.
--
-- 100 matches the table CHECK ceiling and the per-source sports_tag limit.

UPDATE public.polymarket_catalog_collections
SET default_limit = 100,
    updated_at = now()
WHERE collection_key = 'featured'
  AND default_limit < 100;
