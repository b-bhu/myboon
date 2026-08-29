# Wallet Connectivity Model

Status: current functionality
Last amended: 2026-08-15
Owner: myboon Apps
Scope: how myboon exposes, activates, resolves, and manages wallets for Solana

This is the durable product and engineering contract for wallet connectivity.
The behavior below is the completed baseline, not a list of proposed work.
Application PRDs may depend on it without reopening wallet presentation,
authentication, chain selection, or signer-precedence decisions.

## The model in one paragraph

Wallets belong to the myboon session, not to an individual venue. An
application declares the chain and signing capabilities it needs, and the
connectivity layer either returns an already-active signer or opens the single
app-wide wallet sheet for that requirement. Privy authentication is shared,
but its Solana and Polygon wallets are created only when the user explicitly
activates that chain. External wallets are supported for Solana through Mobile
Wallet Adapter. The global manager shows every active chain; an application
requirement shows only the chain that application needs.

## Product language

User-facing copy uses these terms consistently:

- **Solana wallet** — a wallet used by Spot, Meteora, Phoenix, Pacifica, and
  other Solana applications.
- **Polygon wallet** — the myboon wallet used by Polymarket.
- **External wallet** — a Solana wallet connected through Mobile Wallet
  Adapter.
- **myboon wallet** — an embedded wallet reached through email or Google.
- **Connect wallet** — the global action when no chain is active.
- **Wallets** — the global action when one or more chains are active.

Do not expose “EVM,” “backend,” “provisioned,” “entropy,” or “activation” as
primary product language. Those terms remain valid in code and diagnostics.

## State vocabulary

**Backend** — the system holding key material. The supported backends are Privy
embedded wallets and external wallets reached through Mobile Wallet Adapter.

**Provisioned** — key material exists for a chain. For Privy, the embedded
wallet has been created. For an external wallet, the user has authorized the
connection.

**Active** — the user explicitly selected that chain and signer for the current
session. Only active, usable chains appear in the global Wallets manager and
may satisfy application requirements.

**Dormant** — a chain is not active. Authentication alone does not make a chain
active and must not make it appear connected.

**Requirement** — an application's declaration of the chain and signing
capabilities it needs.

Provisioned and active are independent. A provisioned wallet can be dormant; a
chain cannot be active unless its signer is usable.

## Supported wallet backends

### Privy embedded wallets

Email or Google establishes one Privy identity. It does not automatically
create wallets on every supported chain. Both embedded wallet hooks use
deferred creation:

- entering a Solana application can create or activate the Privy Solana wallet;
- entering Polymarket can create or activate the Privy Polygon wallet;
- activating one chain does not create, activate, or display the other.

An already-authenticated user is not asked to authenticate again. The relevant
requirement sheet offers **Enable Polygon wallet**, **Create Solana wallet**, or
**Use myboon wallet**, depending on existing state.

Signing out of Privy disconnects every active Privy-backed chain because those
wallets share authentication. A separately connected external Solana wallet
remains active and unchanged.

### External wallets

External wallet connectivity is Solana-only through Mobile Wallet Adapter.
External EVM/Polygon accounts are not reachable through that transport, even
when the installed wallet application holds them.

Consequently:

- Solana requirements may offer an external wallet, email, or Google;
- Polygon requirements offer email or Google only;
- a connected external Solana wallet never satisfies or hides a Polygon
  requirement.

## Session and activation

Activation is per chain and sticky within the session. It survives
backgrounding, process death, and app restart. The explicit session boundaries
are disconnecting a wallet and signing out of Privy.

A chain becomes active only through a user action that expresses intent:

- connecting an external wallet for that chain;
- creating or selecting a myboon wallet for that chain; or
- satisfying an application's requirement for that chain.

Authentication is not activation. A dormant chain has no active row, no active
badge, and no implication that it can transact.

Privy wallets are created on demand rather than eagerly created and hidden.
This prevents an unused chain from acquiring an undisclosed deposit address.
If a provisioned-but-dormant address is ever found with a non-zero balance, the
manager surfaces it as a safety exception with an explicit activation action.

## Requirement resolution contract

Applications obtain wallets through the requirement resolver. They never read
an arbitrary global address and never mount their own connection sheet.

