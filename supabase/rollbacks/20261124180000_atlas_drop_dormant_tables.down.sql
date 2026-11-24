-- Rollback of 20261124180000 (#827): recreate atlas.entity_alias_merge_source and
-- public.manual_command_log exactly as they were on prod (columns, defaults, check and
-- primary-key constraints, FK to public.entities ON DELETE SET NULL, RLS on with no
-- policies, grants). Does not insert rows; those are in
-- /workspace/backups/827-drop-pre-20261124-174752/.
-- public.entities must still exist (the log table's foreign key points at it).
-- Idempotent: safe to rerun, and safe if the up never ran.
-- Recreated from a read-only catalog dump of prod on Nov 24, 2026.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
revoke all on atlas.entity_alias_merge_source from public, anon, authenticated;
grant select on atlas.entity_alias_merge_source to atlas_analyst;

create table if not exists public.manual_command_log (
  request_id   text primary key,
  command_hash text not null,
  actor        jsonb not null,
  entity_id    uuid references public.entities(id) on delete set null,
  applied_at   timestamptz not null default now()
);
alter table public.manual_command_log enable row level security;
revoke all on public.manual_command_log from public, anon, authenticated;
grant all on public.manual_command_log to service_role;

commit;
