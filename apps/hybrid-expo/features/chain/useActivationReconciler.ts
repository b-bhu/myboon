/**
 * useActivationReconciler — connection implies activation.
 *
 * Activation is the record that a connection happened, not a second consent
 * step on top of it. `useChainSigner.connect()` writes that record for the
 * connections it drives, but a wallet can become connected without passing
 * through it: an external wallet authorized in the wallet app, a session
 * restored from a previous launch, or one that predates activation existing.
 *
 * Left unreconciled the app reports both facts honestly and contradictorily —
 * a connected address in one panel and "connect a wallet" in the next.
 *
 * Mounted once at the app root rather than folded into `useChainActivation`,
 * for two reasons. Importing `useWallet` into `activation.ts` drags React
 * Native's Flow-typed entry point into the unit runner and breaks tests that
 * are deliberately renderer-free. And a single writer avoids every consumer of
 * activation racing to write the same record.
 *
 * This never creates a wallet. It records a connection that already exists, so
 * dormancy is untouched: a chain with no wallet stays inactive.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("Dormancy")
 */

import { useEffect, useRef } from 'react';
import {
  activateChain,
  shouldReconcileConnectedChain,
  useChainActivation,
} from '@/features/chain/activation';
import { usePrivyEvmWallet } from '@/features/chain/usePrivyEvmWallet';
import { useWallet } from '@/hooks/useWallet';

export function useActivationReconciler(): void {
  const { activation, isHydrated } = useChainActivation();
  const solana = useWallet();
  const evm = usePrivyEvmWallet();

  const solanaConnected = solana.connected && !!solana.address;
  const evmConnected = evm.isProvisioned && !!evm.address;
  const previousSolanaConnected = useRef(false);
  const previousEvmConnected = useRef(false);

  useEffect(() => {
    // Waiting for hydration matters: acting on the pre-read `false` would write
    // an activation record for a chain the user may have deliberately
    // disconnected, resurrecting it on every launch.
    if (!isHydrated) return;
    const reconcileSolana = shouldReconcileConnectedChain({
      isHydrated,
      isConnected: solanaConnected,
      wasConnected: previousSolanaConnected.current,
      isActive: activation.solana,
    });
    const reconcileEvm = shouldReconcileConnectedChain({
      isHydrated,
      isConnected: evmConnected,
      wasConnected: previousEvmConnected.current,
      isActive: activation.evm,
    });
    previousSolanaConnected.current = solanaConnected;
    previousEvmConnected.current = evmConnected;
    if (reconcileSolana) void activateChain('solana');
    if (reconcileEvm) void activateChain('evm');
  }, [isHydrated, solanaConnected, evmConnected, activation.solana, activation.evm]);
}
