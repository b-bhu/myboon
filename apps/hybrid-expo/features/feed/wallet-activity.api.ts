import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
import type { ActivityToken, WalletActivityResult } from './wallet-activity.types';

const mint = (value: unknown): value is string => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const metric = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
const token = (value: unknown): value is ActivityToken => {
  if (!value || typeof value !== 'object') return false;
  const row = value as ActivityToken;
  return mint(row.address) && typeof row.symbol === 'string' && !!row.symbol.trim() && typeof row.name === 'string';
};

export function isWalletActivityResult(value: unknown): value is WalletActivityResult {
  if (!value || typeof value !== 'object') return false;
  const data = value as WalletActivityResult;
  if (data.chain !== 'solana' || data.source !== 'birdeye'
    || !['ready', 'partial', 'stale', 'unavailable'].includes(data.status)
    || typeof data.stale !== 'boolean' || typeof data.partial !== 'boolean'
    || !(data.fetchedAt === null || iso(data.fetchedAt)) || !(data.nextRefreshAt === null || iso(data.nextRefreshAt))
    || !data.coverage || data.coverage.limited !== true || data.coverage.lookbackDays !== 30
    || !Number.isInteger(data.coverage.walletCount) || data.coverage.walletCount < 0 || data.coverage.walletCount > 3
    || !Array.isArray(data.coverage.tokens) || data.coverage.tokens.length > 3 || !data.coverage.tokens.every(token)
    || new Set(data.coverage.tokens.map((row) => row.address)).size !== data.coverage.tokens.length
    || !Array.isArray(data.activities) || data.activities.length > 20) return false;
  if (data.error && (typeof data.error.code !== 'string' || typeof data.error.retryable !== 'boolean' || typeof data.error.message !== 'string')) return false;
  if ((data.status === 'stale') !== data.stale || (data.status === 'partial' && !data.partial)) return false;
  if (data.status === 'unavailable') return data.activities.length === 0 && !!data.error;
  if (!iso(data.fetchedAt)) return false;
  const covered = new Set(data.coverage.tokens.map((row) => row.address));
  const ids = new Set<string>();
  return data.activities.every((row) => {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id) || !mint(row.walletAddress)
      || !Array.isArray(row.walletLabels) || row.walletLabels.length === 0 || row.walletLabels.length > 2
      || !row.walletLabels.every((label) => label === 'kol' || label === 'smart_trader')
      || new Set(row.walletLabels).size !== row.walletLabels.length
      || !token(row.classificationToken) || !covered.has(row.classificationToken.address)
      || !mint(row.tokenAddress) || !covered.has(row.tokenAddress) || row.classificationToken.address !== row.tokenAddress
      || typeof row.tokenSymbol !== 'string' || !row.tokenSymbol.trim()
      || (row.action !== 'buy' && row.action !== 'sell')
      || typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount <= 0
      || !metric(row.priceUsd) || !metric(row.valueUsd)
      || typeof row.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(row.signature)
      || !iso(row.observedAt)) return false;
    ids.add(row.id);
    return true;
  });
}

export async function fetchWalletActivity(signal?: AbortSignal): Promise<WalletActivityResult> {
  const response = await fetchWithTimeout(`${resolveApiBaseUrl()}/market/wallet-activity`, { signal, timeoutMs: 30_000 });
  const payload: unknown = await response.json();
  if (isWalletActivityResult(payload) && ((response.ok && payload.status !== 'unavailable') || (response.status === 503 && payload.status === 'unavailable'))) return payload;
  throw new Error('Wallet activity could not be loaded. Try again.');
}
