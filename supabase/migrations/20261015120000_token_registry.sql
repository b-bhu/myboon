-- Not applied. Apply only after Bucket's explicit yes on #318.
create table public.token_registry (
  mint            text primary key,              -- base58 Solana mint
  symbol          text,
  name            text,
  decimals        smallint check (decimals between 0 and 30),
  icon_source_url text,                          -- upstream URL, server-only; clients use /tokens/icon/*
  verified        boolean not null default false, -- registry decides; Meteora flag is only an input
  sources         jsonb not null default '{}'::jsonb, -- per-field provenance, e.g. {"verified":"seed","symbol":"jupiter"}
  upstream_seen_at timestamptz,                  -- when upstream data was observed
  updated_at      timestamptz not null default now()
);
create index token_registry_updated_at_idx on public.token_registry (updated_at);
alter table public.token_registry enable row level security;
-- No anon/authenticated policies: only the API (service role) reads and writes.

-- Rank of a provenance source for `verified`; higher wins. Unknown/absent = 0.
create or replace function public.token_source_rank(src text) returns int language sql immutable as $$
  select case src when 'seed' then 3 when 'jupiter' then 2 when 'meteora' then 1 else 0 end
$$;

