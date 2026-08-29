# Meteora DLMM App PRD

Status: decision-aligned draft for final review
Date: 2026-07-15
Owner: myboon Apps
Platform: mobile-first Expo app, Android beta first

> **Implementation note (2026-08-29):** A Meteora beta surface and wallet
> position integration now exist. This PRD remains the dated design record; see
> [`../markets.md`](../markets.md) for the current product-level integration
> status and [`../VISION.md`](../VISION.md) for current positioning.

## Purpose

Add Meteora as the first liquidity application inside myboon.

The experience follows the product pattern already used by myboon:

```text
Options -> Execution -> Profile

Meteora pools -> Liquidity or limit order -> Positions and orders
```

The purpose is not to reproduce Meteora's desktop terminal on a phone. It is to
turn the important parts of Meteora DLMM into a clear mobile journey that fits
myboon's context-to-action product:

```text
Feed explains a liquidity development
  -> user opens Meteora from Apps
  -> user compares Meteora-approved pools
  -> user understands the position they are creating
  -> user signs with their own Solana wallet
  -> myboon shows and manages the resulting position
```

## Beta Scope Amendment (2026-07-21)

Status: supersedes conflicting scope below. Added after implementation review
found the original P0 scope too large to ship coherently as a first beta —
the execution surface (range presets, three distributions, Zap In, limit
orders, manual bin entry) grew faster than the actual beta job, which is:
**discover an open position, update it, close it.** This amendment narrows P0
to that job. Everything trimmed here is reclassified from "P0" to
"Postponed" — it is not deleted from the document, since the fuller vision
this PRD describes remains the intended direction after beta.

### Beta P0 (what ships)

- Browse Meteora-approved pools, open one, see its price/liquidity/fees.
- Create a liquidity position: two-token deposit only, one server-calculated
  default range (no manual entry, no Focused/Balanced/Wide picker), with a
  choice of **Spot, Curve, or Bid-Ask distribution** — the distribution
  picker is kept for beta since it is already built and working.
- Manage an existing position directly from its Profile row: **Claim fees**,
  **Add liquidity**, **Remove liquidity (partial or full)**, **Close**.
- Claim and Remove are lightweight action-sheet flows launched from the
  Profile position row — they do not need a dedicated Position Detail page
  or a price chart.
- Add reuses the create-position amount step only: it must know it is adding
  to an existing position (range and distribution are already fixed) rather
  than re-offering goal/range choices. The existing distribution is shown as
  fixed context, not re-selectable.
- Close is Remove 100% plus explicit destructive confirmation, then account
  close.

### Reclassified from P0 to Postponed for beta

- Buy lower / Sell higher position goals (single-sided DCA positions) — Earn
  fees / two-token only for beta.
- Focused / Balanced / Wide range presets and manual min/max price entry —
  one calculated default range for beta.
- Ape In / Zap In ("Start with one token") — the code path is already
  disabled (`METEORA_ZAP_EXECUTION_ENABLED = false`); the UI branch should be
  removed for beta too, not just the execution flag.
- DLMM limit orders in full (discovery, place, monitor, partial fill,
  cancel, close) — this is a parallel product bolted onto the liquidity
  PRD; it gets its own scoping pass later. The Profile "Orders" tab and its
  empty state are also postponed with it.
- A dedicated Position Detail route/screen — superseded by the action-sheet
  approach above; revisit only if real usage shows the action sheets are
  insufficient.

This does not change anything under Security and Risk Controls, Token
Policy, Transaction Lifecycle, or Accessibility — those requirements apply
in full to whatever ships, beta or not.

## Decision Summary

The following decisions were confirmed during founder review:

1. The first Meteora integration covers **DLMM liquidity positions and DLMM
   limit orders**.
2. The user-facing structure is **Pools -> Execution -> Profile**, where
   execution can be liquidity or a limit order.
3. myboon shows Meteora-approved pools and excludes pools Meteora marks as
   blacklisted. myboon does not invent a separate volume-based approval list.
4. Pool discovery is public. A wallet is required only for execution and
   personal positions.
5. Liquidity P0 supports three plain-language position goals:
   **Earn fees**, **Buy lower**, and **Sell higher**.
6. Users can choose Focused, Balanced, or Wide presets or enter manual min/max
   prices. myboon translates prices into valid DLMM bins.
7. Solana transaction signing remains on the user's device. myboon never holds
   the user's wallet key.
8. P0 execution requires a wallet with Solana transaction support through
   Mobile Wallet Adapter. The current Privy embedded wallet remains read-only
   for Meteora.
9. Meteora reads and transaction construction go through a reusable server-side
   integration, while the mobile app owns review, local ephemeral position/order
   signing, wallet approval, progress, and reconciliation.
10. Position management includes add, claim, remove, and close. P0 also includes
    Ape In/Zap In and limit-order place, monitor, cancel, and close flows.
    Rebalance and pool creation are postponed.

No included P0 action may require the user to finish the journey in Meteora's
app. External links are limited to documentation, support, audits, and Solana
explorer verification.

Approval of this PRD changes an earlier beta-readiness assumption. The current
Beta Readiness Sprint PRD says to hide Meteora and postpone LP execution. After
this PRD is approved, those clauses must be updated so Meteora becomes the first
P0 LP application instead of a hidden future tile.

## Product Problem

Liquidity providers currently need to move between a dense pool explorer, a
desktop-style terminal, a wallet, and portfolio tools. Meteora's own app exposes
rich information, but its pool table and four-panel Dynamic Terminal are too
dense to copy directly into myboon's mobile experience.

The mobile user still needs to answer five questions safely:

1. Which pool is worth inspecting?
2. What tokens and pool conditions am I taking exposure to?
3. Where will my liquidity sit, and what happens if price leaves that range?
4. Exactly what will I deposit and sign?
5. After signing, is my position active, out of range, earning fees, or in need
   of attention?

myboon's job is to preserve those decisions while removing desktop terminal
noise.

## Why Meteora Fits myBoon

Meteora adds the first liquidity action to the Apps layer:

```text
Feed    = what changed and why it matters
Apps    = where the user can inspect or act
Wallet  = the user's cross-product state
```

Meteora is especially useful for myboon because a liquidity position has an
evolving context: price range, volatility, volume, fees, incentives, and
in-range state can all change. P0 builds the truthful action and position
foundation. Later work can connect Feed Stories to relevant Meteora pools and
position changes.

## Meteora Product Knowledge Used by This PRD

Meteora DLMM is a concentrated-liquidity market maker built from discrete price
bins. One bin is active at the current pool price. Liquidity earns trading fees
when swaps use the bins covered by the position. When the active price moves
outside the user's range, the position becomes inactive and stops earning fees
until price returns or the user changes the position.

DLMM supports:

- concentrated price ranges
- two-token and single-sided deposits
- dynamic fees that can rise with volatility
- Spot, Curve, and Bid-Ask liquidity distributions
- liquidity-mining rewards on eligible pools
- adding and removing liquidity from positions
- claiming accumulated fees and rewards
- position ranges that may require multiple transactions when wide
- Token-2022 assets, subject to extension and token-badge rules

Important limits for product language:

- concentrated liquidity does not remove impermanent loss
- a narrow range may capture more fees per dollar while in range, but can go
  inactive faster
- a wide range may remain active through more movement, but spreads liquidity
  more thinly
- fees do not auto-compound in DLMM; users claim them
- 24-hour APR/APY is an extrapolation, not a promised return
- DLMM liquidity is not connected to Meteora Dynamic Vault lending yield
- pool price can diverge from the wider market price, especially in a new or
  thin pool
