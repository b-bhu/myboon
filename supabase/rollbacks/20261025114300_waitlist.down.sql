-- Rollback for #432 waitlist table.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
drop table if exists public.waitlist;
commit;
