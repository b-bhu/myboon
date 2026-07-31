# Polymarket Account Setup PRD

Status: ready for review
Date: 2026-07-30
Owner: myboon Apps
Builds on: `docs/modules/wallet/PRDs/2026_07_26_wallet_connectivity_restructure_PRD.md` (complete)
Governing spec: `docs/modules/wallet/specs/wallet_connectivity.md`

This is a change plan. It describes work to be done and stops being read once the
work lands. The durable rules it establishes are amended into the wallet
connectivity spec, not kept here.

Scope note: the wallet connectivity spec governs how any application obtains a
signer. This PRD governs what an application does with one before the user can
transact — for Polymarket, CLOB authentication and deposit wallet setup — and how
that is presented.

It establishes a general mechanism — application setup declared alongside a
chain requirement — because more EVM applications are coming and they will not
be on Polygon. The mechanism is defined here and amended into the wallet spec;
Polymarket is its first implementation, not its definition. A second EVM
application supplies its own setup and does not read this document.

## The problem in one paragraph

A user signs into Privy, an embedded EVM wallet is created, and the Polymarket
profile screen still says "Connect wallet" with no way forward. Tapping it opens
the connection sheet, which correctly reports the wallet as already connected and
offers nothing further. The user is stuck with a working wallet and no path to a
Polymarket account.

## Two distinct facts, currently conflated

The restructure split one operation into two, and the screens were never updated
to match.

**Under the old derivation flow**, the Polygon EOA was derived from a Solana
signature *inside* `enable()`. The address and the CLOB session came into
existence together, in one call. `polygonAddress != null` was therefore a sound
proxy for "this user has a wallet."

**Under the current flow**, the Privy embedded wallet exists independently — at
app load, restored from the Privy session, before any server call. CLOB
authentication is a separate, later step. The two facts are now:

| Question | Answered by | Source |
|---|---|---|
| Can this user sign on Polygon? | `signer` / `signerStatus` | Local, Privy, instant |
| Does this user have a Polymarket account? | `polygonAddress` | Server, `/clob/auth` |

The proxy became false the moment deferred provisioning shipped. Nothing failed
loudly, because `polygonAddress` is still a string that is still sometimes
populated — it is simply answering a question the screens are not asking.

`usePolymarketWallet` exposes both, undifferentiated, as fields of the same
object. A screen author reaching for "the user's address" finds
`polygonAddress` first, and it type-checks.

## What already works — and why the bug survived

The merged sign-in-and-setup flow this PRD formalises **already exists on both
market detail screens**:

- `PredictMarketDetailScreen.tsx:474-478`
- `PredictSportDetailScreen.tsx:733-736`

Both implement the same pattern inline: a local `setupAfterConnect` flag, set
before opening the connection sheet, consumed by a `useEffect` that fires
`poly.enable()` as soon as a signer resolves. The user taps once. There is no
intermediate "now create your account" step. This is the correct behaviour and
the intended UX.

It was written twice, by hand, in two screens. It lives in component-local
`useState` rather than in the hook every Predict screen already calls. Nothing
requires a new screen to implement it.

**The profile screen does not have it.** That is the entire bug. Not a missing
design — a pattern that was never given a home, and a third screen that missed
it.

Root cause is the same class as the restructure's own: a missing abstraction.
There was no shared EVM signer, so Predict built its own. There is now no shared
account-setup flow, so two screens built their own and one went without.

## The specific dead end

`profile.tsx:381` `handleConnectPredictAccount` branches correctly on
`poly.signer` — connection sheet if absent, `enable()` if present. But it is only
reachable from `EmptyPortfolio`, whose action is gated at `profile.tsx:559` on
`!poly.polygonAddress`. A user with a fresh wallet and no CLOB session has
`polygonAddress === null`, so the gate routes to `openConnect` — the sheet — not
to setup.

The sheet then shows a connected wallet and no action. Profile has no
`setupAfterConnect` equivalent, so closing it resumes nothing.

Four call sites on the profile screen read `polygonAddress` where they mean
"wallet":

