# Wallet Connectivity Restructure — Test Cases

Date: 2026-07-26
Source PRD: [`2026_07_26_wallet_connectivity_restructure_PRD.md`](../PRDs/2026_07_26_wallet_connectivity_restructure_PRD.md)
Source spec: [`wallet_connectivity.md`](../specs/wallet_connectivity.md)
Scope: **full restructure** — the PRD's 14 acceptance criteria *and* the durable
spec's behavioral model. That means resolution order, per-chain session scoping,
activation stickiness, connection-modal option filtering, dormancy as deferred
creation, the Wallet destination's two states, the security deletions, the E2E
build fence, and the drawer entry-point removal. myboon has **zero users**, so
there are deliberately **no migration, fund-sweep, or legacy-user cases** in this
document — if you find yourself writing one, it is out of scope. Portfolio depth
beyond address + balance per active chain (positions, transaction history) is a
follow-on and is not covered here; see PRD open decision 1 and the Ambiguities
section.

## How to read this document

- **TC ID** groups: `RESOLVE` (resolution order, requirement satisfaction,
  signer descriptors), `MODAL` (shared connection modal and option filtering),
  `DORMANT` (deferred creation and activation), `WALLET` (Wallet destination's
  two states), `SESSION` (per-chain session sharing and activation stickiness),
  `SEC` (security deletions, as negative cases), `POLY` (Polymarket as first
  consumer), `BUILD` (E2E build fence), `DRAWER` (drawer entry-point removal),
  `A11Y` (accessibility).
- **Priority** P0 = blocks ship, P1 = should pass before ship, P2 = polish/edge
  case.
- **Type** names the test's character: Functional, Unit, Integration, Security,
  Regression, State/UI, Build, Accessibility.
- **Execution** is stated on every case and is one of:
  - `Automatable` — runs in CI with no human and no hardware. Unit, build, and
    static-analysis cases.
  - `Automatable (harness)` — runs unattended but needs the Detox/Playwright E2E
    harness, an emulator, or mocked Privy/MWA transports.
  - `Real device` — needs a physical Android device. Sub-qualified inline with
    what it needs: a real Phantom install, a live Privy account, or mainnet
    funds.
- **Status** is Not Run for all cases; update per test cycle.
- Cases that depend on an unresolved PRD open decision carry an inline
  **Assumes:** line naming the reading they were written against. Every one of
  those is also listed under Open Questions and Ambiguities.

---

## 1. Resolution and Signer Contract (`RESOLVE`)

### TC-RESOLVE-001: Active chain resolves ready with no prompt

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Seed resolver state with `evm` active and provisioned (a Privy embedded
   Ethereum wallet exists, address known).
2. Call `useChainSigner(POLYMARKET_REQUIREMENT)`.

**Expected**
- `status === 'ready'`.
- `signer` is non-null and its `descriptor.address` equals the seeded EVM
  address.
- `reason === null`.
- No connection modal is mounted and no `connect()` call is required to reach
  `ready` — the transition to `ready` occurs on the first render pass.

### TC-RESOLVE-002: Provisioned-but-dormant chain activates then resolves ready

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Seed resolver state with `solana` provisioned (embedded Solana wallet exists)
   but **not** active.
2. Call `useChainSigner` with a `solana` requirement.
3. Observe the status sequence to settle.

**Expected**
- Status passes through `preparing` and settles at `ready` — it never reports
  `needs_connection` for a chain that is already provisioned.
- The chain is marked active as a side effect of resolution.
- No connection modal is presented at any point in the sequence.
- `create()` is **not** called on the embedded wallet hook — the wallet already
  exists and is not re-provisioned.

### TC-RESOLVE-003: Neither active nor provisioned yields needs_connection

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Seed resolver state with no wallet on any chain and no active chain.
2. Call `useChainSigner` with a `solana` requirement.

**Expected**
- `status === 'needs_connection'`.
- `signer === null`.
- `connect` is a callable function.
- Nothing is provisioned as a side effect of merely *asking* — no `create()`
  call and no MWA `authorize` call fires until `connect()` is invoked.

### TC-RESOLVE-004: Unsatisfiable requirement returns unsupported with a reason, never throws

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Construct a requirement that no backend can satisfy — for example
   `{ chain: 'evm', needsRawTransaction: true }` if the Privy EVM backend cannot
   send raw transactions, or a requirement naming a chain with no registered
   backend at all.
2. Call `useChainSigner` inside a test that fails on any thrown error or
   unhandled rejection.

**Expected**
- `status === 'unsupported'`.
- `signer === null`.
- `reason` is a non-empty string that names the chain or capability that cannot
  be satisfied, and reads as a sentence a user could be shown — not an
  identifier, stack frame, or empty string.
- No exception is thrown and no promise rejects. The test asserts this
  explicitly, not merely by not crashing.

### TC-RESOLVE-005: Resolver returns exactly one of the four statuses

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Enumerate the resolver state matrix: {chain active, provisioned-only,
   neither} × {backend can satisfy, backend cannot satisfy} × {solana, evm}.
2. Call `useChainSigner` for each cell and record the settled status.

**Expected**
- Every cell settles at exactly one of `ready`, `needs_connection`, `preparing`,
  `unsupported`. No cell settles at `undefined`, at a fifth value, or oscillates
  between two.
- `preparing` is never a terminal state — every cell that passes through it
  settles at `ready` or an error status within the test timeout.
- The `unsupported` branch wins over `needs_connection` when no backend can
  satisfy the requirement: the user is never offered a connection flow that
  cannot possibly succeed.

### TC-RESOLVE-006: SignerDescriptor flags are correct for the Privy embedded backend

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Resolve a signer for `POLYMARKET_REQUIREMENT` against the Privy embedded
   backend.
2. Read `signer.descriptor`.

**Expected**
- `backend === 'privy_embedded'`, `chain === 'evm'`, `chainId === 137`.
- `canSignTypedData === true` — Polymarket's requirement declares
  `needsTypedData: true`, so a descriptor reporting false here must have caused
  the resolver to return `unsupported` instead.
- `survivesReinstall === true` and `survivesDeviceLoss === true` — Privy
  embedded wallets are recoverable across devices per the spec's "Privy —
  universal" section.
- `address` is a checksummed 0x-prefixed 20-byte address.

### TC-RESOLVE-007: SignerDescriptor flags are correct for the external MWA backend

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Resolve a signer for a `solana` requirement against a mocked MWA-authorized
   external wallet.
2. Read `signer.descriptor`.

**Expected**
- `backend === 'external_mwa'`, `chain === 'solana'`, `chainId` is absent or
  undefined (the field is EVM-only per the `ChainRequirement` type).
- `survivesReinstall === true` and `survivesDeviceLoss === true` — the key lives
  in the user's own external wallet, not in myboon. A descriptor claiming
  otherwise would make features warn spuriously.
- `address` is a valid base58 Solana address.

### TC-RESOLVE-008: A second EVM application needs only a new descriptor

**Priority:** P0 · **Type:** Unit / Regression · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Record a hash or diff baseline of the resolver module and the connection
   modal module.
2. Add a second requirement descriptor, e.g.
   `{ applicationId: 'hypothetical_evm_app', chain: 'evm', chainId: 137,
   needsTypedData: true, needsRawTransaction: false, fundsAtRisk: 'session' }`,
   in the descriptor file only.
3. Call `useChainSigner` with it and run the full resolver suite.

**Expected**
- The new requirement resolves through the same four branches with the same
  results as `POLYMARKET_REQUIREMENT` (same chain, same backend).
