# Wallet One-Screen PRD

Status: DRAFT. The screen and action panel design is LOCKED (2026-11-21). The
six decisions below are still defaults and need a yes from the owner.
Date: 2026-11-21
Owner: myboon Apps
Design reference: `docs/design/wallet.html`, the locked mock (see "Design work").

This is the product source of truth for the Wallet. It describes what the
Wallet is and what it must do. Earlier wallet PRDs stay as history; where they
disagree with this one, this one wins (see "What this replaces").

Facts below come from a read-only code and docs survey on 2026-11-21. Anything
not confirmed is marked UNVERIFIED. Nothing here has been built or tested yet.

## Why

Today a user who wants to know "what do I have and what can I do with it"
must visit several screens: Home's wallet panel, the combined portfolio, one
profile screen per app, and separate deposit/withdraw modals per app. Send,
Receive and Transfer are placeholder tiles that say "Coming soon". The current
mock shows each app as one name and one dollar number, which does not answer
"how am I doing".

The Wallet becomes the one central place for everything about the user's money
that is **not opening a trade**.

## Product model

1. **One screen.** Top ~60-70% by default is the action panel. The bottom is the
   Portfolio, which slides up to take more room.
2. **Apps are a catalog.** Tapping "profile" on an app anywhere in myboon opens
   the Wallet with that app selected. There is no separate profile screen.
3. **The Wallet does everything except open a trade:** balances, stats,
   positions, orders, history, redeem, cancel, deposit, withdraw, swap, send,
   receive, move. Opening a trade stays in the market screens, where the user is
   looking at a price.
4. **Move is the bridge.** Moving between chains, and between an app and a
   chain, goes through Relay. We do not build bridge internals; the user
   reviews and signs.

## Screen layout

```
┌──────────────────────────────┐
│ Gold header: wordmark, bell, avatar            │
│ [ Swap | Move | Send | Receive ]   segmented   │
│ Action panel (changes with mode)               │  ~60-70% default
│ Swipe-to-confirm                               │
├──────────────────────────────┤
│ Portfolio (slides up)                          │
│  total · allocation bar                        │
│  Table | Map | Cards     Apps | Spot           │
│  top 5 + "more"                                │
│  App selected: app view (below)                │
└──────────────────────────────┘
```

- The slide-up already exists in `HomeWalletOverview.tsx` (rising panel). Build
  on it; do not invent a second mechanism.
- Swipe-to-confirm already exists: `features/swap/components/SwipeToConfirm.tsx`.
  Reuse it for Move, Swap and Send.
- Never say "Spot wallet". Say "Spot".

## Action panel modes

| Mode | What it does | Exists today |
|---|---|---|
Order is Swap | Move | Send | Receive. Swap is the default mode.

| Mode | What it does | Exists today |
|---|---|---|
| Swap | Asset-to-asset swap via the existing composer | Yes (`WalletActionPanel.tsx`, `useSwapController`) |
| Move | Pay from one place, receive at another place (chains and apps), 25/50/75/Max, route, fees, swipe | No. No Relay code in the repo |
| Send | Address + amount + token, swipe to send. Mock scope: Solana USDC only | No (placeholder tile) |
| Receive | Address, QR, copy | No (placeholder tile) |

Swap is one of the four modes, not a separate Trade Sheet (Decision 2). Swap
and Move stay separate modes; merging them was drawn and rejected for now,
because an app side has no token list, a dial of chains plus apps gets crowded,
and same-chain swaps (Jupiter) and cross-chain moves (Relay) have different
quotes, fees and errors.

### Action panel layout (locked)

One layout for all four modes, so the panel never changes size when the user
switches mode.

- **Fixed size.** The panel body is 430px tall at a 390x844 phone, so the gold
  area is 552px, about 65% of the screen. Identical in every mode and state.
- **Two columns.** Left is Pay (Swap) or From (Move). Right is Receive (Swap)
  or To (Move). A wire with a node joins the selected asset on each side.
- **Chain dial.** At the right end of each column header is a horizontal dial.
  The user drags it sideways or taps an icon; it snaps to the centered chain,
  which gets a gold ring, and the asset list below changes immediately. In
  Move the dial picks a chain; the list shows that chain's wallet under a
  "Chain" label and its apps under "Apps".