- audits reduce some uncertainty but do not guarantee a smart contract or token
  is safe

## P0 Scope

The original P0 vision is preserved below for reference, but is now governed
by the Beta Scope Amendment above — where the two disagree, the amendment
wins. The beta journey is:

```text
open Meteora
  -> browse Meteora-approved pools
  -> inspect one pool
  -> choose a position goal (Earn fees only for beta), a distribution
     (Spot, Curve, or Bid-Ask), and the calculated default range
  -> enter token amounts (two-token only for beta)
  -> review current data, costs, and risks
  -> connect a supported Solana wallet
  -> sign the required transaction step(s)
  -> see confirmed or recoverable status
  -> see the new position in Profile
  -> claim, add, remove, or close directly from the position row
```

### Included in P0 (full vision — see Beta Scope Amendment for what beta actually ships)

- Home Apps tile opens Meteora
- Meteora-approved DLMM pool list, pagination, search, sorting, and refresh
- pool detail with decision-level metrics and compact price chart
- Earn fees, Buy lower, and Sell higher position goals — **beta: Earn fees only**
- Spot, Curve, and Bid-Ask mapping under those user goals — **beta: kept, all three available**
- Focused, Balanced, and Wide range presets with actual min/max prices — **beta: one calculated default range**
- manual min/max price entry with server-side bin snapping and validation — **postponed for beta**
- two-token deposits for centered fee positions
- valid single-sided deposits for below-price or above-price DCA positions — **postponed for beta (depends on Buy lower/Sell higher)**
- Ape In/Zap In so a user can start an Earn fees position with one token while
  the flow swaps the required portion before adding liquidity — **postponed for beta**
- liquidity-slippage control with a sensible default and guarded maximum
- separate swap quote, price-impact, route, and slippage review for Zap In — **postponed for beta (depends on Zap In)**
- preview of token amounts, range, fee conditions, rent, network cost, and
  transaction count
- DLMM limit-order discovery on pools that support limit orders — **postponed for beta**
- limit Buy and Sell entry with manual price, amount, bin snapping, and review — **postponed for beta**
- open, partially filled, canceled, closable, and closed limit-order states — **postponed for beta**
- limit-order cancel and close/reclaim flows — **postponed for beta**
- supported external Solana wallet execution
- transaction simulation, signing, confirmation, and indexer reconciliation
- open position profile grouped by pool
- per-position range and in-range status
- current balance, unclaimed fees/rewards, and source-timestamped P&L when
  available
- add liquidity, claim fees/rewards, partial remove, full remove and close —
  **beta: as action-sheet flows from the Profile position row, not a
  dedicated Position Detail screen**
- recent position and limit-order activity — **beta: position activity only**
- accessibility, stale-data, failure, feature-flag, and rollback behavior

### Explicitly Postponed

- DAMM v1 and DAMM v2
- Dynamic Bonding Curve and token launches
- Dynamic Vault, Stake2Earn, Presale Vault, and Alpha Vault
- standalone swaps inside Meteora; the swap embedded in Ape In/Zap In is
  postponed with Zap In for beta
- Zap Out into one preferred token
- creating pools
- arbitrary manual bin-ID editing and 1,400-bin expert layouts; manual
  min/max price entry is postponed for beta (see amendment)
- TradingView indicators, drawing tools, and saved chart layouts
- executing Meteora's pool-price sync flow
- automatic or one-tap rebalance
- Claim All and Close All across many positions
- auto-compounding
- notifications and out-of-range alerts
- LP copy strategies or return recommendations
- embedded Privy-wallet transaction execution
- permissionless advanced Token-2022 execution
- unified myboon wallet net worth derived from Meteora positions
- DLMM limit orders in full, Buy lower / Sell higher goals, Curve/Bid-Ask
  distributions, range presets and manual entry, Ape In/Zap In, and a
  dedicated Position Detail screen — see Beta Scope Amendment

## User-Facing Language

Use the terms users need to make a decision:

| Internal or protocol term | P0 user-facing term |
| --- | --- |
| LbPair | Pool |
| token X / token Y | Token symbols or token names |
| active bin | Current pool price |
| lower/upper bin ID | Min price / Max price |
| Spot | Even distribution |
| Curve | Focused near current price |
| Bid-Ask | More liquidity toward the range edges |
| position account | Position |
| place_limit_order | Place limit order |
| cancel_limit_order | Cancel order |
| close_limit_order_if_empty | Close order and reclaim remaining assets/rent |
| Ape In / Zap In | Start with one token |
| fee/TVL ratio | 24h fees relative to liquidity |
| out_of_range | Out of range — not earning swap fees now |

The technical strategy name can appear in an expandable explanation. It should
not be the first thing a new user must understand.

Do not use `safe`, `guaranteed`, `best`, `passive income`, or `expected return`
for a pool or strategy. Do not label the widest preset as safe. Use `Focused`,
`Balanced`, and `Wide`, each with its real range and trade-off.

## Information Architecture

### Route proposal

```text
Home / Apps / Meteora tile
  -> /apps/meteora
       Pools (options)
       Profile entry

/apps/meteora/pools/:poolAddress
  Pool detail
  Liquidity tab: add liquidity or Start with one token
  Limit tab: place a Buy or Sell limit order when supported

/apps/meteora/profile
  Positions, Limit orders, and recent history

/apps/meteora/positions/:positionAddress
  Position detail and management

/apps/meteora/limit-orders/:orderAddress
  Limit-order detail, fill state, cancel, and close
```

This establishes `/apps/:app` as the clean route convention for new Apps. The
existing Polymarket, Pacifica, and Phoenix routes do not need to move in this
work.

### Navigation rules

- Meteora's Home tile opens Pools.
- The Meteora mark and app name stay visible in its top bar.
- A Profile action is visible from Pools and every pool detail.
- Back returns to the prior Meteora surface and never unexpectedly returns Home.
- A Feed-to-Meteora deep link may open a pool directly, but the pool must pass
  the same Meteora-approval, technical-support, and freshness checks as a pool
  opened from the list.
- Wallet connection is requested only when the user previews or manages an
  action, not while browsing.
- Pool detail defaults to Liquidity. Limit appears only when the pool's on-chain
  mode supports DLMM limit orders.

## Translating Meteora's App Into myBoon

Meteora's current app emphasizes a very wide pool table and a four-area Dynamic
Terminal. myBoon translates those areas into a mobile sequence:

| Meteora app area | myBoon mobile placement |
| --- | --- |
| Large pool table with many columns | Scannable pool rows with the four most useful comparison metrics |
| Pool and token insight panel | Pool overview and expandable Risk & details section |
| TradingView chart | Compact, touch-friendly price chart with a text summary |
| Position creation panel | Guided Liquidity flow, manual/preset ranges, and review sheet |
| Ape In | Start with one token inside the Liquidity flow |
| Limit-order controls | Limit tab on supported pool detail |
| Open positions and orders | Meteora Profile with Positions and Limit orders |
| Position/order management panel | Dedicated position or order detail actions |

We retain Meteora's information richness through hierarchy and progressive
disclosure, not by placing every metric on the first screen.

### Confirmed Penpot direction

- Pools use compact data rows following the existing Pacifica and Phoenix list
  language, not large pool cards.
- The liquidity execution surface is one scrollable form inspired by Meteora's
  own Create Position panel: amount, auto-fill/funding mode, strategy, price
  range, exact min/max controls, bin/range information, costs, and the primary
  wallet/action button.
