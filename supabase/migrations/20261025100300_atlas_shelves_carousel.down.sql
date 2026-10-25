-- squawk-ignore-file ban-drop-column, prefer-robust-stmts
-- Why: rollback of the column added by the paired migration; runs as one transaction.
set lock_timeout = '5s';
set statement_timeout = '60s';

alter table atlas.shelves drop column show_in_carousel;