- The resolver module and the modal module are byte-identical to the baseline —
  the new application required zero edits outside the descriptor file.
- No `switch` or `if` on `applicationId` exists in the resolver. A static check
  greps the resolver source for `applicationId ===` and any string literal
  matching a known application id and finds no hits.

### TC-RESOLVE-009: No module-level mutable wallet singleton exists

**Priority:** P0 · **Type:** Security / Regression · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Run a repo-wide static scan over `apps/hybrid-expo/` and `packages/` for
   module-scope mutable wallet or signer bindings — `let`/`var` at module top
   level whose identifier or type mentions wallet, signer, or key.
2. Specifically assert that `activeEvmWallet`, `getActiveEvmWallet`,
   `requireActiveEvmWallet`, and `clearActiveEvmWallet` do not appear anywhere in
   the repo.

**Expected**
- Zero hits for all four named symbols.
- Zero module-scope mutable wallet or signer bindings. Every signer is obtained
  through `useChainSigner` and scoped to the component that asked.
- This check runs in CI so a reintroduction fails the build, not just this
  cycle's manual pass.

### TC-RESOLVE-010: Requirement declaring a capability the backend lacks does not silently downgrade

**Priority:** P1 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Construct a requirement with `needsRawTransaction: true` on `evm`.
2. Resolve it against the Privy embedded backend, whose current adapter signs
   EIP-712 locally and does not send raw transactions
   (`useWallet.native.ts:54` sets `signAndSendTransaction: null` for the Privy
   path today).

**Expected**
- The resolver returns `unsupported` with a reason naming the missing
  capability.
- It does **not** return `ready` with a signer whose `canSendTransaction` is
  false. A caller that trusted `ready` and then called a missing method would
  fail at signing time instead of at resolution time, which is the failure this
  case exists to prevent.

### TC-RESOLVE-011: Resolution is idempotent under repeated calls

**Priority:** P1 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. From a clean state, mount three components that each call `useChainSigner`
   with the same `evm` requirement, simultaneously.
2. Drive them all to `ready`.

**Expected**
- Exactly one embedded wallet `create()` call is made across all three
  consumers, not three.
- All three receive a signer with the same address.
- No duplicate activation events are recorded for the chain.

---

## 2. Connection Modal and Option Filtering (`MODAL`)

### TC-MODAL-001: A solana requirement yields two options

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Compute the modal's available-option list for a requirement with
   `chain: 'solana'`.

**Expected**
- The list has exactly two entries: an external-wallet option and a Privy
  option.
- Both entries are enabled and selectable — neither renders as disabled with an
  explanatory tooltip. An unavailable option is absent from the list, not
  present and greyed.

### TC-MODAL-002: An evm requirement yields exactly one option

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Compute the modal's available-option list for `POLYMARKET_REQUIREMENT`
   (`chain: 'evm'`).

**Expected**
- The list has exactly one entry: the Privy option.
- The external-wallet option is **absent from the list**, not present-and-hidden
  and not present-and-disabled.

### TC-MODAL-003: The single-option EVM modal is the same component as the two-option one

**Priority:** P0 · **Type:** Unit / Regression · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Render the modal for a `solana` requirement and capture the rendered
   component tree.
2. Render it for an `evm` requirement and capture the tree.
3. Compare the component identity of the modal root and of the list container.

**Expected**
- Both renders use the same modal component and the same list container — the
  EVM case differs only in the length of the option array.
- No component exists in the codebase whose name or path implies a
  chain-specific or Privy-branded connection screen (a grep for a second modal
  component under the connection module returns one modal, not two).

### TC-MODAL-004: Adding a hypothetical external EVM option requires only an availability-rule change

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Baseline the modal component file and the option-list rendering code.
2. In the availability rule only, flip external-wallet support on for `evm`.
3. Recompute the option list for `POLYMARKET_REQUIREMENT` and re-render.

**Expected**
- The list now has two entries and the modal renders both without any change to
  the modal component, the list container, or the resolver.
- The modal component file and rendering code are byte-identical to the
  baseline.
- Revert the flip and confirm the list returns to one entry — the test leaves no
  residue.

### TC-MODAL-005: Cancelling the modal mid-flow leaves state untouched

**Priority:** P0 · **Type:** Functional · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. From a state with nothing provisioned and nothing active, enter an
   application that requires `solana`. The modal appears.
2. Dismiss it without choosing an option — via the back gesture, the backdrop
   tap, and the explicit close control, once each (three sub-runs).
3. Inspect resolver state and Privy/MWA state after each dismissal.

**Expected**
- No wallet is created on any chain. `create()` was not called.
- No chain is marked active.
- `useChainSigner` for the same requirement still returns `needs_connection`,
  not `preparing` or a wedged state.
- Re-entering the same application presents the modal again cleanly, with the
  same option list and no residual selection or spinner from the cancelled run.
- All three dismissal routes produce identical state.

### TC-MODAL-006: Cancelling the external wallet handoff mid-authorize

**Priority:** P0 · **Type:** Functional · **Execution:** Real device — needs a real Phantom install · **Status:** Not Run

**Steps**
1. With nothing active, enter a Solana application and choose "Connect an
   external wallet".
2. Phantom opens. Reject the authorization request (or background Phantom and
   return to myboon without approving).

**Expected**
- Control returns to myboon with Solana neither provisioned nor active.
- The modal either remains open or is dismissed, but the app is not left on a
  permanent spinner and does not crash.
- A retry is possible immediately — choosing the external wallet option again
  re-opens Phantom and a subsequent approval succeeds.
- No partial or ghost Solana address is written to any surface, including the
  Wallet destination.

### TC-MODAL-007: Cancelling Privy login mid-flow

**Priority:** P0 · **Type:** Functional · **Execution:** Real device — needs a live Privy account · **Status:** Not Run

**Steps**
1. With nothing active, enter Polymarket. The Privy-only modal appears.
2. Begin the Privy login (email OTP or passkey) and abandon it — dismiss the
   passkey sheet, or request the OTP and never enter the code.

**Expected**
- No Privy session is established.
- No wallet is created on any chain.
- Polymarket's requirement still reports `needs_connection`; the app does not
  present a partially-enabled Predict UI.
- Retrying the login from the same modal succeeds without an app restart.

### TC-MODAL-008: Modal is not reachable from inside an application's own UI

**Priority:** P1 · **Type:** Regression · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Grep the feature directories (`features/predict`, `features/perps`, and any
   other application module) for connection UI — imports of MWA `connect`,
   Privy login methods, or wallet-option lists.

**Expected**
- No application module renders its own connect button, wallet picker, or login
  form. Applications trigger the shared modal via the resolver's `connect()` and
  nothing else, per the spec's "Applications do not own connection UI."

---

## 3. Dormancy and Deferred Creation (`DORMANT`)

> These cases test **absence of creation**, not absence of display. A passing
> case here proves no key material and no address exist for the dormant chain.
> A case that only proves the address is not rendered has not tested dormancy
> and must be rewritten.

### TC-DORMANT-001: Provider config creates no wallet on any chain at login

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Read the `config.embedded` block passed to `BasePrivyProvider` in
   `apps/hybrid-expo/providers/PrivyProvider.tsx`.
2. Assert on the `createOnLogin` value for each configured chain.

**Expected**
- Both `embedded.solana` and `embedded.ethereum` are present (the PRD's item 1
  adds `ethereum`).
- Neither chain has `createOnLogin: 'all-users'`. The pre-restructure value at
  `PrivyProvider.tsx:15` was `'all-users'` for Solana; this case fails if that
  value survives on either chain.
