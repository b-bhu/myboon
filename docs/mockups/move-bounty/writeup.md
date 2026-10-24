# MyBoon Move: one step between your apps and chains

**Redesign entry for Superteam India, "Redesign your favourite app on Solana".**
App: **MyBoon Wallet**. Feature: **Move**, a single flow that replaces Transfer (until now "Coming soon"), bridging, and deposit/withdraw.

> All balances, fees, timings, addresses and the transfer ID in this prototype are **example data**. Nothing is signed or sent.

## The problem
MyBoon already puts Polymarket, Phoenix, Pacifica and a Solana spot wallet in one app. But the money in them doesn't move together. To put 100 USDC of Polymarket cash into Phoenix today, a user:

| | Count |
|---|---|
| Apps | **3** (Polymarket, a bridge app, MyBoon/Phoenix) |
| Steps | **13** |
| Signatures | **4** (withdraw, approve spend, bridge, deposit) |
| Addresses pasted by hand | **2** |
| Plus | finding SOL for gas, and no idea where the money is while it's in the bridge |

## The redesign
**You choose only From and To. MyBoon works out the route.** Every place money can live sits in one inline picker, grouped as **Apps** (Polymarket on Polygon, Phoenix, Pacifica, Spot wallet) and **Chains** (Base, Ethereum, Arbitrum). The same flow covers protocol to protocol (Polymarket to Phoenix), chain to chain (Base to Solana) and mixes (Phoenix to Base).

After: **1 app, 1 Wallet screen that changes in place, 2 approvals, 0 pasted addresses.**

### One screen, one dropdown, only the center changes
MyBoon's Wallet already has an action dropdown on the action name (Swap / Send / Receive / Transfer). Move takes the Transfer slot. Picking an option **never opens a bottom sheet or a new screen**: the masthead, the action name with its dropdown, and the bottom CTA stay exactly where they are, and only the center of the composer re-renders for the chosen mode (a 200 ms fade-and-rise, off under reduced motion).
- **Swap** → You pay / You receive panels, rate, minimum, slippage. CTA: *Review swap*.
- **Move** → From and To rows with a direction flip, the amount, the one-line outcome and "How it moves". CTA: *Review move*.
- **Send / Receive** → listed, greyed out, "Coming soon" (as in the current app).

The From and To pickers follow the same rule as our Swap token picker ("the slab is the picker"): tapping From or To expands the Apps and Chains list **in place inside the composer**; choosing closes it. Review also happens in place: the center turns into the approvals summary, and the same CTA becomes *Approve withdrawal · 1 of 2*. No scrim, no modal, no sheet anywhere in the Move flow.

### Screens
0. **Before**: a neutral schematic of today's 13 steps (no third-party UI copied).
1. **Wallet, Move selected**: every account row, and every open position on desktop, has **Move to…**, which sets From and opens the To list in place.
2. **Dropdown**: open over the composer, then Swap selected: the header and CTA hold still, only the center swaps.
3. **Inline From/To picker**: Apps and Chains, balances shown, the From and To pair pinned on top with a direction button. Options you can't choose stay visible, greyed out, **with the reason** ("Already your From", "Nothing to move. 0 USDC here", "Deposits paused until 10:00 PM IST").
4. **Amount and route** (same center): Max, then one sentence answers the question: *"Phoenix receives ≈99.40 USDC in ~3 min. You approve 2 times."* "How it moves" opens the steps with each fee and time, and marks which steps need your approval. Warnings appear for amounts below the minimum and for missing gas.
5. **Review in place**: says plainly how many approvals there are and what each one does. All fees are in one number. "Edit" sits next to the title; no countdown, nothing pre-ticked.
6. **Live tracker**: the top card always answers *"Where is your money now?"* The timeline from issue #173 (Withdrawal pending → In transit → Deposit detected → Funds available) is built from the actual route, so every scenario tells its own story end to end. Phoenix to Base reads Withdrawal pending → In your Spot wallet (approve bridge 2 of 2) → In transit, Solana → Base → Funds available in your Base wallet. You can leave: a status chip and a dot on the Wallet tab follow you.
7. **Success**: a receipt with what was sent, the fees, what was received, and when.
8. **Edge cases**
   - **Bridge stuck**: "In Circle's bridge … locked, not lost", the expected time, the explorer link, what happens next, and a **manual fallback** (claim it yourself with the transfer ID after 8:40 PM IST).
   - **Deposit failed**: "99.40 USDC is safe in your Solana wallet", with **Retry deposit** or **Keep in wallet**, and the retry cost stated.
   - **Not enough gas**: "Your Spot wallet has 0.0004 SOL, approving needs 0.0021". A switch, on by default and shown, offers to cover it from the amount (0.40 USDC), and the outcome line updates.

