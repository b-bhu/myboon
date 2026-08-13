# Token Identity and Venue Adapters — Test Cases

Date: 2026-08-11
Reviewed: 2026-08-12 — see "Review pass results" below. This document was
authored pre-implementation; each case below now carries a `Result:` line.
File:line references throughout the case bodies point at pre-PRD code and are
stale by design (kept for precondition context) — the "Review pass results"
section re-anchors every reference to where the code actually lives now.
Source PRD: [`2026_08_11_token_identity_and_venue_adapters_PRD.md`](../PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md)
Scope: P0 only, per the PRD — token identity service, icon proxy generalization,
perp symbol map, venue adapter contract, shared market list shell, formatter
consolidation, and the two folded-in bugs (USDT mint, leaked Jupiter key
pattern). Detail screens, sort sheets/filter chips beyond what's named,
token-first navigation, and the swap screen migration are out of scope — see
the PRD's `Explicitly Postponed`.

This document is authored **before implementation**. File:line references are
to the pre-PRD code, given for precondition/context only — they will move or
disappear once the work lands; re-anchor them at review time.

## How to read this document

- Three layers, in verification order: **SERVER** (`SRV-*`), **LOGIC**
  (`LGC-*`), **CLIENT** (`CLI-*`). Server must be provably correct before
  logic is testable; logic before client, since client cases assume correct
  formatters and adapter output.
- **Automation** column: `unit` = automatable now via `tsx --test` once the
  code exists, colocated per the repo's convention (`<module>.test.ts`,
  in-process `app.request(...)` against a Hono router — see
  `packages/api/src/spot.test.ts` for the established pattern; no server needs
  to be running for these). `api-manual` = needs the API running locally
  (`pnpm api`, port 3000) and a manual HTTP call (curl/Postman) or a small
  throwaway script — typically because it depends on the nightly snapshot job
  or an upstream call that isn't worth mocking. `device` = needs the Expo app
  running on simulator/device, judged by eye or with the accessibility
  inspector.
- **Priority**: P0 = blocks the PRD's acceptance criteria, P1 = should pass
  before ship, P2 = polish/follow-up.
- Every case cites the acceptance criterion (`AC-n`) and/or risk it covers in
  its heading. The traceability table at the end is the authoritative map.

---

## Review pass results (2026-08-12)

Independent post-implementation review on branch `feat/token-identity-venue-adapters`.
Verified by: running every test suite named below, reading the shipped code
against each case, and writing throwaway `tsx` scripts in-process against the
real Hono routers (pattern: `packages/api/src/spot.test.ts`) to exercise
behavior the unit tests don't already cover directly (route-level ordering,
icon-proxy fetch-dedup counting, exact Cache-Control values).

**Current file locations** (re-anchoring the stale pre-PRD references used
throughout this document as preconditions):

| Old reference | Current location |
|---|---|
| `pacifica.ts:105` iconPath null | `packages/api/src/pacifica.ts:101` — now `perpIconPath(market.symbol) ?? legacy proxy path` |
| `phoenix.ts:760` iconPath null | `packages/api/src/phoenix.ts` (~line 761) — now `perpIconPath(venueSymbol)` |
| `pacifica.ts:127-166` icon proxy | Generalized to `packages/api/src/tokens/icon-proxy.ts` |
| `PacificaMarketListScreen.tsx`, `PhoenixMarketListScreen.tsx` | Deleted. Replaced by `apps/hybrid-expo/features/markets/VenueMarketListScreen.tsx` (generic, `search.mode: 'local'` venues only) + `app/markets/pacifica.tsx` / `phoenix.tsx` thin routes + `app/markets/[venueId].tsx` catch-all |
| `MeteoraPoolsScreen.tsx` | Still exists, NOT deleted — kept intentionally (see LGC-ADAPT-005 result). Now renders `<MarketList>` (`apps/hybrid-expo/features/markets/MarketList.tsx`) instead of its own table |
| `perps.contract.ts` / `perps.registry.ts` | Generalized to `apps/hybrid-expo/features/markets/venue.contract.ts` / `venue.registry.core.ts` / `venue.registry.ts` |
| `formatPrice`/`formatPhoenixPrice` etc. | Consolidated into `apps/hybrid-expo/lib/format.ts`, tested in `lib/format.test.ts` |
| `knownTokens.ts:4`, `swap.api.ts:25` | `swap.api.ts` corrected to `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` at `apps/hybrid-expo/features/swap/swap.api.ts:38`; `packages/tx-parser/src/constants/knownTokens.ts:4` unchanged (was already correct) |
| `swap.api.ts:39` leaked key | Removed; server-side proxy at `packages/api/src/swap.ts`, header injection at `swap.ts:19-20` |
| `data-api.ts:188-194`, `:558-573` fabricated fields | Fixed at `packages/shared/src/meteora/data-api.ts:186-198` (`normalizePortfolioToken`, both fields now `null`) and `:559-578` (both tokenX/tokenY inline literals) |

### Suites run (verbatim tallies)

- `pnpm --filter @myboon/api run test:tokens` — **32/32 pass**
- `pnpm --filter @myboon/api run test:swap` — **5/5 pass**
- `pnpm --filter @myboon/api run test:spot` — **7/7 pass**
- `pnpm --filter @myboon/api run test:internal` — **13/13 pass**
- `pnpm --filter hybrid-expo test` — **30/30 (format) + 56/56 (markets) pass**
- `pnpm --filter @myboon/shared test` — **pass** (live E2E against Pacifica/Meteora/spot; 5/5 Pacific + Meteora service/execution + spot data-api all green)
- `pnpm --filter hybrid-expo exec tsc --noEmit` — **clean, zero errors**

### Per-case results

**SERVER layer**

| Case | Result | Note |
|---|---|---|
| SRV-RESOLVE-001 | PASS | `routes.test.ts:24-32` |
| SRV-RESOLVE-002 | PASS | `routes.test.ts:47-63` (mixed hit/miss batch, order preserved) |
| SRV-RESOLVE-003 | PASS | `identity-service.test.ts` unparseable-ref case; confirmed at HTTP layer too via throwaway script (garbage ref echoed verbatim, 200) |
| SRV-RESOLVE-004 | PASS | `routes.test.ts:34-45`, `identity-service.test.ts` miss cases; confirmed status is 200 with `assetId: null`, `iconUrl: null`, non-empty `fallbackLetter` |
| SRV-RESOLVE-005 | PASS (implementation choice: empty array, not 400) | `routes.ts:69` — no `refs` param or empty `refs=` both produce `[]`, not an error. Consistent, never 500s. Flagging the choice (empty-array-not-400) as the resolved open question, not a defect. |
| SRV-RESOLVE-006 | PASS | `identity-service.test.ts` "perp markets always resolve with decimals null"; `identity-service.ts:206` hardcodes `decimals: null` on the perp branch, `mint` also null |
| SRV-ICON-001 | PASS | All `iconUrl` values are `/tokens/icon/<assetId>` relative paths — never a third-party host. Confirmed by grep (see below) and route tests. |
| SRV-ICON-002 | PASS | `icon-proxy.test.ts` "first request fetches upstream and caches...", confirmed Cache-Control `max-age=604800` exact on hit |
| SRV-ICON-003 | PASS | `icon-proxy.test.ts` 404 negative-cache case; `ICON_NEGATIVE_TTL_MS = 60*60*1000` at `icon-proxy.ts:25`, exact 1h, not 24h |
| SRV-ICON-004 | PASS | Proxy is keyed on `assetId` string only (`icon-proxy.ts:63` signature), no venue-specific key ever enters the cache map |
| SRV-ICON-005 | **PARTIAL — deliberate deviation, not a defect, but flag it.** | `icon-proxy.ts:85-104`: both an upstream non-OK status AND a thrown/network exception negative-cache identically (both hit the same `catch`/`!res.ok` branches, both set `expiresAt: now + ICON_NEGATIVE_TTL_MS`). The pre-authored case expected these to differ (network error = not cached). This is a **unification**, consistent with the module's own doc comment ("Never throws — upstream failures negative-cache the same as a 404"). Reasonable design (a transient network blip self-heals within 1h either way), but it is a behavior change from today's Pacifica-only proxy that the PRD didn't explicitly call for. Not blocking; noting per the case's own instruction to "flag the decision either way, don't let it pass silently." |
| SRV-PERP-001 | PASS | `identity-service.test.ts` "perp:BTC-PERP and perp:BTC resolve to the same assetId", spot-checked against `perp-symbol-map.ts` directly |
| SRV-PERP-002 | PASS | `identity-service.test.ts` "perp:kPEPE-PERP resolves to pepe's assetId with fallbackLetter K"; map has literal `kPEPE: 'pepe'` entry, not a stripped-and-matched heuristic |
| SRV-PERP-003 | PASS | `identity-service.test.ts` "a perp symbol outside the frozen union falls through to the static fallback, not fuzzy search". Independently grepped all of `packages/api/src/tokens/*.ts` (excluding tests) for `.includes/.substring/.startsWith/.indexOf/.match` — only non-test hit is `snapshot-job.ts` category allowlist check (unrelated). `perpAssetId()` (`perp-symbol-map.ts:127-130`) is an exact object-key lookup, never a substring/fuzzy match. |
| SRV-PERP-004 | PASS | Same evidence as SRV-PERP-003; unmapped symbol returns the static fallback shape with `fallbackLetter` computed |
| SRV-FLAG-001 | PASS | `routes-flag-off.test.ts` — GET/POST resolve return well-formed static identities, icon route 404s, nothing 500s |
| SRV-FLAG-002 | PASS | Route mounting is a **runtime** branch, not boot-time (resolved the open question the original case flagged): `create-app.ts:75-76` always mounts `createTokenRoutes({enabled: config.tokenIdentityEnabled, ...})`; `config.ts:45` derives `tokenIdentityEnabled` from exactly one env var (`TOKEN_IDENTITY_ENABLED === '1' \|\| === 'true'`). **However — see "Defects found" below: a second, independent client-side flag (`EXPO_PUBLIC_TOKEN_IDENTITY_DISABLED`) exists and is undocumented. This is a genuine AC-9 concern, not the server-side "one flag" claim itself, which does hold.** |
| SRV-SNAPSHOT-001 | PASS (api-manual, covered by unit test with mocked upstream instead) | `snapshot-job.test.ts` — "with an api key, pulls curated lists + resolve + asset detail and maps fields with source 'tokens'", "never deletes rows" cases all pass. A live-upstream run was not performed (no `TOKENS_API_KEY` in this environment) — acceptable per the case's own api-manual marking. |