- `createOnLogin` is set to the off/deferred value for both chains, so no chain
  is created eagerly at login.

### TC-DORMANT-002: A fresh Privy login provisions no wallet on any chain

**Priority:** P0 · **Type:** Integration · **Execution:** Real device — needs a live Privy account (a fresh one per run) · **Status:** Not Run

**Steps**
1. On a clean install, log into Privy from a surface that does **not** enter any
   chain-requiring application — e.g. the Wallet destination's nothing-active
   state, or the app's own login entry point.
2. Immediately after login completes, query
   `useEmbeddedEthereumWallet()` and `useEmbeddedSolanaWallet()` for their
   wallet arrays.
3. Independently confirm against the Privy dashboard or API for that user id.

**Expected**
- Both hooks report zero embedded wallets. Not "a wallet with a hidden address"
  — zero wallets.
- The Privy dashboard shows no wallet on either chain for that user.
- No EVM address and no Solana address exists anywhere in app state, storage, or
  logs for this user at this point.

### TC-DORMANT-003: Logging in via Polymarket creates EVM only, and Solana does not exist

**Priority:** P0 · **Type:** Integration · **Execution:** Real device — needs a live Privy account (fresh) · **Status:** Not Run

**Steps**
1. On a clean install with no prior session, open Polymarket. Complete the
   Privy login from the Privy-only modal.
2. Once Predict is usable, query both embedded wallet hooks.
3. Query the Privy dashboard/API for the user's wallet list.

**Expected**
- `useEmbeddedEthereumWallet()` reports exactly one wallet with a valid address.
- `useEmbeddedSolanaWallet()` reports **zero wallets**. There is no Solana
  address in existence for this user — not hidden, not filtered from display,
  not present in storage or the Privy dashboard.
- The Wallet destination lists EVM and nothing else.
- Solana `create()` was never invoked. Instrument or assert on the call to
  confirm this, rather than inferring it from the empty wallet list alone.

### TC-DORMANT-004: A dormant chain has no address that can receive funds

**Priority:** P0 · **Type:** Security · **Execution:** Real device — needs a live Privy account (fresh) · **Status:** Not Run

**Steps**
1. Reach the state of TC-DORMANT-003 (EVM active, Solana never activated).
2. Search every place an address could surface or be recovered: app state dumps,
   AsyncStorage, secure store, the Wallet destination, the drawer, any share or
   copy affordance, and the Privy API response for the user.

**Expected**
- No Solana address is retrievable from any of these. There is nothing a user or
  a third party could send funds to.
- This is the load-bearing consequence of deferred creation. If any Solana
  address is recoverable while Solana is dormant, dormancy has been implemented
  as hidden display and the implementation is wrong regardless of what the UI
  shows.

### TC-DORMANT-005: Activation provisions the chain via create()

**Priority:** P0 · **Type:** Integration · **Execution:** Automatable (harness) with a mocked Privy transport; confirm once on **Real device — live Privy account** · **Status:** Not Run

**Steps**
1. From the TC-DORMANT-003 state, enter a Solana application.
2. Complete the prompt by choosing the Privy option.
3. Query `useEmbeddedSolanaWallet()`.

**Expected**
- `create()` was called exactly once on the Solana embedded wallet hook.
- The hook now reports exactly one Solana wallet with a valid base58 address.
- The EVM wallet is unchanged — same address as before, still active.
- Both chains now appear in the Wallet destination.

### TC-DORMANT-006: Activation interrupted before create() completes

**Priority:** P0 · **Type:** Functional / State · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. From the TC-DORMANT-003 state, enter a Solana application and begin
   activation.
2. Interrupt before `create()` resolves — force the create call to reject, and
   in a second sub-run, background the app mid-create and return.

**Expected**
- On rejection: the chain is **not** marked active, `useChainSigner` returns to
  `needs_connection` (not a stuck `preparing`), and a retry succeeds.
- On backgrounding: on return, the chain is either fully provisioned-and-active
  or fully neither. There is no state where the chain is marked active with no
  wallet behind it, and no state where a wallet exists but the chain is dormant
  and unsurfaced.
- Exactly zero or exactly one Solana wallet exists afterward — never two from a
  duplicated create.

### TC-DORMANT-007: Funded-dormant-chain safety net surfaces a non-zero balance

**Priority:** P0 · **Type:** Functional · **Execution:** Automatable (harness) with an injected provisioned-dormant chain and a stubbed non-zero balance · **Status:** Not Run

**Steps**
1. Force the state the safety net exists for: inject a provisioned-but-dormant
   chain (bypassing deferred creation) and stub its balance as non-zero.
2. Open the Wallet destination.

**Expected**
- The dormant chain is surfaced with its balance and an activation prompt — it
  is not concealed. Per the spec, concealing a funded address is a correctness
  failure while displaying an unrequested empty one is only a UX cost.
- Accepting the prompt activates the chain and it joins the normal active list.

### TC-DORMANT-008: Funded-dormant safety net does not fire for a zero-balance dormant chain

**Priority:** P1 · **Type:** Functional · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. Inject a provisioned-but-dormant chain with a zero balance.
2. Open the Wallet destination.

**Expected**
- The chain is **not** surfaced and no activation prompt appears. The safety net
  is balance-gated; surfacing every dormant chain would defeat dormancy.
- Boundary: repeat with the smallest representable non-zero balance (1 lamport /
  1 wei) and confirm it **does** surface. The threshold is "non-zero", not "above
  a dust floor", unless the implementation documents a floor — see Ambiguities.

### TC-DORMANT-009: The safety net is unreachable under normal operation

**Priority:** P1 · **Type:** Regression · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. Run the full normal-path suite (TC-DORMANT-002 through 006, TC-SESSION-*)
   with an assertion hook on the funded-dormant code path.

**Expected**
- The funded-dormant branch is never entered during any normal flow. With
  deferred creation there is no way to reach a provisioned-but-dormant chain.
- If it fires outside the injected TC-DORMANT-007/008 scenarios, that is a
  provisioning bug and this case fails — per the PRD, "if it ever fires we have a
  provisioning bug."

---

## 4. Session Scoping and Activation Stickiness (`SESSION`)

### TC-SESSION-001: Activation is sticky within a session

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Activate `solana` through application A.
2. Enter application B, which declares a `solana` requirement.
3. Enter application A again.

**Expected**
- Application B resolves straight to `ready` with no modal and no prompt.
- Re-entering A likewise resolves to `ready` with no prompt.
- Both applications receive a signer with the same address — the connection is
  shared, not duplicated per application.
- The activation record is keyed by chain, not by `applicationId`. A static or
  state assertion confirms the active set contains `'solana'` and no
  application-scoped entries.

### TC-SESSION-002: Activation on one chain does not activate another

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. From a clean state, activate `evm` only.
2. Inspect the active-chain set and the provisioned-wallet set.

**Expected**
- `evm` is active and provisioned. `solana` is neither.
- Entering a Solana application at this point produces a prompt — activation
  does not leak across chains.

### TC-SESSION-003: External Solana connection is untouched by an EVM activation

**Priority:** P0 · **Type:** Integration · **Execution:** Automatable (harness) with mocked MWA; confirm once on **Real device — needs a real Phantom install** · **Status:** Not Run

**Steps**
1. Connect an external Solana wallet via MWA. Record its address and the active
   Solana signer's `descriptor.backend`.
2. Without disconnecting, open Polymarket and complete the Privy login to
   activate EVM.
3. Return to a Solana application.

