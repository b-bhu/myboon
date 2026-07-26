# Wallet Connectivity Restructure — Real-Device Checklist

Date: 2026-07-26
Source: [`2026_07_26_wallet_connectivity_restructure_test_cases.md`](./2026_07_26_wallet_connectivity_restructure_test_cases.md)
Spec: [`wallet_connectivity.md`](../specs/wallet_connectivity.md)

The 13 cases that cannot run in CI, as an executable checklist. Everything else
from the test case document is automated — see the Traceability section there.

**Run the whole list once per release candidate.** TC-POLY-003 spends real money
and is the only case that does; the rest cost only time and a throwaway account.

---

## Before you start

### Prerequisites

| Need | Cases | Notes |
|---|---|---|
| Physical Android device | all 13 | MWA is Android-only in practice. iOS is Privy-only and does not exercise the external-wallet cases at all. |
| Real Phantom install | TC-MODAL-006, TC-SESSION-004, TC-WALLET-006 | The Play Store build. An emulator with a sideloaded Phantom does not reliably reproduce the MWA handoff. |
| Live Privy account | TC-MODAL-007, TC-DORMANT-002/003/004, TC-SESSION-004/006/007, TC-POLY-003 | Email OTP or passkey. |
| **Fresh** Privy account per run | TC-DORMANT-002, TC-DORMANT-003, TC-DORMANT-004 | These assert on the state of a user who has *never* activated a chain. Reusing an account silently invalidates them — the wallet already exists from the previous run and the case passes for the wrong reason. Use a plus-addressed email (`you+run17@…`). |
| Privy dashboard access | TC-DORMANT-002, TC-DORMANT-003, TC-DORMANT-004 | The independent check. The app's own hook output is not sufficient evidence that no wallet exists. |
| Mainnet funds (small) | TC-POLY-003 | USDC on Polygon plus gas. Size it so a total loss is acceptable. |
| TalkBack | TC-A11Y-001, TC-A11Y-002, TC-A11Y-003 | Android's built-in screen reader. |

### Clean-state procedure

Several cases require a genuinely clean install. Uninstalling the app is **not**
enough on its own for the Privy-side state:

1. Uninstall the app (clears AsyncStorage, and with it `chain_activation_v1`).
2. Use a **new** Privy identity, or delete the existing user from the Privy
   dashboard. A reinstall with the same login recovers the same embedded wallets
   — that is Privy working correctly, and it defeats any case asserting no
   wallet exists.
3. For the Phantom cases, revoke the app's authorization inside Phantom
   (Settings → Connected Apps) so the MWA handoff runs fresh rather than
   silently reusing a cached authorization.

### How to inspect wallet state on device

Several cases need "does a wallet exist?" answered on evidence, not on what the
UI shows. Dormancy is *deferred creation*, so the load-bearing check is that no
wallet exists — a hidden address would pass a display check and fail the spec.

- **Privy dashboard** — the authoritative check. Find the user, read their
  linked accounts, and count wallets per chain.
- **In-app** — with a dev build attached to a debugger, read
  `useEmbeddedSolanaWallet().wallets` and `useEmbeddedEthereumWallet().wallets`.
  Zero-length arrays are the expected dormant state.
- **Storage** — `chain_activation_v1` in AsyncStorage holds
  `{"solana":bool,"evm":bool}` and nothing else. It must never contain an
  address.

---

## Group 1 — Connection modal (real device)

### TC-MODAL-006 — Cancelling the external wallet handoff mid-authorize

**Needs:** real Phantom install · **Priority:** P0 · **Spends value:** no

**Preconditions:** clean state, Phantom installed and set up, nothing active.

1. Open a Solana application (Perps/Spot).
2. On the connection sheet, tap the Solana Wallet row. Phantom opens.
3. **Sub-run A:** reject the authorization in Phantom.
4. Repeat from step 1. **Sub-run B:** background Phantom and return to myboon
   without approving.

**Expected (each sub-run):**
- [ ] Control returns to myboon; Solana is neither provisioned nor active.
- [ ] No permanent spinner and no crash — the sheet is either open or dismissed,
      and the app is usable.
- [ ] Retrying immediately re-opens Phantom, and approving then succeeds.
- [ ] No partial or ghost Solana address appears anywhere, including the Wallet
      section on Home.

---

### TC-MODAL-007 — Cancelling Privy login mid-flow

