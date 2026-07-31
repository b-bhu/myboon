/**
 * Web stub for usePrivyEvmWallet. `@privy-io/expo` embedded wallets are
 * native-only, matching the existing `hooks/usePrivyWallet.web.ts` stub.
 */

export interface PrivyEvmWalletState {
  isPrivyUser: boolean;
  isProvisioned: boolean;
  needsRecovery: boolean;
  isProvisioning: boolean;
  address: string | null;
  provision: () => Promise<string>;
  request: (<T = unknown>(args: { method: string; params?: unknown[] }) => Promise<T>) | null;
}

const webPrivyEvmWallet: PrivyEvmWalletState = {
  isPrivyUser: false,
  isProvisioned: false,
  needsRecovery: false,
  isProvisioning: false,
  address: null,
  provision: async () => {
    throw new Error('Privy embedded wallets are only available in the native app.');
  },
  request: null,
};

export function usePrivyEvmWallet(): PrivyEvmWalletState {
  return webPrivyEvmWallet;
}
