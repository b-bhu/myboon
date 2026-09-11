# Product Improvement Proposal — myboon

**Date:** 2026-08-12
**Scope:** Full end-to-end review of the app — every screen, every state, UX + engineering + mobile-native feel
**Method:** 6 independent AI reviewers, one per flow, each walking the screens from source; findings then verified by hand against the code and against Solana mainnet
**Goal:** Move UX from a self-assessed **3/10 to 9/10**

> **Current-status note (2026-08-29):** This audit records the app as it existed
> before commit `192965c`. That commit added the first direct Story-to-market
> path: Bitcoin Stories can open Phoenix BTC, and researched events appear on
> the market chart. The audit remains useful, but statements that the feed has
> *zero* actions or that the connection is structurally absent are now historical.
> The broader, asset-agnostic Story-to-market loop is still incomplete.

---

## The one-paragraph version

The bones are better than a 3. Four venues are integrated end-to-end, the Polymarket bet lifecycle is genuinely well modelled, and Meteora has real transaction-recovery states most teams never build. What drags it to a 3 is not missing features — it's that **the app never became an app**. There's no tab bar, no onboarding, no notifications, type is routinely 7–8px, errors are OS dialogs, and several prominent buttons are decoys that do nothing. On top of that sit four confirmed correctness bugs in real-money paths. The path to 9 is mostly *subtraction and finishing* — not building more surface area.

**Per-flow ratings from the reviewers:**

| Flow | Rating | One-line verdict |
|---|:--:|---|
| Polymarket | 5/10 | Best flow in the app; 3 taps to bet. Held back by missing market rules and 7pt type |
| Onboarding / Home / Wallet | 4/10 | No onboarding at all; connect is buried ~900px down |
| Feed | 4/10 | At audit time it was a dead end; one Bitcoin-to-Phoenix action path now exists, but general coverage remains incomplete |
| Perps (Pacifica/Phoenix) | 4/10 | Pacifica solid, Phoenix is a hollow copy of it. Stale-order bug |
| Meteora | 4/10 | Most engineered flow; users still choose pools blind (no APR) |
| Swap | 2/10 | Unreachable, fake balances, dead CTA, wrong token address |

---

## Part 1 — Confirmed defects (verified by hand, not just reported)

These four I checked myself. They are not opinions.

### 1.1 Pacifica can execute a stale order — wrong type, dropped TP/SL
`features/perps/PacificaMarketDetailScreen.tsx:326-341`

`handlePressIn` starts an 800ms timer that calls `executeOrder()`. Its dependency array is `[connected, address, amountUsdc, buttonState]` — it does **not** include `executeOrder`. But `executeOrder` depends on `orderType`, `limitPriceText`, `tpPriceText`, `slPriceText` (line 444).

So: type an amount → switch Market to Limit → hold to confirm → **a market order goes out**. Same for TP/SL edited after the amount: silently dropped. This is real money, executed differently from what the screen displays.

**Fix:** hold the latest `executeOrder` in a ref, or add it to the deps. One-line class of fix, highest severity item in this document.

### 1.2 The swap screen's USDT is not USDT
`features/swap/swap.api.ts:22`

The fallback token list has USDT as `Es9vMFrzaCER7xN4k3qfKxuxMxDPZWS9Vyuk3F7S3w7P`. The real mint is `Es9vMFrzaCERZ7xN4k3qfKxuxMxDPZWS9Vyuk3F7S3w7P` — the code is missing `Z`.

I queried Solana mainnet directly: the in-code address returns `value: null` — **the account does not exist on chain**. It is a valid-looking 32-byte pubkey, so nothing catches it statically.

Harmless today only because swap can't execute. It becomes a fund-loss bug the day it ships.

**Fix:** correct the address, and add a test that base58-decodes every hardcoded mint and asserts it resolves to a real token account.

### 1.3 The connect sheet dead-ends the users most likely to need it
`features/wallet/components/ConnectionSheet.tsx:334`

```
const isConnected = step.kind === 'options' && connectedWallets.length > 0;
```

This asks "is *any* wallet connected?" — not "is the *requested chain* connected?" A user with Solana connected who triggers an EVM connect (Polymarket profile does exactly this when `poly.signer` is null) gets shown their Solana address and a Disconnect button, with no way to connect the chain that was asked for.

The Polymarket setup flow is unreachable for precisely the users trying to reach it.

