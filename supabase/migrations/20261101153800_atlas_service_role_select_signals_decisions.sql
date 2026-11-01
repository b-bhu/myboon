-- #552: the api's /internal/atlas/signals and /analyst routes read atlas.signals and atlas.decisions
-- as service_role over PostgREST. Prod (Nov 1, 2026) grants service_role INSERT only on both, so reads 403.
set lock_timeout = '3s';
grant select on atlas.signals, atlas.decisions to service_role;
