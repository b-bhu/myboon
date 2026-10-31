-- #462 backfill rollback: remove card.image. Repeat until UPDATE 0.
-- Rows whose card was NULL before the backfill end up as '{}' (snapshot: /workspace/462-entities-before.json on the box).
set lock_timeout = '3s';
set statement_timeout = '30s';

with batch as (
  select id from atlas.entities where card ? 'image' order by id limit 200
)
update atlas.entities sh
set card = case when sh.card - 'image' = '{}'::jsonb then null else sh.card - 'image' end
from batch b
where sh.id = b.id;