**Fix:** key the check on the requested chain having an address.

### 1.4 Typography is below platform minimums, everywhere
Counted across `features/` and `components/`:

| Size | Rules |
|---|---|
| 6–8px | **119** |
| 8.5–10px | **107** |
| Under 11px total | **226** |

Apple's guidance floor is 11pt; Material's is 12sp. **226 style rules sit under it.** This single fact explains most of the "feels like a cramped desktop terminal" impression, across every flow independently — all six reviewers flagged it without coordinating.

**Fix:** set a floor of 11px for labels, 13px for body, 15px+ for anything a user must read to make a money decision. Mechanical, one PR, and the largest single visible improvement available.

---

## Part 2 — Why it's a 3, structurally

Five root causes. Almost every individual complaint traces back to one of them.

### Theme A — It has the shape of a website, not an app

A complete `BottomGlassNav` tab bar exists at `features/feed/components/BottomGlassNav.tsx` — with haptics, a11y roles, active states. **Nothing imports it.** Verified: the only references to the symbol are its own definition.

Instead, Home is a ~920px vertical mega-scroll with billboard headings (Feed / Markets / Wallet) and a "route card" acting as navigation. Every venue is a pushed leaf you escape with a back arrow.

Supporting evidence:
- `react-native-gesture-handler`: **0 files** → no swipe-back, no swipe-to-dismiss sheets
- `KeyboardAvoidingView`: **1 file** across 46,000 lines → keyboards cover the inputs that opened them, reported independently in perps, swap, and Polymarket withdraw
- Sheets are `Modal animationType="fade"` — bottom panels that *fade*. Tapping the scrim doesn't dismiss. Every native instinct fails.
- `ScrollView` in 17 files vs `FlatList`/`SectionList` in 5 → long lists render every row

### Theme B — The core promise was not wired up at audit time

The pitch is `market moves → myboon explains → you open the market → positions track it`. At audit time, **the arrow from Feed to Markets did not exist in code.** Commit `192965c` has since added a focused proof: a Bitcoin Story can open Phoenix BTC, and the chart shows researched event markers. This closes one demonstrated path, not the generalized system. Other Stories still need reliable asset and venue mapping, and evidence/receipt presentation remains incomplete.

Compounding it: **`expo-notifications` appears in 0 files.** A product whose value is *timely* context has no way to reach the user when the thing happens. The user must remember to open the app — which inverts the entire proposition.

This is the biggest product gap in the document. Everything else is polish by comparison.

### Theme C — Decoys erode trust, and this is a money app

Things that look interactive and aren't:
- Swap: **unreachable** (nothing routes to `/swap` — only a stale entry in `feed.mock.ts`), header says **"Feed"** (`FeedHeader` hardcodes the title, takes no props), balances are `MOCK_BALANCES` constants that Half/Max compute against, CTA is a permanent `COMING SOON`, "Custom" slippage silently applies 0.5%, Market/Limit tabs are static `View`s
- Home: Orca/Raydium/Kamino tiles are dimmed and dead on tap, with no label saying why
- Home: Send/Receive/Transfer look enabled, show "Coming soon" on tap — a *different* convention from the tiles right above them
- Phoenix: TP/SL fields accept input and are **silently ignored** on submit; "Remove All TP/SL" is permanently disabled
- Polymarket: an odds-format preference is built and persisted, but unreachable
- Pacifica: the "History" tab is local AsyncStorage that only logs closes made from that one screen — it presents device state as account history

In a wallet, a button that lies is worse than a button that's absent. Receive in particular could ship this week: the address already exists — show a QR and a copy button.

### Theme D — No query layer, so every screen re-invents data fetching

Verified: **no `@tanstack/react-query`, no `swr`, anywhere in the monorepo.** Every screen hand-rolls fetch + loading + error + polling. There are **16 `setInterval` call sites** in `features/`.

Downstream symptoms, all reported separately as if unrelated:
- Skeleton flash every time you move Home → Feed (same data, refetched from zero)
- Feed auto-refreshes every 5 minutes and resets the list under the reader
- Offset pagination against a live feed produces duplicate rows
- Wallet hero renders a partial sum as "your total" — it visibly climbs as 4 sources land
- Polling storms on detail screens, some unguarded when backgrounded
- Meteora runs three independent API client instances with three separate caches
- Nothing is cached, so nothing works offline, even briefly