- The execution form does not add a separate Review page or a generic `Review`
  button. Required facts and costs appear inline above the final action.
- The draggable liquidity-range visualization is required. Penpot explores two
  variants for the separate market-price chart: one compact chart and one
  without it. The range visualization remains in both.
- Manual range uses both draggable handles and exact min/max price fields.
- Meteora identity is intentionally stronger than in existing Apps. The myboon
  shell, spacing discipline, navigation, and safety language remain, while
  Meteora's visual character, logo, and application-specific accents dominate
  the working surface.
- Profile opens from the top-right action on both Pools and Pool detail. It
  leads with a flat portfolio ledger, followed by Positions, Limit orders, and
  History. Status and recovery information stays with the relevant row; there
  is no separate `Needs attention` section.
- The profile summary is not enclosed in a pill or decorative card. Metrics use
  the same compact, divided data layout as the rest of the Meteora application.

## Screen 1: Pools — Options

### Purpose

Help the user find and compare a Meteora-approved DLMM pool through compact rows
that extend the existing Pacifica and Phoenix list pattern.

### Header

- back/Home behavior consistent with other Apps
- Meteora identity
- `Profile` action

### Pool row

Every row shows:

- token pair symbols and icons
- verification state expressed in text, not only an icon
- current pool price in the quote token
- TVL
- 24-hour volume
- 24-hour fees or 24-hour fees relative to TVL
- optional reward indicator when the pool has active rewards
- supported action label: Liquidity, Limit, or both
- freshness state when data is not current

The row must not lead with APY. If APR/APY is exposed in expanded details, it is
labeled `24h annualized` and accompanied by `not a forecast`.

### Search and sort

- search by token symbol, token name, pair name, or pool address
- default sort: 24-hour volume descending
- alternate sorts: TVL, 24-hour fees, and 24-hour fees/TVL
- results are paginated; infinite scroll must retain the current scroll position
- search is debounced and cancellable
- sort choice can persist locally, but no account setting is required

### Meteora approval and technical-support gate

The myboon API returns pools approved by Meteora for the relevant DLMM use:

- `is_blacklisted` is false
- both tokens are verified through the Meteora-provided metadata/token path
- both tokens have usable metadata and decimals
- the pool is the supported DLMM program and is active
- pool state can be read from RPC
- current price, fee configuration, and token reserves are valid
- no unsupported Token-2022 extension or unresolved freeze/transfer behavior
- the requested action matches the pool function mode; a liquidity-mining pool
  is not silently treated as a limit-order pool or vice versa

myboon may temporarily deny a pool for a confirmed technical or security
problem, but it does not create a separate approval ranking based on TVL or
volume. TVL and volume remain comparison data. A server-side emergency denylist
always wins so an unsafe integration path can be rolled back without an app
release.

### States

- **Initial loading:** shaped skeleton rows, not a blank screen
- **Refreshing:** keep current rows and show refresh progress
- **No search result:** preserve search and provide Clear search
- **No approved pools:** explain that no Meteora-approved pools are currently available
- **Stale cache:** show the data age and keep browse available
- **Unavailable:** show a retry action; core P0 actions must not depend on
  handing the user back to Meteora's app
- **Rate limited:** serve approved cached data when possible and honor retry timing

## Screen 2: Pool Detail and Execution

**Beta note:** this screen serves both "create a new position" and "add to an
existing position." For beta, Earn fees / two-token / one calculated default
range are live, and the Spot / Curve / Bid-Ask distribution picker is kept —
Buy lower, Sell higher, manual range, presets, Zap In, and the Limit tab
described below are postponed (see Beta Scope Amendment). When entered in
"add to position" mode from an existing position's action sheet, this screen
skips goal and range selection entirely — the position's existing range and
distribution are fixed — and asks only for the amount to add.

### Purpose

Let the user understand one pool, choose how liquidity should behave, and
review exactly what will be signed.

### Pool overview

The top of the screen shows:

- pair and pool address shortcut
- current pool price and quote direction
- 24-hour price change when available
- TVL, 24-hour volume, and 24-hour fees
- base fee and current dynamic fee
- reward state
- updated time
- pool-price/reference-price relationship

If a reliable external reference price is unavailable, say so. If pool price
diverges beyond the configured execution threshold, browse remains available
but Add Liquidity is blocked with a plain explanation. P0 does not attempt to
sync the price for the user.

### Price and range visualization

- the liquidity distribution/range graphic with draggable min/max handles is
  required
- position range and current pool price remain clear while dragging
- exact fields provide a non-gesture alternative
- Penpot produces one variant with a small OHLCV market-price chart and one
  without it before the final design is selected
- if retained, the compact price chart offers 1h, 4h, and 24h views without
  TradingView indicators
- every visual has an accessible text equivalent stating current price, selected
  min/max, range percentages, and relevant period/high/low data

### Step 1: Choose the position goal

#### Earn fees

For a two-token position around the current price.

- default underlying strategy: Spot / even distribution
- optional distribution choice: Even or Focused near current price
- requires the token mix calculated for the selected range
- explains that the mix changes as price moves through the range

#### Buy lower

For gradually converting the quote token into the base token below the current
price.

- single-sided quote-token deposit
- range must remain below the current active price
- underlying strategy: Bid-Ask
- explains that conversion occurs only if price moves through the selected
  range

#### Sell higher

For gradually converting the base token into the quote token above the current
price.

- single-sided base-token deposit
- range must remain above the current active price
- underlying strategy: Bid-Ask
- explains that conversion occurs only if price moves through the selected
  range

### Step 2: Choose a range

P0 offers three server-calculated presets and a manual option:

| Preset | Product meaning |
| --- | --- |
| Focused | Fewer bins and more concentrated liquidity; highest chance of leaving range |
| Balanced | Meteora-style centered default around 69 bins when valid |
| Wide | More bins and greater price coverage; liquidity is spread more thinly |
| Manual | User enters min and max prices and sees the exact snapped range before review |

The API calculates valid min/max bin IDs from the pool's current active bin and
bin step, then returns:

- min and max price
- distance from current price in percentage
- number of bins
- required token ratio
- whether the current price is inside the range
- a concise risk statement

For Manual, the user enters min and max prices. The server converts those prices
to valid pool bin IDs, snaps them to executable prices, and returns both the
requested and executable range. The user must review the executable min/max if
snapping changes either boundary. Free-form bin IDs are never accepted from the
mobile client.

For Buy lower and Sell higher, preset or manual ranges must remain on the
correct side of the active price. Manual Earn fees ranges may be asymmetric but
must contain the current price unless the user explicitly changes to a
single-sided goal.

### Step 3: Enter amount

- show the user's spendable balances for both pool tokens
- use decimal strings and token decimals; do not calculate money inputs with
  floating-point numbers
- `Max` reserves enough SOL for transaction fees and account rent
- two-token mode lets the user enter either side and shows the required other
  side
- single-sided modes expose only the token that can validly fund the range
- entering an amount never submits a transaction
- insufficient balance, insufficient SOL, invalid token account, and minimum
  usable amount are shown before review

### Start with one token — Ape In/Zap In

For Earn fees, the user can choose `Start with one token` instead of supplying
the calculated two-token mix.

The flow:

```text
choose input token and amount
  -> quote the required partial swap
  -> show resulting token mix
  -> show the selected position range
  -> review swap and liquidity costs together
  -> sign the complete transaction plan
```

