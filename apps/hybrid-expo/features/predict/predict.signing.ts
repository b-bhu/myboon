/**
 * predict.signing — every signature Polymarket needs, over a resolver-supplied
 * `Signer`.
 *
 * Each entry point takes its `Signer` as an argument. There is deliberately no
 * module-level signer here: the spec's governing rule is that applications
 * declare a requirement and receive a signer scoped to the call, rather than
 * reaching for a global. Callers obtain one from
 * `useChainSigner(POLYMARKET_REQUIREMENT)`.
 *
 * Key material never appears in this module. The EOA is a Privy embedded EVM
 * wallet; we only ever ask it to sign.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md
 */

import { ClobClient, OrderType, Side, SignatureTypeV2, Chain } from '@polymarket/clob-client-v2';
import type { ApiKeyCreds, SignedOrder } from '@polymarket/clob-client-v2';
import { createSecureClient, forkEnvironmentConfig } from '@polymarket/client';
import type { SecureClient, Signer as PolymarketSigner, TransactionHandle } from '@polymarket/client';
import type { Signer } from '@/features/chain/chain.contract';
import { resolveApiBaseUrl, fetchWithTimeout } from '@/lib/api';
import type { PlaceBetParams } from './predict.api';

/**
 * Where the CLOB client sends L1 auth calls.
 *
 * Defaults to our own `/clob` proxy rather than `clob.polymarket.com` directly:
 * devices on some networks cannot reach Polymarket at all, which surfaced as an
 * axios "Network Error" with no status. Every other Polymarket read in the app
 * already goes through this proxy for the same reason — the credential calls
 * were simply written before it existed.
 *
 * The EIP-712 signature is still produced on the device and travels in the
 * `POLY_SIGNATURE` header; the server relays bytes and never sees key material.
 *
 * Set `EXPO_PUBLIC_CLOB_HOST` to override — point it at `https://clob.polymarket.com`
 * to go direct on a network that allows it.
 */
const CLOB_HOST = process.env.EXPO_PUBLIC_CLOB_HOST?.trim()
  || `${resolveApiBaseUrl()}/clob`;
const CHAIN_ID = Chain.POLYGON;
const BUILDER_CODE = '0xda0aa9e10ba50d0077e25e94cf9e4d9ef749821528acf6fc758df962d67b63ed';
const DEPOSIT_WALLET_FACTORY = '0x00000000000fb5c9adea0298d729a0cb3823cc07';
const CONTRACTS = {
  PUSD: '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb',
  USDC_E: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
  COLLATERAL_ONRAMP: '0x93070a847efef7f70739046a929d47a521f5b8ee',
  CTF_COLLATERAL_ADAPTER: '0xada100db00ca00073811820692005400218fce1f',
  NEG_RISK_CTF_COLLATERAL_ADAPTER: '0xada2005600dec949baf300f4c6120000bdb6eaab',
  CTF_EXCHANGE_V2: '0xe111180000d2663c0091e4f400237545b87b996b',
  NEG_RISK_CTF_EXCHANGE_V2: '0xe2222d279d744050d28e00520010520000310f59',
  NEG_RISK_ADAPTER: '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296',
  CTF: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
} as const;
const APPROVAL_OPERATORS: Set<string> = new Set([
  CONTRACTS.CTF_EXCHANGE_V2,
  CONTRACTS.NEG_RISK_CTF_EXCHANGE_V2,
  CONTRACTS.NEG_RISK_ADAPTER,
  CONTRACTS.CTF_COLLATERAL_ADAPTER,
  CONTRACTS.NEG_RISK_CTF_COLLATERAL_ADAPTER,
]);
const MAX_UINT256 = 'f'.repeat(64);
const SELECTORS = {
  approve: '0x095ea7b3',
  setApprovalForAll: '0xa22cb465',
  transfer: '0xa9059cbb',
  wrap: '0x62355638',
  redeemPositions: '0x01b7037c',
} as const;

export interface DepositWalletCallToSign {
  target: string;
  value: string;
  data: string;
}

export interface DepositWalletSignatureRequest {
  kind: 'deposit_wallet_batch';
  operation: string;
  ownerAddress: string;
  depositWalletAddress: string;
  chainId: number;
  nonce: string;
  deadline: string;
  calls: DepositWalletCallToSign[];
}

