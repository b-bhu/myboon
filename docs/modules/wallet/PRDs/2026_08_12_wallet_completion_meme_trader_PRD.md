# Wallet-Native Spot Trading: Discover, Swap, Buy, and Sell Tokens

Status: aligned and ready for issue breakdown
Date: 2026-08-12
Last rescoped: 2026-08-18
Data-provider decision locked: 2026-08-18
Owner: myboon Apps

This PRD defines token and meme-coin spot trading as a native capability of the
myboon Wallet. Spot is not another venue inside Apps, and Jupiter is not
presented like Pacifica, Phoenix, Meteora, or Polymarket. Jupiter supplies
quotes and routes underneath myboon's own token and trading surfaces.

Wallet connectivity is a completed platform dependency. It is not planned,
debugged, or accepted here.

Durable platform contracts:

- `docs/modules/wallet/specs/wallet_connectivity.md` — wallet connection, chain
  activation, management, and signer resolution
- `docs/modules/wallet/specs/token_identity.md` — canonical token identity
- `docs/modules/wallet/specs/solana_execution.md` — shared transaction safety
  and execution behavior when that contract exists

## Completed platform baseline

The following behavior is assumed to be implemented and verified before this
PRD begins:

- one canonical app-wide wallet sheet supports management and application
  requirements;
- Solana and Polygon state are resolved independently;
- email and Google can activate deferred myboon wallets per chain;
- Mobile Wallet Adapter connects external Solana wallets;
- an external Solana wallet can coexist with a myboon Polygon wallet;
- disconnecting external Solana never silently changes the active signer;
- every major product root exposes **Connect wallet** or **Wallets** in one tap;
- Solana applications receive an active signer capable of signing and
  broadcasting the transactions they declare;
- cancelling wallet activation returns the user to the same trade context with
  their input preserved.

If any baseline behavior regresses, fix it against the wallet connectivity
specification. Do not add the regression to this PRD or make spot-trading scope
responsible for redesigning wallet state.

## Locked P0 implementation direction

This PRD owns two user-facing surfaces and one shared data/execution path:

1. **Wallet Trade Sheet** — a direct asset-to-asset Swap action plus prefilled
   Buy and Sell configurations opened from Spot.
2. **Spot** — a table-first token terminal and a Profile tab. Terminal and
   Profile controls remain in the bottom thumb zone; search sits immediately
   above them.
3. **Jupiter backend gateway** — myboon's existing server-side `/swap` proxy is
   extended to cover token discovery, prices, Swap V2 order construction, and
   managed execution.

The implementation does not create a Jupiter application, advanced charting
terminal, wallet-connectivity project, or generalized DeFi portfolio rewrite.

### Existing server-security baseline

The Jupiter API key has already been removed from the Expo client. The shipped
app must never read an `EXPO_PUBLIC_JUP_API_KEY`, attach an `x-api-key` header,
or call authenticated Jupiter endpoints directly.

- `packages/api/src/swap.ts` is the existing Jupiter proxy and injects
  `JUP_API_KEY` only on the server.
- `apps/hybrid-expo/features/swap/swap.api.ts` calls the myboon API and never
  receives the Jupiter key.
- `docs/modules/wallet/qa/2026_08_11_token_identity_test_cases.md` records the
  regression coverage for the previous client-key leak.

This PRD extends that path; it does not introduce a second Jupiter client or a
new secret-distribution mechanism. The device receives market data, quote/order
responses, and an unsigned serialized transaction. Signing stays on-device.
The signed transaction may be returned to the myboon backend for Jupiter
`/execute`; private keys and wallet signing authority never leave the wallet.

### Jupiter-only P0 boundary

Jupiter is the P0 provider for token discovery, metadata, current price,
short-window market statistics, quote/order construction, and transaction
execution. Its documented APIs do not provide candles, OHLC, or a historical
price series. Therefore P0 shows an honest **momentum strip** using Jupiter's
`5m`, `1h`, `6h`, and `24h` changes instead of fabricating a line chart.

The authoritative Spot HTML mock renders that same four-window momentum strip.
A historical line or candle chart requires a separately approved data provider
and remains outside P0.

Spot Profile uses the Wallet's existing canonical spot-balance source in P0.
Jupiter Portfolio remains a beta evaluation path for Jupiter-specific
positions; it is not the dependency for basic SPL holdings or Wallet totals.

## Product ownership model

The product has four distinct layers:

| Layer | Owns | Does not own |
|---|---|---|
| **Wallet** | Token balances, Spot entry, Swap entry, activity, and portfolio context | Venue-specific accounts and profiles |
| **Spot** | Table-first token discovery, bottom search, Profile, inline token analysis, and buy/sell entry | A third-party venue identity or advanced charting terminal |
| **Trade Sheet** | Every buy, sell, and asset-to-asset swap interaction | Discovery lists, charts, or a separate navigation destination |
| **Jupiter** | Token metadata, current price, market statistics, quote, route, transaction construction, and managed execution | A myboon app tile, venue profile, historical chart provider, or Jupiter-branded product area |

The compact rule is:

> **Wallet is the entry point. Spot is the token workspace. The Trade Sheet is
> the execution surface. Jupiter is routing infrastructure.**

## Relationship to token identity and venue adapters

Token Identity answers **what token is this?** A mint resolves to one canonical
`TokenIdentity`; search, holdings, Terminal rows, momentum, quotes, positions,
and transaction construction all use that identity. The product never merges
assets by ticker symbol or guesses decimals independently.

Venue adapters answer **where else can this token be used?** They may later
show that the same canonical asset has a Pacifica or Phoenix market, or a
Meteora pool. They do not decide whether a token can appear in the Wallet's
native Spot experience and they do not turn Jupiter into a venue.

## Product outcome

A Solana user can satisfy either of these intentions without taking the longer
path designed for the other:

### Discovery-first intent

```text
Wallet
  -> tap Spot
  -> browse the token table or use bottom search
  -> expand one token in place
  -> inspect momentum and required information
  -> Buy or Sell
  -> Trade Sheet
  -> review, sign, and confirm
  -> return to the same expanded token with refreshed position
```

### Pair-first intent

```text
Wallet
  -> tap Swap
  -> choose From asset
  -> enter amount
  -> choose To asset
  -> review, sign, and confirm
  -> return to Wallet with refreshed balances
```

For example, swapping **10 USDC to JUP** must not require opening Spot,
searching for JUP, expanding JUP, and then choosing Buy. The Wallet's Swap
action opens the Trade Sheet directly with a normal From/To pair.

The primary activation metric is **first confirmed spot trade**, not wallet
connection. Supporting metrics distinguish the discovery-first and pair-first
funnels.

## Target users and frequency

The same infrastructure serves two common mobile behaviors:

1. **The pair-first user** already knows the conversion they want, such as SOL
   to USDC or USDC to JUP. Their highest-frequency need is opening Swap and
   completing the pair with minimal navigation.
2. **The discovery-first trader** browses the ranked token table, opens several
   assets, checks compact momentum and market context, then buys or sells from
   the same screen.
3. **The position manager** opens Spot to inspect existing holdings and exit
   using exact percentage presets.

The Spot Hub is the view where an active token trader may spend most of their
time. The Trade Sheet is deliberately transient: it performs an operation and
returns the user to the context that opened it.

## Current product gaps