Requirements:

- use the supported Meteora Zap path and its approved swap dependency
- show input token, swap amount, estimated output, route, price impact, swap
  slippage, liquidity slippage, network cost, rent, and transaction count
- refresh the swap and liquidity preview together when either quote expires
- never describe Zap In as single-sided liquidity; part of the input is swapped
  before the two-token position is created
- if Zap is unavailable, the user's existing inputs remain available for the
  normal two-token flow
- P0 does not provide a standalone swap screen or Zap Out

### Liquidity slippage

- default is set by server policy and shown in percent
- the user may choose only within a bounded P0 range
- changing slippage requires no wallet action
- the explanation says this protects the liquidity deposit from pool movement;
  it is not swap-price slippage language copied blindly from a trade ticket

### Inline review and final action

The execution form shows the following inline before the final action:

- pool name and shortened address
- position goal and technical distribution
- funding mode: token pair, valid single-sided range, or Start with one token
- token amount(s) and USD reference values when available
- min price, current price, and max price
- in-range status at preview time
- base fee and current dynamic fee
- 24-hour fee activity labeled as historical
- liquidity-slippage tolerance
- estimated network fee
- refundable position/account rent
- estimated non-refundable bin-array/account cost, when applicable
- estimated transaction step count
- for Zap In: swap route, swap slippage, estimated output, and price impact
- quote expiry countdown
- `Fees vary. Returns are not guaranteed.`
- `You can lose value from token price changes, impermanent loss, or leaving the range.`

The full-width bottom action changes truthfully by state:

```text
Connect Solana wallet
Wallet not supported
Refresh preview
Add liquidity
Start with one token
Place limit order
Sign 1 of N
Confirming
Position created
```

There is no separate generic Review button. Selecting the final action may open
the wallet approval prompt only after all inline validation and preview data are
current.

### Limit-order execution tab

**Postponed for beta** (see Beta Scope Amendment). No `Limit` tab ships in
beta — pool detail shows only the Liquidity flow.

Pools whose on-chain function mode supports DLMM limit orders expose a `Limit`
tab beside `Liquidity`. Pools that do not support limit orders do not show a
disabled or pretend Limit action.

The user chooses:

- `Buy` — deposit the quote token at a price below the current pool price
- `Sell` — deposit the base token at a price above the current pool price
- amount
- manual limit price

The server converts the requested price to the nearest valid bin and returns the
exact executable price. Before signing, review shows:

- Buy or Sell
- deposited token and amount
- requested and executable price
- current pool price
- estimated received token if fully filled
- price distance from the current pool price
- network fee and rent/account cost
- partial-fill behavior
- transaction count and expiry

The interface explains that this is on-chain liquidity placed at selected DLMM
price bins. It may fill partially as price trades through those bins. It is not
presented as a guaranteed centralized-exchange fill.

P0 limit-order lifecycle:

```text
open -> partially_filled -> filled
  or
open/partially_filled -> canceling -> canceled -> closable -> closed
```

Cancel and close remain separate when required by the protocol. Cancel stops
the remaining order; close reclaims remaining assets and refundable rent after
the order account is empty or cancelable. The app must make the remaining step
obvious and recoverable.

## Screen 3: Meteora Profile

### Purpose

Show what the connected wallet actually has on Meteora across `Positions`,
`Limit orders`, and `History`.

### Disconnected

- explain that a Solana address is required to load positions
- connect action
- browsing Pools remains available

### Profile summary

When available, show the following as a flat, divided ledger rather than a pill
or containing summary card:

- current position balance
- open position count
- unclaimed fees
- unclaimed rewards
- live P&L and percentage with source and updated time
- number of out-of-range positions
- open and partially filled limit-order count

If any aggregate is unavailable, show `Unavailable`, not `$0`. P&L is labeled as
an indexed estimate and never treated as a guaranteed accounting statement.
Out-of-range, syncing, recovery, and order lifecycle information appears inline
on the affected position or order row instead of being duplicated in a separate
attention module.

### Position list

Positions are grouped by pool. Each pool group shows:

- pair and pool address shortcut
- current pool price
- combined current balance
- combined unclaimed fees/rewards
- count of positions
- `In range`, `Out of range`, `Mixed`, or `Status unavailable`

Each position row shows:

- created date
- current token balances
- min and max price
- current position value
- unclaimed fees/rewards
- P&L when available
- range status in text and icon, never color alone
- pending on-chain/indexer status when applicable

### Limit-order list

**Postponed for beta** (see Beta Scope Amendment). No Orders tab ships in
beta — Profile shows Positions and History only.

The Limit orders tab shows Open and Closed filters. Each row shows:

- pair
- Buy or Sell
- requested/executable limit price
- current pool price
- deposited, filled, and remaining amount
- status: Open, Partially filled, Filled, Canceled, Needs closing, or Closed
- created and last-updated time
- available next action: Cancel, Close, or View

Unknown fill state never renders as zero. Orders returned by Meteora's open and
closed limit-order portfolio APIs are reconciled with on-chain state before an
action is built.

### History

P0 shows recent add, remove, fee claim, reward claim, position close, limit-order
place, fill, cancel, and close events. It is read-only and date ordered. Full
tax/accounting export is postponed.

## Screen 4: Position Management (beta: action sheets, not a dedicated page)

**Beta Scope Amendment supersedes this screen's original "dedicated Position
Detail route" shape.** For beta, position management is reached directly from
the position row in Profile (Screen 3) — there is no separate
`/apps/meteora/positions/:positionAddress` page. This is a smaller, faster
surface than the original spec and is intentional: claim and remove do not
need range/strategy/chart context, so a full page is more than the job
requires. A dedicated Position Detail page remains a possible post-beta
addition if real usage shows the action sheets are insufficient — it is not
ruled out, only deferred.

### What the position row exposes (beta)

The Profile position row itself already carries the fields a beta user needs
to decide what to do: pair, current balance, unclaimed fees, P&L when
available, and in-range status (see Screen 3). Tapping the row opens an
action sheet with four actions. None of them require pair/position-address/
distribution/created-time detail beyond what the row already shows.

### P0 actions (beta: via action sheet from the Profile row)

#### Add liquidity

- opens the pool-detail amount step directly in "add to position" mode: goal,
  distribution, and range are already fixed by the existing position and are
  not re-asked
- recalculates the valid token ratio for the existing range
- repeats amount, preview, cost, simulation, signing, and reconciliation rules

#### Claim fees and rewards

- action-sheet flow: shows exactly which claimable assets are included,
  preview (network fee, rent), sign, done
- supports multiple transaction steps when required
- does not imply a claim compounds the position

#### Remove liquidity

- action-sheet flow: percentage presets and an exact bounded amount
- shows estimated token outputs before signing
- explains that liquidity from an active bin cannot be withdrawn as only one
  token
- partial removal leaves the position open

#### Withdraw and close

- same action sheet as Remove, with 100% selected, plus a dedicated
  destructive-action confirmation step
- removes 100 percent, claims eligible fees/rewards, closes the position account,
  and reclaims refundable rent when the protocol flow permits it
- shows each transaction step and does not report completion until the close is
  confirmed or the remaining action is clearly recoverable

Rebalance is deliberately absent from P0. An out-of-range position can be held,
added to when valid, partially removed, or fully closed, but myboon does not
claim to re-center it automatically in this release.

## Screen 5: Limit-Order Detail and Management

