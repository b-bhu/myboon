/**
 * Polymarket signer adapter and SecureClient factory.
 *
 * The Privy wallet remains the only holder of EOA key material. The unified
 * SDK owns CLOB authentication, Deposit Wallet derivation/deployment and all
 * transaction workflows. Builder credentials are signed remotely by the API.
 */

import {
  createSecureClient,
  forkEnvironmentConfig,
  remoteBuilderSigning,
} from '@polymarket/client';
import type {
  SecureClient,
  Signer as PolymarketSigner,
  TransactionHandle,
} from '@polymarket/client';
import type { Signer } from '@/features/chain/chain.contract';
import { resolveApiBaseUrl, fetchWithTimeout } from '@/lib/api';

type ApiKeyCreds = SecureClient['credentials'];

const CLOB_HOST = process.env.EXPO_PUBLIC_CLOB_HOST?.trim()
  || `${resolveApiBaseUrl()}/clob/proxy`;
const RELAYER_HOST = process.env.EXPO_PUBLIC_RELAYER_HOST?.trim()
  || `${resolveApiBaseUrl()}/clob/relayer-proxy`;
const BUILDER_SIGN_URL = `${resolveApiBaseUrl()}/clob/builder/sign`;
const POLYGON_RPC_URL = process.env.EXPO_PUBLIC_POLYGON_RPC_URL?.trim()
  || 'https://polygon-rpc.com';
const BUILDER_PROOF_TTL_MS = 3 * 60 * 1000;

export const POLYMARKET_BUILDER_CODE =
  '0xda0aa9e10ba50d0077e25e94cf9e4d9ef749821528acf6fc758df962d67b63ed';

const POLYMARKET_ENVIRONMENT = forkEnvironmentConfig({
  name: 'myboon-proxies',
  clob: { rest: CLOB_HOST },
  relayer: { rest: RELAYER_HOST },
  rpc: POLYGON_RPC_URL,
});

async function assertSignerAddress(signer: Signer, expected: string): Promise<void> {
  const actual = await signer.getAddress();
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('Predict signer changed. Reconnect Predict and try again.');
  }
}

export async function createPredictAuthProof(
  signer: Signer,
  address: string,
): Promise<{ authTimestamp: number; authSignature: string }> {
  await assertSignerAddress(signer, address);
  const authTimestamp = Date.now();
  const authSignature = await signer.signMessage([
    'myboon:predict:builder-auth',
    `address:${address.toLowerCase()}`,
    `timestamp:${authTimestamp}`,
  ].join('\n'));
  return { authTimestamp, authSignature };
}

async function waitForPolygonTransaction(
  transactionHash: TransactionHandle['transactionHash'],
  { timeoutMs = 60_000, intervalMs = 2_000 } = {},
): Promise<{ transactionHash: NonNullable<TransactionHandle['transactionHash']>; transactionId: null }> {
  if (!transactionHash) throw new Error('Wallet did not return a transaction hash.');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetchWithTimeout(POLYGON_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [transactionHash],
      }),
    });
    const body = await response.json().catch(() => null);
    const receipt = body?.result;
    if (receipt) {
      if (receipt.status === '0x0') throw new Error(`Transaction ${transactionHash} reverted.`);
      return { transactionHash, transactionId: null };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Transaction ${transactionHash} was submitted but has not confirmed yet. `
    + 'It may still succeed — check before retrying.',
  );
}

function toPolymarketSigner(signer: Signer): PolymarketSigner {
  return {
    getAddress: async () => (await signer.getAddress()) as Awaited<ReturnType<PolymarketSigner['getAddress']>>,
    signMessage: async (message) => (
      await signer.signMessage(message)
    ) as Awaited<ReturnType<PolymarketSigner['signMessage']>>,
    signTypedData: async (payload) => {
      const mutableTypes = Object.fromEntries(
        Object.entries(payload.types).map(([key, fields]) => [key, [...fields]]),
      );
      return (
        await signer.signTypedData(payload.domain, mutableTypes, payload.message)
      ) as Awaited<ReturnType<PolymarketSigner['signTypedData']>>;
    },
    sendTransaction: async (request): Promise<TransactionHandle> => {
      const hash = await signer.sendTransaction({
        to: request.to,
        data: request.data,
        value: request.value,
        chainId: request.chainId,
      });
      const transactionHash = hash as TransactionHandle['transactionHash'];
      return {
        transactionHash,
        transactionId: null,
        wait: () => waitForPolygonTransaction(transactionHash),
      };
    },
  };
}

function createBuilderProofHeaders(signer: Signer, address: string) {
  let cached: { headers: Record<string, string>; mintedAt: number } | null = null;
  return async (): Promise<Record<string, string>> => {
    if (cached && Date.now() - cached.mintedAt < BUILDER_PROOF_TTL_MS) return cached.headers;
    const { authTimestamp, authSignature } = await createPredictAuthProof(signer, address);
    const headers = {
      'X-Predict-Address': address,
      'X-Predict-Timestamp': `${authTimestamp}`,
      'X-Predict-Signature': authSignature,
    };
    cached = { headers, mintedAt: Date.now() };
    return headers;
  };
}

export async function createPolymarketSecureClient(
  signer: Signer,
  address: string,
  credentials?: ApiKeyCreds,
): Promise<SecureClient> {
  await assertSignerAddress(signer, address);
  return createSecureClient({
    environment: POLYMARKET_ENVIRONMENT,
    signer: toPolymarketSigner(signer),
    apiKey: remoteBuilderSigning({
      url: BUILDER_SIGN_URL,
      headers: createBuilderProofHeaders(signer, address),
    }),
    ...(credentials ? { credentials } : {}),
  });
}
