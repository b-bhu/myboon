# Wallet Connectivity Model

Status: living specification
Last amended: 2026-07-26
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
shared by every application that needs the same chain. When a requirement cannot
be satisfied, the layer presents one connection modal whose available options
are filtered by what that chain actually supports.

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

### Privy — universal

One social or passkey login provisions wallets on every supported chain under a
single user identity. A Privy user has no chain-specific connection step
anywhere in the product. They log in once; Solana applications work, EVM
applications work, and a chain added next year works without the user doing
anything.

Privy exposes `useEmbeddedEthereumWallet()` and `useEmbeddedSolanaWallet()`,
each with a `create()` method, and `createOnLogin` is configurable
independently per chain in the provider config. This is what makes lazy
per-chain provisioning possible — see Dormancy below.

Privy embedded wallets are recoverable across devices and survive reinstall.

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
1. Chain is active            -> use the connected wallet, no prompt
2. Chain is provisioned only  -> activate, then use it
3. Neither                    -> present the connection modal
```

Resolution is per chain and session-scoped. Connect a Solana wallet once and
every Solana application in that session uses it. Applications never prompt for
a chain that is already satisfied.

**Session boundary.** A session ends only on explicit user action —
disconnecting a wallet, or logging out. It survives backgrounding, process
death, and app restart. Activation state is therefore persisted, not held in
memory: a user who backgrounds the app and returns is not re-prompted for a
chain they have already activated. Anything less makes stickiness meaningless.

## The connection modal

There is one connection modal in the product, not one per chain. It offers:

- **Connect an external wallet** — available only when the required chain has an
  external path. Today that means Solana only.
- **Continue with Privy** — always available, on every chain.

What varies per application is which options render, driven by the chain
requirement:

| Application needs | External wallet | Privy |
|---|---|---|
| Solana | offered | offered |
| EVM | not offered — no mobile transport exists | offered |

An EVM application therefore shows a single-option modal. This is a filtering
outcome, not a separate screen. The modal must be built as a list of available
options rather than a Privy-branded screen, so that adding an external EVM
transport later is a change to the availability rule and nothing else.

## Dormancy

A user who logs in through an EVM application gets Privy wallets. Privy can
provision Solana at the same time. That user has expressed no intent toward
Solana, does not know a Solana address exists, and has no mental model for it.
Showing it would be presenting the user with an account they did not ask for —
and if they funded it, real value would sit somewhere they do not understand.

So: **only active chains are surfaced.** A chain becomes active when the user
takes an action implying intent for it — connecting an external wallet on that
chain, or entering an application that requires it.

Activation is per chain, sticky, and one-way within a session lifecycle. It is
not per application. Once Solana is active it stays active; entering a second
Solana application does not re-prompt.

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

## The Wallet surface

Wallet is a top-level destination in the home screen, alongside Feed and
Apps/Markets. It is the only place a user manages connections. Applications do
not own connection UI; they trigger the shared modal when a requirement is
unsatisfied.

The surface has two states over the same screen, not two products:

- **Nothing active** — it is a connection manager. It presents the connection
  modal and explains what connecting does.
- **Something active** — it is a portfolio. Active chains, their addresses,
  balances, and positions. Switching or disconnecting a wallet is an explicit
  action taken here, never a per-application prompt.

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
  wallet. Any design that asks a passkey or email user to record a seed phrase in
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
