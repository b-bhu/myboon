-- squawk-ignore-file ban-drop-table, ban-drop-function, prefer-robust-stmts, ban-drop-constraint
-- Why: rollback of objects created by the paired migration; no client uses atlas yet.
-- Runs as one transaction; IF EXISTS would hide a half-applied state. The dead_letter
-- constraint restore is DROP + ADD ... NOT VALID + VALIDATE, mirroring the forward
-- migration (the drop of the same-named check is the swap's first half, and an inline
-- CHECK cannot be edited in place -- ban-drop-constraint ignored).
-- Rollback for 20261026220000_atlas_signal_states.sql. Revokes exactly what the
-- migration granted to service_role, restores the #441 dead_letter queue_name check
-- (which allowed only 'signal_queue' and 'decision_queue'), then drops the signal-state
-- tables and functions. Deletes nothing on purpose: if any row was dead-lettered with
-- queue_name = 'signal_states', the restored VALIDATE fails and this rollback aborts
-- loudly instead of discarding the dead-letter evidence -- review or remove those rows
-- by hand before rolling back.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- Service_role grants from the up migration, revoked before the drops so the
-- statements name objects that still exist.
revoke execute on function
  atlas.signal_admit(integer),
  atlas.signal_claim(text, integer, interval, text),
  atlas.signal_sweep(),
  atlas.signal_advance(text, uuid, text, text),
  atlas.signal_fail(text, uuid, text, interval)
  from service_role;
revoke select, insert, update on table atlas.signal_states from service_role;
revoke select, insert on table atlas.jev_decisions from service_role;

-- Original #441 check, same name and value list as before this migration.
alter table atlas.dead_letter drop constraint dead_letter_queue_name_check;
alter table atlas.dead_letter
  add constraint dead_letter_queue_name_check
    check (queue_name in ('signal_queue','decision_queue')) not valid;
alter table atlas.dead_letter validate constraint dead_letter_queue_name_check;

drop function atlas.signal_fail(text, uuid, text, interval);
drop function atlas.signal_advance(text, uuid, text, text);
drop function atlas.signal_sweep();
drop function atlas.signal_claim(text, integer, interval, text);
drop function atlas.signal_admit(integer);
drop table atlas.jev_decisions;
drop table atlas.signal_states;