export interface SignedDepositWalletBatch {
  type: 'WALLET';
  from: string;
  to: string;
  nonce: string;
  signature: string;
  depositWalletParams: {
    depositWallet: string;
    deadline: string;
    calls: DepositWalletCallToSign[];
  };
}

export type DepositWalletSigningContext =
  | { operation: 'predict_setup' }
  | { operation: 'wrap' }
  | { operation: 'withdraw'; amount: number; bridgeAddress: string }
  | { operation: 'redeem'; conditionId?: string; negativeRisk?: boolean };

const DEPOSIT_WALLET_TYPES = {
  Call: [
    { name: 'target', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ],
  Batch: [
    { name: 'wallet', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'calls', type: 'Call[]' },
  ],
};

function normalizeAddress(value: string): string {
  return value.toLowerCase();
}

function isApiKeyCreds(value: unknown): value is ApiKeyCreds {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ApiKeyCreds>;
  return (
    typeof candidate.key === 'string' &&
    candidate.key.length > 0 &&
    typeof candidate.secret === 'string' &&
    candidate.secret.length > 0 &&
    typeof candidate.passphrase === 'string' &&
    candidate.passphrase.length > 0
  );
}

/**
 * Describe why a CLOB credential call failed, whatever shape it failed in.
 *
 * Anything unrecognised previously returned `null`, so the caller's message
 * ended in a bare "." — which reported a real failure (a geoblock HTML 403, an
 * L1 auth rejection, a transport error) as if nothing had gone wrong. The
 * unknown shapes are exactly the ones worth seeing, so they are stringified
 * rather than dropped, and any HTTP status the client attached is preserved.
 */
function apiCredsFailureMessage(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Error) {
    // Axios attaches the response to the error; a transport failure ("Network
    // Error") has none, which is itself the useful signal.
    const response = (value as { response?: { status?: unknown; data?: unknown } }).response;
    const status = typeof response?.status === 'number' ? ` (HTTP ${response.status})` : '';
    const code = (value as { code?: unknown }).code;
    const codeLabel = typeof code === 'string' && code ? ` [${code}]` : '';
    return `${value.message}${status}${codeLabel}`;
  }

  if (typeof value === 'string') return value || null;

  if (typeof value === 'object') {
    const candidate = value as { error?: unknown; status?: unknown; message?: unknown };
    const status = typeof candidate.status === 'number' ? ` (${candidate.status})` : '';
    if (typeof candidate.error === 'string' && candidate.error) {
      return `${candidate.error}${status}`;
    }
    if (typeof candidate.message === 'string' && candidate.message) {
      return `${candidate.message}${status}`;
    }
    // Unknown object shape — say what came back rather than swallowing it.
    try {
      const serialised = JSON.stringify(value);
      if (serialised && serialised !== '{}') return `${serialised.slice(0, 200)}${status}`;
    } catch {
      // Circular or otherwise unserialisable; fall through to the type label.
    }
    return `unexpected response${status}`;
  }

  return String(value);
}

function ensureHexWord(data: string, index: number): string {
  const normalized = data.toLowerCase();
  const start = 10 + index * 64;
  const word = normalized.slice(start, start + 64);
  if (word.length !== 64) throw new Error('Invalid Predict wallet action calldata.');
  return word;
}

function wordAddress(word: string): string {
  return `0x${word.slice(24)}`;
}

function wordBigInt(word: string): bigint {
  return BigInt(`0x${word}`);
}

function assertZeroValue(call: DepositWalletCallToSign) {
  if (BigInt(call.value || '0') !== 0n) {
    throw new Error('Predict refused to sign a wallet action with native token value.');
  }
}

function assertApprove(call: DepositWalletCallToSign, token: string, spender: string, amount?: bigint) {
  assertZeroValue(call);
  const data = call.data.toLowerCase();
  if (normalizeAddress(call.target) !== normalizeAddress(token) || !data.startsWith(SELECTORS.approve)) {
    throw new Error('Predict refused to sign an unexpected token approval.');
  }
  if (normalizeAddress(wordAddress(ensureHexWord(data, 0))) !== normalizeAddress(spender)) {
    throw new Error('Predict refused to sign approval for an unexpected spender.');
  }
  const approvedAmountWord = ensureHexWord(data, 1);
  if (amount !== undefined) {
    if (wordBigInt(approvedAmountWord) !== amount) {
      throw new Error('Predict refused to sign approval for an unexpected amount.');
    }
  } else if (approvedAmountWord !== MAX_UINT256) {
    throw new Error('Predict refused to sign a non-standard setup approval amount.');
  }
}

