/**
 * usePerpPositions — the server call behind the perps app view's positions
 * (issue #849; Phoenix first, Pacifica in #857).
 *
 * Calls `GET /wallet/{venue}/positions?solana=` with the api session headers
 * and returns the open positions plus loading, error and a `retry`. State
 * transitions are ./perp-positions — a failed refresh keeps the list already
 * shown, and the list stays null until the first good load. A `null` solana
 * is "no Solana address": no call, no error, no positions. The request is
 * aborted on unmount and when the address or venue changes, as
 * useMeteoraPositions does.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
import { apiClientSessionHeaders } from '@/lib/api-client-session';
import type { PerpPositionsResponse, WalletPerpPositionDetail } from '@myboon/shared/wallet-summary';
import {
  applyPerpPositionsResponse,
  perpPositionsUrl,
  type PerpPositionsState,
  type PerpVenue,
} from './perp-positions';

export interface UsePerpPositionsResult {
  /** Open positions from the last good load; null before the first one. A failed refresh keeps the previous list. */
  positions: WalletPerpPositionDetail[] | null;
  loading: boolean;
  error: string | null;
  /** One new request for the same solana; the held list stays while it runs. */
  retry: () => void;
}

const INITIAL_STATE: PerpPositionsState = { positions: null, error: null };

export function usePerpPositions(venue: PerpVenue, solana: string | null): UsePerpPositionsResult {
  const [state, setState] = useState<PerpPositionsState>(INITIAL_STATE);
  const [loading, setLoading] = useState<boolean>(solana !== null);
  const [nonce, setNonce] = useState(0);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  // A list is only ever true for its own venue and address; changing either
  // resets it before the next fetch replaces it.
  const identityKey = `${venue}:${solana ?? ''}`;
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

    const url = perpPositionsUrl(resolveApiBaseUrl(), venue, solana);
    if (!url) {
      setLoading(false);
      return;
    }

    fetchWithTimeout(url, {
      headers: { Accept: 'application/json', ...apiClientSessionHeaders() },
      signal: controller.signal,
    })
      .then(async (response) => {
        // Read the body even on a failure: its `error` text is the one shown.
        const payload: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        const shaped = payload && typeof payload === 'object' ? (payload as PerpPositionsResponse) : null;
        setState((prev) => applyPerpPositionsResponse(prev, venue, shaped));
      })
      .catch(() => {
        if (cancelled) return;
        setState((prev) => applyPerpPositionsResponse(prev, venue, null));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [identityKey, nonce, solana, venue]);

  return { positions: state.positions, loading, error: state.error, retry };
}
