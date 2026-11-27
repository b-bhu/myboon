/**
 * Mapped wallet-summary app states → Home's `WalletSourcesState` (issue #912).
 *
 * Home's total comes from the wallet summary (one `GET /wallet/summary` per
 * load, via useWalletSourcesFromSummary) instead of the phone-side fetchers.
 * wallet-summary.mapping turns that summary into per-app
 * ok/stale/unavailable/not_connected states; this rule turns those into the
 * `WalletSourcesState` that the existing total rule already aggregates
 * (wallet.totals.ts: computeWalletTotals / isTotalPartial — untouched here).
 * The status mapping:
 *
 *   ok            → resolved  (value; resolvedAt is Date.parse(asOf), 0 if unparsable)
 *   stale         → stale     (keeps the last value; error from the state)
 *   unavailable   → failed
 *   not_connected → idle
 *
 * `detail` is null everywhere: the summary carries no row content. `states`
 * null means no summary is mapped yet — every source is the given `status`
 * with nothing held, so the total stays null (not zero) until a source has a
 * value.
 *
 * PURE — no react or react-native imports.
 */

import type {
  WalletSourceState,
  WalletSourcesState,
} from '@/features/wallet/wallet.types';
import type {
  WalletAppSourceState,
  WalletAppSourceStates,
} from '@/features/wallet/wallet-summary.mapping';

/**
 * An app that holds a value carries an `asOf` (the mapping sets the server
 * `fetchedAt` while ok and keeps it while stale); `Date.parse` of a missing or
 * unparsable one collapses to 0 per the mapping contract (#912).
 */
function parseAsOf(asOf: string | null): number {
  if (asOf === null) return 0;
  const at = Date.parse(asOf);
  return Number.isNaN(at) ? 0 : at;
}

function fromMapped<S>(state: WalletAppSourceState<S>): WalletSourceState {
  switch (state.status) {
    case 'ok':
      return {
        status: 'resolved',
        valueUsd: state.valueUsd,
        resolvedAt: parseAsOf(state.asOf),
        error: state.error,
        detail: null,
      };
    case 'stale':
      // The last good value rides on: hasValue counts it, and the stale status
      // keeps the total marked partial while its error explains why.
      return {
        status: 'stale',
        valueUsd: state.valueUsd,
        resolvedAt: parseAsOf(state.asOf),
        error: state.error,
        detail: null,
      };
    case 'unavailable':
      return {
        status: 'failed',
        valueUsd: null,
        resolvedAt: null,
        error: state.error,
        detail: null,
      };
    case 'not_connected':
      // Neither an error nor a failure: the person has no account there.
      return { status: 'idle', valueUsd: null, resolvedAt: null, error: null, detail: null };
  }
}

export function walletSourcesFromSummary(
  states: WalletAppSourceStates | null,
  status: 'loading' | 'idle' | 'failed',
): WalletSourcesState {
  if (states === null) {
    const source: WalletSourceState = { status, valueUsd: null, resolvedAt: null, error: null, detail: null };
    return {
      spot: { ...source },
      meteora: { ...source },
      phoenix: { ...source },
      pacifica: { ...source },
      polymarket: { ...source },
    };
  }
  return {
    spot: fromMapped(states.spot),
    meteora: fromMapped(states.meteora),
    phoenix: fromMapped(states.phoenix),
    pacifica: fromMapped(states.pacifica),
    polymarket: fromMapped(states.polymarket),
  };
}
