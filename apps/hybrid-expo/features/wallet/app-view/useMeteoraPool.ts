/**
 * useMeteoraPool — the real pool load behind the Wallet's Meteora Manage
 * sheet (issue #917; the sheet itself is issue #903).
 *
 * Wraps `meteoraClient.getPool` and hands the sheet the pool plus the
 * freshness the load reported, for `buildMeteoraPrepareContext` in
 * ./meteora-manage. One request per address and per retry; a `null` address
 * makes no call and holds nothing. A failed load keeps the last good pool
 * and only `error` and `loading` move — same trust rule as
 * useMeteoraPositions — so a retry still runs against the pool it holds.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MeteoraFreshness,
  MeteoraPoolDetail,
} from '@myboon/shared/meteora';
import { meteoraClient } from '@/features/meteora/meteora.client';

export interface UseMeteoraPoolResult {
  /** Pool detail from the last good load; null before the first one. A failed retry keeps the previous pool. */
  pool: MeteoraPoolDetail | null;
  /** Freshness that came with the held pool; null before the first good load. */
  freshness: MeteoraFreshness | null;
  loading: boolean;
  error: string | null;
  /** One new request for the same address; the held pool stays while it runs. */
  retry: () => void;
}

/** No load yet — also the reset shape for a changed or cleared address. */
type MeteoraPoolState = {
  pool: MeteoraPoolDetail | null;
  freshness: MeteoraFreshness | null;
  error: string | null;
};

const NO_POOL: MeteoraPoolState = { pool: null, freshness: null, error: null };

export function useMeteoraPool(poolAddress: string | null): UseMeteoraPoolResult {
  const [state, setState] = useState<MeteoraPoolState>(NO_POOL);
  const [loading, setLoading] = useState<boolean>(poolAddress !== null);
  const [nonce, setNonce] = useState(0);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  // A pool address is only ever true for itself. Changing it drops the held
  // pool before the next fetch replaces it, so one address's detail is never
  // shown against another (same rule as useMeteoraPositions).
  const identityKey = poolAddress ?? '';
  const identityRef = useRef(identityKey);

  useEffect(() => {
    const identityChanged = identityRef.current !== identityKey;
    identityRef.current = identityKey;

    if (!poolAddress) {
      setState(NO_POOL);
      setLoading(false);
      return;
    }

    let cancelled = false;
    if (identityChanged) setState(NO_POOL);
    setLoading(true);

    meteoraClient
      .getPool(poolAddress)
      .then((result) => {
        if (cancelled) return;
        setState({ pool: result.data, freshness: result.freshness, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Keep the last good pool and its freshness; only the error moves.
        setState((prev) => ({
          ...prev,
          error: error instanceof Error ? error.message : 'Meteora pool did not load.',
        }));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [identityKey, nonce, poolAddress]);

  return { pool: state.pool, freshness: state.freshness, loading, error: state.error, retry };
}
