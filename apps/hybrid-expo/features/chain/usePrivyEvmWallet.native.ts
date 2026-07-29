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

/**
 * Poll a predicate until it holds, or give up.
 *
 * Privy settles auth into React state a tick or two after `login*` resolves.
 * Anything that acts on the login immediately reads the pre-login render and
 * concludes the user is logged out, so a short wait is the difference between a
 * working flow and one that fails on a login that actually succeeded.
 */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5000, intervalMs = 50 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
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

  // `provision()` is called immediately after login resolves, but this hook's
  // `authenticated` comes from the render that captured the callback — Privy's
  // `user` has not propagated through React state yet, so reading the closure
  // reports a logged-in user as logged out. A ref tracks the live value.
  const authenticatedRef = useRef(authenticated);
  authenticatedRef.current = authenticated;

  // `create` is undefined until Privy is ready, and lands on the same delayed
  // render as `user` — so it needs the same treatment, or provisioning fails
  // one step later with "embedded EVM wallets are unavailable".
  const createWalletRef = useRef(createWallet);
  createWalletRef.current = createWallet;

  const provision = useCallback(async (): Promise<string> => {
    if (address) return address;
    if (!authenticatedRef.current) {
      // Give Privy's state a moment to land. The alternative is failing a login
      // that actually succeeded, which is what "Log in before activating an EVM
      // wallet" reported when the user had just logged in.
      const settled = await waitFor(() => authenticatedRef.current);
      if (!settled) {
        throw new Error('Log in before activating an EVM wallet.');
      }
    }
    const create = createWalletRef.current
      ?? ((await waitFor(() => !!createWalletRef.current)) ? createWalletRef.current : null);
    if (!create) {
      throw new Error('Privy embedded EVM wallets are unavailable.');
    }
    if (inflightRef.current) return inflightRef.current;

    const pending = (async () => {
      setIsProvisioning(true);
      try {
        const { user: updated } = await create();
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
