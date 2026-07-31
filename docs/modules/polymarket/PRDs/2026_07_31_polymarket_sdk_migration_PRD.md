# Polymarket SDK Migration PRD

Status: **account setup verified end-to-end against a real, fresh, on-chain
deposit wallet** (see "Proven" below) — via a Node script driving the real
SDK/proxy/signing chain, not yet from the actual phone app. Order placement,
wrap, withdraw, redeem, and the server route triage (step 4) are not started.
Date: 2026-07-31
Owner: myboon Apps

## Implementation status (read this first)

Two on-device/local failures surfaced real gaps the type-level investigation
couldn't show, both now fixed and both genuinely required server-side
changes — correcting the earlier claim (made to the user) that this
migration needed zero server changes. That claim was accurate only for what
bundling/type-checking could prove; each live network call surfaced a new
runtime dependency. Recorded in order they were found:

1. **`@polymarket/client` calls Polymarket's relayer directly** (`GET
   /deployed`, checking whether a signer's deposit wallet already exists) —
   a call the old SDK never made from the phone. Only the CLOB host had been
   proxied; the relayer host timed out on-device the same way
   `clob.polymarket.com` used to. Fixed: `routes/proxies.ts`'s
   `relayToRelayer` (mirrors the existing CLOB relay exactly) +
   `predict.signing.ts` forking `relayer` alongside `clob`.
2. **`createSecureClient` throws without Builder or Relayer API Key
   authorization**: `"Deposit Wallet deployment requires a Relayer API Key
   or Builder API Key in the client configuration."` The SDK's
   `builderApiKey({ key, secret, passphrase })` embeds the raw secret in
   whatever process calls it — correct for a trusted server, wrong for a
   phone bundle, since this app's Builder secret authorizes gasless relaying
   for the whole account, not per-user. Fixed with the SDK's documented
   alternative for exactly this: `remoteBuilderSigning({ url })`, backed by
   a new server route, `routes/builder-sign.ts`'s `POST /clob/builder/sign`,
   which holds the secret and returns signed headers per request — the
   secret never leaves the server.

**Proven end-to-end** (Node script, real `@polymarket/client`, real HTTP
calls through both new proxies, no shortcuts): a freshly generated,
never-before-used private key ran through `createSecureClient` with Builder
auth via the remote signer, deployed a real `WALLET-CREATE` transaction
through the relayer, and resolved `client.account.wallet ==
0xc4eec2e6d5818f2df34e5056de015c8fe559fdd4`. Independently confirmed via two
public Polygon RPCs (`polygon.drpc.org`, `polygon-bor-rpc.publicnode.com`,
agreeing) that this address holds real contract bytecode — a genuine beacon
proxy, with the factory address and signer EOA visibly embedded in the
returned code. **This is direct proof the original bug is fixed**: a fresh
signer now deploys to and resolves the address the factory actually uses,
with no manual intervention.

