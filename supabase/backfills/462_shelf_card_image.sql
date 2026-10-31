-- #462 backfill: card.image from the legacy entity (managed_knowledge_private.entities.metadata.image_url),
-- joined through atlas.entities.legacy_entity_id. Idempotent: only rows without card.image, only https URLs.
-- Run one batch per statement (autocommit) and repeat until it reports UPDATE 0. Never one big transaction.
set lock_timeout = '3s';
set statement_timeout = '30s';

with batch as (
  select sh.id,
         jsonb_build_object('url', e.metadata->>'image_url',
                            'source', coalesce(e.metadata->>'image_origin', 'legacy_entity')) as image
  from atlas.entities sh
  join managed_knowledge_private.entities e on e.id = sh.legacy_entity_id
  where sh.card->'image' is null
    and e.metadata->>'image_url' ~ '^https://'
  order by sh.id
  limit 200
)
update atlas.entities sh
set card = coalesce(sh.card, '{}'::jsonb) || jsonb_build_object('image', b.image)
from batch b
where sh.id = b.id;
