# EVM Wallet Layer PRD

Status: decision-aligned draft for review
Date: 2026-07-26
Owner: myboon Apps
Chain posture: Solana-first, EVM as a supported second surface
Security classification: contains an active P1 remediation (Phase 1)

## Purpose

Give myboon one answer to the question "this app needs an EVM wallet", so that
every EVM integration stops inventing its own key handling.

Today there is no shared EVM signer concept. The Polymarket Predict feature
needed an EVM key, found nothing to reuse, and derived one inline from a Solana
signature. That inline scheme is the P1 described below. The scheme is the
symptom; the missing layer is the cause.

The target shape:

```text
Solana identity (MWA or Privy)
  -> chain signer resolver
  -> EVM signer (Privy embedded | device secure store)
  -> protocol adapter (Polymarket today, other EVM apps later)
```

myboon stays Solana-first. Solana remains the user's identity and the place
value comes to rest. EVM is plumbing that some apps require, provisioned on
demand, and never presented as a second wallet the user has to manage.

This PRD covers two phases in one document:

- Phase 1 contains the live P1 and moves user funds off compromised keys.
- Phase 2 builds the shared layer and moves Polymarket onto it.

## Problem

### 1. The Predict EVM private key is a signature over a public constant

`apps/hybrid-expo/hooks/useEvmSigner.ts:16-22` derives the EVM key as:

```text
evmPrivateKey = keccak256( ed25519_sign( solanaKey, "myboon:polymarket:enable" ) )
```

`PREDICT_DERIVE_MESSAGE` is a hardcoded constant. It ships inside every JS
bundle and is recoverable from any release APK. It is not secret and cannot be
made secret.

The derived EOA owns everything downstream. `packages/api/src/polymarket/trading/routes/session.ts:57`
derives the Polymarket deposit wallet CREATE2-deterministically from that EOA,
so the chain is:

```text
solana signature -> EVM private key -> deposit wallet -> user funds
```

### 2. Signatures are treated as public data everywhere else in the ecosystem

Ed25519 signing is deterministic under RFC 8032. The same key over the same
message returns byte-identical output forever. That determinism is what makes
the current scheme reproducible, and it is also what makes it dangerous: a
value that the entire wallet ecosystem treats as public verification material
has been promoted to non-rotatable key material.

Wallet apps log signatures. Support tickets contain screenshots of them. MWA
session state holds them. Any one of those is a permanent key compromise.

### 3. Any third party can harvest the key

The signed message carries no domain separator, no nonce, no timestamp, and no
origin binding. Any other dApp, site, or wallet session can present the same
bytes to the same Solana wallet, receive the identical signature, and compute
`keccak256(sig)` to obtain the user's Predict owner key.

The attack requires no transaction, no gas, and no token approval. The victim
sees an ordinary message-signing prompt. Our own copy at
`apps/hybrid-expo/app/predict-profile.tsx:392-395` actively teaches users that
this prompt is safe:

```text
One signature to verify ownership
No transaction, no gas, no cost
No extra seed phrases or wallets to manage
```

A phishing prompt is visually indistinguishable from the legitimate one.

### 4. The key cannot be rotated

The key is a pure function of the Solana key and a fixed string. A user cannot
rotate without changing Solana wallets. We cannot rotate by changing the
constant without stranding funds at the previous EOA. Once exposed, an account
is permanently exposed.

### 5. Mobile Wallet Adapter cannot reach EVM at all

The MWA specification is Solana-only. `authorize` accepts `solana:mainnet`,
`solana:testnet`, and `solana:devnet`. Other chain types are described as
envisioned, not shipped.

Phantom mobile does hold Ethereum, Base, Polygon, and HyperEVM accounts, but
those accounts are unreachable through MWA. "Ask the user's existing wallet to
sign the EVM action" is therefore not an available option for MWA users, and
signature derivation was almost certainly chosen for this reason.

### 6. There is no shared EVM signer concept

