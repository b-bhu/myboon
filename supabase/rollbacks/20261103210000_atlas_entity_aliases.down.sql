-- squawk-ignore-file ban-drop-table, ban-drop-function, ban-drop-constraint, require-concurrent-index-deletion
-- Rollback for supabase/migrations/20261103210000_atlas_entity_aliases.sql (#566).
-- Drops everything the up created. entities.aliases (text[]) was never touched, so no data is lost
-- from atlas.entities; alias rows written after the up are lost (re-create them with the backfill).
-- Every step is IF EXISTS, so it reruns as a no-op.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function if exists atlas.move_entity_aliases(uuid, uuid);
drop function if exists atlas.entity_candidates(text, text[]);
drop function if exists atlas.entity_candidates_any(text[]);
drop table if exists atlas.entity_alias_merge_source;
drop table if exists atlas.entity_alias_conflicts;
drop table if exists atlas.entity_aliases;
drop index if exists atlas.entities_type_status_idx;
alter table atlas.entities drop constraint if exists entities_id_type_key;
drop function if exists atlas.norm_alias(text);

commit;