**Expected**
- The Solana signer still resolves to the **same external address** with
  `backend === 'external_mwa'`. It has not been replaced by a Privy embedded
  Solana wallet.
- No Solana embedded wallet was created by the Privy login — Solana was already
  satisfied, and `createOnLogin` is off, so `create()` was not called for Solana.
- The Solana application resolves to `ready` with no prompt.
- Both an external Solana connection and a Privy EVM wallet coexist in the same
  session; the Wallet destination lists both chains with their respective
  addresses.

> This case guards the pre-restructure precedence in `useWallet.native.ts:41`,
> where `privy.isPrivyUser` short-circuits and hides any MWA account. Under the
> new per-chain model that precedence must not apply — a Privy login must not
> displace an existing external Solana connection. See Ambiguities.

### TC-SESSION-004: A user with an external Solana wallet hitting an EVM app is prompted for Privy only

**Priority:** P0 · **Type:** Functional · **Execution:** Real device — needs a real Phantom install and a live Privy account · **Status:** Not Run

**Steps**
1. Connect Phantom for Solana. Do not log into Privy.
2. Open Polymarket.

**Expected**
- A modal appears with exactly one option: Privy. Phantom is not offered, per
  TC-MODAL-002.
- The Solana connection is visibly unaffected during and after the flow — the
  Wallet destination still shows the Phantom address, and Solana applications
  still resolve without a prompt.
- This is the deliberate cost the PRD accepts: the user must log into Privy for
  EVM. Confirm the flow completes and Predict becomes usable, rather than dead-
  ending.

### TC-SESSION-005: Activation does not reverse implicitly

**Priority:** P1 · **Type:** Functional · **Execution:** Automatable (harness) · **Status:** Not Run

**Assumes:** PRD open decision 2 resolved as its own recommendation — a
Privy-provisioned chain **cannot** be deactivated in v1. If the team decides
otherwise, this case must be rewritten.

**Steps**
1. Activate both `solana` and `evm`.
2. Navigate away from every chain-requiring application, background and foreground
   the app, and open the Wallet destination.

**Expected**
- Both chains remain active. Activation is one-way within the session lifecycle
  per the spec.
- No deactivation control is offered for a Privy-provisioned chain in the Wallet
  destination in v1.
- Disconnecting an **external** wallet is still offered and does deactivate that
  chain — see TC-WALLET-006.

### TC-SESSION-006: Session scoping — what survives an app restart

**Priority:** P1 · **Type:** Functional · **Execution:** Real device — needs a live Privy account · **Status:** Not Run

**Assumes:** "session-scoped" means the Privy authenticated session, so a
Privy user who reopens the app with a valid session finds their previously
active chains still active. The spec says activation is one-way "within a
session lifecycle" without defining the lifecycle boundary — see Ambiguities.

**Steps**
1. Activate `evm` via Polymarket. Confirm it is active.
2. Force-quit and reopen the app with the Privy session still valid.
3. Open Polymarket.

**Expected**
- EVM is still active; Polymarket resolves to `ready` with no re-prompt.
- The EVM wallet address is identical to before the restart (Privy embedded
  wallets survive reinstall, so they certainly survive a restart).
- Chains that were dormant before the restart are still dormant and still have
  no wallet.

### TC-SESSION-007: Logging out clears the active set

**Priority:** P1 · **Type:** Functional · **Execution:** Real device — needs a live Privy account · **Status:** Not Run

**Steps**
1. With `evm` active via Privy, log out of Privy from the Wallet destination.
2. Reopen Polymarket.

**Expected**
- The active set is empty; the Wallet destination shows its nothing-active
  state.
- Polymarket resolves to `needs_connection` and presents the modal.
- Logging back into the same Privy account restores the **same** EVM address —
  no second wallet is created for the same user.

---

## 5. The Wallet Destination (`WALLET`)

### TC-WALLET-001: Wallet is a top-level destination

**Priority:** P0 · **Type:** Functional · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. Open the home screen and inspect the top-level destinations.

**Expected**
- Wallet is present as a peer of Feed and Apps/Markets, reachable in one tap
  from the home screen — not nested inside a drawer, a settings screen, or an
  application.

### TC-WALLET-002: Nothing-active state is a connection manager

**Priority:** P0 · **Type:** State / UI · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. With no chain active and nothing provisioned, open Wallet.

**Expected**
- The screen presents a connection action and copy explaining what connecting
  does.
- No address, no balance, and no `$0` renders. Per the spec's dormancy rule
  there is nothing to show, and per the prior beta trust rules a bare `$0` must
  never stand in for absent data.
- Triggering the connection action opens the **same shared modal** that
  applications trigger — verified by component identity, not by appearance.

### TC-WALLET-003: Something-active state is a portfolio

**Priority:** P0 · **Type:** State / UI · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. Activate `evm`. Open Wallet.
2. Also activate `solana`. Reopen Wallet.

**Expected**
- With EVM only: one active chain row, showing its address and balance.
- With both: two rows, one per active chain, each with its own address and
  balance.
- Dormant chains do not appear (they do not exist — see TC-DORMANT-003).
- Scope boundary: addresses and balances are present. Positions and transaction
  history are out of scope for this pass and their absence is not a failure —
  see Ambiguities on PRD open decision 1.

### TC-WALLET-004: The two states are one screen, not two products

**Priority:** P1 · **Type:** UI / Regression · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. Open Wallet with nothing active, then activate a chain without leaving the
   destination.

**Expected**
- The screen transitions from connection manager to portfolio in place. The
  route does not change and the user is not navigated to a different screen.
- A grep confirms there is one Wallet destination component with two states, not
  two sibling screen components selected by a connection check.

### TC-WALLET-005: Switching and disconnecting live only here

**Priority:** P0 · **Type:** Functional · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. With a chain active, look for switch and disconnect controls in the Wallet
   destination, in each application, and in the drawer.

**Expected**
- Switch and disconnect are present and functional in the Wallet destination.
- Neither appears in any application's UI nor in the drawer. Per the spec these
  are "an explicit action taken here, never a per-application prompt."

### TC-WALLET-006: Disconnecting an external Solana wallet deactivates only Solana

**Priority:** P0 · **Type:** Functional · **Execution:** Real device — needs a real Phantom install · **Status:** Not Run

**Steps**
1. With an external Solana wallet connected **and** Privy EVM active, disconnect
   the Solana wallet from the Wallet destination.
2. Open an EVM application, then a Solana application.

**Expected**
- Solana leaves the active set; its row disappears from the portfolio.
- EVM is untouched — still active, same address, and the EVM application
  resolves to `ready` with no prompt.
- The Solana application now presents the two-option modal (external + Privy).

### TC-WALLET-007: Balance failure does not fabricate a value

**Priority:** P1 · **Type:** State / UI · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. With a chain active, force its balance fetch to fail after retries.
2. Read the row.

**Expected**
- The address still renders — it is known and does not depend on the balance
  fetch.
- The balance shows an explicit unresolved state, never a bare `$0` standing in
  for unknown.
- A retry affordance is present and retries only that chain.

---

## 6. Security Deletions (`SEC`)

> Every case in this section is a negative case: it passes by finding nothing.
> All are static and belong in CI so a reintroduction fails the build.

### TC-SEC-001: useEvmSigner.ts is deleted

**Priority:** P0 · **Type:** Security / Regression · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Assert `apps/hybrid-expo/hooks/useEvmSigner.ts` does not exist.
2. Grep the repo for imports from `@/hooks/useEvmSigner` and for the identifier
   `useEvmSigner`.

