# Wallet PRD

Status: decision-aligned draft for review
Date: 2026-07-21
Owner: myboon product
Platform: mobile-first Expo app

## Purpose

Give the user one place to see everything they hold across myboon's
Solana-native surfaces, and one place to eventually act on it.

The experience follows the product pattern already used by myboon:

```text
Feed -> Apps -> Wallet
```

Wallet is the third pillar. Today it is a hard-coded mockup on Home and a
drawer that mixes identity controls with a fabricated protocol balance. This
PRD replaces both with a real, honestly-stated summary of what the connected
wallet actually holds and owes across Solana spot and the protocols myboon
integrates with.

## Decision Summary

The following decisions were confirmed during a requirements interview:

1. Wallet shows a combined total, aggregated from: **Solana spot balance**,
   **Meteora**, **Phoenix**, and **Pacifica**. Polymarket is explicitly
   excluded from this phase — it remains reachable only through its existing
   `/predict-profile` screen and account drawer path.
2. The total is a genuine sum (`spot + Meteora + Phoenix + Pacifica`), not a
   single-source read. It is modeled on DeBank's net-worth-plus-breakdown
   pattern in spirit only, not in visual design.
3. The total is always shown, computed from whichever sources have
   successfully loaded. It is never hidden while sources are in flight past
   their own loading state, and it is never silently wrong: if one source
   fails, the total is visibly marked partial rather than presented as
   complete.
4. Every dollar figure shown — spot or protocol — is a real, sourced number
   or an explicit `Unavailable`. It is never a fabricated placeholder and
   never a bare `$0` standing in for "we don't know."
5. Spot balance covers whatever tokens a chosen balance/pricing
   source-of-truth API returns for the connected Solana wallet, priced in
   USD by that same source.
6. Perps protocol rows (Phoenix, Pacifica) show **equity** — collateral plus
   unrealized PnL — not static collateral alone. This number moves with the
   market even when the user has not touched the position.
7. Each protocol row shows exactly one number (that protocol's account
   value). It does not list individual open positions inline. Tapping a
   protocol row navigates to that protocol's own existing profile/position
   screen for detail.
8. While a source is loading, its row shows a skeleton placeholder, not a
   spinner-only or blank state. Once loaded, the row (and the total) show an
   "as of X minutes ago" freshness label.
9. Wallet also becomes the home for wallet-level activities. **Send,
   Receive, and cross-protocol Transfer** are the three actions actually
   designed and shipped in P0 — they render as fully-styled, tappable tiles
   that show a `Coming soon` tooltip on tap, not working flows and not
   visually disabled. Deposit and Withdraw are not part of this phase; they
   remain a candidate follow-up once designed, not a P0 commitment. Only the
   read summary and per-protocol tap-through navigation are live in P0.
10. Wallet is conceptually a global profile for the connected wallet, not a
    trading surface in its own right. It does not duplicate any protocol's
    execution UI.

## Design Decisions (from the Wallet mock design pass; current reference: home-redesign/wallet-inline.html)

These were resolved after the initial decision interview, while iterating
on `docs/mockups/home-redesign/wallet-inline.html`. They refine, and in a few cases override,
the visual assumptions implied above — this section is the current source of
truth for how the screen looks and behaves, not just what data it shows.

11. The total carries no eyebrow label (no "Combined total," no "Net worth").
    It is the hero number directly under the "Wallet" section title.
12. The "spot + Meteora + Phoenix + Pacifica" composition is shown as a
    segmented percentage mix bar under the total, not as text. Each
    protocol's slice uses that protocol's own real brand color.
13. There is no status banner of any kind on the hero card — not for a
    loading source, not for a failed source, not for a partial total. The
    total number and mix bar simply reflect whichever sources have resolved,
    silently. This is required to scale to 15-16+ protocols without
    accumulating a wall of explanatory sentences.
14. A source that fails to load is never called "Unavailable" with harsh,
    alarming language. Its row stays visible with a dashed border, a small
    spinner, and the word "syncing," plus a retry affordance — framed as
    temporary/in-progress, not broken.
15. Account rows have no circular icon badges and no colored left-edge
    rail (both were rejected as generic/templated). Protocol identity is
    carried by the row's name text color and a very faint background tint,
    both drawn from that protocol's real brand color:
    - Spot -> Solana's own purple (`#9945FF`)
    - Meteora -> the violet end of its real gradient mark (`#6E45FF`,
      deliberately not its orange-red stop, to stay visually distinct from
      Phoenix)
    - Phoenix -> its flat brand orange (`#FF8D2A`)
    - Pacifica -> its flat brand cyan (`#61D7EF`)
