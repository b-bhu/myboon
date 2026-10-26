-- #444 / PR #473: minimal write access to the Atlas signal queue for the news scout,
-- which connects as service_role (one shared team login, per CTO).
-- The queue_* functions are SECURITY INVOKER, so service_role needs the table
-- privileges they use, not just EXECUTE. Every grant below was checked against the
-- scout's own SQL on a local Postgres; dropping any one of them breaks a scout call.
--   atlas.signals       insert; select on (signal_id, source, source_id) only, for
--                       ON CONFLICT (source, source_id) and RETURNING signal_id
--   atlas.signal_queue  insert, select, update, delete (enqueue, ON CONFLICT, and
--                       claim / heartbeat / complete / fail inside queue_*)
--   atlas.dead_letter   insert only (queue_fail at max_attempts)
--   atlas.queue_*       execute
-- Nothing for decision_queue, anon or authenticated. service_role already has USAGE
-- on schema atlas (#449) and EXECUTE on atlas.uuidv7(). It bypasses RLS on Supabase.
-- Rollback: supabase/rollbacks/20261026011119_atlas_scout_service_role_grants.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

grant insert on table atlas.signals to service_role;
grant select (signal_id, source, source_id) on table atlas.signals to service_role;
grant select, insert, update, delete on table atlas.signal_queue to service_role;
grant insert on table atlas.dead_letter to service_role;
grant execute on function
  atlas.queue_claim(text, integer, interval),
  atlas.queue_heartbeat(text, bigint, uuid, interval),
  atlas.queue_complete(text, bigint, uuid),
  atlas.queue_fail(text, bigint, uuid, text, interval)
  to service_role;

commit;