- **Lists.** Each list is 231px, about 5.8 rows, and scrolls. The selected asset
  is highlighted in the list.
- **Amount.** The amount and the 25/50/75/Max chips sit just above the slider.
  Tapping the amount opens a keyboard (288px in the mock); the slider must stay
  visible for keyboards up to about 316px. Not yet tested on a device.
- **Slider carries the status.** No separate quote strip. The slider's small
  line shows route, fees and time (or the rate for a same-chain swap); its
  strong line is the action ("Swipe to move ..."). It also shows pending
  ("Step n of N"), done, failed ("money is safe", tap to retry) and
  route-not-supported (reason, and tap to switch to a supported chain). The fee
  split (execution, app, swap cost) shows when the user taps the "i" on the
  slider; it is not always visible.
- **Receive** shows one QR card and a Copy button where the slider sits. Nothing
  is signed, so no swipe.
- **Icons over words.** Assets are shown by icon; avoid ticker text where an
  icon works.

### Move

- From and To each pick a place through the chain dial (see "Action panel
  layout"); a place is a chain wallet or an app on that chain.
- Deposit to an app = Move with **To** prefilled. Withdraw from an app = Move
  with **From** prefilled. The app view has a Deposit / Withdraw strip that
  opens Move this way.
- Provider: Relay (`https://docs.relay.link/llms.txt`). Flow: quote, then steps
  (`transaction` or `signature`), then poll status. Show fees (execution, app,
  swap cost) and time estimate to the user before signing.
- Relay's API key must not ship in the app. The myboon API proxies the quote
  (Decision 5).
- Relay on Solana: standard transactions are limited to 1232 bytes
  (`SOLANA_TX_TOO_LARGE`). `useV1Transaction: true` raises it to 4096 where the
  wallet supports it. Test common routes early.
- Relay only supports Solana tokens Jupiter can trade.

#### The honest limit of Move (Decision 1)

Relay can move funds to a chain. It does not do a venue's own last step.

- **Polymarket:** has its own bridge today (`DepositModal.tsx`,
  `WithdrawModal.tsx`, API `/polymarket/bridge/*`). Whether Relay can deliver to
  Polygon / Polymarket's proxy wallet is UNVERIFIED (Relay docs do not state
  Polygon).
- **Phoenix, Pacifica:** deposits are program calls, not plain transfers. Relay
  delivers USDC to the Solana wallet; the venue's own deposit step finishes the
  job.

Default: Move prefills the screen and handles the chain hop; each app's own
deposit/withdraw step does the final hop until Relay is proven for that app.
The user should experience one flow ("sign, sign, sign"), not two screens.
Launch scope: Solana and Base; Polygon and Polymarket are "to be confirmed"
(Decision 6).

## Portfolio

- Total value, allocation bar.
- Views: Table, Map, Cards (Table first; Map and Cards later).
- Toggle: Apps | Spot. Show top 5 and "more". Hide dust under $1.
- Group by chain or by app.
- **Apps row:** name and value, plus one summary line, e.g.
  `Cash $120 · Bets $292 · +$18`. Tapping selects the app and opens the app view.
- **Spot row:** opens the token list for that chain (`/spot`), not the older
  "Spot Hub" (Decision 3).
- A venue the user has not connected shows nothing rather than an error
  (current behavior in `CombinedPortfolioScreen.tsx`; keep).
- Loading and retry per venue stay independent, so one slow app does not blank
  the rest.

## App view (an app selected in Portfolio)

Top of the app view: cash available, value in open positions, total P&L, and
the Deposit / Withdraw strip. Below it three tabs, the same everywhere:
Positions, Orders, History. Each row lists the actions valid for **that
position type** and says where each goes.

Rule (Decision 4): redeem, cash out and cancel happen in place in the Wallet.
Opening a trade, and closing a position, stay in the market screen. Where an
action must leave the Wallet, the row says so and links to the market detail.

