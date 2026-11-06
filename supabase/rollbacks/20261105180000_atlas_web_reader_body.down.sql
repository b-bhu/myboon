-- squawk-ignore-file require-concurrent-index-deletion, ban-drop-constraint, ban-drop-column
-- (rollback: drops only the objects 20261105180000 added, inside one short transaction)
-- Rollback of 20261105180000 (#582): drop the web_reader_worker policies, grants and role, then the
-- pick index, body checks and body columns. Idempotent: safe to rerun, and safe if the up never ran.
-- Drops fetched article bodies (body/body_status/body_fetched_at) only; nothing else is touched.
-- If the role has LOGIN on prod, stop the web reader first: drop role fails while connected.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop policy if exists web_reader_worker_select on atlas.signals;
drop policy if exists web_reader_worker_update on atlas.signals;

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'web_reader_worker') then
    execute 'revoke all on all tables in schema atlas from web_reader_worker';
    execute 'revoke all on all sequences in schema atlas from web_reader_worker';
    execute 'revoke all on all functions in schema atlas from web_reader_worker';
    execute 'revoke all on schema atlas from web_reader_worker';
    execute 'drop role web_reader_worker';
  end if;
end $$;

drop index if exists atlas.signals_body_pick_idx;
alter table atlas.signals drop constraint if exists signals_body_length_check;
alter table atlas.signals drop constraint if exists signals_body_status_check;
alter table atlas.signals drop column if exists body_fetched_at;
alter table atlas.signals drop column if exists body_status;
alter table atlas.signals drop column if exists body;

commit;
