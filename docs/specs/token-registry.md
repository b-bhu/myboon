# Spec: Shared TokenRegistry (Phase 1) — Refs #318

## Problem
Token identity (mint, symbol, name, decimals, icon, verified) is stored three times: in Meteora pool payloads, in the server seed/Jupiter cache, and in a 10-minute in-memory store on the phone. Server caches are per-process `Map`s with no size limit (`packages/api/src/tokens/jupiter-tokens.ts:60`, `icon-proxy.ts:50`) and are lost on restart. No durable token table exists, so a restart re-queries the free Jupiter tier (`jupiter-tokens.ts:24-27`). The phone uses `cache: 'no-store'` (`apps/hybrid-expo/lib/token-identity.ts:78`) and falls back to Meteora's third-party icon URLs (`features/meteora/meteora.rows.ts:40-48`).

## Goal
One server-side `TokenRegistry` in `packages/api` is the single source of truth for token identity, including `verified`. It is durable across restarts, bounded in memory, and cheap to serve to clients over HTTP caching.

## Design

### 1. Supabase `token_registry` table (proposal only, NOT applied)
Planned file: `supabase/migrations/<ts>_token_registry.sql`. It ships in implementation PR 1 and is applied only after Bucket says yes on #318.
```sql
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
```
Writes are upserts guarded by `where excluded.upstream_seen_at > token_registry.upstream_seen_at or token_registry.<field> is null`, so older upstream data never overwrites a newer row.

### 2. Bounded in-memory LRU
- Replaces `mintCache` (`jupiter-tokens.ts:60`). Found TTL 7d, miss TTL 10min, max about 50k entries.
- All limits are config values in `packages/api/src/bootstrap/config.ts`, not constants: `TOKEN_REGISTRY_LRU_MAX`, `TOKEN_REGISTRY_FOUND_TTL_MS`, `TOKEN_REGISTRY_MISS_TTL_MS`, `TOKEN_REGISTRY_STALE_AFTER_MS`.
- The icon byte cache (`icon-proxy.ts:50`) moves to its own bounded LRU (by entry count and total bytes). Its current TTLs stay.

### 3. Lookup order
LRU → `token_registry` (batched `in (...)` select) → seed (`seed/token-identities.seed.json`) → upstream (Jupiter `tokens/v2/search`; Meteora data only via ingest). In-flight dedupe is kept per mint (`jupiter-tokens.ts:62`). Upstream results are written back to both the DB and the LRU. Misses are cached only in the LRU, never in the DB.

### 4. Stale-while-revalidate
A row older than `TOKEN_REGISTRY_STALE_AFTER_MS` (default 24h) is returned immediately, and one deduped background refresh is queued. Refresh failures keep the old row and log a counter. They are never surfaced to the client.

### 5. Meteora ingest (write-through)
Whenever the server sees Meteora pool data (`token_x`/`token_y`, `packages/shared/src/meteora/data-api.ts:59`, `:176-179`, `:203-210`), it upserts fill-gap or refresh-stale rows using the guard in §1. Meteora's `verified` is recorded in `sources.meteora_verified`. It does not set `verified` unless no higher-priority source exists. Priority: seed > existing registry decision > Jupiter > Meteora. In Phase 1 ingest only runs where the API already touches Meteora data, because the server pools proxy is Phase 2.

### 6. Cacheable endpoints (response shape versioned `v: 1`)
- `GET /tokens/resolve?refs=` (≤100 refs, `routes.ts:20`): sorted, normalized refs give a stable URL. Response has `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` and an ETag/304. Responses with misses get `max-age=60`.
- `POST /tokens/resolve` (≤500 refs, `routes.ts:21`): unchanged batch path, `no-store`.
- `GET /tokens/catalog`: already `max-age` 3d plus ETag (`routes.ts:24`, `:189-209`). It gains `v: 1`.
- `GET /tokens/icon/*`: unchanged headers (`routes.ts:235-270`). It is the only icon path clients use.
- Every JSON body carries `"v": 1`, so Phase 2 can change the shape without breaking older builds.