function assertSetApprovalForAll(call: DepositWalletCallToSign, operator: string) {
  assertZeroValue(call);
  const data = call.data.toLowerCase();
  if (normalizeAddress(call.target) !== CONTRACTS.CTF || !data.startsWith(SELECTORS.setApprovalForAll)) {
    throw new Error('Predict refused to sign an unexpected CTF approval.');
  }
  if (normalizeAddress(wordAddress(ensureHexWord(data, 0))) !== normalizeAddress(operator)) {
    throw new Error('Predict refused to sign CTF approval for an unexpected operator.');
  }
  if (wordBigInt(ensureHexWord(data, 1)) !== 1n) {
    throw new Error('Predict refused to sign CTF approval removal.');
  }
}

function validateSetupCalls(calls: DepositWalletCallToSign[]) {
  if (calls.length !== APPROVAL_OPERATORS.size * 2) {
    throw new Error('Predict refused to sign an unexpected setup action count.');
  }
  const approvedErc20 = new Set<string>();
  const approvedCtf = new Set<string>();
  for (const call of calls) {
    const data = call.data.toLowerCase();
    if (data.startsWith(SELECTORS.approve)) {
      const spender = normalizeAddress(wordAddress(ensureHexWord(data, 0)));
      if (!APPROVAL_OPERATORS.has(spender)) throw new Error('Predict refused to sign setup approval for an unknown spender.');
      assertApprove(call, CONTRACTS.PUSD, spender);
      approvedErc20.add(spender);
    } else if (data.startsWith(SELECTORS.setApprovalForAll)) {
      const operator = normalizeAddress(wordAddress(ensureHexWord(data, 0)));
      if (!APPROVAL_OPERATORS.has(operator)) throw new Error('Predict refused to sign setup CTF approval for an unknown operator.');
      assertSetApprovalForAll(call, operator);
      approvedCtf.add(operator);
    } else {
      throw new Error('Predict refused to sign an unknown setup action.');
    }
  }
  if (approvedErc20.size !== APPROVAL_OPERATORS.size || approvedCtf.size !== APPROVAL_OPERATORS.size) {
    throw new Error('Predict refused to sign incomplete setup approvals.');
  }
}

function validateWrapCalls(calls: DepositWalletCallToSign[], depositWalletAddress: string) {
  if (calls.length !== 2) throw new Error('Predict refused to sign an unexpected wrap action count.');
  const approveAmount = wordBigInt(ensureHexWord(calls[0].data, 1));
  assertApprove(calls[0], CONTRACTS.USDC_E, CONTRACTS.COLLATERAL_ONRAMP, approveAmount);

  const wrap = calls[1];
  assertZeroValue(wrap);
  const data = wrap.data.toLowerCase();
  if (normalizeAddress(wrap.target) !== CONTRACTS.COLLATERAL_ONRAMP || !data.startsWith(SELECTORS.wrap)) {
    throw new Error('Predict refused to sign an unexpected wrap action.');
  }
  if (normalizeAddress(wordAddress(ensureHexWord(data, 0))) !== CONTRACTS.USDC_E) {
    throw new Error('Predict refused to sign wrap for an unexpected asset.');
  }
  if (normalizeAddress(wordAddress(ensureHexWord(data, 1))) !== normalizeAddress(depositWalletAddress)) {
    throw new Error('Predict refused to sign wrap to an unexpected wallet.');
  }
  if (wordBigInt(ensureHexWord(data, 2)) !== approveAmount || approveAmount <= 0n) {
    throw new Error('Predict refused to sign wrap for an unexpected amount.');
  }
}