`useEvmSigner.ts` is Predict-specific in everything but its name. It exposes a
module-level singleton `activeEvmWallet` that any importer can pull from, with
no notion of which protocol is asking, which chain is targeted, or what the
signer is permitted to do. A second EVM integration has nothing to adopt and
will write its own variant.

### 7. Secondary exposure points

- `apps/hybrid-expo/features/predict/components/PredictOwnerKeyExportModal.tsx:102`
  copies the raw private key to the system clipboard. The reset-on-background
  guard at lines 62-65 does not clear clipboard contents. Gboard clipboard
  history and iOS Universal Clipboard both persist and sync it off-device.
- `apps/hybrid-expo/hooks/useWallet.native.ts:24` returns
  `new Uint8Array(64).fill(1)` when `EXPO_PUBLIC_PREDICT_E2E === '1'`. Every
  user in that mode derives one identical, publicly computable key.
  `EXPO_PUBLIC_` variables are inlined at build time, so a misconfigured
  release build would place all users on a single known wallet.
- The `__DEV__` log at `useEvmSigner.ts:36` prints the address only. This one
  is acceptable and needs no change.

### 8. What is not in scope as a problem

The CLOB API credentials sent to our backend at
`apps/hybrid-expo/hooks/usePolymarketWallet.ts:257` and held in memory at
`packages/api/src/polymarket/trading/routes/session.ts:94` are L2 trading
credentials. They can place and cancel orders. They cannot move funds out, and
they are revocable. This is a deliberate trust boundary and a different, lower
severity tier. It is recorded here so reviewers do not conflate it with the P1.

## Governing Rule

One rule generalises the fix and should be enforced in review for all future
chain work:

```text
A signature may AUTHORIZE a key.
A signature must never BE a key.
```

Key material is generated from a CSPRNG or by a managed wallet provider.
Signatures are used to prove that a durable identity approves a generated key,
which is the model Hyperliquid uses for agent wallets. Authorization material
is safe to leak; key material is not.

## Decision Summary

Decisions taken before this draft. Each is settled unless a reviewer reopens it.

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Custody for Privy users | Privy embedded EVM wallet | `@privy-io/expo` is already a dependency and provisions Ethereum and Solana wallets under one user DID |
| 2 | Custody for MWA users | Random key in device secure store | MWA cannot reach EVM; `expo-secure-store` is already a dependency |
| 3 | Is the EVM account a user-facing product? | No | It is plumbing. Social-auth users must keep full signing ability with no seed phrase and no external wallet |
| 4 | Delivery | One PRD, two phases | Phase 1 contains the P1, Phase 2 builds the layer |
| 5 | Derivation from signatures | Prohibited | See Governing Rule |
| 6 | External EVM wallet connect | Deferred | Breaks Solana-first UX as a default; revisit as a power-user path |
| 7 | ERC-4337 smart accounts | Deferred | Correct north star, wrong cost today |

Decision 3 is the constraint that rules out several otherwise attractive
designs. Any option that asks a passkey or email user to record a seed phrase
in order to use an EVM app is out of scope.

## Custody Model

Two custody backends, one interface. The resolver picks the backend from the
user's existing auth source, and no user is asked to re-onboard.

```text
Privy user (passkey / email)
  -> Privy embedded EVM wallet
  -> keys managed by Privy, recoverable across devices

MWA user (Phantom / Solflare)
  -> random key generated on device
  -> stored in Keychain / Keystore, bound to the Solana address
  -> device-bound, swept back to Solana when idle
```

### Privy users

Enable EVM alongside the existing Solana config in
`apps/hybrid-expo/providers/PrivyProvider.tsx`:

```tsx
config={{
  embedded: {
    solana: { createOnLogin: 'all-users' },
    ethereum: { createOnLogin: 'all-users' },
  },
}}
```

Privy generates the key. Nothing is derived from a Solana signature. The wallet
exposes an EIP-1193 provider, which covers `personal_sign`,
`eth_signTypedData_v4`, and `eth_sendTransaction`. Polymarket order signing and
deposit-wallet batch signing are both EIP-712 and are satisfied by this.

