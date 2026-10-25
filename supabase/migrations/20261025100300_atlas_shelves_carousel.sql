-- squawk-ignore-file prefer-robust-stmts
-- Why: runs as one transaction; IF NOT EXISTS would hide drift.
-- #441 / #449: carousel flag on shelves, read by stories (#449).
-- Rollback: 20261025100300_atlas_shelves_carousel.down.sql
set lock_timeout = '5s';
set statement_timeout = '60s';

alter table atlas.shelves add column show_in_carousel boolean not null default false;