function validateWithdrawCalls(calls: DepositWalletCallToSign[], amount: number, bridgeAddress: string) {
  if (calls.length !== 1) throw new Error('Predict refused to sign an unexpected withdraw action count.');
  const call = calls[0];
  assertZeroValue(call);
  const data = call.data.toLowerCase();
  if (normalizeAddress(call.target) !== CONTRACTS.PUSD || !data.startsWith(SELECTORS.transfer)) {
    throw new Error('Predict refused to sign an unexpected withdraw transfer.');
  }
  if (normalizeAddress(wordAddress(ensureHexWord(data, 0))) !== normalizeAddress(bridgeAddress)) {
    throw new Error('Predict refused to sign withdraw to an unverified bridge address.');
  }
  const expectedAmount = BigInt(Math.floor(amount * 1_000_000));
  if (expectedAmount <= 0n || wordBigInt(ensureHexWord(data, 1)) !== expectedAmount) {
    throw new Error('Predict refused to sign withdraw for an unexpected amount.');
  }
}

function validateRedeemCalls(calls: DepositWalletCallToSign[], context: Extract<DepositWalletSigningContext, { operation: 'redeem' }>) {
  if (calls.length === 0 || calls.length > 3) throw new Error('Predict refused to sign an unexpected collect action count.');
  for (const call of calls) {
    const data = call.data.toLowerCase();
    if (data.startsWith(SELECTORS.setApprovalForAll)) {
      const operator = normalizeAddress(wordAddress(ensureHexWord(data, 0)));
      if (operator !== CONTRACTS.CTF_COLLATERAL_ADAPTER && operator !== CONTRACTS.NEG_RISK_CTF_COLLATERAL_ADAPTER) {
        throw new Error('Predict refused to sign collect approval for an unknown operator.');
      }
      assertSetApprovalForAll(call, operator);
      continue;
    }
    if (!data.startsWith(SELECTORS.redeemPositions)) {
      throw new Error('Predict refused to sign an unknown collect action.');
    }
    const target = normalizeAddress(call.target);
    const allowedTarget = target === CONTRACTS.CTF
      || target === CONTRACTS.CTF_COLLATERAL_ADAPTER
      || target === CONTRACTS.NEG_RISK_CTF_COLLATERAL_ADAPTER;
    if (!allowedTarget) throw new Error('Predict refused to sign collect for an unexpected contract.');
    if (context.conditionId && ensureHexWord(data, 2) !== context.conditionId.toLowerCase().replace(/^0x/, '')) {
      throw new Error('Predict refused to sign collect for an unexpected market.');
    }
    assertZeroValue(call);
  }
}

function validateDepositWalletSignatureRequest(
  request: DepositWalletSignatureRequest,
  context: DepositWalletSigningContext,
) {
  if (request.operation !== context.operation) {
    throw new Error('Predict refused to sign a mismatched wallet action.');
  }
  if (request.chainId !== CHAIN_ID) {
    throw new Error('Predict refused to sign a wallet action for an unexpected chain.');
  }
  switch (context.operation) {
    case 'predict_setup':
      validateSetupCalls(request.calls);
      break;
    case 'wrap':
      validateWrapCalls(request.calls, request.depositWalletAddress);
      break;
    case 'withdraw':
      validateWithdrawCalls(request.calls, context.amount, context.bridgeAddress);
      break;
    case 'redeem':
      validateRedeemCalls(request.calls, context);
      break;
  }
}

/**
 * `ClobClient` accepts an `EthersSigner`, which is structural: `getAddress()`
 * plus `_signTypedData()`. Our `Signer` already provides both under different
 * names, so this adapter is a rename — not a wallet, and it holds no key.
 */
function toClobSigner(signer: Signer) {
  return {
    getAddress: () => signer.getAddress(),
    _signTypedData: (
      domain: Record<string, unknown>,
      types: Record<string, { name: string; type: string }[]>,
      value: Record<string, unknown>,
    ) => signer.signTypedData(domain, types, value),
  };
}

/**
 * Guard every signature against the signer having changed underneath the flow —
 * a different EOA means a different deposit wallet, so signing on regardless
 * would produce a valid signature for the wrong account.
 */
async function assertSignerAddress(signer: Signer, expected: string): Promise<void> {
  const signerAddress = (await signer.getAddress()).toLowerCase();
  if (signerAddress !== expected.toLowerCase()) {
    throw new Error('Predict signer changed. Reconnect Predict and try again.');
  }
}