### No native Spot destination

Home already renders a **Spot** account row, but it has no destination and is
therefore deliberately non-interactive. Meteora, Phoenix, and Pacifica can open
their own surfaces; Spot cannot.

### No first-class quick Swap action

The Wallet action rail contains Send, Receive, and Transfer placeholders. There
is no clear **Swap** action that opens a native asset-to-asset trade composer.
The existing `/swap` screen is disconnected from the Wallet information
architecture and should not become a Jupiter venue.

### No table-first discovery surface

There is no native ranked token table, persistent bottom search, or
contract-address entry. A user must already know where else in the product a
token can be selected.

### No token analysis surface

There is no place to expand an asset and inspect short-window momentum, market
numbers, position, warnings, and Buy/Sell actions together.

### Incomplete execution

The current swap CTA is non-functional. Balances are mocked, amount conversion
uses floating-point math, the full Jupiter quote is discarded, minimum received
is unavailable, and Custom slippage is not a real input.

### No transaction truth

The product does not yet present the full lifecycle of quote, validation,
simulation, wallet approval, submission, confirmation, known failure, and
unknown outcome.

## Product decisions

| Decision | Choice |
|---|---|
| Product home for token operations | **Wallet** |
| Primary discovery destination | **Spot Hub**, opened from the Wallet's Spot row |
| Spot navigation | Bottom **Terminal / Profile** tabs; no top category tabs |
| Terminal layout | Token table starts immediately below the Spot header |
| Search placement | Persistent search directly above Terminal / Profile in the thumb zone |
| Fast known-pair entry | **Swap** action in the Wallet activity rail |
| Token-detail interaction | Expand one asset in place inside Spot; no visible page transition |
| Deep-link model | Route-backed Spot state opens the requested mint already expanded |
| Execution UI | One shared, content-sized **Trade Sheet** for Swap, Buy, and Sell |
| Asset selection inside Trade Sheet | Replace the sheet's content temporarily; never stack token-picker sheets |
| Default terminal ranking | Jupiter `toptrending/1h`, applied behind the UI with myboon eligibility filters |
| P0 token visualization | Jupiter `5m / 1h / 6h / 24h` momentum; no fabricated historical line |
| Terminal 24h source | Tokens V2 `stats24h.priceChange`; Price V3 `priceChange24h` is not mixed into Terminal rows |
| Router | Jupiter Swap V2 `/order` + `/execute` behind the existing myboon API proxy |
| API-key ownership | Backend only through `JUP_API_KEY`; never shipped in Expo |
| Jupiter presentation | Provider disclosure in the quote only; never an app or venue destination |
| Discovery | Ranked token table, bottom search/paste, and later watchlist |
| Category UI | Excluded from P0; no Trending / New / Gainers chips |
| Profile balances | Existing canonical Wallet raw spot balances plus current Price V3 valuation only |
| Jupiter Portfolio | Beta evaluation only; not required for P0 Wallet balances |
| Editorial recommendations | Excluded; provider ranking is measured market data, not a myboon endorsement |
| Buy denomination | Configurable SOL quick-buy amounts plus manual asset input |
| Sell denomination | 25 / 50 / 75 / 100% of the exact raw token balance |
| Default quick-sell output | SOL |
| Amount math | Decimal-string parsing and BigInt end to end |
| Slippage | Per trade; dangerous tiers are session-scoped and explicitly confirmed |
| Transaction retry | Never automatically retry an ambiguously submitted transaction |
| Automated execution | No delegated trading or server-held wallet authority |

## Information architecture

### Navigation model

```text
Home / Wallet
├── Wallet balance and protocol accounts
├── Wallet actions
│   ├── Send
│   ├── Receive
│   └── Swap -> Trade Sheet
└── Spot account row -> Spot Hub

Spot Hub /spot
├── Terminal tab
│   ├── Token / Price / 24h table immediately below the header
│   └── Search token or paste mint immediately above bottom navigation
├── Profile tab
│   └── Existing Wallet spot balances and portfolio summary
├── Bottom Terminal / Profile navigation
└── Expanded token state /spot?token=<mint>
    ├── 5m / 1h / 6h / 24h momentum strip
    ├── Price and market summary
    ├── Position and balance
    ├── Warnings and data freshness
    └── Buy / Sell -> Trade Sheet
```

This introduces one navigation level from Wallet to Spot. Expanding a token
does not create another visible navigation level. Buy, Sell, and Swap are modal
operations that return to their caller.

### Wallet entry points

The Wallet exposes two different actions because they represent different user
intent:

- **Spot row** — “I want to browse or manage tokens.” It opens the Spot Hub.
- **Swap action** — “I already know I want to exchange one asset for another.”
  It opens the Trade Sheet immediately.

Swap is not an alias for Transfer. The final disposition of the existing
Transfer action is an explicit product decision; it must not be silently
renamed if Transfer represents a distinct future cross-account or cross-venue
operation.

### Spot Hub content hierarchy

The first version is deliberately dense and thumb-oriented:

1. **Token table** — begins immediately below the Spot header; no Market title,
   instructional copy, or category-chip row consumes vertical space.
2. **Inline token detail** — inserted directly beneath the selected row.
3. **Search/paste** — fixed immediately above bottom navigation and visible on
   Terminal only.
4. **Terminal / Profile** — the two bottom tabs. Terminal owns discovery and
   trading entry; Profile owns raw spot balances and current valuation.

The provider may use `toptrending/1h` to order the initial table, but the UI
does not expose Trending, New, or Gainers as selectable categories. The list is
one terminal, not a collection of discovery destinations.

### Token rows and inline expansion

A collapsed token row shows enough information to choose whether to inspect it:

- icon, canonical symbol, and name;
- current price;
- relevant short-window price change;
- liquidity or volume signal appropriate to the list;
- user balance/value when the token is held;
- verification or warning treatment.

Tapping a row expands it directly beneath the row. Only one token is expanded
at a time. Expanding another token collapses the previous one. Re-tapping the
same token collapses it.

The expanded state contains:

- compact `5m / 1h / 6h / 24h` momentum strip sourced from Jupiter token
  statistics;
- current price, market cap, liquidity, and volume;
- user's balance and value;
- the P0 warning summary: verification, organic-activity label, an explicit
  suspicious flag only when Jupiter supplies `audit.isSus: true`, and data
  freshness;
- Buy and Sell actions;
- later, watchlist, alerts, average entry, and PnL.

List virtualization and detail mounting must respect this invariant: collapsed
rows do not retain detailed requests or visualization state. Only the expanded
asset owns the detailed content.

### Route-backed expansion

The user sees inline expansion, but the expanded mint is represented in route
state:

```text
/spot
/spot?token=<canonical-solana-mint>
```

Search results, pasted contract addresses, notifications, shared links, and
future venue links open `/spot` with the relevant token expanded and scrolled
into view. Back removes or restores the expanded-token state predictably rather
than dropping the user on an unrelated screen.

The route accepts only a canonical token identifier. It never accepts a
pre-authorized amount, slippage value, destination, or armed transaction.

### Shared Trade Sheet

There is one Trade Sheet with three entry configurations:

| Entry | Prefilled state | User can change |
|---|---|---|
| **Swap from Wallet** | No required pair; optionally restore harmless recent asset choices | From asset, To asset, and amount |
| **Buy from expanded token** | Output token fixed to the selected mint; input defaults to SOL or configured funding asset | Funding asset and amount |
| **Sell from expanded token** | Input token fixed to the selected mint; output defaults to SOL | Output asset when allowed and amount/preset |

All three modes use the same component, quote contract, review, validation,
execution lifecycle, and terminal states. Buy and Sell are not independent
terminals.

The Trade Sheet is compact and content-sized when composing or reviewing a
trade. It grows or scrolls only when content and safe-area constraints require
it. Its normal content order is:

1. From asset, balance, and amount.
2. Pair-reversal action when the selected pair permits it.
3. To asset and estimated output.
4. Quote freshness, minimum received, price impact, and fees.
5. Review/Confirm action.

Opening an asset picker replaces the Trade Sheet body and returns the selection
to the same sheet. Do not open a second bottom sheet on top of it. Wallet
activation, when required, uses the canonical wallet sheet and returns the
result to the preserved trade intent.

After confirmation:

- Swap opened from Wallet returns to Wallet and refreshes both balances.
- Buy or Sell opened from Spot returns to the same Spot scroll position with
  the same token expanded and its position refreshed.
- Failure or cancellation retains the selected pair and amount unless the
  quote itself has become invalid.

### Default-ranking integrity

The Terminal's initial order is a discoverability mechanism, not an editorial
recommendation feed. The backend starts from Jupiter
`GET /tokens/v2/toptrending/1h` and applies explicit minimum identity,
liquidity, organic-activity, spam, and supported-route checks before returning
rows to the app.

The user does not choose Trending, New, or Gainers in P0. Provider, ranking
window, eligibility rules, and freshness remain observable through product
telemetry and developer diagnostics without spending permanent screen height
on category controls. Placement never renders a green “safe” claim or bypasses
the token's warning and review steps.

## P0 — Wallet-native Spot and complete execution

P0 is one shippable milestone: the Wallet exposes Spot and Swap, a user can
discover or select a token, and either entry reaches the same safe confirmed
trade lifecycle.

### SPOT-P0-01 — Wallet entry points and Spot Hub

- Make the Wallet's existing Spot account row tappable.
- Open the native Spot Hub at `/spot`.
- Add a first-class **Swap** Wallet action that opens the Trade Sheet directly.
- Keep Swap independent from the discovery path.
- Preserve the current Wallet balance and protocol-account context on return.
- Do not introduce a Jupiter app tile, venue profile, or Jupiter-specific
  navigation hierarchy.
- Make the legacy `/swap` route open or redirect to the same native Trade Sheet
  rather than maintaining a second swap product.

### SPOT-P0-02 — Terminal table, bottom search, and Profile

Build the Spot Hub exactly around the approved compact screen hierarchy:

- Terminal and Profile are bottom tabs in the natural thumb zone;
- the Terminal table starts immediately below the Spot header;
- no Market title, instructional subtitle, or Trending / New / Gainers category
  chips render above the table;
- the initial table is supplied by Jupiter `toptrending/1h` behind myboon
  filtering, without exposing a category selector;
- persistent search sits immediately above the bottom tabs and searches by
  symbol, name, or canonical mint;
- paste a mint and resolve through the canonical token-identity contract;
- Profile uses the active Wallet's exact raw spot balances and batched Price V3
  current valuation;
- Profile shows total current value, each token's raw display balance, each
  token's current USD value when available, priced-token count, unpriced-token
  count, and valuation freshness;
- Profile does not show daily portfolio gain, cost basis, average entry,
  realized or unrealized PnL, best performer, or allocation performance in P0;
- search hides on Profile and restores unchanged on return to Terminal;
- explicit loading, empty, stale, partial, and failed states exist for the
  table, search, and Profile;
- list virtualization or continuation is appropriate to the result size;
- spam and unsupported-route exclusion occurs before display.

Search and pasted identifiers resolve by mint. A symbol match is a search
result to inspect, never sufficient identity for transaction construction.

### SPOT-P0-03 — Inline token expansion and Jupiter momentum

- Expand exactly one token row at a time without a visible screen transition.
- Represent expansion as `/spot?token=<mint>`.
- Scroll a deep-linked or searched token into view and expand it.
- Show sourced `5m`, `1h`, `6h`, and `24h` price-change values as a compact
  momentum strip.
- Do not draw a historical line from four interval-change values and do not
  claim Jupiter provides candles.
- Show current price, market cap, liquidity, volume, balance, and value.
- Show only the P0 warning summary: `verification`, `organicActivity`, and
  `suspicious`, plus source freshness. Do not expose holder count, authority
  fields, concentration, developer balances, or the broader audit object in
  P0.
- Mount detailed requests and visualization state only for the expanded row.
- Place Buy and Sell actions inside the expanded content.
- Return from a trade to the same row and scroll position.

P0 delivers compact decision context, not historical charting, desktop
indicators, or drawing controls.

### SPOT-P0-04 — Shared compact Trade Sheet

Build one compact, content-sized Trade Sheet used by Wallet Swap and Spot
Buy/Sell. It is bottom-anchored and may scroll on small devices, but it must not
reserve unused height.

- From asset, To asset, amount, balances, and pair reversal.
- Asset picker replaces sheet content instead of stacking another sheet.
- Buy preselects the expanded token as output.
- Sell preselects the expanded token as input and SOL as default output.
- Wallet Swap starts pair-first and does not require Spot navigation.
- Preserve pair, amount, invoking context, and scroll state through wallet
  activation and recoverable failures.
- Render composing, quoting, reviewing, awaiting-signature, submitted, and
  terminal states within one coherent flow.
- Do not reserve a fixed full-screen height. Compose and Review use the height
  their content needs while preserving safe-area padding and scroll fallback.

### SPOT-P0-05 — Jupiter backend gateway, order, and execute

Extend `packages/api/src/swap.ts`; do not add a second Jupiter proxy or any
client-side API-key path. The existing V1 `/swap/quote` upstream call is
superseded by Jupiter Swap V2 `/order`.

Required upstream Jupiter calls:

| myboon function | Jupiter endpoint | P0 use |
|---|---|---|
| Initial Terminal rows | `GET /tokens/v2/toptrending/1h?limit=<n>` | Ranked default table behind myboon eligibility filters |
| Search or resolve mint | `GET /tokens/v2/search?query=<query>` | Search by name, symbol, or mint; known-mint batches when useful |
| Batch current prices | `GET /price/v3?ids=<mints>` | Current USD price and block recency, up to Jupiter's documented batch limit |
| Quote-only order | `GET /swap/v2/order` without `taker` | Debounced amount preview; returns pricing with `transaction: null` |
| Signable order | `GET /swap/v2/order` with `taker` | Fresh review data plus the unsigned versioned transaction |
| Managed landing | `POST /swap/v2/execute` | Submit the wallet-signed transaction and obtain the terminal result |

Frozen myboon P0 API surface:

```text
GET  /swap/tokens?limit=<n>
GET  /swap/tokens/search?query=<query>
GET  /swap/prices?ids=<mints>
POST /swap/order
POST /swap/execute
```

All five routes return myboon-owned normalized JSON. Jupiter response bodies
are server-only provider DTOs and are never passed through to Expo. Every JSON
error uses this envelope:

```ts
interface SwapApiErrorResponse {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string | null;
  };
}
```