```text
1. Requested chain is active and has the required capability
   -> return the active signer without prompting
2. Requested chain can be activated for an authenticated Privy user
   -> open that chain's enable/use presentation
3. Requested chain has no usable signer
   -> open that chain's connection options
4. A recorded wallet cannot sign on this device
   -> show the neutral recovery presentation
```

Opening a requirement has this completion contract:

```ts
type WalletRequirementOutcome = 'satisfied' | 'cancelled';

openForRequirement(input: {
  chain: 'solana' | 'evm';
  applicationLabel: string;
}): Promise<WalletRequirementOutcome>;
```

The promise resolves `satisfied` only after the requested chain is active and
exposes a signer with the declared capabilities. Dismissal resolves
`cancelled`. Technical failures reject. The calling application resumes its
action only after `satisfied`; cancellation and failure preserve the calling
screen's state.

For Polymarket, `poly.enable()` or equivalent account setup runs only after the
Polygon requirement is satisfied. This avoids callback, ref, and timing races.

## The canonical app-wide wallet sheet

There is exactly one mounted wallet sheet. Every screen uses its provider; no
venue, profile, or detail screen owns a local copy.

It has two explicit intents:

```ts
type WalletSheetIntent =
  | { kind: 'manage' }
  | {
      kind: 'requirement';
      chain: 'solana' | 'evm';
      applicationLabel: string;
    };
```

### Management intent

Management answers: **Which wallets is myboon actively using?**

- Show one card per active chain, Solana first.
- Show the chain, truncated address, source, copy action, and appropriate
  disconnect/manage action.
- Show all active chains regardless of which screen opened the manager.
- Do not show dormant chains as connected or render empty chain placeholders.
- When nothing is active, show Solana-primary onboarding with email, Google,
  and external-wallet choices. Do not promote Polygon until the user enters a
  Polygon application.

The state matrix is:

| Active session state | Global Wallets manager |
|---|---|
| No wallet | Solana-primary onboarding; no empty chain cards |
| External Solana only | Solana card · External wallet |
| myboon Solana only | Solana card · myboon wallet |
| myboon Polygon only | Polygon card · myboon wallet |
| myboon Solana + myboon Polygon | Two cards |
| External Solana + myboon Polygon | Two cards; external remains Solana signer |
| External Solana + myboon Solana + myboon Polygon | Two active-chain cards; do not expose a Solana switcher |
| External Solana + authenticated Privy, Polygon dormant | Solana card only |

One chain produces one active card. Multiple Solana backends describe
provenance and dormant state; they are not multiple selectable signers in this
version.

### Requirement intent

Requirement mode answers: **What wallet does this application need now?**

- Show only the requested chain's choices and actions.
- Use a context rail in the form `APPLICATION · CHAIN`.
- Never show an unrelated chain as a wallet row.
- Another active chain may be acknowledged with one quiet reassurance sentence.
- If the requirement is already satisfied, do not open the sheet.

#### Polygon application

Polymarket opens a Polygon requirement and renders:

- rail: **POLYMARKET · POLYGON**;
- title: **Connect Polygon wallet**;
- explanation that Polymarket uses Polygon for orders, deposits, and payouts;
- **Continue with email** and **Continue with Google** when authentication is
  needed;
- **Enable Polygon wallet** when the user is already authenticated;
- **Your Solana wallet stays connected and unchanged** only when Solana is
  active.

No Solana card, Solana disconnect action, or external-wallet option appears in
this presentation. During creation, the action shows **Creating your Polygon
wallet…**. Success briefly shows **Polygon wallet ready**, closes the sheet,
and resolves the waiting application requirement.

#### Solana application

Spot, Meteora, Phoenix, Pacifica, and other Solana applications open a Solana
requirement and render:

- rail such as **SPOT · SOLANA** or **METEORA · SOLANA**;
- title: **Connect Solana wallet**;
- **Continue with email** and **Continue with Google**;
- **Connect external wallet**;
- an enable/use action instead of authentication when the user is already
  authenticated and a myboon Solana wallet can be activated.

No Polygon address, Polygon status, Polymarket profile, or EVM terminology
appears in this presentation.

## Global visibility and venue profiles

Every major Home, Feed, and venue-root screen exposes wallet management in one
top-bar tap:

- no active chain: wallet icon + **Connect wallet**;
- one or more active chains: wallet icon + **Wallets**;
- accessible labels: **Connect wallet** or **Manage wallets**.

The control derives its state from all active chains, never from Solana alone.
An active Polygon-only user therefore sees **Wallets**, not a disconnected
avatar or Connect state.

