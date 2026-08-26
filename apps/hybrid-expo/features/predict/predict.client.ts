import * as SecureStore from 'expo-secure-store';
import type { SecureClient } from '@polymarket/client';
import type { Signer } from '@/features/chain/chain.contract';
import { createPolymarketSecureClient } from './predict.signing';

type ApiKeyCreds = SecureClient['credentials'];

let active: { address: string; client: SecureClient } | null = null;
const pending = new Map<string, Promise<SecureClient>>();
let desiredAddress: string | null = null;
const listeners = new Set<(snapshot: { address: string; client: SecureClient } | null) => void>();
let lifecycleConsumers = 0;

function notifyListeners(): void {
  listeners.forEach((listener) => listener(active));
}

function normalizedAddress(address: string): string {
  return address.toLowerCase();
}

function credentialsKey(address: string): string {
  return `predict_clob_credentials_${normalizedAddress(address).replace(/^0x/u, '')}`;
}

function isCredentials(value: unknown): value is ApiKeyCreds {
  if (!value || typeof value !== 'object') return false;
  const creds = value as Record<string, unknown>;
  return typeof creds.key === 'string' && creds.key.length > 0
    && typeof creds.secret === 'string' && creds.secret.length > 0
    && typeof creds.passphrase === 'string' && creds.passphrase.length > 0;
}

async function readCredentials(address: string): Promise<ApiKeyCreds | undefined> {
  const raw = await SecureStore.getItemAsync(credentialsKey(address));
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isCredentials(parsed)) return parsed;
  } catch {
    // Corrupt credentials are discarded below and fresh auth is used.
  }
  await SecureStore.deleteItemAsync(credentialsKey(address));
  return undefined;
}

async function storeCredentials(address: string, credentials: ApiKeyCreds): Promise<void> {
  await SecureStore.setItemAsync(credentialsKey(address), JSON.stringify(credentials));
}

async function closeClient(client: SecureClient): Promise<void> {
  await client.closeSubscriptions().catch(() => {});
}

export function getActivePolymarketClient(address?: string | null): SecureClient | null {
  if (!active) return null;
  return !address || active.address === normalizedAddress(address) ? active.client : null;
}

export function subscribePolymarketClient(
  listener: (snapshot: { address: string; client: SecureClient } | null) => void,
): () => void {
  listeners.add(listener);
  listener(active);
  return () => listeners.delete(listener);
}

/** Release transient SDK resources when the final Predict lifecycle owner unmounts. */
export function retainPolymarketClientLifecycle(): () => void {
  lifecycleConsumers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lifecycleConsumers = Math.max(0, lifecycleConsumers - 1);
    if (lifecycleConsumers === 0) void releasePolymarketClient();
  };
}

export async function activatePolymarketClient(
  signer: Signer,
  address: string,
): Promise<SecureClient> {
  const key = normalizedAddress(address);
  desiredAddress = key;
  if (active?.address === key) return active.client;
  const existing = pending.get(key);
  if (existing) return existing;
  const previous = active;
  active = null;
  if (previous) notifyListeners();
  if (previous) void closeClient(previous.client);

  const creation = (async () => {
    const credentials = await readCredentials(key);
    const client = await createPolymarketSecureClient(signer, address, credentials);
    if (normalizedAddress(client.account.signer) !== key) {
      await closeClient(client);
      throw new Error('Polymarket authenticated a different signer. Reconnect and try again.');
    }
    // Stable SDK WalletType.DEPOSIT_WALLET is 3. Do not permit an EOA/Safe
    // account to silently replace the product's required Deposit Wallet.
    if (client.account.walletType !== 3) {
      await closeClient(client);
      throw new Error('Polymarket did not resolve a Deposit Wallet for this signer.');
    }
    await storeCredentials(key, client.credentials);
    if (desiredAddress !== key) {
      await closeClient(client);
      throw new Error('Predict wallet changed while the account was connecting.');
    }
    active = { address: key, client };
    notifyListeners();
    return client;
  })();

  pending.set(key, creation);
  try {
    return await creation;
  } finally {
    pending.delete(key);
  }
}

export async function releasePolymarketClient(address?: string | null): Promise<void> {
  const key = address ? normalizedAddress(address) : null;
  if (!key || desiredAddress === key) desiredAddress = null;
  if (!active) return;
  if (key && active.address !== key) return;
  const previous = active;
  active = null;
  notifyListeners();
  await closeClient(previous.client);
}

export async function disablePolymarketClient(
  address: string,
  expectedClient?: SecureClient | null,
): Promise<void> {
  const key = normalizedAddress(address);
  const client = expectedClient ?? (active?.address === key ? active.client : null);
  if (!client) {
    throw new Error('Predict is not active, so its API key could not be revoked. Reopen Predict and try again.');
  }

  // Explicit disconnect is credential revocation, unlike background release.
  // Keep the client and SecureStore copy intact when revocation cannot reach
  // Polymarket so the UI never falsely claims the credential was revoked.
  await client.endAuthentication();
  if (active?.client === client) {
    active = null;
    desiredAddress = null;
    notifyListeners();
  }
  await SecureStore.deleteItemAsync(credentialsKey(address));
}
