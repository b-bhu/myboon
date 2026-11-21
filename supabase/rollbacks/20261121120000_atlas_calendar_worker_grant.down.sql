-- Rollback of 20261121120000 (#702): revoke calendar_worker from latest_update_worker.
-- Leaves calendar_worker, atlas.event_releases, and latest_update_worker's own grants as they
-- are. Does not touch LOGIN or any password.
-- Idempotent: safe to rerun, and safe if the up never ran or if either role is missing.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'calendar_worker')
     and exists (select 1 from pg_catalog.pg_roles where rolname = 'latest_update_worker') then
    execute 'revoke calendar_worker from latest_update_worker';
  end if;
end $$;

commit;