**Expected**
- The file is absent.
- Zero import hits. At the time of writing the importers are
  `apps/hybrid-expo/features/predict/predict.signing.ts`,
  `apps/hybrid-expo/hooks/usePolymarketWallet.ts`, and
  `apps/hybrid-expo/features/predict/components/PredictOwnerKeyExportModal.tsx`
  — all three must be updated or deleted.
- The TypeScript build succeeds, proving no dangling reference survives.

### TC-SEC-002: No key material is constructed from a signature

**Priority:** P0 · **Type:** Security · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Grep the repo for `keccak256` and inspect every hit's argument.
2. Grep for the derivation shape specifically: `keccak256` applied to a variable
   whose name mentions signature/sig, and `new Wallet(` applied to any
   hash output.
3. Grep for `deriveEvmSignerFromSignature`,
   `deriveReadonlyEvmSignerFromSignature`, and
   `walletFromSolanaSignature`.

**Expected**
- Zero hits where `keccak256` output is used as private key material.
- Zero hits for all three named derivation functions.
- Any surviving `keccak256` use is over calldata, a hash commitment, or an
  address — never over signature bytes feeding a key constructor. Each surviving
  hit is inspected and recorded in the test run, not waved through.

### TC-SEC-003: PREDICT_DERIVE_MESSAGE does not appear in the codebase

**Priority:** P0 · **Type:** Security · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Grep the full repo (source, tests, e2e specs, config, docs excluded) for the
   identifier `PREDICT_DERIVE_MESSAGE`.
2. Grep for the literal string `myboon:polymarket:enable`.

**Expected**
- Zero hits for both, including in `apps/hybrid-expo/e2e/predict-lifecycle.spec.ts`
  and `apps/hybrid-expo/hooks/useWallet.web.ts`, which reference the deleted
  module today.
- Boundary: also grep the built JS bundle from a release build for the literal
  string. Removing it from source but leaving it in a vendored or generated
  artifact does not satisfy the criterion.

### TC-SEC-004: predict.signing.ts has no reference to Solana signatures

**Priority:** P0 · **Type:** Security / Regression · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Grep `apps/hybrid-expo/features/predict/predict.signing.ts` for `solana`,
   `Solana`, `signMessage(` over a Solana signer, and `Uint8Array` signature
   parameters.
2. Compile the file with `tsc --noEmit`.

**Expected**
- Zero Solana references in the file.
- It compiles clean. It obtains its signer from the resolver as a `Signer` and
  has no knowledge of how that signer was provisioned.

### TC-SEC-005: No private key reaches the clipboard

**Priority:** P0 · **Type:** Security · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Assert
   `apps/hybrid-expo/features/predict/components/PredictOwnerKeyExportModal.tsx`
   does not exist.
2. Grep the repo for `Clipboard.setStringAsync` and `setStringAsync` and inspect
   every argument.
3. Grep for `.privateKey` and for any variable named `privateKey` reaching a
   clipboard, a log, or a network call.

**Expected**
- The modal file is absent and nothing imports it (`app/predict-profile.tsx`
  references it today and must be updated).
- Every surviving `setStringAsync` argument is an address or a public
  identifier. Zero are key material.
- Zero `.privateKey` accesses anywhere in `apps/hybrid-expo/`. With Privy
  embedded wallets there is no raw key to reach for.

### TC-SEC-006: No key material is logged

**Priority:** P0 · **Type:** Security · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Grep for `console.log`, `console.warn`, and any logger call whose arguments
   include a signer, wallet object, private key, or signature.
2. Specifically confirm the removal of the `[evm-signer] Derived EOA` log at
   `useEvmSigner.ts:36`.

**Expected**
- Zero log statements carrying key material or signatures over fixed strings.
- Address-only logs are acceptable per the spec's "Addresses may be logged; keys
  and signatures over fixed strings may not."

### TC-SEC-007: No key material is sent to our backend

**Priority:** P0 · **Type:** Security · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. Run the full Polymarket enable-and-trade flow against a recording proxy.
2. Inspect every outbound request body and header to a myboon-owned host.

**Expected**
- No request carries a private key, a seed, or a signature over a fixed
  derivation string.
- Addresses and Polymarket CLOB L2 credentials may be sent — the spec's trust
  boundaries place CLOB session credentials in the deliberately lower tier and
  permit them server-side.

### TC-SEC-008: Calldata validation is retained unchanged

**Priority:** P0 · **Type:** Regression · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Confirm `validateDepositWalletSignatureRequest` still exists in
   `predict.signing.ts` and is called before every deposit-wallet batch
   signature.
2. Run its negative suite: a mismatched operation, a wrong `chainId`, a non-zero
   native value, an unexpected target contract, and an unexpected `conditionId`
   on redeem.