Provider error text may inform `message`, but clients branch only on the stable
myboon `code`.

#### Token discovery contracts

```ts
type OrganicActivity = 'high' | 'medium' | 'low' | 'unknown';
type VerificationState = 'verified' | 'unverified' | 'unknown';

interface SpotTokenSummary {
  identity: TokenIdentity; // mint and decimals are non-null for returned rows
  usdPrice: number | null;
  momentumPct: {
    m5: number | null;
    h1: number | null;
    h6: number | null;
    h24: number | null;
  };
  market: {
    marketCapUsd: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
  };
  warnings: {
    verification: VerificationState;
    organicActivity: OrganicActivity;
    suspicious: true | null;
  };
  updatedAt: string | null; // ISO-8601
}

interface SpotTokenListResponse {
  items: SpotTokenSummary[];
  ranking: 'toptrending_1h';
  asOf: string; // ISO-8601 server response time
  partial: boolean;
}

interface SpotTokenSearchResponse {
  query: string;
  items: SpotTokenSummary[];
  asOf: string;
  partial: boolean;
}
```

`partial: true` means the server returned usable rows while one or more
provider or identity enrichments failed. Missing optional metrics remain
`null`; a partial response never fabricates zero values.

`GET /swap/tokens` accepts only `limit`, an integer from 1 through 50 with a
default of 30. `GET /swap/tokens/search` accepts one trimmed `query` from 1
through 120 characters and returns at most 20 items. The public search route
does not expose Jupiter's comma-separated batch mode. A pasted base58 mint is
treated as an exact-mint search and exact match ranks first.

`SpotTokenSummary.identity` is resolved through the canonical Token Identity
service. Its `iconUrl` is either same-origin or `null`; Jupiter's upstream
`icon` URL is never returned. Terminal `24h` and every momentum cell use Tokens
V2 `stats5m/1h/6h/24h.priceChange`. Price V3 `priceChange24h` is intentionally
not mixed into the Terminal contract.

P0 warnings map exactly as follows:

- `isVerified: true` -> `verified`; `false` -> `unverified`; missing or `null`
  -> `unknown`;
- `organicScoreLabel` maps to `high`, `medium`, or `low`; missing values map to
  `unknown`;
- `audit.isSus: true` -> `suspicious: true`; missing, `false`, or absent audit
  data -> `suspicious: null`, never a claim of safety.

No other Tokens V2 audit field, holder count, authority field, concentration,
or developer-wallet metric crosses this P0 response boundary.

#### Price contract

```ts
interface SpotPriceResponse {
  prices: Array<{
    mint: string;
    usdPrice: number | null;
    blockId: number | null;
  }>;
  asOf: string;
}
```

`GET /swap/prices?ids=<mints>` accepts 1 through 50 unique canonical mints.
The normalized `prices` array preserves requested order. If Jupiter omits a
mint because its price is unavailable or unreliable, myboon returns that mint
with `usdPrice: null` and `blockId: null`; it never substitutes zero and does
not fail the whole batch.

#### Order contract

```ts
interface SwapOrderRequest {
  inputMint: string;
  outputMint: string;
  amountAtomic: string;
  taker?: string;
  slippageBps?: number;
}

interface SwapOrderBase {
  requestId: string;
  inputMint: string;
  outputMint: string;
  inAmountAtomic: string;
  outAmountAtomic: string;
  minimumOutAmountAtomic: string;
  inUsdValue: number | null;
  outUsdValue: number | null;
  priceImpactPct: number | null;
  slippageBps: number;
  router: 'metis' | 'jupiterz' | 'dflow' | 'okx' | 'unknown';
  route: Array<{ label: string; percent: number }>;
  fees: {
    providerFeeBps: number | null;
    providerFeeAtomic: string | null;
    providerFeeMint: string | null;
    signatureFeeLamports: string | null;
    priorityFeeLamports: string | null;
    rentFeeLamports: string | null;
    myboonFeeAtomic: '0';
    gasless: boolean;
  };
  expiresAt: string | null;
}

type SwapOrderResponse = SwapOrderBase & (
  | {
      kind: 'quote';
      taker: null;
      transaction: null;
      lastValidBlockHeight: null;
    }
  | {
      kind: 'signable';
      taker: string;
      transaction: string;
      lastValidBlockHeight: string;
    }
);
```

`POST /swap/order` accepts only those five request fields. Both mints and
optional `taker` must be valid Solana public keys. `inputMint` and `outputMint`
must differ. `amountAtomic` is a positive unsigned 64-bit decimal string. It
contains no decimal point, sign, exponent, or separators. `slippageBps`, when
present, is an integer from 0 through the product cap of 5000 (50%). If omitted,
Jupiter RTSE chooses slippage. High-slippage confirmation applies only when the
user explicitly overrides RTSE with fixed/custom slippage; an RTSE-selected
value is displayed on Review but is not misrepresented as a user setting.

No receiver, payer, referral fee, platform fee, router/DEX filter, arbitrary
Jupiter query parameter, or client-supplied priority fee is accepted in P0.
In Auto mode the server sends only Jupiter's required order fields so the order
remains in the recommended default mode with RTSE and Jupiter's optimized fee
strategy. `SWAP_PRIORITY_FEE_MAX_LAMPORTS` is a validation ceiling: a returned
signable order above it is rejected rather than silently clamping the fee shown
to the user. The exact returned `fees.priorityFeeLamports` is shown on Review.
myboon adds no fee.

Omitting `taker` creates a quote-only order and `transaction: null` is valid.
Supplying `taker` requests a signable order. A signable success must contain a
non-empty `transaction` and `lastValidBlockHeight`. If Jupiter returns an empty
transaction with `errorCode`, myboon returns HTTP 422 with a stable code:

- router `metis`, `dflow`, or `okx` code `1`, and `jupiterz` code `1` ->
  `INSUFFICIENT_FUNDS`;
- router `metis`, `dflow`, or `okx` code `2` ->
  `INSUFFICIENT_SOL_FOR_FEES`;
- router `jupiterz` code `2` -> `TOKEN_ACCOUNT_REQUIRED`;
- router `metis`, `dflow`, or `okx` code `3` -> `ORDER_BELOW_MINIMUM`;
- router `jupiterz` code `3`, and every other provider build refusal ->
  `ORDER_BUILD_FAILED`.

A `null` or empty transaction with `taker` but no recognized build refusal is
an invalid upstream response and returns `ORDER_PROVIDER_INVALID` with HTTP
502. Provider `errorMessage` is display-only and is never the branch key.

Quote preview calls `/order` without `taker` after debounce. Opening Review
calls it again with `taker`; every reviewed amount, minimum, fee, route, expiry,
and serialized transaction comes from that one fresh signable response.
`minimumOutAmountAtomic` is the authoritative minimum received.

#### Execute contract and outcome mapping

```ts
interface SwapExecuteRequest {
  signedTransaction: string;
  requestId: string;
  lastValidBlockHeight?: string;
}

interface SwapExecuteResponse {
  outcome: 'confirmed' | 'failed' | 'unknown';
  signature: string | null;
  slot: string | null;
  code: number | null;
  message: string | null;
  totalInputAmountAtomic: string | null;
  totalOutputAmountAtomic: string | null;
  inputAmountResultAtomic: string | null;
  outputAmountResultAtomic: string | null;
}
```