**LOGIC layer**

| Case | Result | Note |
|---|---|---|
| LGC-FMT-001 | PASS | Grep confirms `formatPhoenixPrice` no longer exists anywhere; `apps/hybrid-expo/lib/format.ts` is the sole module, imported by `perps.public-api.ts`, `phoenix.api.ts`, and the new row mappers |
| LGC-FMT-002 | PASS | `lib/format.test.ts` "formatPrice" suite — table-tests the full matrix (0, negative, sub-cent, large, null, undefined, NaN) |
| LGC-FMT-003 | PASS | `lib/format.test.ts` "formatPercent", "formatUsdCompact" suites, including explicit `0` case |
| LGC-FMT-004 | PASS | `lib/format.test.ts` "NO_DATA is the single em-dash glyph"; grepped consolidated module and call sites for literal `--`, zero occurrences as a no-data glyph |
| LGC-FMT-005 | PASS | Every formatter suite in `format.test.ts` includes explicit null/undefined cases, all return `NO_DATA` (`—`), none throw |
| LGC-ADAPT-001 | PASS | `pacifica.rows.test.ts`, `phoenix.rows.test.ts`, `meteora.rows.test.ts` all assert "always produces exactly 3 cells" and "always produces a non-empty a11yLabel" for full and empty identity maps. Additionally, `MarketListRow.cells` is typed as the literal tuple `[Cell, Cell, Cell]` and `a11yLabel: string` is non-optional in `venue.contract.ts:56,59` — a real compile-time guarantee, not just convention. Orca stub covered via `venue.registry.core.test.ts` "a stub fourth venue (Orca) registers with no new screen". |
| LGC-ADAPT-002 | PASS (judgment call, not a placeholder) | Row mappers build `a11yLabel` from symbol/pair + price/context fields (e.g. Pacifica combines symbol, price, change), not a generic "Row" or bare title copy — read directly in `pacifica.rows.ts`/`phoenix.rows.ts`/`meteora.rows.ts` |
| LGC-ADAPT-003 | PASS | `venue.registry.core.test.ts` + direct type check — `columns` is `[ColumnSpec, ColumnSpec, ColumnSpec]` on every adapter |
| LGC-ADAPT-004 | PASS | `meteora.rows.test.ts` "METEORA_THEME keeps its own palette rather than the shared default (acceptance criterion 8)"; Pacifica/Phoenix/Orca adapters omit `theme` and fall through to `DEFAULT_MARKET_LIST_THEME` (`venue.theme.ts`) |
| LGC-ADAPT-005 | PASS, with a correction to the original case's assumption | Pacifica/Phoenix/Orca: `search.mode: 'local'`. Meteora: `search.mode: 'remote'` (`meteora.adapter.ts:57`). **Correction:** Meteora's `search.mode: 'remote'` is exactly why it does NOT go through the generic `VenueMarketListScreen` (that screen's own doc comment restricts it to local-search venues) — Meteora keeps its own bespoke `MeteoraPoolsScreen.tsx`, which now renders through `<MarketList>` but keeps its own fetching/debounce/pagination entirely. This is the PRD's design working as intended, not a gap. |
| LGC-USDT-001 | PASS | `identity-service.test.ts` "USDT seed mint is Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; grepped every `Es9vMFrz` occurrence in the repo — `swap.api.ts:38`, `knownTokens.ts:4`, seed JSON `:1139` all identical, character-for-character |
| LGC-USDT-002 | PASS | Same evidence; `swap.api.ts` `FALLBACK_TOKENS` USDT entry now uses the corrected mint with an explanatory comment |
| LGC-JUP-001 | PASS | `EXPO_PUBLIC_JUP_API_KEY` appears in exactly one place in the whole tree: a comment in `swap.api.ts:6` explaining the fix. No live `process.env.EXPO_PUBLIC_JUP_API_KEY` read anywhere. Removed from `apps/hybrid-expo/.env.example`. Client no longer sets `x-api-key` at all (confirmed no such header construction in `swap.api.ts`). |
| LGC-JUP-002 | PASS | `packages/api/src/swap.test.ts` — 5/5 pass, including "injects x-api-key only when jupApiKey is configured" (server-side) and a 502-on-upstream-failure case |
| LGC-PRICE-001 | PASS | `TokenIdentity` interface (both `packages/api/src/tokens/types.ts:22-34` and the client's `apps/hybrid-expo/lib/token-identity.core.ts:26-38`) has no price/quote/marketCap field. Both copies match field-for-field. |
| LGC-PRICE-002 | PASS (review, as the PRD itself specifies) | Traced Pacifica/Phoenix mark price and Meteora pool price fields — all come from each venue's own market-data response, never from `/tokens/resolve`. `TokenIdentity`'s absence of a price field (LGC-PRICE-001) is the structural enforcement. |
| LGC-BLOCK-001 | PASS | `VenueMarketListScreen.tsx:81-94` computes `filteredMarkets`/`rows` from `markets` state alone; `identities` (from `useTokenIdentities`, async) is consulted only inside `toRow()` for icon lookup and re-renders independently. A cold/never-resolving identity fetch does not block `rows` from computing — traced directly, not simulated, but the data-flow separation is unambiguous in the code. |
| LGC-METEORA-001 | PASS | `data-api.ts:186-198` — `normalizePortfolioToken` now returns `decimals: null`, `verified: null`, both explicitly commented as "the honest unknown" replacing the former fabrication |
| LGC-METEORA-002 | PASS | Same fix applied at all three sites: `normalizePortfolioToken` (`:186-198`) and both inline literals in `getOpenLimitOrderPools` for tokenX/tokenY (`:559-578`) |
| LGC-METEORA-003 | PASS | `TokenIcon.tsx` three-tier fallback (`:8-19`, `:53-57`): identity icon -> `venueIconUrl` -> letter box, skip-on-empty-field only. `meteora.rows.ts` passes `pool.tokenX.iconUrl`/`tokenY.iconUrl` as `venueIconUrl` — an unresolved identity does not collapse straight to the letter box while Meteora's own icon is available. |

**CLIENT layer**

| Case | Result | Note |
|---|---|---|
| CLI-SHELL-001 | PASS (static verification; no device run performed) | Grepped all of `apps/hybrid-expo` for third-party icon hosts (pacifica, trustwallet, solana-labs, githubraw, meteora CDN) — zero hits in client code. All icon URLs are relative `/tokens/icon/*` resolved against our own API origin via `tokenIconUrl()`. Not run on an actual simulator/device — see "Not verified" below. |
| CLI-SHELL-002 | NOT VERIFIED (device required) | Requires visual/device inspection; not run this pass. Structurally supported (same `assetId` -> same `/tokens/icon/<assetId>` URL regardless of venue), but not observed on-screen. |
| CLI-SHELL-003 | PASS (structural), NOT VERIFIED (visual) | `fallbackLetter` is computed server-side once per identity and consumed identically by all three venues' `TokenIcon` usage — there is no per-venue color logic left in the new components (confirmed by reading `TokenIcon.tsx`, which has no venue-conditional tinting outside the `tint` prop Meteora explicitly opts into for pair rows). Did not visually confirm on device. |
| CLI-PACIFICA-001 | PASS | `MarketList.tsx:122-123` renders `MarketListEmptyState` whenever `empty` is passed and not loading; `VenueMarketListScreen.tsx:133` always passes `empty` when there's no error — this covers Pacifica now that it's on the shared shell. Not run on device, but the code path is unconditional and shared, so a Pacifica-specific regression is structurally implausible. |
| CLI-PACIFICA-002 | PASS (structural) | `MarketList.tsx:190` wires `accessibilityLabel={row.a11yLabel}` on every row's `Pressable`, and `a11yLabel` is a required non-empty field per LGC-ADAPT-001. Not run through an actual accessibility inspector. |
| CLI-PHOENIX-001 | PASS | `phoenix.ts` `iconPath: perpIconPath(venueSymbol)` — no longer hardcoded null. Confirmed by reading the current code (see file re-anchor table above). |
| CLI-PHOENIX-002 | PASS (structural) | Phoenix now goes through the same shared `MarketList` empty-state and a11y wiring as Pacifica — nothing venue-specific was dropped in the migration. |
| CLI-METEORA-001 | PASS | `meteora.rows.ts` exports `METEORA_THEME`, passed as `adapter.theme`; `meteora.rows.test.ts` "keeps its own palette rather than the shared default (acceptance criterion 8)" |
| CLI-METEORA-002 | PASS | Confirmed directly in `MeteoraPoolsScreen.tsx`: `SortSheet` component (~line 408), filter chips (`FILTER_OPTIONS`, ~lines 57-62/377-393), pagination (`page` state + `hasNext`) all present and unchanged in structure |
| CLI-METEORA-003 | PASS | `MeteoraPoolsScreen.tsx`: debounce via `setTimeout` (~lines 86-89, 300ms), request-id race guard via a `requestId` ref checked before applying results (~lines 67, 98-99, 115, 126, 129) — both intact |
| CLI-METEORA-004 | PASS (structural), NOT VERIFIED (visual) | `normalizePortfolioToken` now returns real `null` instead of fabricated `decimals: 0`; downstream consumers that need real decimals resolve through a `mint:` ref per the spec's "Known limits" section. Did not visually confirm a specific non-zero-decimals balance on device. |
| CLI-ORCA-001 | PASS | `orca.adapter.ts` + `venue.registry.ts` registration is the only addition; confirmed via `git status` that no new `.tsx` screen file was added for Orca — it resolves through the pre-existing `app/markets/[venueId].tsx` catch-all route, which is about as clean a proof of "no new screen" as this criterion could ask for |
| CLI-ORCA-002 | N/A, as the original case anticipated | `HomeScreen.tsx`'s `orca` tile entry still has no `route` field (still disabled/58% opacity) even though the adapter is fully registered and reachable at `/markets/orca`. Per the case's own note, this is outside AC-7's literal wording and does not block the criterion. |

### Traceability check

Every one of the 12 acceptance criteria has at least one PASS-covered case
above. No criterion is uncovered. AC-9's "one flag and one env var" server-side
claim holds, but see the defect below regarding a second client-side knob that
the PRD's wording doesn't anticipate.

### Defects found (ranked by severity)

**1. (Medium) AC-9 risk: a second, undocumented, independent feature flag exists
client-side.** `apps/hybrid-expo/lib/token-identity.ts:43-45` reads
`process.env.EXPO_PUBLIC_TOKEN_IDENTITY_DISABLED === '1'` and uses it to gate
`resolveTokenIdentities`/`useTokenIdentities` entirely — if set, the client
never calls `/tokens/resolve` at all, regardless of the server's
`TOKEN_IDENTITY_ENABLED`. This variable:
- Does not appear in `apps/hybrid-expo/.env.example` (only
  `EXPO_PUBLIC_JUP_API_KEY` was removed from that file; nothing was added for
  this flag).
- Is not mentioned in `docs/modules/wallet/specs/token_identity.md`'s
  Configuration table, which lists exactly one flag
  (`TOKEN_IDENTITY_ENABLED`) and one env var (`TOKENS_API_KEY`).
- Creates a real disagreement scenario: server flag ON (so `perpIconPath()`
  lights up server-side icon paths for Pacifica/Phoenix) but client flag
  DISABLED (so the client never fetches `/tokens/resolve`, meaning Meteora's
  identity-tier icons and any client-only consumer silently get nothing) —
  two independent knobs that can point different directions, which is
  precisely what AC-9 ("one feature flag and one env var") and SRV-FLAG-002
  ask to rule out.

Repro: `grep -n "EXPO_PUBLIC_TOKEN_IDENTITY_DISABLED" apps/hybrid-expo/lib/token-identity.ts`
shows it live and functional (not dead code) at lines 44, 129, 192, 204.

This does not break anything today (nothing sets the var, so it defaults to
enabled), but it is a second knob that exists in code and is invisible in
both the spec's Configuration table and `.env.example`. Recommend either
documenting it explicitly as an intentional emergency client-side kill switch
(and adding it to the spec + `.env.example`), or removing it so the "one
flag" claim is literally true rather than true-by-omission.

> **RESOLVED (2026-08-12).** Removed rather than documented. The server flag
> already produces the required degradation — with `TOKEN_IDENTITY_ENABLED`
> off, `/tokens/resolve` returns well-formed identities with null icons and
> every consumer falls back to venue-supplied icons and the letter box — so
> the client knob was redundant as well as divergent. `isDisabled()` and all
> four call sites are gone; a comment at the top of
> `apps/hybrid-expo/lib/token-identity.ts` records why no client-side switch
> should be reintroduced. Verified: `grep` finds no occurrence in any source
> file, `tsc --noEmit` clean, full client suite (230 tests) green.
> **AC-9 now fully met.**

**2. (Low, informational) SRV-ICON-005's negative-caching unification.** See
the SRV-ICON-005 row above — thrown network errors and upstream 404s now
negative-cache identically, which is a deliberate, documented, and reasonable
change from the pre-PRD Pacifica-only proxy's behavior, but it's a behavior
change the PRD text didn't explicitly call for. Not blocking.

> **RESOLVED (2026-08-12).** Fixed rather than accepted — the reviewer's
> instinct was right. A 404 is a definitive answer ("no icon exists for this
> asset") and keeps the one-hour `ICON_NEGATIVE_TTL_MS`. A thrown fetch (DNS,
> timeout, connection reset) is not an answer at all, and caching it for an
> hour would blank that token's icon app-wide long after the network
> recovered — so it now uses `ICON_TRANSIENT_TTL_MS` (one minute). Same
> reasoning as the PRD's own one-hour-not-one-day choice, one level down.
> Pinned by a test asserting the two TTLs stay distinct and that a recovered
> upstream serves real bytes again. `test:tokens` 33/33 green.

### Not verified (and why)

- **Any CLI-* case requiring an actual simulator/device render or an
  accessibility inspector** (CLI-SHELL-002, CLI-SHELL-003's visual half,
  CLI-METEORA-004's visual half) — this review was conducted by reading code,
  running unit/type-check suites, and exercising server routes in-process.
  No Expo dev client or simulator session was launched. Everything gating on
  "PASS (structural)" above is a strong proxy (the code path is unconditional
  and shared across venues) but is not the same as an observed screenshot.
- **SRV-SNAPSHOT-001's live-upstream half** — no `TOKENS_API_KEY` was
  available in this environment; covered instead by the mocked-upstream unit
  test in `snapshot-job.test.ts`, which is what the original case itself
  anticipated as the fallback.
- **The "in-memory caches will not hold" multi-instance risk** — as the
  original document already notes, this needs a load-balanced staging
  environment to exercise and remains untestable in local dev. No change to
  that assessment.

---

## 1. SERVER layer

### 1.1 `GET /tokens/resolve` — single and batch

#### SRV-RESOLVE-001: Single ref resolves to full identity (AC-1, AC-3)

**Priority:** P0 · **Automation:** unit

**Precondition:** Snapshot table contains an entry for a known mint (e.g. SOL).

**Steps**
1. `GET /tokens/resolve?refs=<known-mint>`

**Expected**
- 200. Response is an array (or keyed map, per final route shape) of
  `TokenIdentity` objects.
- `key` echoes the caller's ref verbatim (byte-for-byte, including case).
- `assetId` is non-null. `symbol`, `name`, `fallbackLetter`, `category`,
  `source` are all present and non-empty. `iconUrl` is either null or points
  at our own origin (see SRV-ICON-* for the origin rule itself).

#### SRV-RESOLVE-002: Batch POST resolves multiple refs in one call (AC-1)

**Priority:** P0 · **Automation:** unit

**Steps**
1. `POST /tokens/resolve` with a body containing a mix of: a known mint, a
   known perp symbol (e.g. `BTC-PERP`), and a nonsense ref.

**Expected**
- 200. One `TokenIdentity` per input ref, same order or reliably keyed —
  caller can always match response items back to request items via `key`.
- The nonsense ref does not abort or error the batch; it comes back
  unresolved (see SRV-RESOLVE-004) alongside the two resolved ones.

#### SRV-RESOLVE-003: `key` echoes ref verbatim even when resolution fails

**Priority:** P0 · **Automation:** unit

**Steps**
1. Request a ref that cannot resolve to anything (garbage string).

**Expected**
- `key` in the response equals the exact input string. Nothing about failure
  changes the echo contract.

#### SRV-RESOLVE-004: Unresolved ref is a 200 with empty fields, not an HTTP error (Risk: "Unresolved is a 200, not an error"; AC-3)

**Priority:** P0 · **Automation:** unit

**Precondition:** A mint that exists on-chain but is outside the curated
Tokens registry (Tokens returns a `solana-<mint>` singleton with
`imageUrl: null` and empty stats for these — see PRD "Why the Tokens API").

**Steps**
1. `GET /tokens/resolve?refs=<mint-outside-curated-registry>`

**Expected**
- HTTP status is 200, not 404/422/500.
- `assetId` is `null` (or the singleton form — whichever the implementation
  picked, but it must be a value the client can branch on, not an exception).
- `iconUrl` is `null`. `symbol` still falls back to something derivable from
  the ref (not a blank string) and `name` falls back to `symbol` per the
  documented contract. `fallbackLetter` is still computed and non-empty.
- Fallback logic downstream keys off these **empty fields**, not off HTTP
  status. This is the specific failure mode the PRD calls out as the one
  teams get wrong — write the assertion against field values, and separately
  assert the status code is 200, so a regression that flips this to a 4xx/5xx
  is caught even if a lazy client-side check would have papered over it.

#### SRV-RESOLVE-005: Malformed/empty `refs` param

**Priority:** P1 · **Automation:** unit

**Steps**
1. `GET /tokens/resolve` with no `refs` param.
2. `GET /tokens/resolve?refs=` (empty).

**Expected**
- Neither request 500s. Empty array back, or a 400 with a clear error body —
  pick one and be consistent; assert whichever the implementation commits to
  (flag as an open question if the PRD doesn't say — it doesn't).

#### SRV-RESOLVE-006: `decimals` is null for perp markets (contract: `TokenIdentity.decimals`)

**Priority:** P0 · **Automation:** unit

**Steps**
1. Resolve a known perp symbol (e.g. `ETH-PERP`) through `/tokens/resolve`.

**Expected**
- `decimals` is explicitly `null` (perps have none — this is a documented
  field semantic in the PRD's `TokenIdentity` interface, not an oversight;
  a test should fail if a random on-chain decimals value leaks in from the
  underlying mint).
- `mint` is `null` for the perp symbol (it's not an SPL mint).

### 1.2 Icon proxy — generalized

#### SRV-ICON-001: Icons are always served from our origin (AC-1)

**Priority:** P0 · **Automation:** unit

**Steps**
1. Resolve any token with a known icon via `/tokens/resolve`.
2. Inspect the `iconUrl` value returned.

**Expected**
- `iconUrl` host matches our API's own origin/base path — never
  `app.pacifica.fi`, a Meteora CDN host, `trustwallet`/`solana-labs` GitHub
  raw URLs, or any other third-party host. This is the contract's
  non-negotiable, phrased as: the client never learns where the icon
  originally came from.

#### SRV-ICON-002: Positive cache hit serves from cache with correct headers

**Priority:** P0 · **Automation:** unit

**Precondition:** Icon proxy generalized from `pacifica.ts:127-166`.

**Steps**
1. `GET` an icon route for a known `assetId` twice in succession.

**Expected**
- Both responses 200 with the icon bytes and `Content-Type` set appropriately
  (svg or png per source format).
- `Cache-Control` header present on 200 responses. Per the PRD: icon bytes
  cache **for a week** — confirm the generalized TTL is 7 days, not the
  current Pacifica-only 24h (`ICON_CACHE_TTL_MS` in today's `pacifica.ts` is
  24h for both positive and negative; the PRD explicitly widens positive to a
  week and *shortens* negative to an hour — this is a deliberate change, not
  a carry-over, so assert the new numbers specifically).

#### SRV-ICON-003: Negative-cache TTL is one hour, not a day (PRD explicit: "misses negative-cache for an hour, not a day")

**Priority:** P0 · **Automation:** unit

**Steps**
1. Request an icon for an `assetId` known to have no upstream icon (miss).
2. Immediately re-request the same `assetId` — confirm it's served from the
   negative cache (e.g. via a spy/counter on the upstream fetch, or timing).
3. Advance the clock (fake timers) or wait past 1 hour; re-request.

**Expected**
- Step 2: upstream is not re-fetched; a 404 (or agreed miss-response) comes
  back fast, from cache.
- Step 3: after the 1-hour TTL elapses, the next request re-attempts the
  upstream fetch (cache entry expired) — this is the exact scenario the PRD
  is protecting: "a newly listed token is not broken all day."

#### SRV-ICON-004: Icon proxy keyed on `assetId`, not on venue-specific ticker (contract change from current Pacifica-only keying)

**Priority:** P0 · **Automation:** unit

**Steps**
1. Request the same underlying token's icon via two different venues that
   would previously have produced different cache keys (e.g. Pacifica's
   uppercased ticker sanitization vs. a raw SPL mint).

**Expected**
- Both resolve to the same cached entry, because the key is the canonical
  `assetId`, not a venue-local string. This is what makes the icon
  identical across Pacifica/Phoenix/Meteora for the same token — assert the
  cache is actually shared, not merely that each individually returns 200.

#### SRV-ICON-005: Upstream fetch failure (network error) vs. upstream 404 are distinguished in caching behavior

**Priority:** P1 · **Automation:** unit

**Precondition:** Current Pacifica behavior (`pacifica.ts`) negative-caches a
`!res.ok` (404-style) response but does **not** cache a thrown fetch
exception (502) at all — worth locking in explicitly since the generalized
proxy could accidentally change this.

**Steps**
1. Mock upstream to return non-OK status → request icon.
2. Mock upstream to throw (network error) → request icon.

**Expected**
- Non-OK status: negative-cached per SRV-ICON-003 (1h TTL).
- Thrown/network error: not cached — served as an error response, but the
  very next request re-attempts upstream rather than serving a stale
  negative-cache entry for a transient network blip. If the implementation
  intentionally unifies these two paths, this case should be updated to
  match — flag the decision either way in review, don't let it pass silently
  either direction.

### 1.3 Perp symbol map

#### SRV-PERP-001: Known perp symbols resolve through the checked-in map (PRD "2. Perp symbol map")

**Priority:** P0 · **Automation:** unit

**Steps**
1. Resolve `BTC-PERP` and a sample of other symbols from the ~40-entry map
   via `/tokens/resolve`.

**Expected**
- Each resolves to the correct `assetId`/icon/symbol — spot-check at least
  5-10 entries against the checked-in map file directly (assert the API
  output matches what the map file says, not just that *something* comes
  back).

#### SRV-PERP-002: `kPEPE-PERP`-style denominated symbols resolve correctly, not via naive suffix-strip (PRD explicit example)

**Priority:** P0 · **Automation:** unit

**Precondition:** Map contains an explicit entry for a denominated symbol
(e.g. `kPEPE-PERP` or equivalent multiplier-prefixed ticker).

**Steps**
1. Resolve `kPEPE-PERP` via `/tokens/resolve`.
2. Separately, assert that the naive strip-suffix heuristic (`kPEPE-PERP` →
   strip `-PERP` → `KPEPE`) is **not** what's being looked up — i.e. the map
   has a literal `kPEPE-PERP` (or case-preserved equivalent) key, not one
   that depends on an uppercase-and-strip transform finding a coincidental
   match.

**Expected**
- Resolves to the correct kPEPE identity (right icon/symbol/name), not to
  nothing and not to an unrelated token that happens to also fuzzy-match
  "KPEPE".

#### SRV-PERP-003: Perp symbol never resolves via fuzzy search (PRD non-negotiable: "Never through fuzzy search")

**Priority:** P0 · **Automation:** unit

**Precondition:** A perp symbol that is deliberately **absent** from the
checked-in map, but whose stripped ticker would fuzzy-match a real, different
token in the snapshot (a ticker-collision scenario — e.g. a mid-cap symbol
that collides with an unrelated major).

**Steps**
1. Resolve that perp symbol via `/tokens/resolve`.

**Expected**
- Falls through to unresolved (letter-box fallback territory per
  SRV-RESOLVE-004) — it must **not** return the fuzzy-matched wrong token's
  icon/name/assetId, even though a `search?q=` call against the same string
  would find something. This is the single most consequential negative case
  in the whole document: a passing-looking green check here that actually
  used fuzzy search would ship a confidently wrong logo, which the PRD says
  explicitly is worse than the current grey box.

#### SRV-PERP-004: Symbol not in map degrades to letter-box fallback, not an error (PRD: "falls through to the letter box")

**Priority:** P0 · **Automation:** unit

**Steps**
1. Resolve a plausible-looking but unmapped perp symbol.

**Expected**
- 200, unresolved shape (same as SRV-RESOLVE-004), `fallbackLetter` computed
  and present so the client can render the letter box.

### 1.4 Feature flag off-degradation

#### SRV-FLAG-001: With the Tokens integration flag off, `/tokens/resolve` still responds and the app keeps working (AC-9)

**Priority:** P0 · **Automation:** api-manual

**Precondition:** Requires running the API locally (`pnpm api`, port 3000)
with the feature flag / env var unset or explicitly off — this is
config-dependent startup behavior that's awkward to fake convincingly in a
single in-process unit test if the flag also gates what gets mounted at
`create-app.ts` boot time; do as a unit test if the flag is a simple runtime
branch, escalate to api-manual if it's a boot-time branch.

**Steps**
1. Start the API with the flag off.
2. Call `/tokens/resolve` for a token that has venue-supplied icon data
   available (e.g. a Pacifica market).

**Expected**
- Endpoint does not 404/500 outright in a way that breaks calling clients —
  either it responds with venue-supplied-only data, or clients degrade
  gracefully to venue icons per AC-9's "degrades to venue-supplied icons."
  Confirm which behavior was chosen and that it matches what the PRD
  promises: the app keeps working, it doesn't just fail differently.

#### SRV-FLAG-002: Single flag and single env var actually gate the entire integration (AC-9)

**Priority:** P0 · **Automation:** api-manual

**Steps**
1. Grep the implementation for every place the Tokens integration can be
   independently enabled/disabled.

**Expected**
- Exactly one flag and one env var control it, per AC-9's literal wording
  ("one feature flag and one env var"). If there are two independent knobs
  (e.g. a client flag and a server flag that can disagree), that's a fail
  against this criterion as written — flag it, don't average it into a pass.
  This is a code-inspection case, not a runtime one; note it as such in the
  review pass rather than trying to force it into a unit test.

### 1.5 Nightly snapshot job (server, but largely non-automatable pre-implementation)

#### SRV-SNAPSHOT-001: Snapshot job populates the identity table from curated lists + resolve + per-asset calls (PRD "1. Token identity snapshot and service")

**Priority:** P1 · **Automation:** api-manual

**Steps**
1. Run the nightly job against a test/staging Tokens API key (or a mocked
   upstream if the job supports dependency injection).
2. Inspect the resulting table.

**Expected**
- Table contains rows sourced from all three call types the PRD lists:
  curated lists, resolve-by-mint for the known universe (Meteora pool legs,
  wallet holdings, swap list), and per-asset detail for icon/category.
- This case needs a real or faithfully mocked upstream and cannot be
  meaningfully unit-tested without one; mark as api-manual / integration,
  and note it as the one server case most likely to need a dedicated
  fixture-based integration test once the job exists.

---

## 2. LOGIC layer

### 2.1 Formatter consolidation (AC-6)

#### LGC-FMT-001: Exactly one `formatPrice` implementation is imported everywhere

**Priority:** P0 · **Automation:** unit (+ static grep as a review-time check)

**Steps**
1. Grep the codebase for `formatPrice` and `formatPhoenixPrice` after the
   consolidation lands.

**Expected**
- `formatPhoenixPrice` no longer exists as a separate function; every call
  site (perps public API, Phoenix API, any screen) imports the same single
  `formatPrice` from the consolidated module.
- This is inherently a code-inspection case, not something a black-box unit
  test alone proves — pair it with LGC-FMT-002 (behavioral parity), which
  *is* a real unit test.

#### LGC-FMT-002: Consolidated `formatPrice` preserves both venues' existing thresholds/branches (no regression)

**Priority:** P0 · **Automation:** unit

**Precondition:** Current `perps.public-api.ts:120` `formatPrice` and
`phoenix.api.ts:628` `formatPhoenixPrice` are "character-identical" per the
PRD's own description (same branches, same thresholds, same output) — this
case exists to prove that claim and catch any silent divergence introduced
during the merge.

**Steps**
1. Table-test the consolidated `formatPrice` against a matrix of inputs:
   `0`, negative, very small (sub-cent), very large, `null`, `undefined`,
   `NaN`, `Infinity`.

**Expected**
- Output matches what both legacy functions independently produced for every
  input in the matrix (they should already agree, per the PRD; this proves
  the merge didn't quietly pick one venue's behavior and drop the other's
  edge case).
- `0` and other no-data-equivalent inputs produce the single glyph `—`, not
  `--` (see LGC-FMT-004).

#### LGC-FMT-003: Same treatment for `formatChange` and `formatUsdCompact` (AC-6)

**Priority:** P0 · **Automation:** unit

**Steps**
1. Repeat LGC-FMT-002's approach for `formatChange`/`formatPhoenixPercent`
   and for `formatUsdCompact`.

**Expected**
- One implementation each, nullable-safe, consistent output across the
  input matrix.
- Specifically for `formatUsdCompact`: today there are **two functions with
  that exact name** — the shared one in `lib/format.ts` (glyph `--`, treats
  any `value <= 0` as no-data) and Meteora's private one in
  `MeteoraPoolsScreen.tsx:675` (glyph `—`, only treats `null`/`undefined`/
  non-finite as no-data — a legitimate `0` is *not* no-data there). Assert
  the consolidated version picks one behavior deliberately and both former
  call sites now agree with it — a `0` input is the input most likely to
  silently regress here, so include it explicitly in the test matrix.

#### LGC-FMT-004: Single no-data glyph is `—` (em dash) everywhere, not `--` (AC-6)

**Priority:** P0 · **Automation:** unit

**Steps**
1. Grep the consolidated formatter module and all its call sites for the
   literal string `--`.

**Expected**
- Zero occurrences of `--` as a no-data glyph anywhere in formatter output.
  `—` (U+2014 em dash) is the only glyph produced for null/undefined/
  non-finite/zero-as-no-data inputs, matching the PRD's explicit choice.
- Note: `formatUsdAccessible`-style accessibility strings that spell out
  "Unavailable" in words (not a glyph) are a different, legitimate thing and
  out of scope for this glyph rule — don't flag those as a failure.

#### LGC-FMT-005: Nullable safety — no formatter throws on null/undefined input

**Priority:** P0 · **Automation:** unit

**Steps**
1. Call each consolidated formatter with `null` and `undefined` explicitly
   (not just `0` or `NaN`).

**Expected**
- No exception thrown; each returns the `—` glyph.

### 2.2 Venue adapter contract conformance

#### LGC-ADAPT-001: Every registered adapter's `toRow()` output satisfies `MarketListRow` (AC-5, AC-7)

**Priority:** P0 · **Automation:** unit

**Steps**
1. For each registered adapter (Pacifica, Phoenix, Meteora, and the Orca
   stub), call `toRow()` with a representative sample market and assert the
   return shape against the `MarketListRow` type: `key`, `lead`, `title`,
   `cells` (exactly 3), `onPress`, `a11yLabel`.

**Expected**
- All required fields present for every adapter. `cells` array has exactly
  3 entries, never 2 or 4 — the PRD's `[Cell, Cell, Cell]` tuple is a
  correctness constraint, not a suggestion.
- `a11yLabel` is present and non-empty for every row from every adapter —
  this is the direct test of AC-5 ("enforced by the row type"); if the type
  is truly enforced, a TypeScript compile check is the strongest form of
  this test, but still assert a real non-empty string at runtime since nothing
  stops an adapter from passing `a11yLabel: ''`.

#### LGC-ADAPT-002: `a11yLabel` is not just non-empty but describes the row meaningfully (AC-5)

**Priority:** P1 · **Automation:** unit

**Steps**
1. Inspect `a11yLabel` content for a perps row and a Meteora pool row.

**Expected**
- Label communicates enough to act on without seeing the row (e.g. includes
  the pair/symbol, not a generic "Row" or the row's array index). Exact
  copy is a judgment call — this case is about catching a placeholder/lazy
  implementation (`a11yLabel: title`) vs. one that's actually useful,
  flag as a review note rather than a hard pass/fail if the bar is
  ambiguous.

#### LGC-ADAPT-003: `columns` is always exactly a 3-tuple (`[ColumnSpec, ColumnSpec, ColumnSpec]`)

**Priority:** P1 · **Automation:** unit

**Steps**
1. Assert each adapter's `columns` array length.

**Expected**
- Length 3 for every adapter, matching the type.

#### LGC-ADAPT-004: `theme` is optional and only Meteora sets it (AC-8)

**Priority:** P1 · **Automation:** unit

**Steps**
1. Inspect `theme` on Pacifica/Phoenix (should be undefined/absent — no venue
   colour) vs. Meteora (should carry its palette).

**Expected**
- Pacifica and Phoenix adapters render with the shared shell's default
  styling (no `theme`). Meteora's adapter sets `theme` with its palette
  values. This distinguishes "shares the bones" from "shares the skin" per
  the PRD's decision summary.

#### LGC-ADAPT-005: Search mode matches each venue's actual strategy (perps local, Meteora remote)

**Priority:** P1 · **Automation:** unit

**Steps**
1. Inspect `search.mode` for Pacifica/Phoenix vs. Meteora.

**Expected**
- Pacifica/Phoenix: `'local'` (in-memory filter over ~50 rows).
- Meteora: `'remote'` (debounced server query). This is a contract-shape
  check that the PRD's "seam is at the row model, not at data fetching"
  decision actually held — if Meteora were coerced to `'local'`, it would
  imply the debounce/pagination-reset/race-guard logic got flattened, which
  the PRD explicitly says must not happen.

### 2.3 USDT mint consistency (AC-11, folded-in bug)

#### LGC-USDT-001: USDT mint is byte-identical in `knownTokens.ts` and `swap.api.ts` (AC-11)

**Priority:** P0 · **Automation:** unit

**Precondition:** Correction per on-chain verification (server planner): the
PRD's framing of which value is wrong is backwards.
`packages/tx-parser/src/constants/knownTokens.ts:4`
(`Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`) **is the real,
Jupiter-verified USDT mint** and is already correct. `swap.api.ts:25`
(`Es9vMFrzaCER7xN4k3qfKxuxMxDPZWS9Vyuk3F7S3w7P`) **does not exist on
mainnet** and is the value that needs fixing. The file expected to change is
`apps/hybrid-expo/features/swap/swap.api.ts`; `knownTokens.ts` stays as-is.

**Steps**
1. Compare the USDT mint constant in `knownTokens.ts`, `swap.api.ts`, and any
   other place a USDT mint is hardcoded (token identity snapshot's own USDT
   entry, if statically seeded, should also be checked).

**Expected**
- All occurrences equal `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`
  character-for-character. `swap.api.ts` specifically must have been
  corrected to this value; `knownTokens.ts` is the reference and should be
  unchanged by the fix.

#### LGC-USDT-002: swap flow correctly identifies real USDT after the fix

**Priority:** P0 · **Automation:** unit

**Steps**
1. Feed the swap flow (`swap.api.ts`'s `FALLBACK_TOKENS` / any USDT lookup
   path) a reference to the real USDT mint
   (`Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`).

**Expected**
- Resolves/matches as USDT correctly (pre-fix, `swap.api.ts` carried a mint
  that doesn't exist on mainnet, so anything routed through its USDT constant
  was silently wrong — a swap quote or balance check keyed on that value
  would never match real USDT holdings or real USDT liquidity).

### 2.4 Jupiter key no longer client-exposed (AC-10, folded-in bug)

#### LGC-JUP-001: `EXPO_PUBLIC_JUP_API_KEY` does not appear in the built client bundle (AC-10)

**Priority:** P0 · **Automation:** api-manual (bundle inspection)

**Precondition:** Today `swap.api.ts:39` reads
`process.env.EXPO_PUBLIC_JUP_API_KEY` and attaches it as an `x-api-key`
header directly from the client. The `EXPO_PUBLIC_` prefix is what causes
Expo to inline the value into the shipped JS at build time — this is not a
literal hardcoded secret in source, it's an env-var-naming-convention leak.
Write the test against that mechanism, not against finding a plaintext
string in `swap.api.ts`.

**Steps**
1. Build the client bundle (or inspect the Metro bundle output / source map).
2. Search the bundle for `EXPO_PUBLIC_JUP_API_KEY` and for any literal API
   key value.

**Expected**
- Neither the env var name's resolved value nor any Jupiter key literal
  appears anywhere in the client bundle.
- The swap flow's Jupiter calls are proxied server-side instead (mirroring
  the reasoning already written down for the Helius key in `spot.ts`) —
  confirm the client-side swap code no longer sets an `x-api-key` header
  itself at all.

#### LGC-JUP-002: Swap flow still works end-to-end with the key moved server-side

**Priority:** P0 · **Automation:** api-manual

**Steps**
1. Exercise a swap quote request through the app (or directly against the
   new server-side proxy endpoint) with the API running locally.

**Expected**
- Quote succeeds identically to before the key moved — this is a regression
  guard, not a new-behavior test. Needs a live network call to Jupiter (or a
  mocked upstream in a unit test if the proxy endpoint is testable
  in-process — prefer unit if feasible, falling back to api-manual only for
  the true end-to-end path).

### 2.5 No Tokens-sourced price displayed anywhere (AC-12)

#### LGC-PRICE-001: `TokenIdentity` responses never carry a price/quote field (AC-12)

**Priority:** P0 · **Automation:** unit

**Steps**
1. Inspect the `TokenIdentity` TypeScript interface and a live
   `/tokens/resolve` response.

**Expected**
- No `price`, `quote`, `marketCap`, or similar field exists on the type or
  in the response. The contract in the PRD deliberately excludes these — a
  test that only checks "the screen doesn't show it" without also locking
  the type down would let a future call site add one back silently.

#### LGC-PRICE-002: No screen sources its displayed price from the identity/Tokens call path (AC-12 — "Verified by review" per the PRD itself)

**Priority:** P0 · **Automation:** manual (code review, not testable via
assertion)

**Steps**
1. For each venue screen (Pacifica, Phoenix, Meteora), trace the data source
   of every price shown on a row back to its origin.

**Expected**
- Every displayed price traces to the venue's own market data (Pacifica/
  Phoenix mark price, Meteora pool price), never to a value that passed
  through `/tokens/resolve` or the identity snapshot table.
- **Note:** the PRD itself marks AC-12 as "Verified by review" — there is no
  automatable assertion that proves a negative like this across an entire
  app; the strongest automatable proxy is LGC-PRICE-001 (the type/contract
  never offers a price to begin with, so no call site *can* consume one by
  accident). Both cases together are the closest this criterion gets to
  being testable; log this pairing explicitly at review time rather than
  treating AC-12 as satisfied by LGC-PRICE-001 alone.

### 2.6 Never let identity block a market list (Risk section)

#### LGC-BLOCK-001: A cold or failed identity lookup degrades the icon, not the row (Risk: "Never let identity block a market list")

**Priority:** P0 · **Automation:** unit

**Steps**
1. Simulate `toRow()` being called with a market whose identity lookup has
   not resolved yet (background refresh still in flight) or has failed.

**Expected**
- The row still renders — with a letter-box/fallback icon — rather than the
  list throwing, blocking, or omitting the row entirely.
- This specifically tests that identity resolution happens on a background
  refresh path feeding an already-warm map, not inline in the request path
  that blocks the list — if `toRow()` or the adapter's `listMarkets()`
  awaits a live identity lookup per row, that's a fail against this risk
  even if it "works" (slowly); assert on latency/non-blocking behavior via a
  fake slow/never-resolving identity source, not just correctness.

### 2.7 Meteora's fabricated fields (Risk section)

#### LGC-METEORA-001: `normalizePortfolioToken` no longer hardcodes `decimals: 0` / `verified: true` (Risk: "Meteora's fabricated fields")

**Priority:** P0 · **Automation:** unit

**Precondition:** Today `data-api.ts` `normalizePortfolioToken` (~186) and
the inline token objects in `getOpenLimitOrderPools` (~558-573)
unconditionally hardcode `decimals: 0, verified: true` regardless of any
upstream data, unlike `normalizeToken` (~173) which at least reads
`raw.decimals`/`raw.is_verified` when present.

**Steps**
1. Call the fixed normalization path with a portfolio/limit-order token
   whose real decimals is non-zero (e.g. 6, like USDC) and whose real
   verified status is `false`.

**Expected**
- Output `decimals` reflects the token identity service's resolved value
  (via `/tokens/resolve`), not a hardcoded `0`.
- Output `verified` reflects a real verification result, not a hardcoded
  `true`.
- Any math downstream of these fields (the PRD calls out this exact risk —
  "any math downstream of those is wrong") should be spot-checked with a
  non-zero-decimals token to confirm a value that would previously have been
  computed wrong (e.g. treated as an integer with 0 decimals) is now correct.

#### LGC-METEORA-002: Same fix applied to all three fabrication sites, not just one

**Priority:** P0 · **Automation:** unit

**Steps**
1. Repeat LGC-METEORA-001's assertions against `normalizePortfolioToken`,
   and separately against both inline token-object literals in
   `getOpenLimitOrderPools` (tokenX and tokenY).

**Expected**
- All three sites use the identity service (or at minimum stop hardcoding),
  not just the one most likely to be noticed first. The PRD explicitly notes
  this is "hardcoded... in a second, independent place" — treat each site as
  its own case rather than assuming a fix to one implies the others were
  touched.

#### LGC-METEORA-003: Meteora's own `icon` survives as a second-tier fallback (Risk: "Long-tail coverage is thin by design")

**Priority:** P0 · **Automation:** unit

**Precondition:** A token that is a Tokens-registry singleton (unresolved,
per SRV-RESOLVE-004) but for which Meteora's own API response carries a
usable `icon` URL — realistic for brand-new pool tokens, which the PRD says
Meteora lists constantly and Tokens won't have indexed yet.

**Steps**
1. Normalize a token in this state through the fixed `normalizeToken`/
   `normalizePortfolioToken` path.

**Expected**
- The row's icon is Meteora's own `icon` value (proxied through our origin
  per AC-1), not the generic letter-box fallback — even though the identity
  service itself returned unresolved for this mint.
- This is explicitly a case where "unresolved from Tokens" must **not**
  collapse to "no icon" — the PRD says keep Meteora's icon as a second-tier
  fallback rather than deleting it. A naive implementation that always
  prefers "identity service says unresolved → show letter box" and discards
  Meteora's own data would fail this case while passing SRV-RESOLVE-004; the
  two cases together are what prove the fallback chain has the right number
  of tiers (identity icon → venue-supplied icon → letter box), not just two.

---

## 3. CLIENT layer

All CLIENT cases assume SERVER and LOGIC layers pass first — a client-visible
bug that's actually a server contract violation belongs in section 1 or 2,
not re-litigated here as a fourth thing.

### 3.1 Cross-venue consistency (shared shell)

#### CLI-SHELL-001: Icons on all three screens come from our origin, none from a third-party host (AC-1)

**Priority:** P0 · **Automation:** device (network inspection) — can also be
approximated via a network-request assertion in an integration test if the
app's test harness supports intercepting requests; otherwise manual with dev
tools / a proxy.

**Steps**
1. Open Pacifica market list, Phoenix market list, Meteora pools list on
   device/simulator.
2. Inspect network requests for icon images on each screen.

**Expected**
- Every icon request's host matches our API origin. Zero requests to
  `app.pacifica.fi`, any Meteora CDN, `trustwallet`, or `solana-labs` GitHub
  raw content across all three screens.

#### CLI-SHELL-002: Same token shows the identical icon on all three screens (AC-1, AC-3)

**Priority:** P0 · **Automation:** device

**Precondition:** A token that trades on all three venues simultaneously
(e.g. SOL or USDC, if listed on Pacifica perps, Phoenix perps, and a Meteora
pool).

**Steps**
1. Screenshot or inspect the icon for that token on each of the three
   screens.

**Expected**
- Pixel-identical (or at minimum, visually identical — same crop, same
  background, same rounding) icon across all three. This is the PRD's
  headline visible fix: "Pacifica shows a real BTC logo; Phoenix shows a
  grey circle... Meteora shows a third icon."

#### CLI-SHELL-003: Unknown-token fallback is identical across all three venues (AC-3)

**Priority:** P0 · **Automation:** device

**Precondition:** A token/market with no resolvable identity on each of the
three venues (may need to be synthetically forced per venue if no natural
unresolved token exists on all three simultaneously — acceptable to test
each venue independently against the same expected fallback spec, if a
single shared token can't be arranged).

**Steps**
1. Trigger the fallback state on Pacifica, Phoenix, and Meteora.
2. Compare box shape, color, letter, and rounding.

**Expected**
- Identical presentation on all three — same box, same colour, same letter,
  computed server-side (`fallbackLetter` from the identity contract).
- Specifically regress-test that Meteora's current cyan-for-tokenX /
  violet-for-tokenY arbitrary position-based coloring (today's
  `MeteoraPoolsScreen.tsx` `METEORA.cyan`/`METEORA.violet`, keyed on
  left/right position not on the token itself) is gone — two different
  unknown tokens in the same pool row must no longer get different colors
  just because one is listed first.

### 3.2 Pacifica-specific

#### CLI-PACIFICA-001: Empty state renders when search matches nothing (AC-4)

**Priority:** P0 · **Automation:** device

**Precondition:** Today's `PacificaMarketListScreen.tsx` has no
`ListEmptyComponent` at all — a no-match search renders a blank list.

**Steps**
1. Open Pacifica market list.
2. Search for a string matching no market (e.g. `zzzznotarealmarket`).

**Expected**
- A visible empty state renders (message text, not a blank screen) —
  matching the shared shell's empty state per the PRD ("Pacifica gains the
  empty state" in Step 3 of Sequencing).

#### CLI-PACIFICA-002: Pacifica rows carry a11y labels (AC-5)

**Priority:** P0 · **Automation:** device (accessibility inspector) — unit
test can cover this at the adapter level (LGC-ADAPT-001); this case is the
device-level confirmation that the label actually reaches the rendered
`Pressable`/accessibility tree, not just the data model.

**Steps**
1. Enable VoiceOver/TalkBack or use the accessibility inspector on the
   Pacifica list.
2. Focus a market row.

**Expected**
- Row announces a meaningful label (not silent, not just "Button"). Today's
  screen has no `accessibilityLabel` on `MarketRow`'s `Pressable` at all —
  this is a real regression-catch, not a formality.

### 3.3 Phoenix-specific

#### CLI-PHOENIX-001: Phoenix rows show real token logos, not the hardcoded null (AC-2)

**Priority:** P0 · **Automation:** device

**Precondition:** Today `phoenix.ts:760` hardcodes `iconPath: null`
unconditionally.

**Steps**
1. Open Phoenix market list.
2. Inspect icons for several markets, including at least one that also
   trades on Pacifica.

**Expected**
- Real logos render, not letter-box fallbacks, for any token resolvable via
  the identity service — this is called out in the PRD as "the single most
  visible fix in the plan."
- The token that also trades on Pacifica shows the same icon on both screens
  (ties back to CLI-SHELL-002).

#### CLI-PHOENIX-002: Phoenix retains its existing empty state and a11y labels after migration to the shared shell (regression guard)

**Priority:** P1 · **Automation:** device

**Steps**
1. Search Phoenix with no matches; inspect a11y labels on rows.

**Expected**
- Empty state and a11y labels still present post-migration — Phoenix already
  had both pre-PRD; the migration to the shared shell must not regress them
  while fixing Pacifica up to the same bar.

### 3.4 Meteora-specific

#### CLI-METEORA-001: Meteora keeps its own palette on the shared shell (AC-8)

**Priority:** P0 · **Automation:** device

**Steps**
1. Open Meteora pools screen post-migration.

**Expected**
- Meteora's brand colours (violet/cyan or whatever the adapter's `theme`
  token specifies) are visually present — the screen does not look
  reskinned into the app's default palette. "Same bones, different skin."

#### CLI-METEORA-002: Sort sheet, filter chips, and pagination remain intact (PRD: "It keeps top-positioned search, its sort sheet, its filter chips, its pagination")

**Priority:** P0 · **Automation:** device

**Steps**
1. Exercise Meteora's sort sheet (open it, pick a sort option).
2. Exercise filter chips.
3. Scroll to trigger pagination / infinite scroll.

**Expected**
- All three continue to function exactly as before migration — these pass
  through the shell's `header`/`footer` slots untouched per the PRD's
  explicit design; none of them were meant to be unified away.

#### CLI-METEORA-003: Meteora's debounced remote search and request-id race guarding still work post-migration

**Priority:** P0 · **Automation:** device (ideally paired with a
frontend-dev-state-level integration test if the harness supports simulating
out-of-order network responses; otherwise manual — type quickly, verify no
stale results flash in)

**Steps**
1. Type a fast sequence of characters into Meteora's search, changing the
   query multiple times within the debounce window.

**Expected**
- Only the result set for the final query is shown — no flash of a stale
  intermediate result set caused by an earlier, slower request resolving
  after a later, faster one. This is the exact scenario the PRD's "seam is
  at the row model, not at data fetching" decision is protecting; a
  regression here would mean the shared shell accidentally absorbed
  Meteora's search into a generic `search` prop and dropped the race guard.

#### CLI-METEORA-004: Fabricated `decimals`/`verified` fix is visible in a real balance/amount display

**Priority:** P1 · **Automation:** device

**Precondition:** Portfolio or limit-order view showing a token whose real
decimals differ from 0 (pairs with LGC-METEORA-001).

**Steps**
1. Open a Meteora portfolio position or limit order involving a token with
   non-zero real decimals.

**Expected**
- Displayed amount is correct for that token's real decimals, not computed
  as if decimals were 0.

### 3.5 Orca stub — plug-and-play proof (AC-7)

#### CLI-ORCA-001: Orca adapter requires only a new adapter file + registry entry, no new screen (AC-7)

**Priority:** P0 · **Automation:** unit (for the adapter conformance itself,
via LGC-ADAPT-001 against the Orca stub) + manual code-diff review (for the
"no new screen" claim, which is inherently about what files changed, not
runtime behavior)

**Steps**
1. Review the diff that adds the Orca stub adapter.
2. Confirm: a new adapter object/file and a registry entry are the only
   additions; no new `.tsx` screen file, no new style block, no
   venue-specific `FlatList`/list-rendering code.

**Expected**
- Orca appears as a working (even if minimally populated) market list using
  the exact same `<MarketList>` shell component as Pacifica/Phoenix/Meteora.
- This is explicitly the acceptance test for the abstraction itself per the
  PRD's Sequencing: "This is acceptance criterion 7 and it is the actual
  test of whether the abstraction worked" — treat a passing unit-level
  adapter-conformance check as necessary but not sufficient; the "no new
  screen" half of the claim can only be confirmed by looking at what files
  were touched.

#### CLI-ORCA-002: Orca tile on the home grid becomes enabled once the adapter is registered (context: HomeScreen's 58%-opacity dead-tile pattern)

**Priority:** P1 · **Automation:** device

**Precondition:** Today `HomeScreen.tsx`'s `MARKET_APPS` entry for `orca` has
no `route` field, producing `disabled: true` and `opacity: 0.58` via
`marketAppTileDisabled`.

**Steps**
1. After the Orca stub adapter is registered and wired to a route, open the
   home grid.
2. Tap the Orca tile.

**Expected**
- Orca tile is no longer at 58% opacity / disabled state; tapping it
  navigates to the Orca market list rendered via the shared shell.
- Note: this may be considered beyond strict P0 scope if the stub is
  adapter-only and deliberately not wired into `HomeScreen.tsx`'s routing —
  confirm which the implementation intends; if the stub stops at "adapter
  exists and conforms" without a live route, mark this case N/A and note
  that AC-7 is still satisfied by CLI-ORCA-001 alone (the PRD's wording is
  "requires a new adapter file and a registry entry," which doesn't strictly
  require home-grid wiring).

---

## Traceability — Acceptance Criteria to Test Cases

| AC | Text (abridged) | Covering cases |
|---|---|---|
| AC-1 | Icons from our own origin on all three venues; no third-party host | SRV-ICON-001, CLI-SHELL-001, CLI-SHELL-002, LGC-METEORA-003 |
| AC-2 | Phoenix shows real logos, not unconditional `null` | CLI-PHOENIX-001 |
| AC-3 | Missing-from-snapshot token renders identical fallback on all three venues, server-computed | SRV-RESOLVE-004, CLI-SHELL-003 |
| AC-4 | Pacifica empty state on no-match search | CLI-PACIFICA-001 |
| AC-5 | Every row carries an a11y label, enforced by the row type | LGC-ADAPT-001, LGC-ADAPT-002, CLI-PACIFICA-002 |
| AC-6 | One formatPrice, one formatChange, one formatUsdCompact, one no-data glyph | LGC-FMT-001, LGC-FMT-002, LGC-FMT-003, LGC-FMT-004, LGC-FMT-005 |
| AC-7 | Fourth venue = new adapter file + registry entry, no new screen; demonstrate with a stub | LGC-ADAPT-001 (Orca instance), CLI-ORCA-001, CLI-ORCA-002 |
| AC-8 | Meteora retains its own palette on the shared shell | LGC-ADAPT-004, CLI-METEORA-001 |
| AC-9 | Entire Tokens integration behind one feature flag + one env var; off degrades to venue icons, keeps working | SRV-FLAG-001, SRV-FLAG-002 |
| AC-10 | `EXPO_PUBLIC_JUP_API_KEY` no longer in the client bundle | LGC-JUP-001, LGC-JUP-002 |
| AC-11 | USDT mint identical everywhere | LGC-USDT-001, LGC-USDT-002 |
| AC-12 | No screen displays a Tokens-sourced price (verified by review, per the PRD) | LGC-PRICE-001, LGC-PRICE-002 |

### Risks and Failure Modes (PRD section) to test cases

| Risk | Covering cases |
|---|---|
| Unresolved is a 200, not an error | SRV-RESOLVE-004 |
| Long-tail coverage is thin by design (keep Meteora's own icon as 2nd-tier fallback) | LGC-METEORA-003 |
| In-memory caches will not hold on multi-instance deploy | Not covered — see "Untestable / out of reach" below |
| Never let identity block a market list | LGC-BLOCK-001 |
| Meteora's fabricated fields (`decimals: 0`, `verified: true`) | LGC-METEORA-001, LGC-METEORA-002, CLI-METEORA-004 |
| Never through fuzzy search (perp symbol map) | SRV-PERP-003 |

---

## Untestable / out of reach as written

- **"In-memory caches will not hold" (multi-instance deploy risk).** The PRD
  names this as a real risk but explicitly says the nightly-snapshot design
  "mostly sidesteps this for Tokens" and defers the actual fix ("the icon
  proxy still needs a CDN in front before it matters") — there is no P0
  acceptance criterion attached to it, and single-process local dev
  (`pnpm api`) cannot exercise multi-instance cache divergence at all. No
  test case is written against it. If this needs coverage before ship,
  it needs either a load-balanced staging environment or an explicit
  decision that it's post-P0 — flagging back to the PRD author rather than
  writing a case that can't actually fail in the environment available.
- **AC-12 ("No screen displays a Tokens-sourced price") is marked "Verified
  by review" in the PRD itself**, not by a testable assertion. LGC-PRICE-001
  and LGC-PRICE-002 are the closest coverage available (contract-level
  guarantee + manual trace), but neither is a single automated check that
  can fail on its own the way the other eleven criteria's cases can. This
  is the PRD author's own framing, not a gap I'm introducing — noted here so
  it isn't miscounted as "covered by a real test" during review.
- **SRV-FLAG-001/002 (AC-9)** depend on whether the feature flag is a
  boot-time branch (gates what `create-app.ts` mounts) or a runtime branch
  (gates behavior inside an already-mounted route). The PRD doesn't specify
  which, and the two require different test strategies (process restart vs.
  in-process toggle). Written against the runtime-branch assumption as the
  more testable and more gracefully-degrading reading; flag to the PRD
  author if boot-time gating was actually intended, since that changes both
  the implementation and how SRV-FLAG-001 needs to be written.
- **CLI-ORCA-002 (home-grid wiring)** is written against a reading of AC-7
  that may be stricter than the PRD intends — see the case's own note. The
  PRD's Sequencing step 5 says "Stub a fourth adapter... and confirm it needs
  no new screen," which doesn't explicitly require home-grid routing. Flagged
  as an assumption, not invented as fact.
- **Funding label mismatch (`Fund/8h` vs `Fund/1h`)** is explicitly called
  out in the PRD's Open Questions as "not folded into this PRD until that
  answer exists" — correctly out of scope, no case written, noted here only
  so its absence isn't mistaken for an oversight.
