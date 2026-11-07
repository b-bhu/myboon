# Wallet connect sheet — research notes

Open `index.html` in a browser. The dock under the phone jumps to every state.

Mobbin MCP (`user-Mobbin`) is paywalled / not used for this mock.

Issue: [#590](https://github.com/b-bhu/myboon/issues/590) WS1 (ConnectionSheet) + WS2 (Privy export/recovery). Folded [#316](https://github.com/b-bhu/myboon/issues/316) fail states.

## Pattern adopted

First screen of the sheet is **two choices only**:

1. **Create a new wallet** (primary filled control)
2. **I already have a wallet** (secondary)

Create drills into **Continue with email** / **Continue with Google** (Privy).  
Already-have drills into **Seeker** / **Phantom** only (MWA) — never creates Privy.

Matches MyBoon `connect.options.ts` backends (`privy_embedded` → email/google, `external_mwa` → external wallet) but fixes the flat four-row list into a staged choice → method flow.

## Connected state (WS1)

Same sheet chrome for both paths; distinction is identity chrome + chains, not badges.
Labels match live `ConnectionSheet` `ConnectedStep` / chain rows.

| | Privy (create) | External (connect) |
|---|---|---|
| Title | **Wallets** (dual) | **Wallet** |
| Identity | Envelope / multicolor Google G + account string | Seeker / Phantom mark + wallet name |
| Chains | **Solana** + **EVM** — label+Copy on one row; full address nowrap (scroll) below | **Solana only** (MWA has no EVM); same address/Copy layout |
| Actions | **Export / recovery** once, **Disconnect** once (embedded logout drops both chains) | **Disconnect** only |

Home **Manage** opens the matching connected sheet when linked; otherwise the choice screen. No Receive / Send / QR here (later workstreams). No Solana|EVM picker on create/connect first screens (caller already opens with a chain).

## Export / recovery (WS2, Privy only)

Entry: Privy connected → **Export / recovery**.

Flow stays product-honest to Privy (no custom seed-phrase UI):

1. Short sheet: warning, then “Continue with Privy” / “Not now”
2. Wait: opening Privy Home (`https://home.privy.io`) in the system browser
3. Browser closes → back to the Privy connected sheet. The app is not told whether a key was copied, so it does not show a success check.

External connected cannot reach export (guarded in render + no action row). `@privy-io/expo` has no export method; Privy documents that call for the web SDK only.

Refs: [Privy export a wallet](https://docs.privy.io/wallets/wallets/export), [mobile key export](https://docs.privy.io/recipes/mobile-key-export), [Privy Home](https://docs.privy.io/basics/get-started/dashboard/privy-home), [Privy Home key controls](https://privy.dev/blog/enhanced-wallet-controls-in-privy-home).

## Fail setup (#316)

- Sign-in failed → retry create (email/Google).
- Wallet setup failed → “signed in, wallet didn’t finish” + **Try wallet again** only.
- After 3 setup fails: optional **Log out and start over**.

## Sources (choice hierarchy)

- Phantom — [How to create a new Phantom wallet](https://phantom.com/learn/guides/how-to-create-a-new-wallet)  
  Welcome CTA pair: **Create a New Wallet** vs **I Already Have a Wallet**.
- Phantom Help — [Sign in to or import an existing Phantom wallet](https://help.phantom.com/articles/sign-in-to-or-import-an-existing-phantom-wallet-15079894392851)
- Rainbow — [Get started with the Rainbow app](https://rainbow.me/support/app/get-started-with-the-rainbow-app)
- U1CORE — [Web3 onboarding UX: first 90 seconds](https://www.u1core.com/web3-onboarding-ux-what-happens-in-the-first-90-seconds/)

## Icons + OTP

- Email / Google marks: quiet envelope outline + official-style 4-color Google G (inline SVG). No `@` / serif `G` tiles.
- OTP **Enter code**: **Paste** fills all 6 digits with a mock clipboard code (`482193`); Verify stays.

## Deliberately cut

CREATE/CONNECT chips, OR dividers, path badges, safety-policy essays, metadata tables, Receive/Send/QR, custom seed-phrase product UI, Wallet tab layout redesign.
