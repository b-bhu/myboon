# Predict Experience Redesign PRD

Status: draft for review
Date: 2026-08-23
Owner: myboon Apps
Builds on: `docs/modules/polymarket/PRDs/2026_07_30_polymarket_account_setup_PRD.md` (account setup flow),
`docs/modules/polymarket/PRDs/2026_07_31_polymarket_sdk_migration_PRD.md` (SDK/signing chain)

**Mock references** — the six screens this PRD implements, plus shared system:

| Screen | Mock | Live route today |
|---|---|---|
| Discover | `docs/mockups/polymarket-discover.html` | `apps/hybrid-expo/app/markets/polymarket.tsx` |
| One Tap Up/Down | `docs/mockups/polymarket-updown-card.html` | *(does not exist)* |
| Sports moneyline | `docs/mockups/polymarket-sports-detail.html` | `apps/hybrid-expo/app/markets/polymarket/sport/[sport]/[slug].tsx` |
| Yes/No detail | `docs/mockups/polymarket-binary-detail.html` | `apps/hybrid-expo/app/markets/polymarket/market/[slug].tsx` |
| Multi-outcome event | `docs/mockups/polymarket-event-detail.html` | same `[slug].tsx` route, different render path |
| Profile | `docs/mockups/polymarket-profile.html` | `apps/hybrid-expo/app/markets/polymarket/profile.tsx` |

Shared design tokens: `docs/mockups/polymarket-detail-system.css`. Conventions from
the review pass recorded in `docs/mockups/polymarket-mockups.md`.

How to read this document: the mocks are the visual source of truth; this document is
the scope-and-decisions source of truth. Where they disagree, this document wins and
the mock gets updated — flag it, don't silently pick one.

---

## Decision record — how we got here

Four independent reviews ran against the six mockup files before this PRD was
written. Their findings split into three buckets: fixed immediately in the mocks,
accepted as build requirements here, and deferred. Recorded so nobody re-litigates
settled questions or rediscovers a known trap.

