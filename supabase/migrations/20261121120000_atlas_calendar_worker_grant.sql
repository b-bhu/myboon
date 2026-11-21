-- #702: let the calendar releases job reuse the latest_update_worker login instead of
-- giving calendar_worker a password. GRANT calendar_worker TO latest_update_worker
-- WITH INHERIT TRUE, so the job can use calendar_worker's scoped grants (select/insert/update
-- on atlas.event_releases, no delete; select id, slug, status on atlas.entities) without
-- SET ROLE. A plain GRANT is not enough: both roles are NOINHERIT, so inherit_option would
-- stay false and the privileges would be refused. WITH INHERIT TRUE is required (Postgres 16+;
-- prod is 17). calendar_worker stays NOLOGIN, with no password.
-- Safe to rerun: a second GRANT WITH INHERIT TRUE is a no-op, and it also repairs a plain
-- GRANT that left inherit_option false.
-- Rollback: supabase/rollbacks/20261121120000_atlas_calendar_worker_grant.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

grant calendar_worker to latest_update_worker with inherit true;

commit;
