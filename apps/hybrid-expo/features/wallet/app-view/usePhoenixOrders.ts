/**
 * usePhoenixOrders — the server call behind the Phoenix Orders tab (issue
 * #850). Same rules as usePerpPositions (#849), calling
 * `GET /wallet/phoenix/orders?solana=`: `{ orders, loading, error, retry }`,
 * a null address makes no call, a failed refresh keeps the held list.
 * State transitions are ./phoenix-orders.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
import { apiClientSessionHeaders } from '@/lib/api-client-session';
import type { PhoenixOrdersResponse, WalletPhoenixOrder } from '@myboon/shared/wallet-summary';
import { applyPhoenixOrdersResponse, phoenixOrdersUrl, type PhoenixOrdersState } from './phoenix-orders';

export interface UsePhoenixOrdersResult {
  /** Orders from the last good load; null before the first one. */
  orders: WalletPhoenixOrder[] | null;
  loading: boolean;
  error: string | null;
  /** One new request for the same solana; the held list stays while it runs. */
  retry: () => void;
}

const INITIAL_STATE: PhoenixOrdersState = { orders: null, error: null };

export function usePhoenixOrders(solana: string | null): UsePhoenixOrdersResult {
  const [state, setState] = useState<PhoenixOrdersState>(INITIAL_STATE);
  const [loading, setLoading] = useState<boolean>(solana !== null);
  const [nonce, setNonce] = useState(0);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  const identityKey = solana ?? '';
  const identityRef = useRef(identityKey);

  useEffect(() => {
    const identityChanged = identityRef.current !== identityKey;
    identityRef.current = identityKey;

    if (!solana) {
      setState(INITIAL_STATE);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    if (identityChanged) setState(INITIAL_STATE);
    setLoading(true);

    const url = phoenixOrdersUrl(resolveApiBaseUrl(), solana);
    if (!url) {
      setLoading(false);
      return;
    }

    fetchWithTimeout(url, {
      headers: { Accept: 'application/json', ...apiClientSessionHeaders() },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        const shaped = payload && typeof payload === 'object' ? (payload as PhoenixOrdersResponse) : null;
        setState((prev) => applyPhoenixOrdersResponse(prev, shaped));
      })
      .catch(() => {
        if (cancelled) return;
        setState((prev) => applyPhoenixOrdersResponse(prev, null));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [identityKey, nonce, solana]);

  return { orders: state.orders, loading, error: state.error, retry };
}