`POST /swap/execute` accepts only the base64 `signedTransaction`, matching
`requestId`, and optional decimal-string `lastValidBlockHeight`. Invalid input
rejected before provider dispatch uses HTTP 400 and is safe to correct. After
dispatch, outcomes map as follows:

- Jupiter `Success` with code `0`, followed by confirmation reconciliation,
  returns HTTP 200 with `outcome: confirmed`;
- Jupiter `Failed` with a known non-ambiguous code returns HTTP 200 with
  `outcome: failed`;
- Jupiter unknown codes `-1001` or `-2001`, provider timeout/disconnect after
  dispatch, or an unparseable post-dispatch response returns HTTP 202 with
  `outcome: unknown`;
- a failure proven to occur before provider dispatch returns a retryable 502
  or 503 error envelope and is not recorded as submitted.

An `unknown` response is persisted with any available `requestId` and
`signature`, reconciled against chain history, and never submitted again
automatically.

#### Shared gateway requirements

- `JUP_API_KEY` is read only by the server and added as Jupiter's `x-api-key`;
- Expo calls only the myboon API and never receives or echoes the key;
- every upstream body is schema-validated before normalization;
- token-list and Price V3 results are cached server-side; search is debounced
  on-device and cached by normalized query on the server;
- identical quote-only orders are coalesced and cached for at most two seconds;
  signable orders are never cached or shared across users;
- canonical decimals come from `TokenIdentity`; UI values become atomic
  amounts through decimal-string parsing and BigInt;
- the unsigned transaction is decoded and independently validated before the
  wallet signs it on-device;
- only the wallet-signed base64 transaction returns to the backend for
  `/execute`;
- the Jupiter key, serialized transactions, and full wallet addresses are
  redacted from ordinary logs.

A quote is not a transaction authorization. The `/order` transaction is
decoded and independently validated before signing. Jupiter `/execute` manages
landing; it never signs for the user.

Provider usage is budgeted explicitly. Values below reflect Jupiter's current
documentation and must be rechecked during implementation:

| Upstream call | Current credits | P0 cache/request behavior |
|---|---:|---|
| Token category | 5 | Shared backend cache; 30-second freshness target |
| Token search | 10 | 300–400 ms client debounce; normalized-query backend cache |
| Price V3 | 1 | Batch mints; shared short cache instead of one request per row |
| Swap V2 order | 1 | Cancel superseded previews; coalesce/cache identical quote-only requests for two seconds; always refresh the signable order for Review |
| Swap V2 execute | 0 | Never cache or automatically retry an ambiguous result |
| Portfolio positions | 100 | Not a P0 balance dependency; evaluate separately |

Keyless access is for development only. Production uses a server-held API key,
observes Jupiter's rate-limit headers, and chooses a plan from measured shared
backend traffic. The mobile client never spends the organisation's Jupiter
rate limit independently.

P0 provider-to-normalized mapping is fixed as follows:

| UI area | Source fields |
|---|---|
| Terminal row | canonical `TokenIdentity`; Tokens V2 `usdPrice` and `stats24h.priceChange` |
| Expanded momentum | Tokens V2 `stats5m.priceChange`, `stats1h.priceChange`, `stats6h.priceChange`, and `stats24h.priceChange` |
| Expanded market summary | Tokens V2 `mcap`, `liquidity`, `stats24h.buyVolume + stats24h.sellVolume`, and `updatedAt` |
| Expanded warning summary | Tokens V2 `isVerified`, `organicScoreLabel`, and only `audit.isSus === true` |
| Profile valuation | canonical Wallet raw balances multiplied by batched Price V3 `usdPrice`; missing prices stay unavailable and are not coerced to zero |
| Compose quote | normalized `/swap/order` atomic amounts, USD values, `priceImpactPct`, `slippageBps`, and normalized fees |
| Review | the same fresh signable normalized order, including `minimumOutAmountAtomic`, route, fee fields, wallet, and network |
| Terminal outcome | normalized `/swap/execute` outcome, code, signature, result amounts, and message |

Price V3 can omit a requested mint when Jupiter does not consider its price
reliable. The normalized array makes that omission explicit as `usdPrice:
null`, never `$0.00`. P0 never turns absent warning data into a safe state.

### SPOT-P0-06 — Real balances, quick trades, slippage, and review

Remove every mock balance from production trade paths. Use the canonical spot
balance source and re-read the relevant balance when constructing a trade.

Buy behavior:

- configurable quick-buy amounts such as 0.5 / 1 / 2 / 5 SOL;
- manual input asset and amount through the Trade Sheet;
- insufficient-balance state before requesting a signable order;
- reserve enough SOL for disclosed network and account-creation costs.

Sell behavior:

- 25 / 50 / 75 / 100% presets from the exact raw token balance;
- 100% uses the exact order-time balance, not a rounded display value;
- close an emptied token account only when validation proves the lamport
  destination is the user;
- refresh the expanded row and Wallet total after confirmation.

Slippage behavior:

- Auto delegates to Jupiter RTSE without typed confirmation;
- real per-trade custom input;
- explicit fixed/custom values above 5% are session-scoped and reset on a new session;
- explicit fixed/custom values above 15% require typed confirmation;
- hard cap at 50%;
- minimum received is always visible when material and required to trade;
- a failure never silently widens slippage.

Before the wallet prompt, review shows:

- active wallet/source and Solana network;
- exact input and expected output;
- minimum received;
- price impact;
- Jupiter/router fee;
- myboon fee: zero;
- priority-fee amount or ceiling;
- simulated balance changes.

### SPOT-P0-07 — Transaction validation and simulation

Validate every serialized transaction returned by myboon `/swap/order` before asking
the user to sign.

- deserialize the versioned transaction and resolve all address lookup tables;
- refuse an unresolvable lookup table;
- allowlist expected Jupiter, Token, Token-2022, Associated Token Account,
  Compute Budget, and System program ids;
- require the active wallet as fee payer;
- refuse token `Approve`, `SetAuthority`, and unexpected delegate changes;
- permit `CloseAccount` only when its lamport destination is the user;
- require the output token account to be owned by the active wallet;
- verify input mint, output mint, amount constraints, and minimum received
  against the reviewed trade;
- refuse unexpected additional signers or writable accounts.

Simulate before signature. Derive balance changes from simulation and refuse a
result below the transaction's minimum received. If simulation infrastructure
is unavailable, show an explicit warning and require a second confirmation;
never skip silently.

### SPOT-P0-08 — Execution lifecycle and recovery

Every entry path uses one execution lifecycle:

```text
quoting
  -> ordering
  -> validating
  -> simulating
  -> awaiting_signature
  -> executing
  -> confirmed | failed(reason) | unknown
```

Requirements:

- duplicate-intent lock reserved before the first asynchronous operation;
- blockhash refresh only before the wallet prompt;
- compute-budget and bounded priority-fee instructions;
- Jupiter `/execute` terminal response plus confirmation reconciliation with
  timeout;
- pending-transaction recovery after app restart;
- no automatic retry after an unknown submission;
- transaction/explorer action for submitted and terminal states;
- distinct failures for slippage, blockhash expiry, insufficient funds,
  account creation, and insufficient priority fee;
- caller-aware return behavior for Wallet and Spot.

### SPOT-P0-09 — API and discovery protection

Protect trade and discovery endpoints before production use:

- rate limiting tied to an appropriate client/session identity;
- request attestation or equivalent abuse control;
- separate limits for discovery, quote-only order, signable order, and execute
  costs;
- server-side trading kill switch;
- clean client state: **Trading is temporarily paused**;
- observability for discovery freshness, order/execute failures, validation
  refusals, simulation failures, submission outcomes, and confirmation latency;
- no wallet addresses or serialized transactions in ordinary request logs.

The kill switch stops new signable orders. It does not mark already-submitted
transactions as failed or erase pending recovery records.

## P1 — Deeper vetting, positions, and repeat use

### SPOT-P1-01 — Full token risk strip

Extend the P0 warning summary with sourced and timestamped signals for:

- mint authority;
- freeze authority;
- LP burned or locked state;
- top-holder concentration;
- developer-wallet holdings;
- bundled or sniper activity.

Use neutral, missing, or warning states—never a green “safe” assertion. Missing
data is missing, not passing. Freeze authority present blocks Buy until product
and legal policy explicitly changes.

### SPOT-P1-02 — Market-data depth

Expand the P0 compact summary with useful short-window movement, holder count,
trade count, buy/sell flow, and source comparison. Each value retains source and
freshness treatment. This is additional decision context, not the advanced
charting project.

### SPOT-P1-03 — Buy-time sellability warning

Run a small hypothetical sellability check in parallel with the quote. Report a
failed check as a warning, not proof that the token is or is not a honeypot.
State and measure a latency budget so it does not serially delay every trade.

### SPOT-P1-04 — Spot activity and cost basis

Persist enough spot activity to support position accounting. Choose raw-RPC
parsing or Helius Enhanced Transactions explicitly; define pagination,
backfill, retention, reorg handling, and rate limits.

Begin with trades executed inside myboon, where input, output, fees, and
confirmation are known exactly. Label externally acquired positions as having
unknown basis until history has been reconciled.

### SPOT-P1-05 — Average entry and PnL

For each mint, show balance, SOL-denominated average entry, current value,
realized and unrealized PnL where basis is known, and an honest unknown-basis
state. PnL is informational and never ranks or promotes tokens.

### SPOT-P1-06 — Watchlist

Let users star tokens from the expanded row. Add Watchlist to the same Spot Hub
with price movement, liquidity context, and Buy/Sell actions that reuse the
Trade Sheet.

### SPOT-P1-07 — Spam and dust hygiene

- collapse low-value unverified tokens into a hidden bucket;
- exclude spam valuations from portfolio totals;
- persist manual hide/unhide decisions;
- exempt tokens deliberately traded in myboon from automatic hiding;
- never auto-link token-supplied metadata;
- apply unverified styling consistently;
- offer burn-and-close only through the reviewed and validated transaction
  lifecycle.

## P2 — Monitoring and advanced spot execution

### SPOT-P2-01 — Price alerts

Persist alert subscriptions, run the watcher outside the request/response API,
and measure p95 detection-to-device delivery before making a latency promise.

### SPOT-P2-02 — Safe alert deep links

An alert deep link carries only the canonical token identifier and opens the
Spot Hub with that token expanded. Amount, slippage, and output asset are chosen
inside the Trade Sheet after arrival.

### SPOT-P2-03 — Wallet-event alerts

Track developer-wallet and large-holder sales through streaming account
subscriptions and maintained holder sets, not the price-alert polling loop.

### SPOT-P2-04 — Token-first venue navigation

Inside expanded token context, show other myboon venues where the same canonical
token is available, grouped by intent: spot, directional leverage, or liquidity
provision. Hide empty groups. Navigation does not silently move funds.

### SPOT-P2-05 — Advanced chart interaction

Introduce a historical-data provider only after product approves a source,
licence, retention contract, freshness SLO, and failure behavior. Possible
scope includes real candles, more time windows, and trade markers. Jupiter
interval-change statistics must never be presented as historical candles.
Desktop drawing tools and indicator parity remain excluded.

### SPOT-P2-06 — Take-profit orders

Evaluate Jupiter Trigger for best-effort take-profit orders. Before shipping:

- disclose router and execution fees;
- show and cancel every open order, including after reinstall;
- state that execution depends on liquidity;
- never describe a trigger as guaranteed;
- complete security and legal review;
- prohibit delegated session keys and server-held wallet authority.

## Explicitly out of scope

### Wallet platform work

- wallet connection-sheet design or ownership;
- email/Google authentication UX;
- Solana versus Polygon presentation;
- global wallet manager and venue-profile separation;
- external-wallet versus myboon-wallet signer precedence;
- wallet recovery-method selection;
- external EVM wallet connectivity;
- generic Send, Receive, bridge, and cross-chain balance movement.

### Trading and discovery exclusions

- Jupiter as an app, venue, profile, or branded destination;
- editorially curated or personalized token recommendations;
- paid token placement or undisclosed ranking influence;
- automatic trading, delegated signing, or server-held private keys;
- limit orders, stop-loss, DCA, and recurring orders before the P2 trigger
  decision;
- integrator-sponsored gasless swaps, custom relayers, and a product promise of
  gasless execution; an automatically gasless Jupiter order may still be
  executed and accurately disclosed;
- cross-venue funding;
- desktop charting-terminal parity;
- CSV and tax export;
- visual redesign of unrelated venue screens.

An objective Jupiter-ranked default Terminal table with myboon eligibility
filters is in scope. A feed that myboon edits, personalizes, sponsors, or
presents as a recommendation is not.

## Acceptance criteria

1. The Wallet's Spot row is visibly tappable and opens `/spot`.
2. The Wallet exposes a clear Swap action that opens the native Trade Sheet
   without first visiting Spot.
3. A user can swap 10 USDC to JUP through From/To selection, review, signature,
   and confirmation without encountering a Jupiter venue screen.
4. Spot renders the token table immediately below the header, persistent search
   above bottom navigation, and bottom Terminal / Profile tabs.
5. Spot renders no Market intro block or Trending / New / Gainers category
   chips; the backend uses Jupiter `toptrending/1h` as the hidden default
   ranking input and records freshness and eligibility diagnostics.
6. Tapping a token expands it inline; expanding another collapses the first;
   collapsed rows do not retain detailed requests or visualization state.
7. `/spot?token=<mint>` opens the Spot Hub with the canonical token expanded
   and back behavior returns predictably to `/spot` or the previous caller.
8. The expanded row shows Jupiter `5m / 1h / 6h / 24h` momentum, required
   market context, position, the exact P0 warning summary, warning freshness,
   and Buy/Sell actions; it does not fabricate a historical line chart or
   expose P1 risk fields.
9. Wallet Swap, token Buy, and token Sell use one Trade Sheet, one quote
   contract, one validation path, and one execution lifecycle.
10. Returning from Buy or Sell preserves Spot scroll position and expansion and
    refreshes the affected balance. Returning from Swap refreshes Wallet.
11. Asset selection replaces Trade Sheet content rather than stacking another
    bottom sheet.
12. A confirmed Buy exposes 25 / 50 / 75 / 100% Sell actions, and 100% uses the
    exact raw balance without avoidable token dust.
13. No mock balance or floating-point atomic-amount construction remains in a
    production trade path.
14. Every review shows exact input, expected output, minimum received, price
    impact, Jupiter fee, zero myboon fee, bounded priority fee, and simulated
    balance changes.
