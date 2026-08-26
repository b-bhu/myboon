export interface PrivyWalletState {
  connected: boolean;
  isPrivyUser: boolean;
  address: string | null;
  shortAddress: string | null;
  loginWithGoogle: () => Promise<void>;
  sendEmailOTP: (email: string) => Promise<void>;
  loginWithEmailOTP: (code: string) => Promise<void>;
  disconnect: () => Promise<void>;
  waitForWallet: () => Promise<void>;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
  authMethod: 'email' | 'google' | 'wallet' | null;
  identityEmail: string | null;
  identityName: string | null;
}

const unavailable = async () => {
  throw new Error('Privy embedded wallets are only available in the native app.');
};

const webPrivyWallet: PrivyWalletState = {
  connected: false,
  isPrivyUser: false,
  address: null,
  shortAddress: null,
  loginWithGoogle: unavailable,
  sendEmailOTP: unavailable,
  loginWithEmailOTP: unavailable,
  disconnect: async () => {},
  waitForWallet: async () => {},
  signMessage: null,
  authMethod: null,
  identityEmail: null,
  identityName: null,
};

export function usePrivyWallet(): PrivyWalletState {
  return webPrivyWallet;
}