export async function createPredictSessionProof(
  signer: Signer,
  address: string,
): Promise<{ authTimestamp: number; authSignature: string }> {
  await assertSignerAddress(signer, address);
  const authTimestamp = Date.now();
  const authSignature = await signer.signMessage([
    'myboon:predict:server-session',
    `address:${address.toLowerCase()}`,
    `timestamp:${authTimestamp}`,
  ].join('\n'));
  return { authTimestamp, authSignature };
}

/**
 * Public Polygon RPC for polling transaction receipts client-side.
 *
 * Only used for a plain `eth_getTransactionReceipt` poll — not a ranged
 * `eth_getLogs` scan, so the free-tier range cap that mattered on the server
 * side (docs/modules/polymarket/PRDs/2026_07_31_polymarket_sdk_migration_PRD.md)
 * doesn't apply here. The app has never needed a client-side Polygon RPC
 * before (every prior write went through the server's relayer, never
 * broadcast directly), so there is no existing client to reuse.
 */
const POLYGON_RPC_URL = process.env.EXPO_PUBLIC_POLYGON_RPC_URL?.trim()
  || 'https://polygon-rpc.com';

/**
 * Poll for a transaction's receipt after `sendTransaction` returns a hash.
 *
 * `Signer.sendTransaction()` resolves once the transaction is broadcast, per
 * standard EIP-1193 `eth_sendTransaction` semantics — not once it's mined.
 * `@polymarket/client`'s `TransactionHandle.wait()` needs the mined outcome,
 * so this fills that gap directly against the chain rather than through the
 * signer (the app's `Signer` interface has no raw JSON-RPC read method, only
 * signing operations).
 */