16. "Solana spot" is labeled simply "Spot" in the UI.
17. A protocol row never spells out a position count in text (e.g. never
    "3 positions"). Instead, each open position renders as a small pill:
    - Spot: overlapping tiny token-logo chips for the largest holdings, with
      a "+N" chip if more exist.
    - Meteora (LP): one pill per position showing the pair (e.g. "SOL/USDC"),
      with a colored ring — green ring = in range/earning, red ring = out of
      range.
    - Phoenix / Pacifica (perps): one pill per open position showing the
      asset and a direction arrow, tinted green or red by whether that
      specific position is currently winning.
    This keeps the row honest and glanceable regardless of how many
    positions are open, without violating decision #7 (still exactly one
    dollar number per row, no inline position list).
18. Send, Receive, and Transfer render as normal-looking, fully enabled
    tappable tiles (no "Soon" badge, no muted/disabled visual treatment).
    Tapping one shows a small "Coming soon" tooltip near the tile, rather
    than the tile itself announcing its own unavailability up front.

## Product Problem

The current Home "Wallet" section and account drawer both show numbers that
are not real:

- Home's Wallet preview shows a hard-coded net worth, a hard-coded daily
  change, and three hard-coded position rows, regardless of whether a wallet
  is even connected.
- The account drawer shows a hard-coded Pacifica account value alongside two
  protocol cards (Predict, Phoenix) that do fetch real data — an
  inconsistency that is itself confusing, since some numbers on the same
  screen are real and one is not.
- There is no single screen today that answers "what do I actually have,
  right now, across everything myboon can see." A user must open each
  protocol's own profile screen separately to get a real number, and even
  then, those numbers are shaped differently by each protocol (some are
  plain numbers with no null-handling, some already use a `null`/`stale`/
  `unavailable` convention).

This PRD does not ask "should we show a number." It asks "how do we show a
number the user can trust," including the moment something fails to load.

## Why Wallet Fits myBoon

Wallet is the third pillar of the existing product shell:

```text
Feed    = what changed and why it matters
Apps    = where the user can inspect or act
Wallet  = what the user owns or has open, across everything myboon can see
```

Wallet is the cross-protocol memory of the user's own state, the same way
Feed is the cross-source memory of the market's state. It only becomes
useful once it is truthful — a wallet screen that shows a wrong number is
worse than no wallet screen at all.

## P0 Scope

P0 delivers a real, honestly-stated Wallet section inline on Home (no
separate screen):

```text
scroll Home to the Wallet section
  -> see a combined total, or a visibly partial total if a source failed
  -> see Solana spot balance, Meteora, Phoenix, and Pacifica as separate rows
  -> see freshness ("as of X minutes ago") once each source has loaded
  -> tap a protocol row to open that protocol's own account/position screen
  -> see wallet-activity tiles (Send, Receive, Transfer) that show a
     "Coming soon" tooltip on tap
```

### Included in P0

- a real, live-data Wallet section inline on Home, replacing the current
  hard-coded Wallet preview and the drawer's protocol-card section — there is
  no separate `/wallet` route; the full experience (total, mix bar, all
  account rows, activity tiles) lives directly in Home's long scroll
- a combined total across Solana spot, Meteora, Phoenix, and Pacifica
- Solana spot balance sourced from a chosen balance/pricing source-of-truth
  API, priced in USD
- Meteora, Phoenix, and Pacifica account rows showing one number each:
  Meteora's current position value, and Phoenix/Pacifica's equity
  (collateral + unrealized PnL)
- tap-through navigation from each protocol row to that protocol's existing
  profile/position screen (no duplicated position lists on Wallet itself)
- skeleton loading state per row while a source is in flight
- an "as of X minutes ago" freshness label per row and on the total, once
  loaded
- a visibly partial-total state when one or more sources fail to load,
  distinct from the fully-loaded state
- explicit `Unavailable` display for any source that fails, never a bare
  `$0` or a silently-omitted row
- fully-styled, tappable Send/Receive/Transfer tiles that show a
  `Coming soon` tooltip on tap
- removal of all fabricated values from Home's Wallet preview and the
  account drawer's hard-coded Pacifica value

### Explicitly Postponed

- Polymarket inclusion in the Wallet total or row list (stays on its
  existing `/predict-profile` path)
- Deposit and Withdraw tiles — not designed for this phase; not a P0
  commitment at all (distinct from Send/Receive/Transfer, which are P0
  scope, just not working flows yet)