**UI designer review (7/10).** Craft confirmed solid — single token palette, zero
hover effects, tabular numerals, reduced-motion support, consistent plain-language
copy. Main risks raised: micro-typography throughout the One Tap card (6–8px labels),
tap targets under the 44px thumb guideline on exactly the controls users touch most,
and the shared order composer not actually being shared — only Event Detail showed
the full confidence review (You pay / Avg price / If you're right / Maximum loss);
the other three screens stopped at "Estimated shares." Also flagged: the One Tap card
was overpacked with a hidden flip-to-position affordance, emoji flags standing in for
real crests, and an instant "Higher wins" result flash at cycle end.

**Product review (7/10).** Beginner tone judged right (max-loss framing, named
resolution sources). Gaps raised: the core mental model — cents = probability = what
you get back per $1 if right — is never taught anywhere; "shares" appears unexplained;
terminology drifts across screens (USDC vs pUSD, Up vs Higher, Add cash vs Deposit);
no losing, pending, or resolving position state exists (every example position is
green — first loss with no designed state churns users); deposit is a dead-end toast;
"8.4k picks"-style metrics are fabricated (violates our own honesty rule); and the
mock promised 5m/15m/4h/1w rounds upstream supply can't fill.

**CTO review (6.5/10).** Trade-time UX strong and mostly honest; the journey edges
are thin. Findings: onboarding/deposit/withdraw flows undesigned (Privy stays and
carries them); withdrawal wallet listed Solana while deposits arrive on Polygon;
round durations don't exist upstream (critical scope decision); GTC limit orders on
expiring rounds lock funds indefinitely — need auto-expiry; cash-out needs a real
quote/slippage design or it becomes support tickets; INR conversion hardcoded; crest/
flag pipeline unbuilt; geo/eligibility and responsible-trading guardrails needed
before public launch. His ranked pre-build decisions were adopted into the build
sequence and open questions below.

**Engineering-manager review (gap analysis).** Verified in-repo that roughly 60% of
the redesign carries over existing, tested code (order quote math, signing chain,
GTD server support, deposit/withdraw modals, lifecycle statuses) and that One Tap has
zero existing code. Its risk ranking, missing-state list, and build sequencing are
incorporated in the sections below.

### Fixed immediately in the mockups (applied fix pass)

- Durations cut to **1 hour / 1 day only**, everywhere including the featured card.
- "Higher wins" instant flash replaced by a neutral **"Round closed"** settling state.
- Full order review (**You pay / Average price / If you're right / Maximum loss**)
  ported to all four composers, plus a one-line shares explainer ("each pays $1.00
  if right").
- **USDC → pUSD** everywhere; "Add cash" → **Deposit**; history "Cash added" →
  Deposit; One Tap language aligned to **Higher/Lower** across screens.
- Fabricated pick counts replaced with traded volume (which the API actually has).
- Withdrawal wallet row changed to Polygon.
- Type floor of **9px** applied (~100 micro-type fixes) and primary tap targets
  enlarged (Chart/Book switch 27→34px, book tabs 30→36px, quick amounts 34→38px,
  mini book rows 25→30px).
- Unit explainer added to Discover: prices run 1¢–99¢ and a price is also the chance.

### Decided during the process (settled)

| Question | Decision |
|---|---|
| Dark vs light cards — accidental inconsistency? | Intentional. `--wallet` (#031F2C) is reserved for the money card on Discover and Profile; all other cards use `--surface`. Keep as hierarchy anchor. |
| Terminology canon | Your pick · If you're right · Maximum loss · Deposit · Withdraw · Ready to collect · Higher/Lower. One word per concept, all screens. |
| Money-map hierarchy | Available / In picks / Ready to collect, with Deposit + Withdraw inside the financial card. |
| Probability teaching | Persistent unit explainer at first use rather than per-screen tooltips. |
| Cycle-history swiping | Deferred past v1 (EM + CTO agreed); keeps the chart tractable. |
| Bottom navigation tabs | None; search stays near the bottom of Discover. |
| Live sports data | Nothing rendered unless the API provides it — no scores, clocks, or badges. |

### Acknowledged, owned by build/design (not yet designed)

Losing/pending/settling position states, a designed deposit flow beyond the existing
modal, the crest/flag asset pipeline, and all empty/error/offline states are required
before their screens ship but deliberately not invented inside HTML mockups — they
are design tasks scheduled alongside the build sequence.

## The problem in one paragraph

The current Predict screens grew feature by feature: two detail screens each hand-roll
their own amount entry, order review shows shares but never payout or max loss on most
paths, One Tap does not exist despite being the intended beginner entry point, and the
profile mixes login state with positions with deposits in one undifferentiated scroll.
A user who has never traded a prediction market can complete an order today, but
nothing tells them what they bought, what it pays, or what happens when the market
resolves. This redesign replaces the surface with one connected system built around
that user without capping advanced ones.

## Goals

1. One end-to-end flow — **Discover → understand the market → choose an outcome →
   place an order → manage it in Profile** — with shared components at every step.
2. A beginner can place a first order understanding three things: what they paid,
   what they get if right, and the most they can lose.
3. Every market type (binary rounds, sports moneyline, yes/no questions, multi-outcome
   events) uses the same order composer, the same Chart/Book pattern, the same
   position language, and the same odds/currency behaviour.
4. Zero fabricated data. Nothing renders that the API does not provide — no invented
   scores, clocks, pick counts, or instant settlement flashes.

## Non-goals (v1)

- Bottom tab navigation (search stays near the bottom of Discover instead).
- Swipe-through historical cycle charts on One Tap.
- Live scores, match clocks, or "live" badges on sports (upstream API provides none).
- Desktop-specific layouts; mobile-first with native sheets and touch targets.
- New deposit/withdraw rails. Privy stays for wallet/auth/deposit; the existing
  `components/predict/DepositModal.tsx` / `WithdrawModal.tsx` carry over behind the
  new money-map UI.
- Any server-side trading-model change. GTD/GTC/FOK/FAK support already exists in
  `packages/api/src/polymarket/trading/routes/orders.ts`; nothing here needs more.
- Renaming `features/predict/` (per SDK-migration PRD: "Predict" is the product
  concept; Polymarket is today's venue).

## Locked decisions (not open for re-litigation here)

| Decision | Value |
|---|---|
| Wallet/auth/deposit provider | Privy (stays) |
| Settlement currency | pUSD; local currency display-only |
| Withdrawal destination | Polygon (deposits arrive there) |
| One Tap durations | 1 hour and 1 day only — upstream supply reality; 5m/15m/4h/1w cut |
| Order types | Market + Limit everywhere; limits auto-cancel at deadline/kickoff |
| Data honesty | Render nothing the API does not return |
| Odds formats | Probability default; Decimal + American toggle on multi-outcome events; books and limit prices always in contract cents |
| Charts | Probability-based everywhere |
| Card hierarchy | Dark `--wallet` card reserved for money surfaces; `--surface` for content cards |

## The experience, screen by screen

Each section: what the mock shows → what exists at its route → exactly what a
developer builds.

### 1. Discover — mock: `polymarket-discover.html`

Featured carousel across One Tap / sports / politics / crypto; live + upcoming sports;
movers; browse-by-league rail with crests/flags; search near the bottom. One Tap is
**one** featured card opening the full Up/Down screen — not per-timeframe cards.

- Route today: `app/markets/polymarket.tsx` rendering `features/predict/PredictScreen.tsx`.
- Reskin of the existing screen. Data plumbing carries over: `fetchFeaturedMarkets`,
  `fetchLivePrices` (`predict.api.ts`), catalog reads in
  `packages/api/src/polymarket/catalog/featured-markets.ts` (note: currently pinned
  to one cricket match — Open Question #4).
- Build: carousel layout, movers section, league rail. The crest/flag asset pipeline
  does not exist anywhere in the repo — v1 fallback is league wordmarks unless
  Open Question #6 resolves first.
- New data need: traded volume per market for the movers section (replaces the cut
  fabricated pick counts). Confirm availability in catalog reads before layout locks.

### 2. One Tap Up/Down — mock: `polymarket-updown-card.html` — NEW BUILD

Binary higher/lower rounds on assets (BTC first). Asset + timeframe switchers inline;
continuous price chart showing previous-cycle tail, cycle boundary, target price, and
current progress toward deadline; Chart/Book share one switchable surface; Up/Down
then shared numpad composer. Round close shows a neutral settling state, never an
instant result flash.

- Route today: none. Zero updown code exists anywhere in the repo.
- Build: new route (`app/markets/polymarket/updown.tsx`), new round-lifecycle hook,
  new cycle chart component. Chart primitives exist to adapt from
  `MultiLineChart.tsx` (react-native-svg); quotes from `orderbookQuote.ts`; numpad
  from `InlineNumpad.tsx`.
- Blocked on Open Question #1 (round supply). Everything else can proceed without it.

### 3. Sports moneyline — mock: `polymarket-sports-detail.html`

Moneyline only. Crests and matchup identity carry the screen; Home/Draw/Away outcomes;
Chart + Book views; same composer. Larger elements deliberately fill space other apps
waste on unavailable live data.

- Route today: `app/markets/polymarket/sport/[sport]/[slug].tsx` rendering
  `features/predict/PredictSportDetailScreen.tsx`.
- Mostly a reskin. Existing: `catalog/sports-rules.ts`, league series mapping
  (EPL/UCL/IPL/FIFA WC in `catalog/featured-markets.ts`), inline setup-after-connect
  flow. Swap amount UI for the shared composer; add the Chart/Book switcher.

### 4. Yes/No detail — mock: `polymarket-binary-detail.html`

Question and resolution context first; Chart/Book panel; Yes/No into the composer;
existing positions via "Your pick" (current value, entry, P/L, add, cash-out).

- Route today: `app/markets/polymarket/market/[slug].tsx` rendering
  `features/predict/PredictMarketDetailScreen.tsx`.
- Strongest starting point — order book, cancel, positions, balance, pending-order
  merge (`pendingOpenOrders.ts`) and cash-out (`positionSellQuotes.ts`,
  `CashOutConfirmModal.tsx`, `redeemErrors.ts`) all live here today.
- Build: question/resolution header, Chart/Book switcher, "Your pick" surface,
  composer swap. This screen pilots the shared composer (build step 1).

### 5. Multi-outcome event — mock: `polymarket-event-detail.html`

One event card: question, outcome ladder of probability lines, one book per outcome,
resolution-rules sheet naming the deciding source. Odds toggle Probability/Decimal/
American; charts stay probability-based; execution prices stay in cents.

- Route today: same `[slug].tsx` — feed types already carry multi-outcome events
  (`FeedOutcome[]` in `predict.types.ts`).
- Build: outcome-ladder render path, per-outcome book switching, resolution-rules
  sheet (rules data likely available via Gamma — confirm in catalog hydrate).
- Note: `hooks/useOddsFormat.ts` implements probability/decimal/**points** today;
  spec requires American on this screen (Open Question #3).

### 6. Shared order composer — bottom sheet, ALL market types

Market/Limit tabs, existing numpad, configurable quick amounts, pUSD amount, average
execution price, "If you're right" payout, maximum possible loss, confirmation CTA.

- Today there is no composer component: `PredictMarketDetailScreen.tsx` and
  `PredictSportDetailScreen.tsx` each hand-roll amount entry around `InlineNumpad.tsx`.
  The math is centralized and tested — `orderbookQuote.ts`'s `buildExecutableBuyQuote`
  already returns average price and unfilled amounts — so this is extraction, not
  reinvention.
- Build ONE component (`features/predict/components/OrderComposerSheet.tsx`), used by
  all four market types. Pilot on Yes/No detail, then port screen by screen behind a
  flag. GTD wiring ("limit cancels at deadline/kickoff") rides along — server support
  confirmed in `trading/routes/orders.ts`.
- Review block contents (You pay / Average price / If you're right / Maximum loss /
  shares explainer line) are copy-frozen per the terminology canon.

### 7. Profile — mock: `polymarket-profile.html`

Compact identity card (masked login, sign-in method) → Account & Security (login mgmt,
passkeys, connected wallets, withdrawal wallet, sign-out; sensitive actions confirmed)
→ money map (Available / In picks / Ready to collect) with Deposit + Withdraw →
Positions / Open Orders / Activity tabs → Settings.

- Route today: `app/markets/polymarket/profile.tsx`, already importing
  `DepositModal` / `WithdrawModal`, portfolio, balance, open orders.
- Mostly presentation-layer rebuild over existing data. Activity state machine exists
  (`predictActivityState.ts`). Privy exposes login method / linked accounts for the
  identity + security sections.
- Build: money map card (dark `--wallet` treatment), security sheet(s), settings
  (odds format persists via the `useOddsFormat` storage pattern; quick amounts and
  order-review safety are new persisted prefs).

## Component map — reuse vs create

Shared components (in `features/predict/components/` unless noted):

| Component | Status | Used by |
|---|---|---|
| `OrderComposerSheet` | **CREATE** — pilot on Yes/No | all four market types |
| `InlineNumpad.tsx` | EXISTS — gets absorbed into composer | composer |
| `OrderbookView.tsx` | EXISTS — restyle only | all details + One Tap |
| `MultiLineChart.tsx` | EXISTS — extend for cycle overlay | One Tap, details |
| `OddsFormatToggle.tsx` | EXISTS — add American (Q3) | event detail |
| `DetailPicksPanel.tsx` | EXISTS — becomes "Your pick" | yes/no, sports |
| `CashOutConfirmModal.tsx` + `positionSellQuotes.ts` | EXISTS | yes/no |
| `DepositModal` / `WithdrawModal` (`components/predict/`) | EXISTS — rewire entry points | profile money map |
| CycleChart (boundary/target/settling states) | **CREATE** | One Tap |
| RoundLifecycleHook (countdown, settle polling) | **CREATE** | One Tap |
| OutcomeLadder + ResolutionRulesSheet | **CREATE** | event detail |
| LeagueRail + crest/wordmark assets | **CREATE** (assets blocked, Q6) | discover |

Backend: no new routes required for v1 except whatever One Tap's round supply forces
(Q1). Read-side additions: traded-volume fields for movers (confirm in catalog).

## Hardest problems, ranked

1. **One Tap round supply.** Where do hourly/daily BTC rounds come from — mapped
   Polymarket crypto series or our own round clock over CLOB prices? Blocks all One
   Tap work. Resolve at PRD sign-off.
2. **Composer unification regression risk.** Four screens currently own four amount
   flows touching live trading. Extract incrementally behind one flag, one screen at
   a time; the math is tested and carries over.
3. **Cycle chart rendering.** Continuous multi-cycle SVG with boundary/target overlays
   in React Native. Swipeable history is deferred, which keeps this tractable.
4. **Settlement timing honesty.** Backend statuses exist (`lifecycle.ts`:
   waiting_to_match → filled/not_filled → cancelled → collected vocabulary); nothing
   yet drives pending → won/lost → collected through the UI including redeem-failure
   handling (`redeemErrors.ts` extends rather than invents).
5. **Race conditions at close.** Limit submitted seconds before deadline: GTD protects
   the book side; client needs optimistic cancel + "round closed" reconciliation.

## States the mocks do not cover (design tasks before each screen ships)

Empty states (no picks/orders/activity), failed buy/sell/cancel/redeem messaging,
offline/reconnect mid-round, insufficient balance inside the new composer, limit
partially filled at expiry, cash-out quote failure/slippage-bound rejection, losing
and resolving position presentations. None blocks starting; each blocks shipping its
screen.

## Build sequence after sign-off

Ordered for dependency and risk; each step ships independently:

1. **Shared composer extraction** — `OrderComposerSheet` piloted inside
   `PredictMarketDetailScreen.tsx` behind a flag; then sport screen; then event
   render path. Includes GTD deadline wiring + review block.
2. **Profile reskin** — money map + Account & Security + tabbed activity in
   `profile.tsx`; rewire Deposit/Withdraw modals into the money card; settings prefs.
3. **Yes/No + Event detail reskins** — headers, Chart/Book switcher, "Your pick",
   outcome ladder, resolution rules.
4. **Sports reskin** — crests/identity, composer swap, Chart/Book switcher.
5. **Discover assembly** — carousel, movers (needs volume data), league rail; links
   to everything above, so it lands after its targets exist.
6. **One Tap last** — greenfield, gated on Q1; new route + CycleChart +
   round lifecycle + settle states feeding the Profile money map.

v1 cut line if pressed: American odds format, crest pipeline (ship wordmarks),
quick-amount configurability in settings (hardcode defaults).

## Definition of done

- A first-session user completes Discover → order → sees payout/max-loss before
  confirming, in under two minutes, without documentation.
- All four market types render the identical composer component (one source file).
- Zero fabricated values render anywhere in the surface (audit against API responses).
- Every position resolves through pending → won/lost → collected with correct states,
  including redeem-failure recovery.
- Type scale ≥ 9pt-equivalent and primary tap targets ≥ 44px throughout — the mock
  fix-pass standard carried into React Native.
- All existing predict tests keep passing (`pendingOpenOrders.test.ts`,
  `predict-feed.test.ts`, `predict.navigation.test.ts`); composer extraction adds
  coverage for the unified review math.

## Open questions (blocking ones marked)

1. **[BLOCKS ONE TAP]** Where do One Tap rounds come from — mapped Polymarket crypto
   series or self-run round clock?
2. Does the composer need a balance-aware wrap step (pUSD ↔ USDC.e), or is wrap
   transparent today via the combo-approve path?
3. Odds format: spec says American; `useOddsFormat.ts` implements "points". Which is
   the real v1 set?
4. Featured/curation: `catalog/featured-markets.ts` is pinned to one cricket match
   (flagged TODO). Replace with real curation before Discover ships, or keep the pin?
5. Geo/eligibility and responsible-trading guardrails required before public launch?
   (CTO review flagged; owner: product.)
6. Crest/flag assets: budget a real asset pipeline for Discover's league rail, or
   ship league wordmarks in v1?