Cost note for review: Privy bills per monthly active wallet. Provisioning an
EVM wallet for every user roughly doubles the wallet count. If that is
material, change `createOnLogin` to `'off'` and provision lazily on first EVM
feature use. The layer supports either; the resolver's `provision()` call is
the lazy hook.

### MWA users

Generate 32 random bytes, store in `expo-secure-store`, bind to the connected
Solana address:

```text
key:   myboon:evm:signer:v1:<solanaAddress>
value: { version: 1, privateKey: '0x...', createdAt: <epoch ms> }
opts:  keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY
```

`WHEN_UNLOCKED_THIS_DEVICE_ONLY` is required. It keeps the key out of iCloud
Keychain sync and out of Android auto-backup, which is the difference between a
device-bound key and a key that silently replicates to the user's other
devices and to a cloud backup.

Binding to the Solana address preserves current behaviour: switching Solana
wallets yields a different EVM signer, and the Predict session for the previous
wallet is cleared.

Device-bound means device loss is fund loss. Decision 3 makes this acceptable
because the EVM account is transient plumbing, but it imposes two obligations
in Phase 2: an idle sweep back to Solana, and a plainly worded warning at
provisioning time.

### Capability descriptor

Every protocol declares what it needs rather than reaching for a global, in the
same style as `PerpsVenueDescriptor.capabilities` in
`apps/hybrid-expo/features/perps/perps.registry.ts`.

## Non-Goals

- A portable, user-facing EVM wallet product with seed backup and cross-app
  reuse. Decision 3.
- ERC-4337 smart accounts with passkey or ed25519 signers. Correct long-term
  direction, deferred on cost and chain support.
- External EVM wallet connect through Reown or WalletConnect. Deferred.
- MWA EVM support. Not available in the protocol.
- Changing the CLOB credential trust boundary. See Problem 8.
- Bridging design. How USDC reaches the EVM side is out of scope here.

## Phase 1: Contain the P1

Phase 1 ships as its own reviewable change set. It does not wait on the
abstraction. Its only goal is that no user's funds sit behind a key that is
derivable from a public constant.

Every existing Predict user is already exposed. Migration is mandatory and
prompted on next open, not opt-in.

### 1. Provision a real key

Add the Privy EVM config and the secure-store backend described above. At this
stage they may be consumed directly by the Predict feature; the general
resolver arrives in Phase 2.

### 2. Migrate funds off the legacy EOA

The legacy key remains derivable by the app, which is what makes an automated
sweep possible. Run once per affected user:

```text
1. derive legacy EOA one final time (existing code path)
2. provision new EVM signer (Privy embedded or secure store)
3. POST /clob/auth with the new EOA -> new deposit wallet address
4. sweep legacy deposit wallet -> new deposit wallet
5. mark migration complete, never derive the legacy key again
```

Step 4 has to handle two asset classes. The deposit wallet holds USDC
collateral and CTF ERC-1155 outcome tokens for open positions.

- Preferred: batch `safeBatchTransferFrom` for the ERC-1155 positions plus an
  ERC-20 transfer for USDC, so open positions survive the migration.
- Fallback: close all open positions to USDC and transfer only USDC. Simpler,
  but forces users to realise P&L at whatever the market offers at that moment,
  which is not an acceptable default.

Recommend the preferred path with the fallback available behind a flag if the
batch transfer proves unreliable against the relayer.

Users who never reopen the app keep funds at a compromised address. Nothing in
code can fix that, so the mitigation is a direct notification to affected
users. Ownership of that notification sits with product, not this PRD.

### 3. Remove the clipboard path

`PredictOwnerKeyExportModal.tsx` stops writing the private key to the system
clipboard. Replace with on-screen reveal behind an explicit tap, no copy
affordance. If a copy affordance is judged necessary for the migration window,
it must clear the clipboard on a timer and on background.

### 4. Fence the E2E stub

`useWallet.native.ts` must not honour `EXPO_PUBLIC_PREDICT_E2E` in a release
build. Add a build-time guard so that the flag and a production build are
mutually exclusive and the build fails rather than shipping the shared key.

