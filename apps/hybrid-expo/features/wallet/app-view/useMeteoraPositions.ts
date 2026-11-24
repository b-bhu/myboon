/**
 * useMeteoraPositions — the server call behind the Meteora app view's
 * positions data (issue #901; the Positions tab that shows it is issue
 * #902).
 *
 * Calls `GET /wallet/meteora/positions?solana=` (#867) with the api session
 * headers and returns the open positions plus loading, error and a `retry`.
 * State transitions are ./meteora-positions — same trust rule as
 * useWalletSummary: a failed refresh keeps the list already shown and only
 * `error` and `loading` move, and the list stays null until the first good
 * load. A `null` solana is "no Solana address": no call, no error, no
 * positions. The request is aborted on unmount and when the address
 * changes, as useWalletSummary does.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
import { apiClientSessionHeaders } from '@/lib/api-client-session';
import type {
  MeteoraPositionsResponse,
  WalletMeteoraPosition,
} from '@myboon/shared/wallet-summary';
import {
  applyMeteoraPositionsResponse,
  meteoraPositionsUrl,
  type MeteoraPositionsState,
} from './meteora-positions';

export interface UseMeteoraPositionsResult {
  /** Open positions from the last good load; null before the first one. A failed refresh keeps the previous list. */
  positions: WalletMeteoraPosition[] | null;
  /** Pools behind the held list; 0 before the first good load. */
  totalPools: number;
  /** True when pools sit beyond what the held response returned. */
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** One new request for the same solana; the held list stays while it runs. */
  retry: () => void;
}

/** No load yet — also the reset shape for a changed address. */
const INITIAL_STATE: MeteoraPositionsState = { positions: null, totalPools: 0, hasMore: false, error: null };

export function useMeteoraPositions(solana: string | null): UseMeteoraPositionsResult {
  const [state, setState] = useState<MeteoraPositionsState>(INITIAL_STATE);
  const [loading, setLoading] = useState<boolean>(solana !== null);
  const [nonce, setNonce] = useState(0);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  // An address is only ever true for itself. Changing it resets the held
  // list before the next fetch replaces it, so one address's positions are
  // never shown against another.
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

    const url = meteoraPositionsUrl(resolveApiBaseUrl(), solana);
    if (!url) {
      // Unreachable above (solana is set), but keeps the types honest.
      setLoading(false);
      return;
    }

    fetchWithTimeout(url, {
      headers: { Accept: 'application/json', ...apiClientSessionHeaders() },
      signal: controller.signal,
    })
      .then(async (response) => {
        // Read the body even on a failure: its `error` text is the one the
        // hook shows. A non-2xx body has no `status`, so the helper reads it
        // as the failed refresh it is.
        const payload: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        const shaped = payload && typeof payload === 'object' ? (payload as MeteoraPositionsResponse) : null;
        setState((prev) => applyMeteoraPositionsResponse(prev, shaped));
      })
      .catch(() => {
        // Network failure, timeout or abort: no body at all.
        if (cancelled) return;
        setState((prev) => applyMeteoraPositionsResponse(prev, null));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [identityKey, nonce, solana]);

  return { positions: state.positions, totalPools: state.totalPools, hasMore: state.hasMore, loading, error: state.error, retry };
}
