-- #566 backfill: fill atlas.entity_aliases. Needs migration 20261103210000 applied.
-- Run with psql in autocommit mode (NOT inside BEGIN), from this directory:
--   psql ... -v ON_ERROR_STOP=1 -f 566_entity_aliases.sql
-- Sources, in priority order (an earlier source wins a (type, norm_alias) clash):
--   1. active entities: name           (source 'active_name')
--   2. active entities: aliases text[] (source 'active_alias')
--   3. merged losers from the Nov 3 cleanup -> their ACTIVE winner, winner's type ('merged_loser')
-- Retired entities that were not merged get no rows, so they never block a future match.
-- Clashes with a different entity go to atlas.entity_alias_conflicts; nothing fails.
-- Safe to rerun: every insert is ON CONFLICT DO NOTHING; a rerun adds 0 rows and 0 conflicts.
-- Batches of 200 entities, one commit per batch, short lock/statement timeouts.
set lock_timeout = '3s';
set statement_timeout = '30s';

\i 566_merged_names.sql

do $b$
declare
  last_id uuid := '00000000-0000-0000-0000-000000000000';
  ids uuid[];
  added int; total int := 0; conf int; total_conf int := 0;
begin
  loop
    select array_agg(id order by id) into ids
      from (select id from atlas.entities where status = 'active' and id > last_id order by id limit 200) s;
    exit when ids is null;
    last_id := ids[array_upper(ids, 1)];

    create temp table if not exists _src (entity_id uuid, type text, alias text, source text, prio int) on commit drop;
    truncate _src;
    insert into _src
      select e.id, e.type, e.name, 'active_name', 1 from atlas.entities e where e.id = any(ids)
      union all
      select e.id, e.type, a, 'active_alias', 2 from atlas.entities e, unnest(e.aliases) a where e.id = any(ids);

    insert into atlas.entity_alias_conflicts (type, alias, norm_alias, wanted_entity_id, holder_entity_id, source)
      select s.type, s.alias, atlas.norm_alias(s.alias), s.entity_id, h.entity_id, s.source
      from _src s join atlas.entity_aliases h on h.type = s.type and h.norm_alias = atlas.norm_alias(s.alias)
      where h.entity_id <> s.entity_id
    on conflict do nothing;
    get diagnostics conf = row_count;

    insert into atlas.entity_aliases (entity_id, type, alias)
      select distinct on (s.type, atlas.norm_alias(s.alias)) s.entity_id, s.type, btrim(s.alias)
      from _src s where atlas.norm_alias(s.alias) is not null
      order by s.type, atlas.norm_alias(s.alias), s.prio, s.entity_id
    on conflict do nothing;
    get diagnostics added = row_count;
    total := total + added; total_conf := total_conf + conf;
    commit;
  end loop;
  raise notice 'active: aliases added %, new conflicts %', total, total_conf;
end $b$;

-- in-batch clashes (two active entities in the same batch sharing a norm_alias) lost the DISTINCT ON;
-- record them now that the winner is in the table
insert into atlas.entity_alias_conflicts (type, alias, norm_alias, wanted_entity_id, holder_entity_id, source)
  select e.type, x.alias, atlas.norm_alias(x.alias), e.id, h.entity_id, x.source
  from atlas.entities e
  cross join lateral (select e.name as alias, 'active_name' as source
                      union all select a, 'active_alias' from unnest(e.aliases) a) x
  join atlas.entity_aliases h on h.type = e.type and h.norm_alias = atlas.norm_alias(x.alias)
  where e.status = 'active' and h.entity_id <> e.id
on conflict do nothing;

-- merged losers -> active winner (one statement; 65 rows on Nov 3)
with src as (
  select w.id as winner_id, w.type, m.alias
  from atlas.entity_alias_merge_source m
  join atlas.entities w on w.id = coalesce(m.winner_id, (select id from atlas.entities where slug = m.winner_slug))
  where w.status = 'active' and atlas.norm_alias(m.alias) is not null
), c as (
  insert into atlas.entity_alias_conflicts (type, alias, norm_alias, wanted_entity_id, holder_entity_id, source)
    select s.type, s.alias, atlas.norm_alias(s.alias), s.winner_id, h.entity_id, 'merged_loser'
    from src s join atlas.entity_aliases h on h.type = s.type and h.norm_alias = atlas.norm_alias(s.alias)
    where h.entity_id <> s.winner_id
  on conflict do nothing
  returning 1
)
insert into atlas.entity_aliases (entity_id, type, alias)
  select distinct on (s.type, atlas.norm_alias(s.alias)) s.winner_id, s.type, s.alias from src s
  order by s.type, atlas.norm_alias(s.alias), s.winner_id
on conflict do nothing;

-- report
select (select count(*) from atlas.entity_aliases) as alias_rows,
       (select count(*) from atlas.entity_aliases a join atlas.entity_alias_merge_source m
          on atlas.norm_alias(m.alias) = a.norm_alias
          and a.entity_id = coalesce(m.winner_id, (select id from atlas.entities where slug = m.winner_slug))) as merged_loser_rows,
       (select count(*) from atlas.entity_alias_conflicts where resolved_at is null) as open_conflicts,
       (select count(*) from atlas.entity_alias_merge_source m
          where not exists (select 1 from atlas.entities w where w.status = 'active'
                            and w.id = coalesce(m.winner_id, (select id from atlas.entities where slug = m.winner_slug)))) as merged_without_active_winner;