| App | Position types | Actions in the Wallet | Leaves to market screen |
|---|---|---|---|
| Polymarket | Sports bet; up/down round; neg-risk flag; has cash P&L and % | Redeem (ready to collect), Cash out (confirm modal, sells via `placeBet`), Cancel order | View market (from history rows) |
| Phoenix | Long / short perp | TP/SL (edit), Cancel conditional order | Close position (today a sheet; confirm in design, see Open items) |
| Pacifica | Long / short perp | TP/SL (edit), Cancel order | Close position (same note) |
| Meteora | DLMM LP position | Manage: claim fees, remove liquidity (presets or close), claim and close | Add liquidity, if it is a "trade" (see Open items) |
| Spot | Token holdings | Swap (opens Swap mode with the token prefilled) | Token detail / Buy / Sell today go to `/swap` |

Every row must define what it shows when data is loading, unavailable, or
stale (keep the existing "never blank a known value mid-retry" rule from
`WalletAccountRow.tsx`).

## Data needed

Already available (per survey): Polymarket cash, active picks, ready-to-collect
and per-position P&L (computed on the phone); Spot balances and value
(`GET /spot/:wallet/balances`); Phoenix trader state and histories
(`/perps/phoenix/trader/:authority/*`); Pacifica positions/orders/account
(read directly from Pacifica, from the phone); Polymarket bridge and CLOB
proxy endpoints.

Missing or UNVERIFIED:
- One "value per app" number for Phoenix, Pacifica and Meteora. UNVERIFIED
  whether equity is computed server-side.
- Per-position P&L for Phoenix, Pacifica, Meteora. Not checked.
- Meteora has no API route; reads are client-side. UNVERIFIED where the data
  comes from.
- The user's own activity across venues. The existing `/market/wallet-activity`
  is **tracked** wallets, not the user's own history. Do not mix them up.
- Allocation by chain: computed in `features/wallet/wallet.totals.ts` (not read
  in full).
- Relay quote proxy endpoint on the myboon API: does not exist.

Shared API types for any new endpoint land in `packages/shared` in their own
small PR before frontend work starts (team rule).

## What this replaces

- `2026_07_21_beta_readiness_wallet_PRD.md`: its "Send / Receive / Transfer
  Coming soon" tiles and "Deposit and Withdraw postponed" rule are superseded.
- `2026_08_12_wallet_completion_meme_trader_PRD.md`: its Spot Hub and shared
  Trade Sheet are superseded (Decisions 2 and 3). Its "never say Spot wallet"
  and spot-data rules still stand.
- Still valid: `wallet_connectivity_restructure` PRD and
  `specs/wallet_connectivity.md` (signer and connection model);
  `token_identity_and_venue_adapters` PRD and `specs/token_identity.md` (token
  lists Move depends on).
- The standalone per-venue profile screens and the per-app Deposit/Withdraw
  modals are removed once the Wallet covers them. Deleting the modals comes
  after Move is proven for that app, not before.
- The combined portfolio's route and the "per-venue scoped view" issue (#657)
  are folded into this work.

## Decisions to confirm (defaults used in this draft)

1. **Deposit/withdraw:** Move prefills; each app's own step finishes the last
   hop until Relay is proven for that app.
2. **Swap** is one of the four modes. No separate Trade Sheet.
3. **Spot rows** open the chain's token list, not a Spot Hub.
4. **Redeem, cash out, cancel** happen in the Wallet. Opening a trade and
   closing a position stay in the market screen.
5. **Relay key** lives on the myboon API server, which proxies quotes.
6. **Move launch scope:** Solana and Base. Polygon / Polymarket "to be
   confirmed".

## Open items (not decided, not defaults)

- Is "close position" a trade? Draft says yes (stays in market). The mock and
  owner should confirm, because today Phoenix and Pacifica close from the
  profile.
- Is Meteora "add liquidity" a trade? Draft says it is out of the Wallet.
- Does a market screen still show a small "your position here" strip linking to
  the Wallet? Draft recommends yes.
- Send: Solana only at launch? Token support? Address book? Not decided.
- What does Receive show when the user has Solana and EVM addresses? Not
  decided.
- Relay: Polygon support, app fees, free-tier limits, time-estimate unit, and
  SOL needed for fees are all UNVERIFIED. A short spike answers them.
