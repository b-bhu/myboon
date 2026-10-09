import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
import type { HeatmapInterval, TokenHeatmapResult } from './token-heatmap.types';

const finiteOrNull = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value));
const nonNegativeOrNull = (value: unknown) => finiteOrNull(value) && (value === null || (value as number) >= 0);
const isoOrNull = (value: unknown) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

function isResult(payload: unknown, interval: HeatmapInterval): payload is TokenHeatmapResult {
  if (!payload || typeof payload !== 'object') return false;
  const result = payload as TokenHeatmapResult;
  if (result.chain !== 'solana' || result.source !== 'jupiter' || result.interval !== interval || result.limit !== 20
    || !['ready', 'partial', 'stale', 'unavailable'].includes(result.status)
    || typeof result.stale !== 'boolean' || typeof result.partial !== 'boolean'
    || !isoOrNull(result.fetchedAt) || !isoOrNull(result.nextRefreshAt)
    || !Array.isArray(result.tokens) || result.tokens.length > 20) return false;
  if (result.error && (typeof result.error.code !== 'string' || typeof result.error.message !== 'string' || typeof result.error.retryable !== 'boolean')) return false;
  if (result.status === 'unavailable') return result.tokens.length === 0 && !!result.error;
  if (result.fetchedAt === null) return false;
  const addresses = new Set<string>();
  return result.tokens.every((token) => {
    if (!token || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token.address) || addresses.has(token.address)
      || typeof token.symbol !== 'string' || !token.symbol.trim() || typeof token.name !== 'string'
      || typeof token.volumeUsd !== 'number' || !Number.isFinite(token.volumeUsd) || token.volumeUsd <= 0
      || !finiteOrNull(token.priceChangePct) || !nonNegativeOrNull(token.priceUsd)
      || !nonNegativeOrNull(token.marketCapUsd) || !nonNegativeOrNull(token.liquidityUsd)) return false;
    addresses.add(token.address);
    return true;
  });
}

export async function fetchTokenHeatmap(interval: HeatmapInterval, signal?: AbortSignal): Promise<TokenHeatmapResult> {
  const response = await fetchWithTimeout(`${resolveApiBaseUrl()}/market/token-heatmap?interval=${interval}`, { signal });
  const payload: unknown = await response.json();
  if (isResult(payload, interval) && ((response.ok && payload.status !== 'unavailable') || (response.status === 503 && payload.status === 'unavailable'))) return payload;
  throw new Error('Token heatmap could not be loaded. Try again.');
}
