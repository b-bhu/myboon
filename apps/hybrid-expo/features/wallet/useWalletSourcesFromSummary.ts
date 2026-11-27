/**
 * useWalletSourcesFromSummary — Home's Wallet section from the wallet summary
 * (issue #912).
 *
 * Calls `useWalletSummary` with the same addresses Home gives `chainAddress`
 * and maps the answer per app with `mapWalletSummaryApps`. The previous
 * mapping is held in a ref (reset when either address changes) so a newer
 * answer that marks an app unavailable turns it stale — it keeps its last
 * value — instead of blanking it, as the Portfolio does (#778 review note 1).
 *
 * `walletSourcesFromSummary` turns the mapping into a `WalletSourcesState` and
 * `computeWalletTotals` aggregates it: the total rule is the one the
 * phone-side fetchers already ran, so its semantics do not change. The summary
 * is one server call for every app, so pull-to-refresh and a per-app retry are
 * the same `retry`.
 */

import { useMemo, useRef } from 'react';

import { useWalletSummary } from '@/features/wallet/useWalletSummary';
import { walletSourcesFromSummary } from '@/features/wallet/wallet-sources-from-summary';
import {
  mapWalletSummaryApps,
  type WalletAppSourceStates,
} from '@/features/wallet/wallet-summary.mapping';
import { computeWalletTotals } from '@/features/wallet/wallet.totals';
import type {
  WalletSourcesState,
  WalletTotals,
} from '@/features/wallet/wallet.types';

export interface UseWalletSourcesFromSummaryResult {
  sources: WalletSourcesState;
  totals: WalletTotals;
  /** Refetch the summary — one server call for every app. */
  retry: () => void;
}

/**
 * Where nothing is mapped yet: no addresses means nothing to fetch (idle); a
 * first answer that failed with nothing held is failed; otherwise the request
 * is in flight (loading). With a summary held this is ignored — the held
 * values show, and a failed refresh keeps them unchanged.
 */
type NullStatesStatus = 'loading' | 'idle' | 'failed';

export function useWalletSourcesFromSummary(
  solana: string | null,
  evm: string | null,
): UseWalletSourcesFromSummaryResult {
  const { summary, error, retry } = useWalletSummary(solana, evm);

  const identityKey = `${solana ?? ''}|${evm ?? ''}`;
  // Refresh carry-over: `previous` holds the mapping of the summary the screen
  // was last showing, so a failed refresh keeps that summary's values. Reset
  // when either address changes — a value from one address never travels to
  // another (#912).
  const identityRef = useRef(identityKey);
  const previousRef = useRef<WalletAppSourceStates | null>(null);
  if (identityRef.current !== identityKey) {
    identityRef.current = identityKey;
    previousRef.current = null;
  }

  const mapped = useMemo(() => {
    if (summary === null) return null;
    const byApp = mapWalletSummaryApps(summary, previousRef.current);
    previousRef.current = byApp;
    return byApp;
  }, [summary]);

  const status: NullStatesStatus =
    solana === null && evm === null ? 'idle'
    : summary === null && error !== null ? 'failed'
    : 'loading';

  const sources = useMemo(
    () => walletSourcesFromSummary(mapped, status),
    [mapped, status],
  );

  // The only place Home's total is computed — the shared rule, unchanged.
  const totals = useMemo(() => computeWalletTotals(sources), [sources]);

  return { sources, totals, retry };
}
