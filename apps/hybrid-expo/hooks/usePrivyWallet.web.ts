export interface PrivyWalletState {
  connected: boolean;
  isPrivyUser: boolean;
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

const unavailable = async () => {
  throw new Error('Privy embedded wallets are only available in the native app.');
};

const webPrivyWallet: PrivyWalletState = {
  connected: false,
  isPrivyUser: false,
  address: null,
  shortAddress: null,
  loginWithPasskey: unavailable,
  signupWithPasskey: unavailable,
  sendEmailOTP: unavailable,
  loginWithEmailOTP: unavailable,
  disconnect: async () => {},
  waitForWallet: async () => {},
  signMessage: null,
  authMethod: null,
};

export function usePrivyWallet(): PrivyWalletState {
  return webPrivyWallet;
}