- Relay requires an API key for `POST /quote/v2` from 2026-10-02; the key must
  exist before launch. Owner of the Relay account: not decided.
- Money, wallet and signing are touched, so every issue here carries
  `needs-bucket`; Bibhu alone merges.

## Out of scope

- Opening trades, market screens, order composers.
- Building bridge internals.
- Tracked-wallet feed (`/wallets`, KOL wallets). Different feature.
- Fiat on/off-ramp.
- Notifications content behind the bell (the bell is a header placeholder here).

## Acceptance criteria (product level)

Each becomes Given/when/then scenarios in its issue.

1. Wallet shows the four-mode switch in the order Swap | Move | Send | Receive,
   with Swap selected on load. Swap works as today; the other three are
   disabled until their issue lands. The panel body is the same size in every
   mode.
2. Portfolio shows total, allocation bar, Apps | Spot, top 5 plus "more", Table
   view. A disconnected app shows nothing. One failing app does not blank the
   others.
3. An Apps row shows its summary line. Tapping it opens the app view with the
   correct app selected; "profile" links from elsewhere land there too.
4. Polymarket app view shows cash, open-bets value, P&L, Deposit/Withdraw, and
   Positions/Orders/History with redeem, cash out and cancel working in place.
5. Deposit on an app opens Move with To prefilled; Withdraw with From prefilled.
6. Receive shows address and QR; copy works.
7. Send transfers a token with swipe-to-confirm and shows the result.
8. Move quotes via the myboon API, shows fees and time, signs, and shows
   status until done or failed. Unsupported routes say so plainly.
9. The old Polymarket Deposit/Withdraw modals are deleted only after item 5 is
   proven for Polymarket.

## Suggested issue breakdown (to groom, not yet created)

Parallel from the start (different files):
- Venue app-view shell plus migrate Polymarket's account side into it (replaces
  splitting `polymarket.portfolio.tsx` in place). Then Phoenix, Pacifica,
  Meteora one at a time.
- New gold header and four-mode switch (B1).
- Portfolio section, Table view (B2).
- Receive mode.
- Split `ConnectionSheet.tsx` (1,433 lines, refactor only).

Then:
- Apps/Spot navigation into the app view.
- Map and Cards views.
- Send mode (`needs-bucket`).
- Relay spike, then API quote proxy (shared types first), then Move UI, then
  Deposit/Withdraw wiring, then delete old modals.

## Design work

`docs/design/wallet.html` is the locked mock. It has 45 frames in 10 groups:
action panel (four modes), Swap states, Move states, Move prefilled from an
app, amount keyboard, Send and Receive, slide-up and Portfolio, app view
(Polymarket, Phoenix, Meteora, Spot token list), states (loading, empty, not
connected, one app failing, stale), and the market-screen strip. It keeps fake
data and says so. Open `?proto` for the clickable phone, which has a Demo
states panel for reaching each state.

Other layouts were drawn and dropped: a cards-and-picker layout, an
amount-first layout, a two-by-two token grid, and a merged Swap and Move
panel. They are not part of this PRD.

Mock details that are placeholders, not decisions: the per-app numbers for
Phoenix, Pacifica and Meteora are invented; brand colors for Phoenix, Pacifica
and Meteora were picked by the designer; Pacifica reuses the Phoenix layout and
is only reachable in the proto; Send's token chip is a static Solana USDC pill.

## References

- `docs/design/wallet.html`
- `apps/hybrid-expo/features/wallet/` (HomeWalletOverview, CombinedPortfolioScreen,
  WalletActivityTiles, WalletActionPanel, WalletAccountRow, wallet.totals.ts)
- `apps/hybrid-expo/features/portfolio/` (per-venue profile screens;
  `venue-portfolio.contract.ts`)
- `apps/hybrid-expo/features/swap/components/SwipeToConfirm.tsx`
- `apps/hybrid-expo/components/polymarket/DepositModal.tsx`, `WithdrawModal.tsx`
- `packages/api/src` (spot, phoenix, polymarket, swap, rpc)
- Relay: https://docs.relay.link/llms.txt
- `docs/team/labels-and-flow.md`