**Not yet done: the same flow from the actual phone app**, through Privy's
embedded wallet and the real UI (`usePolymarketWallet.ts`'s `enable()`). The
Node script proves the SDK, the proxies, and the signing chain are correct;
it does not exercise `createPrivyEvmSigner`'s `sendTransaction`/`eth_sendTransaction`
path, Privy's actual signing behavior, or the UI's handling of the result.

**Done, on `polymarket-sdk-migration`:**
- `chain.contract.ts`: `Signer.sendTransaction` + `canBroadcastTransaction`
  capability + `needsBroadcastTransaction` requirement flag, distinct from
  the pre-existing sign-only `signTransaction`/`canSendTransaction`.
  `POLYMARKET_REQUIREMENT` now declares `needsBroadcastTransaction: true`.
- `chain.signers.ts`: `createPrivyEvmSigner` implements `sendTransaction` via
  `eth_sendTransaction`.
- `predict.signing.ts`: `createPolymarketSecureClient` — constructs
  `@polymarket/client`'s `SecureClient` with a real adapter over the app's
  `Signer`, pointed at this app's CLOB **and relayer** proxies via
  `forkEnvironmentConfig`, with Builder auth via `remoteBuilderSigning`. A
  client-side `waitForTransaction` poller backs `TransactionHandle.wait()`
  (the app never broadcast a transaction directly before this).
- `usePolymarketWallet.ts`: `enable()` now calls
  `createPolymarketSecureClient` → `client.setupTradingApprovals()` →
  registers the resulting address with the server via `/clob/auth`, passing
  it as `knownDepositWalletAddress` so the server's existing on-chain
  `owner()` verification accepts it immediately rather than running its own
  (wrong) derivation.
- **`packages/api/src/polymarket/trading/routes/proxies.ts`: added
  `relayToRelayer` / `GET|* /clob/relayer-proxy/*`.** Mirrors the existing
  `relayToClob` pattern exactly. Confirmed working end-to-end (see "Proven"
  above), not yet from the actual phone.
- **`packages/api/src/polymarket/trading/routes/builder-sign.ts` (new file):
  `POST /clob/builder/sign`** — remote HMAC signing for Builder
  authorization, keeping `POLYMARKET_BUILDER_SECRET` server-side. Same HMAC
  algorithm as the old `@polymarket/builder-signing-sdk`'s signer (verified
  against both implementations' compiled source). Confirmed working
  end-to-end (see "Proven" above).
- `apps/hybrid-expo` gained `@polymarket/client`; confirmed to bundle
  cleanly under Metro/Hermes on iOS and Android (probe import — the full app
  has not yet run this path on a device).
- All existing tests (136, across chain/wallet/security suites) and
  TypeScript pass. Neither exercises the new SDK path — that coverage is the
  Node-script proof above and the on-device run still to come.

**Deliberately not done in this pass, and why:**
- **The server's `/clob/auth`, `resolveDepositWallet`, and
  `knownDepositWalletAddress` hint mechanism are still present**, not
  deleted. The client now always sends the *correct* address as the hint
  (instead of sometimes sending a stale one or none), so the server's
  existing `owner()` verification accepts it on the first pass and its own
  wrong CREATE2 derivation is never reached in practice — but the dead
  derivation code itself, and the routes built around it, are untouched.
  This is intentional: order placement, wrap, withdraw, and redeem
  (`routes/orders.ts`, `routes/funds.ts`, `routes/redeem.ts`) still depend on
  the server-side `ClobSession` that `/clob/auth` populates, so deleting it
  now would break working functionality. Deleting the dead derivation code
  and shrinking these routes is step 4 below, scoped separately on purpose —
  it needs its own route-by-route triage, not a rider on the bug fix.
  **The "no `knownDepositWalletAddress` anywhere in the repo" acceptance
  criterion further down describes step 4's end state, not this pass's.**
- Order placement, wrap, withdraw, redeem, and the "predict" → "polymarket"
  rename are all untouched — same reasoning.
Builds on: `docs/modules/polymarket/PRDs/2026_07_30_polymarket_account_setup_PRD.md` (client-side state model, unimplemented, independent of this work)

This is a change plan for `apps/hybrid-expo/features/predict/predict.signing.ts`
and `packages/api/src/polymarket/**`. It replaces the deprecated
`@polymarket/clob-client-v2` + `@polymarket/builder-relayer-client` +
`@polymarket/builder-signing-sdk` stack with `@polymarket/client` (the unified
SDK) **on the phone**, and shrinks the server's role to match. It stops being
read once the work lands; durable outcomes are the code itself.

## Revision note: this PRD originally planned a server-side migration

The first draft of this document planned to run `@polymarket/client` inside
`packages/api`, keeping the server's role exactly as it is today (orchestrate,
hold sessions, drive the SDK) and using an address-known, non-signing stub in
place of a real signer — the same trick `sessions.ts`'s current
`addressOnlySigner` plays on the old SDK.

That plan is wrong, and the reason is a fact about the new SDK, not a decision
this app gets to make: `@polymarket/client`'s exported `Signer` type
(`dist/types-vvy5wT5V.d.ts`) requires `sendTransaction(request):
Promise<TransactionHandle>` — a real, transaction-broadcasting signer, not an
address-and-signature-only one. Reading the compiled `createSecureClient` body
confirms why: it unconditionally calls `beginAuthentication(..., signer)` (the
CLOB L1 auth signature) and, for a wallet that isn't deployed yet, calls a
deploy step that sends a real transaction through that same signer. There is
no code path where `createSecureClient` runs with a signer that can't sign.

**This is not a security question and nothing here changes who holds keys.**
The server was never going to hold a private key or a Privy server-signer
either way — that line was correct in the original draft and stays correct
now. What changes is *where the SDK call happens*: since it needs the real
signer, and the real signer is the user's Privy embedded wallet living on the
phone, `createSecureClient` has to be constructed **client-side**, in
`predict.signing.ts`, exactly where `predict.signing.ts` already builds a
`ClobClient` with the real signer today. The user's key material never moves;
it was on the phone before this migration and stays on the phone after it.