**Expected**
- Each negative input throws before any signature is produced, with the existing
  messages ("Predict refused to sign a mismatched wallet action.", "...for an
  unexpected chain.", "...with native token value.", "...for an unexpected
  contract.", "...for an unexpected market.").
- Behavior is unchanged from before the restructure — this validation is
  explicitly out of scope for modification and any behavioral diff is a failure.

### TC-SEC-009: The device-bound secure-store EVM key backend does not exist

**Priority:** P0 · **Type:** Security / Regression · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Grep for `expo-secure-store` usage storing EVM key material, and for any
   third `WalletBackend` value beyond `'privy_embedded'` and `'external_mwa'`.
2. Assert the `WalletBackend` union type has exactly two members.

**Expected**
- Exactly two backends exist in the type and in the resolver's backend registry.
- No secure-store code path writes or reads EVM private key material.
- No idle-sweep policy, device-loss warning, or reinstall edge-case code remains
  from the superseded draft.

---

## 7. Polymarket as First Consumer (`POLY`)

### TC-POLY-001: predict.signing.ts obtains its signer from the resolver

**Priority:** P0 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Inspect the signer acquisition in `predict.signing.ts` —
   `createPredictSessionProof`, `createPolymarketApiCreds`, and
   `signDepositWalletBatch` all called `requireActiveEvmWallet()` before this
   change.
2. Assert each now receives a `Signer` from the resolver, passed in or obtained
   through the requirement.

**Expected**
- Zero calls to `requireActiveEvmWallet` remain.
- Each function takes or resolves a `Signer` scoped to
   `POLYMARKET_REQUIREMENT`.
- The "Predict wallet needs a fresh signature" error path is gone — with a Privy
  embedded wallet there is no per-session signature to go stale. Confirm no
  user-facing copy still asks the user to re-sign for that reason.

### TC-POLY-002: EIP-712 signature from the Privy EVM backend verifies to the expected address

**Priority:** P0 · **Type:** Integration · **Execution:** Automatable (harness) with a live Privy test account; also confirm once on **Real device** · **Status:** Not Run

**Steps**
1. Resolve a signer for `POLYMARKET_REQUIREMENT`.
2. Sign a known EIP-712 payload (a Polymarket CLOB order and a deposit-wallet
   batch, one each).
3. Recover the signer address from each signature with an independent library.

**Expected**
- The recovered address equals `signer.descriptor.address` exactly, for both
  payloads.
- The domain separator carries `chainId` 137, matching the requirement's
  `chainId`.
- A payload signed for a different chainId does not verify — proving the chain
  binding is real and not incidental.

### TC-POLY-003: Full Polymarket lifecycle on a Privy account

**Priority:** P0 · **Type:** Integration · **Execution:** Real device — needs a live Privy account and **mainnet funds** (small size) · **Status:** Not Run

**Steps**
1. On a fresh Privy account, open Polymarket, complete login, and enable
   trading.
2. Deposit a small amount, buy a position, sell it, and withdraw.

**Expected**
- Every step completes with signatures produced by the Privy EVM signer.
- The deposit wallet address is derived from the Privy EOA and is stable across
  the whole lifecycle — it does not change between enable and withdraw.
- Funds arrive at the withdrawal destination.
- This case cannot be automated: it needs real value on mainnet. Run it once per
  release candidate.

### TC-POLY-004: The Predict owner-key export entry point is gone from the UI

**Priority:** P0 · **Type:** Regression · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. Open `predict-profile` and every Predict surface with an export, backup, or
   "owner key" affordance.

**Expected**
- No export-key control exists anywhere in Predict.
- No copy references exporting, revealing, or backing up a private key.
- The route does not crash from the removed modal import.

### TC-POLY-005: Polymarket never prompts for a chain already satisfied

**Priority:** P1 · **Type:** Functional · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. Activate `evm` from any surface other than Polymarket.
2. Open Polymarket.

**Expected**
- Polymarket resolves to `ready` immediately with no modal, per the spec's
  "Applications never prompt for a chain that is already satisfied."
- Predict's UI does not render a connect or enable step.

### TC-POLY-006: Polymarket requirement descriptor matches the PRD

**Priority:** P1 · **Type:** Unit · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Assert on `POLYMARKET_REQUIREMENT` field by field.

**Expected**
- `applicationId === 'polymarket'`, `chain === 'evm'`, `chainId === 137`,
  `needsTypedData === true`, `needsRawTransaction === false`,
  `fundsAtRisk === 'account'`.
- `chainId` 137 matches the `CHAIN_ID` constant `predict.signing.ts` validates
  against at line 269 — a mismatch would make every deposit-wallet signature
  request throw.

---

## 8. Build Fence (`BUILD`)

### TC-BUILD-001: A production build with EXPO_PUBLIC_PREDICT_E2E=1 fails

**Priority:** P0 · **Type:** Build / Security · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Run a release/production build with `EXPO_PUBLIC_PREDICT_E2E=1` set in the
   environment.

**Expected**
- The build exits non-zero and produces no artifact.
- The failure message names the flag and says why, so the cause is obvious to
  whoever hits it in CI.
- The failure occurs at build time, not at runtime — an app that builds and then
  refuses to run still shipped the shared key in the bundle.

### TC-BUILD-002: A production build without the flag succeeds

**Priority:** P0 · **Type:** Build · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Run the same release build with `EXPO_PUBLIC_PREDICT_E2E` unset.
2. Repeat with it set to `0` and to the empty string.

**Expected**
- All three succeed and produce an artifact. The fence is precise: it blocks
  only the `1` value in a production build, and does not break normal releases.

### TC-BUILD-003: A development/E2E build with the flag still succeeds

**Priority:** P0 · **Type:** Build · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Run a development or E2E-profile build with `EXPO_PUBLIC_PREDICT_E2E=1`.
2. Run the Predict E2E suite against it.

**Expected**
- The build succeeds. The stub stays for E2E per the PRD — the fence must not
  break the test harness.
- The E2E suite passes, confirming the stub still returns its fixed values in
  the modes that need it.

### TC-BUILD-004: The shared-key stub does not appear in a release bundle

**Priority:** P0 · **Type:** Security · **Execution:** Automatable · **Status:** Not Run

**Steps**
1. Build a release artifact normally (no flag).
2. Search the bundled JS for the stub's fingerprints: `new Uint8Array(64).fill(1)`,
   the literal `E2ePredict111111111111111111111111111111111`, and
   `e2e-signature`.

**Expected**
- Zero hits, confirming dead-code elimination removed the branch when the flag
  is unset — or, if the branch survives, that it is provably unreachable.
- Boundary: this is a distinct check from TC-BUILD-001. The fence stops a
  misconfigured build; this confirms a correctly-configured build is also clean.

---

## 9. Drawer Entry Point Removal (`DRAWER`)

### TC-DRAWER-001: No connection entry point remains in the drawer

**Priority:** P0 · **Type:** Regression · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. Open the account drawer in both connected and disconnected states.
2. Inspect every control.

**Expected**
- No connect action, no wallet picker, no sign-in form, no OTP or passkey entry.
  `components/drawer/WalletDrawer.tsx` currently holds all of these
  (`handleWalletConnect`, the email OTP flow, the passkey flow, and the
  `installedWalletOptions` list) and they must be gone.
- No Privy Solana export button remains.
- The drawer offers no path, direct or indirect, to establish a connection.

### TC-DRAWER-002: The drawer keeps its other responsibilities

**Priority:** P0 · **Type:** Functional · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. Inspect the drawer's full contents after the removal.

**Expected**
- Identity, auth method label, connected address display, feedback/support/
  privacy links, and app version remain present and functional.
- Nothing that was not a connection entry point was removed as collateral.

### TC-DRAWER-003: Disconnect moved to the Wallet destination, not duplicated

**Priority:** P1 · **Type:** Functional · **Execution:** Automatable (harness) · **Status:** Not Run

**Assumes:** disconnect counts as connection management and therefore moves to
the Wallet destination with the rest, per the spec's "Switching or disconnecting
a wallet is an explicit action taken here." The PRD's item 6 says only that "the
drawer's connection entry point is removed" without naming disconnect — see
Ambiguities.

**Steps**
1. Look for a disconnect control in the drawer and in the Wallet destination.

**Expected**
- Disconnect is present in the Wallet destination and absent from the drawer.
- There is exactly one disconnect path in the app, not two that could diverge.

### TC-DRAWER-004: Removing the drawer entry point breaks no route

**Priority:** P1 · **Type:** Regression · **Execution:** Automatable (harness) · **Status:** Not Run

**Steps**
1. Open the drawer from every surface that mounts it and exercise each remaining
   control.

**Expected**
- No crash, no dead tap target, and no empty section left where the connection
  block used to be.
- The drawer's layout is coherent — the removal did not leave an orphaned header
  or divider.

---

## 10. Accessibility (`A11Y`)

### TC-A11Y-001: Connection modal options are announced as actionable

**Priority:** P1 · **Type:** Accessibility · **Execution:** Real device — screen reader (TalkBack) · **Status:** Not Run

**Steps**
1. Open the connection modal for a `solana` requirement with TalkBack on.
2. Repeat for an `evm` requirement.

**Expected**
- Each available option is announced as a button with a label naming what it
  does.
- In the EVM case, the screen reader encounters exactly one option and no
  announcement of a hidden or disabled second one.
- The modal is announced as modal and focus is trapped inside it.

### TC-A11Y-002: The modal is dismissible without a gesture

**Priority:** P1 · **Type:** Accessibility · **Execution:** Real device — screen reader (TalkBack) · **Status:** Not Run

**Steps**
1. With the modal open and TalkBack on, dismiss it using only the screen
   reader's navigation and the explicit close control.

**Expected**
- An explicitly labeled close control is reachable and works — dismissal does not
  depend on a backdrop tap, which is not reliably reachable via assistive tech.
- After dismissal, focus returns to the element that opened the modal.

### TC-A11Y-003: Wallet destination states are announced distinctly

**Priority:** P1 · **Type:** Accessibility · **Execution:** Real device — screen reader (TalkBack) · **Status:** Not Run

**Steps**
1. Open Wallet with nothing active, then with a chain active, with TalkBack on.

**Expected**
- The nothing-active state announces the connection prompt and its action, not
  an empty screen.
- The active state announces each chain row with the chain name, its address,
  and its balance — the address is announced in a way a user can act on, not as
  a run-on character string with no boundaries.
- An unresolved balance is announced as unresolved, not skipped silently.

### TC-A11Y-004: The funded-dormant activation prompt is not colour-only

**Priority:** P2 · **Type:** Accessibility · **Execution:** Automatable (harness) with the injected state from TC-DORMANT-007 · **Status:** Not Run

**Steps**
1. Reach the funded-dormant safety-net state and inspect the prompt in grayscale
   and with a screen reader.

**Expected**
- The prompt's meaning survives grayscale — it carries text or an icon, not just
  a warning tint.
- The screen reader announces both the balance and the activation action.

---

## Traceability — PRD acceptance criteria to test cases

| # | Acceptance criterion (abridged) | Covered by | Coverage |
|---|---|---|---|
| 1 | `useEvmSigner.ts` deleted; no module-level mutable wallet singleton | TC-SEC-001, TC-RESOLVE-009 | Full |
| 2 | No code path constructs key material from a signature; `keccak256`-over-signature search returns no hits | TC-SEC-002, TC-SEC-009 | Full |
| 3 | `PREDICT_DERIVE_MESSAGE` does not appear in the codebase | TC-SEC-003 | Full |
| 4 | `predict.signing.ts` compiles with no reference to Solana signatures | TC-SEC-004, TC-POLY-001 | Full |
| 5 | Key material never reaches `Clipboard.setStringAsync`; `PredictOwnerKeyExportModal.tsx` removed | TC-SEC-005, TC-POLY-004 | Full |
| 6 | Production build with `EXPO_PUBLIC_PREDICT_E2E=1` fails | TC-BUILD-001, TC-BUILD-002, TC-BUILD-003, TC-BUILD-004 | Full |
| 7 | Fresh Privy login provisions no wallet on any chain until activation | TC-DORMANT-001, TC-DORMANT-002, TC-DORMANT-004 | Full |
| 8 | Polymarket login yields active EVM, **no Solana wallet in existence**; Wallet shows EVM only | TC-DORMANT-003, TC-DORMANT-004, TC-WALLET-003 | Full |
| 9 | That user opening a Solana app is prompted once, activates, and Solana persists active | TC-DORMANT-005, TC-SESSION-001, TC-SESSION-005, TC-SESSION-006 | Full |
| 10 | External-Solana user opening Polymarket gets a Privy-only modal; Solana untouched | TC-SESSION-004, TC-SESSION-003, TC-MODAL-002 | Full |
| 11 | Modal renders from a filtered option list; adding an external EVM option changes only the availability rule | TC-MODAL-004, TC-MODAL-001, TC-MODAL-002, TC-MODAL-003 | Full |
| 12 | A second EVM application needs a new descriptor and no resolver change | TC-RESOLVE-008 | Full |
| 13 | Unsatisfiable requirement returns `unsupported` with a human-readable reason, not a throw | TC-RESOLVE-004, TC-RESOLVE-005, TC-RESOLVE-010 | Full |
| 14 | No connection entry point remains in the app drawer | TC-DRAWER-001, TC-DRAWER-003, TC-DRAWER-004 | Full |

**All 14 acceptance criteria have at least one covering case.** Two carry
caveats that the reader should not miss:

- **Criterion 2** is only as strong as the grep. "No code path constructs key
  material from a signature" cannot be proven by static search alone — a
  derivation written with a different hash function, or assembled across two
  modules, would pass TC-SEC-002. The case is written to inspect every surviving
  `keccak256` hit by hand rather than pattern-match, but the criterion is
  fundamentally not fully decidable by test. It needs code review as well, which
  is why the spec records it under Governing Rules "enforce in review."
- **Criterion 6's** wording is "a production build," which TC-BUILD-001 tests
  directly. TC-BUILD-004 was added because a passing fence does not by itself
  prove a *correctly configured* release is free of the shared key.

### Spec behavior not restated in the PRD, and where it is covered

| Spec behavior | Covered by |
|---|---|
| Resolution order: active → provisioned → modal | TC-RESOLVE-001, 002, 003, 005 |
| Resolution is per chain and session-scoped | TC-SESSION-001, 002, 003, 006 |
| Activation is sticky, per chain, not per application, one-way | TC-SESSION-001, 002, 005 |
| One connection modal in the product, not one per chain | TC-MODAL-003, TC-WALLET-002 |
| Dormancy is deferred creation, not hidden display | TC-DORMANT-001 through 006 |
| Funded-dormant chain must be surfaced with an activation prompt | TC-DORMANT-007, 008, 009 |
| Wallet surface's two states over one screen | TC-WALLET-002, 003, 004 |
| Applications do not own connection UI | TC-MODAL-008, TC-WALLET-005, TC-POLY-005 |
| Key material never leaves the device boundary | TC-SEC-005, 006, 007 |
| Signature may authorize a key, never be one | TC-SEC-002 |
| Calldata validation is the required adapter pattern | TC-SEC-008 |
| Exactly two backends; MWA is Solana-only permanently | TC-SEC-009, TC-MODAL-002, TC-RESOLVE-007 |
| Signer descriptor exposes durability properties | TC-RESOLVE-006, 007 |

---

## Open questions and ambiguities

These are for the PRD author and the implementer. Cases written against an
assumed reading say so inline; they are listed here so the assumption is visible
rather than buried.

### From the PRD's three open decisions

1. **Portfolio depth in the Wallet destination (PRD open decision 1).**
   The PRD's item 5 scopes this pass to "address and balance level per active
   chain" and calls positions and history a follow-on, but open decision 1 leaves
   the scope call unmade. **TC-WALLET-003 is written against the item-5 reading**
   — addresses and balances only, and the absence of positions is not a failure.
   If positions and history land in this pass, that case needs extending and a
   `WALLET` sub-group for position rendering needs adding.

2. **Does activation ever reverse? (PRD open decision 2.)**
   **TC-SESSION-005 is written against the PRD's own recommendation: not in v1**
   — a Privy-provisioned chain cannot be deactivated. TC-WALLET-006 covers the
   uncontested case (disconnecting an *external* wallet does deactivate that
   chain). If the team decides Privy-provisioned chains can be deactivated, we
   need new cases for: what happens to the wallet that already exists, whether
   its address is retained for re-activation, and whether a deactivated chain
   with a non-zero balance is caught by the funded-dormant safety net. That last
   one matters — deactivation would create exactly the provisioned-but-dormant
   state the safety net exists for, turning TC-DORMANT-009's "should be
   unreachable" assertion false.

3. **Copy for the Privy-only EVM modal (PRD open decision 3.)**
   No test case asserts specific copy, because there is none to assert against.
   **TC-MODAL-002 covers the structural requirement** (one option, external
   absent) and is copy-independent. Once product writes the copy, add a case
   verifying the explanation is present and that it does not claim the user's
   connected Phantom is unsupported *by Phantom* — the true reason is the
   transport. Until then this is uncovered by design, not by oversight.

### Ambiguities found while writing these cases

4. **"Session-scoped" is not defined at its boundary.**
   The spec says resolution is "session-scoped" and activation is one-way "within
   a session lifecycle" without saying what ends a session — app process death,
   Privy session expiry, explicit logout, or MWA authorization expiry. These give
   different answers for a user who force-quits and reopens. **TC-SESSION-006 is
   written against the reading that the Privy authenticated session is the
   boundary**, so a restart with a valid session preserves the active set.
   TC-SESSION-007 assumes logout clears it. Both need confirming.

5. **Existing Privy-over-MWA precedence contradicts the new per-chain model.**
   `apps/hybrid-expo/hooks/useWallet.native.ts:41` short-circuits on
   `privy.isPrivyUser` and returns the Privy wallet, deliberately ignoring "any
   stale MWA account still cached by the mobile wallet adapter" (its own comment).
   Under the restructure a user can legitimately hold an external Solana wallet
   *and* a Privy EVM wallet at once — acceptance criterion 10 requires exactly
   that. This precedence must be removed or scoped per chain, or criterion 10
   cannot pass. **TC-SESSION-003 is written to catch it.** Flagging it because
   the PRD does not list `useWallet.native.ts` under "what is being removed"
   beyond the E2E stub, so the precedence change may not have been noticed.

6. **`ChainRequirement` declares capabilities the resolver's four-branch table
   does not consult.**
   The requirement carries `needsTypedData`, `needsRawTransaction`, and
   `fundsAtRisk`, but the resolution table in PRD item 3 branches only on
   active/provisioned/neither/unsatisfiable. It is not stated whether a
   capability mismatch is what produces `unsupported`, or whether `unsupported`
   only means "no backend for this chain." **TC-RESOLVE-010 is written against
   the reading that a capability mismatch produces `unsupported`**, since the
   alternative lets a caller receive `ready` and fail later at signing time. If
   the intended reading is chain-only, that case is invalid and the capability
   fields need a stated consumer — otherwise they are decorative.

7. **`fundsAtRisk` has no specified effect.**
   The PRD says the descriptor exists "so features decide whether to warn before
   a user parks value," but nothing states what `fundsAtRisk: 'account'` must
   cause. **This is currently untestable as written** — there is no observable
   result to assert. No case covers it. Either specify the behavior (e.g. an
   `'account'` requirement on a signer with `survivesDeviceLoss: false` must show
   a warning before first use) or drop the field. Flagging rather than inventing
   an expected result.

8. **"Non-zero balance" for the funded-dormant net has no defined floor.**
   TC-DORMANT-008 tests the strict reading — 1 wei counts. If the implementation
   uses a dust threshold or a USD-value floor, that is a different behavior and
   the case needs the threshold specified. A USD floor also introduces a price
   dependency the spec does not mention.

9. **A `preparing` status with no stated timeout.**
   The resolver's `preparing` state has no specified maximum duration or failure
   transition. TC-RESOLVE-005 asserts it is never terminal within the test
   timeout, and TC-DORMANT-006 asserts it does not wedge on interruption, but
   neither can assert a real bound because none is specified. If Privy's
   `create()` hangs, the intended behavior is undefined.

10. **What "provisioned" means for an external wallet across sessions.**
    The spec defines provisioned for an external wallet as "the user has
    authorized a connection," but MWA authorizations can be reused or can expire.
    Whether a previously-authorized-but-now-expired Phantom connection counts as
    provisioned (branch 2, activate silently) or as neither (branch 3, show the
    modal) is not stated. No case covers the expired-authorization path because
    the expected result is undecided — flagging rather than guessing.

### Contradiction found between documents

11. **The spec and the PRD disagree on whether the funded-dormant path is
    reachable.**
    The spec says "Where a chain has been provisioned eagerly *for any reason*,
    the Wallet surface must still check its balance," implying eager provisioning
    is a live possibility. The PRD says "With deferred creation this should be
    unreachable, which is the point — it is a safety net, and if it ever fires we
    have a provisioning bug." These are reconcilable — the spec describes a
    required behavior, the PRD asserts the trigger should not occur — but they
    lead to different test expectations. **TC-DORMANT-007 and 008 test the
    behavior with an injected state (the spec's reading); TC-DORMANT-009 asserts
    the path is never entered organically (the PRD's reading).** Both are written
    so the pair is coherent, but the implementer should confirm this is the
    intended split, and note that resolving open decision 2 toward reversible
    activation would break TC-DORMANT-009.

---

## Coverage statement

**69 cases** across ten groups: 51 P0, 17 P1, 1 P2, broken down by group in the
table below. All 14 PRD acceptance criteria have covering cases; criterion 2 is
covered but not fully decidable by test and needs review support, as noted in
Traceability.

| Group | P0 | P1 | P2 | Total |
|---|---|---|---|---|
| `RESOLVE` | 9 | 2 | 0 | 11 |
| `MODAL` | 7 | 1 | 0 | 8 |
| `DORMANT` | 7 | 2 | 0 | 9 |
| `SESSION` | 4 | 3 | 0 | 7 |
| `WALLET` | 5 | 2 | 0 | 7 |
| `SEC` | 9 | 0 | 0 | 9 |
| `POLY` | 4 | 2 | 0 | 6 |
| `BUILD` | 4 | 0 | 0 | 4 |
| `DRAWER` | 2 | 2 | 0 | 4 |
| `A11Y` | 0 | 3 | 1 | 4 |
| **Total** | **51** | **17** | **1** | **69** |

By execution mode: **33 Automatable** (CI, no hardware — every `SEC` and `BUILD`
case plus most of `RESOLVE` and `MODAL`), **23 Automatable (harness)** (emulator
or mocked Privy/MWA transport; 5 of these also call for one confirming run on a
real device), and **13 Real device**.

Real-device dependencies, called out explicitly:
- **Real Phantom install — 3 cases:** TC-MODAL-006, TC-SESSION-004,
  TC-WALLET-006. TC-SESSION-003 is harness-run but wants one confirming device
  pass with Phantom.
- **Live Privy account — 7 cases:** TC-MODAL-007, TC-DORMANT-002, TC-DORMANT-003,
  TC-DORMANT-004, TC-SESSION-004, TC-SESSION-006, TC-SESSION-007, plus TC-POLY-003.
  TC-DORMANT-002/003/004 each need a *fresh* account per run, since they assert on
  the state of a never-activated user.
- **Mainnet funds — exactly 1 case:** TC-POLY-003, the full Polymarket enable /
  buy / sell / withdraw lifecycle. Run once per release candidate at small size.
  No other case in this suite spends real value.
- **Screen reader (TalkBack) — 3 cases:** TC-A11Y-001, 002, 003.

### Known gaps in this suite

- **No copy or visual-design cases.** Blocked on PRD open decision 3 and on
  design not existing yet for the Wallet destination.
- **No `fundsAtRisk` cases.** Untestable as specified — see ambiguity 7.
- **No expired-MWA-authorization case.** Expected result undecided — see
  ambiguity 10.
- **No performance or resolver-latency cases.** No budget is specified anywhere.
- **No cases for portfolio positions or transaction history.** Out of scope for
  this pass per PRD item 5; add when open decision 1 resolves toward including
  them.
- **iOS coverage is assumed to mirror Android but is not separately enumerated.**
  MWA is Android-only in practice, so the external-wallet cases have no iOS
  equivalent and the iOS matrix is Privy-only. If iOS ships in this cycle, the
  `MODAL` and `SESSION` groups need an iOS pass added.

This suite is **complete for the PRD's stated scope and the spec's behavioral
model as currently written**, and **incomplete** in the six respects listed
above. Do not report it as full coverage without those caveats.

## Notes

- Update **Status** per test cycle. Do not delete failed cases — record the
  failure and link the fixing commit or PR, so this file remains the running
  record of what has actually been verified.
- The `SEC` and `RESOLVE-009` cases are static checks and should be wired into
  CI rather than run by hand. A security deletion that is verified once and then
  reintroduced silently is worse than one that was never verified, because the
  document will claim it passed.
- This document deliberately contains **no migration, fund-sweep, or
  legacy-user cases**. myboon has zero users. If a future reader adds one,
  check first whether that assumption still holds.
