-- Rollback for 20261025114823_atlas_service_role_read.sql: revokes exactly what it granted.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

revoke select on table atlas.shelves, atlas.items from service_role;
revoke usage on schema atlas from service_role;

commit;
