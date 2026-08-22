import { useMobileWallet } from '@wallet-ui/react-native-web3js';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';

export type WalletSource = 'privy' | 'mwa';

export function useWallet() {
  const privy = usePrivyWallet();
  const { account, connect, disconnect, signMessage, signTransaction, signAndSendTransaction, connection } =
    useMobileWallet();

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
      disconnect: async () => {},
      signMessage: async () => new Uint8Array(64).fill(1),
      signTransaction: async <T,>(transaction: T) => transaction,
      signAndSendTransaction: async () => 'e2e-signature',
      connection: null,
      walletOptions: [],
      source: 'mwa' as WalletSource,
      isPreparing: false,
      sessionKey: `mwa:${fakeAddress}`,
    };
  }

  // MWA wallet state
  const raw = account?.address;
  const mwaAddress = raw ? (typeof raw === 'string' ? raw : raw.toBase58()) : null;

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
  const preferMwa = !!account && !privy.isPreparing;

  if (privy.isPrivyUser && !preferMwa) {
    return {
      connected: privy.connected,
      address: privy.connected ? privy.address : null,
      shortAddress: privy.connected ? privy.shortAddress : null,
      connect: async (_walletName?: string) => {
        if (privy.connected) return;
        await privy.waitForWallet();
      },
      disconnect: privy.disconnect,
      signMessage: privy.connected ? privy.signMessage : null,
      signTransaction: privy.connected ? privy.signTransaction : null,
      // Privy embedded wallets don't support signAndSendTransaction directly —
      // Polymarket orders are signed locally (EIP-712) and proxied via VPS
      signAndSendTransaction: null,
      connection: null,
      walletOptions: [],
      source: 'privy' as WalletSource,
      isPreparing: privy.isPreparing,
      sessionKey: privy.connected && privy.address ? `privy:${privy.address}` : 'privy:disconnected',
    };
  }

  // Fall back to MWA (Phantom / Solflare)
  return {
    connected: !!account,
    address: mwaAddress,
    shortAddress: mwaAddress
      ? `${mwaAddress.slice(0, 4)}···${mwaAddress.slice(-4)}`
      : null,
    connect: async (_walletName?: string) => connect(),
    disconnect,
    signMessage,
    signTransaction,
    signAndSendTransaction,
    connection,
    walletOptions: [],
    source: 'mwa' as WalletSource,
    isPreparing: false,
    sessionKey: mwaAddress ? `mwa:${mwaAddress}` : 'mwa:disconnected',
  };
}
