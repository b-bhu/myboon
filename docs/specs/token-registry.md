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
Writes are **field-level merges**, not whole-row overwrites. An incoming field replaces the stored one only if the incoming data is newer or the stored value is null. An incoming null never clears a stored value. `upstream_seen_at` only moves forward:
```sql
-- Rank of a provenance source for `verified`; higher wins. Unknown/absent = 0.
create or replace function public.token_source_rank(src text) returns int language sql immutable as $$
  select case src when 'seed' then 3 when 'jupiter' then 2 when 'meteora' then 1 else 0 end
$$;

insert into public.token_registry as t (mint, symbol, name, decimals, icon_source_url, verified, sources, upstream_seen_at)
values ($1, $2, $3, $4, $5, $6, $7, $8)   -- $7 carries provenance only for the fields this write supplies
on conflict (mint) do update set
  symbol          = case when excluded.symbol is not null and (t.symbol is null or t.upstream_seen_at is null or excluded.upstream_seen_at > t.upstream_seen_at) then excluded.symbol else t.symbol end,
  name            = case when excluded.name is not null and (t.name is null or t.upstream_seen_at is null or excluded.upstream_seen_at > t.upstream_seen_at) then excluded.name else t.name end,
  decimals        = case when excluded.decimals is not null and (t.decimals is null or t.upstream_seen_at is null or excluded.upstream_seen_at > t.upstream_seen_at) then excluded.decimals else t.decimals end,
  icon_source_url = case when excluded.icon_source_url is not null and (t.icon_source_url is null or t.upstream_seen_at is null or excluded.upstream_seen_at > t.upstream_seen_at) then excluded.icon_source_url else t.icon_source_url end,
  -- verified is decided by source priority (seed > jupiter > meteora), NOT freshness; ties go to the incoming value
  verified        = case when public.token_source_rank(excluded.sources->>'verified') >= public.token_source_rank(t.sources->>'verified') then excluded.verified else t.verified end,
  -- provenance follows the value: a field's source is replaced only when that field's value was taken from this write
  sources         = t.sources || (
                      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(excluded.sources) e(k, v)
                      where case k
                        when 'symbol' then excluded.symbol is not null and (t.symbol is null or t.upstream_seen_at is null or excluded.upstream_seen_at > t.upstream_seen_at)
                        when 'name' then excluded.name is not null and (t.name is null or t.upstream_seen_at is null or excluded.upstream_seen_at > t.upstream_seen_at)
                        when 'decimals' then excluded.decimals is not null and (t.decimals is null or t.upstream_seen_at is null or excluded.upstream_seen_at > t.upstream_seen_at)
                        when 'icon_source_url' then excluded.icon_source_url is not null and (t.icon_source_url is null or t.upstream_seen_at is null or excluded.upstream_seen_at > t.upstream_seen_at)
                        when 'verified' then public.token_source_rank(excluded.sources->>'verified') >= public.token_source_rank(t.sources->>'verified')
                        else true end),
  upstream_seen_at = greatest(t.upstream_seen_at, excluded.upstream_seen_at),  -- greatest() ignores NULLs
  updated_at      = now();
```

### 2. Bounded in-memory LRU
- Replaces `mintCache` (`jupiter-tokens.ts:60`). Found TTL 7d, miss TTL 10min, max about 50k entries.
- All limits are config values in `packages/api/src/bootstrap/config.ts`, not constants: `TOKEN_REGISTRY_LRU_MAX`, `TOKEN_REGISTRY_FOUND_TTL_MS`, `TOKEN_REGISTRY_MISS_TTL_MS`, `TOKEN_REGISTRY_STALE_AFTER_MS`.
- The icon byte cache (`icon-proxy.ts:50`) moves to its own bounded LRU. Defaults, all config values:
  - `TOKEN_ICON_CACHE_MAX_ENTRIES=2000`: about 30x the 60 icons a home-screen load needs, and well above the 209 icon requests seen in 15 days of logs.
  - `TOKEN_ICON_CACHE_MAX_BYTES=64MB`: token icons are typically 5–30KB, so 2000 × 32KB ≈ 64MB, a safe ceiling for a single PM2 process.
  - `TOKEN_ICON_MAX_ITEM_BYTES=256KB`: anything larger is served without being cached.
  - TTLs stay as they are today: 7d found, 1h missing, 1min error (`icon-proxy.ts:24-35`).
  - Eviction is least recently used, applied when either limit is exceeded.

