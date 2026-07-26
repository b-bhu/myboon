# Wallet Connectivity Restructure PRD

Status: ready for issue breakdown
Date: 2026-07-26
Owner: myboon Apps
Supersedes: EVM Wallet Layer PRD (2026-07-26, migration-oriented draft)

This is a change plan. It describes work to be done and stops being read once
the work lands. How the system works after this ships is specified in
`docs/modules/wallet/specs/wallet_connectivity.md` — that document is durable
and is the one to amend when the model changes.

Rule for keeping the two apart: **does this sentence stay true after the work
ships?** If yes it belongs in the spec. If it describes a transition, it belongs
here.

## Why this changed

The previous draft was written around two assumptions that no longer hold:

1. **Existing users with funds at risk.** myboon has zero users. There is no
   migration, no fund sweep, no disclosure obligation, and no incident response.
   The derivation flaw is now dead code to delete rather than a live P1. This
   removes the largest and riskiest section of the previous draft, and with it
   the argument for shipping a security fix ahead of the UI work. The two are
   now one change.

2. **Custody split by user identity.** The previous model gave Privy users a
   Privy EVM wallet and MWA users a random device-bound key in
   `expo-secure-store`. The model is now split by chain requirement instead:
   EVM is satisfied by Privy only, because MWA cannot reach EVM. This deletes
   the device-bound key backend entirely — no secure-store key, no idle-sweep
   policy, no device-loss-is-fund-loss warning, no reinstall edge case.

One consequence to accept deliberately: a user who connects an external Solana
wallet and never logs into Privy will hit a Privy login when they open an EVM
application. Under the old derivation hack they got an EVM key for free. That
hack is exactly what we are removing, so this cost is the honest price of not
shipping signature-derived keys. Accepted.

## What is being removed

### The signature-derived EVM key

`apps/hybrid-expo/hooks/useEvmSigner.ts:16-22` derives the Polymarket EVM key
as:

```text
evmPrivateKey = keccak256( ed25519_sign( solanaKey, "myboon:polymarket:enable" ) )
```

`PREDICT_DERIVE_MESSAGE` is a hardcoded constant that ships in every JS bundle
and is recoverable from any release APK. Ed25519 is deterministic, and the
message carries no domain separator, nonce, timestamp, or origin binding — so
any dApp that gets the same Solana wallet to sign the same bytes recomputes the
key. The derived EOA owns everything downstream:
`packages/api/src/polymarket/trading/routes/session.ts:57` derives the deposit
wallet CREATE2-deterministically from it.

The key cannot be rotated. It is a pure function of the Solana key and a fixed
string.

With zero users this is contained. It is still deleted in full, and the rule it
violated is recorded in the spec under Governing Rules.

Root cause was a missing abstraction, not a crypto slip: there was no shared EVM
signer, so Predict built its own.

### The module-level signer singleton

`useEvmSigner.ts` exposes a mutable module-level `activeEvmWallet` that any
importer can pull from, with no notion of which application is asking, which
chain is targeted, or what the signer may do. A second EVM integration has
nothing to adopt and would write its own variant.

### The clipboard export path

`apps/hybrid-expo/features/predict/components/PredictOwnerKeyExportModal.tsx:102`
writes the raw private key to the system clipboard. The reset-on-background
guard at lines 62-65 does not clear clipboard contents. Gboard clipboard history
and iOS Universal Clipboard both persist and sync it off-device.

With Privy embedded wallets there is no raw key to export, so this modal is
removed rather than repaired.

### The unfenced E2E stub

`apps/hybrid-expo/hooks/useWallet.native.ts:24` returns
`new Uint8Array(64).fill(1)` when `EXPO_PUBLIC_PREDICT_E2E === '1'`. Every user
in that mode derives one identical, publicly computable key. `EXPO_PUBLIC_`
variables are inlined at build time, so a misconfigured release build would put
all users on a single known wallet.

The stub stays for E2E. The build must fail if the flag survives into a release
build.

### The global Privy-over-MWA precedence

`apps/hybrid-expo/hooks/useWallet.native.ts:41` short-circuits on
`privy.isPrivyUser` and ignores any cached MWA account. A user is therefore
either a Privy user or an MWA user, never both. This model requires both at
once — an external Solana wallet alongside a Privy EVM wallet — so a single
global wallet identity with Privy winning is incompatible with per-chain
resolution and must go. How it is restructured (removed outright, or scoped per
chain) is an implementation decision to be taken in its own issue, not here.
Acceptance criterion 10 and TC-SESSION-003 both depend on it.

### The app drawer as connection surface

Connection moves out of the side drawer and into the Wallet destination on the
home screen. The drawer's connection entry point is removed.

## What is being built

