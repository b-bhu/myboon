-- squawk-ignore-file ban-drop-table, ban-drop-function, prefer-robust-stmts
-- Why: rollback of objects created by the paired migration; no client uses atlas yet.
-- Runs as one transaction; IF EXISTS would hide a half-applied state.
-- Rollback for 20261026220000_atlas_signal_states.sql.
set lock_timeout = '5s';
set statement_timeout = '60s';

drop function atlas.signal_fail(text, uuid, text, interval);
drop function atlas.signal_advance(text, uuid, text, text);
drop function atlas.signal_sweep();
drop function atlas.signal_claim(text, integer, interval, text);
drop function atlas.signal_admit(integer);
drop table atlas.jev_decisions;
drop table atlas.signal_states;