### 2a. Jupiter free-tier protection
One shared upstream limiter is used by foreground lookups and stale-while-revalidate background refreshes alike. All of its settings are config values:
- **Concurrency:** `TOKEN_UPSTREAM_MAX_CONCURRENCY=2` in-flight Jupiter requests.
- **Rate:** a token bucket, `TOKEN_UPSTREAM_RPM=30` requests per minute. Each request carries at most 10 mints (`jupiter-tokens.ts:29`).
- **Backoff:** on a 429 or 5xx, exponential backoff with full jitter (base 1s, max 60s). After 3 consecutive failures, a circuit break opens for a `TOKEN_UPSTREAM_COOLDOWN_MS=300000` (5min) cooldown, and Jupiter is not called until it ends. A `Retry-After` header is honored when present.
- **Fallback when limited or circuit-open:** serve from the LRU, DB, seed and cached misses only. Unresolved refs come back as misses with a short TTL. Background refreshes are dropped, not queued without limit.
- **Cold batch:** a cold `POST /tokens/resolve` with 500 unknown refs never fans out without limit. Each request may send at most `TOKEN_UPSTREAM_MAX_PER_REQUEST=50` **tokens (mints)** upstream. `jupiter-tokens.ts` already batches 10 mints into one comma-separated search call (`MINTS_PER_REQUEST = 10`, `:29-30`), so that is at most **5 Jupiter HTTP calls**. Today those batches all run at once through `Promise.all` (`warmJupiterTokens`, `:166-180`) with no concurrency cap; in this design they go through the shared limiter instead (2 at a time). Each request waits at most `TOKEN_UPSTREAM_REQUEST_BUDGET_MS=2000`. The response is a partial result (see the contract in section 6). Leftover refs are queued for background fill under the same limiter, and that queue is capped at `TOKEN_UPSTREAM_QUEUE_MAX=1000`.
- **Counter:** every upstream call increments `token_upstream_calls_total{source,status}`, logged as a one-line summary each minute. This gives the baseline for the acceptance target.

### 3. Lookup order
LRU → `token_registry` (batched `in (...)` select) → seed (`seed/token-identities.seed.json`) → upstream (Jupiter `tokens/v2/search`; Meteora data only via ingest). In-flight dedupe is kept per mint (`jupiter-tokens.ts:62`). Upstream results are written back to both the DB and the LRU. Misses are cached only in the LRU, never in the DB.

### 4. Stale-while-revalidate
A row older than `TOKEN_REGISTRY_STALE_AFTER_MS` (default 24h) is returned immediately, and one deduped background refresh is queued. Refresh failures keep the old row and log a counter. They are never surfaced to the client.

### 5. Meteora ingest (write-through)
Whenever the server sees Meteora pool data (`token_x`/`token_y`, `packages/shared/src/meteora/data-api.ts:59`, `:176-179`, `:203-210`), it upserts fill-gap or refresh-stale rows using the guard in §1. Meteora's `verified` is recorded in `sources.meteora_verified`. It does not set `verified` unless no higher-priority source exists. Priority: seed > Jupiter > Meteora, decided by source rank, never by freshness (see `token_source_rank` in §1). In Phase 1 ingest only runs where the API already touches Meteora data, because the server pools proxy is Phase 2.

### 6. Cacheable endpoints (response shape versioned `v: 1`)
- `GET /tokens/resolve?refs=` (≤100 refs, `routes.ts:20`): sorted, normalized refs give a stable URL. Response has `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` and an ETag/304. Responses with misses get `max-age=60`.
- **Partial-result contract** (only `GET /tokens/resolve` and `POST /tokens/resolve` can return it; `/tokens/catalog` and the icon routes never do): `{ v: 1, identities: [...], partial: boolean, unresolved: string[] }`. `partial` is `true` when refs were skipped because of the per-request limit, the time budget or the rate limiter, and `unresolved` lists exactly those refs. Refs confirmed as misses are not partial; they come back as misses, as today. Both fields are always present (`false` and `[]` when complete), and older clients ignore them.
- **Caching a partial result:** a partial `GET` gets `Cache-Control: public, max-age=60` with no `stale-while-revalidate`, the same as misses. I chose 60s over `no-store` because a burst of identical cold requests (many phones opening the home screen at once) then collapses into one upstream fill instead of re-hitting the limiter every time. Meanwhile the background queue fills the rest, so the next fetch after 60s is complete. `POST` stays `no-store`.
- `POST /tokens/resolve` (≤500 refs, `routes.ts:21`): unchanged batch path, `no-store`.
- `GET /tokens/catalog`: already `max-age` 3d plus ETag (`routes.ts:24`, `:189-209`). It gains `v: 1`.
- `GET /tokens/icon/*`: unchanged headers (`routes.ts:235-270`). It is the only icon path clients use.
- Every JSON body carries `"v": 1`, so Phase 2 can change the shape without breaking older builds.

