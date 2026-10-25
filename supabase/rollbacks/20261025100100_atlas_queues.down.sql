-- squawk-ignore-file ban-drop-table, ban-drop-function, ban-drop-schema, prefer-robust-stmts
-- Why: rollback of objects created by the paired migration; no client uses atlas yet.
-- Runs as one transaction; IF EXISTS would hide a half-applied state.
-- Rollback for 20261025100100_atlas_queues.sql.
set lock_timeout = '5s';
set statement_timeout = '60s';

drop function atlas.queue_fail(text, bigint, uuid, text, interval);
drop function atlas.queue_complete(text, bigint, uuid);
drop function atlas.queue_heartbeat(text, bigint, uuid, interval);
drop function atlas.queue_claim(text, integer, interval);
drop table atlas.dead_letter;
drop table atlas.decision_queue;
drop table atlas.signal_queue;
