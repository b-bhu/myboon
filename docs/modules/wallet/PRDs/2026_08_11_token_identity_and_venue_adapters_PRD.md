# Token Identity and Venue Adapters PRD

Status: ready for issue breakdown
Date: 2026-08-11
Owner: myboon Apps

This is a change plan. It describes work to be done and stops being read once
the work lands. How the system works after this ships belongs in a durable spec
— `docs/modules/wallet/specs/token_identity.md` — which does not exist yet and
should be written as part of this work.

Rule for keeping the two apart: **does this sentence stay true after the work
ships?** If yes it belongs in the spec. If it describes a transition, it belongs
here.

## Purpose

Two problems, one root cause.

**The visible problem.** The same token looks like a different token depending
on which screen you are on. Pacifica shows a real BTC logo; Phoenix shows a grey
circle with the letter B. Meteora shows a third icon from a third CDN. A user
moving between venue lists does not experience one app.

**The structural problem.** Adding a venue today means writing another
400-line list screen. Pacifica and Phoenix are already ~85% the same file, drifted.
Orca, Raydium and Kamino sit dead on the home grid at 58% opacity precisely
because "add a venue" is currently a large job.

The root cause of both is the same: **there is no shared answer to "what is this
token," and no shared contract for "what is a market list."** Six subsystems each
invented their own.

This PRD does two things:

1. Builds a **token identity service** — one server-side source of truth for
   symbol, name, icon, decimals, and canonical grouping — backed by a nightly
   snapshot of the Solana Foundation Tokens registry.
2. Generalizes the existing `perps.contract.ts` descriptor pattern into a
   **venue adapter contract** that is not perps-specific, so a new venue is a
   registered adapter rather than a new screen.

## Decision Summary

| Decision | Choice | Why |
|---|---|---|
| Tokens API integration shape | **Nightly snapshot into our own table** | The upstream repo is five days old with no SLA, no status page, no published rate limit, and no pricing. A build-time dependency gets the grouping and icon wins with zero runtime risk. |
| What Tokens owns | **Identity only** — icon, name, category, canonical grouping, risk score | Its prices are cached third-party (CoinGecko/Birdeye), further from execution than what we already have. |
| What Tokens never owns | Prices, quotes, perp market data, pool data | Showing a Tokens spot price next to a perp mark price is a correctness bug, not a cosmetic one. |
| Perp symbol resolution | **Explicit checked-in symbol → assetId map** | `BTC-PERP` is not a mint and cannot resolve. Fuzzy search on the stripped ticker eventually shows a *wrong* logo, which is worse than a blank one. |
| Venue list architecture | **Adapter contract + shared shell**, not a perps-only dedup | Stated requirement: plug-and-play across perps, LP, and future venues. |
| Meteora visual identity | **Keeps its palette** via a theme token on the adapter | Venue colour is wayfinding. Same bones, different skin. |
| Scope of "unify" | Bones only — rows, states, formatters, icons | Sort sheets and filter chips on a 50-row perps list are a tap tax, not consistency. |

## Product Problem

### Six answers to "what is this token"

| Where | Keyed on | Icon source | Name source |
|---|---|---|---|
| Pacifica — `packages/api/src/pacifica.ts:105` | Ticker (`tokenBase()` at `:53`) | Pacifica's SVG set, proxied through us | None — symbol only |
| Phoenix — `packages/api/src/phoenix.ts:760` | Ticker | **None.** `iconPath` is hardcoded `null` | None |
| Meteora — `packages/shared/src/meteora/data-api.ts:178` | SPL mint | Meteora's CDN, hit directly from the device | `raw.name ?? raw.symbol` |
| Swap — `apps/hybrid-expo/features/swap/swap.api.ts:6` | SPL mint | 4 hardcoded URLs into `trustwallet` and the **deprecated** `solana-labs/token-list` | Jupiter |
| Wallet — `packages/api/src/spot.ts:104` | SPL mint | On-chain metadata URI via Helius | On-chain metadata |
| tx-parser — `packages/tx-parser/src/constants/knownTokens.ts` | SPL mint, 3 entries | None | `mint.slice(0, 8)` |

