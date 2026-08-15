# Wallet Connectivity Model

Status: living specification
Last amended: 2026-08-15
Owner: myboon Apps
Scope: how applications inside myboon obtain a wallet capable of signing on the
chain they need

This document describes how the system works, not what work is outstanding.
Amend it when the model changes. Do not add issues, phases, or acceptance
criteria here — those belong in a PRD.

Companion change plan:
`docs/modules/wallet/PRDs/2026_07_26_wallet_connectivity_restructure_PRD.md`.

## The model in one paragraph

An application does not own a wallet connection. It declares the chain it needs
to sign on, and the connectivity layer resolves that requirement against what
the user already has. Wallets are held per chain, at the session level, and are
shared by every application that needs the same chain. Privy authentication is
shared, but each embedded chain wallet is created only when that chain is
explicitly requested. When a requirement cannot be satisfied, the layer opens
the one app-wide wallet sheet with only the options that chain supports.

## Vocabulary

These four terms are load-bearing. They are used precisely throughout the
codebase and in every related document.

**Backend** — the thing that holds key material. There are two:
Privy embedded wallets, and external wallets reached over Mobile Wallet Adapter.

**Provisioned** — key material exists for a given chain. For Privy this means
the embedded wallet has been created. For an external wallet it means the user
has authorized a connection.

**Active** — the user has expressed intent for this chain. Only active chains
appear in the Wallet surface, can be funded from within the app, and are offered
to applications.

**Requirement** — an application's declaration of the chain and signing
capabilities it needs, evaluated by the resolver.

Provisioned and Active are independent. A chain can be provisioned but dormant
(key exists, user has not expressed intent). A chain cannot be active without
being provisioned.

## The two backends

### Privy — shared identity, deferred wallets

Email or Google authentication establishes one Privy user identity. It does
not provision every supported chain. The first explicit requirement for a
chain creates that chain's embedded wallet and activates it; other chains stay
dormant and uncreated. An authenticated user therefore does not repeat login,
but still makes an explicit per-chain choice. For Solana, the sheet shows
**Create Solana wallet** when none exists or **Use existing Solana wallet**
when a dormant embedded wallet already exists. Polygon uses **Enable Polygon
wallet**. User-facing connection copy must not introduce “myboon wallet” as an
unexplained wallet type.

Privy exposes `useEmbeddedEthereumWallet()` and `useEmbeddedSolanaWallet()`,
each with a `create()` method, and `createOnLogin` is configurable
independently per chain in the provider config. This is what makes lazy
per-chain provisioning possible — see Dormancy below.

The repository configures deferred creation. It does not configure or prove the
wallet recovery method, which may instead be set in the Privy dashboard. Until
that dashboard configuration is verified, the product must not promise iCloud,
Google Drive, passcode, recovery-key, or any other method-specific recovery.
When Privy records a wallet that cannot sign on the current device, show the
neutral **Wallet unavailable on this device** state and a myboon support path.

### External wallets — Solana only, and permanently so

Mobile Wallet Adapter is Solana-only by specification. `authorize` accepts
`solana:mainnet`, `solana:testnet`, and `solana:devnet`; other chain types are
described as envisioned, not shipped.

Phantom mobile does hold Ethereum, Base, Polygon, and HyperEVM accounts, but
those accounts are unreachable through MWA. This is not a gap we can close by
writing more code, and it is not a Phantom limitation we can route around. It is
a property of the transport.

**Consequence:** there is no external wallet path for EVM on mobile. An EVM
application can only ever be satisfied by Privy. This single constraint explains
most of the asymmetry in this document.

## Resolution

When an application needs a chain:

```text
1. Chain is active and usable -> return `satisfied`, no prompt
2. Privy user is authenticated -> explicitly create/activate the requested chain
3. Neither                    -> present the requested chain's connection options
4. Wallet exists but cannot sign here -> show neutral recovery and support
```

Resolution is per chain and session-scoped. Connect a Solana wallet once and
every Solana application in that session uses it. Applications never prompt for
a chain that is already satisfied.