**Needs:** live Privy account · **Priority:** P0 · **Spends value:** no

**Preconditions:** clean state, nothing active.

1. Open Polymarket (Predict). The connection sheet appears with email and
   passkey only — no wallet row.
2. **Sub-run A:** begin email login, request the OTP, never enter the code.
      Dismiss the sheet.
3. **Sub-run B:** begin passkey login and dismiss the system passkey sheet.

**Expected (each sub-run):**
- [ ] No Privy session is established.
- [ ] No wallet is created on any chain — confirm in the Privy dashboard that
      the user either does not exist or has zero wallets.
- [ ] Predict still reports an unsatisfied requirement and does not render a
      partially-enabled trading UI.
- [ ] Retrying the login from the same sheet succeeds with no app restart.

> **Note — divergence from the source document.** TC-MODAL-007 describes "the
> Privy-only modal" as having one option. The shipped sheet renders **two** rows
> on EVM (email and passkey), because Privy is offered as two auth methods. The
> structural requirement — no external-wallet row on EVM — holds. See
> Divergence D1 in the test case document.

---

## Group 2 — Dormancy (real device, fresh account each)

> These three are the heart of the restructure. They prove a dormant chain has
> **no wallet in existence**, not merely a hidden one. Each needs a fresh Privy
> account; reusing one invalidates the result silently.

### TC-DORMANT-002 — A fresh Privy login provisions no wallet on any chain

**Needs:** fresh Privy account · **Priority:** P0 · **Spends value:** no

**Preconditions:** clean install, brand-new Privy identity.

1. Log into Privy from a surface that does **not** enter a chain-requiring
   application — the Home Wallet section's nothing-active state.
2. Immediately after login completes, inspect both embedded wallet hooks.
3. Independently check the Privy dashboard for that user id.

**Expected:**
- [ ] `useEmbeddedEthereumWallet().wallets` is empty.
- [ ] `useEmbeddedSolanaWallet().wallets` is empty.
- [ ] The Privy dashboard shows **no wallet on either chain** for this user.
- [ ] No EVM or Solana address appears in app state, AsyncStorage, or logs.
- [ ] `chain_activation_v1` is absent or `{"solana":false,"evm":false}`.

---

### TC-DORMANT-003 — Logging in via Polymarket creates EVM only

**Needs:** fresh Privy account · **Priority:** P0 · **Spends value:** no

**Preconditions:** clean install, brand-new Privy identity, no prior session.

1. Open Polymarket. Complete the Privy login from the connection sheet.
2. Once Predict is usable, inspect both embedded wallet hooks.
3. Check the Privy dashboard for the user's wallet list.

**Expected:**
- [ ] `useEmbeddedEthereumWallet()` reports exactly **one** wallet with a valid
      `0x` address.
- [ ] `useEmbeddedSolanaWallet()` reports **zero** wallets — not a wallet with a
      hidden address.
- [ ] The Privy dashboard confirms one Ethereum wallet and no Solana wallet.
- [ ] The Home Wallet section lists Polygon and nothing else.
- [ ] Solana `create()` was never invoked (check debugger logs, not just the
      empty array — an empty array with a create call would mean a race, not
      dormancy).

> **Note — divergence.** The source case says Polymarket login yields an active
> **Solana** chain in some earlier readings; #250 moved Predict onto a real EVM
> signer, so EVM is correct. Both Predict detail screens call
> `useConnectionSheet('evm')`. See Divergence D2.

---

### TC-DORMANT-004 — A dormant chain has no address that can receive funds

**Needs:** fresh Privy account · **Priority:** P0 · **Type:** Security · **Spends value:** no

**Preconditions:** the end state of TC-DORMANT-003 (EVM active, Solana never
activated). Continue in the same session rather than starting over.

Search every place a Solana address could surface or be recovered:

- [ ] Home Wallet section — no Solana row.
- [ ] Account drawer — no Solana address, no export control.
- [ ] AsyncStorage dump — no base58 address in any key.
- [ ] Secure store — no Solana entry.
- [ ] Any share/copy affordance in the app.
- [ ] The Privy API response for this user id.

**Expected:**
- [ ] **No Solana address is retrievable from any of these.** There is nothing a
      user or third party could send funds to.

> This is the load-bearing consequence of deferred creation. If any Solana
> address is recoverable while Solana is dormant, dormancy has been implemented
> as hidden display and the implementation is wrong **regardless of what the UI
> shows**. Fail the release on this one.