One library removes an entire category of bugs.

### Theme E — Copy-paste per venue instead of the adapter that already exists

`features/` is 45,939 lines. `perps/` is 12,359 and `predict/` is 11,913 — with ~1,100 lines duplicated between the two Polymarket detail screens, and Pacifica/Phoenix as two full copies of one venue.

Seven files exceed 1,200 lines; `PhoenixProfileScreen.tsx` is **2,374**.

Meanwhile a ~600-line venue-adapter contract sits **unused**. That's why Phoenix is a hollow clone: fixes land on Pacifica and never propagate. Each new venue currently costs a full screen stack.

---

## Part 3 — What 9/10 looks like

Concretely, a user's first two minutes:

1. **Open → a 3-card intro** stating what myboon does, then one clear "Get started". Not a dark scroll they must decode.
2. **A tab bar, always there:** Feed · Markets · Portfolio. Location is never in question; back arrows stop being the only way out.
3. **Feed cards carry live signal** — relative time ("14m ago"), a NEW treatment, the entity, the source. And every card ends in an action: *"BTC funding flipped negative" → [Open BTC on Pacifica]*. The loop closes.
4. **A push arrives** when a market they hold moves, or a story they read develops. That's the retention engine, and it's the reason to keep the app installed.
5. **Any market opens in ≤3 taps**, with legible type, real rules, and honest numbers. Buttons that can't act aren't shown.
6. **Portfolio is one screen** across all four venues — not four separate profile screens behind four separate icons.
7. **Errors appear in-flow** as a banner with a retry, in plain language. Never an OS dialog with a raw string. (There are **33 `Alert.alert`** call sites today.)

---

## Part 4 — Sequenced roadmap

### NOW — 2 weeks. Correctness and honesty. (3 → 5)

Nothing here is architectural. This is stopping the bleeding.

| # | Item | Why | Effort |
|---|---|---|---|
| 1 | Fix the stale hold-to-confirm closure | Executes orders the user didn't place | XS |
| 2 | Fix the USDT mint + add a mint-resolution test | Wrong-token risk the day swap ships | XS |
| 3 | Fix `ConnectionSheet` to key on requested chain | Unblocks Polymarket setup | XS |
| 4 | Typography floor pass (11/13/15px) | 226 rules under minimum; biggest visible win | S |
| 5 | Either route to `/swap` or delete it | It ships in the bundle as a broken screen | XS |
| 5b | Delete the 13 truly-orphaned files (see Part 4b) — **keep `BottomGlassNav` + `feed.mock`** | ~900 lines out; the tab bar gets mounted in NEXT instead | XS |
| 6 | Delete or honestly label every decoy | Trust; 4 "coming soon" sites + dead tiles + fake tabs | S |
| 7 | Ship Receive (QR + copy) | Address already exists; converts a decoy into value | S |
| 8 | Wire Phoenix TP/SL or remove the fields | Silently ignoring money input is indefensible | S |
| 9 | Separate "no account" from "request failed" | Today a network blip tells users to deposit | S |
| 10 | Add `restoring` state to `useWallet` | Returning users flash "disconnected" every launch | S |
| 11 | Swap the inverted YES/NO chart colors | Red YES / green NO, contradicting every other surface | XS |
| 12 | Show Polymarket market rules + resolution source | Users bet without knowing settlement terms | S |

### NEXT — 1–2 months. Structure. (5 → 7)

| # | Item | Why | Effort |
|---|---|---|---|
| 13 | **Mount the tab bar**, break up the mega-scroll | The single biggest "is this an app?" fix. Component is already built | M |
| 14 | **Adopt React Query** across feed, wallet, venues | Kills ~8 reported bugs at the root; enables offline | M–L |
| 15 | **Onboarding: 3 cards + a clear connect** | There is literally none today | M |
| 16 | Replace `Alert.alert` with in-flow banners + haptics | 33 sites; errors stop feeling like crashes | M |
| 17 | Real bottom sheets (gesture-handler): swipe + scrim dismiss | Native instincts currently fail everywhere | M |
| 18 | Reconnecting WebSocket + staleness badge | "Live" prices silently freeze today | M |
| 19 | Show APR on Meteora rows | The one number LPs choose on; API already returns it | S |
| 20 | Show amounts before signing Claim/Remove | Never sign what you can't see | M |
| 21 | `KeyboardAvoidingView` pass | 1 file across 46k lines | S |
| 22 | Slippage bound on Phoenix market orders | Unbounded execution today | S |

