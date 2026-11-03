-- squawk-ignore-file require-concurrent-index-creation, disallowed-unique-constraint, adding-foreign-key-constraint
-- #566: entity aliases table + type-first candidate lookup.
--   atlas.norm_alias(text)            the one normalizer (lowercase, punctuation -> space, collapse, trim)
--   entities unique (id, type)        target of the composite FK, so an alias's type follows its entity
--   atlas.entity_aliases              one row per (entity, alias); unique (type, norm_alias)
--   atlas.entity_alias_conflicts      review list: aliases the backfill/merge could not place
--   atlas.entity_alias_merge_source   staging for the backfill: names of merged losers (Nov 3 cleanup)
--   atlas.entity_candidates(type, names[])  candidate fetch, active entities only
--   atlas.move_entity_aliases(loser, winner) merge rule: loser's aliases move to the winner
--   index entities (type, status)
-- Index builds are plain, not CONCURRENTLY: prod entities has 1,162 rows (Nov 3) and the new tables
-- are empty, so each build locks for milliseconds, and CONCURRENTLY cannot run inside this
-- one-transaction file (same reasoning as 20261030210000, #503/#505). lock_timeout bounds the wait.
-- entities.aliases (text[]) is untouched; it is dropped in a later, separate migration.
-- Data goes in by supabase/backfills/566_entity_aliases.sql, not here.
-- Every step is rerunnable. Rollback: supabase/rollbacks/20261103210000_atlas_entity_aliases.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function atlas.norm_alias(p text) returns text
  language sql immutable strict parallel safe
  set search_path = pg_catalog
as $f$
  select nullif(btrim(regexp_replace(lower(p), '[^[:alnum:]]+', ' ', 'g')), '')
$f$;
comment on function atlas.norm_alias(text) is
  '#566: single alias normalizer. App code must call this (never re-implement it in TS).';

do $d$ begin
  if not exists (select 1 from pg_constraint where conname = 'entities_id_type_key'
                 and conrelid = 'atlas.entities'::regclass) then
    alter table atlas.entities add constraint entities_id_type_key unique (id, type);
  end if;
end $d$;

create index if not exists entities_type_status_idx on atlas.entities (type, status);

create table if not exists atlas.entity_aliases (
  id          uuid primary key default atlas.uuidv7(),
  entity_id   uuid not null,
  type        text not null,
  alias       text not null check (length(alias) <= 200),
  norm_alias  text generated always as (atlas.norm_alias(alias)) stored not null,
  created_at  timestamptz not null default now(),
  constraint entity_aliases_entity_fkey foreign key (entity_id, type)
    references atlas.entities (id, type) on update cascade on delete cascade,
  constraint entity_aliases_type_norm_key unique (type, norm_alias)
);
-- the unique index serves the candidate lookup: WHERE type = $1 AND norm_alias = ANY($2)
create index if not exists entity_aliases_entity_idx on atlas.entity_aliases (entity_id);
alter table atlas.entity_aliases enable row level security;

create table if not exists atlas.entity_alias_conflicts (
  id                 uuid primary key default atlas.uuidv7(),
  type               text not null,
  alias              text not null,
  norm_alias         text not null,
  wanted_entity_id   uuid not null,
  holder_entity_id   uuid not null,
  source             text not null check (source in ('active_name', 'active_alias', 'merged_loser', 'merge')),
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  resolution         text,
  constraint entity_alias_conflicts_key unique (type, norm_alias, wanted_entity_id)
);
alter table atlas.entity_alias_conflicts enable row level security;

create table if not exists atlas.entity_alias_merge_source (
  loser_id     uuid not null,
  loser_slug   text not null,
  alias        text not null,
  winner_id    uuid,
  winner_slug  text,
  batch        text not null,
  check (winner_id is not null or winner_slug is not null),
  primary key (loser_id, alias)
);
alter table atlas.entity_alias_merge_source enable row level security;

-- Candidate fetch for the matcher. Active entities only (CTO review on #566).
create or replace function atlas.entity_candidates(p_type text, p_names text[])
  returns table (entity_id uuid, slug text, name text, matched_alias text)
  language sql stable parallel safe
  set search_path = pg_catalog
as $f$
  select e.id, e.slug, e.name, a.alias
  from atlas.entity_aliases a
  join atlas.entities e on e.id = a.entity_id
  where a.type = p_type
    and a.norm_alias = any (array(select atlas.norm_alias(n) from unnest(p_names) n))
    and e.status = 'active'
$f$;

-- Merge rule: move the loser's aliases to the winner (winner's type). A clash with a third entity
-- goes to the review list. Returns the number of aliases moved. Caller merges items and retires.
create or replace function atlas.move_entity_aliases(p_loser uuid, p_winner uuid) returns integer
  language plpgsql
  set search_path = pg_catalog
as $f$
declare wtype text; n integer;
begin
  select type into wtype from atlas.entities where id = p_winner;
  if wtype is null then raise exception 'winner % not found', p_winner; end if;
  insert into atlas.entity_alias_conflicts (type, alias, norm_alias, wanted_entity_id, holder_entity_id, source)
    select wtype, l.alias, l.norm_alias, p_winner, h.entity_id, 'merge'
    from atlas.entity_aliases l
    join atlas.entity_aliases h on h.type = wtype and h.norm_alias = l.norm_alias
    where l.entity_id = p_loser and h.entity_id not in (p_loser, p_winner)
  on conflict do nothing;
  with moved as (delete from atlas.entity_aliases where entity_id = p_loser returning alias)
  insert into atlas.entity_aliases (entity_id, type, alias)
    select p_winner, wtype, m.alias from moved m
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end
$f$;

revoke all on function atlas.move_entity_aliases(uuid, uuid) from public;
revoke all on atlas.entity_aliases, atlas.entity_alias_conflicts, atlas.entity_alias_merge_source
  from public, anon, authenticated;

grant select on atlas.entity_aliases to atlas_analyst, analyst_worker, entity_worker, service_role;
grant insert (entity_id, type, alias), delete on atlas.entity_aliases to entity_worker;
grant select, insert on atlas.entity_alias_conflicts to entity_worker;
grant select on atlas.entity_alias_conflicts to service_role;
grant execute on function atlas.entity_candidates(text, text[]) to atlas_analyst, analyst_worker, entity_worker, service_role;
grant execute on function atlas.move_entity_aliases(uuid, uuid) to entity_worker;

drop policy if exists entity_aliases_read on atlas.entity_aliases;
create policy entity_aliases_read on atlas.entity_aliases for select
  to atlas_analyst, analyst_worker, entity_worker, service_role using (true);
drop policy if exists entity_worker_insert on atlas.entity_aliases;
create policy entity_worker_insert on atlas.entity_aliases for insert to entity_worker with check (true);
drop policy if exists entity_worker_delete on atlas.entity_aliases;
create policy entity_worker_delete on atlas.entity_aliases for delete to entity_worker using (true);
drop policy if exists entity_alias_conflicts_read on atlas.entity_alias_conflicts;
create policy entity_alias_conflicts_read on atlas.entity_alias_conflicts for select
  to entity_worker, service_role using (true);
drop policy if exists entity_worker_insert on atlas.entity_alias_conflicts;
create policy entity_worker_insert on atlas.entity_alias_conflicts for insert to entity_worker with check (true);

commit;
