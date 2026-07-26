/**
 * usePrivyEvmWallet — Privy embedded Ethereum wallet, provisioned on demand.
 *
 * Privy is configured with `createOnLogin: 'off'` for ethereum
 * (`providers/PrivyProvider.tsx`), so logging in creates nothing. `create()` is
 * called only from `provision()`, which the resolver invokes on activation.
 * That is what makes dormancy real: a dormant EVM chain has no wallet in
 * existence, and therefore no address that can receive funds by accident.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("Dormancy")
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { usePrivy, useEmbeddedEthereumWallet } from '@privy-io/expo';

export interface PrivyEvmWalletState {
  /** Whether the user is authenticated via Privy. */
  isPrivyUser: boolean;
  /** Whether an embedded EVM wallet exists. False means dormant. */
  isProvisioned: boolean;
  /** Whether `create()` is currently in flight. */
  isProvisioning: boolean;
  address: string | null;
  /** Create the embedded EVM wallet. Idempotent; safe to call when provisioned. */
  provision: () => Promise<string>;
  /** EIP-1193 request against the embedded wallet, or null when dormant. */
  request: (<T = unknown>(args: { method: string; params?: unknown[] }) => Promise<T>) | null;
}

export function usePrivyEvmWallet(): PrivyEvmWalletState {
  const { user, isReady } = usePrivy();
  const ethereumWallet = useEmbeddedEthereumWallet();
  const [isProvisioning, setIsProvisioning] = useState(false);
  // Dedupe concurrent provision() calls — two features activating EVM in the
  // same tick must not race two create() calls into two wallets.
  const inflightRef = useRef<Promise<string> | null>(null);

  const authenticated = isReady && !!user;
  const wallet = ethereumWallet.wallets?.[0] ?? null;
  const address = wallet?.address ?? null;
  const createWallet = ethereumWallet.create;

  const provision = useCallback(async (): Promise<string> => {
    if (address) return address;
    if (!authenticated) {
      throw new Error('Log in before activating an EVM wallet.');
    }
    if (!createWallet) {
      throw new Error('Privy embedded EVM wallets are unavailable.');
    }
    if (inflightRef.current) return inflightRef.current;

    const pending = (async () => {
      setIsProvisioning(true);
      try {
        const { user: updated } = await createWallet();
        // `create()` resolves with the updated user before the hook's `wallets`
        // array re-renders, so read the address off the returned user rather
        // than waiting a tick for hook state.
        const created = (updated?.linked_accounts ?? []).find(
          (account): account is typeof account & { address: string } =>
            (account as { type?: string }).type === 'wallet'
            && (account as { chain_type?: string }).chain_type === 'ethereum'
            && typeof (account as { address?: unknown }).address === 'string',
        );
        if (!created?.address) {
          throw new Error('EVM wallet creation did not return an address.');
        }
        return created.address;
      } finally {
        setIsProvisioning(false);
        inflightRef.current = null;
      }
    })();

    inflightRef.current = pending;
    return pending;
  }, [address, authenticated, createWallet]);

  const request = useMemo(() => {
    if (!wallet) return null;
    return async <T = unknown>(args: { method: string; params?: unknown[] }): Promise<T> => {
      const provider = await wallet.getProvider();
      return (await provider.request({
        method: args.method,
        params: args.params ?? [],
      })) as T;
    };
  }, [wallet]);

  return {
    isPrivyUser: authenticated,
    isProvisioned: !!wallet,
    isProvisioning,
    address,
    provision,
    request,
  };
}
