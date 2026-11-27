import { useMobileWallet } from '@wallet-ui/react-native-web3js';
import { useCallback, useSyncExternalStore } from 'react';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import {
  clearMwaAccount,
  getMwaAccountCleared,
  pickWalletSession,
  readMwaAddress,
  restoreMwaAccount,
  subscribeMwaAccountCleared,
  type WalletSource,
} from '@/hooks/walletSession';

export type { WalletSource };

export function useWallet() {
  const privy = usePrivyWallet();
  const { account, connect, disconnect, store, signMessage, signTransaction, signAndSendTransaction, connection } =
    useMobileWallet();
  // Shared across every useWallet() consumer (hooks/walletSession.ts): a
  // disconnect on the connection sheet is visible on Home in the same tick.
  const mwaAccountCleared = useSyncExternalStore(
    subscribeMwaAccountCleared,
    getMwaAccountCleared,
    getMwaAccountCleared,
  );
  // Resolves with the connected external address — `connect()` resolves the
  // adapter account, and the SIWS message is keyed to that address (#948).
  const connectMwa = useCallback(async (): Promise<string | null> => {
    restoreMwaAccount();
    return readMwaAddress(await connect());
  }, [connect]);
  const disconnectMwa = useCallback(async () => {
    // Immediate UI guard, shared app-wide; store.persist(null) clears the
    // durable cache below.
    clearMwaAccount();
    try {
      await disconnect();
    } finally {
      try {
        await store.persist(null);
      } catch (error) {
        console.warn('Could not clear the cached external Solana wallet authorization.', error);
      }
    }
  }, [disconnect, store]);

  if (process.env.EXPO_PUBLIC_PREDICT_E2E === '1') {
    const runtimeAddress = (globalThis as typeof globalThis & {
      __PREDICT_E2E_SOLANA_ADDRESS?: string;
    }).__PREDICT_E2E_SOLANA_ADDRESS;
    const fakeAddress = runtimeAddress
      ?? process.env.EXPO_PUBLIC_PREDICT_E2E_SOLANA_ADDRESS
      ?? 'E2ePredict111111111111111111111111111111111';
    return {
      connected: true as const,
      address: fakeAddress,
      shortAddress: 'E2eP···1111',
      connect: async () => {},
      // Already-have must not share `connect`. That one creates a Privy wallet
      // when a Privy session is signed in. See the privy branch below.
      connectExternal: async () => fakeAddress,
      disconnect: async () => {},
      signMessage: async () => new Uint8Array(64).fill(1),
      signTransaction: async <T,>(transaction: T) => transaction,
      signAndSendTransaction: async () => 'e2e-signature',
      connection: null,
      walletOptions: [],
      source: 'mwa' as WalletSource,
      hasMwaAccount: true,
      disconnectMwa: async () => {},
      isPreparing: false,
      sessionKey: `mwa:${fakeAddress}`,
    };
  }

  // MWA wallet state. The read is safe: a missing, non-string, or unsafe
  // `account.address` is no external address (hooks/walletSession.ts).
  const mwaAddress = mwaAccountCleared ? null : readMwaAddress(account);

  // A connected external wallet (Phantom / Solflare via MWA) wins over a Privy embedded
  // wallet: the user connected it deliberately and it is the Solana account they expect to
  // trade from. Privy remains authenticated underneath — nothing here clears it.
  //
  // The hydration guard still holds. `MobileWalletProvider` rehydrates its authorization
  // from AsyncStorage on mount, so `account` can be a stale cached entry rather than a live
  // authorization, and the adapter exposes no flag telling the two apart. We therefore only
  // let MWA win once Privy has settled (`isPreparing === false`). While Privy is still
  // hydrating we fall through to the Privy branch below, which reports a disconnected Privy
  // session — so no cached MWA account is ever exposed during the hydration window, exactly
  // as before. Stale-vs-live is resolved the same way it is for MWA-only users: the first
  // signing call re-authorizes through `transact` and fails if the cache is dead.
  //
  // The privy-vs-MWA pick itself is `pickWalletSession()` (hooks/walletSession.ts):
  // the shared disconnect clears the external candidate, so after a disconnect a
  // new email/Google login selects the Privy wallet, never the stale external one.
  const session = pickWalletSession({
    mwaAccountCleared,
    mwaAddress,
    privyIsPrivyUser: privy.isPrivyUser,
    privyIsPreparing: privy.isPreparing,
    // SIWS sign-in (#948): a wallet-login Privy account never gets an embedded
    // Solana wallet, so its external wallet is picked as soon as it exists.
    privyWalletLogin: privy.authMethod === 'wallet',
    privyConnected: privy.connected,
    privyAddress: privy.address,
  });

  if (session.source === 'privy') {
    return {
      connected: privy.connected,
      address: session.address,
      shortAddress: privy.connected ? privy.shortAddress : null,
      // Explicit Solana activation for someone already signed into Privy
      // (`useChainSigner`). This creates the embedded wallet. The connection
      // sheet must not use it for Seeker / Phantom — that was the silent
      // MWA → Privy path. Already-have calls `connectExternal` instead.
      connect: async (_walletName?: string) => {
        if (privy.connected) return;
        await privy.waitForWallet();
      },
      connectExternal: async (_walletName?: string) => connectMwa(),
      disconnect: privy.disconnect,
      signMessage: privy.connected ? privy.signMessage : null,
      signTransaction: privy.connected ? privy.signTransaction : null,
      // Privy embedded wallets don't support signAndSendTransaction directly —
      // Polymarket orders are signed locally (EIP-712) and proxied via VPS
      signAndSendTransaction: null,
      connection: null,
      walletOptions: [],
      source: 'privy' as WalletSource,
      hasMwaAccount: !!account?.address,
      disconnectMwa,
      isPreparing: privy.isPreparing,
      sessionKey: privy.connected && privy.address ? `privy:${privy.address}` : 'privy:disconnected',
    };
  }

  // Fall back to MWA (Phantom / Solflare)
  return {
    connected: !!mwaAddress,
    address: mwaAddress,
    shortAddress: mwaAddress
      ? `${mwaAddress.slice(0, 4)}···${mwaAddress.slice(-4)}`
      : null,
    connect: async (_walletName?: string) => connectMwa(),
    connectExternal: async (_walletName?: string) => connectMwa(),
    disconnect: disconnectMwa,
    signMessage,
    signTransaction,
    signAndSendTransaction,
    connection,
    walletOptions: [],
    source: 'mwa' as WalletSource,
    hasMwaAccount: !!account?.address,
    disconnectMwa,
    isPreparing: false,
    sessionKey: mwaAddress ? `mwa:${mwaAddress}` : 'mwa:disconnected',
  };
}
