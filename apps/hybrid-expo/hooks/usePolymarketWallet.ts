/**
 * usePolymarketWallet — the Polymarket enable flow, over a resolved EVM signer.
 *
 * Architecture:
 * - The EOA is a Privy embedded EVM wallet resolved through
 *   `useChainSigner(POLYMARKET_REQUIREMENT)`. This app never sees key material,
 *   and no key is derived from any signature.
 * - The phone stores public Polygon/deposit-wallet addresses in AsyncStorage so the UI
 *   remembers the user is "enabled" across app restarts.
 * - On enable: the embedded wallet signs CLOB auth, then only the public address
 *   and CLOB L2 credentials go to the server.
 * - On app reopen: phone reads stored address from AsyncStorage. If the server session expired,
 *   the next CLOB operation will fail and the user re-enables.
 * - On disable: clears both local storage and server session.
 *
 * Sessions are keyed on the EVM address, because the EOA is what determines the
 * deposit wallet server-side (CREATE2 in
 * `packages/api/src/polymarket/trading/routes/session.ts`). Keying on anything
 * else would let a stored session point at a deposit wallet the current signer
 * does not control.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useChainSigner } from '@/features/chain/useChainSigner';
import { logChainEvent, logChainState } from '@/features/chain/chain.debug';
import { POLYMARKET_REQUIREMENT } from '@/features/chain/chain.contract';
import type { Signer } from '@/features/chain/chain.contract';
import { resolveApiBaseUrl, fetchWithTimeout } from '@/lib/api';
import { onClobSessionExpired } from '@/features/predict/predict.api';

const STORAGE_KEY = 'polymarket_polygon_address'; // Public address only, not a secret
const DEPOSIT_WALLET_STORAGE_KEY = 'polymarket_deposit_wallet_address';
const WALLET_MODE_STORAGE_KEY = 'polymarket_wallet_mode';
const WALLET_CHANGED_MESSAGE = 'Wallet changed. Please try again.';

const API_BASE = resolveApiBaseUrl();
const E2E_POLYGON_ADDRESS = process.env.EXPO_PUBLIC_PREDICT_E2E_POLYGON_ADDRESS
  ?? '0xe2e0000000000000000000000000000000000001';
const E2E_DEPOSIT_WALLET_ADDRESS = process.env.EXPO_PUBLIC_PREDICT_E2E_DEPOSIT_WALLET_ADDRESS
  ?? '0xe2e0000000000000000000000000000000000002';

export type PolymarketWalletMode = 'deposit_wallet';

function isWalletChangedError(err: unknown): boolean {
  return err instanceof Error && err.message === WALLET_CHANGED_MESSAGE;
}

export interface PolymarketWallet {
  polygonAddress: string | null;
  /** Legacy field kept for UI compatibility; deposit-wallet mode always returns null. */
  safeAddress: string | null;
  /** Deposit wallet address for new Polymarket API users */
  depositWalletAddress: string | null;
  /** Active trading wallet mode for this user */
  walletMode: PolymarketWalletMode | null;
  /** Address that holds pUSD/CTF and funds CLOB orders */
  tradingAddress: string | null;
  isReady: boolean;
  isLoading: boolean;
  /** Server lost the CLOB session (restart/TTL) — UI should prompt the user to reconnect via enable() */
  sessionExpired: boolean;
  /** Resolve the EVM signer, authenticate with the CLOB, and set up deposit-wallet trading */
  enable: () => Promise<void>;
  /** Clear session (server + local) */
  disable: () => void;
  /** Whether an EVM signer is resolved and able to sign */
  canSignLocally: boolean;
  /**
   * The resolved EVM signer, or null when the requirement is unsatisfied.
   * Callers pass this to the signing entry points in `predict.api`.
   */
  signer: Signer | null;
  /** Resolver status, so the UI can open the connection sheet on `needs_connection`. */
  signerStatus: ReturnType<typeof useChainSigner>['status'];
  /** Satisfy the EVM requirement (activate, provisioning the wallet if needed). */
  connectSigner: () => Promise<void>;
}

