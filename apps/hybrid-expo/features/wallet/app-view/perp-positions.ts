/**
 * Perps positions state transitions (issue #849 — the data behind the
 * Phoenix Positions tab; Pacifica reuses it in #857).
 *
 * The pure helpers behind usePerpPositions: the request URL for
 * `GET /wallet/{venue}/positions?solana=` and the state machine that folds
 * one response into the hook's state. Same trust rule as useWalletSummary:
 * a failed refresh never blanks a list already shown. A body without a
 * `status` (non-2xx) or no body at all (network drop, timeout) is the
 * failure transition: keep the previous list, set the error text.
 *
 * Plain module: no React, no fetch — unit-tested with tsx --test
 * (phoenix-positions.test.ts).
 */

import type { PerpPositionsResponse, WalletPerpPositionDetail } from '@myboon/shared/wallet-summary';

export type PerpVenue = 'phoenix' | 'pacifica';

/** What the hook holds: the last good load (nothing before one) and its error. */
export interface PerpPositionsState {
  /** Open positions from the last good load; null until that load lands. */
  positions: WalletPerpPositionDetail[] | null;
  /** Human-readable failure text; null after a good load. */
  error: string | null;
}

/** The positions request URL, or null when there is no address to ask for. */
export function perpPositionsUrl(baseUrl: string, venue: PerpVenue, solana: string | null): string | null {
  if (!solana) return null;
  const params = new URLSearchParams({ solana });
  return `${baseUrl}/wallet/${venue}/positions?${params.toString()}`;
}

function venueName(venue: PerpVenue): string {
  return venue === 'phoenix' ? 'Phoenix' : 'Pacifica';
}

/**
 * Fold one response into the state. `ok` and `not_connected` take the array;
 * `unavailable` sets the response's `error` (else a default) and keeps the
 * held list; a body without `status`, or null, is a failed refresh.
 */
export function applyPerpPositionsResponse(
  previous: PerpPositionsState,
  venue: PerpVenue,
  payload: PerpPositionsResponse | null,
): PerpPositionsState {
  if (payload && (payload.status === 'ok' || payload.status === 'not_connected')) {
    return { positions: Array.isArray(payload.positions) ? payload.positions : [], error: null };
  }
  const fallback =
    payload && payload.status === 'unavailable'
      ? `${venueName(venue)} positions are unavailable.`
      : `${venueName(venue)} positions request failed.`;
  return { ...previous, error: (payload && payload.error) || fallback };
}
