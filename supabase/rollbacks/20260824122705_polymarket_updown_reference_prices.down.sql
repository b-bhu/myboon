-- Rollback for 20260824122705_polymarket_updown_reference_prices.sql (#397).
-- Drops the table it created. Loses any reference prices written since apply;
-- the API refetches them from Binance on demand.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

drop table if exists public.polymarket_updown_reference_prices;

commit;
