-- Polymarket Catalog V3: whole-sport tag sources.
--
-- A sports_rule pins one Polymarket sport code, which maps to a single league
-- (crichundred is The Hundred and nothing else). Covering a sport therefore
-- meant one catalog row per competition, and any league Polymarket launched
-- later stayed invisible until someone added it by hand.
--
-- A sports_tag instead stores a Gamma tag id (cricket is 517). The API expands
-- that tag at read time into every league beneath it, so new competitions show
-- up as soon as Polymarket tags them.

ALTER TABLE public.polymarket_catalog_items
  DROP CONSTRAINT IF EXISTS polymarket_catalog_items_source_kind_check;

ALTER TABLE public.polymarket_catalog_items
  ADD CONSTRAINT polymarket_catalog_items_source_kind_check
  CHECK (source_kind IN ('event', 'market', 'sports_rule', 'sports_tag'));

-- Rewritten to cover sports_tag: same window/marketType rules as sports_rule,
-- but a higher game ceiling because one tag spans many leagues at once, and a
-- required tagId so read-time expansion never has to guess.
ALTER TABLE public.polymarket_catalog_items
  DROP CONSTRAINT IF EXISTS polymarket_catalog_items_rule_config_check;

ALTER TABLE public.polymarket_catalog_items
  ADD CONSTRAINT polymarket_catalog_items_rule_config_check
  CHECK (
    CASE
      WHEN source_kind IN ('sports_rule', 'sports_tag') THEN
        CASE
          WHEN jsonb_typeof(rule_config) = 'object'
            AND jsonb_typeof(rule_config -> 'windowDays') = 'number'
            AND jsonb_typeof(rule_config -> 'limit') = 'number'
            AND rule_config ->> 'marketType' = 'moneyline'
            AND (
              source_kind = 'sports_rule'
              OR nullif(btrim(rule_config ->> 'tagId'), '') IS NOT NULL
            )
          THEN
            (rule_config ->> 'windowDays')::numeric = trunc((rule_config ->> 'windowDays')::numeric)
            AND (rule_config ->> 'windowDays')::numeric BETWEEN 1 AND 30
            AND (rule_config ->> 'limit')::numeric = trunc((rule_config ->> 'limit')::numeric)
            AND (rule_config ->> 'limit')::numeric
                  BETWEEN 1 AND (CASE WHEN source_kind = 'sports_tag' THEN 100 ELSE 50 END)
          ELSE false
        END
      ELSE rule_config = '{}'::jsonb
    END
  );

-- sports_tag carries the same shape as sports_rule: a resolved source_id (the
-- tag id), no condition, and sports display metadata.
ALTER TABLE public.polymarket_catalog_items
  DROP CONSTRAINT IF EXISTS polymarket_catalog_items_sports_rule_metadata_check;

ALTER TABLE public.polymarket_catalog_items
  ADD CONSTRAINT polymarket_catalog_items_sports_rule_metadata_check
  CHECK (
    source_kind NOT IN ('sports_rule', 'sports_tag')
    OR (
      source_id IS NOT NULL
      AND condition_id IS NULL
      AND category = 'sports'
      AND sport IS NOT NULL
    )
  );
