/**
 * useEvmBalance — USDC collateral held at a Polygon address.
 *
 * Reads through the active mobile-owned Polymarket SecureClient. When Predict
 * has not been restored in this process there is deliberately no server-side
 * session fallback, so the value remains unknown.
 *
 * Returns `null` while loading and on failure — never `0`. A zero we did not
 * measure is a lie about the user's money, which is the trust rule the wallet
 * surface has held since the beta work.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The Wallet surface")
 */

import { useCallback, useEffect, useState } from 'react';
import type { SecureClient } from '@polymarket/client';
import { fetchClobBalance } from '@/features/predict/predict.api';
import { getActivePolymarketClient } from '@/features/predict/predict.client';

export function useEvmBalance(address: string | null, secureClient: SecureClient | null = null): {
  balanceUsd: number | null;
  refresh: () => void;
} {
  const [balanceUsd, setBalanceUsd] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!address) {
      setBalanceUsd(null);
      return;
    }

    let cancelled = false;
    // Clear before fetching so a stale figure from a previous address is never
    // shown against the current one.
    setBalanceUsd(null);

    const client = secureClient ?? getActivePolymarketClient(address);
    if (!client) {
      setBalanceUsd(null);
      return;
    }

    fetchClobBalance(client)
      .then((result) => {
        if (cancelled) return;
        setBalanceUsd(result ? result.balance : null);
      })
      .catch(() => {
        if (!cancelled) setBalanceUsd(null);
      });

    return () => {
      cancelled = true;
    };
  }, [address, nonce, secureClient]);

  return { balanceUsd, refresh };
}
