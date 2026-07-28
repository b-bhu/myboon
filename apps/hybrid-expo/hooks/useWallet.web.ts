import { useCallback, useEffect, useRef } from 'react';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import type { WalletName } from '@solana/wallet-adapter-base';
import type { Transaction, VersionedTransaction } from '@solana/web3.js';

export function useWallet() {
  const {
    publicKey,
    connected,
    wallet,
    wallets,
    connect,
    disconnect,
    select,
    signMessage,
    signTransaction,
    sendTransaction,
  } = useSolanaWallet();

  const { connection } = useConnection();

  // Track whether we initiated a connect so we can finish it after select settles
  const connectingRef = useRef(false);

  // Once a wallet is selected (state updated), fire connect()
  useEffect(() => {
    if (connectingRef.current && wallet && !connected) {
      connectingRef.current = false;
      connect().catch(() => {});
    }
  }, [wallet, connected, connect]);

  const handleConnect = useCallback(async (walletName?: WalletName | string) => {
    const targetName = walletName ?? wallets[0]?.adapter.name;
    if (!targetName) {
      throw new Error('No Solana wallet extension found');
    }

    connectingRef.current = true;

    if (wallet?.adapter.name === targetName) {
      connectingRef.current = false;
      await connect();
      return;
    }

    select(targetName as WalletName);
  }, [wallets, wallet, connect, select]);

  const handleDisconnect = useCallback(async () => {
    connectingRef.current = false;
    await disconnect();
    select(null);
  }, [disconnect, select]);

  // Wrap sendTransaction so callers don't need to pass connection
  const handleSignAndSendTransaction = useCallback(
    async (tx: Transaction | VersionedTransaction): Promise<string> => {
      return sendTransaction(tx, connection);
    },
    [sendTransaction, connection],
  );

  const addressStr = publicKey?.toBase58() ?? null;

  if (process.env.EXPO_PUBLIC_PREDICT_E2E === '1') {
    const runtimeAddress = (globalThis as typeof globalThis & {
      __PREDICT_E2E_SOLANA_ADDRESS?: string;
    }).__PREDICT_E2E_SOLANA_ADDRESS;
    const fakeAddress = runtimeAddress
      ?? process.env.EXPO_PUBLIC_PREDICT_E2E_SOLANA_ADDRESS
      ?? 'E2ePredict111111111111111111111111111111111';
    return {
      connected: true,
      address: fakeAddress,
      shortAddress: 'E2eP···1111',
      connect: async () => {},
      disconnect: async () => {},
      signMessage: async () => new Uint8Array(64).fill(1),
      signTransaction: signTransaction ?? (async () => { throw new Error('signTransaction not supported in E2E'); }),
      signAndSendTransaction: async () => 'e2e-signature',
      connection,
      walletOptions: [],
      source: 'mwa' as const,
      sessionKey: `mwa:${fakeAddress}`,
    };
  }

  return {
    connected,
    address: addressStr,
    shortAddress: addressStr
      ? `${addressStr.slice(0, 4)}···${addressStr.slice(-4)}`
      : null,
    connect: handleConnect,
    disconnect: handleDisconnect,
    signMessage: signMessage ?? (async () => { throw new Error('signMessage not supported'); }),
    signTransaction: signTransaction ?? (async () => { throw new Error('signTransaction not supported'); }),
    signAndSendTransaction: handleSignAndSendTransaction,
    connection,
    // Only wallets the user can actually connect to right now. The adapter also
    // reports `NotDetected` (extension not installed) and `Unsupported` (wrong
    // platform); listing those gives the user options that fail on tap.
    // `Loadable` is included — it means available without prior installation.
    walletOptions: wallets
      .filter(({ readyState }) => readyState === 'Installed' || readyState === 'Loadable')
      .map(({ adapter, readyState }) => ({
        name: adapter.name,
        icon: adapter.icon,
        readyState,
      })),
    source: 'mwa' as const,
    sessionKey: addressStr ? `mwa:${addressStr}` : 'mwa:disconnected',
  };
}
