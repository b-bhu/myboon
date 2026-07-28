/**
 * usePrivyEvmWallet (web) — `@privy-io/react-auth`.
 *
 * Same contract as the native hook, implemented against the web SDK so the EVM
 * path can be exercised in a browser. Privy is the only backend that can
 * satisfy EVM, so without this the whole Polymarket flow was device-only.
 *
 * Dormancy holds identically here: `createOnLogin` is `'off'` for both chains
 * in `providers/PrivyProvider.web.tsx`, and `createWallet()` runs only from
 * `provision()`. Logging in creates nothing.
 *
 * Gated on `EXPO_PUBLIC_PRIVY_WEB=1`. With the flag off the provider renders no
 * Privy context, so the guard returns the dormant shape rather than letting the
 * hooks below read from a context that is not there.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("Dormancy")
 */

import { useCallback, useRef, useState } from 'react';
import { usePrivy, useWallets, useCreateWallet } from '@privy-io/react-auth';
import { PRIVY_WEB_ENABLED } from '@/providers/PrivyProvider.web';

export interface PrivyEvmWalletState {
  isPrivyUser: boolean;
  isProvisioned: boolean;
  isProvisioning: boolean;
  address: string | null;
  provision: () => Promise<string>;
  request: (<T = unknown>(args: { method: string; params?: unknown[] }) => Promise<T>) | null;
}

const DORMANT: PrivyEvmWalletState = {
  isPrivyUser: false,
  isProvisioned: false,
  isProvisioning: false,
  address: null,
  provision: async () => {
    throw new Error('Set EXPO_PUBLIC_PRIVY_WEB=1 to use Privy in a browser.');
  },
  request: null,
};

export function usePrivyEvmWallet(): PrivyEvmWalletState {
  const { user, ready } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const [isProvisioning, setIsProvisioning] = useState(false);
  // Dedupe concurrent provision() calls — two features activating EVM in the
  // same tick must not race two createWallet() calls into two wallets.
  const inflightRef = useRef<Promise<string> | null>(null);

  const authenticated = ready && !!user;

  // `useWallets` returns connected external wallets alongside the embedded one.
  // Only the embedded wallet is ours to provision; treating a connected
  // MetaMask as "provisioned" would report an address this path cannot sign
  // with.
  const embedded = wallets.find((w) => w.walletClientType === 'privy') ?? null;
  const address = embedded?.address ?? null;

  const provision = useCallback(async (): Promise<string> => {
    if (address) return address;
    if (!authenticated) {
      throw new Error('Log in before activating an EVM wallet.');
    }
    if (inflightRef.current) return inflightRef.current;

    setIsProvisioning(true);
    const inflight = (async () => {
      try {
        const created = await createWallet();
        const createdAddress = created?.address ?? null;
        if (!createdAddress) {
          throw new Error('Privy did not return an EVM address.');
        }
        return createdAddress;
      } finally {
        setIsProvisioning(false);
        inflightRef.current = null;
      }
    })();

    inflightRef.current = inflight;
    return inflight;
  }, [address, authenticated, createWallet]);

  const request = useCallback(
    async <T = unknown>(args: { method: string; params?: unknown[] }): Promise<T> => {
      if (!embedded) throw new Error('No embedded EVM wallet.');
      const provider = await embedded.getEthereumProvider();
      return provider.request(args) as Promise<T>;
    },
    [embedded],
  );

  if (!PRIVY_WEB_ENABLED) return DORMANT;

  return {
    isPrivyUser: authenticated,
    isProvisioned: !!address,
    isProvisioning,
    address,
    provision,
    request: embedded ? request : null,
  };
}
