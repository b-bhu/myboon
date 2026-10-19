-- #342 PR-4: read-only export for the article-created entity review CSV.
-- Run read-only against prod (e.g. Supabase SQL / execute_sql); writes nothing.
-- Output: one jsonb array; save it as review-export.json and run review-csv.py.
SELECT jsonb_agg(row_to_json(t) ORDER BY t.created_at, t.id) FROM (
  SELECT e.id, e.name, e.name_key, e.type, e.aliases, e.status, e.catalog_entity_id, e.created_at,
         e.created_operation IS NOT NULL AND e.catalog_entity_id IS NULL AS article_created,
         (SELECT count(*) FROM managed_knowledge_private.memberships m
           WHERE m.entity_id = e.id AND m.removed_operation IS NULL) AS live_items
  FROM managed_knowledge_private.entities e
  WHERE e.status IS DISTINCT FROM 'archived'
) t;
