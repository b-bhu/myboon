import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchMeteoraValueUsd,
  fetchPacificaValueUsd,
  fetchPhoenixValueUsd,
  fetchPolymarketValueUsd,
  fetchSpotValueUsd,
  invalidateSpotWalletSourceCache,
  isNotConnectedError,
  type WalletFetchResult,
} from '@/features/wallet/wallet.sources';
import { subscribeWalletDataChanged } from '@/features/wallet/wallet.refresh';
import { computeWalletTotals, isTotalPartial } from '@/features/wallet/wallet.totals';
import {
  WALLET_PROTOCOL_IDS,
  type WalletProtocolId,
  type WalletSourceState,
  type WalletSourcesState,
  type WalletTotals,
} from '@/features/wallet/wallet.types';

const VIEWPORT_DEBOUNCE_MS = 800;

const FETCHERS: Record<WalletProtocolId, (walletAddress: string) => Promise<WalletFetchResult>> = {
  spot: fetchSpotValueUsd,
  meteora: fetchMeteoraValueUsd,
  phoenix: fetchPhoenixValueUsd,
  pacifica: fetchPacificaValueUsd,
  polymarket: fetchPolymarketValueUsd,
};

function idleSource(): WalletSourceState {
  return { status: 'idle', valueUsd: null, resolvedAt: null, error: null, detail: null };
}

function initialSources(): WalletSourcesState {
  return {
    spot: idleSource(),
    meteora: idleSource(),
    phoenix: idleSource(),
    pacifica: idleSource(),
    polymarket: idleSource(),
  };
}

export interface UseProtocolAccountsResult {
  sources: WalletSourcesState;
  totals: WalletTotals;
  /** Call when the Wallet section's viewport visibility changes (debounced internally). */
  notifyVisibility: (isVisible: boolean) => void;
  /** Manual refresh — re-fetches every source (explicit refresh affordance, no pull-to-refresh at scroll bottom). */
  refreshAll: () => void;
  /** Retry a single failed/pending source without touching the others. */
  retrySource: (id: WalletProtocolId) => void;
  /**
   * True when at least one venue has a value but another is still loading,
   * failed or stale — the total is a lower bound and the UI must say so
   * rather than presenting it as complete (#653).
   */
  totalIsPartial: boolean;
}

/**
 * Orchestrates independent fetches for Spot, Meteora, Phoenix, Pacifica and
 * Polymarket for Home's Wallet section (issue #237; Polymarket added by #653).
 *
 * - Each source has its own try/catch, loading/resolved/failed state, and
 *   retry — one source failing or being slow never blocks another.
 * - Nothing fetches until the Wallet section scrolls into view
 *   (`notifyVisibility`), debounced so scroll wobble near the boundary
 *   doesn't refetch repeatedly.
 * - Each deliberate re-entry into view (leave, then return) re-triggers a
 *   fresh fetch of every source — the primary refresh mechanism.
 * - `refreshAll` backs the explicit manual-refresh affordance (no
 *   pull-to-refresh at the bottom of Home's scroll, no polling timer).
 */
export function useProtocolAccounts(walletAddress: string | null): UseProtocolAccountsResult {
  const [sources, setSources] = useState<WalletSourcesState>(initialSources);
  const visibilityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasVisible = useRef(false);
  const requestSeq = useRef<Record<WalletProtocolId, number>>({
    spot: 0,
    meteora: 0,
    phoenix: 0,
    pacifica: 0,
    polymarket: 0,
  });

  const fetchSource = useCallback((id: WalletProtocolId, address: string) => {
    const seq = ++requestSeq.current[id];
    setSources((prev) => ({
      ...prev,
      [id]: { ...prev[id], status: 'loading', error: null },
    }));

    FETCHERS[id](address)
      .then(({ valueUsd, detail }) => {
        if (requestSeq.current[id] !== seq) return; // superseded by a newer request
        setSources((prev) => ({
          ...prev,
          [id]: { status: 'resolved', valueUsd, resolvedAt: Date.now(), error: null, detail },
        }));
      })
      .catch((error: unknown) => {
        if (requestSeq.current[id] !== seq) return;
        // A venue that needs its own connection (Polymarket) and has none is
        // not a failure — there is nothing to show and nothing to retry until
        // the user connects it, so the source returns to idle rather than
        // rendering an error the user cannot act on.
        if (isNotConnectedError(error)) {
          setSources((prev) => ({ ...prev, [id]: idleSource() }));
          return;
        }
        setSources((prev) => {
          const previous = prev[id];
          // A source that had already resolved at least once keeps its last
          // known value and is labeled "stale" rather than blanked or downgraded
          // to the never-loaded "syncing" treatment (TC-STATE-003). A source
          // that has never resolved has nothing to retain, so it's "failed".
          const hadResolvedValue = previous.resolvedAt !== null && previous.valueUsd !== null;
          return {
            ...prev,
            [id]: {
              ...previous,
              status: hadResolvedValue ? 'stale' : 'failed',
              error: error instanceof Error ? error.message : 'Unable to sync',
            },
          };
        });
      });
  }, []);

  const fetchAll = useCallback((address: string) => {
    WALLET_PROTOCOL_IDS.forEach((id) => fetchSource(id, address));
  }, [fetchSource]);

  const notifyVisibility = useCallback((isVisible: boolean) => {
    if (visibilityTimer.current) {
      clearTimeout(visibilityTimer.current);
      visibilityTimer.current = null;
    }

    visibilityTimer.current = setTimeout(() => {
      visibilityTimer.current = null;
      const enteredView = isVisible && !wasVisible.current;
      wasVisible.current = isVisible;
      if (enteredView && walletAddress) {
        fetchAll(walletAddress);
      }
    }, VIEWPORT_DEBOUNCE_MS);
  }, [fetchAll, walletAddress]);

  const refreshAll = useCallback(() => {
    if (walletAddress) fetchAll(walletAddress);
  }, [fetchAll, walletAddress]);

  const retrySource = useCallback((id: WalletProtocolId) => {
    if (walletAddress) fetchSource(id, walletAddress);
  }, [fetchSource, walletAddress]);

  // Reset to idle and re-arm the "has entered view" gate whenever the
  // connected wallet changes (including disconnect), so stale balances from
  // a previous wallet never linger. Also cancels any debounced
  // visibility-entry fetch still pending for the previous wallet — without
  // this, a fetch scheduled just before a disconnect/reconnect could fire
  // after this reset and populate the just-cleared state with stale data.
  useEffect(() => {
    if (visibilityTimer.current) {
      clearTimeout(visibilityTimer.current);
      visibilityTimer.current = null;
    }
    setSources(initialSources());
    wasVisible.current = false;
  }, [walletAddress]);

  useEffect(() => () => {
    if (visibilityTimer.current) clearTimeout(visibilityTimer.current);
  }, []);

  useEffect(() => subscribeWalletDataChanged(() => {
    if (!walletAddress) return;
    invalidateSpotWalletSourceCache();
    fetchSource('spot', walletAddress);
  }), [fetchSource, walletAddress]);

  // The aggregation rule lives in wallet.totals.ts so it can be unit tested
  // without React (#653). This hook owns fetching; that module owns the sum.
  const totals = useMemo<WalletTotals>(() => computeWalletTotals(sources), [sources]);
  const totalIsPartial = useMemo(() => isTotalPartial(sources), [sources]);

  return { sources, totals, totalIsPartial, notifyVisibility, refreshAll, retrySource };
}
