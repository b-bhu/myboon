-- #566 backfill rollback: empty the alias tables (schema stays; drop it with the migration rollback).
-- WARNING: after cutover (app writes go to atlas.entity_aliases) this destroys live alias data.
-- Guard: refuses unless the session opts in first, e.g.
--   psql ... -c "set myboon.allow_alias_wipe = 'pre-cutover'" -f 566_entity_aliases.down.sql   (or via PGOPTIONS)
-- entities.aliases text[] was never modified, so nothing in atlas.entities needs restoring.
set lock_timeout = '3s';
set statement_timeout = '30s';
do $g$ begin
  if coalesce(current_setting('myboon.allow_alias_wipe', true), '') <> 'pre-cutover' then
    raise exception 'refusing to wipe atlas.entity_aliases: set myboon.allow_alias_wipe = ''pre-cutover'' (only before app writes move to the table)';
  end if;
end $g$;
delete from atlas.entity_aliases;
delete from atlas.entity_alias_conflicts;
delete from atlas.entity_alias_merge_source;
