import type {
  SpotPriceResponse,
  SpotTokenSearchResponse,
  SpotTokenSummary,
  SwapApiErrorBody,
  SwapExecuteRequest,
  SwapExecuteResponse,
  SwapOrderRequest,
  SwapOrderResponse,
  SwapToken,
} from '@/features/swap/swap.types';
import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
import { apiClientSessionHeaders } from '@/lib/api-client-session';

const swapApiBase = () => `${resolveApiBaseUrl()}/swap`;

export class SwapApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'SwapApiError';
  }
}

function sameOriginIconUrl(iconUrl: string | null): string | undefined {
  if (!iconUrl) return undefined;
  if (iconUrl.startsWith('/')) return `${resolveApiBaseUrl()}${iconUrl}`;
  try {
    const icon = new URL(iconUrl);
    const api = new URL(resolveApiBaseUrl());
    return icon.origin === api.origin ? icon.toString() : undefined;
  } catch {
    return undefined;
  }
}

function toSwapToken(row: SpotTokenSummary): SwapToken | null {
  const { identity } = row;
  if (!identity.mint || identity.decimals === null || identity.decimals < 0) return null;
  return {
    address: identity.mint,
    symbol: identity.symbol,
    name: identity.name,
    decimals: identity.decimals,
    logoURI: sameOriginIconUrl(identity.iconUrl),
  };
}

function isErrorBody(value: unknown): value is SwapApiErrorBody {
  if (!value || typeof value !== 'object') return false;
  const error = (value as { error?: unknown }).error;
  return !!error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string';
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${swapApiBase()}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...apiClientSessionHeaders(),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'The trading service took too long to respond.'
      : 'The trading service is unreachable.';
    throw new SwapApiError(message, 0, 'NETWORK_ERROR', true, null);
  }

  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    if (isErrorBody(payload)) {
      throw new SwapApiError(
        payload.error.message,
        response.status,
        payload.error.code,
        payload.error.retryable,
        payload.error.requestId,
      );
    }
    throw new SwapApiError('The trading service returned an invalid response.', response.status, 'INVALID_RESPONSE', response.status >= 500, null);
  }
  return payload as T;
}

export async function fetchSwapTokens(limit = 30): Promise<SwapToken[]> {
  const payload = await requestJson<{ items: SpotTokenSummary[] }>(`/tokens?limit=${encodeURIComponent(String(limit))}`);
  return payload.items.map(toSwapToken).filter((token): token is SwapToken => token !== null);
}

export async function searchSwapTokens(query: string): Promise<SwapToken[]> {
  const normalized = query.trim();
  if (!normalized) return fetchSwapTokens(30);
  const payload = await requestJson<SpotTokenSearchResponse>(
    `/tokens/search?query=${encodeURIComponent(normalized)}`,
  );
  return payload.items.map(toSwapToken).filter((token): token is SwapToken => token !== null);
}

export async function fetchTokenPrices(mints: string[]): Promise<SpotPriceResponse> {
  const unique = [...new Set(mints.filter(Boolean))];
  if (unique.length === 0) return { prices: [], asOf: new Date().toISOString() };
  return requestJson<SpotPriceResponse>(`/prices?ids=${encodeURIComponent(unique.join(','))}`);
}

export function createSwapOrder(
  request: SwapOrderRequest,
  signal?: AbortSignal,
): Promise<SwapOrderResponse> {
  return requestJson<SwapOrderResponse>('/order', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
  });
}

export function executeSwap(request: SwapExecuteRequest): Promise<SwapExecuteResponse> {
  return requestJson<SwapExecuteResponse>('/execute', {
    method: 'POST',
    body: JSON.stringify(request),
    timeoutMs: 45_000,
  } as RequestInit & { timeoutMs: number });
}