### LATER — 3–6 months. Differentiation. (7 → 9)

| # | Item | Why | Effort |
|---|---|---|---|
| 23 | **Generalize the Story→market loop** beyond the completed Bitcoin→Phoenix path: entity chips, asset mapping, and relevant market links | This is the product connection; the first proof exists, but coverage must become systematic | L |
| 24 | **Push notifications** | Timely context can't be pull-only; the retention engine | L |
| 25 | **Unified portfolio** across all four venues | Turns four venue integrations into one product | L |
| 26 | Migrate both perps venues onto the adapter, delete the copies | Removes ~5k duplicated lines; new venues get cheap | L |
| 27 | Build the swap execution path (server-proxied) | Also fixes the Jupiter key currently bundled client-side | L |
| 28 | Receipts/sources in the article sheet | "Evidence-backed" is a stated vision pillar, currently absent | M |

---

## Part 4b — Dead code inventory

Traced properly: a reachability walk from every expo-router entry point in `app/`, following `@/` alias and relative imports, and accounting for platform variants (`.native.ts` / `.web.ts`).

**200 files scanned → 167 reachable → 15 orphaned non-test files, 1,009 lines.**

That's smaller than the "junk everywhere" impression, and it's worth knowing the codebase is mostly live. But the orphans are concentrated in a revealing place.

### Orphaned files (1,009 lines) — 13 to delete, 2 to keep

The two marked ⚠️ are the unmounted tab bar. They are technically dead, but they are the fix for the biggest problem in this document. **Delete the other 13 (~900 lines).**

| Lines | File | What it is | Last touched |
|---:|---|---|---|
| 255 | `features/predict/profile/RedeemableSection.tsx` | Orphaned when Polymarket moved to the signer layer | 2 weeks |
| 145 | `components/AnimatedInput.tsx` | Superseded input component | 3 months |
| 137 | `features/perps/perps.registry.ts` | Old per-venue registry, replaced by `features/markets/venue.registry.ts` | 2 weeks |
| 102 | ⚠️ `features/feed/components/BottomGlassNav.tsx` | **The tab bar you built and never mounted — KEEP, see below** | 2 weeks |
| 89 | `features/predict/profile/PerfStrip.tsx` | Orphaned in the profile-lifecycle rework | 4 months |
| 53 | `constants/theme.ts` | **create-expo-app boilerplate** — still has the scaffold comment | 7 months |
| 53 | `features/navigation/SectionPlaceholderScreen.tsx` | Placeholder from nav consolidation | 4 months |
| 46 | `features/predict/components/StatsStrip.tsx` | Orphaned in the detail-screen redesign | 4 months |
| 42 | `features/meteora/components/MeteoraProfileButton.tsx` | Superseded by the shared profile button | 3 weeks |
| 29 | `features/feed/components/ProgressBar.tsx` | From the original app shell | 5 months |
| 21 | `hooks/use-theme-color.ts` | Boilerplate; only consumer of `constants/theme.ts` | 7 months |
| 21 | `hooks/use-color-scheme.web.ts` | Boilerplate | 7 months |
| 8 | ⚠️ `features/feed/feed.mock.ts` | `BOTTOM_NAV_ITEMS` — nav config for that tab bar — **KEEP, see below** | 2 weeks |
| 7 | `features/perps/perps.api.ts` | Barrel that nothing imports | 3 months |
| 1 | `hooks/use-color-scheme.ts` | Boilerplate | 7 months |

Four of these (`constants/theme.ts`, both `use-color-scheme*`, `use-theme-color.ts`) are **create-expo-app scaffolding that has never been used** — they form a closed island importing only each other. Deleting `constants/theme.ts` alone requires deleting `use-theme-color.ts`, its only consumer.

### Dead exports inside live files

Files that are reachable but carry unused exports — these won't show up in any file-level sweep:

- `features/feed/feed.api.ts` → `getApiBaseUrl`, `toRelativeTime`, `fetchSimpleExplanation`, `detectSlugType`, `extractSport`, `fetchPredictMarket`
- `features/predict/predict.api.ts` → `fetchCuratedMarkets`, `fetchSportsMarkets`, `fetchMarketPrice`, `wrapPolymarketCash`

