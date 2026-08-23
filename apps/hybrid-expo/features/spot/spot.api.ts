import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
import { apiClientSessionHeaders } from '@/lib/api-client-session';
import type { TokenIdentity } from '@/lib/token-identity.core';

export type OrganicActivity = 'high' | 'medium' | 'low' | 'unknown';
export type VerificationState = 'verified' | 'unverified' | 'unknown';

export interface SpotTokenSummary {
  identity: TokenIdentity;
  usdPrice: number | null;
  momentumPct: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  market: { marketCapUsd: number | null; liquidityUsd: number | null; volume24hUsd: number | null };
  warnings: { verification: VerificationState; organicActivity: OrganicActivity; suspicious: true | null };
  updatedAt: string | null;
}

export interface SpotTokenListResponse { items: SpotTokenSummary[]; ranking: 'toptrending_1h'; asOf: string; partial: boolean }
export interface SpotTokenSearchResponse { query: string; items: SpotTokenSummary[]; asOf: string; partial: boolean }
export interface SpotPriceResponse { prices: { mint: string; usdPrice: number | null; blockId: number | null }[]; asOf: string }

export class SpotApiError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly requestId: string | null = null) {
    super(message);
    this.name = 'SpotApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithTimeout(`${resolveApiBaseUrl()}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...apiClientSessionHeaders(), ...init?.headers },
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const envelope = payload && typeof payload === 'object' ? (payload as { error?: Record<string, unknown> }).error : null;
    throw new SpotApiError(
      typeof envelope?.code === 'string' ? envelope.code : `HTTP_${response.status}`,
      typeof envelope?.message === 'string' ? envelope.message : 'Spot data is unavailable.',
      envelope?.retryable === true || response.status >= 500,
      typeof envelope?.requestId === 'string' ? envelope.requestId : null,
    );
  }
  return payload as T;
}

export function fetchSpotTokens(limit = 30): Promise<SpotTokenListResponse> {
  return request<SpotTokenListResponse>(`/swap/tokens?limit=${Math.min(50, Math.max(1, Math.floor(limit)))}`);
}

export function searchSpotTokens(query: string): Promise<SpotTokenSearchResponse> {
  return request<SpotTokenSearchResponse>(`/swap/tokens/search?query=${encodeURIComponent(query.trim())}`);
}

export async function fetchSpotPrices(mints: readonly string[]): Promise<SpotPriceResponse> {
  const unique = Array.from(new Set(mints)).slice(0, 50);
  if (unique.length === 0) return { prices: [], asOf: new Date().toISOString() };
  return request<SpotPriceResponse>(`/swap/prices?ids=${encodeURIComponent(unique.join(','))}`);
}