**Postponed for beta.** DLMM limit orders are cut from beta scope entirely
(see Beta Scope Amendment) — this screen, the Limit tab on Screen 2, and the
Orders tab on Screen 3 do not ship in beta. Kept below for the post-beta
limit-order scoping pass.

### Overview

- pair and order address
- Buy or Sell
- requested and executable limit price
- current pool price
- original deposit
- filled and remaining amounts
- received/claimable assets when available
- order and close state
- placed, updated, canceled, and closed times
- realized bonus/fee data only when Meteora returns it reliably

### P0 actions

- `Cancel remaining order` when open or partially filled
- `Close order` when the on-chain account is empty or cancel has completed
- `Retry status check` when confirmation or indexing is unknown
- explorer link for submitted signatures

Canceling and closing use the same preview, expected-program validation,
multi-step signing, persistence, and reconciliation rules as liquidity actions.

## Theme and Visual Direction

Meteora must feel like a myboon App, not a web page embedded in myboon.

### Existing myboon foundation

Use the repository theme system:

- screen: deep navy `semantic.background.screen`
- cards/surfaces: `semantic.background.surface` and `surfaceRaised`
- primary text: bone/near-white
- secondary text: dim blue-grey
- primary interactive accent: myboon blue
- primary CTA/highlight: myboon yellow where the existing flow uses it
- positive state: viridian with text/icon
- negative or blocked state: vermillion with text/icon
- compact technical metadata: monospace
- important headings and explanations: readable non-monospace hierarchy

Meteora is the first experiment in stronger application-specific identity.
Meteora's mark, accent behavior, range graphics, and working-surface character
may visually outweigh the base myboon styling after the user enters the App.
The myboon top-level shell, navigation behavior, spacing discipline, semantic
status colors, and safety language remain recognizable.

Any Meteora-specific palette becomes an explicit semantic theme extension in
`theme/tokens.ts` and `theme/semantic.ts`. Feature components must not hardcode
hex or rgba values, and Meteora accents must pass the same contrast and
non-color-only accessibility rules as the core theme.

### Visual character

- sleek, dense enough for market information, but never spreadsheet-like
- one strong hierarchy per screen
- rounded rectangles remain restrained and consistent with the current Home
  and Feed work
- pool rows use alignment and spacing before extra borders
- charts and range graphics support the decision rather than dominate the page
- the primary action remains visible without covering important price/risk data
- Meteora identity is allowed to dominate the App workspace while the myboon
  product shell remains visible and consistent

## Accessibility

### Current app assessment

The current mobile app has a useful base: Home app tiles and several market rows
already use accessibility roles, labels, selected/disabled states, and hit slop.
The implementation is not yet consistent enough to copy without a dedicated
Meteora standard:

- some icon buttons are only 28x28
- several retry buttons and modal actions have no explicit accessible label
- some modals do not declare or restore focus
- important text can be as small as 8–10 points
- charts are primarily visual
- positive/negative values often depend heavily on color

Meteora P0 must close these gaps in its own surface and should produce reusable
components that later Apps can adopt.

### P0 requirements

- all interactive targets have at least a 44x44 point hit area
- every Pressable has the correct role, label, state, and useful hint when the
  action is not obvious
- selected strategy/range controls expose `selected`; unavailable actions expose
  `disabled`; busy controls expose `busy`
- text supports system font scaling without clipping critical amounts or CTAs
- essential explanatory and transaction text is at least 12 points before
  scaling
- pair/token icons have meaningful combined labels or are hidden when duplicate
  text already names the pair
- full numeric values are available to screen readers even when the visual UI
  abbreviates them
- percentages announce `increase` or `decrease`; range status is never conveyed
  only by green/red
- headings form a predictable focus order
- modal/sheet focus moves to the title, is trapped while open, and returns to
  the invoking control on close
- loading, transaction progress, success, and failure use restrained live-region
  announcements
- chart data has a text summary and selected-range description
- gestures such as chart scrubbing and range adjustment always have button or
  form-control alternatives
- animations respect reduced-motion preference
- error messages identify the field or action and provide the next available
  step
- Android TalkBack and large-font testing are release gates

## Data Architecture

### Ownership

```text
Meteora Data API / Solana RPC / DLMM SDK
  -> reusable myboon Meteora integration
  -> myboon API normalization and policy gate
  -> mobile Meteora API client
  -> Pools / Execution / Profile UI
```

The recommended reusable integration lives under:

```text
packages/shared/src/meteora/
```

It owns:

- Meteora Data API client
- DLMM SDK wrapper
- pool and token normalization
- eligibility policy inputs
- range and amount calculations using exact decimal/BN types
- manual-price-to-bin snapping and validation
- Ape In/Zap In quote and transaction-plan integration
- DLMM limit-order read, place, cancel, and close integration
- transaction instruction/plan construction
- expected program and account validation
- upstream error normalization

The API mounts public routes under:

```text
/apps/meteora
```

The mobile app never consumes raw Meteora responses. This keeps upstream naming,
rate limits, schema drift, eligibility policy, and transaction construction out
of presentation components.

### Data sources

| Need | Source |
| --- | --- |
| Pool list and metrics | Meteora DLMM Data API `/pools` |
| One pool | Meteora DLMM Data API `/pools/:address`, checked against RPC |
| Chart | Meteora DLMM Data API `/pools/:address/ohlcv` |
| Open portfolio | Meteora DLMM Data API `/portfolio/open` |
| Closed portfolio/P&L | Meteora DLMM Data API `/portfolio` and `/portfolio/total` |
| Position P&L | Meteora DLMM Data API `/positions/:pool/pnl` |
| Position activity | Meteora DLMM Data API `/positions/:address/historical` |
| Open/closed limit orders | Meteora DLMM Data API wallet limit-order endpoints |
| Live pool/range state | Solana RPC through the DLMM SDK |
| Build liquidity actions | `@meteora-ag/dlmm` on the server |
| Build limit-order actions | `@meteora-ag/dlmm` on the server |
| Start with one token | Meteora Zap SDK/program and approved swap route |
| Independent reference price | approved price source through the myboon API |

Meteora documents a 30 request-per-second API limit. myboon must proxy, cache,
deduplicate concurrent requests, bound pagination, and apply backoff rather than
having every device call Meteora directly.

## Public API Contracts

All values that can lose precision are decimal or atomic strings. Every read
response includes source freshness.

### Common freshness

```ts
interface MeteoraFreshness {
  state: 'live' | 'fresh' | 'stale' | 'partial' | 'unavailable'
  sourceUpdatedAt: string | null
  servedAt: string
  ageMs: number | null
  source: 'meteora_data_api' | 'solana_rpc' | 'mixed'
  reason: string | null
}
```

### Pool list

```text
GET /apps/meteora/pools
  ?page=1
  &pageSize=20
  &query=SOL
  &sort=volume24h_desc
```

```ts
interface MeteoraPoolSummary {
  address: string
  pair: string
  tokenX: MeteoraTokenSummary
  tokenY: MeteoraTokenSummary
  currentPrice: string | null
  quoteSymbol: string
  tvlUsd: string | null
  volume24hUsd: string | null
  fees24hUsd: string | null
  feeTvl24hPct: string | null
  baseFeePct: string | null
  dynamicFeePct: string | null
  rewardsActive: boolean
  approvedByMeteora: true
  supportedActions: Array<'liquidity' | 'limit_order' | 'zap_in'>
  freshness: MeteoraFreshness
}
```

The upstream blacklist, raw reserves, token authority fields, and technical
support reasons remain server concerns. A pool that Meteora has not approved or
that myboon cannot safely execute against is not returned as an actionable
option.

