/**
 * useEvmBalance — USDC collateral held at a Polygon address.
 *
 * Reads the same backend endpoint the Polymarket profile uses. The read is
 * unauthenticated: `fetchClobBalance` only needs a signer for its auto-wrap
 * step, which is skipped when none is passed. So this works for an EVM chain
 * the user has activated but never enabled Polymarket on.
 *
 * Returns `null` while loading and on failure — never `0`. A zero we did not
 * measure is a lie about the user's money, which is the trust rule the wallet
 * surface has held since the beta work.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The Wallet surface")
 */

import { useCallback, useEffect, useState } from 'react';
import { fetchClobBalance } from '@/features/predict/predict.api';

export function useEvmBalance(address: string | null): {
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

    fetchClobBalance(address, null)
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
  }, [address, nonce]);

  return { balanceUsd, refresh };
}