Wallet management and venue identity remain separate controls:

- **Wallets** manages chain accounts and connection state;
- a venue profile opens that venue's positions, orders, deposits, and settings.

The controls must have distinct visible or accessible labels and must never be
represented by two visually identical identity avatars.

## Solana coexistence and signer selection

An external Solana wallet can coexist with myboon Solana and Polygon wallets.
When external Solana is active, it remains the active Solana signer. Logging
into Privy for Polygon does not replace it and does not create a Solana wallet
unless the user explicitly requests one.

Disconnecting external Solana deactivates Solana. The system does not silently
fall back to a provisioned myboon Solana wallet. A later Solana action opens the
requirement sheet and asks the user to choose **Use myboon wallet** or connect
an external wallet. A transaction never changes signer without explicit user
action.

## Recovery behavior

The repository does not establish which Privy recovery method is configured in
the Privy dashboard. Product copy therefore does not promise iCloud, Google
Drive, passcode, recovery key, or any other method-specific recovery.

When Privy records a wallet that cannot sign on the current device:

- show **Wallet unavailable on this device**;
- do not call wallet creation again or imply the chain is connected;
- keep the user in the same contextual sheet;
- provide the configured myboon support path;
- introduce a method-specific recovery action only after that method is
  verified and implemented end to end.

## Signing and capability honesty

An active signer is returned only when it satisfies the requesting
application's declared capabilities. Address presence alone is insufficient.

- Solana transaction applications require transaction signing and a supported
  broadcast path.
- Polygon applications use the Privy EVM provider for their declared message,
  typed-data, or transaction capability.
- Capability tables reflect device-verified behavior and never route an
  application to a method that throws “unsupported.”
- Every transaction adapter validates the operation it asks the wallet to sign.

## Governing security rules

### Applications declare requirements

Applications obtain signers through the resolver, scoped to the application
that requested them. No module-level mutable wallet singleton may choose a
wallet implicitly.

### A signature authorizes a key; it is never key material

Signatures are public authorization material. Never derive durable private-key
material from a deterministic signature.

### Key material stays inside its provider boundary

Private keys are never logged, copied, returned by application APIs, or sent to
myboon servers. Addresses may be displayed and copied. Sensitive signing
payloads and signatures over fixed strings are not diagnostic identifiers.

### Transactions are validated before signing

Every transaction adapter decodes and validates the operation, expected chain,
program or contract, accounts, recipient, amount constraints, and authority
changes before invoking the signer. A server-built payload is not trusted merely
because it came from a myboon endpoint.

## Deliberate exclusions

- External EVM/Polygon connection through WalletConnect or Reown.
- EVM support through Mobile Wallet Adapter.
- A Solana wallet switcher when external and myboon Solana wallets coexist.
- Automatic signer fallback after disconnect.
- Eager creation of every Privy chain wallet at login.
- ERC-4337 smart accounts.
- Seed-phrase onboarding for email or Google users.
- Bridging and cross-chain balance movement.

These are product-boundary decisions. A future change requires an amendment to
this specification rather than a venue-specific exception.

## Trust boundaries

**Account-level key material** controls funds and cannot be revoked. It follows
every rule above.

**Protocol session credentials**, such as Polymarket CLOB credentials, are
revocable and may place or cancel orders without holding the user's private
wallet key. They are a deliberately lower trust tier and must not be treated as
wallet key material.

## References

### Internal

- `apps/hybrid-expo/providers/PrivyProvider.tsx` — deferred embedded-wallet
  creation configuration
- `apps/hybrid-expo/features/chain/` — requirement, activation, capability, and
  signer resolution
- `apps/hybrid-expo/features/wallet/WalletSheetProvider.tsx` — canonical sheet
  ownership and completion contract
- `apps/hybrid-expo/features/wallet/components/ConnectionSheet.tsx` — shared
  management and requirement presentations
- `apps/hybrid-expo/features/predict/predict.signing.ts` — transaction
  validation posture

### External

- [Mobile Wallet Adapter specification](https://github.com/solana-mobile/mobile-wallet-adapter/blob/main/spec/spec.md)
- [Privy React Native quickstart](https://docs.privy.io/basics/react-native/quickstart)
- [Privy Expo Solana wallet creation](https://docs.privy.io/guide/expo/embedded/solana/creation)