### Pool detail

```text
GET /apps/meteora/pools/:poolAddress
GET /apps/meteora/pools/:poolAddress/ohlcv?timeframe=1h
```

Pool detail adds fee configuration, token risk summary, reward tokens, current
active price, reference price state, eligibility, and supported actions. It does
not return arbitrary raw SDK account data.

### Position preview

```text
POST /apps/meteora/previews/create-position
```

```ts
interface CreateMeteoraPositionPreviewRequest {
  walletAddress: string
  poolAddress: string
  goal: 'earn_fees' | 'buy_lower' | 'sell_higher'
  distribution: 'spot' | 'curve' | 'bid_ask'
  range:
    | { mode: 'preset'; preset: 'focused' | 'balanced' | 'wide' }
    | { mode: 'manual'; minPrice: string; maxPrice: string }
  fundingMode: 'token_pair' | 'valid_single_sided' | 'zap_in'
  input: {
    tokenXAtomic?: string
    tokenYAtomic?: string
  }
  liquiditySlippageBps: number
}

interface MeteoraExecutionPreview {
  previewId: string
  expiresAt: string
  pool: MeteoraPoolSummary
  activeBinId: number
  minBinId: number
  maxBinId: number
  requestedMinPrice: string | null
  requestedMaxPrice: string | null
  minPrice: string
  currentPrice: string
  maxPrice: string
  tokenXAtomic: string
  tokenYAtomic: string
  estimatedNetworkFeeLamports: string | null
  refundableRentLamports: string | null
  nonRefundableAccountCostLamports: string | null
  estimatedTransactionCount: number
  warnings: MeteoraWarning[]
  canBuild: boolean
  blockingReason: string | null
  freshness: MeteoraFreshness
}
```

The preview is short-lived. Build rejects changed inputs, expired price state,
unapproved or technically unsupported pools, and mismatched wallet or position
information.

Zap In adds a swap quote to the same preview contract:

```ts
interface MeteoraZapInQuote {
  inputMint: string
  inputAtomic: string
  swapInputAtomic: string
  estimatedSwapOutputAtomic: string
  resultingTokenXAtomic: string
  resultingTokenYAtomic: string
  routeLabel: string
  priceImpactPct: string | null
  swapSlippageBps: number
  expiresAt: string
}
```

### Limit-order reads and preview

```text
GET  /apps/meteora/limit-orders?wallet=:walletAddress&status=open
GET  /apps/meteora/limit-orders/:orderAddress?wallet=:walletAddress
POST /apps/meteora/previews/limit-order
```

```ts
interface MeteoraLimitOrderPreviewRequest {
  walletAddress: string
  poolAddress: string
  side: 'buy' | 'sell'
  inputAtomic: string
  requestedPrice: string
}

interface MeteoraLimitOrderPreview {
  previewId: string
  expiresAt: string
  side: 'buy' | 'sell'
  requestedPrice: string
  executablePrice: string
  binIds: number[]
  depositMint: string
  depositAtomic: string
  estimatedFullFillOutputAtomic: string | null
  estimatedNetworkFeeLamports: string | null
  refundableRentLamports: string | null
  estimatedTransactionCount: number
  warnings: MeteoraWarning[]
  canBuild: boolean
  blockingReason: string | null
  freshness: MeteoraFreshness
}
```

### Transaction build

```text
POST /apps/meteora/transactions/create-position
POST /apps/meteora/transactions/add-liquidity
POST /apps/meteora/transactions/claim
POST /apps/meteora/transactions/remove-liquidity
POST /apps/meteora/transactions/close-position
POST /apps/meteora/transactions/zap-in
POST /apps/meteora/transactions/place-limit-order
POST /apps/meteora/transactions/cancel-limit-order
POST /apps/meteora/transactions/close-limit-order
```

```ts
interface MeteoraTransactionPlan {
  planId: string
  action:
    | 'create'
    | 'zap_in'
    | 'add'
    | 'claim'
    | 'remove'
    | 'close'
    | 'place_limit_order'
    | 'cancel_limit_order'
    | 'close_limit_order'
  walletAddress: string
  poolAddress: string
  resourceType: 'position' | 'limit_order'
  resourceAddress: string
  expiresAt: string
  steps: Array<{
    id: string
    order: number
    title: string
    transactionBase64: string
    transactionVersion: 'legacy' | 'v0'
    requiredSigners: Array<'wallet' | 'position' | 'limit_order'>
    expectedProgramIds: string[]
  }>
  warnings: MeteoraWarning[]
}
```

For a new position or limit order, the mobile app generates the required
ephemeral resource keypair. It sends only the public key to the build endpoint,
partially signs the returned transaction locally with that position/order
keypair, and then asks the connected wallet to sign and send. The ephemeral
secret never leaves the device and is discarded only after the transaction
reaches a recoverable terminal state.

This exact partially-signed transaction path must pass an Android/Mobile Wallet
Adapter spike for both positions and limit orders before either create flow is
considered unblocked.

### Portfolio and positions

```text
GET /apps/meteora/portfolio?wallet=:walletAddress
GET /apps/meteora/pools/:poolAddress/positions?wallet=:walletAddress
GET /apps/meteora/positions/:positionAddress?wallet=:walletAddress
GET /apps/meteora/positions/:positionAddress/history?wallet=:walletAddress
GET /apps/meteora/limit-orders?wallet=:walletAddress&status=:status
GET /apps/meteora/limit-orders/:orderAddress?wallet=:walletAddress
```

Responses normalize current balances, deposits, withdrawals, fees, rewards,
P&L, min/max price, active price, open/closed state, out-of-range status, and
limit-order deposits/fills/remaining assets. Unknown upstream values stay null
and render as unavailable.

## Caching and Freshness Policy

- approved pool list: 20-second fresh cache, up to 5-minute stale fallback
- pool detail: 10-second fresh cache, up to 2-minute stale fallback
- OHLCV: cache by timeframe for one candle interval or less
- portfolio and positions: 5-second deduplicated cache per wallet
- transaction preview/build: never served from stale cache
- RPC state used for build: fetched immediately before construction
- preview expiry: 30 seconds unless device testing proves a different value is
  needed

Browse can remain available on labeled stale data. Execution is disabled when
the pool state, reference price, wallet balances, or preview exceeds the
configured transaction freshness threshold.

## Transaction Lifecycle

### Readiness checks

Before preview or build:

- supported Solana cluster and DLMM program
- connected wallet address matches the requested authority
- wallet supports sign-and-send transactions
- pool is Meteora-approved, technically supported for the selected action, and
  not remotely disabled
- token policy still passes
- pool and reference prices are sufficiently current and synchronized
- active bin and chosen range are valid
- manual min/max prices snap to valid bins and the user has reviewed the snapped
  executable range
- Zap In route, price impact, and both slippage limits are current when used
- limit-order side, price, deposit token, bins, and pool mode are valid when used
- user balances and token accounts are readable
- enough SOL remains for fees and rent
- amounts fit token decimals and protocol limits
- preview has not expired

### Build and validation

- server builds with the pinned, tested Meteora SDK version
- server validates the pool, mints, wallet authority, position public key,
  expected program IDs, and action parameters
- mobile validates the returned wallet, pool, position, program allowlist, step
  count, and expiry before presenting a wallet prompt
- every transaction is simulated when the RPC and transaction type permit it
- simulation failure blocks signing and returns a stable error code

### Signing and confirmation