async function waitForTransaction(
  transactionHash: TransactionHandle['transactionHash'],
  { timeoutMs = 60_000, intervalMs = 2_000 } = {},
): Promise<{ transactionHash: NonNullable<TransactionHandle['transactionHash']>; transactionId: null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetchWithTimeout(POLYGON_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [transactionHash],
      }),
    });
    const body = await res.json().catch(() => null);
    const receipt = body?.result;
    if (receipt) {
      if (receipt.status === '0x0') {
        throw new Error(`Transaction ${transactionHash} reverted.`);
      }
      return { transactionHash: transactionHash as NonNullable<TransactionHandle['transactionHash']>, transactionId: null };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for transaction ${transactionHash} to be mined.`);
}

/**
 * Adapts the app's `Signer` to `@polymarket/client`'s `Signer` shape.
 *
 * Structurally similar to `toClobSigner` above but a different target type:
 * the unified SDK's `Signer` bundles `domain`/`types`/`message` into one
 * `TypedDataPayload` object (`toClobSigner`'s target took them as three
 * positional args), and requires `sendTransaction` — a capability the old
 * `ClobClient` never asked for, because deposit-wallet derivation used to be
 * a pure computation. The new SDK's `createSecureClient` sends a real
 * transaction to deploy the deposit wallet the first time a signer sets up
 * an account (see docs/modules/polymarket/PRDs/2026_07_31_polymarket_sdk_migration_PRD.md
 * for how this was confirmed by reading the SDK's compiled source), so this
 * adapter's `sendTransaction` is load-bearing, not incidental.
 */
function toPolymarketSigner(signer: Signer): PolymarketSigner {
  return {
    // `EvmAddress`/`EvmSignature`/`TransactionHandle`'s hash field are
    // branded string types the SDK uses to keep addresses, signatures, and
    // hashes from being confused with plain strings at compile time — plain
    // strings at runtime, so a cast through `Awaited<ReturnType<...>>` is
    // correct here, not a lie.
    getAddress: async () => (await signer.getAddress()) as Awaited<ReturnType<PolymarketSigner['getAddress']>>,
    signMessage: async (message) => (await signer.signMessage(message)) as Awaited<ReturnType<PolymarketSigner['signMessage']>>,
    signTypedData: async (payload) => {
      // `payload.types` is `TypedData` (readonly field arrays); our `Signer`
      // takes a mutable `{ name, type }[]` — copy rather than cast through,
      // since a `readonly` array assigned into a mutable-typed parameter is
      // a real (if narrow) safety gap the compiler is right to flag.
      const mutableTypes = Object.fromEntries(
        Object.entries(payload.types).map(([key, fields]) => [key, [...fields]]),
      );
      const signature = await signer.signTypedData(payload.domain, mutableTypes, payload.message);
      return signature as Awaited<ReturnType<PolymarketSigner['signTypedData']>>;
    },
    sendTransaction: async (request): Promise<TransactionHandle> => {
      const hash = await signer.sendTransaction({
        to: request.to,
        data: request.data,
        value: request.value,
        chainId: request.chainId,
      });
      const transactionHash = hash as TransactionHandle['transactionHash'];
      // `transactionId` is documented as null "when submitted directly to
      // the blockchain" — exactly this path, since we broadcast via the
      // signer's own EIP-1193 provider, never through Polymarket's relayer.
      return {
        transactionHash,
        transactionId: null,
        wait: () => waitForTransaction(transactionHash),
      };
    },
  };
}

/**
 * The environment `@polymarket/client` calls against — production, except the
 * CLOB REST base, redirected to this app's own proxy.
 *
 * Devices on some networks cannot reach `clob.polymarket.com` directly (an
 * axios "Network Error" with no status) — the same reason `CLOB_HOST` exists
 * below for the old SDK. `forkEnvironmentConfig` is the unified SDK's
 * equivalent of the old `ClobClient`'s `host` option: everything else
 * (contracts, chain ID, relayer, gamma) stays at production defaults, only
 * the CLOB REST endpoint is overridden. Marked `@experimental` by the SDK's
 * own type comments — confirmed to type-check and construct without error,
 * not yet exercised against a live network call; if it turns out not to work
 * end-to-end, the fallback is pointing `rest` at `https://clob.polymarket.com`
 * directly via `EXPO_PUBLIC_CLOB_HOST`, same escape hatch the old SDK had.
 */
const POLYMARKET_ENVIRONMENT = forkEnvironmentConfig({
  name: 'myboon-clob-proxy',
  clob: { rest: CLOB_HOST },
});

/**
 * The unified SDK's account-setup client: CLOB L1 auth, deposit-wallet
 * derivation, and first-time deployment collapse into this one call.
 *
 * Replaces `createPolymarketApiCreds` + the server's old CREATE2 derivation
 * for the *setup* path specifically. `createPolymarketApiCreds` (below)
 * still backs order placement's `ClobClient` construction until that path
 * migrates too — see the PRD's step 4 for why wrap/withdraw/redeem/order
 * signing aren't moved in this same change.
 */
export async function createPolymarketSecureClient(
  signer: Signer,
): Promise<SecureClient> {
  return createSecureClient({
    environment: POLYMARKET_ENVIRONMENT,
    signer: toPolymarketSigner(signer),
  });
}

export async function createPolymarketApiCreds(signer: Signer): Promise<ApiKeyCreds> {
  const client = new ClobClient({
    host: CLOB_HOST,
    chain: CHAIN_ID,
    signer: toClobSigner(signer),
  });
  let deriveFailure: unknown = null;
  try {
    const derived: unknown = await client.deriveApiKey();
    if (isApiKeyCreds(derived)) return derived;
    deriveFailure = derived;
  } catch (error) {
    deriveFailure = error;
  }

  // `createApiKey()` throws on a transport failure rather than resolving with an
  // error shape. Letting that escape surfaced the raw axios "Network Error" and
  // lost the derive attempt's reason entirely — both matter when diagnosing a
  // geoblock, so catch it and report the pair.
  let created: unknown = null;
  try {
    created = await client.createApiKey();
    if (isApiKeyCreds(created)) return created;
  } catch (error) {
    created = error;
  }

  // A wallet that already has a key gets "Could not create api key" here, which
  // is not a dead end: the key exists, the first derive just missed it. Each
  // call signs a fresh timestamp, so retrying derive is a genuinely new request
  // rather than a replay of the one that failed.
  try {
    const rederived: unknown = await client.deriveApiKey();
    if (isApiKeyCreds(rederived)) return rederived;
  } catch {
    // Fall through to the combined error below — the first two attempts carry
    // the diagnostic detail worth reporting.
  }

  const failures = [apiCredsFailureMessage(deriveFailure), apiCredsFailureMessage(created)]
    .filter(Boolean)
    .join('; ');
  throw new Error(
    `Predict could not reach Polymarket to set up your account${failures ? `: ${failures}` : '.'}`,
  );
}

export async function signDepositWalletBatch(
  signer: Signer,
  request: DepositWalletSignatureRequest,
  context: DepositWalletSigningContext,
): Promise<SignedDepositWalletBatch> {
  await assertSignerAddress(signer, request.ownerAddress);
  // Calldata is validated before the signature is produced, never after.
  validateDepositWalletSignatureRequest(request, context);

  const domain = {
    name: 'DepositWallet',
    version: '1',
    chainId: request.chainId,
    verifyingContract: request.depositWalletAddress,
  };
  const message = {
    wallet: request.depositWalletAddress,
    nonce: request.nonce,
    deadline: request.deadline,
    calls: request.calls,
  };
  const signature = await signer.signTypedData(domain, DEPOSIT_WALLET_TYPES, message);

  return {
    type: 'WALLET',
    from: request.ownerAddress,
    to: DEPOSIT_WALLET_FACTORY,
    nonce: request.nonce,
    signature,
    depositWalletParams: {
      depositWallet: request.depositWalletAddress,
      deadline: request.deadline,
      calls: request.calls,
    },
  };
}

export async function signAndSubmitDepositWalletBatch(
  signer: Signer,
  polygonAddress: string,
  request: DepositWalletSignatureRequest,
  context: DepositWalletSigningContext,
): Promise<Record<string, unknown>> {
  const batch = await signDepositWalletBatch(signer, request, context);
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/clob/wallet-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ polygonAddress, batch }),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    // `detail` and `error` before `userMessage`. The server's `failedOperation`
    // sets `userMessage` to a fixed "Something went wrong. Try again in a
    // moment." for every failure, so reading it first replaced the actual cause
    // — relayer rejections, missing builder config, bad nonces — with a string
    // that says nothing. The specific text is what makes a failure diagnosable.
    const detail = typeof data.detail === 'string' && data.detail ? data.detail : null;
    const error = typeof data.error === 'string' && data.error ? data.error : null;
    const userMessage = typeof data.userMessage === 'string' && data.userMessage
      ? data.userMessage
      : null;
    const specific = [error, detail].filter(Boolean).join(': ');
    throw new Error(
      specific || userMessage || 'Failed to submit signed Predict wallet action',
    );
  }
  return data;
}

