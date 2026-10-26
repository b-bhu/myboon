-- Rollback for 20261026011119_atlas_scout_service_role_grants.sql: revokes exactly what it granted.
-- Leaves #449's USAGE on schema atlas and SELECT on shelves/items in place.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

revoke execute on function
  atlas.queue_claim(text, integer, interval),
  atlas.queue_heartbeat(text, bigint, uuid, interval),
  atlas.queue_complete(text, bigint, uuid),
  atlas.queue_fail(text, bigint, uuid, text, interval)
  from service_role;
revoke insert on table atlas.dead_letter from service_role;
revoke select, insert, update, delete on table atlas.signal_queue from service_role;
revoke select (signal_id, source, source_id) on table atlas.signals from service_role;
revoke insert on table atlas.signals from service_role;

commit;