15. The validator refuses disallowed programs, unresolved ALTs, wrong fee
    payer, unexpected assets/accounts, approvals, authority changes, and unsafe
    close-account instructions with automated coverage.
16. An ambiguously submitted transaction becomes `unknown`, survives restart,
    links to chain history, and is never retried automatically.
17. Trade endpoints are protected from open-proxy abuse and can be disabled
    remotely without an app release.
18. The product contains no Jupiter app tile, Jupiter venue profile, or separate
    Jupiter navigation hierarchy.
19. Wallet connectivity, authentication, chain presentation, and signer
    precedence do not appear as spot implementation items.
20. No Expo production bundle contains `JUP_API_KEY`,
    `EXPO_PUBLIC_JUP_API_KEY`, or a client-created Jupiter `x-api-key` header.
21. Token discovery, Price V3, Swap V2 `/order`, and Swap V2 `/execute` flow
    through the existing myboon server proxy as the frozen normalized DTOs in
    this PRD, with no Jupiter pass-through body, route-level validation,
    caching where safe, rate limits, redacted logs, and automated tests.
22. Compose and Review Trade Sheet states reserve no unused full-screen height
    and match the approved compact mock behavior.
23. Profile shows raw display balances and current Price V3 values only. Missing
    prices remain unavailable; daily portfolio gain, cost basis, PnL, and best
    performer do not render in P0.
24. Every token icon returned through Spot is same-origin through
    `TokenIdentity`, and the Expo client never receives Jupiter's raw `icon`
    URL.
25. `/swap/execute` distinguishes confirmed, known failed, and unknown outcomes
    exactly as specified; an unknown outcome returns HTTP 202, persists for
    reconciliation, and cannot auto-retry.

## Product measurement

Instrument the two funnels separately without logging signed payloads or
private wallet material.

### Discovery-first funnel

```text
Spot opened
  -> token list rendered
  -> token expanded
  -> Buy or Sell selected
  -> quote received
  -> review shown
  -> signature requested
  -> submitted
  -> confirmed | failed | unknown | cancelled
```

### Pair-first funnel

```text
Swap opened
  -> pair selected
  -> amount entered
  -> quote received
  -> review shown
  -> signature requested
  -> submitted
  -> confirmed | failed | unknown | cancelled
```

Primary measures:

- Wallet-to-Spot open rate;
- Wallet-to-Swap open rate;
- Terminal-row impression-to-expansion rate;
- Profile open rate and held-token expansion rate;
- search and mint-resolution success rate;
- token-expansion-to-Buy/Sell rate;
- Swap-open-to-valid-quote time;
- quote-only order, signable order, and execute success rate;
- review-to-signature rate;
- submission-to-confirmation rate;
- median and p95 time to confirmed trade by entry path;
- confirmed-buy-to-successful-exit rate;
- failure and unknown-outcome rate by reason.

Report execution reliability separately for myboon and external Solana signers.
The comparison is diagnostic and never silently changes signer selection.

## Risks and required failure behavior

**A ranked default table can look like a recommendation.** Use Jupiter's
objective ranking input plus documented eligibility filters, never sell
placement, and never render a green safety assertion without a separate policy
and disclosure.

**Inline detail can destroy list performance.** Only one row expands. Collapsed
rows unmount detailed state and requests. Preserve list virtualization.

**A line chart can imply data Jupiter did not provide.** P0 renders explicit
interval changes as momentum. A genuine chart waits for a separately approved
historical provider.

**A client-side Jupiter key is extractable.** All Jupiter calls remain behind
the existing server proxy. Keep the regression test that proves the Expo client
does not read or attach the key.

**Nested sheets create broken mobile navigation.** The asset picker replaces
Trade Sheet content. Wallet activation returns to the same Trade Sheet rather
than opening competing local connection sheets.

**Route state and visual state can diverge.** The expanded mint has one
canonical owner. Search, deep links, row taps, and back navigation all update the
same route-backed state.

**A stale balance can produce a wrong Max trade.** Re-read balances before the
signable order; never construct a transaction from display cache alone.

**A provider-assembled transaction can be malicious or corrupted.** Client-side
decoding and validation remain mandatory even when it arrived through
myboon's server.

**A quote can move before signature.** The reviewed transaction's minimum is
authoritative. Re-quoting requires a new review; the client never substitutes a
different trade invisibly.

**An unknown submission may already have landed.** Never auto-retry. Preserve
the transaction signature, check chain history, and reconcile balances.

**Persisted high slippage outlives its context.** Reset dangerous tiers at the
session boundary and explicitly confirm extreme values.

**PnL beside Buy can create recommendation pressure.** Never rank or promote
tokens by user profit, return, or projected return.

## Resolved P0 implementation defaults

1. The Wallet action rail keeps **Transfer** as a distinct fourth action and
   adds **Swap**; no existing intent is silently renamed.
2. The Terminal requests 30 rows by default (the gateway caps requests at 50),
   then requires canonical mint/decimals, a valid first-pool route signal, at
   least `$10,000` liquidity, high or medium organic activity, and no
   `spam`/`scam` tag. Search keeps the identity, route, and spam checks but may
   return lower-liquidity or low-organic tokens with their warning state.
3. Wallet Swap always starts from the predictable SOL-to-USDC pair in P0; it
   does not persist the last pair.
4. Quick Buy ships with `0.5 / 1 / 2 / 5 SOL`, configured in the shared Trade
   Sheet implementation.
5. Quick Sell defaults to SOL. The input token remains fixed, while the output
   picker may choose another eligible token without leaving the Trade Sheet.
6. The server-owned priority-fee ceiling defaults to `1,000,000` lamports and
   is deployment-configurable. A failed-to-land result says that congestion or
   the configured ceiling may be responsible and requires a fresh review; it
   never claims priority fee was the cause when Jupiter cannot prove that.

These defaults do not reopen wallet connectivity or make Jupiter a venue. P1
choices such as cost-basis history source and buy-time sellability latency
remain deliberately deferred.

## Sequencing

1. **Structural shell.** Make Spot tappable, add `/spot`, add the Wallet Swap
   entry, and establish route-backed expanded-token state.
2. **Spot discovery.** Table-first Terminal, bottom search, Profile, list
   states, and one-at-a-time inline expansion.
3. **Token context.** Jupiter momentum, market summary, balance, warnings, and
   Buy/Sell actions inside the expanded row.
4. **Shared Trade Sheet.** Wallet Swap plus preconfigured Buy/Sell, asset-picker
   replacement, caller-state preservation, and review shell.
5. **Provider gateway and exact amounts.** Extend the existing server proxy for
   Jupiter Tokens V2, Price V3, Swap V2 order/execute, complete review data,
   BigInt math, real balances, presets, and slippage rules.
6. **Validation and execution.** Decode, simulate, review, sign, submit,
   confirm, recover, and render precise terminal states.
7. **Production protection.** Rate limits, attestation, kill switch,
   observability, and log redaction.
8. **Retention.** Risk depth, market depth, cost basis, PnL, Watchlist, and spam
   hygiene.
9. **Monitoring and advanced execution.** Alerts, safe deep links, venue
   navigation, advanced charts, and best-effort triggers.

Steps 1–7 constitute P0. The order expresses product and technical dependency;
independent data and infrastructure work may proceed in parallel.