export function usePolymarketWallet(): PolymarketWallet {
  const { signer, status: signerStatus, connect: connectSigner } = useChainSigner(POLYMARKET_REQUIREMENT);

  // The EOA the deposit wallet is derived from. Everything below is keyed on it.
  const evmAddress = signer?.descriptor.address ?? null;
  const connected = !!signer;
  const walletPreparing = signerStatus === 'preparing';
  // Identity of the current signer. A different EOA is a different session, and
  // must not inherit the previous one's stored deposit wallet.
  const sessionKey = useMemo(
    () => (evmAddress ? `evm:${evmAddress.toLowerCase()}` : null),
    [evmAddress],
  );

  const [polygonAddress, setPolygonAddress] = useState<string | null>(null);
  const [safeAddress, setSafeAddress] = useState<string | null>(null);
  const [depositWalletAddress, setDepositWalletAddress] = useState<string | null>(null);
  const [walletMode, setWalletMode] = useState<PolymarketWalletMode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Derived, not stored: signing ability is exactly "the resolver gave us a
  // signer", so there is no separate flag that can go stale.
  const canSignLocally = !!signer;
  const [sessionExpired, setSessionExpired] = useState(false);
  const prevWalletSessionKey = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);
  const activePolygonAddressRef = useRef<string | null>(null);
  const walletSnapshotRef = useRef({ connected, evmAddress, sessionKey, walletPreparing });
  walletSnapshotRef.current = { connected, evmAddress, sessionKey, walletPreparing };

  useEffect(() => {
    activePolygonAddressRef.current = polygonAddress;
  }, [polygonAddress]);

  // Server session is in-memory (packages/api/src/clob.ts) and is wiped on
  // restart/redeploy. predict.api.ts detects the resulting 401 on CLOB reads
  // and notifies here so the UI can prompt reconnect instead of polling a
  // dead session forever.
  useEffect(() => {
    return onClobSessionExpired(() => {
      if (activePolygonAddressRef.current) setSessionExpired(true);
    });
  }, []);

  const removeStoredSessionForAddress = useCallback((address: string) => {
    AsyncStorage.multiRemove([
      `${STORAGE_KEY}:${address}`,
      `${DEPOSIT_WALLET_STORAGE_KEY}:${address}`,
      `${WALLET_MODE_STORAGE_KEY}:${address}`,
    ]).catch(() => {});
  }, []);

  const clearWalletSessionState = useCallback(() => {
    setPolygonAddress(null);
    setSafeAddress(null);
    setDepositWalletAddress(null);
    setWalletMode(null);
    setSessionExpired(false);
  }, []);

  const clearStoredSession = useCallback(() => {
    loadGenerationRef.current += 1;
    if (evmAddress) removeStoredSessionForAddress(evmAddress);
    clearWalletSessionState();
  }, [evmAddress, removeStoredSessionForAddress, clearWalletSessionState]);

  const clearServerSession = useCallback((address: string | null) => {
    if (address) {
      fetchWithTimeout(`${API_BASE}/clob/session/${address}`, { method: 'DELETE' }).catch(() => {});
    }
  }, []);

  // Load stored addresses when wallet/provider connects or changes; clear when disconnected.
  useEffect(() => {
    if (walletPreparing) {
      loadGenerationRef.current += 1;
      clearWalletSessionState();
      setIsLoading(true);
      prevWalletSessionKey.current = null;
      return;
    }

    const nextWalletSessionKey = connected && evmAddress ? sessionKey : null;
    const previousWalletSessionKey = prevWalletSessionKey.current;

    if (previousWalletSessionKey && previousWalletSessionKey !== nextWalletSessionKey) {
      clearServerSession(activePolygonAddressRef.current);
    }

    // Signer unresolved or the EOA changed - immediately clear UI-visible state.
    if (!connected || !evmAddress || !nextWalletSessionKey) {
      loadGenerationRef.current += 1;
      clearWalletSessionState();
      setIsLoading(false);
      prevWalletSessionKey.current = null;
      return;
    }

    // Same wallet session, already loaded - skip.
    if (previousWalletSessionKey === nextWalletSessionKey) return;
    prevWalletSessionKey.current = nextWalletSessionKey;

    // New wallet connected - clear old state before loading stored addresses for the new wallet.
    const loadGeneration = ++loadGenerationRef.current;
    setIsLoading(true);
    clearWalletSessionState();

    Promise.all([
      AsyncStorage.getItem(`${STORAGE_KEY}:${evmAddress}`),
      AsyncStorage.getItem(`${DEPOSIT_WALLET_STORAGE_KEY}:${evmAddress}`),
      AsyncStorage.getItem(`${WALLET_MODE_STORAGE_KEY}:${evmAddress}`),
    ])
      .then(([storedEoa, storedDepositWallet, storedWalletMode]) => {
        const current = walletSnapshotRef.current;
        if (
          loadGenerationRef.current !== loadGeneration
          || current.evmAddress !== evmAddress
          || current.sessionKey !== nextWalletSessionKey
        ) {
          return;
        }

        if (storedEoa && (!storedDepositWallet || storedWalletMode !== 'deposit_wallet')) {
          removeStoredSessionForAddress(evmAddress);
          return;
        }

        if (storedEoa) setPolygonAddress(storedEoa);
        if (storedDepositWallet) setDepositWalletAddress(storedDepositWallet);
        if (storedWalletMode === 'deposit_wallet') {
          setWalletMode(storedWalletMode);
        } else if (storedDepositWallet) {
          setWalletMode('deposit_wallet');
        }
      })
      .catch(() => {})
      .finally(() => {
        const current = walletSnapshotRef.current;
        if (
          loadGenerationRef.current === loadGeneration
          && current.evmAddress === evmAddress
          && current.sessionKey === nextWalletSessionKey
        ) {
          setIsLoading(false);
        }
      });
  }, [
    connected,
    evmAddress,
    sessionKey,
    walletPreparing,
    clearWalletSessionState,
    clearServerSession,
    removeStoredSessionForAddress,
  ]);

  const enable = useCallback(async () => {
    const activeSigner = signer;
    const startAddress = evmAddress;
    const startSessionKey = connected && startAddress ? sessionKey : null;

    if (!activeSigner || !startSessionKey || !startAddress) {
      throw new Error('Connect your wallet first');
    }

    setSessionExpired(false);

    const assertWalletUnchanged = () => {
      const current = walletSnapshotRef.current;
      if (
        !current.connected
        || current.walletPreparing
        || current.evmAddress !== startAddress
        || current.sessionKey !== startSessionKey
      ) {
        throw new Error(WALLET_CHANGED_MESSAGE);
      }
    };

    const enableGeneration = ++loadGenerationRef.current;
    setIsLoading(true);
    try {
      // The EOA is the embedded EVM wallet itself — nothing is derived, and no
      // key material exists outside Privy.
      const eoaAddress = startAddress;

      // `@polymarket/client`'s SecureClient does CLOB L1 auth, deposit-wallet
      // derivation, and first-time deployment in one call — this is the fix
      // for the wrong-address bug (docs/modules/polymarket/PRDs/2026_07_31_polymarket_sdk_migration_PRD.md):
      // the old server-side CREATE2 derivation computed an address the live
      // factory never deploys to. `client.account.wallet` is correct by
      // construction because the SDK that derives it is the SDK the factory
      // actually matches.
      const { createPolymarketSecureClient, createPredictSessionProof } = await import('@/features/predict/predict.signing');
      logChainEvent('polymarket.enable', '1/4 creating SecureClient (auth + deposit wallet)', { eoaAddress });
      const client = await createPolymarketSecureClient(activeSigner);
      assertWalletUnchanged();
      const depositWalletAddress = client.account.wallet;
      const creds = client.credentials;
      logChainEvent('polymarket.enable', '2/4 SecureClient ready', {
        depositWalletAddress,
        walletType: client.account.walletType,
      });

      // Grants the ERC-20/ERC-1155 approvals the CTF exchanges need before an
      // order can fill — the SDK's replacement for the old server-relayed
      // approval batch (`buildApprovalTxs` + `/wallet-batch`). Called on every
      // enable() rather than gated on "first time only": the SDK's type
      // comments don't state whether it's a no-op when approvals already
      // exist, so this needs confirming on-device (does a second call cost
      // gas/time, or return immediately?) rather than assumed either way.
      logChainEvent('polymarket.enable', '3/4 setting up trading approvals');
      await client.setupTradingApprovals();
      assertWalletUnchanged();
      logChainEvent('polymarket.enable', '3/4 trading approvals ok');

      // The server still holds the CLOB session for order placement, wrap,
      // withdraw, and redeem — those haven't migrated to call the SDK
      // directly yet (PRD step 4, still open). Register this correct address
      // and these credentials with it rather than letting the server derive
      // anything itself: passed as `knownDepositWalletAddress`, the server's
      // existing on-chain `owner()` verification accepts it immediately and
      // never reaches its own (wrong) CREATE2 derivation or blind-deploy path.
      logChainEvent('polymarket.enable', '4/4 signing session proof and registering with server');
      const authProof = await createPredictSessionProof(activeSigner, eoaAddress);

      const res = await fetchWithTimeout(`${API_BASE}/clob/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          polygonAddress: eoaAddress,
          creds,
          ...authProof,
          knownDepositWalletAddress: depositWalletAddress,
        }),
      });
      assertWalletUnchanged();

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        assertWalletUnchanged();
        throw new Error(err.detail || err.error || 'CLOB auth failed');
      }

      const data = await res.json();
      assertWalletUnchanged();
      logChainEvent('polymarket.enable', '4/4 server session registered', {
        polygonAddress: data.polygonAddress,
        depositWalletAddress: data.depositWalletAddress,
        walletMode: data.walletMode,
      });
      // The server is expected to echo back exactly the address the SDK
      // derived, since it was handed as a verified hint — anything else means
      // the server's verification rejected it (wrong signer, no code at that
      // address) and fell through to its own derivation, which is the bug
      // this migration exists to avoid resurfacing silently.
      if (!data.depositWalletAddress || data.depositWalletAddress.toLowerCase() !== depositWalletAddress.toLowerCase()) {
        throw new Error('Server reported a different deposit wallet than the SDK derived — reconnect and try again.');
      }
      if (loadGenerationRef.current !== enableGeneration) {
        throw new Error(WALLET_CHANGED_MESSAGE);
      }

      await AsyncStorage.multiSet([
        [`${STORAGE_KEY}:${startAddress}`, data.polygonAddress],
        [`${DEPOSIT_WALLET_STORAGE_KEY}:${startAddress}`, data.depositWalletAddress],
        [`${WALLET_MODE_STORAGE_KEY}:${startAddress}`, 'deposit_wallet'],
      ]);
      assertWalletUnchanged();

      setPolygonAddress(data.polygonAddress);
      setSafeAddress(null);
      setDepositWalletAddress(data.depositWalletAddress);
      setWalletMode('deposit_wallet');
    } catch (err) {
      logChainEvent('polymarket.enable', 'FAILED', {
        message: err instanceof Error ? err.message : String(err),
        eoaAddress: startAddress,
      });
      if (isWalletChangedError(err)) {
        removeStoredSessionForAddress(startAddress);
        clearWalletSessionState();
      }
      throw err;
    } finally {
      const current = walletSnapshotRef.current;
      if (current.evmAddress === startAddress && current.sessionKey === startSessionKey) {
        setIsLoading(false);
      }
    }
  }, [
    signer,
    connected,
    evmAddress,
    sessionKey,
    removeStoredSessionForAddress,
    clearWalletSessionState,
  ]);

  const disable = useCallback(() => {
    clearServerSession(polygonAddress);
    clearStoredSession();
  }, [polygonAddress, clearStoredSession, clearServerSession]);

  const tradingAddress = depositWalletAddress;
  const isReady = !!polygonAddress && walletMode === 'deposit_wallet' && !!depositWalletAddress;

  // Stage 3: what the screens gate on. `signerStatus: 'ready'` with
  // `polygonAddress: null` is the state that renders "Set up Polymarket" — a
  // usable wallet whose CLOB session has not been established, which is
  // exactly the distinction these two fields are meant to keep apart.
  logChainState('polymarket.account', {
    signerStatus,
    signerAddress: signer?.descriptor.address ?? null,
    polygonAddress,
    depositWalletAddress,
    walletMode,
    isReady,
    isLoading,
    sessionExpired,
  });

  if (process.env.EXPO_PUBLIC_PREDICT_E2E === '1') {
    const runtime = globalThis as typeof globalThis & {
      __PREDICT_E2E_POLYGON_ADDRESS?: string;
      __PREDICT_E2E_DEPOSIT_WALLET_ADDRESS?: string;
    };
    const e2ePolygonAddress = runtime.__PREDICT_E2E_POLYGON_ADDRESS ?? E2E_POLYGON_ADDRESS;
    const e2eDepositWalletAddress = runtime.__PREDICT_E2E_DEPOSIT_WALLET_ADDRESS ?? E2E_DEPOSIT_WALLET_ADDRESS;
    return {
      polygonAddress: e2ePolygonAddress,
      safeAddress: null,
      depositWalletAddress: e2eDepositWalletAddress,
      walletMode: 'deposit_wallet',
      tradingAddress: e2eDepositWalletAddress,
      isReady: true,
      isLoading: false,
      sessionExpired: false,
      enable: async () => {},
      disable: () => {},
      canSignLocally: true,
      signer: null,
      signerStatus: 'ready',
      connectSigner: async () => {},
    };
  }

  return {
    polygonAddress,
    safeAddress,
    depositWalletAddress,
    walletMode,
    tradingAddress,
    isReady,
    isLoading,
    sessionExpired,
    enable,
    disable,
    canSignLocally,
    signer,
    signerStatus,
    connectSigner,
  };
}
