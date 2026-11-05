-- squawk-ignore-file require-concurrent-index-creation, adding-foreign-key-constraint, disallowed-unique-constraint, adding-not-nullable-field, constraint-missing-not-valid, prefer-bigint-over-int
-- (smallint handoff_version per Backend Dev answer 2; integer em_attempts matches signals.attempts and signal_* returns)
-- #571 task 2: analyst -> entity-manager handoff on atlas.decisions, plus the tables the entity
-- manager writes. Answers: Backend Dev on #571 (issuecomment-6654717699).
--   decisions.handoff jsonb NOT NULL default '{}' (object) + handoff_version smallint default 1
--   decisions.em_status    null = legacy row (before #571); analyst writes 'pending' (every keep,
--                          entity null = growth) or 'none' (ignore/unclear); entity manager moves
--                          pending -> claimed -> story | parked | duplicate | new_entity | failed
--   decisions.em_*         claim queue (lease 5 min, 3 attempts), same shape as signals' queue
--   decisions.em_duplicate_of  -> entity_items(id), set only with em_status = 'duplicate'
--   atlas.em_claim / em_finish / em_fail  mirror signal_claim / signal_finish / signal_fail
--   entity_items.image_url text, https only
--   item_signals.role text default 'origin' (table already exists, 0 rows on prod Nov 5)
--   atlas.entity_context   parked context: one row per (entity, signal), reason + sentiment
--   analyst_worker: select on 8 more atlas.signals columns (SignalMetadata), insert on handoff cols
-- NOT dropped here (answer 7): decisions.entity_reviewed_at / entity_outcome, entity_items.angle.
-- signals is unchanged apart from grants.
-- Adds are nullable or constant-default (metadata-only on PG >= 11). Checks and FKs are added
-- NOT VALID, then VALIDATEd (prod decisions 4,438 rows, entity_items 8,835: milliseconds).
-- Plain index builds, same reasoning as 20261103210000 (#566): small tables, one transaction.
-- Data: supabase/backfills/571_em_handoff.sql (item_signals origin rows, image_url), not here.
-- Rerunnable. Rollback: supabase/rollbacks/20261105150000_atlas_em_handoff.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 1. Handoff + entity-manager queue on atlas.decisions --------------------------------------
alter table atlas.decisions
  add column if not exists handoff             jsonb not null default '{}'::jsonb,
  add column if not exists handoff_version     smallint not null default 1,
  add column if not exists em_status           text,
  add column if not exists em_duplicate_of     uuid,
  add column if not exists em_claim_token      uuid,
  add column if not exists em_claim_expires_at timestamptz,
  add column if not exists em_claimed_by       text,
  add column if not exists em_attempts         integer not null default 0,
  add column if not exists em_last_error       text,
  add column if not exists em_next_attempt_at  timestamptz not null default now(),
  add column if not exists em_done_at          timestamptz;

do $c$
declare r record;
begin
  for r in select * from (values
    ('decisions_handoff_object',      'check (jsonb_typeof(handoff) = ''object'')'),
    ('decisions_handoff_version_pos', 'check (handoff_version >= 1)'),
    ('decisions_em_status_check',     'check (em_status in (''pending'',''claimed'',''story'',''parked'',''duplicate'',''new_entity'',''none'',''failed''))'),
    ('decisions_em_needs_handoff',    'check (em_status is null or em_status = ''none'' or handoff <> ''{}''::jsonb)'),
    ('decisions_em_claim_pair',       'check ((em_claim_token is null) = (em_claim_expires_at is null))'),
    ('decisions_em_claimed_has_token','check ((em_status = ''claimed'') = (em_claim_token is not null))'),
    ('decisions_em_duplicate_of',     'check ((em_status = ''duplicate'') = (em_duplicate_of is not null))'),
    ('decisions_em_attempts_nonneg',  'check (em_attempts >= 0)'),
    ('decisions_em_duplicate_of_fkey','foreign key (em_duplicate_of) references atlas.entity_items (id)')
  ) v(name, def) loop
    if not exists (select 1 from pg_constraint where conname = r.name and conrelid = 'atlas.decisions'::regclass) then
      execute format('alter table atlas.decisions add constraint %I %s not valid', r.name, r.def);
    end if;
    execute format('alter table atlas.decisions validate constraint %I', r.name);
  end loop;
end $c$;

-- queue scan: pending rows, oldest first (answer 3)
create index if not exists decisions_em_pending_idx on atlas.decisions (created_at) where em_status = 'pending';
-- expired-lease scan
create index if not exists decisions_em_claimed_idx on atlas.decisions (em_claim_expires_at) where em_status = 'claimed';
-- FK lookup
create index if not exists decisions_em_duplicate_of_idx on atlas.decisions (em_duplicate_of) where em_duplicate_of is not null;

-- 2. entity_items.image_url ----------------------------------------------------------------
alter table atlas.entity_items add column if not exists image_url text;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'entity_items_image_url_https'
                 and conrelid = 'atlas.entity_items'::regclass) then
    alter table atlas.entity_items add constraint entity_items_image_url_https
      check (image_url ~ '^https://' and length(image_url) <= 2048) not valid;
  end if;
  alter table atlas.entity_items validate constraint entity_items_image_url_https;
