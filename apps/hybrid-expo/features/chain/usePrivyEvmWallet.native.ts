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
import { logChainEvent, logChainState } from '@/features/chain/chain.debug';

export interface PrivyEvmWalletState {
  /** Whether the user is authenticated via Privy. */
  isPrivyUser: boolean;
  /** Whether an embedded EVM wallet exists *and can sign here*. False means dormant. */
  isProvisioned: boolean;
  /**
   * Privy has a wallet on file that this device cannot sign with — its entropy
   * is not available locally. Distinct from dormant: creating is not the fix,
   * and `provision()` will refuse rather than hit Privy's duplicate error.
   */
  needsRecovery: boolean;
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

/**
 * The embedded EVM wallet recorded on the user, or null.
 *
 * This is *existence*, not usability. `useEmbeddedEthereumWallet().wallets`
 * drops every wallet whose entropy is unavailable on this device — the SDK maps
 * accounts to entropy and returns `[]` if any lookup fails — so a wallet can be
 * present here and absent there. Use this only to decide whether `create()`
 * would be rejected as a duplicate; never to claim a wallet can sign.
 */
function findEmbeddedEvmAddress(
  linkedAccounts: readonly unknown[] | undefined,
): string | null {
  const found = (linkedAccounts ?? []).find(
    (account) =>
      (account as { type?: string }).type === 'wallet'
      && (account as { chain_type?: string }).chain_type === 'ethereum'
      && typeof (account as { address?: unknown }).address === 'string',
  );
  return (found as { address?: string } | undefined)?.address ?? null;
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
  const createWallet = ethereumWallet.create;

  // Two different questions, deliberately kept apart:
  //
  //   `address`       — a wallet we can sign with. Drives every UI claim of
  //                     being connected, so it comes only from `wallets`.
  //   `recordedEvm`   — a wallet Privy has on file, signable or not. Used only
  //                     to keep `create()` from being rejected as a duplicate.
  //
  // Conflating them is what showed a connected address on a screen that still
  // said "Connect wallet": `linked_accounts` still listed a wallet whose
  // entropy was gone, so it could be displayed but never used.
  const recordedEvmAddress = useMemo(
    () => findEmbeddedEvmAddress(user?.linked_accounts),
    [user?.linked_accounts],
  );
  const address = wallet?.address ?? null;
  // A wallet exists but this device cannot sign with it. Privy's EVM hook has
  // no status field (unlike the Solana one), so this is the only way to tell
  // "needs recovery" apart from "no wallet yet" — and they need opposite
  // handling: recovery vs. creation.
  const needsRecovery = !wallet && !!recordedEvmAddress;

  // Stage 1 of the chain: what Privy actually hands us. `walletCount: 0` with a
  // non-null `recordedEvmAddress` is the recovery case — Privy drops every
  // wallet whose entropy is unavailable on this device, so a wallet can be on
  // file and unusable here.
  logChainState('evm.wallet', {
    isReady,
    authenticated,
    walletCount: ethereumWallet.wallets?.length ?? 0,
    address,
    recordedEvmAddress,
    needsRecovery,
    isProvisioning,
  });

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

  // The address needs the same live read: `provision()` runs from the render
  // that captured it, which for a just-logged-in user is the one where no
  // wallet was visible yet.
  const addressRef = useRef(address);
  addressRef.current = address;

  const recordedEvmAddressRef = useRef(recordedEvmAddress);
  recordedEvmAddressRef.current = recordedEvmAddress;

  const provision = useCallback(async (): Promise<string> => {
    logChainEvent('evm.provision', 'called', {
      address: addressRef.current,
      recordedEvmAddress: recordedEvmAddressRef.current,
      authenticated: authenticatedRef.current,
    });
    if (addressRef.current) return addressRef.current;
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

    // `wallets` populates a render or two after login, so a wallet that is
    // merely late looks identical to one that is missing. Wait for it before
    // concluding anything — but only when Privy says a wallet exists, so a
    // genuinely new user is not delayed on every first connect.
    if (!addressRef.current && recordedEvmAddressRef.current) {
      await waitFor(() => !!addressRef.current);
    }
    if (addressRef.current) return addressRef.current;

    // Still nothing signable while Privy has one on file: entropy for this
    // wallet is not on this device. `create()` would be rejected as a
    // duplicate, so say what is actually wrong rather than surfacing Privy's
    // "Wallet already exists" — which reads as a bug, not a device-availability state.
    if (recordedEvmAddressRef.current) {
      throw new Error(
        'Wallet unavailable on this device. Contact myboon support.',
      );
    }
    if (inflightRef.current) return inflightRef.current;

    const pending = (async () => {
      setIsProvisioning(true);
      try {
        const { user: updated } = await create();
        // `create()` resolves with the updated user before the hook's `wallets`
        // array re-renders, so read the address off the returned user rather
        // than waiting a tick for hook state.
        const created = findEmbeddedEvmAddress(updated?.linked_accounts);
        logChainEvent('evm.provision', 'create() resolved', { created });
        if (!created) {
          throw new Error('EVM wallet creation did not return an address.');
        }
        return created;
      } finally {
        setIsProvisioning(false);
        inflightRef.current = null;
      }
    })();

    inflightRef.current = pending;
    return pending;
    // Every value this reads is a ref, so the callback is stable by design —
    // callers can depend on it without re-running on each Privy render.
  }, []);

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
    // Deliberately `wallet`, not `address`: provisioned means "can sign", and
    // signing needs the hook's wallet object. A linked account proves a wallet
    // exists but yields no provider, so reporting it as provisioned would
    // resolve `ready` with a null signer. While `wallets` catches up the
    // resolver reports `preparing`, which is the honest state.
    isProvisioned: !!wallet,
    needsRecovery,
    isProvisioning,
    address,
    provision,
    request,
  };
}