### 7. Client token store — coordinate with Frontend Dev
- Shared types (`TokenIdentityV1`, `TokenResolveResponseV1`) land first in `packages/shared` as their own small PR. The frontend issue links that PR as a dependency.
- Phone: a persistent store (MMKV or AsyncStorage, hours to days TTL) replaces the 10min/30s in-memory TTLs (`lib/token-identity.store.ts:3-4`). Drop `no-store` (`lib/token-identity.ts:78`). Keep warming the catalog at start (already called in `app/_layout.tsx:21`). Load icons only via `/tokens/icon/*` and never use Meteora `iconUrl`.
- Frontend Dev owns this part and its EAS checklist.

## Out of scope
- **Phase 2: the server Meteora pools proxy (`GET /meteora/pools`) is explicitly out of scope.** It starts only after Phase 1 is merged and baselined.
- Redis or multi-instance caching (the API runs as a single PM2 process).
- Changing the Jupiter tier or adding paid upstreams.

## Done-when
- [ ] The migration PR is reviewed and applied only after Bucket's explicit yes on #318.
- [ ] After a `myboon-api` restart, the first 100 previously-seen mints resolve from the DB with 0 upstream Jupiter calls.
- [ ] LRU and icon cache never exceed their configured limits (unit test).
- [ ] Ingest never overwrites a row with an older `upstream_seen_at` (unit test).
- [ ] `GET /tokens/resolve` returns the ETag/304 and `Cache-Control` above, and the body carries `v: 1`.
- [ ] The phone loads zero icons from third-party hosts on the Meteora home screen.
- [ ] Home screen server p95 for `/tokens/resolve` and `/tokens/icon/*` is no worse than the baseline below.

## Test plan
- Unit (`pnpm --filter @myboon/api test:internal`): LRU eviction and TTL, the lookup order with mocked DB and upstream, SWR returning stale data and refreshing once, the ingest upsert guard, and the `verified` priority.
- Route tests: extend `packages/api/src/tokens/routes.test.ts` for headers, ETag/304, `v: 1`, and the flag-off case (`routes-flag-off.test.ts`).
- Runtime (read-only, after deploy approval): re-run the baseline method below and count upstream Jupiter calls per hour through a new counter log line.

## Baseline (captured 2026-10-14, read-only, no restart)
| Metric | Value | Method |
|---|---|---|
| Requests per home-screen load | 1 Meteora `listPools` (page size 30) + 1 `/tokens/resolve` + up to 60 `/tokens/icon/*` | Code read: `MeteoraPoolsScreen.tsx:28,84-93`, `TokenIcon.tsx:110-133` |
| Meteora `/pools` (30) from VPS | p50 318ms, p95 474ms | 20 curl samples |
| `/tokens/resolve` prod | p50 0ms, p95 142ms | PM2 access log since 2026-09-29, n=57 |
| `/tokens/icon/*` prod | p50 6ms, p95 578ms | access log, n=209 |
| `/tokens/catalog` prod | p50 1ms, p95 54ms | access log, n=28 |
| Jupiter calls after restart | **still to capture at the next natural restart** | Last natural restart 2026-10-08 16:56 IST (PM2 `pm_uptime`, 2 restarts total, 0 unstable). The out/error logs around it have no Jupiter traces: `jupiter-tokens.ts` doesn't log upstream calls and the error log has 0 Jupiter or lite-api lines. PR 1 adds an upstream-call counter log so this can be counted next time. |

## Owners
- [x] Backend (registry, table, endpoints, icon cache)
- [x] Frontend (client store, shared types consumer)
- [ ] System

## Risk
- Touches money: [ ] Yes [x] No
- Touches wallet: [ ] Yes [x] No
- Touches DB or migrations: [x] Yes [ ] No → `needs-bucket`
