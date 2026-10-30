-- #480 rollback: revoke exactly the grants 20261030230000_atlas_entity_reviews.sql added, then
-- drop the table (its table-level grants go with it). Column revokes of absent privileges are
-- no-ops, so the file is idempotent. The pre-existing service_role grants this migration relied
-- on (decisions.signal_id, table-level SELECT on items/shelves) are NOT revoked.
-- squawk-ignore-file ban-drop-table, prefer-robust-stmts
-- Dropping atlas.entity_reviews is the point of the rollback (the table is one run's own audit,
-- created empty by the migration); the IF EXISTS form keeps the file runnable twice.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

revoke select (id) on atlas.decisions from service_role;
revoke update (status, aliases) on atlas.shelves from service_role;
revoke update (main_shelf_id) on atlas.items from service_role;

drop table if exists atlas.entity_reviews;

commit;