## P0–P2 working reference

Use these stable IDs in spot-trading issues and implementation handoffs. They
deliberately contain no wallet-connectivity item.

### P0 — Wallet-native Spot and complete execution

- [ ] **SPOT-P0-01 — Wallet entry points and Spot Hub**
- [ ] **SPOT-P0-02 — Terminal table, bottom search, and Profile**
- [ ] **SPOT-P0-03 — Inline token expansion and Jupiter momentum**
- [ ] **SPOT-P0-04 — Shared compact Trade Sheet**
- [ ] **SPOT-P0-05 — Jupiter backend gateway, order, and execute**
- [ ] **SPOT-P0-06 — Real balances, quick trades, slippage, and review**
- [ ] **SPOT-P0-07 — Transaction validation and simulation**
- [ ] **SPOT-P0-08 — Execution lifecycle and recovery**
- [ ] **SPOT-P0-09 — API and discovery protection**

### P1 — Deeper vetting, positions, and repeat use

- [ ] **SPOT-P1-01 — Full token risk strip**
- [ ] **SPOT-P1-02 — Market-data depth**
- [ ] **SPOT-P1-03 — Buy-time sellability warning**
- [ ] **SPOT-P1-04 — Spot activity and cost basis**
- [ ] **SPOT-P1-05 — Average entry and PnL**
- [ ] **SPOT-P1-06 — Watchlist**
- [ ] **SPOT-P1-07 — Spam and dust hygiene**

### P2 — Monitoring and advanced spot execution

- [ ] **SPOT-P2-01 — Price alerts**
- [ ] **SPOT-P2-02 — Safe alert deep links**
- [ ] **SPOT-P2-03 — Wallet-event alerts**
- [ ] **SPOT-P2-04 — Token-first venue navigation**
- [ ] **SPOT-P2-05 — Advanced chart interaction**
- [ ] **SPOT-P2-06 — Take-profit orders**

## Developer reading order

The assignee should read these in order before changing implementation:

1. `docs/modules/wallet/PRDs/2026_08_12_wallet_completion_meme_trader_PRD.md`
   — this document; authoritative product and P0 integration scope.
2. `docs/mockups/wallet-spot-screen-mock.html` — authoritative Spot layout and
   interaction reference: table-first Terminal, bottom search, bottom
   Terminal/Profile tabs, one inline expansion, the four-window momentum strip,
   and the P0-safe current-value Profile.
3. `docs/mockups/wallet-trade-sheet-mock.html` — authoritative compact Wallet
   Swap and prefilled Buy/Sell Trade Sheet reference, including custom
   slippage, simulated balance changes, Review, signing, submission, confirmed,
   failed, and unknown states.
4. `docs/modules/wallet/specs/token_identity.md` — authoritative mint,
   decimals, identity, icon, and long-tail token resolution contract.
5. `docs/modules/wallet/specs/wallet_connectivity.md` — completed signer and
   wallet-state contract consumed by trading; not implementation scope here.
6. `docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md`
   — historical design context for the token service, icon proxy, and removal
   of the Jupiter key from Expo.
7. `docs/modules/wallet/qa/2026_08_11_token_identity_test_cases.md` — evidence
   and regression cases for icon proxying, Jupiter server proxying, and the
   client-key leak fix.
8. `docs/DEPLOY.md` — deployment environment and server-secret handling.

Supporting visual context:

- `docs/mockups/wallet_mock.html` — original Wallet visual language and account
  rows used by both approved mocks.
- `docs/modules/wallet/PRDs/2026_07_26_wallet_connectivity_restructure_PRD.md`
  — historical wallet-platform context only. If it conflicts with the current
  wallet connectivity spec, the spec wins.

## Implementation references

### Wallet and Spot entry

- `apps/hybrid-expo/features/home/HomeScreen.tsx`
- `apps/hybrid-expo/features/wallet/WalletActivityTiles.tsx`
- `apps/hybrid-expo/features/wallet/WalletAccountRow.tsx`
- `apps/hybrid-expo/features/wallet/wallet.sources.ts`
- `apps/hybrid-expo/features/wallet/useProtocolAccounts.ts`

### Existing Jupiter and token backend

- `packages/api/src/swap.ts` — extend this proxy; it already owns
  `JUP_API_KEY`, Tokens V2 search, Price V3, and the legacy V1 quote path.
- `packages/api/src/swap.test.ts` — extend server forwarding, header, failure,
  normalization, and redaction coverage.
- `packages/api/src/bootstrap/config.ts` — existing server-only key wiring;
  add and validate `SWAP_PRIORITY_FEE_MAX_LAMPORTS` for production.
- `packages/api/src/bootstrap/create-app.ts` — existing `/swap` route mount.
- `packages/api/src/spot.ts` — precedent for keeping upstream provider keys on
  the server.
- `packages/api/src/tokens/jupiter-tokens.ts` — existing Jupiter mint cache;
  coordinate rather than introduce a competing long-tail cache.
- `packages/api/src/tokens/identity-service.ts`
- `packages/api/src/tokens/icon-proxy.ts`
- `packages/api/src/tokens/routes.ts`

### Existing swap client

- `apps/hybrid-expo/app/swap.tsx`
- `apps/hybrid-expo/features/swap/SwapScreen.tsx`
- `apps/hybrid-expo/features/swap/swap.api.ts` — already calls the myboon
  server proxy; replace floating-point/V1 preview behavior without restoring a
  direct Jupiter client.
- `apps/hybrid-expo/features/swap/swap.types.ts`

### Execution and safety precedent

- `apps/hybrid-expo/features/meteora/meteora.execution.native.ts`
- `apps/hybrid-expo/features/predict/predict.signing.ts`
- `apps/hybrid-expo/features/chain/`
- `packages/tx-parser/src/rpc.ts`
- `packages/tx-parser/src/parsers/`

## External Jupiter references

- [Jupiter complete documentation index](https://developers.jup.ag/docs/llms.txt)
- [Tokens V2 overview](https://developers.jup.ag/docs/tokens)
- [Token information, categories, search, and response fields](https://developers.jup.ag/docs/tokens/token-information)
- [Price V3](https://developers.jup.ag/docs/price)
- [Swap V2 overview](https://developers.jup.ag/docs/swap)
- [Swap V2 Order and Execute guide](https://developers.jup.ag/docs/swap/order-and-execute)
- [Swap V2 `/order` reference](https://developers.jup.ag/docs/api-reference/swap/order)
- [Swap V2 `/execute` reference](https://developers.jup.ag/docs/api-reference/swap/execute)
- [Portfolio positions beta](https://developers.jup.ag/docs/portfolio/jupiter-positions)
- [API plans and endpoint credits](https://developers.jup.ag/docs/portal/plans)
- [Rate limits and response headers](https://developers.jup.ag/docs/portal/rate-limits)
- [Client-key exposure and firewall guidance](https://developers.jup.ag/docs/portal/firewall)
- [Jupiter Trigger, P2 evaluation only](https://developers.jup.ag/docs/trigger)

## Other future-provider references

These are not Jupiter-only P0 dependencies:

- [Helius DAS API](https://www.helius.dev/docs/das-api) — possible later
  history/asset support after a separate decision.
- [Expo Notifications](https://docs.expo.dev/push-notifications/overview/) — P2
  alerts only.