`fetchSimpleExplanation` is the "Explain Simply" feature — built, wired to an endpoint, never surfaced in the UI. Either ship it or cut it; right now it's a maintained API contract with no user.

Note `toRelativeTime` already exists and is unused — while Part 2 recommends adding relative timestamps to feed cards. The helper is sitting right there.

### NOT dead — do not delete (my first sweep got this wrong)

`features/markets/`, `features/orca/`, and the three `*.adapter.ts` files look orphaned to a naive import grep, but they are **live and new** on `feat/token-identity-venue-adapters`. They're reached through `app/markets/[venueId].tsx`, a dynamic catch-all route where expo-router resolves by filename at runtime rather than by a static import anyone can grep.

This is the venue-adapter work in progress — the thing Theme E says the codebase needs. It's the opposite of junk.

**Caveat worth stating:** any file-based-routing project has this blind spot. Route files are entry points that nothing imports, and dynamic segments resolve at runtime. Trace reachability from `app/` rather than trusting a plain grep, and always check `git status` before deleting — new work looks identical to abandoned work from the import graph alone.

### What the pattern says

Nine of the fifteen orphans were created by refactors that landed the new thing and left the old one in the tree. The 2-week-old cluster all traces to one commit, `2f02f20` ("one connection surface, consistent app routes and naming"). The habit to fix is deletion-as-part-of-the-refactor, not a periodic cleanup sweep.

And the standout finding: **the tab bar and its nav config are sitting in the dead-code pile.** The single highest-impact fix in this document — Theme A, "it has the shape of a website" — is a component you already wrote, currently classified as junk. Don't delete `BottomGlassNav.tsx` and `feed.mock.ts`; mount them.

---

## Part 5 — Things the reviewers under-weighted

Worth saying plainly, because none of the flow reviews owned these:

1. **`EXPO_PUBLIC_JUP_API_KEY` is bundled into the client.** Anything `EXPO_PUBLIC_*` ships inside the app binary and is extractable. Rotate it and proxy Jupiter server-side. (There's a real key committed in `apps/hybrid-expo/.env` — treat it as compromised.)
2. **Meteora defaults to the public mainnet RPC**, hit on every preview. It will rate-limit under any real load; the sluggishness is partly this.
3. **There is no cold-start story.** A funded, experienced user is assumed everywhere. A user with $0 sees empty tables and dead buttons and has no reason to return tomorrow.
4. **No analytics.** You cannot prove 3→9 without instrumenting the funnel. Add it in the NOW phase or the rest is unmeasurable.
5. **Perf on cheap Android** is untested, and `ScrollView`-heavy lists plus 16 intervals plus a 1-second whole-screen re-render in Meteora will show up there first.
6. **Regulatory copy is absent** on real-money surfaces.

---

## Part 6 — Metrics to prove the rating moved

1. **Connect rate** — % of first sessions that connect a wallet (no baseline exists; nothing is instrumented)
2. **Story→market rate** — % of Story reads that open a relevant market. The Bitcoin→Phoenix path now makes this measurable; it is the sharpest single indicator
3. **Time-to-first-action** — install → first bet/trade/LP
4. **Error-visible rate** — % of sessions showing an error state; watch it fall as React Query lands
5. **D7 retention**, split by push-enabled vs not — the direct test of whether notifications are the retention engine

---

## Appendix — Method and honesty notes

- 13 agents were dispatched; **6 completed** before the session hit its token limit. The 6 that landed covered the entire core user loop: onboarding/home/wallet, feed, Polymarket, perps, Meteora, swap.
- The 4 that died (navigation/design-system, engineering health, mobile-native feel, web landing page) and the 3 synthesis agents were **reconstructed by hand** via direct codebase measurement — that's the source of the font-size census, the gesture-handler/notifications/keyboard counts, the query-layer check, the `Alert.alert` count, and the line-count analysis. The web landing page (`apps/web`) was **not** reviewed in depth and remains an open gap.
- Every claim in Part 1 was independently verified against the code, and the USDT mint against Solana mainnet. Where a reviewer overstated a finding it was corrected: the bad USDT address was reported as malformed, but it is in fact a *valid* 32-byte pubkey pointing at a non-existent account — which is worse, because no static check catches it.
- Ratings are the reviewers' own, on a consistent 1–10 scale, and land in a tight 2–5 band that matches the team's self-assessed 3.