### 7. Client token store — coordinate with Frontend Dev
- Shared types (`TokenIdentityV1`, plus `TokenResolveResponseV1 = { v: 1; identities: TokenIdentityV1[]; partial: boolean; unresolved: string[] }`) land first in `packages/shared` as their own small PR. The frontend issue links that PR as a dependency.
- **Storage and TTL:** the store uses **AsyncStorage**, with a **7-day TTL for found tokens and 10 minutes for misses**. Stale entries are revalidated against the cacheable `GET /tokens/resolve`. Refs listed in `unresolved` are not stored as misses; they are retried on the next fetch.
- Phone behaviour: drop `no-store` (`lib/token-identity.ts:78`), keep warming the catalog at start (`app/_layout.tsx:21`), and load icons only via `/tokens/icon/*`.
- **Why AsyncStorage:** `apps/hybrid-expo` already depends on `@react-native-async-storage/async-storage` 2.2.0 (`package.json:41`) and uses it in several places (for example `hooks/useOddsFormat.ts`). MMKV is not a dependency, and adding it would mean a new native module and a new EAS build. **This is a PR3 decision to confirm with Frontend Dev.**
- Frontend Dev owns this part and its EAS checklist.

### 8. Rollout and rollback
- **Flag:** `TOKEN_REGISTRY_ENABLED`, default **off**, separate from `TOKEN_IDENTITY_ENABLED` (which stays as the master switch for token identity). With the flag off, today's Map and Jupiter path runs unchanged. With it on, the TokenRegistry path runs (LRU, DB, seed, upstream).
- **Migration:** the PR1 migration includes a down-migration (`drop table if exists public.token_registry;`). Merging PR1 does not apply it. It is applied only after Bucket says yes on #318.
- **Rollback:** set `TOKEN_REGISTRY_ENABLED` to off and restart `myboon-api` (with approval). That returns the API to the current behavior right away. Drop the table only if needed, using the down-migration, again with Bucket's yes.
- **Compatibility:** the response shape stays a superset of today's. Older app builds keep working against `v: 1` (new fields like `partial` are additive), and no field is removed in Phase 1.

### 9. PR plan
| PR | Contents | Flag / client impact |
|---|---|---|
| PR0 | Shared types in `packages/shared` (`TokenIdentityV1`, `TokenResolveResponseV1` including `partial` and `unresolved`) | No runtime change |
| PR1 | Migration (up and down) + `TokenRegistry` + bounded LRU + upstream limiter + Jupiter call counter | Flag off, no client change. **Merging PR1 does not apply the migration** (Bucket's yes is needed) |
| PR2 | Meteora write-through + cacheable `GET /tokens/resolve` + bounded icon LRU | Behind the flag. Turned on only after the migration is applied and approved |
| PR3 | Client persistent store, drop `no-store`, icons only through the proxy (Frontend Dev) | Needs an EAS build; follows PR0. **Decision with Frontend Dev:** storage (AsyncStorage recommended over MMKV) |

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
- [ ] With the flag on, upstream Jupiter calls per hour (from the new counter) are **at least 90% lower** than the first measured window with the flag off.
- [ ] Post-restart upstream calls (counted at the next natural restart) are recorded, and with the flag on the first 100 known mints after a restart cause 0 calls.
- [ ] Icon LRU never exceeds 2000 entries or 64MB (unit test).
- [ ] A cold 500-ref POST sends at most 50 mints upstream (at most 5 Jupiter HTTP calls), returns within about 2s with `partial: true`, and never exceeds 2 concurrent upstream requests (unit test).
- [ ] Route test: a partial `GET /tokens/resolve` returns `partial: true`, the exact `unresolved` refs and `Cache-Control: public, max-age=60` (no SWR). A complete response returns `partial: false`, `unresolved: []` and the long-lived headers. `POST` stays `no-store`.
- [ ] Unit test for the field-level merge: older data never overwrites newer fields; a stored null is filled; an incoming null never clears a stored value; `upstream_seen_at` never moves backward (including a stored NULL, and an incoming NULL); `sources` are merged.
- [ ] When Jupiter returns 429 or 5xx, the circuit opens and responses fall back to seed and cached misses (unit test).
- [ ] With the flag off, behavior is identical to today (existing route tests pass unchanged).
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