end $c$;

-- 3. item_signals.role ---------------------------------------------------------------------
alter table atlas.item_signals add column if not exists role text not null default 'origin';
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'item_signals_role_check'
                 and conrelid = 'atlas.item_signals'::regclass) then
    alter table atlas.item_signals add constraint item_signals_role_check check (role in ('origin')) not valid;
  end if;
  alter table atlas.item_signals validate constraint item_signals_role_check;
end $c$;

-- 4. atlas.entity_context (parked context) -------------------------------------------------
create table if not exists atlas.entity_context (
  id          uuid primary key default atlas.uuidv7(),
  entity_id   uuid not null references atlas.entities (id),
  signal_id   text not null references atlas.signals (signal_id),
  decision_id uuid not null references atlas.decisions (id),
  reason      text not null check (length(reason) between 1 and 2000),
  sentiment   text,
  created_at  timestamptz not null default now(),
  constraint entity_context_entity_signal_key unique (entity_id, signal_id)
);
create index if not exists entity_context_entity_created_idx on atlas.entity_context (entity_id, created_at desc);
create index if not exists entity_context_signal_idx on atlas.entity_context (signal_id);
create index if not exists entity_context_decision_idx on atlas.entity_context (decision_id);
alter table atlas.entity_context enable row level security;
drop trigger if exists entity_context_history on atlas.entity_context;
create trigger entity_context_history after insert or update or delete on atlas.entity_context
  for each row execute function atlas.write_history('id');

-- 5. Queue functions (invoker rights, like signal_*; callers need the column grants below) --
-- Claim one pending row (or one whose lease expired). Expired leases at max attempts -> failed.
create or replace function atlas.em_claim(p_worker text, p_lease interval default interval '5 minutes',
                                          p_max_attempts integer default 3)
  returns table (decision_id uuid, signal_id text, claim_token uuid, attempts integer)
  language plpgsql
  set search_path = ''
as $f$
begin
  update atlas.decisions d
     set em_status = 'failed',
         em_last_error = 'claim expired after max attempts',
         em_claim_token = null, em_claim_expires_at = null, em_claimed_by = null,
         em_done_at = pg_catalog.now()
   where d.em_status = 'claimed'
     and d.em_claim_expires_at < pg_catalog.now()
     and d.em_attempts >= p_max_attempts;
  return query
    update atlas.decisions d
       set em_status = 'claimed',
           em_claim_token = atlas.uuidv7(),
           em_claim_expires_at = pg_catalog.now() + p_lease,
           em_claimed_by = p_worker,
           em_attempts = d.em_attempts + 1
     where d.id = (
             select c.id from atlas.decisions c
              where (c.em_status = 'pending' and c.em_next_attempt_at <= pg_catalog.now())
                 or (c.em_status = 'claimed' and c.em_claim_expires_at < pg_catalog.now())
              order by c.created_at, c.id
              for update skip locked
              limit 1)
    returning d.id, d.signal_id, d.em_claim_token, d.em_attempts;
end $f$;

-- Finish a live claim. Returns false when the claim was lost (expired or taken over).
create or replace function atlas.em_finish(p_decision_id uuid, p_token uuid, p_outcome text,
                                           p_duplicate_of uuid default null)
  returns boolean
  language plpgsql
  set search_path = ''
as $f$
declare v_n integer;
begin
  if p_outcome not in ('story', 'parked', 'duplicate', 'new_entity', 'failed') then
    raise exception 'invalid em outcome %', p_outcome;
  end if;
  if (p_outcome = 'duplicate') <> (p_duplicate_of is not null) then
    raise exception 'duplicate_of is required for, and only for, outcome duplicate';
  end if;
  update atlas.decisions d
     set em_status = p_outcome,
         em_duplicate_of = p_duplicate_of,
         em_claim_token = null, em_claim_expires_at = null, em_claimed_by = null,
         em_done_at = pg_catalog.now()
   where d.id = p_decision_id
     and d.em_status = 'claimed'
     and d.em_claim_token = p_token
     and d.em_claim_expires_at >= pg_catalog.now();
  get diagnostics v_n = row_count;
  return v_n = 1;
