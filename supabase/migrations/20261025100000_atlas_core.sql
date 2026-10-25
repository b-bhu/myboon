-- squawk-ignore-file require-concurrent-index-creation, prefer-robust-stmts
-- Why: every index here is on a table created in this same migration (empty, no readers),
-- and CONCURRENTLY cannot run inside the migration transaction. The file runs as one
-- transaction, so a failure rolls back fully; IF NOT EXISTS would only hide drift.
-- #441 V4 Atlas, part 1: schema, uuidv7, read-only role, core tables, append-only history.
-- Creates only the new `atlas` schema. No existing table is touched.
-- Rollback: 20261025100000_atlas_core.down.sql
set lock_timeout = '5s';
set statement_timeout = '60s';

create schema atlas;
comment on schema atlas is 'V4 Atlas (#441). Field names frozen in #440 (Oct 25).';
revoke all on schema atlas from public;

-- UUIDv7 stopgap for PG17. On PG18 replace the body with: select pg_catalog.uuidv7()
create function atlas.uuidv7() returns uuid
language sql volatile parallel safe set search_path = '' as $$
  select encode(set_bit(set_bit(overlay(pg_catalog.uuid_send(pg_catalog.gen_random_uuid()) placing substring(pg_catalog.int8send((extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint) from 3) from 1 for 6), 52, 1), 53, 1), 'hex')::uuid
$$;

-- Read-only analyst role. NOLOGIN: Bucket creates the login and the GitHub secret himself.
do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'atlas_analyst') then
    create role atlas_analyst nologin;
  end if;
end $$;
grant usage on schema atlas to atlas_analyst;
alter default privileges in schema atlas grant select on tables to atlas_analyst;
alter default privileges in schema atlas revoke execute on functions from public;

