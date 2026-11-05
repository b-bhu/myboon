-- #571 backfill rollback: remove origin links and image_url values.
-- WARNING: after cutover (the entity manager writes item_signals / image_url) this destroys live data.
-- Guard: refuses unless the session opts in first, e.g.
--   PGOPTIONS="-c myboon.allow_571_wipe=pre-cutover" psql ... -f 571_em_handoff.down.sql
set lock_timeout = '3s';
set statement_timeout = '30s';
do $g$ begin
  if coalesce(current_setting('myboon.allow_571_wipe', true), '') <> 'pre-cutover' then
    raise exception 'refusing #571 backfill wipe: set myboon.allow_571_wipe = ''pre-cutover''';
  end if;
end $g$;
delete from atlas.item_signals where role = 'origin';
update atlas.entity_items set image_url = null where image_url is not null;