| Line | Element | Reads | Should read |
|---|---|---|---|
| `profile.tsx:510` | identity header address | `polygonAddress` | signer address |
| `profile.tsx:512` | "Connected" chip | `polygonAddress` | `signerStatus === 'ready'` |
| `profile.tsx:520` | "Connect wallet" CTA | `!polygonAddress` | `signerStatus === 'needs_connection'` |
| `profile.tsx:559` | EmptyPortfolio action | `!polygonAddress` | `!signer` |

`usePolymarketWallet.ts:338` `isReady` reads `polygonAddress` and is **correct** —
it asks whether the Polymarket session is live, which is genuinely a
`polygonAddress` question. It is listed here so the fix does not sweep it up.

## What is being built

### 1. Application setup, declared and run by the chain layer

More EVM applications are coming, on chains other than Polygon. They share the
wallet — one Privy embedded EVM address, any `chainId` — but each needs its own
post-connection setup before the user can transact. Polymarket needs CLOB auth
and a deposit wallet; a perps venue would need something else entirely.

So the *shape* is generalised, not the Polymarket code. An application declares
its setup alongside its chain requirement, and the chain layer runs it as part of
connecting:

```ts
export interface ApplicationSetup {
  /** Stable id for storage scoping and diagnostics. */
  id: string;
  /** Is setup already satisfied for this signer? Read from local storage. */
  isSatisfied: (signer: Signer) => Promise<boolean>;
  /** Perform setup. Called only when `isSatisfied` is false. */
  run: (signer: Signer) => Promise<void>;
  /** Ceiling for `run`. Exceeded means setup failed; the wallet survives. */
  timeoutMs?: number;
}
```

`ChainRequirement` stays a pure data descriptor — no functions on it. It is
imported by `chain.resolution.ts`, which is deliberately renderer-free and
pure-testable, and adding a function member would break that. Setup is
registered separately and looked up by `applicationId`:

```ts
// chain.setup.ts
export const APPLICATION_SETUPS: Record<string, ApplicationSetup> = {
  polymarket: polymarketSetup,
};
```

`useChainSigner` gains one method:

```ts
connectAndSetup: () => Promise<void>;
```

which carries a user from "wants to act" to "can act", regardless of entry state:

```text
signer absent   -> caller opens the connection sheet; resume when the signer lands
signer present  -> activate if needed, then run the application's setup
already set up  -> no-op
```

The resume-after-connection behaviour lives here, so a screen opens the sheet and
calls one method instead of hand-rolling an effect. This replaces the duplicated
`setupAfterConnect` state machines in both detail screens.

A new EVM application on Base or Arbitrum is then a `ChainRequirement` plus an
`ApplicationSetup` — no changes to the resolver, the sheet, or this flow.

### 2. Setup status in the resolver's state

`useChainSigner` currently reports four statuses. A resolved signer whose
application setup has not run is not `ready` — the user cannot transact. It gains
one state:

```ts
type ChainSignerStatus =
  | 'preparing'
  | 'needs_connection'
  | 'needs_setup'      // signer resolved, application setup outstanding
  | 'ready'
  | 'unsupported';
```

A requirement with no registered setup treats `isSatisfied` as always true, so
Solana and any application without setup behave exactly as today. `needs_setup`
is unreachable for them.

**`isSatisfied` is async, so setup status is unknown on first render.** The
resolver must report `preparing` until it resolves — never `needs_setup`. Getting
this wrong makes a returning user with a live session see a setup prompt flash
before the screen settles, which is the same class of bug this PRD exists to fix:
reporting a state the app has not actually determined yet.

This mirrors `isActivationHydrated`, which already gates the same way for
AsyncStorage-backed activation state, and the reasoning in `chain.resolution.ts`
for why hydration precedes branch evaluation. Setup hydration joins it as a
second precondition.

### 3. Unambiguous state on `usePolymarketWallet`

The hook re-exports the resolver's status rather than leaving callers to infer
connection state from two strings. `polygonAddress` remains available —
`fetchPortfolio`, `fetchClobBalance`, `fetchOpenOrders`, `cancelOrder`, and
`placeBet` all legitimately need the CLOB address. It stops being the field a
screen reaches for to answer a connection question.