-- Shelves (entities). 9 types from the cleanup.
create table atlas.shelves (
  id               uuid primary key default atlas.uuidv7(),
  slug             text not null unique,
  name             text not null,
  type             text not null check (type in ('organization','asset','protocol','person','topic','place','event','product','regulation')),
  aliases          text[] not null default '{}',
  summary          text,
  card             jsonb,
  status           text not null default 'active' check (status in ('active','retired')),
  legacy_entity_id uuid unique,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Signals (scout -> analyst). Link, excerpt and hash only, never full raw bytes.
create table atlas.signals (
  signal_id      text primary key,
  schema_version bigint not null,
  source         text not null,
  source_id      text not null,
  type           text not null check (type in ('post','price_move','onchain_event','news')),
  priority       bigint not null default 0,
  occurred_at    timestamptz,
  fetched_at     timestamptz not null default now(),
  text           text,
  numbers        jsonb not null default '{}',
  link           text,
  raw_ids        jsonb not null default '{}',
  unusual_score  double precision,
  excerpt        text check (char_length(excerpt) <= 500),
  raw_hash       text check (raw_hash ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz not null default now(),
  constraint signals_source_source_id_key unique (source, source_id)
);

-- Items: one main shelf (the cause) as a NOT NULL column; "also affects" in item_shelves.
create table atlas.items (
  id             uuid primary key default atlas.uuidv7(),
  item_key       text not null unique,
  title          text not null,
  summary        text,
  main_shelf_id  uuid not null references atlas.shelves (id),
  occurred_at    timestamptz,
  status         text not null default 'active' check (status in ('active','merged')),
  merged_into_id uuid references atlas.items (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint items_merged_into_not_self check (merged_into_id is distinct from id),
  constraint items_merge_tombstone check ((status = 'merged') = (merged_into_id is not null))
);
create index items_main_shelf_id_idx on atlas.items (main_shelf_id);
create index items_merged_into_id_idx on atlas.items (merged_into_id) where merged_into_id is not null;

create table atlas.item_shelves (
  item_id    uuid not null references atlas.items (id) on delete cascade,
  shelf_id   uuid not null references atlas.shelves (id),
  role       text not null default 'also_affects' check (role = 'also_affects'),
  created_at timestamptz not null default now(),
  primary key (item_id, shelf_id, role)
);
create index item_shelves_shelf_id_idx on atlas.item_shelves (shelf_id);

-- Decisions (analyst -> entity manager).
create table atlas.decisions (
  id              uuid primary key default atlas.uuidv7(),
  schema_version  bigint not null,
  signal_id       text not null references atlas.signals (signal_id),
  analyst_version text not null,
  decision_type   text not null default 'file' check (decision_type in ('file','merge')),
  action          text not null check (action in ('keep','skip')),
  reason          text,
  confidence      double precision check (confidence between 0 and 1),
  shelves         jsonb not null default '[]',
  target_item_id  uuid references atlas.items (id),
  item_key        text,
  merged_into_id  uuid references atlas.items (id),
  created_at      timestamptz not null default now(),
  constraint decisions_signal_id_analyst_version_key unique (signal_id, analyst_version),
  constraint decisions_merge_has_target check (decision_type <> 'merge' or merged_into_id is not null)
);
create index decisions_target_item_id_idx on atlas.decisions (target_item_id) where target_item_id is not null;
create index decisions_merged_into_id_idx on atlas.decisions (merged_into_id) where merged_into_id is not null;

create table atlas.item_signals (
  item_id    uuid not null references atlas.items (id) on delete cascade,
  signal_id  text not null references atlas.signals (signal_id),
  created_at timestamptz not null default now(),
  primary key (item_id, signal_id)
);
create index item_signals_signal_id_idx on atlas.item_signals (signal_id);

create table atlas.stories (
  id         uuid primary key default atlas.uuidv7(),
  slug       text not null unique,
  title      text not null,
  summary    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table atlas.story_items (
  story_id   uuid not null references atlas.stories (id) on delete cascade,
  item_id    uuid not null references atlas.items (id),
  position   bigint,
  created_at timestamptz not null default now(),
  primary key (story_id, item_id)
);
create index story_items_item_id_idx on atlas.story_items (item_id);

-- Append-only history: changed fields only, written by trigger in the same transaction.
create table atlas.history (
  id         bigint generated always as identity primary key,
  table_name text not null,
  row_pk     jsonb not null,
  op         text not null check (op in ('INSERT','UPDATE','DELETE')),
  changed    jsonb not null,
  actor      text not null default current_user,
  reason     text,
  at         timestamptz not null default now()
);
create index history_table_row_idx on atlas.history (table_name, row_pk);

create function atlas.history_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'atlas.history is append-only (% blocked)', tg_op using errcode = '42501';
end $$;
create trigger history_append_only before update or delete on atlas.history
  for each row execute function atlas.history_guard();
create trigger history_no_truncate before truncate on atlas.history
  for each statement execute function atlas.history_guard();

create function atlas.write_history() returns trigger
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
    if v_changed = '{}' then return null; end if;
  else
    v_changed := coalesce(v_new, v_old);
  end if;
  insert into atlas.history (table_name, row_pk, op, changed, reason)
  values (tg_table_name, v_pk, tg_op, v_changed, nullif(pg_catalog.current_setting('atlas.reason', true), ''));
  return null;
end $$;
revoke all on function atlas.write_history() from public;

create trigger shelves_history after insert or update or delete on atlas.shelves
  for each row execute function atlas.write_history('id');
create trigger items_history after insert or update or delete on atlas.items
  for each row execute function atlas.write_history('id');
create trigger item_shelves_history after insert or update or delete on atlas.item_shelves
  for each row execute function atlas.write_history('item_id', 'shelf_id', 'role');
create trigger item_signals_history after insert or update or delete on atlas.item_signals
  for each row execute function atlas.write_history('item_id', 'signal_id');
create trigger stories_history after insert or update or delete on atlas.stories
  for each row execute function atlas.write_history('id');
create trigger story_items_history after insert or update or delete on atlas.story_items
  for each row execute function atlas.write_history('story_id', 'item_id');
create trigger decisions_history after insert or update or delete on atlas.decisions
  for each row execute function atlas.write_history('id');

create function atlas.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := pg_catalog.now(); return new; end $$;
create trigger shelves_touch before update on atlas.shelves for each row execute function atlas.touch_updated_at();
create trigger items_touch before update on atlas.items for each row execute function atlas.touch_updated_at();
create trigger stories_touch before update on atlas.stories for each row execute function atlas.touch_updated_at();

-- RLS on, no policies for anon/authenticated; analyst gets read-only policies.
do $$
declare t text;
begin
  foreach t in array array['shelves','signals','items','item_shelves','decisions','item_signals','stories','story_items','history'] loop
    execute format('alter table atlas.%I enable row level security', t);
    execute format('create policy analyst_read on atlas.%I for select to atlas_analyst using (true)', t);
  end loop;
end $$;

revoke update, delete, truncate on atlas.history from public;
-- Supabase API roles get nothing in atlas (the schema is not exposed; this is belt and braces).
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema atlas from %I', r);
      execute format('revoke all on all functions in schema atlas from %I', r);
      execute format('revoke all on schema atlas from %I', r);
    end if;
  end loop;
end $$;
grant select on all tables in schema atlas to atlas_analyst;
grant execute on function atlas.uuidv7() to atlas_analyst;