---

### TC-DORMANT-005 — Activation provisions the chain via create()

**Needs:** live Privy account · **Priority:** P0 · **Spends value:** no

**Preconditions:** the end state of TC-DORMANT-003.

1. Enter a Solana application (Perps/Spot).
2. Complete the prompt by choosing email or passkey (the Privy path).
3. Inspect `useEmbeddedSolanaWallet()`.

**Expected:**
- [ ] `create()` was called **exactly once** on the Solana embedded wallet.
- [ ] The hook now reports exactly one Solana wallet with a valid base58 address.
- [ ] The EVM wallet is unchanged — same address as before, still active.
- [ ] Both chains now appear in the Home Wallet section.
- [ ] Backgrounding and returning does not create a second wallet.

---

## Group 3 — Session scoping and coexistence

### TC-SESSION-004 — External-Solana user hitting an EVM app is prompted for Privy only

**Needs:** real Phantom install + live Privy account · **Priority:** P0 · **Spends value:** no

**Preconditions:** clean state. Phantom connected for Solana; **not** logged into
Privy.

1. Connect Phantom for Solana from the Home Wallet section. Confirm the Solana
   row shows the Phantom address.
2. Open Polymarket.

**Expected:**
- [ ] The connection sheet offers **email and passkey only** — no wallet row.
- [ ] The Solana connection is visibly unaffected during and after the flow: the
      Wallet section still shows the Phantom address.
- [ ] Solana applications still resolve with no prompt.
- [ ] Completing the Privy login makes Predict usable — the flow does not
      dead-end.
- [ ] After login, **both** rows are present: Phantom's Solana address and the
      Privy Polygon address.

> This is the deliberate cost the PRD accepts: an EVM app requires a Privy login
> even for a user who already has a wallet, because MWA cannot reach EVM.

---

### TC-SESSION-006 — What survives an app restart

**Needs:** live Privy account · **Priority:** P1 · **Spends value:** no

1. Activate EVM via Polymarket. Confirm it is active.
2. Force-quit the app (swipe from recents; do not just background it).
3. Reopen and open Polymarket.

**Expected:**
- [ ] EVM is still active; Polymarket resolves with **no re-prompt**.
- [ ] The EVM address is identical to before the restart.
- [ ] Chains dormant before the restart are still dormant and still have no
      wallet.
- [ ] Repeat once more with a device reboot rather than a force-quit — same
      result.

> The persistence mechanism itself (`chain_activation_v1` written to
> AsyncStorage, re-hydrated on a cold module load) is covered by automated tests
> that simulate process death. This case confirms the real device behaves the
> same way, including that the Privy session survives alongside it.

---

### TC-SESSION-007 — Logging out clears the active set

**Needs:** live Privy account · **Priority:** P1 · **Spends value:** no

**Preconditions:** EVM active via Privy.

1. Log out of Privy from the account drawer.
2. Reopen Polymarket.
3. Log back into the **same** Privy account.

**Expected:**
- [ ] The active set is empty; the Wallet section shows its nothing-active state.
- [ ] Polymarket presents the connection sheet again.
- [ ] `chain_activation_v1` is `{"solana":false,"evm":false}` after logout.
- [ ] Logging back in restores the **same** EVM address — no second wallet is
      created for the same user. Confirm in the Privy dashboard that the user
      still has exactly one Ethereum wallet.

---

### TC-WALLET-006 — Disconnecting external Solana deactivates only Solana

**Needs:** real Phantom install · **Priority:** P0 · **Spends value:** no

**Preconditions:** external Solana wallet connected **and** Privy EVM active
(the end state of TC-SESSION-004).

1. Disconnect Solana from the Home Wallet section.
2. Open an EVM application, then a Solana application.

**Expected:**
- [ ] Solana leaves the active set; its row disappears.
- [ ] EVM is untouched — still active, same address, resolves with no prompt.
- [ ] The Solana application now presents the sheet **with** the wallet row
      (external + email + passkey).
- [ ] Reconnecting Phantom restores the same address.

---

## Group 4 — Polymarket

### TC-POLY-002 — EIP-712 signature verifies to the expected address

**Needs:** live Privy account · **Priority:** P0 · **Spends value:** no

> Marked harness-automatable in the source document with a confirming device
> pass. It is listed here because the harness path is not built — see Not-done
> in the traceability update.

