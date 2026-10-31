-- tool_log: keep 14 daily partitions ahead (was 3) so missed cron runs can't break inserts.
-- Same job name, so cron.schedule updates the existing job in place. Adds tables only.
select cron.schedule('atlas-tool-log-maintain', '5 0 * * *', 'select atlas.tool_log_maintain(14)');
select atlas.tool_log_maintain(14);