**Session boundary.** A session ends only on explicit user action —
disconnecting a wallet, or logging out. It survives backgrounding, process
death, and app restart. Activation state is therefore persisted, not held in
memory: a user who backgrounds the app and returns is not re-prompted for a
chain they have already activated. Anything less makes stickiness meaningless.

## The app-wide wallet sheet

There is exactly one mounted wallet sheet in the product. Screens never own a
local instance. They open it with one of two intents:

- **Manage** — list only active, usable wallets; copy addresses; disconnect;
  or offer Solana-first onboarding when nothing is active.
- **Requirement** — supply the required chain and venue label. Render only that
  chain's actions, while reassuring the user that another active chain remains
  unchanged.

Active wallet rows are text-only: **Solana** or **EVM**, followed by
the source **External wallet** or **Privy**. They do not show chain-initial
badges or venue-specific usage text.

The available connection options are:

- **Connect an external wallet** — available only when the required chain has an
  external path. Today that means Solana only.
- **Continue with email** — authenticates Privy, then creates only the requested
  chain wallet.
- **Continue with Google** — the same chain-specific behavior through Google
  authentication.

What varies per application is which options render, driven by the chain
requirement:

| Application needs | External wallet | Email | Google |
|---|---|---|---|
| Solana | offered | offered | offered |
| Polygon / EVM | not offered — no mobile transport exists | offered | offered |

An EVM application therefore omits the external-wallet row. This is a filtering
outcome, not a separate screen. Adding an external EVM transport later is a
change to the availability rule and nothing else.

Requirement opening has a completion contract:

```ts
Promise<'satisfied' | 'cancelled'>
```

It resolves `satisfied` only after the requested chain is active and exposes a
usable signer. Dismissing the sheet resolves `cancelled`. Technical failures
reject. Application continuation is gated on `satisfied`; in particular,
Polymarket may call its setup/enable path only after the Polygon requirement
has returned that outcome.

## Dormancy

A user who logs in through an EVM application gets a Privy identity and a
Polygon wallet only when Polygon is activated. That user has expressed no
intent toward Solana, so no Solana wallet is created or shown.

So: **only active chains are surfaced.** A chain becomes active when the user
takes an action implying intent for it — connecting an external wallet on that
chain, or entering an application that requires it.

Activation is per chain and sticky within a session. It is not per application.
Once Solana is active it stays active until the user explicitly disconnects it;
entering a second Solana application does not re-prompt.

Because `createOnLogin` is configurable per chain and both wallet hooks expose
`create()`, dormancy is implemented as **deferred creation, not hidden
display**. A dormant chain has no wallet, and therefore no address that can
receive funds by accident. This is strictly safer than provisioning eagerly and
hiding the result, and it is the required implementation.

Deferred creation means a dormant chain should never hold a balance, because it
should never have an address. The Wallet surface still checks balances for any
provisioned-but-dormant chain and surfaces a non-zero one with an activation
prompt. This is a safety net, not an expected path: if it ever fires, deferred
creation has failed somewhere and that is a bug. Concealing a funded address
would be a correctness failure, so the check stays even though it should be
unreachable.

## Solana wallet coexistence and signer selection

An external Solana wallet may coexist with Privy-backed wallets, including a
Privy Polygon wallet. The active Solana source is explicit session state, not a
fallback preference hidden inside a transaction hook.

Disconnecting an external Solana wallet deactivates Solana. It must not silently
switch transactions to an embedded Solana wallet, even if one already exists.
The user must explicitly choose **Create Solana wallet** or **Use existing
Solana wallet**, as appropriate, before that signer becomes active. Every
transaction therefore retains the signer the user selected until an explicit
connection or disconnect action changes it.

Signing out of Privy disconnects every Privy-backed chain because those wallets
share authentication. A separately connected external Solana wallet remains
active and unchanged.

## The Wallet surface