1. Resolve a signer for `POLYMARKET_REQUIREMENT` and enable Polymarket trading.
2. Capture the EIP-712 signature for a CLOB order and for a deposit-wallet
   batch, one each.
3. Recover the signer address from each signature with an independent library
   (e.g. `ethers.verifyTypedData`).

**Expected:**
- [ ] The recovered address equals `signer.descriptor.address` exactly, for both
      payloads.
- [ ] The domain separator carries `chainId` 137.
- [ ] A payload signed for a different `chainId` does **not** verify — proving
      the chain binding is real rather than incidental.

---

### TC-POLY-003 — Full Polymarket lifecycle

**Needs:** live Privy account + **mainnet funds** · **Priority:** P0 · **Spends value: YES**

> The only case in this suite that spends real value. Run once per release
> candidate, at the smallest workable size.

**Preconditions:** fresh Privy account, small USDC balance on Polygon.

1. Open Polymarket, complete login, enable trading.
2. Deposit a small amount.
3. Buy a position.
4. Sell it.
5. Withdraw.

**Expected:**
- [ ] Every step completes, with signatures produced by the Privy EVM signer.
- [ ] The deposit wallet address is derived from the Privy EOA and is **stable
      across the whole lifecycle** — it does not change between enable and
      withdraw.
- [ ] Funds arrive at the withdrawal destination.
- [ ] No step asks the user to re-sign for a "stale signature" reason — with an
      embedded wallet there is no per-session signature to expire.
- [ ] Record the actual amounts and the deposit wallet address in the run log.

---

## Group 5 — Accessibility (TalkBack)

### TC-A11Y-001 — Connection sheet options are announced as actionable

**Needs:** TalkBack · **Priority:** P1 · **Spends value:** no

1. With TalkBack on, open the connection sheet for a **Solana** requirement.
2. Repeat for an **EVM** requirement.

**Expected:**
- [ ] Each available option is announced as a button, with a label naming what
      it does.
- [ ] In the EVM case the screen reader encounters the Privy options and **no
      announcement of a hidden or disabled wallet row**.
- [ ] The sheet is announced as modal and focus is trapped inside it.

---

### TC-A11Y-002 — The sheet is dismissible without a gesture

**Needs:** TalkBack · **Priority:** P1 · **Spends value:** no

1. With the sheet open and TalkBack on, dismiss it using only screen-reader
   navigation and the explicit close control.

**Expected:**
- [ ] An explicitly labelled close control is reachable and works — dismissal
      does not depend on a backdrop tap, which assistive tech cannot reliably
      reach.
- [ ] After dismissal, focus returns to the element that opened the sheet.

---

### TC-A11Y-003 — Wallet states are announced distinctly

**Needs:** TalkBack · **Priority:** P1 · **Spends value:** no

1. With TalkBack on, open the Home Wallet section with nothing active, then with
   a chain active.

**Expected:**
- [ ] The nothing-active state announces the connection prompt and its action,
      not an empty screen.
- [ ] The active state announces each chain row with the chain name, address,
      and balance.
- [ ] The address is announced in a way a user can act on, not as a run-on
      character string.
- [ ] An unresolved balance is announced **as unresolved**, not skipped
      silently. This matters on EVM today, which has no balance source and
      always renders the unavailable marker (#261).

---

## Run log

Copy this table per release candidate.

| Case | Needs | Result | Date | Notes |
|---|---|---|---|---|
| TC-MODAL-006 | Phantom | | | |
| TC-MODAL-007 | Privy | | | |
| TC-DORMANT-002 | Privy (fresh) | | | |
| TC-DORMANT-003 | Privy (fresh) | | | |
| TC-DORMANT-004 | Privy (fresh) | | | |
| TC-DORMANT-005 | Privy | | | |
| TC-SESSION-004 | Phantom + Privy | | | |
| TC-SESSION-006 | Privy | | | |
| TC-SESSION-007 | Privy | | | |
| TC-WALLET-006 | Phantom | | | |
| TC-POLY-002 | Privy | | | |
| TC-POLY-003 | Privy + **funds** | | | |
| TC-A11Y-001 | TalkBack | | | |
| TC-A11Y-002 | TalkBack | | | |
| TC-A11Y-003 | TalkBack | | | |

Record failures here rather than deleting rows — this file is the running record
of what has actually been verified on hardware.