```text
prepared
  -> awaiting_wallet
  -> submitted
  -> confirmed
  -> syncing_resource
  -> complete
```

Alternative terminal states:

```text
wallet_rejected
expired_before_submit
simulation_failed
onchain_failed
partially_complete
confirmation_unknown
```

- each step is signed only after the prior required step confirms
- transaction signatures and pending plan state persist locally so the user can
  resume after an app background/return
- wallet rejection is not shown as a protocol failure
- a blockhash-expired transaction can be rebuilt only after re-preview
- a submitted transaction is never blindly resubmitted
- `confirmed` and `indexed` are separate states
- indexer lag shows `Confirmed on-chain — syncing position/order` rather than failure
- multi-transaction liquidity and limit-order actions clearly identify
  completed and remaining steps

## Security and Risk Controls

- never accept or store a user's private wallet key
- never log ephemeral position/order secret material or serialized signed
  transactions
- pin and review the DLMM SDK version; do not float to latest in production
- verify the official DLMM program ID and allowlisted supporting programs on
  both API and mobile
- validate wallet authority, pool address, position owner, token mints, token
  programs, recipient accounts, and fee payer
- reject blacklisted pools and unsupported tokens at read, preview, and build
- recheck eligibility immediately before construction
- cap page size, amount length, slippage, bin range, and transaction count
- validate Zap swap routes and outputs independently from the liquidity leg
- validate limit-order direction, price side, deposit mint, and order ownership
- rate-limit build endpoints independently from public reads
- no API endpoint signs as the user's wallet or submits on the user's behalf
- no affiliate/referral instruction is added without a separate disclosed
  product decision
- transaction and analytics logs use stable error codes and redacted payloads
- audits may be linked in Risk & details, but never represented as a guarantee

## Token Policy

P0 supports standard SPL tokens and only those Token-2022 configurations that
are explicitly verified in the implementation test matrix.

Default behavior:

- block an upstream-blacklisted token or pool
- block unsupported or unknown Token-2022 extensions
- block unresolved freeze-authority or transfer-hook behavior
- allow a Token-2022 pool only when the extension combination, wallet behavior,
  SDK path, deposit, claim, remove, and close flows all pass device testing
- show `Verified metadata` as metadata verification, not a safety endorsement

## Loading, Empty, Stale, and Failure States

Every screen distinguishes:

| State | Required behavior |
| --- | --- |
| Loading | Skeleton or progress with existing content retained where possible |
| Empty | Explain whether the wallet has no positions, search has no match, or policy exposes no pools |
| Stale | Show last updated time; browse may continue; execution may not |
| Partial | Render usable sections and identify the unavailable metric/source |
| Offline | Show cached read-only state and disable build/sign actions |
| Upstream error | Stable message, retry, and official-link fallback |
| RPC error | Separate from Meteora Data API error; do not show false zero balances |
| Wallet rejected | Return safely to review with inputs preserved |
| Indexer lag | Show on-chain confirmation and continue reconciliation |
| Unknown confirmation | Preserve signature and provide explorer/recheck actions |

No error state clears a submitted transaction signature or encourages a blind
duplicate transaction.

## Feature Flags, Rollback, and Operations

P0 ships with independently controlled flags:

```text
meteora_browse_enabled
meteora_execution_enabled
meteora_management_enabled
meteora_profile_enabled
meteora_zap_in_enabled
meteora_limit_orders_enabled
```

Operational controls:

- global execution kill switch
- action-level switches for create, Zap In, add, claim, remove, close, place
  limit order, cancel order, and close order
- server-side pool allow/deny overrides
- token denylist
- maximum amount and range guards
- SDK/API version and upstream health dashboard

Rollback order:

1. disable the affected management action
2. disable new position execution while preserving Profile and withdrawals
3. keep read-only pool and position data available
4. hide Meteora only if reads are misleading or unsafe

Position withdrawal/close and limit-order cancel/close recovery should remain
available longer than new deposits or new orders whenever the underlying
protocol path is healthy.

## Analytics and Privacy

Track product and reliability events:

- Meteora tile opened
- pool list loaded/failed/stale
- search and sort used
- pool opened
- position goal, distribution, range preset, or manual range selected
- Start with one token selected and Zap quote outcome
- limit-order Buy/Sell, preview, place, fill-state, cancel, and close outcome
- preview requested/blocked/expired
- wallet readiness state
- wallet prompt opened/rejected
- transaction step submitted/confirmed/failed
- position reconciled
- profile loaded/empty/failed
- add, claim, remove, and close started/completed/failed
- out-of-range explanation opened

Do not send raw wallet addresses, exact balances, exact deposit amounts, position
addresses, signed transactions, or token-account details to product analytics.
Use anonymous session IDs, coarse amount buckets where truly necessary, and
stable error codes.

## Testing Plan

### Unit and contract tests

- upstream pool normalization and null handling
- exact decimal and atomic amount conversion
- pool eligibility rules and denylist precedence
- Focused/Balanced/Wide range calculation across small and large bin steps
- manual min/max price snapping, asymmetric ranges, and invalid boundaries
- Earn fees, Buy lower, and Sell higher range validity
- token ratio and single-sided validation
- Zap In swap-plus-liquidity quote expiry and amount reconciliation
- limit-order side, price, bin, partial-fill, cancel, and close state handling
- cache freshness and stale fallback
- preview expiry and input mismatch
- transaction program/account validation
- error normalization
- profile/P&L unknown-value behavior

### API integration tests

- current production Data API response shape
- 30-RPS protection and request deduplication
- pool search, sorting, pagination, and policy filtering
- RPC check against an approved mainnet pool
- SDK transaction construction for every P0 action
- Zap SDK/program transaction construction and swap-route validation
- limit-order open/closed API reconciliation and transaction construction
- transaction simulation without a user secret
- multi-transaction remove/claim plans
- indexer lag and partial-response behavior

### Mobile tests

- Pools -> pool detail -> Profile navigation
- disconnected browse
- supported MWA wallet lifecycle
- unsupported Privy execution message
- local ephemeral position and limit-order partial signing
- Start with one token preview and Zap In signing
- limit-order place, partial fill, cancel, close, and resume
- background/resume during wallet approval and confirmation
- wallet rejection, blockhash expiry, RPC timeout, and unknown confirmation
- no duplicate submission on repeated taps
- profile reconciliation after create/add/claim/remove/close
- offline and stale browse
- small Android device, large text, TalkBack, reduced motion, and poor network

### Controlled mainnet validation

Before beta execution is enabled:

- use one approved high-liquidity pool
- use the smallest meaningful amounts permitted by protocol and fees
- create a Focused or Balanced position
- create one manual-range position and confirm the executable snapped prices
- create one position through Start with one token/Ape In/Zap In
- verify it appears in Meteora's official app and myboon Profile
- claim if fees/rewards are available
- add a small amount
- partially remove
- fully remove and close
- place a small limit order in a supported pool, verify open state, cancel it,
  close it, and verify returned assets/rent
- verify token balances and reclaimed rent
- record every signature and compare displayed state against RPC and Meteora

## Beta Success Criteria

### Comprehension

In a five-user moderated test, at least four users can correctly identify:

- which two assets they are depositing or converting
- the selected price range
- that fees vary and are not guaranteed
- what `Out of range` means
- that narrow and wide ranges have different trade-offs
- whether a displayed manual price was adjusted to an executable DLMM price
- the difference between adding liquidity and placing a limit order
- the number of wallet approvals still required

### Reliability

