/**
 * usePolymarketAccountSetup — the Polymarket profile screen's account-state
 * machine (#738, extracted verbatim from `polymarket.portfolio.tsx`).
 *
 * Owns account state derivation, connect / reconnect / setup-resume, the
 * withdraw gate and the connection-sheet intent. Pure move: the ref-guarded
 * setup-resume effect keeps its dependencies and its lint-disable, and the
 * `onConnected`-before-close sheet ordering is unchanged.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import type { ConnectionIntent } from '@/features/portfolio/polymarket/polymarket.format';
import {
  getPolymarketProfileAccountState,
  getPolymarketProfileSetupCopy,
} from '@/features/polymarket/portfolio/profile-state';
import { useConnectionSheet } from '@/features/wallet/components/useConnectionSheet';
import type { PolymarketWallet } from '@/hooks/usePolymarketWallet';

interface UsePolymarketAccountSetupOptions {
  poly: PolymarketWallet;
  /** EVM signing address from the Privy/chain signer — the "connected" signal. */
  walletAddress: string | null;
  isEnabled: boolean;
  busy: boolean;
  isPrivyUser: boolean;
  setBusy: (busy: boolean) => void;
  loadPortfolio: () => Promise<void>;
  setPolymarketUnavailable: (update: boolean | ((current: boolean) => boolean)) => void;
  /** Solana destination read only as a withdrawal target, never as connection state. */
  solanaAddress: string | null;
  /** Closes the (still screen-owned) settings sheet without clearing errors. */
  dismissSettings: () => void;
  openWithdrawModal: () => void;
}

export function usePolymarketAccountSetup({
  poly,
  walletAddress,
  isEnabled,
  busy,
  isPrivyUser,
  setBusy,
  loadPortfolio,
  setPolymarketUnavailable,
  solanaAddress,
  dismissSettings,
  openWithdrawModal,
}: UsePolymarketAccountSetupOptions) {
  // Polymarket settles on Polygon, so its requirement is EVM.
  const connectSheet = useConnectionSheet('evm');
  const [connectionIntent, setConnectionIntent] = useState<ConnectionIntent>(null);
  // Set when the connection sheet is opened to reach Polymarket setup, so the
  // effect below can finish the job once a signer resolves. Without it a user
  // who signs in here lands back on a screen with a wallet and no next step —
  // the detail screens already do this; profile was the one that did not.
  const [setupAfterConnect, setSetupAfterConnect] = useState(false);
  // Set by the sheet's `onConnected` so the close handler can tell a successful
  // connection from a cancellation — the sheet closes itself in both cases.
  const connectedViaSheetRef = useRef(false);

  // Two different questions, and the caller must not confuse them:
  //   walletAddress      — the EVM wallet exists and can sign. Local, from Privy,
  //                        available at app load. This is "connected".
  //   poly.polygonAddress — the mobile SecureClient is authenticated and its
  //                        SDK-resolved account is ready.
  // Gating connection UI on polygonAddress showed "Connect wallet" to a user who
  // already had a working wallet, with no control that advanced them.
  const accountState = getPolymarketProfileAccountState({
    signerStatus: poly.signerStatus,
    isPrivyUser,
    hasSigner: walletAddress !== null,
    polymarketReady: isEnabled,
    polymarketLoading: poly.isLoading || busy,
    sessionExpired: poly.sessionExpired,
  });
  const setupCopy = getPolymarketProfileSetupCopy(accountState);

  const connectPolymarketAccount = useCallback(async () => {
    setBusy(true);
    try {
      await poly.enable();
      setPolymarketUnavailable(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to connect Polymarket account';
      Alert.alert('Error', msg);
    } finally {
      setBusy(false);
    }
  }, [poly, setBusy, setPolymarketUnavailable]);

  const handleConnectPolymarketAccount = useCallback(() => {
    // Polymarket signs on Polygon, so the requirement is EVM. When the resolver
    // has no signer yet, the shared connection sheet is the entry point and the
    // effect below resumes setup once the signer lands — signing in and setting
    // up Polymarket is one user action, not two.
    if (!poly.signer) {
      setConnectionIntent('polymarket');
      setSetupAfterConnect(true);
      connectSheet.open('evm');
      return;
    }

    void connectPolymarketAccount();
  }, [connectPolymarketAccount, connectSheet, poly.signer]);

  const handleWithdrawPress = useCallback(() => {
    if (accountState !== 'ready') return;
    dismissSettings();
    if (!solanaAddress) {
      setConnectionIntent('withdrawal');
      connectSheet.open('solana');
      return;
    }
    openWithdrawModal();
  }, [accountState, connectSheet, dismissSettings, openWithdrawModal, solanaAddress]);

  useEffect(() => {
    if (connectionIntent !== 'withdrawal' || !solanaAddress) return;
    setConnectionIntent(null);
    openWithdrawModal();
  }, [connectionIntent, openWithdrawModal, solanaAddress]);

  // Resume setup after the connection sheet resolves a signer. Mirrors
  // PolymarketMarketDetailScreen / PolymarketSportDetailScreen.
  //
  // `connectPolymarketAccount` is deliberately not a dependency: it closes over
  // `poly`, which is a new object every render, so including it would re-run
  // this effect continuously. The ref guard is what makes the resume fire once
  // per connection rather than on every render while setup is in flight.
  const setupResumeRef = useRef(false);
  useEffect(() => {
    if (!setupAfterConnect || !poly.signer || poly.isReady) return;
    if (setupResumeRef.current) return;
    setupResumeRef.current = true;
    setSetupAfterConnect(false);
    void connectPolymarketAccount().finally(() => {
      setupResumeRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupAfterConnect, poly.signer, poly.isReady]);

  const handleReconnect = useCallback(async () => {
    setBusy(true);
    try {
      await poly.enable();
      // Re-fetch after re-auth
      await loadPortfolio();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Refresh failed';
      Alert.alert('Error', msg);
    } finally {
      setBusy(false);
    }
  }, [loadPortfolio, poly, setBusy]);

  const handleSheetConnected = useCallback(() => {
    connectedViaSheetRef.current = true;
  }, []);

  const handleSheetClose = useCallback(() => {
    const completed = connectedViaSheetRef.current;
    connectedViaSheetRef.current = false;
    if (!completed) {
      setSetupAfterConnect(false);
      setConnectionIntent(null);
    } else if (connectionIntent === 'polymarket') {
      setConnectionIntent(null);
    }
    connectSheet.close();
  }, [connectSheet, connectionIntent]);

  return {
    accountState,
    setupCopy,
    connectSheet,
    handleConnectPolymarketAccount,
    handleReconnect,
    handleWithdrawPress,
    handleSheetConnected,
    handleSheetClose,
  };
}