### What a user actually sees

- **Phoenix looks broken next to Pacifica.** Same BTC, same app, one has a logo
  and one has a letter. This is the single most visible inconsistency in the
  product and it is one `null` in `phoenix.ts:760`.
- **The same token has three different icons** depending on screen — different
  crops, different backgrounds, different rounding.
- **Unknown tokens degrade three different ways.** Grey letter box in perps;
  cyan *or violet* letter box in Meteora depending on whether the token is
  tokenX or tokenY (`MeteoraPoolsScreen.tsx:151-153`); raw symbol or nothing in
  wallet.
- **Two "no data" glyphs.** `--` in `lib/format.ts`, `—` in Meteora's private
  copy at `MeteoraPoolsScreen.tsx:675`. Nobody can name why the app feels
  sloppy, but this is the kind of thing that does it.
- **Pacifica has no empty state at all.** Search with no matches renders a blank
  list — no `ListEmptyComponent`. Phoenix has one.
- **Row labels use three conventions:** `BTC-PERP` (Pacifica, raw venue symbol),
  `BTC` (Phoenix, via `marketLabel()` at `:217`), `SOL / USDC` (Meteora).

### What a developer sees

Pacifica and Phoenix share, near byte-for-byte: the column constants
(`COL_PRICE = 80; COL_CHANGE = 58; COL_OI = 60`), the ~190-line style block down
to the hardcoded `rgba(48,47,32,0.5)` border, the table header, the search bar,
the retry pill. And two character-identical formatter sets — `formatPrice` /
`formatPhoenixPrice`, `formatChange` / `formatPhoenixPercent`, `formatFunding` /
`formatPhoenixRate`. Same branches, same thresholds, same output.

None of that divergence is domain difference. It is drift.

## Why the Tokens API, and why only partly

The Solana Foundation ships a hosted Assets API (`api.tokens.xyz/v1`,
`x-api-key`, server-side only). It is genuinely well built — clean errors,
`x-request-id` on every response, per-include partial-failure blocks, MIT
licensed with the registry data in the open.

**What it is uniquely good at, that we cannot easily build:**

- **Canonical grouping.** Five USDC bridge variants collapse to one `usd`. Five
  tokenized Tesla wrappers collapse to one `tesla`. Nothing else does this.
- **Risk scoring** per asset, out of the box.
- **Tokenized equities and RWAs** with issuer metadata and redeemability tier.
- **Curated lists** (`majors|lsts|currencies|rwas|etfs|metals|stocks`) that
  directly replace hardcoded arrays. The LST list is Sanctum-backed rather than
  a static mint list.
- **Trustworthy canonical icons**, replacing our links into a deprecated repo
  that are one reorganization away from 404.

**Why it does not get to be a runtime dependency:**

The repo was created 2026-08-06. Four commits on main. Zero releases, zero tags,
no changelog, no deprecation policy. `status.tokens.xyz` does not resolve. Rate
limits and monthly quotas are referenced in the docs as concepts that return
`429`, with **no published numbers**. There is no pricing page. Access is
invite-gated — the support instruction is literally "reply to the access email."

Additionally, every public route is documented as reading **from cache only**,
never live, with no published TTL; and `POST /v1/assets/market-snapshots`
returns a documented type of `Array<unknown>`.

That is an early design partnership, not a vendor. So: **take the data, not the
dependency.**

## P0 Scope

### Included in P0

**1. Token identity snapshot and service**

A nightly job pulls from Tokens and writes to our own table:

- `GET /v1/assets/curated?list=…` for every curated list
- `GET /v1/assets/resolve?mint=…` for every mint in our known universe
  (Meteora pool legs, wallet holdings, swap list)
- `GET /v1/assets/:id` for icon and category

Served to clients through one endpoint, `GET /tokens/resolve?refs=…` plus a
batch POST. Response shape:

