-- #566 backfill rollback: empty the alias tables (schema stays; drop it with the migration rollback).
-- entities.aliases text[] was never modified, so nothing in atlas.entities needs restoring.
set lock_timeout = '3s';
set statement_timeout = '30s';
delete from atlas.entity_aliases;
delete from atlas.entity_alias_conflicts;
delete from atlas.entity_alias_merge_source;