Polymarket's setup implementation wraps the existing `enable()` body. The CLOB
auth call, deposit wallet creation, and AsyncStorage session keys are unchanged —
they move behind the interface rather than being rewritten.

### 4. Profile screen parity

Profile adopts the same flow as the detail screens: the four gates above key on
the resolver status, and the primary action routes through `connectAndSetup()`.

`needs_setup` is a state the profile screen currently cannot render. It gets one.

### 5. Remove the "Use this wallet" button from `ConnectionSheet`

`ConnectionSheet.tsx:508-526`, added this session, was an attempt to fix this
from the connection layer. It is gated on `needsActivationOnly &&
!activation[chain]`, and `useActivationReconciler` writes `activation.evm = true`
as soon as a signable wallet exists — so the button is correctly invisible in the
exact state it was built for, and can never fire.

The sheet's responsibility per the spec is connection. Polymarket account setup
is not connection. The button is removed rather than repaired.

### 6. Failure contract for application setup

Setup reaches the network — for Polymarket, our API and Polymarket's — and can
fail for reasons unrelated to the wallet: geoblock, network, server restart. The
restructure PRD's unresolved side thread records one such case.

**A setup failure never invalidates the wallet.** The user stays signed in, the
signer stays resolved, and status remains `needs_setup` with a retry affordance
and the failure reason. Discarding a legitimately provisioned wallet because a
server call failed is worse than showing a retry.

This is a property of the shared interface, not of Polymarket's error handling —
every application registered under `APPLICATION_SETUPS` gets the same guarantee.

Because the chain layer now runs application code during connection, two bounds
are required:

- **`run` is time-bounded.** A hung setup call must not wedge the connection
  flow behind a spinner with no exit. Exceeding `timeoutMs` is a setup failure
  like any other — the wallet survives, status is `needs_setup`.
- **`run` never throws past the layer.** Failures are caught and surfaced as
  status plus reason. The resolver's existing contract is that it does not throw
  for an unsatisfiable requirement; the same holds for a failed setup.

This is why `needs_setup` must be a first-class renderable state on every screen,
even though it is never a step in the happy path.

## User-visible flows

**New user, from a market detail.** Taps an outcome, taps the setup CTA on the
numpad. Connection sheet opens. Email, OTP. Wallet provisions, chain activates,
CLOB auth runs, deposit wallet is created. Sheet closes. The numpad is live and
the bet is ready to confirm at the current price.

The bet is *not* auto-placed. The user authenticated; they did not confirm a
trade, and the price may have moved during setup. `InlineNumpad` already models
this correctly via `setupRequired`/`disabled`, and that behaviour is preserved.

**New user, from profile.** Taps "Connect wallet". Same flow. Lands on a
functioning profile with a live session — not on an intermediate screen asking
them to create an account.

**Returning user.** Wallet restores from the Privy session at app load; the CLOB
session rehydrates from AsyncStorage keyed to that wallet. State is `ready`
before the first frame. No prompt anywhere.

**Signed in, setup failed.** State is `needs_setup`. Screens show the wallet
address and a retry with the failure reason. Wallet is untouched.

## Acceptance criteria

- [ ] No screen determines wallet-connection state from `polygonAddress`,
      `tradingAddress`, or any other CLOB session field. A repo-wide search for
      `polygonAddress` in a JSX gating position returns only session questions.
- [ ] A user who signs in from any Predict entry point — profile, market detail,
      sport detail — reaches a live Polymarket session in one user action, with
      no intermediate "create account" step.
- [ ] The profile screen renders a distinct, actionable state for a resolved
      signer with no CLOB session.
- [ ] No screen can reach a state where a wallet is connected and no control
      advances the user toward trading.
- [ ] `setupAfterConnect` local state does not appear in any screen component.
      The resume-after-connection path lives in the chain layer.
- [ ] A failed CLOB auth leaves the user signed in with the signer resolved, and
      surfaces the failure reason with a retry.
- [ ] A setup call that exceeds its timeout fails the same way — wallet intact,
      status `needs_setup` — and never leaves the flow spinning.
- [ ] `ConnectionSheet` contains no Polymarket-specific control.
- [ ] Adding a new Predict screen requires calling one hook method to get the
      full connect-and-setup flow; it cannot silently omit it.
