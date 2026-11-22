# Wallet — Beta Test Cases

Date: 2026-07-21
Source PRD: [`2026_07_21_beta_readiness_wallet_PRD.md`](../PRDs/2026_07_21_beta_readiness_wallet_PRD.md)
Scope: **beta P0 only** — a real `/wallet` screen showing a combined total
across Solana spot, Meteora, Phoenix, and Pacifica, replacing Home's
hard-coded Wallet preview and the account drawer's hard-coded protocol
values. Polymarket, working Send/Receive/Deposit/Withdraw/Transfer, inline
per-position detail, and unified net worth beyond this total are explicitly
out of scope — see the source PRD's `Explicitly Postponed` section.

## How to read this document

- **TC ID** groups: `TOTAL` (combined total / mix bar), `ROWS` (per-protocol
  account rows), `NAV` (tap-through navigation), `ACT` (Send/Receive/
  Transfer activity tiles), `STATE` (loading/partial/stale/disconnected),
  `TRUST` (data-honesty rules from the PRD), `DRAWER` (account drawer
  cleanup), `A11Y` (accessibility).
- **Priority** P0 = blocks beta, P1 = should pass before beta, P2 = polish/edge case.
- **Status** is Not Run for all cases; update per test cycle.

---

## 1. Combined Total and Mix Bar

### TC-TOTAL-001: Total is a genuine sum of resolved sources

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Connect a wallet with real balances across Spot, Meteora, Phoenix, and
   Pacifica.
2. Wait for all four to resolve and read the total.

**Expected**
- Total equals Spot + Meteora + Phoenix + Pacifica exactly (no rounding
  drift beyond currency precision).
