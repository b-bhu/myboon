/**
 * useWalletSummary — the one server call behind the Portfolio (issue #767).
 *
 * Calls `GET /wallet/summary?solana=&evm=` (issue #725) and returns the typed
 * `WalletSummary` plus loading, error and a `retry`. Turn the response into
 * per-app ok/stale/unavailable/not_connected states with
 * ./wallet-summary.mapping — `evm` is the Polymarket deposit wallet address
 * (#729), `solana` the Solana address behind phoenix/pacifica/meteora/spot.
 *
 * Trust rule (docs/design/wallet.html at commit 37e0a51): a failed refresh
 * never blanks a value already shown — when a refresh fails, the previous
 * summary stays in `summary` and only `error` and `loading` change, so the
 * screen can show it as stale instead of empty. When both addresses are
 * absent there is nothing to fetch: no call, no error.
 *
 * #780: a failing answer also carries `errorStatus` — the HTTP status when
 * the server answered, null for a network failure or timeout. Only 404
 * (endpoint not deployed) lets the screen stand in sample data.
 *
 * The API base URL is read the way features/spot does it
 * (resolveApiBaseUrl from @/lib/api).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
import { apiClientSessionHeaders } from '@/lib/api-client-session';
import type { WalletSummary } from '@myboon/shared/wallet-summary';

export interface UseWalletSummaryResult {
  /** Last successful server response; kept (not blanked) on a failed refresh. */
  summary: WalletSummary | null;
  loading: boolean;
  error: string | null;
  /** HTTP status when the server answered the failing request (#780): only
   *  404 means the endpoint isn't deployed yet; null for a network failure
   *  or timeout. Set with `error`, cleared with it. */
  errorStatus: number | null;
  /** Refetch the summary; the held summary stays visible while this runs. */
  retry: () => void;
}

/** A failed HTTP answer: the only failure that carries the server's status. */
class WalletSummaryHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'WalletSummaryHttpError';
    this.status = status;
  }
}

function readErrorMessage(payload: unknown, status: number): string {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  if (record) {
    const direct = record.error;
    if (typeof direct === 'string' && direct) return direct;
    if (direct && typeof direct === 'object') {
      const message = (direct as Record<string, unknown>).message;
      if (typeof message === 'string' && message) return message;
    }
  }
  return `Wallet summary failed (HTTP ${status})`;
}

export function useWalletSummary(solana: string | null, evm: string | null): UseWalletSummaryResult {
  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(solana !== null || evm !== null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  // A value is only ever true for one pair of addresses. Changing either
  // invalidates the held summary before the next fetch replaces it, so a
  // figure from one address is never shown against another.
  const identityKey = `${solana ?? ''}|${evm ?? ''}`;
  const identityRef = useRef(identityKey);

  useEffect(() => {
    const identityChanged = identityRef.current !== identityKey;
    identityRef.current = identityKey;

    if (!solana && !evm) {
      setSummary(null);
      setError(null);
      setErrorStatus(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    if (identityChanged) {
      setSummary(null);
      setError(null);
      setErrorStatus(null);
    }
    setLoading(true);

    const params = new URLSearchParams();
    if (solana) params.set('solana', solana);
    if (evm) params.set('evm', evm);

    fetchWithTimeout(`${resolveApiBaseUrl()}/wallet/summary?${params.toString()}`, {
      headers: { Accept: 'application/json', ...apiClientSessionHeaders() },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as unknown;
        if (!response.ok || !payload || typeof payload !== 'object') {
          const message = response.ok
            ? 'Wallet summary returned no data.'
            : readErrorMessage(payload, response.status);
          // The server answered, so its status travels with the failure
          // (#780): only 404 may enable the sample-data fallback.
          throw new WalletSummaryHttpError(message, response.status);
        }
        // The identity clear above already replaced any older address's
        // summary; a success always becomes the current one.
        if (cancelled) return;
        setSummary(payload as WalletSummary);
        setError(null);
        setErrorStatus(null);
      })
      .catch((err: unknown) => {
        // The previously held summary is deliberately NOT cleared here: a
        // failed refresh never blanks a value the screen is already showing.
        if (cancelled) return;
        setError(err instanceof Error && err.message ? err.message : 'Wallet summary request failed.');
        // The status only when the server answered (#780): offline, timeout
        // and aborted calls stay null.
        setErrorStatus(err instanceof WalletSummaryHttpError ? err.status : null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [identityKey, nonce, solana, evm]);

  return { summary, loading, error, errorStatus, retry };
}