Wallet is a top-level destination in the home screen, alongside Feed and
Apps/Markets. A visible global wallet control opens the manager in one tap from
Home, Feed, and every major venue root. Venue profile controls remain separate:
profile means application identity and positions; wallet means chain accounts
and connection state. Applications do not own connection UI; they trigger the
shared sheet when a requirement is unsatisfied.

The surface has two states over the same screen, not two products:

- **Nothing active** — it is a connection manager. It presents the connection
  modal and explains what connecting does.
- **Something active** — it is a portfolio and manager. Active chains, their
  addresses, balances, and positions. Switching or disconnecting a wallet is
  an explicit action taken here, never a per-application prompt. Dormant chains
  do not render as empty cards.

Portfolio depth is a scope dial. The surface owns the job; how much of it ships
first is a PRD question.

## Governing rules

Rules that constrain all future chain work. Enforce in review.

### A signature may AUTHORIZE a key. A signature must never BE a key.

Key material comes from a CSPRNG or a managed wallet provider. Signatures prove
that a durable identity approves a generated key — the model Hyperliquid uses
for agent wallets. Authorization material is safe to leak; key material is not.

Ed25519 signing is deterministic under RFC 8032: the same key over the same
message returns byte-identical output forever. Wallet apps log signatures,
support tickets contain screenshots of them, and session state holds them. A
signature is public data. Deriving a key from one means the key is public data
too, and it cannot be rotated without abandoning the account.

This rule exists because it was violated once. See the PRD's Problem section for
the specific instance.

### Applications declare requirements; they do not reach for a global

Every application states the chain and capabilities it needs, in the style of
`PerpsVenueDescriptor.capabilities` in
`apps/hybrid-expo/features/perps/perps.registry.ts`. No module-level mutable
wallet singleton may exist. A signer is obtained through the resolver, scoped to
the application that asked for it.

### Key material never leaves the device boundary

Never logged, never sent to our backend, never written to the clipboard.
Addresses may be logged; keys and signatures over fixed strings may not.

### Transaction adapters validate calldata before signing

The validation in `predict.signing.ts:262-286` is the required pattern for any
adapter that signs transactions, not an optional extra.

## Deliberate exclusions

Each of these is excluded for a stated reason. Revisit by amending this
document.

- **External EVM wallet connect (Reown / WalletConnect).** No mobile transport
  today. The connection modal is built as a filtered list so this can be added
  without restructuring.
- **MWA EVM support.** Not available in the protocol. Not actionable by us.
- **ERC-4337 smart accounts.** Correct long-term direction; deferred on cost and
  chain support.
- **Seed-phrase-backed self-custody EVM as a user-facing product.** A social-auth
  user must retain full signing ability with no seed phrase and no external
  wallet. Any design that asks an email or Google user to record a seed phrase in
  order to use an application is out of scope.
- **Bridging.** How value moves between chains is a separate concern.

## Trust boundaries

Not all credentials are equivalent, and reviews should not conflate them.

**Account-level key material** — controls funds, cannot be revoked. Governed by
every rule above.

**Protocol session credentials** — for example Polymarket CLOB L2 credentials,
which can place and cancel orders but cannot move funds out, and are revocable.
A deliberately lower tier. These may be held server-side.

## References

### Internal

- `apps/hybrid-expo/providers/PrivyProvider.tsx` — embedded wallet config
- `apps/hybrid-expo/features/perps/perps.registry.ts` — capability descriptor
  pattern this model follows
- `apps/hybrid-expo/features/predict/predict.signing.ts` — calldata validation
  pattern

### External

- [Mobile Wallet Adapter specification](https://github.com/solana-mobile/mobile-wallet-adapter/blob/main/spec/spec.md) — chain scope is Solana-only
- [Privy React Native quickstart](https://docs.privy.io/basics/react-native/quickstart) — embedded wallets across Ethereum and Solana
- [Privy Expo Solana wallet creation](https://docs.privy.io/guide/expo/embedded/solana/creation) — `create()` for on-demand provisioning
- [Hyperliquid nonces and API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets) — authorize-a-generated-key pattern
