/** Mobile-owned Polymarket SecureClient lifecycle for the active Privy EOA. */

import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import type { SecureClient } from '@polymarket/client';
import { useChainSigner } from '@/features/chain/useChainSigner';
import { logChainEvent, logChainState } from '@/features/chain/chain.debug';
import { POLYMARKET_REQUIREMENT } from '@/features/chain/chain.contract';
import type { Signer } from '@/features/chain/chain.contract';
import {
  activatePolymarketClient,
  disablePolymarketClient,
  releasePolymarketClient,
  retainPolymarketClientLifecycle,
  subscribePolymarketClient,
} from '@/features/predict/predict.client';

const STORAGE_KEY = 'polymarket_polygon_address';
const DEPOSIT_WALLET_STORAGE_KEY = 'polymarket_deposit_wallet_address';
const WALLET_MODE_STORAGE_KEY = 'polymarket_wallet_mode';
const WALLET_CHANGED_MESSAGE = 'Wallet changed. Please try again.';
const E2E_POLYGON_ADDRESS = process.env.EXPO_PUBLIC_PREDICT_E2E_POLYGON_ADDRESS
  ?? '0xe2e0000000000000000000000000000000000001';
const E2E_DEPOSIT_WALLET_ADDRESS = process.env.EXPO_PUBLIC_PREDICT_E2E_DEPOSIT_WALLET_ADDRESS
  ?? '0xe2e0000000000000000000000000000000000002';

export type PolymarketWalletMode = 'deposit_wallet';

export interface PolymarketWallet {
  polygonAddress: string | null;
  safeAddress: null;
  depositWalletAddress: string | null;
  walletMode: PolymarketWalletMode | null;
  tradingAddress: string | null;
  client: SecureClient | null;
  isReady: boolean;
  isLoading: boolean;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  canSignLocally: boolean;
  signer: Signer | null;
  signerStatus: ReturnType<typeof useChainSigner>['status'];
  connectSigner: () => Promise<void>;
}

function storageKeys(address: string): string[] {
  return [
    `${STORAGE_KEY}:${address}`,
    `${DEPOSIT_WALLET_STORAGE_KEY}:${address}`,
    `${WALLET_MODE_STORAGE_KEY}:${address}`,
  ];
}

