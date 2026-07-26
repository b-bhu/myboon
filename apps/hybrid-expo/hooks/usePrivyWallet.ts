/**
 * usePrivyWallet — Adapter hook that wraps Privy's embedded Solana wallet
 * to expose the same interface as useWallet (MWA).
 *
 * Passkey auth → Privy creates embedded Solana wallet → this hook
 * exposes { connected, address, signMessage } so usePolymarketWallet
 * works identically for both Privy and MWA users.
 */

import { useCallback, useEffect, useRef } from 'react';
import { usePrivy, useEmbeddedSolanaWallet, useLoginWithEmail, isConnected } from '@privy-io/expo';
import { useLoginWithPasskey, useSignupWithPasskey } from '@privy-io/expo/passkey';
import { clearActivation } from '@/features/chain/activation';

export interface PrivyWalletState {
  /** Whether the user is authenticated via Privy AND has an embedded wallet */
  connected: boolean;
  /** Whether the user is authenticated via Privy (may not have wallet yet) */
  isPrivyUser: boolean;
  /** Whether Privy auth is complete but the embedded wallet is still hydrating/creating */
  isPreparing: boolean;
  /** Solana address from embedded wallet */
  address: string | null;
  /** Shortened address for display */
  shortAddress: string | null;
  /** Trigger passkey login (existing account) */
  loginWithPasskey: () => Promise<void>;
  /** Trigger passkey signup (new account) */
  signupWithPasskey: () => Promise<void>;
  /** Send email OTP code */
  sendEmailOTP: (email: string) => Promise<void>;
  /** Login with email OTP code */
  loginWithEmailOTP: (code: string) => Promise<void>;
  /** Log out of Privy */
  disconnect: () => Promise<void>;
  /** Wait until the embedded Solana wallet is hydrated after auth */
  waitForWallet: () => Promise<void>;
  /** Sign a message with the embedded Solana wallet */
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
  /** Auth method the user used (email, passkey, wallet, or null) */
  authMethod: 'email' | 'passkey' | 'wallet' | null;
}

const RELYING_PARTY = 'https://myboon.tech';

export function usePrivyWallet(): PrivyWalletState {
  const { user, isReady, logout } = usePrivy();
  const solanaWallet = useEmbeddedSolanaWallet();
  const { loginWithPasskey } = useLoginWithPasskey();
  const { signupWithPasskey } = useSignupWithPasskey();
  const { sendCode: sendEmailCode, loginWithCode: loginWithEmailCode } = useLoginWithEmail();

  const authenticated = isReady && !!user;
  const walletConnected = isConnected(solanaWallet);
  const wallet = walletConnected ? solanaWallet.wallets?.[0] ?? null : null;
  const address = wallet?.address ?? null;
  const isPreparing = authenticated && !wallet;
  const solanaWalletStatus = solanaWallet.status;
  const createSolanaWallet = solanaWallet.create;

  // Provisioning is deferred, not automatic. Privy is configured with
  // `createOnLogin: 'off'` for both chains (providers/PrivyProvider.tsx), so
  // authenticating creates nothing — a dormant chain has no wallet in existence
  // and therefore no address that can receive funds by accident.
  //
  // `create()` is called from `waitForWallet()` instead, which every caller
  // reaches only from an explicit Solana-connect intent: the drawer's
  // email/passkey login flows and `useWallet().connect()`. So logging in through
  // an EVM application provisions no Solana wallet, while the existing Solana
  // flows are unchanged from the caller's point of view.
  const creatingRef = useRef(false);
  const walletWaitersRef = useRef<{ resolve: () => void; reject: (err: Error) => void }[]>([]);

  useEffect(() => {
    if (!authenticated) {
      creatingRef.current = false;
      walletWaitersRef.current.splice(0).forEach(({ reject }) => {
        reject(new Error('Privy user is not authenticated'));
      });
    }
  }, [authenticated]);

  useEffect(() => {
    if (!address) return;
    walletWaitersRef.current.splice(0).forEach(({ resolve }) => resolve());
  }, [address]);

  /**
   * Create the embedded Solana wallet on demand. Idempotent, and deduped via
   * `creatingRef` so two concurrent callers cannot race two `create()` calls.
   */
  const provisionSolanaWallet = useCallback(() => {
    if (!authenticated || solanaWalletStatus !== 'not-created') return;
    if (!createSolanaWallet || creatingRef.current) return;

    creatingRef.current = true;
    console.log('[PrivyWallet] Creating embedded Solana wallet on activation...');
    createSolanaWallet().catch((err: unknown) => {
      creatingRef.current = false;
      console.error('[PrivyWallet] Failed to create wallet:', err);
      walletWaitersRef.current.splice(0).forEach(({ reject }) => {
        reject(err instanceof Error ? err : new Error('Failed to create Privy wallet'));
      });
    });
  }, [authenticated, solanaWalletStatus, createSolanaWallet]);

  const waitForEmbeddedWallet = useCallback(async () => {
    if (address) return;

    // Reaching here is an explicit Solana-connect intent, so this is the
    // activation moment at which provisioning is allowed.
    provisionSolanaWallet();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        walletWaitersRef.current = walletWaitersRef.current.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error('Privy wallet is still preparing. Please try again in a moment.'));
      }, 15000);

      walletWaitersRef.current.push({
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
  }, [address, provisionSolanaWallet]);

  // `waitForWallet()` may be called the instant login resolves, before Privy has
  // settled the embedded wallet status to 'not-created'. In that window the
  // provision call above is a no-op, so re-attempt whenever the status settles
  // and someone is still waiting. Without a pending waiter this never fires —
  // authentication alone still provisions nothing.
  useEffect(() => {
    if (walletWaitersRef.current.length === 0) return;
    provisionSolanaWallet();
  }, [provisionSolanaWallet]);

  const signMessage = wallet
    ? async (message: Uint8Array): Promise<Uint8Array> => {
        const provider = await wallet.getProvider();
        const { signature } = await provider.request({
          method: 'signMessage',
          params: { message: Buffer.from(message).toString('base64') },
        });
        return new Uint8Array(Buffer.from(signature, 'base64'));
      }
    : null;

  // Determine auth method from linked accounts
  const authMethod: 'email' | 'passkey' | 'wallet' | null = (() => {
    if (!user) return null;
    const linked = user.linked_accounts ?? [];
    if (linked.some((a: { type: string }) => a.type === 'passkey')) return 'passkey';
    if (linked.some((a: { type: string }) => a.type === 'email')) return 'email';
    return 'wallet';
  })();

  return {
    connected: authenticated && !!wallet,
    isPrivyUser: authenticated,
    isPreparing,
    address,
    shortAddress: address ? `${address.slice(0, 4)}···${address.slice(-4)}` : null,
    loginWithPasskey: async () => {
      await loginWithPasskey({ relyingParty: RELYING_PARTY });
    },
    signupWithPasskey: async () => {
      await signupWithPasskey({ relyingParty: RELYING_PARTY });
    },
    sendEmailOTP: async (email: string) => {
      await sendEmailCode({ email });
    },
    loginWithEmailOTP: async (code: string) => {
      await loginWithEmailCode({ code });
    },
    disconnect: async () => {
      // Logout is one of the two explicit session boundaries (the other is
      // disconnecting a wallet). Everything else — backgrounding, process death,
      // app restart — leaves activation intact.
      await clearActivation();
      await logout();
    },
    waitForWallet: waitForEmbeddedWallet,
    signMessage,
    authMethod,
  };
}
