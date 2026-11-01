-- #473 / #444: track when a signal was enqueued so the scout's re-enqueue sweep
-- skips signals that already finished (their queue rows are deleted on complete).
set lock_timeout = '5s';
set statement_timeout = '15s';

alter table atlas.signals add column if not exists enqueued_at timestamptz null;

comment on column atlas.signals.enqueued_at is
  'Set by the news scout right after its signal_queue upsert succeeds. NULL = never enqueued; the sweep re-enqueues only NULL rows created in the last 24h.';

grant select (created_at, enqueued_at), update (enqueued_at) on atlas.signals to service_role;