### 5. Warn against re-signing

Until every user has migrated, the Predict signing prompt should state that
this message must never be signed in any other app.

### Phase 1 acceptance criteria

- [ ] No code path constructs an EVM private key from a signature. A repo-wide
      search for `keccak256` applied to signature bytes returns no hits.
- [ ] `PREDICT_DERIVE_MESSAGE` is referenced only by the one-time migration
      path, and that path is unreachable once migration is marked complete.
- [ ] A test account with USDC and at least one open position migrates with
      both the USDC balance and the position intact at the new deposit wallet.
- [ ] Private key material never reaches `Clipboard.setStringAsync`.
- [ ] A production build with `EXPO_PUBLIC_PREDICT_E2E=1` fails to build.
- [ ] Migration is exercised on both a Privy account and an MWA account.

## Phase 2: The EVM signer layer

### 1. Signer contract

New module `apps/hybrid-expo/features/chain/evm.contract.ts`:

```ts
export type EvmCustody = 'privy_embedded' | 'device_secure_store' | 'external';

export interface EvmSignerDescriptor {
  custody: EvmCustody;
  address: string;
  chainId: number;
  canSignMessage: boolean;
  canSignTypedData: boolean;
  canSendTransaction: boolean;
  survivesReinstall: boolean;
  survivesDeviceLoss: boolean;
  isRevocable: boolean;
}

export interface EvmSigner {
  descriptor: EvmSignerDescriptor;
  getAddress(): Promise<string>;
  signMessage(message: string | Uint8Array): Promise<string>;
  signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, { name: string; type: string }[]>,
    value: Record<string, unknown>,
  ): Promise<string>;
  signTransaction(tx: Record<string, unknown>): Promise<string>;
}
```

`survivesReinstall` and `survivesDeviceLoss` are both `false` for
`device_secure_store` and both `true` for `privy_embedded`. Features read these
flags to decide whether to warn before letting a user park value in the
account, rather than hardcoding assumptions about custody.

### 2. Protocol requirements

```ts
export interface EvmProtocolRequirements {
  protocolId: string;
  chainId: number;
  needsTypedData: boolean;
  needsRawTransaction: boolean;
  acceptableCustody: readonly EvmCustody[];
  fundsAtRisk: 'none' | 'session' | 'account';
}

export const POLYMARKET_EVM_REQUIREMENTS: EvmProtocolRequirements = {
  protocolId: 'polymarket',
  chainId: 137,
  needsTypedData: true,
  needsRawTransaction: false,
  acceptableCustody: ['privy_embedded', 'device_secure_store'],
  fundsAtRisk: 'account',
};
```

### 3. Resolver

```ts
export function useEvmSigner(requirements: EvmProtocolRequirements): {
  signer: EvmSigner | null;
  status: 'ready' | 'needs_provision' | 'preparing' | 'unsupported';
  reason: string | null;
  provision: () => Promise<void>;
};
```

Resolution order:

```text
1. Privy user and Privy embedded EVM wallet exists -> privy_embedded
2. Privy user, no wallet yet                       -> needs_provision
3. MWA user and secure-store key exists            -> device_secure_store
4. MWA user, no key yet                            -> needs_provision
5. custody not in acceptableCustody                -> unsupported + reason
```

The old module-level `activeEvmWallet` singleton is deleted. Callers obtain a
signer through the resolver, scoped to the protocol that is asking.

### 4. Polymarket becomes the first consumer

`predict.signing.ts` stops importing from `useEvmSigner.ts` and takes an
`EvmSigner` instead. Its existing transaction-validation logic in
`validateDepositWalletSignatureRequest` is unchanged and remains valuable: it
is a genuinely good defence and should be the template other EVM protocol
adapters copy.

### 5. Idle sweep for device-bound keys

For `device_secure_store` signers with `fundsAtRisk: 'account'`, prompt to
sweep back to Solana after a configurable idle period. This bounds the loss
from device failure, which is the main cost of Decision 2.

