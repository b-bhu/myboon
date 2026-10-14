# Spec: #310 Helius backend service

Status: draft, waiting for Bucket's approval. Issue: #310. Related: #318 (token registry), #236 (spot proxy), #291 (holder reads).
Code snapshot: `main` @ `93a82a2c`. Read map from Backend Dev's findings on #310 (`main` @ `3a2f58a`), checked again against the files below.

## Problem
Solana reads are spread across the phone and the server, and each one has its own caching (or none):
- **Wallet totals are assembled on the phone.** `apps/hybrid-expo/features/wallet/wallet.sources.ts` calls four sources per wallet (`fetchSpotValueUsd` via `/spot`, `fetchMeteoraValueUsd` via the Meteora data API, `fetchPhoenixValueUsd`, `fetchPacificaValueUsd`), driven by `useProtocolAccounts.ts`. Every phone does this work again, and the server never holds the total, which the PnL card needs.
- **Helius is called ad hoc.** `packages/api/src/spot.ts` has its own `heliusRpc` helper, reads `HELIUS_RPC_URL`, and keeps a per-process `Map` cache with a fixed `BALANCES_CACHE_TTL_MS = 15_000`. `packages/tx-parser/src/rpc.ts` calls Helius separately. There is no shared client, batching, retry or backoff.
- **Raw RPC has no cache.** `packages/api/src/rpc/routes.ts`, `websocket.ts` and `policy.ts` proxy JSON-RPC with a read allowlist and a batch limit of 50 (`policy.ts`), but nothing is cached.
- **Fallback is silent.** `packages/api/src/phoenix.ts` falls back from `PHOENIX_RPC_URL` to `SOLANA_RPC_URL` to public `https://api.mainnet-beta.solana.com` with no signal that it happened.
- Meteora DLMM position reads run on the phone through the generic proxy (`features/meteora/meteora.config.ts`, `meteora.position-actions.native.ts`, `packages/shared/src/meteora/sdk-client.ts`).

What already works: the Helius key is server-only. The phone uses `apps/hybrid-expo/lib/rpc.ts` → our `/rpc/solana`, never Helius directly. `apps/web` makes no Solana reads (Solana mentions there are marketing copy only).

## Goal
One typed Helius service in `packages/api` that every server-side Solana read goes through, and a server wallet-totals endpoint that replaces the phone's four-source assembly. The key stays server-side. Privy signing and sending stay on the phone.