export function usePolymarketWallet(): PolymarketWallet {
  const { signer, status: signerStatus, connect: connectSigner } = useChainSigner(POLYMARKET_REQUIREMENT);
  const evmAddress = signer?.descriptor.address ?? null;
  const walletPreparing = signerStatus === 'preparing';
  const [polygonAddress, setPolygonAddress] = useState<string | null>(null);
  const [depositWalletAddress, setDepositWalletAddress] = useState<string | null>(null);
  const [walletMode, setWalletMode] = useState<PolymarketWalletMode | null>(null);
  const [client, setClient] = useState<SecureClient | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const generationRef = useRef(0);
  const previousAddressRef = useRef<string | null>(null);

  useEffect(() => retainPolymarketClientLifecycle(), []);

  const clearUi = useCallback(() => {
    setPolygonAddress(null);
    setDepositWalletAddress(null);
    setWalletMode(null);
    setClient(null);
  }, []);

  const persistEnabled = useCallback(async (address: string, secureClient: SecureClient) => {
    await AsyncStorage.multiSet([
      [`${STORAGE_KEY}:${address}`, address],
      [`${DEPOSIT_WALLET_STORAGE_KEY}:${address}`, secureClient.account.wallet],
      [`${WALLET_MODE_STORAGE_KEY}:${address}`, 'deposit_wallet'],
    ]);
  }, []);

  const installClient = useCallback((address: string, secureClient: SecureClient) => {
    setPolygonAddress(address);
    setDepositWalletAddress(secureClient.account.wallet);
    setWalletMode('deposit_wallet');
    setClient(secureClient);
  }, []);

  useEffect(() => subscribePolymarketClient((snapshot) => {
    if (snapshot && evmAddress && snapshot.address === evmAddress.toLowerCase()) {
      installClient(evmAddress, snapshot.client);
      return;
    }
    clearUi();
  }), [clearUi, evmAddress, installClient]);

  useEffect(() => {
    const generation = ++generationRef.current;
    const previousAddress = previousAddressRef.current;
    previousAddressRef.current = evmAddress;
    clearUi();

    if (previousAddress && previousAddress.toLowerCase() !== evmAddress?.toLowerCase()) {
      void releasePolymarketClient(previousAddress);
    }
    if (walletPreparing) {
      setIsLoading(true);
      return;
    }
    if (!signer || !evmAddress) {
      if (previousAddress) void releasePolymarketClient(previousAddress);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    AsyncStorage.multiGet(storageKeys(evmAddress))
      .then(async (entries) => {
        const [storedEoa, storedWallet, storedMode] = entries.map((entry) => entry[1]);
        if (!storedEoa || !storedWallet || storedMode !== 'deposit_wallet') return;
        const secureClient = await activatePolymarketClient(signer, evmAddress);
        if (generationRef.current !== generation) {
          await releasePolymarketClient(evmAddress);
          return;
        }
        // The SDK is authoritative. This also repairs any stale pre-SDK wallet
        // address saved by older app builds.
        await persistEnabled(evmAddress, secureClient);
        installClient(evmAddress, secureClient);
      })
      .catch((error) => {
        logChainEvent('polymarket.restore', 'FAILED', {
          message: error instanceof Error ? error.message : String(error),
          eoaAddress: evmAddress,
        });
      })
      .finally(() => {
        if (generationRef.current === generation) setIsLoading(false);
      });
  }, [clearUi, evmAddress, installClient, persistEnabled, signer, walletPreparing]);

  useEffect(() => {
    if (!signer || !evmAddress) return;
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', (nextState) => {
      const wasActive = previousState === 'active';
      previousState = nextState;
      if (nextState !== 'active') {
        if (wasActive) void releasePolymarketClient(evmAddress);
        return;
      }
      if (wasActive) return;

      // A background release closes transient subscriptions only. Restore the
      // same SecureClient from encrypted credentials when the app returns.
      AsyncStorage.multiGet(storageKeys(evmAddress))
        .then(async (entries) => {
          const [storedEoa, storedWallet, storedMode] = entries.map((entry) => entry[1]);
          if (!storedEoa || !storedWallet || storedMode !== 'deposit_wallet') return;
          const secureClient = await activatePolymarketClient(signer, evmAddress);
          await persistEnabled(evmAddress, secureClient);
          installClient(evmAddress, secureClient);
        })
        .catch((error: unknown) => {
          logChainEvent('polymarket.resume', 'FAILED', {
            message: error instanceof Error ? error.message : String(error),
            eoaAddress: evmAddress,
          });
        });
    });
    return () => subscription.remove();
  }, [evmAddress, installClient, persistEnabled, signer]);

  const enable = useCallback(async () => {
    if (!signer || !evmAddress) throw new Error('Connect your wallet first');
    const generation = ++generationRef.current;
    setIsLoading(true);
    try {
      logChainEvent('polymarket.enable', '1/3 creating SecureClient', { eoaAddress: evmAddress });
      const secureClient = await activatePolymarketClient(signer, evmAddress);
      if (generationRef.current !== generation) {
        await releasePolymarketClient(evmAddress);
        throw new Error(WALLET_CHANGED_MESSAGE);
      }
      logChainEvent('polymarket.enable', '2/3 setting up trading approvals', {
        depositWalletAddress: secureClient.account.wallet,
      });
      await secureClient.setupTradingApprovals();
      if (generationRef.current !== generation) {
        await releasePolymarketClient(evmAddress);
        throw new Error(WALLET_CHANGED_MESSAGE);
      }
      await persistEnabled(evmAddress, secureClient);
      installClient(evmAddress, secureClient);
      logChainEvent('polymarket.enable', '3/3 ready', {
        eoaAddress: evmAddress,
        depositWalletAddress: secureClient.account.wallet,
      });
    } catch (error) {
      logChainEvent('polymarket.enable', 'FAILED', {
        message: error instanceof Error ? error.message : String(error),
        eoaAddress: evmAddress,
      });
      throw error;
    } finally {
      if (generationRef.current === generation) setIsLoading(false);
    }
  }, [evmAddress, installClient, persistEnabled, signer]);

  const disable = useCallback(async () => {
    const address = evmAddress;
    if (!address || !client) {
      throw new Error('Predict is not active, so its API key could not be revoked.');
    }
    setIsLoading(true);
    try {
      await disablePolymarketClient(address, client);
      ++generationRef.current;
      await AsyncStorage.multiRemove(storageKeys(address));
      clearUi();
    } finally {
      setIsLoading(false);
    }
  }, [clearUi, client, evmAddress]);

  const isReady = !!client && !!polygonAddress && !!depositWalletAddress && walletMode === 'deposit_wallet';
  logChainState('polymarket.account', {
    signerStatus,
    signerAddress: evmAddress,
    polygonAddress,
    depositWalletAddress,
    walletMode,
    isReady,
    isLoading,
  });

  if (process.env.EXPO_PUBLIC_PREDICT_E2E === '1') {
    const runtime = globalThis as typeof globalThis & {
      __PREDICT_E2E_POLYGON_ADDRESS?: string;
      __PREDICT_E2E_DEPOSIT_WALLET_ADDRESS?: string;
    };
    const eoa = runtime.__PREDICT_E2E_POLYGON_ADDRESS ?? E2E_POLYGON_ADDRESS;
    const wallet = runtime.__PREDICT_E2E_DEPOSIT_WALLET_ADDRESS ?? E2E_DEPOSIT_WALLET_ADDRESS;
    return {
      polygonAddress: eoa,
      safeAddress: null,
      depositWalletAddress: wallet,
      walletMode: 'deposit_wallet',
      tradingAddress: wallet,
      client: null,
      isReady: true,
      isLoading: false,
      enable: async () => {},
      disable: async () => {},
      canSignLocally: true,
      signer: null,
      signerStatus: 'ready',
      connectSigner: async () => {},
    };
  }

  return {
    polygonAddress,
    safeAddress: null,
    depositWalletAddress,
    walletMode,
    tradingAddress: depositWalletAddress,
    client,
    isReady,
    isLoading,
    enable,
    disable,
    canSignLocally: !!signer,
    signer,
    signerStatus,
    connectSigner,
  };
}
