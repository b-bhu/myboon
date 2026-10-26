-- Rollback for atlas_signals_enqueued_at
set lock_timeout = '5s';
set statement_timeout = '15s';

revoke select (created_at, enqueued_at), update (enqueued_at) on atlas.signals from service_role;

-- squawk-ignore ban-drop-column
alter table atlas.signals drop column if exists enqueued_at;
