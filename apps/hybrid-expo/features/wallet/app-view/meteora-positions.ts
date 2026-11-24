/**
 * Meteora positions state transitions (issue #901; the Positions tab that
 * shows this data is issue #902 — this unit is data only).
 *
 * The pure helpers behind useMeteoraPositions: the request URL for
 * `GET /wallet/meteora/positions?solana=` (#867) and the state machine that
 * folds one response into the hook's state.
 *
 * Trust rule (the useWalletSummary rule): a failed refresh never blanks a
 * list already shown. A failed request carries no MeteoraPositionsResponse —
 * its body is an error object without a `status` (400/429/5xx), or there is
 * no body at all (network drop, timeout) — so `payload` here is the parsed
 * body or null, and anything without a `status` is the failure transition:
 * keep the previous list and counts, set the error text.
 *
 * Plain module: no React, no fetch — unit-tested with tsx --test
 * (meteora-positions.test.ts).
 */

import type {
  MeteoraPositionsResponse,
  WalletMeteoraPosition,
} from '@myboon/shared/wallet-summary';

/** What the hook holds: the last good load (nothing before one) and its error. */
export interface MeteoraPositionsState {
  /** Open positions from the last good load; null until that load lands. */
  positions: WalletMeteoraPosition[] | null
  /** Pools behind the held list, from the same response. */
  totalPools: number
  /** True when pools sit beyond what the held response returned. */
  hasMore: boolean
  /** Human-readable failure text; null after a good load. */
  error: string | null
}

/** The positions request URL, or null when there is no address to ask for. */
export function meteoraPositionsUrl(baseUrl: string, solana: string | null): string | null {
  if (!solana) return null;
  const params = new URLSearchParams({ solana });
  return `${baseUrl}/wallet/meteora/positions?${params.toString()}`;
}

/**
 * Fold one response into the state. A 2xx body decides by its `status`
 * (`ok` takes the list; `not_connected` and `unavailable` end with an empty
 * list); a body without a `status` — or null, when the request never
 * produced a body — is a failed refresh that keeps the held list.
 */
export function applyMeteoraPositionsResponse(
  previous: MeteoraPositionsState,
  payload: MeteoraPositionsResponse | null,
): MeteoraPositionsState {
  if (payload && payload.status === 'ok') {
    return {
      positions: payload.positions,
      totalPools: payload.totalPools,
      hasMore: payload.hasMore,
      error: null,
    };
  }
  if (payload && payload.status === 'not_connected') {
    return { positions: [], totalPools: payload.totalPools, hasMore: payload.hasMore, error: null };
  }
  if (payload && payload.status === 'unavailable') {
    return {
      positions: [],
      totalPools: payload.totalPools,
      hasMore: payload.hasMore,
      error: payload.error || 'Meteora positions are unavailable.',
    };
  }
  // Failed refresh (non-2xx body, unparseable body or no body at all).
  return {
    ...previous,
    error: (payload && payload.error) || 'Meteora positions request failed.',
  };
}