```ts
interface TokenIdentity {
  key: string;              // echo the caller's ref back verbatim
  assetId: string | null;   // canonical id; null when unresolved
  symbol: string;           // always present
  name: string;             // falls back to symbol
  iconUrl: string | null;   // ALWAYS our origin, never a third-party host
  decimals: number | null;  // null for perp markets — they have none
  mint: string | null;
  verified: boolean;
  category: 'crypto' | 'stablecoin' | 'equity' | 'commodity' | 'unknown';
  fallbackLetter: string;   // computed server-side so every client agrees
  source: 'snapshot' | 'venue' | 'helius' | 'static';
}
```

Two non-negotiables. `iconUrl` always points at our origin — the client never
learns where an icon came from, and normalizing SVG/PNG behind one URL is what
makes Pacifica and Meteora finally match. And `source` is present so we can see
in production which venue is falling through to which fallback.

**2. Perp symbol map**

A checked-in `symbol → assetId` map covering every symbol Pacifica and Phoenix
currently list (~40 entries), seeded from `/v1/assets/curated`. Perps resolve
through this map only. **Never through fuzzy search** — `search?q=BTC` works for
majors but a ticker collision on a mid-cap shows a confidently wrong logo, and
that is worse than the grey letter box we have now. A symbol not in the map
falls through to the letter box, and adding one is a one-line PR.

Note `kPEPE-PERP` and similar denominated symbols: the strip-the-suffix
heuristic produces `KPEPE`, which resolves to nothing. The map handles these
explicitly.

**3. Icon proxy**

Generalize the working proxy at `pacifica.ts:127-166` — it already does caching,
negative caching, and `Cache-Control`. Keyed on `assetId`. Icon bytes cache for
a week; misses negative-cache for an hour, not a day, so a newly listed token
is not broken all day.

**4. Venue adapter contract**

Generalize `perps.contract.ts` / `perps.registry.ts` — which already has a
descriptor with a capability flag set, and a note reading *"shared perps
adapters are introduced"* — into a `VenueAdapter` that is not perps-specific.

```ts
interface VenueAdapter {
  venueId: string;
  displayName: string;
  kind: 'perps' | 'lp' | 'spot';
  routeBase: string;
  theme?: MarketListTheme;        // Meteora's palette lives here
  capabilities: VenueCapabilities;

  listMarkets(query: MarketQuery): Promise<MarketPage>;
  toRow(market: unknown, identity: TokenIdentity[]): MarketListRow;

  search: { mode: 'local' | 'remote'; placeholder: string };
  columns: [ColumnSpec, ColumnSpec, ColumnSpec];
}
```

Registering Orca means writing an adapter object. It does not mean writing a
screen.

**5. Shared market list shell**

```ts
type MarketListRow = {
  key: string;
  lead: ReactNode;            // TokenIcon | TokenPair | letter fallback
  title: string;              // "SOL" or "SOL / USDC"
  titleSuffix?: string;       // "20×", dim inline
  subtitle?: string;          // "0.25% fee · Farm"
  cells: [Cell, Cell, Cell];  // exactly three, right-aligned
  onPress: () => void;
  a11yLabel: string;          // required by the type — cannot be skipped
};

type Cell = { text: string; tone?: 'neutral' | 'dim' | 'pos' | 'neg'; width: number };
```

