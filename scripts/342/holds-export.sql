-- #342 PR-4: read-only export of the 20 entity_identity_grounding hold
-- operations, each target item's live memberships and those entities' stored
-- types. Writes nothing. Save the single jsonb result as holds-export.json and
-- run holds-reclass-csv.py.
WITH ops AS (
  SELECT h.operation_id, count(*) AS holds, min(h.created_at) AS first_hold, max(h.created_at) AS last_hold,
         (array_agg(h.receipt ORDER BY h.sequence DESC))[1] AS last_receipt
  FROM managed_knowledge_private.holds h
  WHERE h.receipt->>'missingDependency' = 'entity_identity_grounding'
     OR h.receipt->'retainedPayload'->'outcome'->>'missingDependency' = 'entity_identity_grounding'
  GROUP BY h.operation_id
), targets AS (
  SELECT ops.operation_id, t.key AS item_id
  FROM ops, jsonb_each_text(coalesce(ops.last_receipt->'retainedPayload'->'targetRevisions','{}'::jsonb)) t
)
SELECT jsonb_build_object(
  'ops', (SELECT jsonb_agg(jsonb_build_object('operation_id',operation_id,'holds',holds,'first_hold',first_hold,'last_hold',last_hold,
            'reason',last_receipt->>'reason','owner',last_receipt->>'owner',
            'targets',(SELECT coalesce(jsonb_agg(item_id),'[]') FROM targets WHERE targets.operation_id = ops.operation_id))
          ORDER BY holds DESC, operation_id) FROM ops),
  'memberships', (SELECT coalesce(jsonb_agg(jsonb_build_object('item_id',m.item_id,'entity_id',m.entity_id,'name',e.name,
            'type',e.type,'uncertain',m.uncertain,'confidence',m.placement_confidence,'catalog',e.catalog_entity_id IS NOT NULL)),'[]')
          FROM managed_knowledge_private.memberships m JOIN managed_knowledge_private.entities e ON e.id = m.entity_id
          WHERE m.removed_operation IS NULL AND m.item_id::text IN (SELECT item_id FROM targets))
) AS export;
