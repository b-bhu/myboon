-- squawk-ignore-file ban-drop-table, ban-drop-column, prefer-robust-stmts
-- ban-drop-column: the four decisions probability columns are added by the paired migration only.
-- Why: rollback of the routing_rules migration; the table is tiny and has no
-- dependents, and no client uses atlas yet, while DROP without IF EXISTS keeps
-- the rollback honest about a half-applied state (as in the #485 rollback).
-- Rollback for 20261026230000_atlas_routing_rules.sql. Revokes exactly what the
-- up migration granted to service_role -- select on atlas.routing_rules and the
-- insert + select (signal_id, analyst_version) on atlas.decisions and select (text, excerpt, occurred_at) on atlas.signals -- then drops the table (atlas.uuidv7() stays
-- as it was: still PUBLIC-executable since #441, this migration never touched it).
-- Deletes nothing on purpose: routing rules are configuration, and rolling back
-- drops them with the table.
set lock_timeout = '5s';
set statement_timeout = '60s';

revoke select on table atlas.routing_rules from service_role;
revoke insert on table atlas.decisions from service_role;
revoke select (signal_id, analyst_version) on table atlas.decisions from service_role;
revoke select (text, excerpt, occurred_at) on table atlas.signals from service_role;

alter table atlas.decisions
  drop column item_margin,
  drop column item_p,
  drop column entity_margin,
  drop column entity_p;

drop table atlas.routing_rules;