`<MarketList>` owns: table header, column widths, row press state and dividers,
skeleton loading (adopt Meteora's — it is the better one), the error card, the
empty state, pull-to-refresh, the search bar, and accessibility plumbing.

It takes `header` and `footer` slots so Meteora's protocol card, filter chips and
infinite-scroll spinner pass straight through untouched.

The seam is at the **row model**, not at data fetching. Each adapter keeps
owning its own fetching, search strategy and pagination — because perps filter
~50 rows in memory while Meteora runs a debounced server query with pagination
reset and request-id race guarding. Papering over that with one `search` prop
means perps carry a debounce they do not need or Meteora loses its race guard.

**6. Formatter consolidation**

Collapse `formatPrice` + `formatPhoenixPrice`, `formatChange` +
`formatPhoenixPercent`, `formatFunding` + `formatPhoenixRate`, and Meteora's
private `formatUsdCompact` into one nullable-safe module. **Pick one no-data
glyph** — `—`.

This is roughly an hour of work and it is the highest ratio of visible
consistency to effort in the whole plan.

**7. Two folded-in bugs**

- **Wrong USDT mint.** `knownTokens.ts:4` says
  `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`; `swap.api.ts:25` says
  `Es9vMFrzaCER7xN4k3qfKxuxMxDPZWS9Vyuk3F7S3w7P`. The swap one is correct.
  Anything routed through the known-token check silently misses USDT today.
- **Leaked Jupiter key.** `swap.api.ts:39` reads `EXPO_PUBLIC_JUP_API_KEY`. That
  prefix is inlined into the shipped JS bundle at build time, so the key is in
  every installed binary and extractable from any release build. It moves behind
  the server-side proxy. Note `spot.ts` already contains the correct reasoning
  for not doing this with the Helius key — the rule is known, the swap path
  missed it.

### Explicitly Postponed

- **Every Tokens market-data endpoint** — `/ohlcv`, `/price-chart`, `/markets`,
  `/risk-summary`, `/trending`. Unrelated to the goal; each venue's charts
  already work.
- **The detail screens.** `PacificaMarketDetailScreen.tsx` and
  `PhoenixMarketDetailScreen.tsx` are 1686 and 1857 lines and contain live
  order-placement paths. They diverge the same way the lists do, but the fix for
  what a user notices there is ~20 lines, not an abstraction. Two deltas worth
  fixing directly: Pacifica has a pulsing live dot next to the header price
  (`:488`) and Phoenix does not; and Pacifica's amount mode is `'usd' | 'native'`
  while Phoenix's is `'usd' | 'base'` — same concept, two names.
- **Sort sheets and filter chips on perps.** ~50 markets, already sorted. A
  modal sort sheet there is a tap tax. Do make the *existing* Phoenix OI sort
  visible by highlighting the column header, and give Pacifica the same sort —
  zero new UI, and it stops the two screens being sorted differently.
- **Moving Meteora's search to a pinned bottom bar.** Its search sits with the
  sort button and filter chips as one discovery block; pinning it to the bottom
  orphans the controls it belongs with. If anything, perps should eventually
  move search to the top, not the reverse.
- **Forcing Meteora onto the app palette.**
- **The swap screen migration.** It works and has its own Jupiter flow. Do the
  venue lists first, prove the shared component, and swap gets it nearly free.
- **Top-bar chrome unification.** Perps have no back button, Meteora does. That
  is a navigation-model question, not a component one. Decide the model first.
- **Token-first navigation.** See below — it is the right next bet, not this bet.

## The token-first question

Worth recording, because it came up strongly and it should not be lost.

The current model asks users a question they cannot answer: *which venue?*
Nobody wakes up wanting Phoenix; they want SOL. Finding where SOL trades today
means opening three venue silos with three search boxes and three empty states.
Arguably the venue-first model is itself the source of the "different feeling" —
the visual divergence is the symptom.

`GET /v1/assets/:assetId/markets` makes a token-first front door cheap. **But it
should be an addition, not a replacement, and not in this PRD**, for two reasons:

1. **A perp and an LP position are not substitutes.** A flat venue list mixing
   "Pacifica perp" with "Meteora SOL/USDC pool" puts a leveraged directional bet
   next to a fee-earning liquidity position. That has to group by *intent*, not
   by venue, or it is actively harmful.
2. **Coverage would lie.** `/:id/markets` returns Tokens' view of where a token
   trades, which is not the same as what is tradeable in our app. Any such list
   must be intersected against our own adapter registry — Tokens for discovery,
   our registry for truth.

And the dependency runs the right way: the token page's "available markets"
section *is* the shared row component rendered with mixed-venue rows. Doing the
adapter work first makes the token page nearly free. Doing it second means
building the same thing twice.

## Acceptance Criteria

1. Pacifica, Phoenix and Meteora rows all render icons from our own origin;
   no client fetches an icon from a third-party host.
2. Phoenix market rows show real token logos. `phoenix.ts:760` no longer returns
   an unconditional `null`.
3. A token missing from the snapshot renders the *same* fallback in all three
   venues — same box, same colour, same letter, computed server-side.
4. Pacifica renders an empty state when search matches nothing.
5. Every market row carries an accessibility label, enforced by the row type.
6. One `formatPrice`, one `formatChange`, one `formatUsdCompact`, one no-data
   glyph across the app.
7. Adding a hypothetical fourth venue requires a new adapter file and a registry
   entry — no new list screen, no new style block. Demonstrate with a stub.
8. Meteora retains its own palette while using the shared shell.
9. The entire Tokens integration sits behind one feature flag and one env var.
   With it off, the app degrades to venue-supplied icons and keeps working.
10. `EXPO_PUBLIC_JUP_API_KEY` no longer appears in the client bundle.
11. The USDT mint is identical everywhere it appears.
12. No screen displays a Tokens-sourced price. Verified by review.

## Risks and Failure Modes

**Unresolved is a 200, not an error.** Tokens returns a *singleton*
(`solana-<mint>`) for anything outside the curated registry — a well-formed
response with `imageUrl: null` and empty stats. Fallback logic must trigger on
empty fields, not on HTTP status. This is the failure mode teams usually get
wrong.

**Long-tail coverage is thin by design.** Tokens curates; Jupiter and Birdeye
index. Meteora lists brand-new tokens constantly and most will be singletons.
Keep Meteora's own `icon` as a second-tier fallback rather than deleting it — a
slightly-off icon beats no icon on a pool row.

**In-memory caches will not hold.** Every cache in `packages/api` today is a
module-level `Map` (`marketCache`, `iconCache`, `balancesCache`). That is
per-process. On any multi-instance deploy the hit rate collapses and upstream
call volume multiplies by instance count. The nightly-snapshot design mostly
sidesteps this for Tokens, but the icon proxy still needs a CDN in front before
it matters.

**Never let identity block a market list.** Resolve identity on the background
refresh, not in the request path. The list reads from an already-warm map. A
cold or failed identity lookup degrades the icon, never the row.

**Meteora's fabricated fields.** `data-api.ts:188-194` and `:558-573` hardcode
`decimals: 0` and `verified: true` for portfolio and limit-order tokens because
the upstream endpoint omits them. Any math downstream of those is wrong. Fix as
part of the identity migration.

## Open Questions

1. **What is the actual rate limit and monthly quota on our key?** Undocumented
   everywhere. Ask via the access email. The nightly-snapshot design makes this
   non-blocking for P0, but it decides whether live lookup is ever viable.
2. **Will it stay free?** Monthly quotas exist as a concept with no published
   price. Worth asking whether early users are grandfathered. Leverage worth
   noting in that conversation: the registry data is MIT-licensed and sits in
   `db/` in the repo — we can fork the data even without the API.
3. **Is `/v1` stable, and what does "v1" commit them to?** Zero releases, zero
   tags. Ask specifically about `market-snapshots` returning `Array<unknown>`.
4. **Funding label mismatch.** Pacifica's detail screen says `Fund/8h`
   (`PacificaMarketDetailScreen.tsx:538`), Phoenix says `Fund/1h`
   (`PhoenixMarketDetailScreen.tsx:644`). This may be correct per venue or it may
   be a wrong number shown to users. Needs confirming with whoever owns the
   integrations before it is treated as a fix. **Not folded into this PRD until
   that answer exists.**
5. **Are venue screens tabs or pushed screens?** Blocks the top-bar chrome
   decision.

## Sequencing

**Step 0 — Formatters and the two bugs.** Half a day. No UI change, no risk,
removes the most obvious "built by different people" signal. Do this regardless
of everything below.

**Step 1 — Token identity snapshot + service + icon proxy.** The nightly job,
the table, `/tokens/resolve`, the generalized icon proxy, the perp symbol map.
Server-side only; nothing visible yet.

**Step 2 — Un-null Phoenix icons.** Small, parallelizable, and it is the single
most visible fix in the plan.

**Step 3 — Adapter contract + shared shell; migrate Pacifica and Phoenix.**
These two are already the same screen, so this deletes ~380 duplicated lines and
makes them *provably* identical rather than accidentally similar. Close the drift
in the same PR: Pacifica gains the empty state, the a11y labels, and
`baseSymbol` search; both gain the skeleton loader and the same error card and
placeholder copy.

**Step 4 — Migrate Meteora onto the shell.** Palette via the adapter's theme
token, extras via `header`/`footer`. It keeps top-positioned search, its sort
sheet, its filter chips, its pagination. It gains the shared row rhythm, states,
and formatters.

**Step 5 — Prove plug-and-play.** Stub a fourth adapter (Orca is the natural
candidate — it is already a dead tile on the home grid) and confirm it needs no
new screen. This is acceptance criterion 7 and it is the actual test of whether
the abstraction worked.

Steps 0-3 deliver most of the visible "same feeling." Step 5 is what makes the
next venue cheap.

## References

### Internal

- `apps/hybrid-expo/features/perps/perps.contract.ts` — descriptor and capability
  types to generalize
- `apps/hybrid-expo/features/perps/perps.registry.ts` — existing registry pattern;
  note the "shared perps adapters are introduced" note already in it
- `apps/hybrid-expo/features/perps/PacificaMarketListScreen.tsx` — `TokenIcon` at
  `:32-59` to delete; no empty state
- `apps/hybrid-expo/features/perps/PhoenixMarketListScreen.tsx` — `marketLabel()`
  at `:217`; the empty state and a11y labels Pacifica lacks
- `apps/hybrid-expo/features/meteora/MeteoraPoolsScreen.tsx` — `TokenMark` at
  `:137-155`; private `formatUsdCompact` at `:675`
- `apps/hybrid-expo/features/perps/perps.public-api.ts` — `formatPrice:120`,
  `formatChange:128`
- `apps/hybrid-expo/features/perps/phoenix.api.ts` — `formatPhoenixPrice:628`,
  `formatPhoenixPercent:636`
- `apps/hybrid-expo/lib/format.ts` — the shared formatters to consolidate into
- `apps/hybrid-expo/features/swap/swap.api.ts` — `FALLBACK_TOKENS:6-35`, leaked
  key at `:39`, USDT mint at `:25`
- `packages/api/src/pacifica.ts` — `iconPath:105`, icon proxy `:127-166` (the
  pattern to generalize)
- `packages/api/src/phoenix.ts` — `iconPath:161`, the `null` at `:760`
- `packages/api/src/spot.ts` — correct server-side-key reasoning, already
  written down
- `packages/api/src/bootstrap/config.ts` — where `TOKENS_API_KEY` goes
- `packages/api/src/bootstrap/create-app.ts` — route mounting
- `packages/shared/src/meteora/data-api.ts` — `normalizeToken:173`,
  `normalizePortfolioToken:186`, fabricated fields at `:188-194` and `:558-573`
- `packages/tx-parser/src/constants/knownTokens.ts` — wrong USDT mint at `:4`
- `apps/hybrid-expo/features/home/HomeScreen.tsx` — the 7-tile grid with three
  dead venues
- `apps/hybrid-expo/features/home/marketBrandAssets.ts` — venue logos, out of
  scope, correctly hardcoded

### External

- [Tokens API docs](https://docs.tokens.xyz/v1/quickstart)
- [solana-foundation/tokens](https://github.com/solana-foundation/tokens) —
  MIT, registry data in `db/`
- [Inside Tokens.xyz](https://solana.com/news/inside-tokens-xyz)