end $f$;

-- Fail a live claim: back to pending with exponential backoff, or failed at max attempts.
-- Returns 'retry' | 'failed' | 'lost_claim'.
create or replace function atlas.em_fail(p_decision_id uuid, p_token uuid, p_error text,
                                         p_backoff interval default interval '1 minute',
                                         p_max_attempts integer default 3)
  returns text
  language plpgsql
  set search_path = ''
as $f$
declare v_attempts integer;
begin
  select d.em_attempts into v_attempts from atlas.decisions d
   where d.id = p_decision_id and d.em_status = 'claimed'
     and d.em_claim_token = p_token and d.em_claim_expires_at >= pg_catalog.now()
   for update;
  if v_attempts is null then
    return 'lost_claim';
  end if;
  if v_attempts >= p_max_attempts then
    update atlas.decisions d
       set em_status = 'failed', em_last_error = p_error,
           em_claim_token = null, em_claim_expires_at = null, em_claimed_by = null,
           em_done_at = pg_catalog.now()
     where d.id = p_decision_id;
    return 'failed';
  end if;
  update atlas.decisions d
     set em_status = 'pending', em_last_error = p_error,
         em_next_attempt_at = pg_catalog.now() + p_backoff * pg_catalog.power(2, d.em_attempts - 1),
         em_claim_token = null, em_claim_expires_at = null, em_claimed_by = null
   where d.id = p_decision_id;
  return 'retry';
end $f$;

-- 6. Grants --------------------------------------------------------------------------------
revoke all on function atlas.em_claim(text, interval, integer) from public;
revoke all on function atlas.em_finish(uuid, uuid, text, uuid) from public;
revoke all on function atlas.em_fail(uuid, uuid, text, interval, integer) from public;
revoke all on atlas.entity_context from public;
grant execute on function atlas.em_claim(text, interval, integer) to entity_worker, service_role;
grant execute on function atlas.em_finish(uuid, uuid, text, uuid) to entity_worker, service_role;
grant execute on function atlas.em_fail(uuid, uuid, text, interval, integer) to entity_worker, service_role;

-- analyst: read the whole signal row (SignalMetadata), write the handoff with its decision
grant select (schema_version, type, priority, fetched_at, numbers, raw_ids, unusual_score, raw_hash)
  on atlas.signals to analyst_worker;
grant select (handoff, handoff_version, em_status) on atlas.decisions to analyst_worker;
grant insert (handoff, handoff_version, em_status) on atlas.decisions to analyst_worker;

-- entity manager: read the handoff, drive its queue columns (em_* functions run as the caller)
grant select (id, signal_id, created_at, decision, handoff, handoff_version, em_status, em_duplicate_of,
              em_claim_token, em_claim_expires_at, em_claimed_by, em_attempts, em_last_error,
              em_next_attempt_at, em_done_at)
  on atlas.decisions to entity_worker, service_role;
grant update (em_status, em_duplicate_of, em_claim_token, em_claim_expires_at, em_claimed_by,
              em_attempts, em_last_error, em_next_attempt_at, em_done_at)
  on atlas.decisions to entity_worker, service_role;
grant select (image_url) on atlas.entity_items to entity_worker, analyst_worker, service_role;
grant update (image_url) on atlas.entity_items to entity_worker;
grant select, insert on atlas.item_signals to entity_worker;
grant select on atlas.item_signals to service_role;
grant select, insert on atlas.entity_context to entity_worker;
grant select on atlas.entity_context to atlas_analyst, service_role;

drop policy if exists entity_worker_select on atlas.item_signals;
create policy entity_worker_select on atlas.item_signals for select to entity_worker using (true);
drop policy if exists entity_worker_insert on atlas.item_signals;
create policy entity_worker_insert on atlas.item_signals for insert to entity_worker with check (true);
drop policy if exists analyst_read on atlas.entity_context;
create policy analyst_read on atlas.entity_context for select to atlas_analyst using (true);
drop policy if exists entity_worker_select on atlas.entity_context;
create policy entity_worker_select on atlas.entity_context for select to entity_worker using (true);
drop policy if exists entity_worker_insert on atlas.entity_context;
create policy entity_worker_insert on atlas.entity_context for insert to entity_worker with check (true);

commit;
