-- #537: drop the unused decision queue and dead letter, plus the 4 queue_* functions
-- that only served decision_queue (CTO confirmed). Both tables had 0 rows on prod
-- on 2026-10-31; Bucket asked for no backup. Rollback recreates the DDL, grants and
-- policies, but not data.
-- DO NOT APPLY until Backend Dev's entity manager PR is deployed (see PR).
set lock_timeout = '5s';

drop function if exists atlas.queue_claim(text, integer, interval);
drop function if exists atlas.queue_heartbeat(text, bigint, uuid, interval);
drop function if exists atlas.queue_complete(text, bigint, uuid);
drop function if exists atlas.queue_fail(text, bigint, uuid, text, interval);

drop table if exists atlas.decision_queue restrict;
drop table if exists atlas.dead_letter restrict;

-- TODO(#537, Backend Dev): entity_worker INSERT on atlas.decisions.
-- Column list comes with Backend Dev's PR; do not guess. Will add here:
--   grant insert (<columns>) on atlas.decisions to entity_worker;
--   drop policy if exists entity_worker_insert on atlas.decisions;
--   create policy entity_worker_insert on atlas.decisions for insert to entity_worker with check (<...>);