- working Send, Receive, and Transfer flows (Coming-soon tooltip only in P0)
- inline per-position detail on the Wallet screen (add/claim/remove-style
  actions remain on each protocol's own screen)
- any non-Solana chain or asset
- portfolio history, charts, or performance-over-time views
- personalization, watchlists, or multi-wallet support

## Information Architecture

### Route

There is no separate `/wallet` route. Wallet is a section within Home's
long scroll, in the existing `Feed -> Apps -> Wallet` order, and the entire
experience below lives there directly:

```text
Home
  -> Wallet section (inline, not a separate screen)
       Total (spot + Meteora + Phoenix + Pacifica, or partial-total state)
       Spot balance row
       Meteora row -> /markets/meteora/profile
       Phoenix row -> /markets/phoenix/profile
       Pacifica row -> /trade?view=profile
       Wallet activity: Send, Receive, Transfer (tappable tiles, each
         showing a "Coming soon" tooltip in P0)
```

### Navigation rules

- Home's Wallet section shows the real total (or its partial/loading state)
  and every account row directly, inline — it never shows fabricated
  figures again, and there is no intermediate preview-then-tap-through step.
- Tapping a protocol row always navigates to that protocol's own existing
  screen; Wallet does not attempt to replicate protocol-specific detail.
- The account drawer keeps identity, auth method, connected address,
  copy/export, feedback/support/privacy, and disconnect. It no longer shows
  any protocol balance or protocol profile card — that responsibility moves
  entirely to Home's Wallet section.
- App version in the drawer is read from application metadata, not
  hard-coded.

## Data and Trust Rules

These rules govern every number this screen shows:

- A number is either real (sourced from a live read) or explicitly marked
  `Unavailable`. It is never `$0` used as a stand-in for "unknown."
- The total is computed from whichever sources have successfully loaded. It
  is shown as soon as at least one source has loaded — it does not wait for
  all four.
- If any source has not loaded (still loading, or failed), the total is
  visibly marked partial (for example, an asterisk or inline note stating
  how many sources are missing), never presented as if it were complete.
  (Superseded in spirit by design decision #13 above: no explanatory banner
  text is shown; the total and mix bar simply reflect resolved sources.)
- Once a source loads, it gets a real "as of" timestamp. There is no
  timestamp for a value that has not yet loaded.
- A failed source shows its own row with a retry affordance; it does not
  disappear from the row list, and it does not block the other three rows
  from showing their real values. (See design decision #14 for the exact
  wording/tone — "syncing," not "Unavailable.")
- Perps equity (Phoenix, Pacifica) reflects live collateral plus unrealized
  PnL — not a cached or stale approximation presented as current.

## Beta Success Criteria

- No fabricated balance, delta, or position value is visible anywhere in
  Home's Wallet section or the account drawer.
- A user can distinguish, at a glance, between a fully-loaded total and a
  partial total missing one or more sources.
- Every protocol row's number matches what that protocol's own profile
  screen shows for the same account at the same time.
- Tapping any protocol row reliably opens that protocol's existing
  profile/position screen.
- `Coming soon` wallet-activity entries are visibly non-functional on tap
  (show a "Coming soon" tooltip), never mistaken for a working action.

## Acceptance Criteria

- [ ] Home's Wallet section shows real, live data and fully replaces the
      hard-coded Wallet preview values — no separate `/wallet` route exists.
- [ ] The account drawer's hard-coded Pacifica value and hard-coded app
      version are removed; version reads from application metadata.
- [ ] The account drawer no longer shows protocol balance cards; that moves
      to Home's Wallet section.
- [ ] Wallet shows a combined total of Solana spot balance, Meteora,
      Phoenix, and Pacifica.
- [ ] Polymarket is not included in the Wallet total or row list.
- [ ] Spot balance is priced in USD via a chosen source-of-truth balance
      API.
- [ ] Phoenix and Pacifica rows show equity (collateral + unrealized PnL),
      not static collateral.
- [ ] Each protocol row shows exactly one number and navigates to that
      protocol's existing screen on tap; no inline position lists appear in
      Home's Wallet section.
- [ ] Each row shows a skeleton while loading and an "as of X minutes ago"
      label once loaded.
- [ ] The total is never presented as complete when one or more sources
      have not loaded successfully (no banner text required — see design
      decision #13 — but the number itself must reflect only resolved
      sources).
- [ ] No dollar amount anywhere on this screen is a fabricated placeholder
      or a bare `$0` standing in for unavailable data.
- [ ] Send, Receive, and Transfer appear as fully-styled tappable tiles that
      show a "Coming soon" tooltip on tap, never a working action and never
      visually disabled. Deposit and Withdraw are not part of this P0.
- [ ] The percentage mix bar and per-protocol brand colors match design
      decisions #12 and #15 (Spot purple, Meteora violet, Phoenix orange,
      Pacifica cyan).
- [ ] Multi-position protocols (Meteora, Phoenix, Pacifica) render one
      small pill per open position (never a spelled-out count), per design
      decision #17.

## References

### myboon

- [`docs/VISION.md`](../../../VISION.md)
- [`docs/PRDs/beta readiness sprint PRD.md`](../../../PRDs/beta%20readiness%20sprint%20PRD.md)
- [`docs/PRDs/meteora dlmm app PRD.md`](../../../PRDs/meteora%20dlmm%20app%20PRD.md)
- [`docs/mockups/home-redesign/wallet-inline.html`](../../../mockups/home-redesign/wallet-inline.html) — the
  visual reference this PRD's design decisions section describes
