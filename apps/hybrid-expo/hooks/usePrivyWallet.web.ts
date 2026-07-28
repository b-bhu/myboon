/**
 * usePrivyWallet (web) — `@privy-io/react-auth`.
 *
 * Email OTP and passkey login in a browser, so an EVM chain can be activated
 * without a device. Gated on `EXPO_PUBLIC_PRIVY_WEB=1`.
 *
 * `address` and `signMessage` stay null on web. Those are the *Solana* embedded
 * wallet on native, and `@privy-io/react-auth/solana` needs peer dependencies
 * the app does not carry. Web already reaches Solana through the wallet-adapter
 * extensions, so only the EVM gap needed closing — see
 * `features/chain/usePrivyEvmWallet.web.ts`.
 *
 * That means on web a Privy login authenticates the user and enables EVM
 * activation, but does not itself provide a Solana address.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md
 */

import { useCallback } from 'react';
import {
  usePrivy,
  useLoginWithEmail,
  useLoginWithPasskey,
  useSignupWithPasskey,
  useLogout,
} from '@privy-io/react-auth';
import { PRIVY_WEB_ENABLED } from '@/providers/PrivyProvider.web';

export interface PrivyWalletState {
  connected: boolean;
  isPrivyUser: boolean;
  isPreparing: boolean;
  address: string | null;
  shortAddress: string | null;
  loginWithPasskey: () => Promise<void>;
  signupWithPasskey: () => Promise<void>;
  sendEmailOTP: (email: string) => Promise<void>;
  loginWithEmailOTP: (code: string) => Promise<void>;
  disconnect: () => Promise<void>;
  waitForWallet: () => Promise<void>;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
  authMethod: 'email' | 'passkey' | 'wallet' | null;
}

const disabled = async () => {
  throw new Error('Set EXPO_PUBLIC_PRIVY_WEB=1 to use Privy in a browser.');
};

const DISABLED: PrivyWalletState = {
  connected: false,
  isPrivyUser: false,
  isPreparing: false,
  address: null,
  shortAddress: null,
  loginWithPasskey: disabled,
  signupWithPasskey: disabled,
  sendEmailOTP: disabled,
  loginWithEmailOTP: disabled,
  disconnect: async () => {},
  waitForWallet: async () => {},
  signMessage: null,
  authMethod: null,
};

export function usePrivyWallet(): PrivyWalletState {
  const { user, ready } = usePrivy();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  const { loginWithPasskey } = useLoginWithPasskey();
  const { signupWithPasskey } = useSignupWithPasskey();
  const { logout } = useLogout();

  const authenticated = ready && !!user;

  const sendEmailOTP = useCallback(async (email: string) => {
    await sendCode({ email });
  }, [sendCode]);

  const loginWithEmailOTP = useCallback(async (code: string) => {
    await loginWithCode({ code });
  }, [loginWithCode]);

  const doLoginWithPasskey = useCallback(async () => {
    await loginWithPasskey();
  }, [loginWithPasskey]);

  const doSignupWithPasskey = useCallback(async () => {
    await signupWithPasskey();
  }, [signupWithPasskey]);

  const disconnect = useCallback(async () => {
    await logout();
  }, [logout]);

  if (!PRIVY_WEB_ENABLED) return DISABLED;

  // `authMethod` reads the linked accounts, matching the native hook. Falls back
  // to 'wallet' so a user authenticated by some other means is not reported as
  // unauthenticated.
  const linked = (user?.linkedAccounts ?? []) as { type?: string }[];
  const authMethod: PrivyWalletState['authMethod'] = !authenticated
    ? null
    : linked.some((account) => account.type === 'passkey')
      ? 'passkey'
      : linked.some((account) => account.type === 'email')
        ? 'email'
        : 'wallet';

  return {
    // No Solana embedded wallet on web, so `connected` — which native defines
    // as "authenticated AND has an embedded Solana wallet" — is never true.
    // EVM readiness is reported by usePrivyEvmWallet instead.
    connected: false,
    isPrivyUser: authenticated,
    isPreparing: false,
    address: null,
    shortAddress: null,
    loginWithPasskey: doLoginWithPasskey,
    signupWithPasskey: doSignupWithPasskey,
    sendEmailOTP,
    loginWithEmailOTP,
    disconnect,
    waitForWallet: async () => {},
    signMessage: null,
    authMethod,
  };
}
