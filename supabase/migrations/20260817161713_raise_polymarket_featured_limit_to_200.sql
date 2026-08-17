-- Raise the collection-wide featured feed ceiling without changing the
-- per-source discovery limits. This allows multiple ordered sources to each
-- contribute their configured maximum instead of being truncated at 100.

ALTER TABLE public.polymarket_catalog_collections
  DROP CONSTRAINT IF EXISTS polymarket_catalog_collections_default_limit_check;

ALTER TABLE public.polymarket_catalog_collections
  ADD CONSTRAINT polymarket_catalog_collections_default_limit_check
  CHECK (default_limit BETWEEN 1 AND 200);

UPDATE public.polymarket_catalog_collections
SET default_limit = 200,
    updated_at = now()
WHERE collection_key = 'featured'
  AND default_limit < 200;
