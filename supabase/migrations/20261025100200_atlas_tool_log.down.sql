-- squawk-ignore-file ban-drop-table, ban-drop-function, ban-drop-schema, prefer-robust-stmts
-- Why: rollback of objects created by the paired migration; no client uses atlas yet.
-- Runs as one transaction; IF EXISTS would hide a half-applied state.
-- Rollback for 20261025100200_atlas_tool_log.sql.
-- Leaves the pg_cron extension installed: other jobs may use it later. Drop it by hand only if no jobs remain.
set lock_timeout = '5s';
set statement_timeout = '60s';

select cron.unschedule(jobid) from cron.job where jobname = 'atlas-tool-log-maintain';
drop function atlas.tool_log_maintain(integer, integer);
drop table atlas.tool_log;