- no critical crash in the Meteora journey on the target Android/Seeker device
- no fabricated pool, balance, fee, reward, or P&L value
- no duplicate transaction caused by UI retry
- every submitted signature remains recoverable after app background/restart
- at least 95 percent of submitted test transactions reach a truthful terminal
  state or a recoverable `confirmation unknown` state
- confirmed positions reconcile into Profile within 30 seconds under normal
  indexer conditions
- the execution kill switch takes effect without an app release

### Accessibility

- all P0 flows complete with TalkBack
- 200 percent font scaling does not hide the review facts or primary action
- no action or status depends only on color or a gesture
- every modal/sheet has correct focus entry and return

## Acceptance Criteria

Beta acceptance criteria (governed by the Beta Scope Amendment) are listed
first. The original full-P0 criteria follow, marked postponed where they
depend on cut scope — kept as the target once beta ships.

### Beta acceptance criteria

- [ ] The Meteora Home tile opens a real Pools route.
- [ ] Pools exposes Meteora-approved, non-blacklisted DLMM pools from normalized
      myboon APIs, subject only to technical and emergency safety blocks.
- [ ] Search, sorting, pagination, refresh, empty, stale, and failure states work.
- [ ] Pool detail shows decision-level metrics, freshness, risk, and an accessible
      chart summary.
- [ ] Earn fees (two-token, Spot, one calculated default range) produces a
      valid protocol range.
- [ ] Review shows inputs, range, fees, slippage, costs, transaction count, expiry,
      and risk before wallet approval.
- [ ] Unsupported wallets can browse and view Profile but cannot enter a false
      execution flow.
- [ ] A supported wallet can create a position without the user's secret leaving
      the device.
- [ ] Transaction progress survives backgrounding and prevents duplicates.
- [ ] Profile shows truthful open positions and unknown values as unavailable.
- [ ] Claim, Add, partial Remove, and full Remove/Close are each reachable
      directly from the Profile position row via an action sheet, and pass
      controlled device testing.
- [ ] Add liquidity from an existing position does not re-ask goal,
      distribution, or range — it reuses the position's existing range.
- [ ] Pool, token, program, account, and transaction-plan validation run before
      signing.
- [ ] Browse, execution, profile, and management can be disabled independently.
- [ ] TalkBack, large text, reduced motion, and minimum touch-target checks pass.
- [ ] The earlier Beta Readiness PRD is updated after approval to include Meteora
      as the first P0 LP application.

### Full-P0 acceptance criteria (postponed beyond beta where noted)

- [ ] Buy lower and Sell higher produce valid protocol ranges. *(postponed)*
- [ ] Focused, Balanced, and Wide show actual price bounds and trade-offs. *(postponed)*
- [ ] Manual min/max price entry snaps to valid executable bins and requires
      review of any adjusted boundary. *(postponed)*
- [ ] Start with one token/Ape In/Zap In shows and executes the swap and
      liquidity legs as one recoverable plan. *(postponed)*
- [ ] Supported pools expose limit Buy/Sell entry, and place, partial-fill,
      cancel, close, and recovery states pass controlled device testing. *(postponed)*

## Issue-Ready Workstreams

Issues are created only after this PRD is reviewed.

1. **Meteora service and public API** — add the shared DLMM/Zap integration,
   pinned SDKs, Meteora-approved pool catalog, normalized reads, exact range and
   amount math, caches, previews, transaction builders, and stable errors.
2. **Meteora product design and accessibility** — complete the Penpot designs
   for Pools, Liquidity, manual ranges, Start with one token, Limit orders,
   Profile, management, and every loading/failure/transaction state.
3. **Pools and pool-detail mobile client** — connect the Home tile and build the
   themed, accessible pool catalog, search/sort, metrics, chart, Liquidity/Limit
   tabs, and preset/manual range controls.
4. **Liquidity execution client** — implement two-token, valid single-sided,
   manual-range, and Ape In/Zap In previews plus partial signing, wallet prompts,
   persistence, confirmation, and reconciliation.
5. **Profile and position management** — build portfolio, position detail,
   history, add, claim, partial remove, full close, and recoverable multi-step
   states; Rebalance remains out of scope.
6. **DLMM limit orders** — build the supported-pool Limit experience end to end:
   reads, Buy/Sell preview, place, partial-fill state, cancel, close, history,
   validation, and recovery.
7. **Safety, QA, and beta rollout** — add token/program controls, feature flags,
   kill switches, privacy, TalkBack/large-text coverage, automated tests,
   controlled mainnet lifecycles, and release gates.

## Implementation Order

```text
1. Meteora service and public API foundation
2. Penpot product design and accessibility states
3. Pools and pool-detail mobile client
4. MWA partial-signing and Zap transaction spike
5. Liquidity execution client
6. Profile and position management
7. Limit-order vertical slice
8. Safety, QA, and controlled mainnet validation
```

The partial-signing spike is the execution stop condition. If the current
Mobile Wallet Adapter cannot reliably submit a transaction already signed by
the local ephemeral position or limit-order keypair, the affected create flow
may ship read-only while the wallet path is corrected; the implementation must
not move resource signing to an unsafe custodial workaround.

## References

### myboon

- [`docs/VISION.md`](../VISION.md)
- [`docs/markets.md`](../markets.md)
- [`docs/markets/categories/lp.md`](../markets/categories/lp.md)
- [`docs/PRDs/beta readiness sprint PRD.md`](beta%20readiness%20sprint%20PRD.md)
- [`apps/hybrid-expo/THEMING.md`](../../apps/hybrid-expo/THEMING.md)

### Meteora official documentation

- [Complete Meteora documentation index](https://docs.meteora.ag/llms.txt)
- [What is DLMM?](https://docs.meteora.ag/core-products/dlmm/what-is-dlmm)
- [DLMM strategies and use cases](https://docs.meteora.ag/core-products/dlmm/strategies-and-use-cases)
- [DLMM limit orders](https://docs.meteora.ag/core-products/dlmm/limit-order)
- [DLMM Dynamic Terminal](https://docs.meteora.ag/user-guides/how-to-use-dlmm/dynamic-terminal)
- [DLMM Data API overview](https://docs.meteora.ag/developer-guides/dlmm/api-reference/overview)
- [DLMM pool list API](https://docs.meteora.ag/api-reference/dlmm/pools/pools)
- [DLMM pool API](https://docs.meteora.ag/api-reference/dlmm/pools/pool)
- [DLMM OHLCV API](https://docs.meteora.ag/api-reference/dlmm/pools/ohlcv)
- [DLMM open portfolio API](https://docs.meteora.ag/api-reference/dlmm/portfolio/get-user-portfolio-with-all-pools-containing-open-positions)
- [DLMM position P&L API](https://docs.meteora.ag/api-reference/dlmm/positions/get-position-pnl-data-open-and-closed-positions-with-on-the-fly-calculation)
- [DLMM TypeScript SDK getting started](https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/getting-started)
- [DLMM TypeScript SDK examples](https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/examples)
- [DLMM Token-2022 support](https://docs.meteora.ag/core-products/dlmm/token-2022-support)
- [Meteora Zap](https://docs.meteora.ag/helper-products/zap/what-is-zap)
- [Meteora Zap TypeScript examples](https://docs.meteora.ag/developer-guides/zap/typescript-sdk/examples)
- [DLMM audits](https://docs.meteora.ag/resources/audits/dlmm)
- [Meteora terms of service](https://docs.meteora.ag/resources/legal/terms-of-service)
