/**
 * useChainSigner — the resolver.
 *
 * An application declares a `ChainRequirement` and receives a `Signer` without
 * knowing which backend satisfied it. Resolution is per chain and sticky across
 * app restarts; applications never prompt for a chain that is already satisfied.
 *
 *   1. chain active                 -> ready
 *   2. chain provisioned, dormant   -> activate, then ready
 *   3. neither                      -> needs_connection
 *   4. no backend can satisfy       -> unsupported + human-readable reason
 *
 * `unsupported` returns a reason string. It does not throw.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md
 */

import { useCallback, useMemo, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import { usePrivyEvmWallet } from '@/features/chain/usePrivyEvmWallet';
import { useChainActivation } from '@/features/chain/activation';
import { logChainState } from '@/features/chain/chain.debug';
import {
  createPrivyEvmSigner,
  createSolanaSigner,
} from '@/features/chain/chain.signers';
import {
  resolveChainSigner,
  type ChainSignerStatus,
} from '@/features/chain/chain.resolution';
import type {
  ChainRequirement,
  Signer,
  WalletBackend,
} from '@/features/chain/chain.contract';

export interface ChainSignerResult {
  signer: Signer | null;
  status: ChainSignerStatus;
  reason: string | null;
  connect: () => Promise<void>;
}

export function useChainSigner(requirement: ChainRequirement): ChainSignerResult {
  const solana = useWallet();
  const privy = usePrivyWallet();
  const evm = usePrivyEvmWallet();
  const { activation, isHydrated, activate } = useChainActivation();
  const [isConnecting, setIsConnecting] = useState(false);

  const isSolana = requirement.chain === 'solana';

  // "Provisioned" means key material exists for this chain right now — not that
  // the user could obtain some. A Privy user with no embedded wallet created is
  // dormant, which is the whole point of deferred provisioning.
  const provisionedBackends = useMemo<readonly WalletBackend[]>(() => {
    if (isSolana) {
      const backends: WalletBackend[] = [];
      if (solana.connected && solana.address) {
        backends.push(solana.source === 'privy' ? 'privy_embedded' : 'external_mwa');
      }
      return backends;
    }
    return evm.isProvisioned && evm.address ? ['privy_embedded'] : [];
  }, [isSolana, solana.connected, solana.address, solana.source, evm.isProvisioned, evm.address]);

  const resolution = useMemo(
    () =>
      resolveChainSigner(requirement, {
        isActive: activation[requirement.chain],
        isActivationHydrated: isHydrated,
        provisionedBackends,
        canProvisionOnDemand: privy.isPrivyUser,
        isBusy:
          isConnecting
          || evm.isProvisioning
          || (isSolana && solana.isPreparing),
      }),
    [
      requirement,
      activation,
      isHydrated,
      provisionedBackends,
      privy.isPrivyUser,
      isConnecting,
      evm.isProvisioning,
      isSolana,
      solana.isPreparing,
    ],
  );

  // Stage 2: how the requirement resolved, and from what. `status` here is the
  // single fact every Predict screen gates on, so when a screen says "connect"
  // for a wallet that exists, this line names which input produced that.
  logChainState(`resolve.${requirement.applicationId}`, {
    chain: requirement.chain,
    status: resolution.status,
    backend: resolution.backend,
    isActive: activation[requirement.chain],
    isActivationHydrated: isHydrated,
    provisionedBackends,
    isPrivyUser: privy.isPrivyUser,
    evmAddress: evm.address,
    evmIsProvisioned: evm.isProvisioned,
  });

  const signer = useMemo<Signer | null>(() => {
    if (resolution.status !== 'ready' || !resolution.backend) return null;

    if (isSolana) {
      if (!solana.address || !solana.signMessage) return null;
      return createSolanaSigner({
        backend: resolution.backend === 'privy_embedded' ? 'privy_embedded' : 'external_mwa',
        address: solana.address,
        signMessage: solana.signMessage,
      });
    }

    if (!evm.address || !evm.request) return null;
    return createPrivyEvmSigner({
      address: evm.address,
      chainId: requirement.chainId,
      request: evm.request,
    });
  }, [
    resolution.status,
    resolution.backend,
    isSolana,
    solana.address,
    solana.signMessage,
    evm.address,
    evm.request,
    requirement.chainId,
  ]);

  /**
   * Satisfy the requirement. For a dormant-but-provisioned chain (branch 2) this
   * is just recording activation. For a Privy user with nothing provisioned it
   * also creates the wallet — the only place `create()` is ever called, which is
   * what keeps a dormant chain free of a wallet.
   *
   * No-op when the requirement is `unsupported`: there is nothing to connect to,
   * and the caller already has a reason string.
   */
  const connect = useCallback(async () => {
    if (resolution.status === 'unsupported') return;

    setIsConnecting(true);
    try {
      if (!isSolana) {
        if (!evm.isProvisioned) {
          // Throws if the user is not logged into Privy. The caller opens the
          // connection modal on `needs_connection` before reaching here.
          await evm.provision();
        }
        await activate('evm');
        return;
      }

      if (!solana.connected) {
        await solana.connect();
      }
      await activate('solana');
    } finally {
      setIsConnecting(false);
    }
  }, [resolution.status, isSolana, evm, solana, activate]);

  return {
    signer,
    status: resolution.status,
    reason: resolution.reason,
    connect,
  };
}