### Design decisions and why
- **Places, not plumbing.** People think "my money is in Polymarket, I want it in Phoenix", not "withdraw, bridge, deposit". The route is there for anyone who opens it, but you never need it to finish.
- **One outcome sentence beats a fee table.** Newcomers read "Phoenix receives ≈99.40 in ~3 min". Experts open "How it moves".
- **Disabled is not hidden.** Showing why an option can't be chosen teaches the system and stops support questions.
- **The tracker is about location, not progress.** "In the bridge, Polygon → Solana" is what an anxious user needs. A percentage bar doesn't tell them that.
- **Built in MyBoon's own system**: the gold masthead and action zone, the navy composer, real protocol colours and logos, the bottom tabs, and mono figures, all from the current `wallet-inline` reference. On desktop it becomes a real two-pane layout: the accounts and positions table on the left, the Move panel on the right, and a route map showing where the money is during a move.
- **Motion has a job**: the dropdown drops from the action name, the center fades up when the mode changes, pickers expand in place, a moving segment marks the live step, and the "now" dot pulses. Under `prefers-reduced-motion` all of it stops, and the live step shows as a static fill.

### Trust and safety
- **Non-custodial by design**: MyBoon never holds funds. Between steps the money sits in Circle's CCTP bridge (burn and mint, no wrapped tokens) or in the user's own wallet. Withdrawals only go to the user's own address.
- **Approvals say what they do**, before and when they happen ("Approve deposit · 2 of 2").
- **Every failure names where the money is and gives a way out**, including a manual path that doesn't depend on MyBoon.
- **Accessibility**: AA contrast on the navy and gold, visible focus rings, targets of 44px or more, safe-area insets, labelled dialogs and switches, and live regions for the outcome and the tracker.

## Draft form answers
**Which app did you redesign, and which features did you pick?**
MyBoon, a Solana super-app that brings Polymarket, Phoenix, Pacifica and a spot wallet together in one place. I redesigned its Wallet's money movement: Transfer, bridging and deposit/withdraw are now one "Move" flow. You pick From and To across apps and chains, see one outcome line with the route and fees, approve twice, and watch a live tracker that always says where your money is, including when a bridge is slow, a deposit fails or you're short on gas.

**What was the biggest problem you found in the current design, in 2-3 sentences?**
Moving money between two apps that MyBoon already shows side by side takes 3 apps, 13 steps, 4 signatures and 2 hand-pasted addresses. Worst of all, once the money is in a bridge the user has no idea where it is or what to do if it stalls. The design treated each protocol as an island, when users just think "move my money from here to there".

## Live prototype
`index.html` has a scenario switcher (happy path, bridge stuck, deposit failed, not enough gas), a Mobile/Desktop toggle, and a screen jump. The URL accepts `view=mobile|desktop`, `scenario=…`, `screen=wallet|tracker|left|success|stuck|failed|kept|before`, `mode=move|swap`, `menu=1` (dropdown open), `pick=from|to` (inline picker open), `review=1`, `step=…` and `export=1`. All balances, fees and times are example data.