The target system is specified in
`docs/modules/wallet/specs/wallet_connectivity.md`. Read it
before starting any issue below. In summary: applications declare a chain
requirement; the resolver satisfies it from session-scoped per-chain
connections; unsatisfied requirements open one shared connection modal filtered
by what the chain supports; only chains the user has expressed intent for are
provisioned and surfaced.

### 1. Enable Privy EVM alongside Solana

`apps/hybrid-expo/providers/PrivyProvider.tsx:12-18` currently enables only
`embedded.solana`. Add `ethereum`.

`createOnLogin` is configurable independently per chain, and both
`useEmbeddedEthereumWallet()` and `useEmbeddedSolanaWallet()` expose a
`create()` method. This is what makes deferred per-chain provisioning possible
and it is the required implementation — a dormant chain has no wallet and
therefore no address that can receive funds by accident.

Set `createOnLogin` so that no chain is created eagerly at login. Provision on
activation via `create()`.

Cost note for review: Privy bills per monthly active wallet. Deferred creation
is the cheaper posture as well as the safer one.

### 2. Chain requirement descriptors

Applications declare what they need, following
`PerpsVenueDescriptor.capabilities` in
`apps/hybrid-expo/features/perps/perps.registry.ts`.

```ts
export type Chain = 'solana' | 'evm';
export type WalletBackend = 'privy_embedded' | 'external_mwa';

export interface ChainRequirement {
  applicationId: string;
  chain: Chain;
  chainId?: number;           // EVM only
  needsTypedData: boolean;
  needsRawTransaction: boolean;
}

export const POLYMARKET_REQUIREMENT: ChainRequirement = {
  applicationId: 'polymarket',
  chain: 'evm',
  chainId: 137,
  needsTypedData: true,
  needsRawTransaction: false,
};
```

### 3. Signer contract and resolver

A single signer interface with a descriptor exposing durability properties, so
features decide whether to warn before a user parks value rather than
hardcoding assumptions about custody.

```ts
export interface SignerDescriptor {
  backend: WalletBackend;
  chain: Chain;
  address: string;
  chainId?: number;
  canSignMessage: boolean;
  canSignTypedData: boolean;
  canSendTransaction: boolean;
  survivesReinstall: boolean;
  survivesDeviceLoss: boolean;
}
```

Resolver, per the spec's Resolution section:

```ts
export function useChainSigner(requirement: ChainRequirement): {
  signer: Signer | null;
  status: 'ready' | 'needs_connection' | 'preparing' | 'unsupported';
  reason: string | null;
  connect: () => Promise<void>;
};
```

```text
1. chain active                 -> ready
2. chain provisioned, dormant   -> activate, then ready
3. neither                      -> needs_connection
4. no backend can satisfy       -> unsupported + human-readable reason
```

`unsupported` returns a reason string; it does not throw.

### 4. The shared connection modal

One modal, built as a **list of available options** rather than a
Privy-branded screen. Options are filtered by the requirement's chain:

| Chain | External wallet | Privy |
|---|---|---|
| `solana` | offered | offered |
| `evm` | not offered | offered |

The EVM case renders a single option. That must be a filtering outcome of the
list, not a separate component. Adding an external EVM transport later should be
a change to the availability rule and nothing else.

### 5. The Wallet destination

New top-level destination on the home screen alongside Feed and Apps/Markets.
Two states over one screen:

- **Nothing active** — connection manager. Presents the modal, explains what
  connecting does.
- **Something active** — portfolio. Active chains, addresses, balances,
  positions. Switching and disconnecting happen here and only here.

Scope for this PRD: connection management complete; portfolio at address and
balance level per active chain. Positions and history are a follow-on.

Include the funded-dormant-chain check: if any provisioned-but-dormant chain has
a non-zero balance, surface it with an activation prompt. With deferred creation
this should be unreachable, which is the point — it is a safety net, and if it
ever fires we have a provisioning bug.

### 6. Remove the drawer connection entry point

After the Wallet destination ships. The drawer keeps its other responsibilities.

### 7. Polymarket becomes the first consumer

`predict.signing.ts` stops importing from `useEvmSigner.ts` and takes a `Signer`
from the resolver. `useEvmSigner.ts` is deleted.

Its existing `validateDepositWalletSignatureRequest` calldata validation
(`predict.signing.ts:262-286`) is unchanged and stays. It is a genuinely good
defence and the spec names it as the required pattern for future adapters.

### 8. Fence the E2E stub

Build-time guard making `EXPO_PUBLIC_PREDICT_E2E=1` and a production build
mutually exclusive. The build fails rather than shipping the shared key.

## Acceptance criteria

- [ ] `apps/hybrid-expo/hooks/useEvmSigner.ts` is deleted. No module-level
      mutable wallet singleton remains anywhere in the app.
- [ ] No code path constructs private key material from a signature. A repo-wide
      search for `keccak256` applied to signature bytes returns no hits.
