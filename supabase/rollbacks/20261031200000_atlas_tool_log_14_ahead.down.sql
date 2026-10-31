-- Rollback: back to 3 days ahead. Extra future partitions are empty and harmless; left in place.
select cron.schedule('atlas-tool-log-maintain', '5 0 * * *', 'select atlas.tool_log_maintain()');