- [ ] Adding a hypothetical EVM application on a non-Polygon chain requires a new
      `ChainRequirement` and a new `ApplicationSetup` registration, and no change
      to the resolver, the connection sheet, or the connect-and-setup flow.
- [ ] A requirement with no registered setup resolves exactly as it does today.
      Solana flows are unchanged and `needs_setup` is unreachable for them.
- [ ] `chain.resolution.ts` remains free of function-valued requirement fields
      and testable without a renderer.

## Testing plan

- Unit: resolver status derivation covers all five branches, including
  `needs_setup` and `preparing` during hydration.
- Unit: a requirement with no registered setup never yields `needs_setup`.
- Unit: status is `preparing`, never `needs_setup`, while `isSatisfied` is
  outstanding.
- Unit: `connectAndSetup()` is a no-op when setup is already satisfied.
- Unit: a rejected setup leaves the signer resolved and the status
  `needs_setup`, and does not throw past the layer.
- Unit: a setup that exceeds `timeoutMs` fails identically to a rejection.
- Integration: fresh Privy login through profile reaches `ready` without a second
  user action.
- Integration: fresh Privy login through a market detail reaches `ready` with the
  numpad live and the bet unplaced.
- Integration: cancelling the connection sheet mid-flow leaves no pending setup
  armed.
- Manual, real device: new Privy account end to end on both entry points; app
  restart confirms `ready` before first interaction.

## Open decisions

1. **Per-chainId session scoping.** Polymarket's session storage keys are scoped
   per EVM address (`polymarket_polygon_address:<address>`), not per `chainId`.
   One wallet serving two EVM applications on different chains would not collide
   today, because keys are also prefixed per application — but nothing enforces
   that, and a second application choosing a generic key name would. Recommend
   folding `chainId` into the key scope when the second EVM application is
   specified, not speculatively now.
2. **Deactivation.** `ConnectionSheet.confirmDisconnect` calls
   `deactivate(chain)` while the Privy wallet still exists, and
   `useActivationReconciler` re-activates it on the next render. This is the
   restructure PRD's open decision 2 ("does activation ever reverse?") arriving in
   practice. Out of scope here; needs its own answer.
3. **Setup on Solana.** The mechanism is chain-agnostic, but no Solana
   application declares setup today. Left unexercised rather than designed
   around.

## Spec amendments

Two rules to add to `docs/modules/wallet/specs/wallet_connectivity.md` under
Governing rules. Both are durable and outlive this PRD.

**An application reports connection state from the resolver alone.** Protocol
session credentials — CLOB L2 credentials, server sessions, anything in the lower
trust tier — never gate connection UI. They answer whether a protocol session is
live, which is a different question from whether the user has a wallet.
Conflating them is what let a working wallet render as "Connect wallet".

**Satisfying a requirement means the user can transact.** A resolved signer is
not the end of the user's journey. Where an application needs further setup
before the user can act, that setup is declared alongside the chain requirement
and run by the connectivity layer as part of connecting — not left as a second
step the user must discover. An application must never present a connected wallet
with no control that advances the user.

Corollary: application setup runs inside the connection flow, so it is
time-bounded and never throws past the layer. A failed setup leaves the wallet
intact and the requirement reporting `needs_setup` with a reason. Key material is
never discarded because a network call failed.

## References

### Internal

- `docs/modules/wallet/specs/wallet_connectivity.md` — governing model
- `docs/modules/wallet/PRDs/2026_07_26_wallet_connectivity_restructure_PRD.md` — the completed restructure this builds on
- `apps/hybrid-expo/hooks/usePolymarketWallet.ts` — enable flow and state
- `apps/hybrid-expo/features/chain/useChainSigner.ts` — resolver
- `apps/hybrid-expo/app/markets/polymarket/profile.tsx` — screen missing the flow
- `apps/hybrid-expo/features/predict/PredictMarketDetailScreen.tsx:474` — existing merged flow
- `apps/hybrid-expo/features/predict/PredictSportDetailScreen.tsx:733` — duplicate of the same
- `apps/hybrid-expo/features/wallet/components/ConnectionSheet.tsx` — connection surface
