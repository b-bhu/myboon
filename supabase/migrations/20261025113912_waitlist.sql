-- #432: waitlist sign-ups. Service-role only (RLS on, no policies, anon/authenticated revoked).
-- New empty table: a plain (non-concurrent) index is safe and keeps the migration transactional.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  x_handle text null,
  source text null,
  created_at timestamptz not null default now(),
  constraint waitlist_x_handle_format
    check (x_handle is null or x_handle ~ '^[A-Za-z0-9_]{1,15}$')
);

create unique index if not exists waitlist_email_lower_key on public.waitlist (lower(email));

alter table public.waitlist enable row level security;

revoke all on table public.waitlist from anon, authenticated;

commit;