export async function createSignedPredictOrder(
  signer: Signer,
  params: PlaceBetParams,
): Promise<SignedOrder> {
  const client = new ClobClient({
    host: CLOB_HOST,
    chain: CHAIN_ID,
    signer: toClobSigner(signer),
    signatureType: SignatureTypeV2.POLY_1271,
    funderAddress: params.tradingAddress ?? params.polygonAddress,
    builderConfig: { builderCode: BUILDER_CODE },
  });

  const side = params.side === 'BUY' ? Side.BUY : Side.SELL;
  const orderType = params.orderType === 'FAK'
    ? OrderType.FAK
    : params.orderType === 'FOK'
      ? OrderType.FOK
      : params.orderType === 'GTC'
        ? OrderType.GTC
        : OrderType.GTC;

  if (orderType === OrderType.FOK || orderType === OrderType.FAK) {
    const amount = typeof params.amount === 'number'
      ? params.amount
      : typeof params.size === 'number'
        ? params.size * params.price
        : null;
    if (!amount || amount <= 0) throw new Error('Missing order amount');
    return client.createMarketOrder(
      {
        tokenID: params.tokenID,
        price: params.price,
        amount,
        side,
        orderType,
        builderCode: BUILDER_CODE,
      },
      { tickSize: '0.01', negRisk: !!params.negRisk },
    );
  }

  if (typeof params.size !== 'number') throw new Error('Missing order size');
  return client.createOrder(
    {
      tokenID: params.tokenID,
      price: params.price,
      size: params.size,
      side,
      builderCode: BUILDER_CODE,
    },
    { tickSize: '0.01', negRisk: !!params.negRisk },
  );
}