- [ ] `PREDICT_DERIVE_MESSAGE` does not appear in the codebase.
- [ ] `predict.signing.ts` compiles with no reference to Solana signatures.
- [ ] Private key material never reaches `Clipboard.setStringAsync`.
      `PredictOwnerKeyExportModal.tsx` is removed.
- [ ] A production build with `EXPO_PUBLIC_PREDICT_E2E=1` fails to build.
- [ ] A fresh Privy login provisions no wallet on any chain until a chain is
      activated.
- [ ] A user who logs in via Polymarket has an active EVM chain and no Solana
      wallet in existence. The Wallet destination shows EVM only.
- [ ] That same user opening a Solana application is prompted once, activates
      Solana, and Solana then persists as active without further prompts.
- [ ] A user who connects an external Solana wallet and then opens Polymarket is
      prompted with a Privy-only modal, and the Solana connection is untouched
      by that flow.
- [ ] The connection modal renders from a filtered option list. Adding a
      hypothetical external EVM option requires changing only the availability
      rule.
- [ ] Adding a hypothetical second EVM application requires a new requirement
      descriptor and no resolver change.
- [ ] Requesting a signer for a requirement no backend can satisfy returns
      `unsupported` with a human-readable reason, not a thrown error.
- [ ] No connection entry point remains in the app drawer.

## Testing plan

- Unit: resolver returns the correct status for each of the four branches.
- Unit: `SignerDescriptor` flags are correct per backend.
- Unit: connection modal option filtering — `solana` yields two options, `evm`
  yields one.
- Unit: activation is sticky per chain and does not re-prompt.
- Integration: EIP-712 signature from the Privy EVM backend verifies to the
  expected address.
- Integration: a full Polymarket lifecycle — enable, buy, sell, withdraw — on a
  Privy account.
- Integration: Solana connection via MWA is unaffected by an EVM activation in
  the same session.
- Build: release build with the E2E flag set fails.
- Manual, real device: MWA connect and sign with Phantom; Privy passkey login;
  full Predict lifecycle on mainnet with small size.

## Open decisions

1. **Portfolio depth in the Wallet destination for this pass.** Addresses and
   balances are specified. Whether positions and transaction history land in the
   same pass or a follow-on is a scope call.
2. **Does activation ever reverse?** Disconnecting an external wallet is
   obviously supported. Whether a Privy-provisioned chain can be deactivated —
   and what that means for a wallet that already exists — is undecided.
   Recommend: not in v1.
3. **Copy for the Privy-only EVM modal.** A user who has already connected
   Phantom will reasonably ask why their wallet is not offered. The answer —
   mobile wallets cannot sign EVM through the connection protocol they support —
   is true but not one line of UI copy. Needs a product pass.

## Unresolved side thread

Not part of this restructure; recorded so it is not lost.

An "Predict could not create Polymarket API credentials." alert fires
client-side at `predict.signing.ts:325`, before `/clob/auth` is called, so the
backend is not involved. Both `deriveApiKey()` and `createApiKey()` resolved
with non-creds values from `clob.polymarket.com`. The alert ended in a bare "."
meaning `failures` was empty — neither value was an Error nor had a string
`error` field, consistent with a Cloudflare/geoblock HTML 403 or an L1 auth
rejection.

Suggested fix: widen `apiCredsFailureMessage` (`predict.signing.ts:105`) to
stringify unknown shapes and capture HTTP status, so the next occurrence is
diagnosable. File separately.

## References

### Internal

- `docs/modules/wallet/specs/wallet_connectivity.md` — the durable model this
  PRD builds toward
- `apps/hybrid-expo/hooks/useEvmSigner.ts` — derivation, to be deleted
- `apps/hybrid-expo/hooks/usePolymarketWallet.ts` — enable flow
- `apps/hybrid-expo/hooks/usePrivyWallet.ts` — Privy adapter
- `apps/hybrid-expo/hooks/useWallet.native.ts` — E2E stub to fence
- `apps/hybrid-expo/providers/PrivyProvider.tsx` — embedded wallet config
- `apps/hybrid-expo/features/predict/predict.signing.ts` — signing and calldata validation
- `apps/hybrid-expo/features/predict/components/PredictOwnerKeyExportModal.tsx` — export path to remove
- `apps/hybrid-expo/features/perps/perps.registry.ts` — descriptor pattern
- `packages/api/src/polymarket/trading/routes/session.ts` — deposit wallet derivation

### External

- [Mobile Wallet Adapter specification](https://github.com/solana-mobile/mobile-wallet-adapter/blob/main/spec/spec.md)
- [Privy React Native quickstart](https://docs.privy.io/basics/react-native/quickstart)
- [Privy Expo Solana wallet creation](https://docs.privy.io/guide/expo/embedded/solana/creation)