- Total has no eyebrow label above it ("Combined total," "Net worth," etc.
  are not shown — see PRD design decision #11).

### TC-TOTAL-002: Total appears as soon as one source resolves

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Open Wallet with all four sources cold (never fetched).
2. Observe the total as each source resolves one at a time, in any order.

**Expected**
- No total renders while zero sources have resolved (skeleton only, no `$0`).
- As soon as one source resolves, the total renders as the sum of resolved
  sources so far — it does not wait for all four.
- No banner, asterisk, or explanatory text ever appears stating how many
  sources are still pending (PRD design decision #13).

### TC-TOTAL-003: Mix bar reflects only resolved sources

**Priority:** P0 · **Type:** Functional / UI · **Status:** Not Run

**Steps**
1. Repeat TC-TOTAL-002, inspecting the segmented mix bar at each stage.

**Expected**
- The mix bar always sums to 100% of only the currently-resolved sources; an
  unresolved source is never allocated a 0%-width "ghost" segment that
  implies it was counted.
- Each segment's color matches that protocol's brand color (Spot purple
  `#9945FF`, Meteora violet `#6E45FF`, Phoenix orange `#FF8D2A`, Pacifica
  cyan `#61D7EF` — PRD design decision #15).

### TC-TOTAL-004: Total never silently omits a permanently-failed source

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Force one source (e.g. Pacifica) to fail after retries are exhausted.
2. Observe the total and mix bar over an extended session.

**Expected**
- The total continues to reflect only the resolved sources (it does not
  block or freeze), and it never presents itself as a complete portfolio
  value if a user could reasonably expect all four to be counted.
- Combined with TC-ROWS-* below: the failed row itself remains visibly
  distinct (see TC-STATE-002) so the omission is discoverable by inspecting
  the row list, even though the total itself carries no callout text.

### TC-TOTAL-005: "As of" freshness on the total

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Load Wallet, let the total resolve, then background the app for several
   minutes and return.

**Expected**
- The total shows an "as of X minutes ago" freshness label once at least one
  source has loaded.
- The label updates to reflect the most recent successful refresh, not a
  stale fixed timestamp from first load.

---

## 2. Per-Protocol Account Rows

### TC-ROWS-001: Each row shows exactly one dollar figure

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Inspect the Spot, Meteora, Phoenix, and Pacifica rows.

**Expected**
- Each row shows exactly one dollar value for that protocol's account/
  position value (or equity for Phoenix/Pacifica). No row lists individual
  positions inline as separate line items with their own dollar amounts.

### TC-ROWS-002: Perps rows show equity, not static collateral

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Open a Phoenix or Pacifica position with a nonzero unrealized PnL.
2. Compare the Wallet row's value to that protocol's own profile screen at
   the same moment.

**Expected**
- The Wallet row's number equals collateral + unrealized PnL, matching the
  protocol's own profile screen exactly (per PRD Beta Success Criteria).
- The number moves when the market moves, even if the user has not touched
  the position (no caching that freezes PnL between visits).

### TC-ROWS-003: Spot row shows composition via token chips, not text

**Priority:** P0 · **Type:** Functional / UI · **Status:** Not Run

**Steps**
1. Connect a wallet holding more than 4 distinct tokens.
2. Inspect the Spot row.

**Expected**
- Row shows small overlapping token-logo chips for the largest holdings plus
  a "+N" chip for the remainder — never a spelled-out sentence like "7
  tokens."
- Chip order is by holding size, largest first.
- Chips are decorative: tapping a chip does not navigate or open anything on
  its own. The row's own press target handles the tap and opens the Spot
  holdings sheet (TC-NAV-004).

### TC-ROWS-008: Spot holdings sheet lists every token, ranked

**Priority:** P0 · **Type:** Functional / UI · **Status:** Not Run

**Steps**
1. Connect a wallet holding at least 6 distinct tokens, one of them below $1.
2. Tap the Spot row.
3. Compare the sheet against the row's chips.

**Expected**
- Sheet header reads "<n> tokens · <total>", where `<n>` equals the number of
  distinct held tokens and `<total>` equals the row's Spot value.
- One row per token, ranked by USD value descending; small balances are still
  listed (no dust filter).
- The sheet lists the same tokens and the same order as the chips slice:
  chips = first 3, "+N" chip = `<n> - 3`. For example 6 tokens shows 3 chips
  and "+3".
- Rows are 60pt tall with hairline separators; the "Open Spot" action stays
  pinned in the footer while the list scrolls.

### TC-ROWS-004: Meteora row shows one pill per LP position

**Priority:** P0 · **Type:** Functional / UI · **Status:** Not Run

**Steps**
1. Open 1 LP position, verify the row.
2. Open a 2nd LP position (one in range, one out of range), verify the row
   again.

**Expected**
- With 1 position: one pill showing the pair name, ring-colored green (in
  range) or red (out of range).
- With 2+ positions: one pill per position, each independently ring-colored
  by its own range status — never a text summary like "2 in range, 1 out."
- The row's single dollar value is the sum of all LP position values.

### TC-ROWS-005: Phoenix/Pacifica rows show one pill per open perps position

**Priority:** P0 · **Type:** Functional / UI · **Status:** Not Run

**Steps**
1. Open 1 perps position, verify the row.
2. Open a 2nd position in the opposite direction (one winning, one losing),
   verify the row again.

**Expected**
- With 1 position: one pill showing the asset and a direction arrow, tinted
  by whether that position is currently winning.
- With 2+ positions: one pill per position, each independently tinted by its
  own live PnL — never a text summary like "3 positions."
- The row's single dollar value is that protocol's total equity across all
  open positions (per TC-ROWS-002).

### TC-ROWS-006: Zero-position protocol row

**Priority:** P1 · **Type:** Functional · **Status:** Not Run

**Steps**
1. View a connected wallet with no open Meteora, Phoenix, or Pacifica
   positions.

**Expected**
- The row still appears (not hidden) with its real value (likely near-zero
  cash/collateral if any) and no pills, rather than an empty or broken-
  looking row.

### TC-ROWS-007: Protocol identity uses real brand colors, no icon badges

**Priority:** P1 · **Type:** UI · **Status:** Not Run

**Steps**
1. Visually inspect all four rows together.

**Expected**
- No circular icon/logo badge appears on any row.
- No colored left-edge rail appears on any row.
- Each row's protocol name renders in that protocol's brand color, and the
  row background carries a faint matching tint (PRD design decision #15).
- Meteora and Phoenix remain visually distinguishable from each other at a
  glance (violet vs. orange, not two shades of orange).

---

## 3. Tap-Through Navigation

### TC-NAV-001: Meteora row navigates to its profile screen

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Tap the Meteora row.

**Expected**
- Navigates to `/markets/meteora/profile`.
- No inline expansion or duplicate position list renders on `/wallet`
  itself before navigating.

### TC-NAV-002: Phoenix row navigates to its profile screen

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Tap the Phoenix row.

**Expected**
- Navigates to `/markets/phoenix/profile`.

### TC-NAV-003: Pacifica row navigates to its profile view

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Tap the Pacifica row.

**Expected**
- Navigates to `/trade?view=profile`.

### TC-NAV-004: Spot row opens the Spot holdings sheet

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Tap the Spot row (any part of it, including on top of its chips).
2. Scroll the list.

**Expected**
- A sheet opens titled "Spot" with the sub-line "<n> tokens · <total>",
  listing every held token ranked by USD value (TC-ROWS-008).
- Tapping a chip inside the row opens the same sheet; chips are not separate
  targets and never open anything else.
- The "Open Spot" footer action opens venue-level `/spot` with no token
  param.
- Scrim tap, swipe-down, and Android back all dismiss the sheet and return
  to Home with the wallet section unchanged.
- The sheet never shows a loading skeleton on open when balances are already
  on screen, and shows the existing refresh/error state if a refetch fails
  while it is open.

### TC-NAV-006: Per-token Trade opens Spot filtered to that token

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Open the Spot holdings sheet for a wallet holding SOL.
2. Tap "Trade" on the SOL row.

**Expected**
- Navigates to `/spot` with `params: { token: <SOL canonical mint> }` — the
  mint address, never the symbol.
- Spot opens filtered/selected to that token; back returns to Home wallet
  section.
- Every listed token with a valid mint address has its own Trade target;
  none of them is a no-op.

### TC-NAV-007: Token without a valid mint has no Trade target

**Priority:** P1 · **Type:** Functional / UI · **Status:** Not Run

**Steps**
1. Connect a wallet whose Spot holdings include a token whose mint is not a
   base58 32–44 character public key (mint-shape gate fails).
2. Open the Spot holdings sheet.

**Expected**
- That row is still listed with its symbol, amount and value — the holding
  is never hidden.
- It has no Trade target at all; the trailing slot shows a muted "NOT ON
  SPOT" label instead.
- Tapping the row does nothing (no dead link, no empty Spot screen, no error
  toast).
- Screen readers announce the label as a state ("not tradable on Spot"), and
  the row is not exposed as a button.

### TC-NAV-005: Home Wallet preview links into full `/wallet`

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. From Home, tap through from the Wallet preview section.

**Expected**
- Opens the full `/wallet` screen.
- The preview never shows fabricated figures at any point in this flow.

---

## 4. Wallet Activity Tiles (Send / Receive / Transfer)

### TC-ACT-001: Activity tiles render as normal, fully-styled tappable tiles

**Priority:** P0 · **Type:** UI · **Status:** Not Run

**Steps**
1. Inspect the Send, Receive, and Transfer tiles.

**Expected**
- No "Soon" badge, no muted/disabled visual treatment, no lock icon. Tiles
  look identical in styling to any other live, working action in the app
  (PRD design decision #18).

### TC-ACT-002: Tapping an activity tile shows a "Coming soon" tooltip

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Tap Send.
2. Tap Receive.
3. Tap Transfer.

**Expected**
- Each tap shows a small "Coming soon" tooltip anchored to that tile.
- No navigation occurs, no crash, no silent no-op with zero feedback.
- Tooltip dismisses automatically after a short delay or on next
  interaction; it does not persist indefinitely or block the screen.

### TC-ACT-003: Deposit/Withdraw are tracked but out of this screen's P0 set

**Priority:** P2 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Confirm whether Deposit/Withdraw tiles are present per the final build
   decision (PRD lists them under wallet-level activities generally, but the
   design-decision tile set names Send/Receive/Transfer specifically).

**Expected**
- Whichever tiles are shipped follow the same TC-ACT-001/002 rules — no
  inconsistent treatment where some "Coming soon" actions look disabled and
  others don't.

---

## 5. Loading, Partial, Stale, and Disconnected States

### TC-STATE-001: Cold-load skeleton state

**Priority:** P0 · **Type:** State / UI · **Status:** Not Run

**Steps**
1. Open Wallet with a freshly connected wallet, nothing cached.

**Expected**
- Total area shows a shimmer skeleton block, not a spinner-only or blank
  screen, and no `$0`.
- Each account row shows its own dashed-border "syncing" state with a small
  spinner (PRD design decision #14) rather than a skeleton bar alone —
  confirm which of these two treatments (shimmer bar vs. dashed+spinner) is
  used per row in the final build and that it's applied consistently.

### TC-STATE-002: One source pending/failed while others are loaded

**Priority:** P0 · **Type:** State / UI · **Status:** Not Run

**Steps**
1. Force Pacifica to remain pending (or fail) while Spot, Meteora, and
   Phoenix resolve normally.

**Expected**
- Pacifica's row shows a dashed border, small spinner, and "syncing" —
  never the word "Unavailable" and never harsh/alarming copy (PRD design
  decision #14).
- A retry affordance is present on the pending/failed row.
- The other three rows are unaffected and show their real values normally.
- The total and mix bar reflect only Spot + Meteora + Phoenix, per
  TC-TOTAL-002/003 — with no banner explaining the omission.

### TC-STATE-003: Stale data is labeled and retained, not blanked

**Priority:** P0 · **Type:** State / UI · **Status:** Not Run

**Steps**
1. Force a source (e.g. Meteora) to return cached/stale data on refresh.

**Expected**
- The row keeps showing its last known value (not blank, not `$0`) and
  visibly labels it stale, distinct from the "syncing"/pending treatment in
  TC-STATE-002.
- The row's own "as of" timestamp reflects the actual last-successful-fetch
  time, not the current time.

### TC-STATE-004: Disconnected state

**Priority:** P0 · **Type:** State / UI · **Status:** Not Run

**Steps**
1. Open `/wallet` (or Home's Wallet preview) with no wallet connected.

**Expected**
- No number of any kind renders — not `$0`, not a placeholder chart, not a
  ghost skeleton implying data is coming.
- A clear "Connect a wallet" prompt with a working connect action is shown.
- Feed and Apps/Markets remain reachable; disconnection does not block the
  rest of the app.

### TC-STATE-005: Retry affordance actually retries

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. From TC-STATE-002/003's failed/stale row, tap the retry action.

**Expected**
- Only that protocol's fetch is retried (other rows do not reload
  unnecessarily).
- On success, the row updates to its normal loaded state, its "as of" stamp
  updates, and the total/mix bar recompute to include it.

---

## 6. Trust Rules (Data Honesty)

### TC-TRUST-001: No bare `$0` standing in for unknown data, anywhere on screen

**Priority:** P0 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Audit every dollar figure on `/wallet` and Home's Wallet preview across
   all states in this document.

**Expected**
- Every figure is either a real sourced number or an explicit non-loaded
  state (skeleton/syncing/stale-labeled) — never a bare `$0` used as a
  stand-in for "we don't know."

### TC-TRUST-002: No fabricated placeholder values remain anywhere

**Priority:** P0 · **Type:** Regression · **Status:** Not Run

**Steps**
1. Search the shipped build for the previous hard-coded values: `$9,428` net
   worth, `+3.8% today across 5 venues`, the three hard-coded position rows
   (Prediction cash `$1,240`, SOL-PERP `$3,880`, Meteora LP `$920`), and the
   drawer's hard-coded Pacifica `$1,204`.

**Expected**
- None of these values appear anywhere in Home, the account drawer, or
  `/wallet`, regardless of connection or data state.

### TC-TRUST-003: Wallet row numbers match each protocol's own profile screen

**Priority:** P0 · **Type:** Functional / Regression · **Status:** Not Run

**Steps**
1. For each of Meteora, Phoenix, and Pacifica, compare the Wallet row's
   dollar value against that protocol's own profile/position screen, read
   at the same moment.

**Expected**
- Values match exactly (accounting for normal fetch-timing skew, not a
  structural discrepancy).

---

## 7. Account Drawer Cleanup

### TC-DRAWER-001: Hard-coded Pacifica value removed from the drawer

**Priority:** P0 · **Type:** Regression · **Status:** Not Run

**Steps**
1. Open the account drawer.

**Expected**
- No protocol balance cards of any kind appear (Predict, Phoenix, Pacifica,
  or otherwise) — that responsibility has moved entirely to `/wallet`.

### TC-DRAWER-002: App version reads from application metadata

**Priority:** P0 · **Type:** Regression · **Status:** Not Run

**Steps**
1. Open the account drawer and read the displayed app version.
2. Compare against the actual build's application metadata (e.g. `app.json`
   / native build version).

**Expected**
- Displayed version matches the real build version exactly; the previous
  hard-coded `v0.1.0` no longer appears if the real version differs.

### TC-DRAWER-003: Drawer retains identity/utility functions only

**Priority:** P1 · **Type:** Functional · **Status:** Not Run

**Steps**
1. Inspect the drawer's full contents.

**Expected**
- Identity, auth method, connected address, copy/export, feedback/support/
  privacy, and disconnect are all still present and functional.
- No protocol-specific navigation or balance content remains.

---

## 8. Accessibility

### TC-A11Y-001: Signal pills are not color-only

**Priority:** P1 · **Type:** Accessibility · **Status:** Not Run

**Steps**
1. Inspect a winning vs. losing perps pill, and an in-range vs. out-of-range
   LP pill, with color vision simulation or grayscale.

**Expected**
- Direction/range state is distinguishable by shape/icon (arrow direction,
  ring vs. no ring) in addition to color, not by color alone.

### TC-A11Y-002: Tooltip and retry actions are reachable via assistive tech

**Priority:** P1 · **Type:** Accessibility · **Status:** Not Run

**Steps**
1. Navigate the Wallet screen with a screen reader.

**Expected**
- Activity tiles announce their name and that tapping shows more
  information (not a silently inert element).
- Retry affordances are announced as actionable buttons with a clear label.

---

## Notes

- This document tracks the P0 beta scope only. Working Send/Receive/Deposit/
  Withdraw/Transfer flows, Polymarket inclusion, inline per-position detail,
  and any richer cross-protocol net-worth work are tracked separately once
  those features move into active scope — do not add their test cases here
  until then.
- Update **Status** per test cycle; do not delete failed cases — record the
  failure and link the fixing commit/PR instead, so this file remains the
  running record of what's actually been verified.
