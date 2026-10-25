-- #449: read-only access to Atlas shelves for the API (service_role only).
-- Grants USAGE on schema atlas and SELECT on atlas.shelves and atlas.items. No writes,
-- no other atlas tables, nothing for anon or authenticated. Rollback revokes exactly this.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

grant usage on schema atlas to service_role;
grant select on table atlas.shelves, atlas.items to service_role;

commit;