### Phase 2 acceptance criteria

- [ ] `apps/hybrid-expo/hooks/useEvmSigner.ts` is deleted; no module-level
      mutable wallet singleton remains anywhere in the app.
- [ ] `predict.signing.ts` compiles with no reference to Solana signatures.
- [ ] A Privy user and an MWA user both complete a Polymarket buy, sell, and
      withdraw against the same adapter code.
- [ ] Requesting a signer with `acceptableCustody: ['privy_embedded']` as an
      MWA user returns `unsupported` with a human-readable `reason`, not a
      thrown error.
- [ ] Adding a hypothetical second EVM protocol requires a new requirements
      constant and no change to the resolver.

## Security Controls

- No signature-derived key material anywhere, enforced in code review against
  the Governing Rule.
- Secure-store entries use `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
- Private key material is never logged, never sent to our backend, and never
  written to the clipboard.
- Addresses may be logged. Keys and signatures over fixed strings may not.
- The existing calldata validation in `predict.signing.ts:262-286` stays and
  becomes the required pattern for any EVM protocol adapter that signs
  transactions.
- Secure-store keys are cleared on wallet disconnect and on Solana address
  change, matching the existing session-clearing behaviour.

## Testing Plan

- Unit: secure-store backend generates distinct keys per Solana address, and
  returns the same key across app restarts for one address.
- Unit: resolver returns the correct custody for each of the five resolution
  branches.
- Unit: `EvmSignerDescriptor` flags are correct per backend.
- Integration: EIP-712 signature produced by the Privy backend and by the
  secure-store backend both verify to the expected address.
- Migration: fixture account with USDC plus an open position sweeps intact.
- Migration: idempotency, running migration twice does not double-sweep or
  strand funds.
- Build: release build with the E2E flag set fails.
- Manual: Privy passkey user and Phantom MWA user each complete a full Predict
  lifecycle on mainnet with small size.

## Open Decisions Before Implementation

1. Privy `createOnLogin: 'all-users'` versus lazy provisioning on first EVM
   use. Depends on Privy per-wallet cost at current MAW. Recommend lazy if the
   delta is material.
2. Position-preserving sweep versus close-to-USDC sweep as the Phase 1 default.
   Recommend position-preserving; needs a relayer feasibility spike.
3. Whether affected users get a direct notification, and through which channel.
   Product decision, but the exposure is real and disclosure is the honest
   default.
4. Idle-sweep period for device-bound keys. Suggest starting at 7 days and
   tuning.
5. Whether Phase 2 lands before or after the next EVM integration is scoped. If
   another EVM app is imminent, Phase 2 should precede it, otherwise the
   pattern in Problem 6 repeats.

## References

### myboon

- `apps/hybrid-expo/hooks/useEvmSigner.ts` — current derivation, to be deleted
- `apps/hybrid-expo/hooks/usePolymarketWallet.ts` — enable flow
- `apps/hybrid-expo/hooks/usePrivyWallet.ts` — Privy adapter
- `apps/hybrid-expo/providers/PrivyProvider.tsx` — embedded wallet config
- `apps/hybrid-expo/features/predict/predict.signing.ts` — signing and calldata validation
- `apps/hybrid-expo/features/predict/components/PredictOwnerKeyExportModal.tsx` — export path
- `apps/hybrid-expo/features/perps/perps.registry.ts` — capability descriptor pattern this PRD follows
- `packages/api/src/polymarket/trading/routes/session.ts` — deposit wallet derivation

### External

- Mobile Wallet Adapter specification — chain scope is Solana-only:
  https://github.com/solana-mobile/mobile-wallet-adapter/blob/main/spec/spec.md
- Privy React Native quickstart — embedded wallets across Ethereum and Solana:
  https://docs.privy.io/basics/react-native/quickstart
- Hyperliquid nonces and API wallets — authorize-a-generated-key pattern:
  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
- Privy agent wallets recipe:
  https://docs.privy.io/recipes/hyperliquid/agents-and-subaccounts