## Out of scope
- Signing, sending or simulating transactions (stays on the phone via Privy).
- Webhooks/streams for wallet activity (later spec, after the endpoint exists).
- Moving Birdeye holder reads (`packages/api/src/wallet-activity/service.ts`, #291) to Helius.
- The token registry and Meteora pools proxy (#318).
- Pacifica live WebSocket (`packages/shared/src/pacific/websocket.ts`).
- Any Supabase migration or Redis.
- `apps/web`.

## Done-when
- [ ] `packages/api` has one Helius client; `spot.ts` uses it and no other file in `packages/api` calls `HELIUS_RPC_URL` directly.
- [ ] Client batches, retries with backoff on 429/5xx/timeouts, caches with config-driven TTLs, and reports when it falls back.
- [ ] A wallet-totals endpoint returns spot, Meteora, Phoenix and Pacifica values plus per-source status, in a versioned response.
- [ ] The phone's wallet screen reads that endpoint; per-source failure still renders the other rows (same behaviour as today's `wallet.sources.ts`).
- [ ] Remaining reads either move behind the service or are listed as staying client-side, with a reason.
- [ ] No Helius key or URL in the client bundle (`packages/api/scripts/verify-client-bundle.ts`, `apps/hybrid-expo/scripts/client-secrets.test.cjs` pass).
- [ ] Before/after request counts and latency for the wallet screen are posted on #310.

## Test plan
- Unit tests for the Helius client: batching, retry/backoff (fake timers), cache hit/expiry, fallback signal. Extend `packages/api/src/spot.test.ts`.
- Route tests for the wallet-totals endpoint: all sources ok, one fails, invalid address, cache hit.
- `packages/api/src/rpc/routes.test.ts` and `websocket.test.ts` stay green.
- Phone: existing wallet tests plus a test that the screen calls the new endpoint; Expo run of the wallet screen with screenshot.
- Secrets checks above; CI on each PR.
- Baseline first: wallet-screen requests per load and p50/p95, measured before Phase 2 and after Phase 3.

## Owners
- [x] Backend (Backend Dev): Phases 1, 2, 4
- [x] Frontend (Frontend Dev): Phase 3
- [x] System (systems manager): Phase 0 baseline, runtime checks
- Review: My Boon CTO

## Risk
- Touches money: [ ] Yes [x] No (reads only, but shows balances users act on)
- Touches wallet: [x] Yes (wallet totals screen)
- Touches DB or migrations: [ ] Yes [x] No
- Wallet = yes, so Phase 3 carries `needs-bucket`.
- Wrong totals are the main risk: keep per-source status so a failed source never shows as $0.
- Moving four upstreams onto our API concentrates load and rate limits on the server.

## Phases (proposed issues, created only after approval)

### Phase 0: Baseline wallet screen
- Owner: `ready:system`. Depends on: none.
- [ ] Requests per wallet-screen load and p50/p95 per source, posted on #310.
- [ ] Current Helius credit use from the dashboard, if Bucket shares it.

### Phase 1: Typed Helius client in `packages/api`
- Owner: `ready:backend`. Depends on: none.
- [ ] New module (e.g. `packages/api/src/helius/`) with typed methods for the calls in use today (`getAssetsByOwner`; RPC passthrough).
- [ ] JSON-RPC batching (respecting the existing 50 limit), retry with exponential backoff and jitter, request timeout.
- [ ] Bounded cache with TTLs from env, defaults equal to today's values.
- [ ] Explicit, logged fallback to `SOLANA_RPC_URL`; never silent.
- [ ] `spot.ts` moves onto it with no change to the `/spot` response.
- [ ] Key read from `HELIUS_RPC_URL` server env only.

### Phase 2: Wallet-totals endpoint
- Owner: `ready:backend`. Depends on: Phase 1, Phase 0.
- [ ] e.g. `GET /wallet/:address/totals` returning `{ version, sources: { spot, meteora, phoenix, pacifica }: { valueUsd, detail, status, updatedAt } }`.
- [ ] Sources fetched in parallel server-side; one failure does not fail the response.
- [ ] Per-wallet cache; address validation as in `spot.ts`.
- [ ] Route tests; old `/spot` untouched.

### Phase 3: Phone switches to the endpoint
- Owner: `ready:frontend`, plus `needs-bucket`. Depends on: Phase 2.
- [ ] `wallet.sources.ts` / `useProtocolAccounts.ts` read the new endpoint; rows and chips look the same.
- [ ] Old direct path kept behind a flag for one release.
- [ ] Expo screenshots before/after; after-numbers posted on #310.

### Phase 4: Remaining reads
- Owner: `ready:backend`. Depends on: Phase 1.
- [ ] Route `phoenix.ts` RPC and the `/rpc/solana` proxy upstream through the Helius client (fallback explicit).
- [ ] Decide per read for swap validation, Pacifica deposit, Meteora positions: move to server or keep client-side, with a reason. Meteora pool data is coordinated with #318 Phase 2.
- [ ] `packages/tx-parser` uses the shared client or a documented reason it doesn't.

## Open questions for Bucket
1. Helius plan and credit limit? Needed for credit estimates and rate limits.
2. Wallet freshness: is a short server cache (today 15s for spot) fine, or does the wallet need live values?
3. Fallback: is public mainnet RPC acceptable as a fallback, or do we want a second paid RPC?
4. Should webhooks/streams be the next spec right after this, or wait for the PnL card?
5. Is a one-release flag for the old phone path OK, or cut over at once?
6. Pacifica and Phoenix are not Helius reads; OK to aggregate them in the same endpoint?