Practically: everything the original draft planned to build in
`packages/api/src/polymarket/trading/{sessions,wallet,redeem}.ts` and their
routes moves to the client. The server's surviving job is what it's good at
and was never in question: proxying CLOB calls the phone can't reach directly
(`0a3dc77`, kept), verifying the Predict session proof, and — if still useful
after the client can derive its own deposit wallet address — a thin
`GET /clob/session/:address` read for cross-device/session-restore
convenience. Steps below reflect this. Anything from the prior draft not
mentioned here is superseded by it, not layered on top of it.

## The bug this fixes

Every new Polymarket account setup on this app fails. Root cause, proven
end-to-end against a real stuck wallet:

`deriveDepositWallet()` in `@polymarket/builder-relayer-client` computes a
CREATE2 address against the SDK's `DepositWalletImplementation` constant — an
ERC-1967 **implementation proxy**. The live factory
(`0x00000000000Fb5C9ADea0298D729A0CB3823Cc07`) deploys **beacon proxies**
against `0x7A18EDfe055488A3128f01F563e5B479D92ffc3a`. The two addresses never
match. Every deploy this app has ever done landed at an address the app wasn't
looking at.

Same signer (`0xdb2430…`), both computed independently and checked on-chain:

| Source | Address | On-chain |
|---|---|---|
| `@polymarket/client` (`client.account.wallet`) | `0xd20212668f45f6d171207dd911f67fee76c2b43d` | has code, `owner()` == signer |
| `@polymarket/builder-relayer-client` (`deriveDepositWallet()`) | `0xf59d094b7944c1cf044098bc855758feab4eb6a7` | empty |

Four days of debugging landed on this one fact. The three commits before this
PRD (`9bdc587`, `8eb59a4`, `46fd56d`) are workarounds that make the
wrong-derivation bug survivable — read the address from a transaction receipt
instead of computing it, scan `eth_getLogs` for it when the receipt isn't
available, cache it, accept a client-supplied hint verified via `owner()`.
They are not the fix. The fix is to stop using the SDK whose math is wrong —
now proven to mean running the *correct* SDK where the signer already lives.

## Does the user need a gas balance? No — unchanged by this migration.

