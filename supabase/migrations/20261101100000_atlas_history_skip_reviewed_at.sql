-- #543: stop atlas.history growing on entity-manager review stamps.
-- An UPDATE whose only changed column (besides updated_at, already ignored) is
-- entity_reviewed_at no longer writes a history row. Any other change, including
-- entity_reviewed_at together with a real column, still writes one, and that row
-- keeps entity_reviewed_at in `changed`. INSERT and DELETE are unchanged.
-- entity_reviewed_at exists on atlas.entities and atlas.decisions (both have the
-- history trigger). Prod Nov 1: ~833/day entities rows were stamp-only; decisions
-- review updates always carry entity_reason/outcome, so they are still logged.
-- CREATE OR REPLACE keeps the owner, ACL and every trigger binding.
-- Rollback: supabase/rollbacks/20261101100000_atlas_history_skip_reviewed_at.down.sql
set lock_timeout = '5s';
set statement_timeout = '30s';

create or replace function atlas.write_history() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_new jsonb := case when tg_op <> 'DELETE' then pg_catalog.to_jsonb(new) end;
  v_old jsonb := case when tg_op <> 'INSERT' then pg_catalog.to_jsonb(old) end;
  v_changed jsonb;
  v_pk jsonb := '{}';
  v_col text;
begin
  foreach v_col in array tg_argv loop
    v_pk := v_pk || pg_catalog.jsonb_build_object(v_col, coalesce(v_new, v_old) -> v_col);
  end loop;
  if tg_op = 'UPDATE' then
    select coalesce(pg_catalog.jsonb_object_agg(n.key, n.value), '{}') into v_changed
    from pg_catalog.jsonb_each(v_new) n
    where n.value is distinct from (v_old -> n.key) and n.key <> 'updated_at';
    -- #543: a review stamp alone is not history.
    if v_changed - 'entity_reviewed_at' = '{}' then return null; end if;
  else
    v_changed := coalesce(v_new, v_old);
  end if;
  insert into atlas.history (table_name, row_pk, op, changed, reason)
  values (tg_table_name, v_pk, tg_op, v_changed, nullif(pg_catalog.current_setting('atlas.reason', true), ''));
  return null;
end $$;