The deposit wallet exists specifically so the user never holds POL/MATIC.
Every write goes through the Polymarket relayer, authorized by *our* Builder
credentials (`POLYMARKET_BUILDER_*`), which pays gas on the user's behalf. The
user produces signatures (and, per the spike finding above, occasionally a
real transaction dispatch for first-time deployment) via their own Privy
wallet — but "who pays gas" and "who signs" are unrelated questions. Gas is
still Builder-sponsored either way; only the *location* of the signing call
changed in this revision, not who bears its cost. That funding is our
operational responsibility (the app's Builder account), not the end user's.

## No users yet — build for the right shape, not the safe shape

There is no production user on this integration. Wherever the old response
shape or the old client/server split is worse than what the unified SDK
naturally gives you, change it — there's no live contract to protect, and the
client is unshipped code in this same repo, changeable in the same PR. The
one thing to actually preserve is correctness against the chain (fresh
wallets deploy to the right address, positions settle to the right place) —
everything else, including which process orchestrates what, is open to be
whatever is actually correct. This is exactly what happened here: the
server-orchestrates-everything shape from the first draft wasn't preserved
once the spike showed it doesn't fit the new SDK.

This is not a license to touch unrelated systems. The freedom above is scoped
to the files this PRD already touches for the SDK swap.

## Scope

```
apps/hybrid-expo/features/predict/predict.signing.ts   — moves to @polymarket/client, becomes the primary migration surface
apps/hybrid-expo/metro.config.js                        — drop bundler shims for the three deprecated packages once nothing imports them
packages/api/src/polymarket/trading/sessions.ts         — shrinks: no SecureClient, no ClobSession creds cache for signing
packages/api/src/polymarket/trading/wallet.ts           — shrinks: no relayer/builder header construction (client now calls Polymarket's API directly via its own SDK, or through the existing proxy for L1 auth calls)
packages/api/src/polymarket/trading/redeem.ts           — deleted if nothing server-side needs CTF calldata anymore (see step 4)
packages/api/src/polymarket/trading/contracts.ts        — drop constants nothing server-side derives from anymore
packages/api/src/polymarket/trading/routes/session.ts   — shrinks to proof verification + optional thin GET; /auth, /wallet-batch, /combo-approve likely delete
packages/api/src/polymarket/trading/routes/orders.ts    — likely deletes; client posts orders directly to Polymarket via its own SDK/proxy
packages/api/src/polymarket/trading/routes/funds.ts     — /wrap, /withdraw need per-route decisions in step 4
packages/api/src/polymarket/trading/routes/redeem.ts    — likely deletes, same reasoning as orders.ts
packages/api/src/polymarket/trading/routes/proxies.ts   — kept and possibly the only route file left. DONE: added `relayToRelayer`/`/relayer-proxy/*` — confirmed needed on first on-device test (see Open Questions #2)
packages/api/package.json                                — remove the three deprecated deps; @polymarket/client does NOT get added here (it's a client dependency now)
apps/hybrid-expo/package.json                            — add @polymarket/client, viem or the Privy adapter
.npmrc                                                    — drop tslib hoist once builder-relayer-client is uninstalled
```

This is a much larger swing in the server's footprint than the first draft
planned — most server route files are candidates for deletion, not
modification, once the phone can talk to Polymarket directly through its own
SDK. Confirm each deletion against step 4 rather than assuming; a route stays
if the server is doing something the SDK can't do from the phone (e.g.
relaying a call the device's network can't reach directly, per `0a3dc77`'s
original reasoning) and goes if it was only ever a signing/orchestration
proxy the phone no longer needs.

## Rename: "predict" → "polymarket", scoped to the files this PRD touches

Everything under `packages/api/src/polymarket/` was named while this was the
app's only prediction-market integration, so internal types, functions, and
user-facing strings say "predict" where they mean "Polymarket." Apply the
rename to whatever survives step-4 route triage — don't spend effort renaming
a file this PRD is about to delete.

This does **not** touch `apps/hybrid-expo/features/predict/` as a *directory*
— that's the betting feature's home (screens, activity feed) and stays named
for the product concept "Predict," which is broader than Polymarket.
`predict.signing.ts` itself keeps its filename for the same reason (it signs
for the Predict feature; Polymarket is what it signs *against* today), but
its Polymarket-specific internals — `createPredictSessionProof`, the message
literal `'myboon:predict:server-session'`, comments describing old-SDK
behavior — get renamed for accuracy where this PRD already touches them.

**Rename together, same PR, both sides, since there's no live client to stage
around:**
- `lifecycleError.code` values (`PREDICT_SESSION_EXPIRED`,
  `PREDICT_CANCEL_FAILED`, `PREDICT_REDEEM_FAILED`, `PREDICT_BUY_NOT_FILLED`,
  `PREDICT_ORDER_NOT_FILLED`, `PREDICT_INSUFFICIENT_FUNDS`,
  `PREDICT_RELAYER_UNAVAILABLE`, `stableErrorCode`'s generated fallback) and
  their consumers (`predictActivityState.ts`, `predict.api.ts`,
  `usePolymarketWallet.ts`) — but only for whichever of these still exist
  after step 4's route triage; a deleted route's error codes don't need
  renaming, they need deleting.
- `predictSessionMessage`/`verifyPredictSessionProof` (wherever session-proof
  verification ends up living after step 4) and `createPredictSessionProof`
  in `predict.signing.ts` — rename both ends together, including the signed
  message literal.

## Step 1 (done): the spike, and what it proved

Installed `@polymarket/client@0.2.0` into `packages/api` to run the planned
derivation-proof script. Before running it, inspected the package's shipped
type definitions and compiled source directly (`node_modules/.pnpm/@polymarket+client@0.2.0.../dist/types-vvy5wT5V.d.ts`
and `dist/index.js`) rather than assuming the docs' examples were exhaustive.
Found:

```ts
type Signer = {
  getAddress(): Promise<EvmAddress>;
  signTypedData(payload: TypedDataPayload): Promise<EvmSignature>;
  signMessage(message: HexString): Promise<EvmSignature>;
  sendTransaction(request: SignerTransactionRequest): Promise<TransactionHandle>;
};
type SecureClientOptions = PublicClientOptions & {
  wallet?: string;
  signer: Signer;   // required, no non-signing variant
} & (credentials-or-nonce union);
```

And in the compiled `createSecureClient` body:

```js
async function createSecureClient(t) {
  let publicClient = createPublicClient({ environment: t.environment, apiKey: t.apiKey });
  let wallet = await resolveWallet(publicClient, t);            // only needs signer.getAddress()
  let secureClient = await publicClient
    .beginAuthentication({ wallet, credentials: t.credentials, nonce: t.nonce }, t.signer)  // needs a REAL signature
    .then(attachSigner(t.signer));
  if (alreadyDeployed) return secureClient;
  if (walletType === DEPOSIT_WALLET) {
    await deployDepositWalletIfNeeded(secureClient);              // needs a REAL sendTransaction, first time only
    return secureClient;
  }
  throw ...;
}
```

Conclusion, evidence-based rather than assumed: `createSecureClient` always
needs a real signature (`beginAuthentication`) and, for a never-before-seen
wallet, a real transaction dispatch (deployment). There is no address-known,
non-signing construction mode — the whole "keep the server signer-less by
faking a stub" plan from the first draft cannot work against this SDK. This
also means the original throwaway script (assert `client.account.wallet`
equals the known-correct address for the stuck wallet
`0xDd79A1287e691A3f0eD3CFeeD72C67b6c2851E40`) cannot run from
`packages/api` either, for the same reason — it needs the real signer, which
lives on the phone.

`@polymarket/client` is accordingly **uninstalled from `packages/api`** (see
step 6) and reinstalled into `apps/hybrid-expo` instead, where the spike's
derivation check gets re-run for real, against the real Privy signer, as part
of step 3's on-device verification — not as an isolated script, since there's
no way to isolate it further than "the real signer, wherever it lives."

## Step 2: `predict.signing.ts` — the SDK moves here

This file already constructs a real signer-backed `ClobClient` today
(`toClobSigner(signer)`, built from the resolver's `Signer` — see
`chain.signers.ts`'s `createPrivyEvmSigner`, which already implements
`getAddress`, `signMessage`, `signTypedData` over the Privy embedded wallet's
EIP-1193 provider). It needs one more capability to satisfy
`@polymarket/client`'s `Signer` type: `sendTransaction`. Add it to
`createPrivyEvmSigner` (`chain.signers.ts`) using the same EIP-1193 `request`
this signer already holds — `eth_sendTransaction` is a standard method every
EIP-1193 provider supports, so this is additive to an existing object, not a
new signer path.

Then `predict.signing.ts` builds `@polymarket/client`'s `createSecureClient`
the same way it builds today's `ClobClient` — real signer in, no server round
trip for the client construction itself:

```ts
import { createSecureClient } from '@polymarket/client';
// signer: the existing chain-resolved Signer, adapted to @polymarket/client's Signer shape
// (a small adapter function, same pattern as toClobSigner today)
const client = await createSecureClient({ signer: polymarketSigner });
const depositWalletAddress = client.account.wallet;
```

This is the direct replacement for `createPolymarketApiCreds` +
`ClobClient`'s deposit-wallet-mode construction + the server's
`resolveDepositWallet` — all three collapse into this one call, because the
correct SDK derives the address correctly and the phone is where the signer
already lives.

`toClobSigner` (the old adapter, shaped for `@polymarket/clob-client-v2`'s
`EthersSigner` interface) is replaced by a new adapter matching
`@polymarket/client`'s `Signer` shape (`getAddress`, `signTypedData`,
`signMessage`, `sendTransaction`) — structurally similar, new target type.

## Step 3: what moves out of `predict.signing.ts`'s old shape, and on-device verification

Order placement (`createSignedPredictOrder`), the deposit-wallet-batch
EIP-712 signing/validation (`signDepositWalletBatch`,
`validateDepositWalletSignatureRequest` and its per-operation validators),
and the server round-trip (`signAndSubmitDepositWalletBatch` →
`/clob/wallet-batch`) are candidates for replacement by direct SDK calls
(`client.placeLimitOrder`, `client.redeemPositions`, `client.splitPosition`,
etc.) called straight from the phone — no `signatureRequest` object, no
server relay, because the phone now holds a client that can both sign and
submit.

**Before deleting any of this validation logic, understand why it exists.**
`validateSetupCalls`/`validateWrapCalls`/`validateWithdrawCalls`/`validateRedeemCalls`
are a defense against a compromised or buggy server handing the phone a
signature request for calldata the phone didn't ask for (wrong spender, wrong
amount, wrong recipient) — the phone validates the *content* of what it's
about to sign, independent of trusting the server that sent it. Moving
construction to the SDK removes the server from this path entirely (the SDK
builds the calldata locally, from parameters the phone itself provided), which
arguably removes the threat these validators defend against — but confirm
that reasoning holds for each operation before deleting the corresponding
validator, rather than deleting all four as a block. If the SDK still accepts
a server-supplied intermediate (e.g. a `GaslessTransactionMetadataSchema`
object mentioned in the SDK's exports) at any step, the same validation
principle likely still applies to that new shape.

**On-device verification, replacing the original spike script:** run this
migration against a **fresh, never-before-used EOA** on a real device,
through the actual `usePolymarketWallet.ts` → `predict.signing.ts` path:
confirm `client.account.wallet` resolves to an address that holds contract
code on Polygon immediately after setup (checked independently via
`polygonProvider.getCode`, not just trusted from the SDK's return value).
This is both step 1's original proof and step 4 of the Definition of Done —
they're the same check now that the SDK only runs where real verification is
possible anyway.

## Step 4: server route triage — what's left in `packages/api`

Go route by route. A route survives only if the server is doing something
the phone's own SDK call can't do from the device — not because it existed
before.

- **`/auth` (`routes/session.ts`):** the CLOB L1 auth + deposit-wallet
  resolution this route orchestrates today is now done entirely by
  `createSecureClient` on the phone. Delete, unless something server-side
  still needs to *know* the result (see `GET /session/:address` below).
- **`/wallet-batch`, `/combo-approve` (`routes/session.ts`):** existed to
  receive a phone-signed batch and relay it to Polymarket's relayer. If the
  phone's SDK submits directly (`client.redeemPositions()` etc. return an
  awaitable `TransactionHandle`, submitted by the SDK itself), there's
  nothing left to relay. Delete unless a specific relayer endpoint is
  unreachable from the device's network the way `clob.polymarket.com` was —
  check this empirically on-device before assuming the relayer is reachable
  just because `CLOB_HOST` needed proxying.
- **`/order`, `/positions`, `DELETE /order/:id` (`routes/orders.ts`):** same
  reasoning — the phone posts/cancels/lists orders directly through its own
  `SecureClient`. Delete unless order posting specifically hits a
  network-reachability wall the way L1 auth did (`0a3dc77`'s original
  motivation) — confirm on-device, don't assume parity with the auth case.
- **`/redeem`, `/wrap`, `/withdraw` (`routes/funds.ts`, `routes/redeem.ts`):**
  same triage. `client.redeemPositions()` is a documented SDK method; wrap
  and withdraw are not (they're this app's own USDC.e-wrap and
  bridge-withdraw logic, not Polymarket position operations) — but "not an
  SDK method" doesn't mean "must stay server-side," it means the phone's SDK
  client still needs to construct and submit that calldata itself, using
  `client.account` for the deposit wallet address and its own
  `sendTransaction`-capable signer, rather than asking the server to build a
  `signatureRequest`. Move the calldata-building logic
  (`buildApprovalTxs`/`buildComboApprovalTxs`/wrap/withdraw calldata,
  currently in `packages/api/src/polymarket/trading/wallet.ts`) to
  `predict.signing.ts` alongside it, using `viem`'s `encodeFunctionData` the
  same way it's used today — this part doesn't change, only which process
  runs it.
- **`GET /clob/session/:address` (`routes/session.ts`):** the one route
  worth keeping *if* there's still a reason for the server to independently
  know account state — e.g. answering a push notification, a background
  job, or a second device checking status without holding the signer. If
  nothing in this app currently needs that (check: does anything call this
  route besides the client itself, which could just call
  `client.account.wallet` locally instead?), delete it too. Don't keep it on
  the assumption it might be useful — the read/write asymmetry problem it
  was built for mostly dissolves once the client can derive its own address
  locally.
- **`proxies.ts`:** kept regardless — `predict.signing.ts`'s `CLOB_HOST`
  pointed at the proxy exists because the device can't always reach
  `clob.polymarket.com` directly, which is a network fact independent of
  which SDK issues the request. Confirm `@polymarket/client`'s configuration
  supports pointing its base URL at this proxy the same way the old
  `ClobClient` did (`host` option) — if it doesn't expose an equivalent
  option, this becomes the one genuinely open integration question for this
  PRD, worth spiking before assuming it works.

Net expectation: `sessions.ts`, most of `routes/session.ts`,
`routes/orders.ts`, and `routes/redeem.ts` (the route file) shrink
dramatically or disappear. `wallet.ts`'s calldata-building functions move to
the client, not delete. `redeem.ts` (the CTF calldata module) moves with
them if wrap/withdraw/redeem calldata construction moves client-side, per
above.

## Step 5: dependency swap

```bash
pnpm remove @polymarket/clob-client-v2 @polymarket/builder-relayer-client @polymarket/builder-signing-sdk --filter @myboon/api
pnpm remove @polymarket/client --filter @myboon/api   # installed during the spike, wrong package for this app
pnpm add @polymarket/client@latest --filter hybrid-expo
```

`viem` — check whether `apps/hybrid-expo` already depends on it before
adding; `@polymarket/client`'s signer adapters (`@polymarket/client/viem`)
assume it. Confirm React Native/Expo compatibility for whatever
`@polymarket/client` needs at runtime (it's built for Node/browser
environments per its `package.json` exports — `.`, `./node`, `./privy`,
`./viem`, `./ethers-v5` — none is an RN-specific entry, so bundler
compatibility under Metro is worth checking early, not assumed).

## Step 6: revert the workarounds, remove the throwaway script

Revert `46fd56d`, `8eb59a4`, `9bdc587` (newest first) once step 4's route
triage lands and step 3's on-device verification passes. Keep `0a3dc77`
(CLOB proxy relay) — still needed per step 4's `proxies.ts` reasoning.
`packages/api/src/__verify.ts` (the hostile-hint security check written
during debugging) deletes with `46fd56d`'s revert.

## Error messages

`failedOperation()`'s hardcoded generic `userMessage` (`operations.ts:63`)
is only relevant for whatever server routes survive step 4's triage — a
deleted route's error handling doesn't need improving, it needs deleting.
For anything that survives (or for the client's own new error handling
around direct SDK calls), build `userMessage` from the SDK's typed error
guards (`RateLimitError.isError`, etc.) where one exists, falling back to a
generic message only for genuinely unclassified errors. Since order
placement and redeem/wrap/withdraw likely move client-side per step 4, most
of this work is now about `predict.signing.ts`'s own error handling around
direct SDK calls, not the server's.

## Explicitly not in this PRD

- **Session durability.** Whatever server-side session concept survives step
  4's triage (likely much thinner than today's `ClobSession` — possibly just
  session-proof verification with nothing to persist) stays in-memory or is
  designed fresh in its own PRD, not bolted onto this one.
- **Test coverage.** Worth adding once the shape settles — an on-device
  integration check asserting `client.account.wallet` has on-chain code for
  a known signer would have caught the original bug in minutes. Not
  blocking this PRD.
- **`ApplicationSetup`/`connectAndSetup()` state machine** — 2026-07-30 PRD,
  independent of this work.

## Acceptance criteria

- [ ] `packages/api/package.json` contains none of `@polymarket/clob-client-v2`,
      `@polymarket/builder-relayer-client`, `@polymarket/builder-signing-sdk`,
      `@polymarket/client` — the last one is a client dependency now, not a
      server one.
- [x] `apps/hybrid-expo/package.json` contains `@polymarket/client`.
- [x] `createPrivyEvmSigner` (`chain.signers.ts`) implements `sendTransaction`
      via the existing EIP-1193 `request`.
- [x] `predict.signing.ts` constructs `@polymarket/client`'s `SecureClient`
      directly with the real Privy-backed signer — no server round trip for
      client construction, no address-known stub anywhere in this codebase.
- [ ] For a fresh, never-before-used EOA, `client.account.wallet` (read on
      the phone) resolves to an address independently confirmed to hold
      contract code on Polygon. **Not yet run on a device — this is the
      actual bug-fix proof and the top priority for on-device testing.**

The following are **step 4's** acceptance criteria (server route triage —
not started), kept here rather than deleted so the full end state stays
visible, but they are not expected to pass yet:

- [ ] Every server route deletion or survival in step 4 is a deliberate,
      justified decision recorded in the implementation PR's description —
      not a silent carryover of the current route list.
- [ ] `resolveDepositWallet`, `depositWalletByEoa`, `verifyDepositWalletHint`,
      `scanForDepositWallet`, `depositWalletFromTx`, and
      `knownDepositWalletAddress` do not appear anywhere in the repo. **As of
      this pass, `knownDepositWalletAddress` still exists and is used
      correctly** — the client always sends the true address now, so the
      server's dead derivation path is never exercised in practice, but the
      mechanism and the routes around it are untouched pending step 4.
- [ ] `0a3dc77` is not reverted. `9bdc587`, `8eb59a4`, `46fd56d` are reverted,
      and `packages/api/src/__verify.ts` is deleted as part of that revert.
      **Not done — these three commits' server-side workarounds are still in
      place; only the client now works around them correctly rather than
      needing them fixed.**
- [ ] No file touched by this PRD contains the identifier `Predict`/`predict`
      in a type name, function name, operation-string literal, or
      user-facing message, except the deliberately-kept `predict.signing.ts`
      filename and the Predict-feature directory itself.
- [ ] Every `lifecycleError.code` rename and its client consumers are
      changed together, in the same PR — for whichever codes survive step
      4's route triage.

## Definition of done

**1. Mechanical checks:**
```
grep -n "@polymarket/clob-client-v2\|builder-relayer-client\|builder-signing-sdk\|@polymarket/client" packages/api/package.json   # → empty
grep -n "@polymarket/client" apps/hybrid-expo/package.json   # → present
grep -rn "resolveDepositWallet\|depositWalletByEoa\|verifyDepositWalletHint\|scanForDepositWallet\|knownDepositWalletAddress" .   # → empty
```

**2. A never-before-used signer, full setup, on-chain, on a real device, no
manual poking.** This is the actual bug reproduction and now also the only
form the original spike can take, since the SDK can't run in isolation from
the real signer. Fresh Privy login on-device → Polymarket setup completes →
confirm on Polygon (independent of the app) that `client.account.wallet`
holds contract code. This is the single check that most directly falsifies
or confirms the fix.

**3. One real trade, start to finish, same device/session as above.** Place
one small limit order → confirm it appears in whatever position-listing path
survives step 4 → cancel it → confirm the cancel is reflected. Proves the
client's direct SDK usage works end-to-end, not just that setup completes.

**4. Failure-path spot check.** Force one failure deliberately (e.g.
insufficient balance) and confirm the error the user sees names the actual
cause.

**5. Whatever server routes survive step 4, confirmed reachable and correct**
— if `/clob/session/:address` or any proxy path is kept, exercise it
directly, not just by inference from the client working.

## Open questions to resolve during implementation

1. ~~Does `@polymarket/client` run under Metro/Hermes (React Native)?~~
   **Resolved, yes.** Bundled a probe entry (`import { createSecureClient }
   from '@polymarket/client'`) through `expo export:embed` for both `ios` and
   `android` platforms — both bundled cleanly, 342 modules, no config
   changes to `metro.config.js` needed. One benign warning
   (`@noble/hashes/crypto.js` not in package exports, Metro falls back to
   file-based resolution automatically) — not a blocker, nothing to fix.
2. ~~Can `@polymarket/client` point its CLOB host at this app's own proxy?~~
   **Resolved, yes — and the first on-device test proved it's needed for
   more than just the CLOB host.** `forkEnvironmentConfig` (per
   `types-vvy5wT5V.d.ts:3869-3906`) forks `clob` and `relayer` independently.
   The first real-device run of `createPolymarketSecureClient` failed with
   `Request timed out: GET https://relayer-v2.polymarket.com/deployed` — the
   device could reach `clob.*` fine (through our proxy) but not
   `relayer-v2.polymarket.com` at all, because only `clob` had been forked at
   the time. `createSecureClient` calls the relayer directly to check
   whether a signer's deposit wallet already exists — a call the old SDK
   never made from the phone (the old flow's relayer calls were all
   server-side). Fixed by adding a second proxy route,
   `routes/proxies.ts`'s `relayToRelayer` (mirrors `relayToClob`'s
   path-agnostic pattern exactly), and forking `relayer: { rest:
   RELAYER_HOST }` alongside `clob` in `predict.signing.ts`. Confirmed
   working against the local dev server (`tsx --watch`, hot-reloaded the new
   route automatically): `GET /clob/relayer-proxy/deployed?address=...`
   returns Polymarket's real `{"deployed":false}` response, and an unknown
   sub-path correctly returns Polymarket's own 404 through the relay rather
   than a local route-not-found — proof it's a live pass-through, not a
   locally-answered stub. **This is a genuine, if small, server-side change**
   — the "no server changes needed" read from the type-level investigation
   was incomplete; it covered whether the SDK could construct and bundle,
   not every host it talks to at runtime. Not yet confirmed from the actual
   phone (only from this Mac's dev server and a direct `curl` test) — that's
   the next on-device check.
3. For each of wrap/withdraw/redeem, does moving calldata construction and
   submission to the phone's `SecureClient` still allow gasless,
   Builder-sponsored execution the way today's relayer flow does — or does
   Builder sponsorship require the specific submission path the server used
   to control? Confirm before assuming parity.
4. Do the calldata-validation functions in `predict.signing.ts`
   (`validateSetupCalls` etc.) still serve a purpose once the server is out
   of the construction path, or were they entirely a defense against a
   compromised server that no longer applies? Decide per-function, not as a
   block deletion.
